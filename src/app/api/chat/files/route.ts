import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { embedTexts, embeddingToVectorLiteral } from "@/lib/ai/embeddings";
import { randomUUID } from "crypto";
import { extractText } from "unpdf";
import mammoth from "mammoth";
import * as XLSX from "xlsx";

const MAX_FILE_BYTES = 20 * 1024 * 1024; // 20MB

function getErrorMessage(err: unknown) {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return "Failed to read file";
}

function sanitizeFilename(name: string) {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function normalizeText(text: string) {
  return text.replace(/\s+/g, " ").trim();
}

function chunkText(text: string, chunkSize = 1200, overlap = 200) {
  const chunks: string[] = [];
  let i = 0;
  while (i < text.length) {
    const chunk = text.slice(i, i + chunkSize);
    if (chunk.trim()) chunks.push(chunk.trim());
    i += Math.max(1, chunkSize - overlap);
  }
  return chunks;
}

async function extractTextFromFile(file: File): Promise<string> {
  const mime = file.type || "application/octet-stream";
  const bytes = Buffer.from(await file.arrayBuffer());

  // Never accept images for now (can be added later with vision models).
  if (mime.startsWith("image/")) {
    throw new Error("Image uploads are not supported");
  }

  if (mime === "application/pdf" || file.name.toLowerCase().endsWith(".pdf")) {
    const { text } = await extractText(new Uint8Array(bytes));
    // text is an array of strings (one per page)
    const joined = Array.isArray(text) ? text.join("\n") : String(text || "");
    return normalizeText(joined);
  }

  if (
    mime ===
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    file.name.toLowerCase().endsWith(".docx")
  ) {
    const res = await mammoth.extractRawText({ buffer: bytes });
    return normalizeText(res.value || "");
  }

  // Excel files (.xlsx, .xls)
  if (
    mime === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
    mime === "application/vnd.ms-excel" ||
    file.name.toLowerCase().endsWith(".xlsx") ||
    file.name.toLowerCase().endsWith(".xls")
  ) {
    const workbook = XLSX.read(bytes, { type: "buffer" });
    const textParts: string[] = [];
    for (const sheetName of workbook.SheetNames) {
      const sheet = workbook.Sheets[sheetName];
      const csv = XLSX.utils.sheet_to_csv(sheet);
      textParts.push(`[Sheet: ${sheetName}]\n${csv}`);
    }
    return normalizeText(textParts.join("\n\n"));
  }

  // Treat common text-like formats as UTF-8
  if (
    mime.startsWith("text/") ||
    mime === "application/json" ||
    file.name.toLowerCase().endsWith(".md") ||
    file.name.toLowerCase().endsWith(".txt") ||
    file.name.toLowerCase().endsWith(".csv") ||
    file.name.toLowerCase().endsWith(".json")
  ) {
    return normalizeText(bytes.toString("utf8"));
  }

  throw new Error(`Unsupported file type: ${mime}`);
}

export async function POST(req: Request) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const formData = await req.formData().catch(() => null);
  if (!formData) {
    return NextResponse.json({ error: "Invalid form data" }, { status: 400 });
  }

  const sessionId = String(formData.get("sessionId") || "");
  const file = formData.get("file");

  if (!sessionId || !(file instanceof File)) {
    return NextResponse.json(
      { error: "Missing sessionId or file" },
      { status: 400 }
    );
  }

  if (file.size > MAX_FILE_BYTES) {
    return NextResponse.json(
      { error: `File too large (max ${MAX_FILE_BYTES / 1024 / 1024}MB)` },
      { status: 400 }
    );
  }

  // Ensure session belongs to user.
  const { data: session, error: sessionError } = await supabase
    .from("chat_sessions")
    .select("id, agent_id")
    .eq("id", sessionId)
    .single();

  if (sessionError || !session) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  // Extract text FIRST - if this fails, don't save anything
  let extractedText = "";
  try {
    extractedText = await extractTextFromFile(file);
  } catch (err) {
    const message = getErrorMessage(err);
    return NextResponse.json({ error: message }, { status: 400 });
  }

  if (!extractedText.trim()) {
    return NextResponse.json(
      { error: "No extractable text found in file" },
      { status: 400 }
    );
  }

  // Best-effort dedupe: if same file_name + size already exists for this session and has chunks, return it.
  // This prevents accidental double-uploads due to retries/double-clicks.
  const fileName = file.name || "upload";
  const { data: existing } = await supabase
    .from("chat_attachments")
    .select("id")
    .eq("session_id", sessionId)
    .eq("file_name", fileName)
    .eq("size_bytes", file.size)
    .order("created_at", { ascending: false })
    .limit(1);

  const existingId = existing?.[0]?.id as string | undefined;
  if (existingId) {
    const { count } = await supabase
      .from("chat_doc_chunks")
      .select("id", { count: "exact", head: true })
      .eq("session_id", sessionId)
      .eq("attachment_id", existingId);

    // If chunks exist, return immediately (true dedupe).
    if ((count || 0) > 0) {
      return NextResponse.json({ ok: true, attachmentId: existingId, chunkCount: count });
    }

    // If an attachment already exists with same name+size, it's likely a double-click/retry while processing.
    // Return it to avoid creating duplicates (the client can refresh later for chunks).
    return NextResponse.json({ ok: true, attachmentId: existingId, chunkCount: 0 });
  }

  // Upload file to storage
  const storagePath = `${user.id}/${sessionId}/${randomUUID()}-${sanitizeFilename(
    fileName
  )}`;

  const fileBytes = new Uint8Array(await file.arrayBuffer());
  const { error: uploadError } = await supabase.storage
    .from("chat_uploads")
    .upload(storagePath, fileBytes, {
      contentType: file.type || "application/octet-stream",
      upsert: false,
    });

  if (uploadError) {
    return NextResponse.json({ error: uploadError.message }, { status: 500 });
  }

  // Record attachment in DB
  const { data: attachment, error: attachmentError } = await supabase
    .from("chat_attachments")
    .insert({
      user_id: user.id,
      session_id: sessionId,
      storage_path: storagePath,
      file_name: fileName,
      mime_type: file.type || "application/octet-stream",
      size_bytes: file.size,
    })
    .select("id")
    .single();

  if (attachmentError || !attachment) {
    return NextResponse.json(
      { error: attachmentError?.message || "Failed to store attachment" },
      { status: 500 }
    );
  }

  const chunks = chunkText(extractedText);
  const embeddings = await embedTexts(chunks);
  if (embeddings.length !== chunks.length) {
    return NextResponse.json(
      {
        error: `Embedding mismatch: got ${embeddings.length} embeddings for ${chunks.length} chunks`,
      },
      { status: 500 }
    );
  }

  const rows = chunks.map((content, idx) => ({
    user_id: user.id,
    session_id: sessionId,
    attachment_id: attachment.id,
    chunk_index: idx,
    content,
    embedding: embeddingToVectorLiteral(embeddings[idx] || []),
  }));

  // Insert in batches to avoid payload limits
  const batchSize = 100;
  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    const { error } = await supabase.from("chat_doc_chunks").insert(batch);
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
  }

  // Sanity check: ensure chunks are actually visible for this user+session (helps debug “200 but no RAG”).
  const { count: finalCount, error: finalCountErr } = await supabase
    .from("chat_doc_chunks")
    .select("id", { count: "exact", head: true })
    .eq("session_id", sessionId)
    .eq("attachment_id", attachment.id);
  if (finalCountErr) {
    return NextResponse.json({ error: finalCountErr.message }, { status: 500 });
  }

  await supabase
    .from("chat_sessions")
    .update({ updated_at: new Date().toISOString() })
    .eq("id", sessionId);

  return NextResponse.json({
    ok: true,
    attachmentId: attachment.id,
    chunkCount: finalCount ?? chunks.length,
  });
}

