import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { verifyInternalRouteAuth } from "@/lib/internalRouteAuth";
import { verifyRelayDeviceToken } from "@/lib/relay/deviceToken";
import { resolveKeys } from "@/lib/keys/resolveKeyMode";
import Anthropic from "@anthropic-ai/sdk";
import { randomUUID } from "crypto";
import {
  completeAgentTrace,
  createAgentTrace,
  ingestAgentTraceToDatagranBestEffort,
} from "@/lib/traces/agentTraces";
import { ANTHROPIC_CONTEXT_1M_BETA, getFilesAgentModel } from "@/lib/ai/modelResolver";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 800;

// Files Agent model is configurable via FILES_AGENT_MODEL
const MODEL = getFilesAgentModel();
const FILES_AGENT_BETAS = [
  ANTHROPIC_CONTEXT_1M_BETA,
  "code-execution-2025-05-22",
  "files-api-2025-04-14",
] as const;

// All available Agent Skills for document processing
const SKILLS = [
  { type: "anthropic" as const, skill_id: "xlsx" },
  { type: "anthropic" as const, skill_id: "pptx" },
  { type: "anthropic" as const, skill_id: "docx" },
  { type: "anthropic" as const, skill_id: "pdf" },
];

type IncomingMessage = {
  role: "user" | "assistant";
  content: string;
};

type UploadedFile = {
  id: string;
  name: string;
  anthropicFileId?: string; // File ID from Anthropic Files API
};

type GeneratedFileInfo = {
  // New shape (used by orchestrator/dashboard-v2)
  name: string;
  mediaType: string;
  url?: string;
  // Compatibility fields (used by datagran/files proxy + dashboard v1)
  filename?: string;
  mime_type?: string;
  storage_path?: string;
  file_id?: string;
};

type PostBody = {
  agentId?: unknown;
  sessionId?: unknown;
  messages?: unknown;
  files?: unknown; // Array of { id, name, anthropicFileId }
};

const MAX_CONTAINER_UPLOAD_FILES = 16;

function toStringOrEmpty(value: unknown) {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  return String(value);
}

function isIncomingMessage(value: unknown): value is IncomingMessage {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  const role = v.role;
  const content = v.content;
  return (role === "user" || role === "assistant") && typeof content === "string";
}

function isUploadedFile(value: unknown): value is UploadedFile {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return typeof v.id === "string" && typeof v.name === "string";
}

function normalizeNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

