import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { resolveKeys } from "@/lib/keys/resolveKeyMode";
import Anthropic from "@anthropic-ai/sdk";
import { randomUUID } from "crypto";

const MAX_FILE_BYTES = 50 * 1024 * 1024; // 50MB for Anthropic Files API

// Supported file types for Agent Skills
const SUPPORTED_EXTENSIONS = [".xlsx", ".pptx", ".docx", ".pdf"];
const SUPPORTED_MIME_TYPES = [
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/pdf",
];

function sanitizeFilename(name: string) {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function isSupportedFile(fileName: string, mimeType: string): boolean {
  const ext = fileName.toLowerCase().slice(fileName.lastIndexOf("."));
  return (
    SUPPORTED_EXTENSIONS.includes(ext) ||
    SUPPORTED_MIME_TYPES.includes(mimeType)
  );
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
  const agentId = String(formData.get("agentId") || "");
  const file = formData.get("file");

  if (!sessionId || !agentId || !(file instanceof File)) {
    return NextResponse.json(
      { error: "Missing sessionId, agentId, or file" },
      { status: 400 }
    );
  }

  if (file.size > MAX_FILE_BYTES) {
    return NextResponse.json(
      { error: `File too large (max ${MAX_FILE_BYTES / 1024 / 1024}MB)` },
      { status: 400 }
    );
  }

  const fileName = file.name || "upload";
  const mimeType = file.type || "application/octet-stream";

  if (!isSupportedFile(fileName, mimeType)) {
    return NextResponse.json(
      { error: "Unsupported file type. Supported: xlsx, pptx, docx, pdf" },
      { status: 400 }
    );
  }

  // Verify session belongs to user.
  const { data: session, error: sessionError } = await supabase
    .from("chat_sessions")
    .select("id, agent_id, user_id")
    .eq("id", sessionId)
    .eq("user_id", user.id)
    .maybeSingle();

  if (sessionError || !session) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  // Verify agent belongs to user, then load key mode context.
  const { data: agent, error: agentError } = await supabase
    .from("agents")
    .select("id, type, user_id")
    .eq("id", agentId)
    .eq("user_id", user.id)
    .maybeSingle();

  if (agentError || !agent) {
    return NextResponse.json({ error: "Agent not found" }, { status: 404 });
  }

  if (agent.type !== "files-agent") {
    return NextResponse.json(
      { error: "Agent is not a files-agent" },
      { status: 400 }
    );
  }

  if (session.agent_id !== agentId) {
    return NextResponse.json(
      { error: "Session is not linked to this Files agent" },
      { status: 400 }
    );
  }

  const cookie = req.headers.get("cookie") || "";
  const resolved = await resolveKeys(user.id, supabase, cookie);
  const keyMode = resolved.keyModes.anthropic || resolved.globalMode;
  const apiKey: string | null = keyMode === "user" ? (resolved.userKeys.anthropic || null) : null;

  if (keyMode === "user" && !apiKey) {
    return NextResponse.json(
      { error: "Missing Anthropic API key. Add it in Settings, or switch Anthropic to Groovy." },
      { status: 400 }
    );
  }
  if (keyMode === "groovy" && !process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json(
      { error: "Groovy Anthropic API key not configured on server." },
      { status: 500 }
    );
  }

  // Store file in Supabase first (for persistence)
  const storagePath = `${user.id}/${sessionId}/${randomUUID()}-${sanitizeFilename(fileName)}`;
  const fileBytes = new Uint8Array(await file.arrayBuffer());

  const { error: uploadError } = await supabase.storage
    .from("chat_uploads")
    .upload(storagePath, fileBytes, {
      contentType: mimeType,
      upsert: false,
    });

  if (uploadError) {
    return NextResponse.json({ error: uploadError.message }, { status: 500 });
  }

  // Record in chat_attachments
  const { data: attachment, error: attachmentError } = await supabase
    .from("chat_attachments")
    .insert({
      user_id: user.id,
      session_id: sessionId,
      storage_path: storagePath,
      file_name: fileName,
      mime_type: mimeType,
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

  // Upload to Anthropic Files API for use in code execution container
  let anthropicFileId: string | null = null;
  try {
    const anthropic = new Anthropic(apiKey ? { apiKey } : {});
    
    // Create a File object for upload
    const uploadFile = new File([fileBytes], fileName, { type: mimeType });
    
    // Upload with the correct beta header as second argument
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const uploadResult = await (anthropic.beta.files.upload as any)(
      { file: uploadFile },
      { betas: ["files-api-2025-04-14"] }
    );
    
    anthropicFileId = uploadResult.id;
    console.log("[files-agent/upload] Uploaded to Anthropic:", anthropicFileId);

    // Bind uploaded Anthropic file ID to the persisted attachment record so
    // downstream container_upload calls can validate ownership by attachment.
    const { error: bindErr } = await supabase
      .from("chat_attachments")
      .update({ anthropic_file_id: anthropicFileId } as Record<string, unknown>)
      .eq("id", attachment.id)
      .eq("user_id", user.id)
      .eq("session_id", sessionId);
    if (bindErr) {
      console.warn("[files-agent/upload] Failed to bind anthropic_file_id to attachment", {
        attachmentId: attachment.id,
        error: bindErr.message,
      });
    }
  } catch (anthropicErr) {
    console.error("[files-agent/upload] Anthropic upload error:", anthropicErr);
    // Don't fail the request - file is stored in Supabase
  }

  // Update session timestamp
  await supabase
    .from("chat_sessions")
    .update({ updated_at: new Date().toISOString() })
    .eq("id", sessionId);

  return NextResponse.json({
    ok: true,
    attachmentId: attachment.id,
    fileName,
    mimeType,
    size: file.size,
    anthropicFileId, // May be null if Anthropic upload failed
  });
}
