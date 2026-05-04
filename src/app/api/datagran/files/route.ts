import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { resolveKeys } from "@/lib/keys/resolveKeyMode";

// MIME type mapping for common file extensions
const MIME_TYPES: Record<string, string> = {
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  svg: "image/svg+xml",
  csv: "text/csv",
  json: "application/json",
  txt: "text/plain",
  html: "text/html",
};

function getMimeType(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase() || "";
  return MIME_TYPES[ext] || "application/octet-stream";
}

export async function GET(req: Request) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const fileId = url.searchParams.get("fileId");
  const storagePath = url.searchParams.get("storagePath");
  const agentId = url.searchParams.get("agentId");

  if ((!fileId && !storagePath) || !agentId) {
    return NextResponse.json(
      { error: "Missing fileId/storagePath or agentId" },
      { status: 400 }
    );
  }

  // If storagePath is provided, serve directly from Supabase storage
  if (storagePath) {
    try {
      // Verify the file belongs to this user by checking the path prefix
      if (!storagePath.startsWith(`${user.id}/`)) {
        return NextResponse.json({ error: "Access denied" }, { status: 403 });
      }

      const { data, error } = await supabase.storage
        .from("chat_uploads")
        .download(storagePath);

      if (error || !data) {
        console.error("[datagran-files] Supabase download error:", error);
        return NextResponse.json(
          { error: "File not found in storage" },
          { status: 404 }
        );
      }

      const filename = storagePath.split("/").pop() || "download";
      const contentType = getMimeType(filename);

      const buffer = Buffer.from(await data.arrayBuffer());

      return new Response(buffer, {
        headers: {
          "Content-Type": contentType,
          "Content-Disposition": `inline; filename="${filename}"`,
          "Cache-Control": "public, max-age=3600",
        },
      });
    } catch (error) {
      console.error("[datagran-files] Storage retrieval error:", error);
      return NextResponse.json(
        { error: error instanceof Error ? error.message : "Failed to retrieve file" },
        { status: 500 }
      );
    }
  }

  // Helper to search for file in message metadata and serve if found
  const searchMessagesForFile = async (
    messages: Array<{ metadata?: Record<string, unknown> }> | null,
    targetFileId: string
  ): Promise<Response | null> => {
    if (!messages) return null;
    for (const msg of messages) {
      const files = msg.metadata?.generated_files || msg.metadata?.files;
      if (Array.isArray(files)) {
        const matchedFile = files.find(
          (f: { file_id?: string; storage_path?: string }) => f.file_id === targetFileId && f.storage_path
        );
        if (matchedFile?.storage_path) {
          const { data, error } = await supabase.storage
            .from("chat_uploads")
            .download(matchedFile.storage_path);

          if (!error && data) {
            const filename = matchedFile.filename || matchedFile.storage_path.split("/").pop() || "download";
            const contentType = matchedFile.mime_type || getMimeType(filename);
            const buffer = Buffer.from(await data.arrayBuffer());

            return new Response(buffer, {
              headers: {
                "Content-Type": contentType,
                "Content-Disposition": `inline; filename="${filename}"`,
                "Cache-Control": "public, max-age=3600",
              },
            });
          }
        }
      }
    }
    return null;
  };

  // Check chat_messages for the file
  const { data: chatMessages } = await supabase
    .from("chat_messages")
    .select("metadata")
    .eq("user_id", user.id)
    .not("metadata", "is", null)
    .order("created_at", { ascending: false })
    .limit(50);

  const chatResult = await searchMessagesForFile(chatMessages, fileId!);
  if (chatResult) return chatResult;

  // Also check orchestrator_messages (orchestrator stores generated files here)
  const { data: orchMessages } = await supabase
    .from("orchestrator_messages")
    .select("metadata")
    .eq("user_id", user.id)
    .not("metadata", "is", null)
    .order("created_at", { ascending: false })
    .limit(50);

  const orchResult = await searchMessagesForFile(orchMessages, fileId!);
  if (orchResult) return orchResult;

  // Fall back to Anthropic Files API for legacy/non-persisted files
  const cookie = req.headers.get("cookie") || "";
  const resolved = await resolveKeys(user.id, supabase, cookie);
  const keyMode = resolved.keyModes.anthropic || resolved.globalMode;
  const anthropicApiKey: string | null =
    keyMode === "user" ? (resolved.userKeys.anthropic || null) : null;

  if (keyMode === "user" && !anthropicApiKey) {
    return NextResponse.json(
      { error: "Missing Anthropic API key. Add it in Settings, or switch Anthropic to Groovy." },
      { status: 400 }
    );
  }
  if (keyMode === "groovy" && !process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json(
      { error: "Groovy Anthropic API key not configured on server" },
      { status: 500 }
    );
  }

  const anthropic = new Anthropic(anthropicApiKey ? { apiKey: anthropicApiKey } : {});

  try {
    // Get file metadata from Anthropic (use beta flag for code execution files)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const metadata = await (anthropic.beta.files as any).retrieveMetadata(
      fileId!,
      { betas: ["files-api-2025-04-14"] }
    );

    // Download file content from Anthropic
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fileContent = await (anthropic.beta.files as any).download(
      fileId!,
      { betas: ["files-api-2025-04-14"] }
    );
    
    // Convert response to buffer
    const arrayBuffer = await fileContent.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // Determine content type based on filename
    const filename = metadata.filename || "output";
    const contentType = getMimeType(filename);

    return new Response(buffer, {
      headers: {
        "Content-Type": contentType,
        "Content-Disposition": `inline; filename="${filename}"`,
        "Cache-Control": "public, max-age=3600",
      },
    });
  } catch (error) {
    console.error("[datagran-files] Anthropic retrieval error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to retrieve file" },
      { status: 500 }
    );
  }
}