export async function POST(req: Request) {
  // Support cookie auth (dashboard) OR device-token auth (WhatsApp/connector).
  const deviceToken = req.headers.get("x-device-token") || "";
  const relaySecret = process.env.RELAY_JWT_SECRET || "";
  const verified = deviceToken ? verifyRelayDeviceToken(deviceToken, relaySecret) : null;
  const verifiedInternal = verified ? null : verifyInternalRouteAuth(req, "files-agent");

  const supabase =
    verified || verifiedInternal
      ? createSupabaseAdminClient()
      : await createSupabaseServerClient();

  let user: { id: string } | null = null;
  if (verified) {
    user = { id: verified.userId };
  } else if (verifiedInternal) {
    user = { id: verifiedInternal.userId };
  } else {
    const {
      data: { user: cookieUser },
      error: userError,
    } = await supabase.auth.getUser();
    if (userError || !cookieUser) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    user = { id: cookieUser.id };
  }

  const body = (await req.json().catch(() => null)) as PostBody | null;
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  const agentId = toStringOrEmpty(body.agentId);
  const sessionId = toStringOrEmpty(body.sessionId);
  const messagesRaw = body.messages;
  const filesRaw = body.files;

  const messages = Array.isArray(messagesRaw)
    ? messagesRaw.filter(isIncomingMessage)
    : [];
  const uploadedFilesRaw = Array.isArray(filesRaw)
    ? filesRaw.filter(isUploadedFile)
    : [];
  const uploadableFilesRaw = uploadedFilesRaw.filter(
    (f) => typeof f.anthropicFileId === "string" && f.anthropicFileId.trim().length > 0
  );
  const uploadedFiles = (() => {
    const dedupedRecent: UploadedFile[] = [];
    const seen = new Set<string>();
    for (let i = uploadableFilesRaw.length - 1; i >= 0; i--) {
      const f = uploadableFilesRaw[i];
      const key = (f.anthropicFileId || "").trim();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      dedupedRecent.push(f);
      if (dedupedRecent.length >= MAX_CONTAINER_UPLOAD_FILES) break;
    }
    return dedupedRecent.reverse();
  })();
  if (uploadedFilesRaw.length !== uploadedFiles.length) {
    console.log("[files-agent] Trimmed uploaded files for container_upload cap", {
      originalCount: uploadedFilesRaw.length,
      uploadableCount: uploadableFilesRaw.length,
      selectedCount: uploadedFiles.length,
      droppedNonUploadable: Math.max(0, uploadedFilesRaw.length - uploadableFilesRaw.length),
      maxAllowed: MAX_CONTAINER_UPLOAD_FILES,
    });
  }

  if (!agentId || !sessionId || !Array.isArray(messagesRaw)) {
    return NextResponse.json(
      { error: "Missing agentId, sessionId, or messages" },
      { status: 400 }
    );
  }

  // Verify session belongs to this authenticated user.
  const { data: session, error: sessionError } = await supabase
    .from("chat_sessions")
    .select("id, user_id, agent_id")
    .eq("id", sessionId)
    .eq("user_id", user.id)
    .maybeSingle();

  if (sessionError || !session) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  // Load agent config and enforce ownership (critical on admin/device-token path).
  const { data: agent, error: agentError } = await supabase
    .from("agents")
    .select("id, user_id, name, type, flag_key, system_prompt")
    .eq("id", agentId)
    .eq("user_id", user.id)
    .maybeSingle();

  if (agentError || !agent) {
    return NextResponse.json({ error: "Agent not found" }, { status: 404 });
  }

  if (agent.type !== "files-agent") {
    return NextResponse.json(
      { error: "Agent type is not files-agent" },
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
  const apiKey = keyMode === "user" ? (resolved.userKeys.anthropic || null) : null;

  if (keyMode === "user" && !apiKey) {
    return NextResponse.json(
      {
        error: "Missing Anthropic API key. Add it in Settings, or switch Anthropic to Groovy.",
      },
      { status: 400 }
    );
  }

  if (keyMode === "groovy" && !process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json(
      {
        error:
          "No Anthropic API key available for Files agent. Add one in Settings, or set ANTHROPIC_API_KEY on the server.",
      },
      { status: 500 }
    );
  }

  // Validate file references server-side before using container_upload.
  // We only trust anthropic_file_id values that were previously bound to
  // chat_attachments for this same (user_id, session_id).
  let validatedUploadedFiles: UploadedFile[] = uploadedFiles;
  if (uploadedFiles.length > 0) {
    const attachmentIds = Array.from(
      new Set(
        uploadedFiles
          .map((f) => normalizeNonEmptyString(f.id))
          .filter((id): id is string => !!id)
      )
    );
    if (attachmentIds.length === 0) {
      return NextResponse.json(
        { error: "Invalid file references. Please re-upload and retry." },
        { status: 400 }
      );
    }

    const { data: attachmentRows, error: attachmentError } = await supabase
      .from("chat_attachments")
      .select("id, file_name, anthropic_file_id")
      .eq("user_id", user.id)
      .eq("session_id", sessionId)
      .in("id", attachmentIds);

    if (attachmentError) {
      return NextResponse.json(
        { error: "Failed to validate file references" },
        { status: 500 }
      );
    }

    const attachmentById = new Map<
      string,
      { id: string; file_name: string; anthropic_file_id?: string | null }
    >();
    for (const row of attachmentRows || []) {
      const r = row as {
        id?: unknown;
        file_name?: unknown;
        anthropic_file_id?: unknown;
      };
      const id = normalizeNonEmptyString(r.id);
      const fileName = normalizeNonEmptyString(r.file_name);
      if (!id || !fileName) continue;
      attachmentById.set(id, {
        id,
        file_name: fileName,
        anthropic_file_id:
          typeof r.anthropic_file_id === "string" ? r.anthropic_file_id : null,
      });
    }

    const invalidRefs: Array<{ id: string; reason: string }> = [];
    const nextValidated: UploadedFile[] = [];

    for (const f of uploadedFiles) {
      const row = attachmentById.get(f.id);
      const incomingAnthropic = normalizeNonEmptyString(f.anthropicFileId);
      const storedAnthropic = normalizeNonEmptyString(row?.anthropic_file_id);
      if (!row) {
        invalidRefs.push({ id: f.id, reason: "attachment_not_found_or_not_owned" });
        continue;
      }
      if (!incomingAnthropic) {
        invalidRefs.push({ id: f.id, reason: "missing_incoming_anthropic_file_id" });
        continue;
      }
      if (!storedAnthropic) {
        invalidRefs.push({ id: f.id, reason: "attachment_missing_bound_anthropic_file_id" });
        continue;
      }
      if (incomingAnthropic !== storedAnthropic) {
        invalidRefs.push({ id: f.id, reason: "anthropic_file_id_mismatch" });
        continue;
      }
      nextValidated.push({
        id: row.id,
        name: row.file_name,
        anthropicFileId: storedAnthropic,
      });
    }

    if (invalidRefs.length > 0) {
      console.warn("[files-agent] Rejected invalid file references", {
        sessionId,
        userId: user.id,
        requestedCount: uploadedFiles.length,
        invalidCount: invalidRefs.length,
        invalidSample: invalidRefs.slice(0, 5),
      });
      return NextResponse.json(
        {
          error:
            "One or more file references are invalid or expired. Please re-upload files and retry.",
        },
        { status: 400 }
      );
    }

    validatedUploadedFiles = nextValidated;
  }

  // Get user message
  const lastUserMessage = [...messages].reverse().find((m) => m.role === "user");
  const userText = lastUserMessage?.content || "";

  let traceId: string | null = null;
  let traceCreatedAtIso = new Date().toISOString();

  // Persist user message
  if (userText.trim()) {
    const messageMetadata: Record<string, unknown> = { agent_id: agentId };
    if (validatedUploadedFiles.length > 0) {
      messageMetadata.files = validatedUploadedFiles.map((f) => ({
        id: f.id,
        name: f.name,
        anthropicFileId: f.anthropicFileId || null,
      }));
    }

    await supabase.from("chat_messages").insert({
      user_id: user.id,
      session_id: sessionId,
      role: "user",
      content: userText,
      metadata: messageMetadata,
    });

    const trace = await createAgentTrace(supabase, {
      userId: user.id,
      agentId,
      sessionId,
      agentName: agent.name,
      agentType: agent.type,
      flagKey: (agent as unknown as { flag_key?: string | null }).flag_key || null,
      provider: "anthropic",
      model: MODEL,
      prompt: userText,
      metadata: {
        uploaded_files: validatedUploadedFiles.map((f) => ({ id: f.id, name: f.name })),
      },
    });
    traceId = trace.traceId;
    traceCreatedAtIso = trace.createdAtIso;

    // Update session timestamp + title if first message
    const { count } = await supabase
      .from("chat_messages")
      .select("id", { count: "exact", head: true })
      .eq("session_id", sessionId);

    const updateData: { updated_at: string; title?: string } = {
      updated_at: new Date().toISOString(),
    };
    if (count === 1) {
      updateData.title = userText.length > 50 ? userText.slice(0, 47).trim() + "…" : userText;
    }
    await supabase.from("chat_sessions").update(updateData).eq("id", sessionId);
  }

  // Build Anthropic client with beta headers for Skills
  const anthropic = new Anthropic(apiKey ? { apiKey } : {});

  // Build messages for Anthropic
  const anthropicMessages: Anthropic.MessageParam[] = [];
  
  for (const m of messages) {
    if (m.role === "user") {
      anthropicMessages.push({ role: "user", content: m.content });
    } else if (m.role === "assistant") {
      anthropicMessages.push({ role: "assistant", content: m.content });
    }
  }

  // If the last message is user and has uploaded files, rebuild it with file references
  if (anthropicMessages.length > 0 && validatedUploadedFiles.length > 0) {
    const lastIdx = anthropicMessages.length - 1;
    const lastMsg = anthropicMessages[lastIdx];
    if (lastMsg.role === "user") {
      // Build content array with text and file references
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const contentBlocks: any[] = [
        { type: "text", text: typeof lastMsg.content === "string" ? lastMsg.content : "" }
      ];
      
      // Add file references for files with anthropicFileId
      for (const file of validatedUploadedFiles) {
        if (file.anthropicFileId) {
          // Use container_upload for files to be used with code execution
          contentBlocks.push({
            type: "container_upload",
            file_id: file.anthropicFileId,
          });
        }
      }
      
      anthropicMessages[lastIdx] = { role: "user", content: contentBlocks };
    }
  }

  // Build system prompt
  const customSystemPrompt =
    typeof agent.system_prompt === "string" && agent.system_prompt.trim()
      ? agent.system_prompt.trim()
      : null;

  const defaultSystemPrompt = `You are a Files Agent that can read, analyze, and create documents.

You have access to these document skills:
- xlsx: Read and create Excel spreadsheets
- pptx: Create and edit PowerPoint presentations
- docx: Create and edit Word documents
- pdf: Generate PDF reports

When the user uploads a file or asks you to create a document:
1. Use the appropriate skill to process or create the file
2. Provide clear explanations of what you're doing
3. When creating files, generate high-quality, professional output

CRITICAL OUTPUT RULE:
- If the user asks for a chart/dashboard/visualization and/or an Excel file, you MUST produce real downloadable artifacts via code execution output:
  - At least one PNG image (e.g. a bar chart/dashboard)
  - And at least one XLSX file (spreadsheet)
- Do NOT only describe what you would generate. Actually generate the files so they appear as outputs.

VERIFICATION EFFICIENCY PRINCIPLE:
- Verification is required, but it must be information-gaining.
- Before repeating a parsing or generation step, confirm what new evidence it can produce.
- Do not repeat semantically equivalent checks or generation attempts when no new hypothesis is being tested.
- If recent checks are converging on the same conclusion and no new evidence path exists, stop re-checking and proceed.
- When stopping verification, report what was verified, current confidence, unresolved uncertainty (if any), and the highest-value next check.`;

  const system = customSystemPrompt || defaultSystemPrompt;

  // Create a streaming response
  const encoder = new TextEncoder();
  
  const readableStream = new ReadableStream({
    async start(controller) {
      let streamClosed = false;
      let keepaliveTimer: ReturnType<typeof setInterval> | null = null;
      let statusTimer: ReturnType<typeof setInterval> | null = null;
      let lastAgentActivityAt = Date.now();

      const safeEnqueue = (payload: string) => {
        if (streamClosed) return;
        try {
          controller.enqueue(encoder.encode(payload));
        } catch {
          streamClosed = true;
        }
      };

      const sendEvent = (event: Record<string, unknown>) => {
        safeEnqueue(`data: ${JSON.stringify(event)}\n\n`);
      };

      const sendStatus = (text: string) => {
        const msg = text.trim();
        if (!msg) return;
        sendEvent({ type: "status", text: msg });
      };

      const markAgentActivity = () => {
        lastAgentActivityAt = Date.now();
      };

      const clearTimers = () => {
        if (keepaliveTimer) {
          clearInterval(keepaliveTimer);
          keepaliveTimer = null;
        }
        if (statusTimer) {
          clearInterval(statusTimer);
          statusTimer = null;
        }
      };

      try {
        sendStatus("Files Agent started. Processing request...");
        markAgentActivity();
        keepaliveTimer = setInterval(() => {
          // Keep SSE connection active even when Anthropic has no text deltas yet.
          safeEnqueue(`: keepalive ${Date.now()}\n\n`);
        }, 10_000);
        statusTimer = setInterval(() => {
          // Fallback heartbeat only when the upstream stream has been quiet.
          if (Date.now() - lastAgentActivityAt >= 25_000) {
            sendStatus("Files Agent is still working...");
            markAgentActivity();
          }
        }, 5_000);

        // Call Anthropic with code execution (streaming required for long operations)
        const stream = anthropic.beta.messages.stream({
          model: MODEL,
          max_tokens: 16384,
          system,
          messages: anthropicMessages,
          tools: [{
            type: "code_execution_20250522",
            name: "code_execution",
          }],
          betas: [...FILES_AGENT_BETAS],
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any);

        let responseText = "";
        const generatedFiles: GeneratedFileInfo[] = [];

        // Stream raw Anthropic events so status updates reflect real agent actions.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        for await (const rawEvent of stream as any) {
          const event =
            rawEvent && typeof rawEvent === "object"
              ? (rawEvent as Record<string, unknown>)
              : null;
          if (!event) continue;
          const type = typeof event.type === "string" ? event.type : "";
          if (!type) continue;
          markAgentActivity();

          if (type === "content_block_delta") {
            const delta =
              event.delta && typeof event.delta === "object"
                ? (event.delta as Record<string, unknown>)
                : null;
            const deltaType = delta && typeof delta.type === "string" ? delta.type : "";

            if (deltaType === "text_delta") {
              const text = typeof delta?.text === "string" ? delta.text : "";
              if (text) {
                responseText += text;
                sendEvent({ type: "text", text });
              }
            }
            continue;
          }

          if (type === "content_block_start") {
            const block =
              event.content_block && typeof event.content_block === "object"
                ? (event.content_block as Record<string, unknown>)
                : null;
            const blockType = block && typeof block.type === "string" ? block.type : "";
            const blockName = block && typeof block.name === "string" ? block.name : "";

            if (blockType === "server_tool_use" || blockType === "tool_use") {
              const toolName = blockName || "unknown_tool";
              sendStatus(`Agent tool started: ${toolName}`);
            } else if (blockType && blockType !== "text") {
              sendStatus(`Agent block started: ${blockType}`);
            }
            continue;
          }

          if (type === "message_delta") {
            const delta =
              event.delta && typeof event.delta === "object"
                ? (event.delta as Record<string, unknown>)
                : null;
            const stopReason =
              delta && typeof delta.stop_reason === "string" ? delta.stop_reason : "";
            if (stopReason && stopReason !== "end_turn") {
              sendStatus(`Agent stop reason: ${stopReason}`);
            }
            continue;
          }
        }

        // Wait for stream to complete
        const response = await stream.finalMessage();
        sendStatus("Model response received. Preparing generated files...");

        // Extract files from code_execution_tool_result blocks
        // Files are in: block.content.content[].file_id where type is "code_execution_output"
        const outputFileIds: string[] = [];
        for (const block of response.content) {
          if (block.type === "code_execution_tool_result") {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const resultBlock = block as any;
            const innerContent = resultBlock?.content?.content;
            if (Array.isArray(innerContent)) {
              for (const item of innerContent) {
                if (item.type === "code_execution_output" && item.file_id) {
                  outputFileIds.push(item.file_id);
                }
              }
            }
          }
        }

        console.log("[files-agent] Found output file IDs:", outputFileIds);

        // Download and store each file
        for (let fileIndex = 0; fileIndex < outputFileIds.length; fileIndex++) {
          const fileId = outputFileIds[fileIndex];
          sendStatus(`Preparing file ${fileIndex + 1}/${outputFileIds.length}...`);
          try {
            // First get file metadata to know the filename
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const fileMeta = await (anthropic.beta.files as any).retrieveMetadata(
              fileId,
              { betas: ["files-api-2025-04-14"] }
            );
            console.log("[files-agent] File metadata:", JSON.stringify(fileMeta, null, 2));
            
            const fileName = fileMeta?.filename || `file_${generatedFiles.length + 1}`;
            
            // Download the file content
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const fileResponse = await (anthropic.beta.files as any).download(
              fileId,
              { betas: ["files-api-2025-04-14"] }
            );
            
            // Convert to buffer
            let fileBuffer: Buffer;
            if (fileResponse instanceof Response) {
              const arrayBuffer = await fileResponse.arrayBuffer();
              fileBuffer = Buffer.from(arrayBuffer);
            } else if (fileResponse?.body?.getReader) {
              const chunks: Uint8Array[] = [];
              const reader = fileResponse.body.getReader();
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                chunks.push(value);
              }
              fileBuffer = Buffer.concat(chunks);
            } else if (Buffer.isBuffer(fileResponse)) {
              fileBuffer = fileResponse;
            } else {
              fileBuffer = Buffer.from(fileResponse);
            }

            console.log("[files-agent] Downloaded file, size:", fileBuffer.length);

            // Determine mime type from extension
            const ext = fileName.split(".").pop()?.toLowerCase() || "";
            const mimeTypes: Record<string, string> = {
              xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
              pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
              docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
              pdf: "application/pdf",
              png: "image/png",
              jpg: "image/jpeg",
              jpeg: "image/jpeg",
            };
            const mimeType = mimeTypes[ext] || "application/octet-stream";

            // Store in Supabase
            const storagePath = `${user.id}/${sessionId}/${randomUUID()}-${fileName.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
            
            const { error: uploadError } = await supabase.storage
              .from("chat_uploads")
              .upload(storagePath, fileBuffer, {
                contentType: mimeType,
                upsert: false,
              });

            if (!uploadError) {
              const { data: signedData } = await supabase.storage
                .from("chat_uploads")
                .createSignedUrl(storagePath, 3600);

              const fileInfo: GeneratedFileInfo = {
                name: fileName,
                mediaType: mimeType,
                url: signedData?.signedUrl,
                // Compatibility fields for stable proxy downloads/previews.
                filename: fileName,
                mime_type: mimeType,
                storage_path: storagePath,
                file_id: fileId,
              };
              generatedFiles.push(fileInfo);

              // Stream file info to client
              sendEvent({ type: "file", file: fileInfo });

              await supabase.from("chat_attachments").insert({
                user_id: user.id,
                session_id: sessionId,
                storage_path: storagePath,
                file_name: fileName,
                mime_type: mimeType,
                size_bytes: fileBuffer.length,
              });
              
              console.log("[files-agent] File stored successfully:", fileName);
            } else {
              console.error("[files-agent] Supabase upload error:", uploadError);
            }
          } catch (downloadErr) {
            console.error("[files-agent] Failed to download file:", downloadErr);
          }
        }

        // Persist assistant message
        const messageMetadata: Record<string, unknown> = {
          agent_id: agentId,
          provider: "anthropic",
          model: MODEL,
        };
        if (generatedFiles.length > 0) {
          messageMetadata.generated_files = generatedFiles;
        }

        await supabase.from("chat_messages").insert({
          user_id: user.id,
          session_id: sessionId,
          role: "assistant",
          content: responseText || "[File operation completed]",
          metadata: messageMetadata,
        });

        if (traceId && (responseText || generatedFiles.length > 0)) {
          const responseForTrace = responseText || "[File operation completed]";
          const generatedFilesForTrace = generatedFiles.map((f) => ({
            name: f.name,
            mediaType: f.mediaType,
            filename: f.filename,
            mime_type: f.mime_type,
            storage_path: f.storage_path,
            file_id: f.file_id,
          }));
          await completeAgentTrace(supabase, { traceId, response: responseForTrace });
          // Fire-and-forget: don't block response waiting for Datagran
          ingestAgentTraceToDatagranBestEffort(supabase, {
            userId: user.id,
            traceId,
            createdAtIso: traceCreatedAtIso,
            agentName: agent.name,
            agentType: agent.type,
            flagKey: (agent as unknown as { flag_key?: string | null }).flag_key || null,
            provider: "anthropic",
            model: MODEL,
            sessionId,
            prompt: userText,
            response: responseForTrace,
            metadata: {
              uploaded_files: validatedUploadedFiles.map((f) => ({ id: f.id, name: f.name })),
              generated_files: generatedFilesForTrace,
            },
          });
        }

        await supabase
          .from("chat_sessions")
          .update({ updated_at: new Date().toISOString() })
          .eq("id", sessionId);

        // Send done signal
        sendStatus("Finalizing response...");
        sendEvent({ type: "done", files: generatedFiles });
        clearTimers();
        if (!streamClosed) {
          controller.close();
          streamClosed = true;
        }
      } catch (err) {
        clearTimers();
        console.error("[files-agent] Anthropic API error:", err);
        sendEvent({
          type: "error",
          error: err instanceof Error ? err.message : "Failed to process request",
        });
        if (!streamClosed) {
          controller.close();
          streamClosed = true;
        }
      }
    },
  });

  return new Response(readableStream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
