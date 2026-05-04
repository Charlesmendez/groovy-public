import { NextResponse } from "next/server";
import type { ModelMessage } from "ai";
import * as XLSX from "xlsx";
import * as mammoth from "mammoth";
import { extractText as extractPdfText } from "unpdf";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { verifyRelayDeviceToken } from "@/lib/relay/deviceToken";
import { runOrchestratorRound } from "@/lib/orchestrator/runOrchestratorRound";
import { extractWhatsAppSendConfirmation } from "@/lib/whatsapp/pendingSend";
import { resolveKeys } from "@/lib/keys/resolveKeyMode";
import { normalizeConnectorPlatform, type ConnectorClientPlatform } from "@/lib/connector/platform";
import {
  normalizeTwilioSupervisorState,
  type AiyraTwilioSupervisorState,
} from "@/lib/aiyra/twilio";
import {
  applyPendingInboxActionSilencePolicy,
  executeInboxCommand,
} from "@/lib/inbox/actions";
import {
  getOrCreateRuntimeSessionForAgent,
  resolveRuntimeScope,
  incrementBranchTurnCount,
} from "@/lib/orchestrator/runtimeGraph";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 800;

type ToolResultInput = {
  toolCallId: string;
  toolName: string;
  result: string;
};

type FileInput = {
  mediaType: string;
  base64: string;
  filename?: string | null;
};

type Body = {
  provider?: string; // defaults to whatsapp_web
  threadKey?: string;
  threadName?: string;
  message?: string;
  command?: "new"; // start a new orchestrator session for this thread
  memoryEnabled?: boolean;
  obsidianVaultPath?: string;
  connectorPlatform?: ConnectorClientPlatform;
  mode?: "orch" | "code";
  code?: {
    terminalId?: string;
    workspaceRootPath?: string;
  };
  toolResults?: ToolResultInput[];
  // Attached files (images, documents, etc.)
  files?: FileInput[];
  // Optional fixed trace across multiple rounds
  traceId?: string;
  // Optional connector follow-up payload for command fast-paths
  commandFollowup?: {
    pendingMessageId?: string;
    finalReply?: string;
  };
  twilioFollowup?: {
    sinceCursor?: string | null;
    sessionId?: string | null;
  };
};

function requireString(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t ? t : null;
}

function looksLikeConnectorLocalPath(rawPath: string): boolean {
  const value = rawPath.trim();
  if (!value) return false;
  if (/^[a-z]+:\/\//i.test(value)) return false;
  if (value.startsWith("~/") || value.startsWith("~\\")) return true;
  if (value.startsWith("/") || value.startsWith("\\")) return true;
  if (/^[a-zA-Z]:[\\/]/.test(value)) return true;
  return false;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  if (!v || typeof v !== "object") return null;
  if (Array.isArray(v)) return null;
  return v as Record<string, unknown>;
}

function toTrimmed(v: unknown): string {
  return typeof v === "string" ? v.trim() : v === null || v === undefined ? "" : String(v).trim();
}

function normalizeDecisionText(v: string): string {
  return v
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[.!,]+$/g, "");
}

const WHATSAPP_TWILIO_FOLLOWUP_TOOL_NAMES = new Set([
  "start_twilio_call",
  "start_twilio_sms",
  "get_twilio_child_status",
  "coach_twilio_child",
]);

function isTerminalTwilioSupervisorState(
  state: AiyraTwilioSupervisorState | null | undefined
): boolean {
  const status = toTrimmed(state?.status).toLowerCase();
  return status === "completed" || status === "failed" || status === "ended";
}

function getTwilioSupervisorCursor(
  state: AiyraTwilioSupervisorState | null | undefined
): string | null {
  if (!state) return null;
  return (
    requireString(state.id) ||
    requireString(state.at) ||
    requireString(
      [
        state.childKind,
        state.status,
        state.stage,
        state.summary,
        state.rawText,
      ]
        .map((part) => toTrimmed(part))
        .filter(Boolean)
        .join("|")
    )
  );
}

function normalizeTwilioUpdateText(value: string | null | undefined): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function buildWhatsAppTwilioFollowupMessage(
  state: AiyraTwilioSupervisorState | null | undefined
): string | null {
  if (!state) return null;
  const kind = toTrimmed(state.childKind).toLowerCase() === "sms" ? "SMS" : "Call";
  const status = toTrimmed(state.status).toLowerCase();
  const stage = toTrimmed(state.stage).toLowerCase();
  const detail = normalizeTwilioUpdateText(state.summary || state.rawText || "");
  const detailLower = detail.toLowerCase();
  const assistantPrefix =
    /^(i told them|i said|agent message|agent said|assistant said|groovy said)\s*:?\s*/i;
  const contactPrefix =
    /^(they said|contact said|recipient said|caller said|customer said|user said)\s*:?\s*/i;

  if (detail) {
    if (/^started supervised (outbound )?(phone )?call\b/i.test(detail)) {
      return `${kind} started.`;
    }
    if (/^started supervised outbound sms\b/i.test(detail)) {
      return `${kind} started.`;
    }
    if (assistantPrefix.test(detail)) {
      const cleaned = detail.replace(assistantPrefix, "").trim();
      if (
        /(call|conversation)\s+has\s+ended/.test(cleaned.toLowerCase()) ||
        /^goodbye[.! ]*$/.test(cleaned.toLowerCase())
      ) {
        return `${kind} ended.`;
      }
      return cleaned ? `Groovy: ${cleaned}` : null;
    }
    if (contactPrefix.test(detail)) {
      const cleaned = detail.replace(contactPrefix, "").trim();
      return cleaned ? `Them: ${cleaned}` : null;
    }
    if (/(^|_)(agent|assistant|groovy)(_|$)/.test(stage)) {
      return `Groovy: ${detail}`;
    }
    if (/(^|_)(contact|recipient|caller|customer|user)(_|$)/.test(stage)) {
      return `Them: ${detail}`;
    }
    if (isTerminalTwilioSupervisorState(state)) {
      if (/(call|conversation)\s+has\s+ended/.test(detailLower)) {
        return `${kind} ended.`;
      }
      return `${kind} ended.\n${detail}`;
    }
    if (status === "active") {
      return `${kind}: ${detail}`;
    }
  }

  if (status === "starting") return `${kind} started.`;
  if (status === "failed") return `${kind} failed.`;
  if (status === "completed" || status === "ended") return `${kind} ended.`;
  if (status === "active" && stage.includes("ring")) return `${kind} ringing…`;
  if (status === "active" && stage.includes("connect")) return `${kind} connected.`;
  return null;
}

async function loadLatestTwilioSupervisorStateForSession(opts: {
  supabase: ReturnType<typeof createSupabaseAdminClient>;
  userId: string;
  sessionId: string;
}): Promise<{
  conversationId: string | null;
  state: AiyraTwilioSupervisorState | null;
} | null> {
  const { data, error } = await opts.supabase
    .from("aiyra_conversations")
    .select(
      "conversation_id,channel_mode,twilio_supervisor_state,twilio_last_update_at,updated_at"
    )
    .eq("user_id", opts.userId)
    .eq("orchestrator_session_id", opts.sessionId)
    .eq("channel_mode", "twilio_parent")
    .not("twilio_supervisor_state", "is", null)
    .order("twilio_last_update_at", { ascending: false, nullsFirst: false })
    .order("updated_at", { ascending: false, nullsFirst: false })
    .limit(12);
  if (error || !Array.isArray(data) || data.length === 0) return null;

  const rows = data
    .map((row) => {
      const rec = asRecord(row);
      const state = normalizeTwilioSupervisorState(rec?.twilio_supervisor_state);
      if (!state) return null;
      const twilioUpdatedAt = requireString(rec?.twilio_last_update_at);
      const updatedAt = requireString(rec?.updated_at);
      const stateAt = requireString(state.at);
      const ts = stateAt || twilioUpdatedAt || updatedAt || "";
      const tsMs = Number.isFinite(Date.parse(ts)) ? Date.parse(ts) : 0;
      return {
        conversationId: requireString(rec?.conversation_id),
        channelMode: requireString(rec?.channel_mode) || "",
        state,
        tsMs,
      };
    })
    .filter(
      (
        row
      ): row is {
        conversationId: string | null;
        channelMode: string;
        state: AiyraTwilioSupervisorState;
        tsMs: number;
      } => row != null
    )
    .sort((a, b) => {
      if (b.tsMs !== a.tsMs) return b.tsMs - a.tsMs;
      if (a.channelMode === b.channelMode) return 0;
      if (a.channelMode === "twilio_parent") return -1;
      if (b.channelMode === "twilio_parent") return 1;
      return 0;
    });

  if (rows.length === 0) return null;
  return {
    conversationId: rows[0].conversationId,
    state: rows[0].state,
  };
}

function parseYesNo(v: string): "yes" | "no" | null {
  const t = normalizeDecisionText(v);
  if (!t) return null;
  if (t === "yes" || t === "y" || t === "send" || t === "send it" || t === "confirm" || t === "ok") return "yes";
  if (t === "no" || t === "n" || t === "cancel" || t === "stop") return "no";
  return null;
}

async function findLatestActivePendingWhatsAppSend(opts: {
  supabase: ReturnType<typeof createSupabaseAdminClient>;
  userId: string;
  sessionId: string;
}): Promise<{
  pendingMessageId: string;
  pending: {
    chatId: string;
    recipientDisplay?: string;
    text?: string;
    media?: Array<{
      url?: string;
      localPath?: string;
      storagePath?: string;
      fileId?: string;
      filename?: string;
      caption?: string;
    }>;
  };
} | null> {
  const { supabase, userId, sessionId } = opts;
  const { data: rows } = await supabase
    .from("orchestrator_messages")
    .select("id, role, metadata, created_at")
    .eq("user_id", userId)
    .eq("session_id", sessionId)
    .order("created_at", { ascending: false })
    .limit(40);

  const consumed = new Set<string>();
  for (const r of rows || []) {
    const meta = (r as { metadata?: unknown }).metadata as Record<string, unknown> | null;
    const consumedOf = meta && typeof meta === "object" ? (meta as { whatsapp_send_consumed_of?: unknown }).whatsapp_send_consumed_of : undefined;
    if (typeof consumedOf === "string" && consumedOf) consumed.add(consumedOf);
  }

  for (const r of rows || []) {
    const id = (r as { id?: unknown }).id;
    const role = (r as { role?: unknown }).role;
    if (role !== "assistant") continue;
    if (typeof id !== "string" || !id) continue;
    if (consumed.has(id)) continue;
    const meta = (r as { metadata?: unknown }).metadata as Record<string, unknown> | null;
    const pendingRaw =
      meta && typeof meta === "object" ? (meta as { whatsapp_pending_send?: unknown }).whatsapp_pending_send : null;
    if (!pendingRaw || typeof pendingRaw !== "object") continue;
    const pendingObj = pendingRaw as {
      chatId?: unknown;
      recipientDisplay?: unknown;
      text?: unknown;
      media?: unknown;
    };
    const chatId = typeof pendingObj.chatId === "string" ? pendingObj.chatId.trim() : "";
    const text = typeof pendingObj.text === "string" ? pendingObj.text.trim() : "";
    const recipientDisplay =
      typeof pendingObj.recipientDisplay === "string" ? pendingObj.recipientDisplay.trim() : undefined;
    const media = Array.isArray(pendingObj.media)
      ? pendingObj.media
          .map((entry) =>
            entry && typeof entry === "object" ? (entry as Record<string, unknown>) : null
          )
          .filter((entry): entry is Record<string, unknown> => !!entry)
          .map((entry) => {
            const url =
              typeof entry.url === "string" && entry.url.trim() ? entry.url.trim() : undefined;
            const storagePath =
              typeof entry.storagePath === "string" && entry.storagePath.trim()
                ? entry.storagePath.trim()
                : typeof entry.storage_path === "string" && entry.storage_path.trim()
                  ? entry.storage_path.trim()
                  : undefined;
            const localPath =
              typeof entry.localPath === "string" && entry.localPath.trim()
                ? entry.localPath.trim()
                : typeof entry.local_path === "string" && entry.local_path.trim()
                  ? entry.local_path.trim()
                  : undefined;
            const fileId =
              typeof entry.fileId === "string" && entry.fileId.trim()
                ? entry.fileId.trim()
                : typeof entry.file_id === "string" && entry.file_id.trim()
                  ? entry.file_id.trim()
                  : undefined;
            const filename =
              typeof entry.filename === "string" && entry.filename.trim()
                ? entry.filename.trim()
                : undefined;
            const caption =
              typeof entry.caption === "string" && entry.caption.trim()
                ? entry.caption.trim()
                : undefined;
            const item: {
              url?: string;
              localPath?: string;
              storagePath?: string;
              fileId?: string;
              filename?: string;
              caption?: string;
            } = {};
            if (url) item.url = url;
            if (localPath) item.localPath = localPath;
            if (storagePath) item.storagePath = storagePath;
            if (fileId) item.fileId = fileId;
            if (filename) item.filename = filename;
            if (caption) item.caption = caption;
            if (!item.url && !item.localPath && !item.storagePath && !item.fileId) return null;
            return item;
          })
          .filter(
            (
              item
            ): item is {
              url?: string;
              localPath?: string;
              storagePath?: string;
              fileId?: string;
              filename?: string;
              caption?: string;
            } => !!item
          )
      : [];
    if (!chatId || (!text && media.length === 0)) continue;
    return {
      pendingMessageId: id,
      pending: {
        chatId,
        ...(text ? { text } : {}),
        ...(recipientDisplay ? { recipientDisplay } : {}),
        ...(media.length > 0 ? { media } : {}),
      },
    };
  }

  return null;
}

function filenameFromStoragePath(storagePath: string): string | undefined {
  const name = storagePath.split("/").pop() || "";
  const trimmed = name.trim();
  return trimmed ? trimmed : undefined;
}

function filenameFromLocalPath(localPath: string): string | undefined {
  const normalized = localPath.replace(/\\/g, "/");
  const name = normalized.split("/").pop() || "";
  const trimmed = name.trim();
  return trimmed ? trimmed : undefined;
}

type SessionGeneratedMediaRefs = {
  storagePaths: Set<string>;
  fileIds: Set<string>;
};

function extractSessionIdFromStoragePath(
  storagePath: string,
  userId: string
): string | null {
  if (!storagePath.startsWith(`${userId}/`)) return null;
  const remainder = storagePath.slice(userId.length + 1);
  const sessionId = remainder.split("/")[0] || "";
  return sessionId.trim() ? sessionId.trim() : null;
}

async function loadLinkedFilesSessionIds(opts: {
  supabase: ReturnType<typeof createSupabaseAdminClient>;
  userId: string;
  sessionId: string;
}): Promise<Set<string>> {
  const { supabase, userId, sessionId } = opts;
  const allowed = new Set<string>();
  const { data: rows } = await supabase
    .from("orchestrator_agent_sessions")
    .select("agent_session_id")
    .eq("user_id", userId)
    .eq("orchestrator_session_id", sessionId)
    .eq("agent_type", "files")
    .limit(20);
  for (const row of rows || []) {
    const id =
      row && typeof row === "object"
        ? (typeof (row as { agent_session_id?: unknown }).agent_session_id === "string"
            ? (row as { agent_session_id: string }).agent_session_id.trim()
            : "")
        : "";
    if (id) allowed.add(id);
  }
  return allowed;
}

async function loadSessionGeneratedMediaRefs(opts: {
  supabase: ReturnType<typeof createSupabaseAdminClient>;
  userId: string;
  sessionId: string;
}): Promise<SessionGeneratedMediaRefs> {
  const { supabase, userId, sessionId } = opts;
  const refs: SessionGeneratedMediaRefs = {
    storagePaths: new Set<string>(),
    fileIds: new Set<string>(),
  };
  const { data: rows } = await supabase
    .from("orchestrator_messages")
    .select("metadata, created_at")
    .eq("user_id", userId)
    .eq("session_id", sessionId)
    .not("metadata", "is", null)
    .order("created_at", { ascending: false })
    .limit(1000);

  for (const row of rows || []) {
    const metadata =
      row && typeof row === "object" ? (row as { metadata?: unknown }).metadata : null;
    const rec =
      metadata && typeof metadata === "object"
        ? (metadata as Record<string, unknown>)
        : null;
    const generatedRaw = rec?.generated_files;
    if (!Array.isArray(generatedRaw)) continue;
    for (const rawFile of generatedRaw) {
      if (!rawFile || typeof rawFile !== "object") continue;
      const f = rawFile as Record<string, unknown>;
      const storagePath =
        (typeof f.storage_path === "string" && f.storage_path.trim()) ||
        (typeof f.storagePath === "string" && f.storagePath.trim()) ||
        "";
      const fileId =
        (typeof f.file_id === "string" && f.file_id.trim()) ||
        (typeof f.fileId === "string" && f.fileId.trim()) ||
        "";
      if (storagePath) refs.storagePaths.add(storagePath);
      if (fileId) refs.fileIds.add(fileId);
    }
  }
  return refs;
}

function sanitizeFilenameForStorage(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function filenameExtension(value: string): string {
  const sanitized = sanitizeFilenameForStorage(value.trim()).toLowerCase();
  const dot = sanitized.lastIndexOf(".");
  if (dot <= 0 || dot === sanitized.length - 1) return "";
  return sanitized.slice(dot);
}

function filenamesAreCompatible(actualFilename: string, providedFilename: string): boolean {
  const baseNorm = sanitizeFilenameForStorage(actualFilename.trim()).toLowerCase();
  const providedNorm = sanitizeFilenameForStorage(providedFilename.trim()).toLowerCase();
  if (!baseNorm || !providedNorm) return false;
  return (
    baseNorm === providedNorm ||
    baseNorm.endsWith(`-${providedNorm}`) ||
    (filenameExtension(baseNorm) !== "" &&
      filenameExtension(baseNorm) === filenameExtension(providedNorm))
  );
}

function storagePathMatchesFilename(storagePath: string, filename: string): boolean {
  const base = filenameFromStoragePath(storagePath);
  if (!base) return false;
  return filenamesAreCompatible(base, filename);
}

function validateSessionMediaReference(args: {
  refs: SessionGeneratedMediaRefs;
  userId: string;
  allowedFilesSessionIds: Set<string>;
  storagePath?: string | null;
  fileId?: string | null;
}): { ok: true } | { ok: false; error: string } {
  const storagePath =
    typeof args.storagePath === "string" ? args.storagePath.trim() : "";
  const fileId = typeof args.fileId === "string" ? args.fileId.trim() : "";
  const pathSessionId =
    storagePath && args.userId
      ? extractSessionIdFromStoragePath(storagePath, args.userId)
      : null;
  if (pathSessionId && args.allowedFilesSessionIds.has(pathSessionId)) {
    return { ok: true };
  }
  const hasKnownRefs =
    args.refs.storagePaths.size > 0 || args.refs.fileIds.size > 0;
  if (!hasKnownRefs) {
    return {
      ok: false,
      error:
        "session_has_no_generated_files",
    };
  }
  if (fileId && args.refs.fileIds.has(fileId)) return { ok: true };
  if (storagePath && args.refs.storagePaths.has(storagePath)) return { ok: true };
  return { ok: false, error: "media_reference_not_in_session" };
}

async function resolvePendingWhatsAppMediaToUrl(opts: {
  supabase: ReturnType<typeof createSupabaseAdminClient>;
  userId: string;
  sessionRefs: SessionGeneratedMediaRefs;
  allowedFilesSessionIds: Set<string>;
  media: {
    url?: string;
    localPath?: string;
    storagePath?: string;
    fileId?: string;
    filename?: string;
    caption?: string;
  };
}): Promise<
  | {
      ok: true;
      connectorParams: {
        url?: string;
        local_path?: string;
        filename?: string;
        caption?: string;
      };
    }
  | { ok: false; error: string }
> {
  const { supabase, userId, sessionRefs, allowedFilesSessionIds, media } = opts;
  const directUrl = typeof media.url === "string" ? media.url.trim() : "";
  if (directUrl) {
    const explicitStoragePath =
      typeof media.storagePath === "string" ? media.storagePath.trim() : "";
    const explicitFileId = typeof media.fileId === "string" ? media.fileId.trim() : "";
    if (explicitStoragePath || explicitFileId) {
      const explicitRefCheck = validateSessionMediaReference({
        refs: sessionRefs,
        userId,
        allowedFilesSessionIds,
        storagePath: explicitStoragePath,
        fileId: explicitFileId,
      });
      if (!explicitRefCheck.ok) return { ok: false, error: explicitRefCheck.error };
      if (
        typeof media.filename === "string" &&
        media.filename.trim() &&
        explicitStoragePath &&
        !storagePathMatchesFilename(explicitStoragePath, media.filename.trim())
      ) {
        return { ok: false, error: "filename_storage_mismatch" };
      }
    }
    const storagePathFromUrl = (() => {
      try {
        const parsed = new URL(directUrl);
        const marker = "/storage/v1/object/sign/chat_uploads/";
        const idx = parsed.pathname.indexOf(marker);
        if (idx < 0) return "";
        const raw = parsed.pathname.slice(idx + marker.length).replace(/^\/+/, "");
        return raw ? decodeURIComponent(raw) : "";
      } catch {
        return "";
      }
    })();
    if (storagePathFromUrl) {
      if (!storagePathFromUrl.startsWith(`${userId}/`)) {
        return { ok: false, error: "storage_path_out_of_scope" };
      }
      const refCheck = validateSessionMediaReference({
        refs: sessionRefs,
        userId,
        allowedFilesSessionIds,
        storagePath: storagePathFromUrl,
        fileId: media.fileId || "",
      });
      if (!refCheck.ok) return { ok: false, error: refCheck.error };
      if (
        typeof media.filename === "string" &&
        media.filename.trim() &&
        !storagePathMatchesFilename(storagePathFromUrl, media.filename.trim())
      ) {
        return { ok: false, error: "filename_storage_mismatch" };
      }
    }
    return {
      ok: true,
      connectorParams: {
        url: directUrl,
        ...(media.filename ? { filename: media.filename } : {}),
        ...(media.caption ? { caption: media.caption } : {}),
      },
    };
  }

  let storagePath = typeof media.storagePath === "string" ? media.storagePath.trim() : "";
  let fallbackFilename = typeof media.filename === "string" ? media.filename.trim() : "";
  const fileId = typeof media.fileId === "string" ? media.fileId.trim() : "";
  const explicitLocalPath = typeof media.localPath === "string" ? media.localPath.trim() : "";
  if (explicitLocalPath && !looksLikeConnectorLocalPath(explicitLocalPath)) {
    return { ok: false, error: "invalid_local_path" };
  }
  const storagePathLooksLocal =
    storagePath &&
    looksLikeConnectorLocalPath(storagePath) &&
    !storagePath.startsWith(`${userId}/`);
  const localPathFromStorage = !explicitLocalPath && storagePathLooksLocal ? storagePath : "";
  const connectorLocalPath = explicitLocalPath || localPathFromStorage;

  if (connectorLocalPath) {
    const actualLocalFilename = filenameFromLocalPath(connectorLocalPath);
    if (
      fallbackFilename &&
      actualLocalFilename &&
      !filenamesAreCompatible(actualLocalFilename, fallbackFilename)
    ) {
      return { ok: false, error: "filename_local_path_mismatch" };
    }
    const nextFilename = fallbackFilename || filenameFromLocalPath(connectorLocalPath) || undefined;
    return {
      ok: true,
      connectorParams: {
        local_path: connectorLocalPath,
        ...(nextFilename ? { filename: nextFilename } : {}),
        ...(media.caption ? { caption: media.caption } : {}),
      },
    };
  }

  if (storagePath) {
    const preRefCheck = validateSessionMediaReference({
      refs: sessionRefs,
      userId,
      allowedFilesSessionIds,
      storagePath,
      fileId,
    });
    if (!preRefCheck.ok) return { ok: false, error: preRefCheck.error };
  }

  if (!storagePath && fileId) {
    const { data: row, error: rowErr } = await supabase
      .from("chat_attachments")
      .select("storage_path, file_name, created_at")
      .eq("user_id", userId)
      .eq("anthropic_file_id", fileId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (rowErr) {
      return { ok: false, error: `failed_to_resolve_file_id:${rowErr.message}` };
    }
    const rowObj = row as { storage_path?: unknown; file_name?: unknown } | null;
    storagePath = typeof rowObj?.storage_path === "string" ? rowObj.storage_path.trim() : "";
    if (!fallbackFilename) {
      fallbackFilename = typeof rowObj?.file_name === "string" ? rowObj.file_name.trim() : "";
    }
    const postRefCheck = validateSessionMediaReference({
      refs: sessionRefs,
      userId,
      allowedFilesSessionIds,
      storagePath,
      fileId,
    });
    if (!postRefCheck.ok) return { ok: false, error: postRefCheck.error };
  }

  if (!storagePath) {
    return { ok: false, error: "missing_media_reference" };
  }
  if (!storagePath.startsWith(`${userId}/`)) {
    return { ok: false, error: "storage_path_out_of_scope" };
  }
  if (
    typeof media.filename === "string" &&
    media.filename.trim() &&
    !storagePathMatchesFilename(storagePath, media.filename.trim())
  ) {
    return { ok: false, error: "filename_storage_mismatch" };
  }

  const { data: signedData, error: signErr } = await supabase.storage
    .from("chat_uploads")
    .createSignedUrl(storagePath, 3600);
  const signedUrl = signedData?.signedUrl || "";
  if (signErr || !signedUrl) {
    return {
      ok: false,
      error: `failed_to_sign_media:${signErr?.message || "missing_signed_url"}`,
    };
  }

  const nextFilename = fallbackFilename || filenameFromStoragePath(storagePath) || undefined;
  return {
    ok: true,
    connectorParams: {
      url: signedUrl,
      ...(nextFilename ? { filename: nextFilename } : {}),
      ...(media.caption ? { caption: media.caption } : {}),
    },
  };
}

function asToolResults(v: unknown): ToolResultInput[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((x) => x as Partial<ToolResultInput>)
    .filter(
      (x): x is ToolResultInput =>
        typeof x.toolCallId === "string" &&
        typeof x.toolName === "string" &&
        typeof x.result === "string"
    );
}

function summarizeConnectorToolResults(toolResults: ToolResultInput[]): Array<Record<string, unknown>> {
  return toolResults.map((tr) => {
    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = asRecord(JSON.parse(tr.result));
    } catch {
      parsed = null;
    }
    const inner = asRecord(parsed?.result);
    const outerOk = parsed?.ok === true;
    const innerOk = inner ? inner.ok !== false : true;
    const ok = outerOk && innerOk;
    const error =
      toTrimmed(inner?.error) || toTrimmed(parsed?.error) || (!ok ? "execution_failed" : "");
    const detail = toTrimmed(inner?.detail) || toTrimmed(parsed?.detail);
    const subject = toTrimmed(inner?.subject) || toTrimmed(parsed?.subject);
    const method = toTrimmed(inner?.method) || toTrimmed(parsed?.method);
    const statusRaw = inner?.status ?? parsed?.status;
    const status = Number.isFinite(Number(statusRaw)) ? Number(statusRaw) : null;
    const row: Record<string, unknown> = {
      toolCallId: tr.toolCallId,
      toolName: tr.toolName,
      ok,
    };
    if (error) row.error = error;
    if (detail) row.detail = detail;
    if (subject) row.subject = subject;
    if (method) row.method = method;
    if (typeof status === "number") row.status = status;
    return row;
  });
}

function asFiles(v: unknown): FileInput[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((x) => x as Partial<FileInput>)
    .filter(
      (x): x is FileInput =>
        typeof x.mediaType === "string" &&
        typeof x.base64 === "string"
    );
}

// Parse document files and extract text content
async function parseDocumentContent(file: FileInput): Promise<{ parsed: boolean; content: string; error?: string }> {
  const mime = file.mediaType || "";
  const filename = file.filename || "document";
  
  // Excel files (.xlsx, .xls)
  if (
    mime.includes("spreadsheet") ||
    mime.includes("excel") ||
    mime === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
    mime === "application/vnd.ms-excel" ||
    filename.endsWith(".xlsx") ||
    filename.endsWith(".xls")
  ) {
    try {
      const buffer = Buffer.from(file.base64, "base64");
      const workbook = XLSX.read(buffer, { type: "buffer" });
      
      const sheets: string[] = [];
      for (const sheetName of workbook.SheetNames.slice(0, 5)) { // Limit to 5 sheets
        const sheet = workbook.Sheets[sheetName];
        const csv = XLSX.utils.sheet_to_csv(sheet, { blankrows: false });
        // Limit each sheet to ~2000 chars
        const truncated = csv.length > 2000 ? csv.slice(0, 2000) + "\n...(truncated)" : csv;
        sheets.push(`### Sheet: ${sheetName}\n${truncated}`);
      }
      
      return {
        parsed: true,
        content: `[Excel File: ${filename}]\n${sheets.join("\n\n")}`,
      };
    } catch (e) {
      return {
        parsed: false,
        content: `[Excel File: ${filename}]`,
        error: e instanceof Error ? e.message : "Failed to parse Excel file",
      };
    }
  }
  
  // PDF files
  if (mime === "application/pdf" || filename.endsWith(".pdf")) {
    try {
      const buffer = Buffer.from(file.base64, "base64");
      // unpdf requires Uint8Array, not Buffer
      const uint8Array = new Uint8Array(buffer);
      console.log("[pdf-parse] Attempting to parse PDF, size:", uint8Array.length);
      const result = await extractPdfText(uint8Array, { mergePages: true });
      const text = result.text || "";
      console.log("[pdf-parse] Extracted text length:", text.length, "preview:", text.slice(0, 200));
      if (!text.trim()) {
        // PDF might be image-based (scanned) - return a helpful message
        return {
          parsed: false,
          content: `[PDF File: ${filename}]\n(Unable to extract text - this may be a scanned/image-based PDF. The PDF has ${buffer.length} bytes but no extractable text.)`,
        };
      }
      const truncated = text.length > 6000 ? text.slice(0, 6000) + "\n...(truncated)" : text;
      return {
        parsed: true,
        content: `[PDF File: ${filename}]\n${truncated}`,
      };
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      console.error("[pdf-parse] Error parsing PDF:", errMsg);
      return {
        parsed: false,
        content: `[PDF File: ${filename}]\n(Error parsing PDF: ${errMsg.slice(0, 100)})`,
        error: errMsg,
      };
    }
  }
  
  // Word documents (.docx)
  if (
    mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    mime === "application/msword" ||
    filename.endsWith(".docx") ||
    filename.endsWith(".doc")
  ) {
    try {
      const buffer = Buffer.from(file.base64, "base64");
      const result = await mammoth.extractRawText({ buffer });
      const text = result.value || "";
      const truncated = text.length > 6000 ? text.slice(0, 6000) + "\n...(truncated)" : text;
      return {
        parsed: true,
        content: `[Word Document: ${filename}]\n${truncated}`,
      };
    } catch (e) {
      return {
        parsed: false,
        content: `[Word Document: ${filename}]`,
        error: e instanceof Error ? e.message : "Failed to parse Word document",
      };
    }
  }
  
  // PowerPoint files (.pptx) - extract text from slides
  if (
    mime === "application/vnd.openxmlformats-officedocument.presentationml.presentation" ||
    mime === "application/vnd.ms-powerpoint" ||
    filename.endsWith(".pptx") ||
    filename.endsWith(".ppt")
  ) {
    try {
      // PPTX files are ZIP archives - we can use XLSX to read the XML
      const buffer = Buffer.from(file.base64, "base64");
      const JSZip = (await import("jszip")).default;
      const zip = await JSZip.loadAsync(buffer);
      
      const slideTexts: string[] = [];
      const slideFiles = Object.keys(zip.files)
        .filter(name => name.match(/ppt\/slides\/slide\d+\.xml$/))
        .sort();
      
      for (const slideName of slideFiles.slice(0, 20)) { // Limit to 20 slides
        const slideXml = await zip.files[slideName].async("string");
        // Extract text between <a:t> tags (PowerPoint text elements)
        const textMatches = slideXml.match(/<a:t>([^<]*)<\/a:t>/g) || [];
        const texts = textMatches
          .map(m => m.replace(/<\/?a:t>/g, ""))
          .filter(t => t.trim());
        if (texts.length > 0) {
          const slideNum = slideName.match(/slide(\d+)/)?.[1] || "?";
          slideTexts.push(`Slide ${slideNum}: ${texts.join(" | ")}`);
        }
      }
      
      const content = slideTexts.join("\n");
      const truncated = content.length > 5000 ? content.slice(0, 5000) + "\n...(truncated)" : content;
      return {
        parsed: true,
        content: `[PowerPoint: ${filename}]\n${truncated}`,
      };
    } catch (e) {
      return {
        parsed: false,
        content: `[PowerPoint: ${filename}]`,
        error: e instanceof Error ? e.message : "Failed to parse PowerPoint file",
      };
    }
  }
  
  // CSV files
  if (mime === "text/csv" || filename.endsWith(".csv")) {
    try {
      const text = Buffer.from(file.base64, "base64").toString("utf-8");
      const truncated = text.length > 3000 ? text.slice(0, 3000) + "\n...(truncated)" : text;
      return {
        parsed: true,
        content: `[CSV File: ${filename}]\n${truncated}`,
      };
    } catch {
      return { parsed: false, content: `[CSV File: ${filename}]` };
    }
  }
  
  // Plain text files
  if (mime.startsWith("text/") || filename.endsWith(".txt") || filename.endsWith(".md")) {
    try {
      const text = Buffer.from(file.base64, "base64").toString("utf-8");
      const truncated = text.length > 4000 ? text.slice(0, 4000) + "\n...(truncated)" : text;
      return {
        parsed: true,
        content: `[Text File: ${filename}]\n${truncated}`,
      };
    } catch {
      return { parsed: false, content: `[Text File: ${filename}]` };
    }
  }
  
  // Images - don't parse, pass through to model
  if (mime.startsWith("image/")) {
    return { parsed: false, content: "" };
  }
  
  // Other files - just note they're attached
  return {
    parsed: false,
    content: `[Attached File: ${filename} (${mime})]`,
  };
}

async function getOrCreateSessionId(opts: {
  supabase: ReturnType<typeof createSupabaseAdminClient>;
  userId: string;
  provider: string;
  threadKey: string;
  threadName?: string | null;
  forceNew?: boolean;
}): Promise<string> {
  const { supabase, userId, provider, threadKey, threadName, forceNew } = opts;

  if (!forceNew) {
    let rows: Array<{ orchestrator_session_id?: unknown; orchestrator_agent_id?: unknown }> | null = null;
    const { data: selected, error: selectErr } = await supabase
      .from("orchestrator_external_threads")
      .select("orchestrator_session_id,orchestrator_agent_id")
      .eq("user_id", userId)
      .eq("provider", provider)
      .eq("thread_key", threadKey)
      .limit(1);
    rows = (selected as typeof rows) || null;
    if (selectErr && /orchestrator_agent_id/i.test(selectErr.message || "")) {
      const { data: legacyRows } = await supabase
        .from("orchestrator_external_threads")
        .select("orchestrator_session_id")
        .eq("user_id", userId)
        .eq("provider", provider)
        .eq("thread_key", threadKey)
        .limit(1);
      rows = (legacyRows as typeof rows) || null;
    }

    const existing = Array.isArray(rows) ? rows[0] : null;
    const aid = (existing as { orchestrator_agent_id?: unknown } | null)?.orchestrator_agent_id;
    if (typeof aid === "string" && aid) {
      const fromAgent = await getOrCreateRuntimeSessionForAgent({
        supabase,
        userId,
        agentId: aid,
        title: threadName ? `WhatsApp: ${threadName}` : "WhatsApp Chat",
      });
      if (typeof fromAgent === "string" && fromAgent) return fromAgent;
    }
    const sid = (existing as { orchestrator_session_id?: unknown } | null)?.orchestrator_session_id;
    if (typeof sid === "string" && sid) return sid;
  }

  // Create a new session + upsert mapping
  const title = threadName ? `WhatsApp: ${threadName}` : "WhatsApp Chat";
  const { data: sessionRow, error: sessionErr } = await supabase
    .from("orchestrator_sessions")
    .insert({ user_id: userId, title })
    .select("id")
    .single();
  if (sessionErr || !sessionRow?.id) {
    throw new Error(sessionErr?.message || "Failed to create session");
  }

  const sessionId = sessionRow.id as string;
  const nowIso = new Date().toISOString();

  await supabase
    .from("orchestrator_external_threads")
    .upsert(
      {
        user_id: userId,
        provider,
        thread_key: threadKey,
        thread_name: threadName || null,
        orchestrator_session_id: sessionId,
        updated_at: nowIso,
      },
      { onConflict: "user_id,provider,thread_key" }
    );

  return sessionId;
}

async function getOrCreateWorkspaceIdForDevice(opts: {
  supabase: ReturnType<typeof createSupabaseAdminClient>;
  userId: string;
  deviceId: string;
  rootPath: string;
  label?: string | null;
}): Promise<string> {
  const { supabase, userId, deviceId, rootPath, label } = opts;
  const { data: existing } = await supabase
    .from("device_workspaces")
    .select("id")
    .eq("user_id", userId)
    .eq("device_id", deviceId)
    .eq("root_path", rootPath)
    .maybeSingle();
  if (existing?.id) return existing.id as string;

  const { data: row, error } = await supabase
    .from("device_workspaces")
    .insert({
      user_id: userId,
      device_id: deviceId,
      label: label || "Workspace",
      root_path: rootPath,
      policy: {},
    })
    .select("id")
    .single();
  if (error || !row?.id) throw new Error(error?.message || "Failed to create workspace");
  return row.id as string;
}

async function getOrCreateClaudeCodeAgentForThread(opts: {
  supabase: ReturnType<typeof createSupabaseAdminClient>;
  userId: string;
  deviceId: string;
  provider: string;
  threadKey: string;
  threadName?: string | null;
  workspaceRootPath: string;
  terminalId?: string | null;
  forceNew?: boolean;
}): Promise<{ agentId: string; workspaceId: string }> {
  const {
    supabase,
    userId,
    deviceId,
    provider,
    threadKey,
    threadName,
    workspaceRootPath,
    terminalId,
    forceNew,
  } = opts;

  if (!forceNew) {
    const { data: mapRow } = await supabase
      .from("claude_code_external_threads")
      .select("claude_code_agent_id")
      .eq("user_id", userId)
      .eq("provider", provider)
      .eq("thread_key", threadKey)
      .limit(1);
    const existing = Array.isArray(mapRow) ? mapRow[0] : null;
    const agentId = (existing as { claude_code_agent_id?: unknown } | null)?.claude_code_agent_id;
    if (typeof agentId === "string" && agentId) {
      // Ensure config + workspace exists; if config missing, recreate it.
      const { data: cfg } = await supabase
        .from("claude_code_agent_configs")
        .select("workspace_id")
        .eq("agent_id", agentId)
        .maybeSingle();
      const workspaceId =
        (cfg as { workspace_id?: unknown } | null)?.workspace_id && typeof (cfg as { workspace_id?: unknown }).workspace_id === "string"
          ? ((cfg as { workspace_id: string }).workspace_id as string)
          : null;
      if (workspaceId) return { agentId, workspaceId };
      // fall through: config missing/partial
    }
  }

  const workspaceId = await getOrCreateWorkspaceIdForDevice({
    supabase,
    userId,
    deviceId,
    rootPath: workspaceRootPath,
    label: threadName ? `WhatsApp: ${threadName}` : "WhatsApp",
  });

  const nowIso = new Date().toISOString();
  const suffix = new Date().toLocaleString();
  const name = threadName ? `WhatsApp Code: ${threadName} (${suffix})` : `WhatsApp Code (${suffix})`;

  const { data: agentRow, error: agentErr } = await supabase
    .from("agents")
    .insert({
      user_id: userId,
      type: "claude-code",
      name,
      flag_key: null,
      provider: null,
      model: null,
    })
    .select("id")
    .single();
  if (agentErr || !agentRow?.id) throw new Error(agentErr?.message || "Failed to create Claude Code agent");

  const agentId = agentRow.id as string;

  const { error: cfgErr } = await supabase.from("claude_code_agent_configs").insert({
    agent_id: agentId,
    user_id: userId,
    device_id: deviceId,
    workspace_id: workspaceId,
    // optional; used only for PTY-based sessions. WhatsApp code mode may still provide it.
    terminal_id: terminalId || null,
  });
  if (cfgErr) {
    await supabase.from("agents").delete().eq("id", agentId);
    throw new Error(cfgErr.message || "Failed to create Claude Code config");
  }

  await supabase
    .from("claude_code_external_threads")
    .upsert(
      {
        user_id: userId,
        provider,
        thread_key: threadKey,
        thread_name: threadName || null,
        claude_code_agent_id: agentId,
        updated_at: nowIso,
      },
      { onConflict: "user_id,provider,thread_key" }
    );

  return { agentId, workspaceId };
}

async function getOrCreateClaudeCliThreadSessionId(opts: {
  supabase: ReturnType<typeof createSupabaseAdminClient>;
  userId: string;
  agentId: string;
}): Promise<string | null> {
  const { supabase, userId, agentId } = opts;
  const { data: thread } = await supabase
    .from("claude_code_cli_threads")
    .select("claude_session_id")
    .eq("user_id", userId)
    .eq("claude_code_agent_id", agentId)
    .maybeSingle();
  const sid = (thread as { claude_session_id?: unknown } | null)?.claude_session_id;
  return typeof sid === "string" && sid.trim() ? sid.trim() : null;
}

async function ensureClaudeCliThreadRow(opts: {
  supabase: ReturnType<typeof createSupabaseAdminClient>;
  userId: string;
  agentId: string;
  sessionId?: string | null;
}) {
  const { supabase, userId, agentId, sessionId } = opts;
  await supabase
    .from("claude_code_cli_threads")
    .upsert(
      {
        user_id: userId,
        claude_code_agent_id: agentId,
        claude_session_id: sessionId || null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id,claude_code_agent_id" }
    );
}

async function upsertClaudeCliThreadSessionId(opts: {
  supabase: ReturnType<typeof createSupabaseAdminClient>;
  userId: string;
  agentId: string;
  sessionId: string;
}) {
  const { supabase, userId, agentId, sessionId } = opts;
  await supabase
    .from("claude_code_cli_threads")
    .upsert(
      {
        user_id: userId,
        claude_code_agent_id: agentId,
        claude_session_id: sessionId,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id,claude_code_agent_id" }
    );
}

async function insertClaudeCliMessage(opts: {
  supabase: ReturnType<typeof createSupabaseAdminClient>;
  userId: string;
  agentId: string;
  role: "user" | "assistant";
  content: string;
  diffs?: Array<{ filename: string; content: string; additions?: number; deletions?: number }> | null;
  model?: string | null;
  costUsd?: number | null;
  durationMs?: number | null;
}) {
  const { supabase, userId, agentId, role, content, diffs, model, costUsd, durationMs } = opts;
  await supabase.from("claude_code_cli_messages").insert({
    user_id: userId,
    claude_code_agent_id: agentId,
    role,
    content,
    diffs: diffs || null,
    model: typeof model === "string" && model.trim() ? model.trim() : null,
    cost_usd: typeof costUsd === "number" ? costUsd : null,
    duration_ms: typeof durationMs === "number" ? Math.trunc(durationMs) : null,
  });
}

async function loadSessionHistory(opts: {
  supabase: ReturnType<typeof createSupabaseAdminClient>;
  userId: string;
  sessionId: string;
  limit?: number;
}): Promise<ModelMessage[]> {
  const { supabase, userId, sessionId, limit = 80 } = opts;
  const { data: rows } = await supabase
    .from("orchestrator_messages")
    .select("role, content, created_at")
    .eq("user_id", userId)
    .eq("session_id", sessionId)
    // Fetch latest N rows first, then restore chronological order below.
    .order("created_at", { ascending: false })
    .limit(limit);

  const history: ModelMessage[] = [];
  const orderedRows = Array.isArray(rows) ? [...rows].reverse() : [];
  for (const r of orderedRows) {
    const role = (r as { role?: unknown }).role;
    const content = (r as { content?: unknown }).content;
    if (role === "user" || role === "assistant") {
      if (typeof content === "string" && content.trim()) {
        history.push({ role, content });
      }
    }
  }
  return history;
}

async function insertMessage(opts: {
  supabase: ReturnType<typeof createSupabaseAdminClient>;
  userId: string;
  sessionId: string;
  agentId?: string | null;
  epochId?: string | null;
  branchId?: string | null;
  role: "user" | "assistant";
  content: string;
  traceId?: string;
  metadata?: Record<string, unknown>;
}): Promise<string | null> {
  const { supabase, userId, sessionId, agentId, epochId, branchId, role, content, traceId, metadata } = opts;
  const nowIso = new Date().toISOString();
  const inserted = await supabase
    .from("orchestrator_messages")
    .insert({
      user_id: userId,
      session_id: sessionId,
      agent_id: agentId || null,
      epoch_id: epochId || null,
      branch_id: branchId || null,
      role,
      content,
      trace_id: traceId,
      metadata: metadata || {},
    })
    .select("id")
    .maybeSingle();
  await supabase
    .from("orchestrator_sessions")
    .update({ updated_at: nowIso })
    .eq("id", sessionId)
    .eq("user_id", userId);
  const insertedId = (inserted.data as { id?: unknown } | null)?.id;
  return typeof insertedId === "string" && insertedId.trim() ? insertedId.trim() : null;
}

async function findExistingWhatsAppTraceOutcome(opts: {
  supabase: ReturnType<typeof createSupabaseAdminClient>;
  userId: string;
  sessionId: string;
  traceId: string;
}): Promise<
  | {
      kind: "final";
      reply: string;
      files: FileInput[];
    }
  | {
      kind: "in_progress";
      statusMessage: string;
      pollAfterMs: number;
    }
  | null
> {
  const { supabase, userId, sessionId, traceId } = opts;
  const { data: rows } = await supabase
    .from("orchestrator_messages")
    .select("role, content, metadata, created_at")
    .eq("user_id", userId)
    .eq("session_id", sessionId)
    .eq("trace_id", traceId)
    .order("created_at", { ascending: true });

  const records = Array.isArray(rows) ? rows : [];
  const hasUserMessage = records.some((row) => toTrimmed((row as { role?: unknown }).role).toLowerCase() === "user");
  if (!hasUserMessage) return null;

  let assistantRow: { content?: unknown; metadata?: unknown } | null = null;
  for (const row of records) {
    if (toTrimmed((row as { role?: unknown }).role).toLowerCase() === "assistant") {
      assistantRow = row as { content?: unknown; metadata?: unknown };
    }
  }

  if (!assistantRow) {
    return {
      kind: "in_progress",
      statusMessage: "Still working...",
      pollAfterMs: 2000,
    };
  }

  const metadata = asRecord(assistantRow.metadata) || {};
  if (metadata.connector_followup_pending === true) {
    return {
      kind: "in_progress",
      statusMessage: "Still working...",
      pollAfterMs: 2000,
    };
  }
  const files = asFiles(metadata.generated_files);
  const storedReply = toTrimmed(assistantRow.content);
  const reply = files.length > 0 && storedReply === "[generated image]" ? "" : storedReply;

  return {
    kind: "final",
    reply,
    files,
  };
}

async function insertActivity(opts: {
  supabase: ReturnType<typeof createSupabaseAdminClient>;
  userId: string;
  sessionId: string;
  agent: string;
  action: string;
  detail?: string;
  status?: "running" | "complete" | "error";
  traceId?: string;
  metadata?: Record<string, unknown>;
}) {
  const { supabase, userId, sessionId, agent, action, detail, status, traceId, metadata } = opts;
  await supabase.from("activity_log").insert({
    user_id: userId,
    session_id: sessionId,
    agent,
    action,
    detail: detail?.slice(0, 500),
    status: status || "complete",
    trace_id: traceId,
    metadata: metadata || {},
  });
}

async function getOrCreateFilesAgentSession(opts: {
  supabase: ReturnType<typeof createSupabaseAdminClient>;
  userId: string;
  orchestratorSessionId: string;
  title?: string | null;
}): Promise<{ agentId: string; sessionId: string } | null> {
  const { supabase, userId, orchestratorSessionId, title } = opts;

  try {
    const { data: link } = await supabase
      .from("orchestrator_agent_sessions")
      .select("agent_session_id, chat_sessions!inner(agent_id)")
      .eq("user_id", userId)
      .eq("orchestrator_session_id", orchestratorSessionId)
      .eq("agent_type", "files")
      .maybeSingle();
    if (link) {
      const cs = link.chat_sessions as unknown as { agent_id?: string } | null;
      const agentId = cs?.agent_id;
      if (typeof agentId === "string" && typeof link.agent_session_id === "string") {
        return { agentId, sessionId: link.agent_session_id };
      }
    }
  } catch {
    // ignore
  }

  // Auto-create a link if possible (match /api/orchestrator/sessions behavior)
  try {
    const { data: filesAgent } = await supabase
      .from("agents")
      .select("id")
      .eq("user_id", userId)
      .eq("type", "files-agent")
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (!filesAgent?.id) return null;

    const { data: filesSession } = await supabase
      .from("chat_sessions")
      .insert({
        user_id: userId,
        agent_id: filesAgent.id,
        title: title ? `Files: ${title}` : "Files session",
      })
      .select("id")
      .single();
    if (!filesSession?.id) return null;

    await supabase.from("orchestrator_agent_sessions").insert({
      user_id: userId,
      orchestrator_session_id: orchestratorSessionId,
      agent_type: "files",
      agent_id: filesAgent.id,
      agent_session_id: filesSession.id,
    });

    return { agentId: filesAgent.id as string, sessionId: filesSession.id as string };
  } catch {
    return null;
  }
}

export async function POST(req: Request) {
  const deviceToken = req.headers.get("x-device-token") || "";
  const relaySecret = process.env.RELAY_JWT_SECRET || "";
  const verified = verifyRelayDeviceToken(deviceToken, relaySecret);
  if (!verified) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await req.json().catch(() => null)) as Body | null;
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  const provider = requireString(body.provider) || "whatsapp_web";
  const mode: "orch" | "code" = body.mode === "code" ? "code" : "orch";
  // codeTerminalId is no longer required - we use headless code_cli_run now
  const codeTerminalId =
    mode === "code" && body.code && typeof body.code === "object"
      ? requireString((body.code as { terminalId?: unknown }).terminalId)
      : null;
  const codeWorkspaceRootPath =
    mode === "code" && body.code && typeof body.code === "object"
      ? requireString((body.code as { workspaceRootPath?: unknown }).workspaceRootPath)
      : null;
  // workspaceRootPath is required for code mode so code_cli_run knows which folder to work in
  if (mode === "code" && !codeWorkspaceRootPath) {
    return NextResponse.json({ error: "code.workspaceRootPath required for mode=code" }, { status: 400 });
  }
  const threadKey = requireString(body.threadKey);
  if (!threadKey) {
    return NextResponse.json({ error: "threadKey required" }, { status: 400 });
  }
  const userScopedThreadKey = `${verified.userId}:${threadKey}`;

  const threadName = requireString(body.threadName);
  const userMessageToPersist = typeof body.message === "string" ? body.message.trim() : "";
  let messageForModel = userMessageToPersist;
  let inboxCommandReplyPrefix = "";
  const hasUserMessage = userMessageToPersist.length > 0;
  const command = body.command;
  const toolResults = asToolResults(body.toolResults);
  const allFiles = asFiles(body.files);
  const memoryEnabled = body.memoryEnabled !== false;
  const obsidianVaultPath = requireString(body.obsidianVaultPath);
  const connectorPlatform = normalizeConnectorPlatform(body.connectorPlatform);
  const incomingTraceId = requireString(body.traceId);

  // Parse document files and enhance message with their content
  // Images pass through to the model directly; documents are parsed to text
  const imageFiles: FileInput[] = [];
  const documentContents: string[] = [];
  
  for (const file of allFiles) {
    if (file.mediaType.startsWith("image/")) {
      // Images go directly to the model
      imageFiles.push(file);
    } else {
      // Parse documents and add content to message
      const parsed = await parseDocumentContent(file);
      if (parsed.content) {
        documentContents.push(parsed.content);
      }
    }
  }
  
  // If we have document content, prepend it to the user's message
  if (documentContents.length > 0) {
    const docSection = documentContents.join("\n\n");
    messageForModel = `${docSection}\n\n---\nUser's question: ${userMessageToPersist}`;
  }
  
  // Only pass image files to the orchestrator (documents are now in the message text)
  const files = imageFiles;

  const supabase = createSupabaseAdminClient();

  let userEmail: string | null = null;
  try {
    const { data: user } = await supabase.auth.admin.getUserById(verified.userId);
    userEmail = user.user?.email || null;
  } catch {
    userEmail = null;
  }

  // Handle command: new session
  const forceNew = command === "new" || userMessageToPersist.toLowerCase() === "new";
  // Code mode sessions live under the Code Agent (claude_code_* tables), not orchestrator_sessions.
  // This prevents cross-contamination between @groovy (chat/orchestrator) and @code histories.
  if (mode === "code") {
    const traceId = incomingTraceId || `code-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const codeAgent = await getOrCreateClaudeCodeAgentForThread({
      supabase,
      userId: verified.userId,
      deviceId: verified.deviceId,
      provider,
      threadKey: userScopedThreadKey,
      threadName,
      workspaceRootPath: codeWorkspaceRootPath!,
      terminalId: codeTerminalId,
      forceNew,
    });

    if (forceNew) {
      return NextResponse.json({
        ok: true,
        kind: "new_session",
        agentId: codeAgent.agentId,
        traceId,
        message: "Started a new Code session for this WhatsApp thread.",
      });
    }

    // If this is a toolResults continuation, persist the assistant result and finish.
    if (!hasUserMessage && toolResults.length > 0) {
      const tr = toolResults.find((x) => x.toolName === "code_cli_run") || toolResults[0]!;
      let parsedOuter: unknown = null;
      try {
        parsedOuter = JSON.parse(tr.result);
      } catch {
        parsedOuter = null;
      }

      const outer = parsedOuter as { ok?: unknown; result?: unknown; error?: unknown } | null;
      const ok = !!(outer && typeof outer === "object" && outer.ok === true);
      const inner = outer && typeof outer === "object" ? asRecord(outer.result) : null; // connector payload
      const innerResult = inner ? asRecord(inner.result) : null;

      const assistantTextRaw =
        innerResult && typeof innerResult.result === "string"
          ? innerResult.result
          : inner && typeof inner.result === "string"
            ? String(inner.result)
            : ok
              ? "(no reply)"
              : String((outer as { error?: unknown } | null)?.error || (inner as { error?: unknown } | null)?.error || "claude_run_failed");

      const MAX_WHATSAPP_REPLY_CHARS = 3500;
      const safeReply =
        assistantTextRaw.length > MAX_WHATSAPP_REPLY_CHARS
          ? `${assistantTextRaw.slice(0, MAX_WHATSAPP_REPLY_CHARS)}\n...(truncated)`
          : assistantTextRaw;

      const diffsRaw = inner ? inner.diffs : null;
      const diffs: Array<{ filename: string; content: string; additions?: number; deletions?: number }> | null =
        Array.isArray(diffsRaw)
          ? diffsRaw
              .map((d) => {
                const r = asRecord(d);
                const filename =
                  r && typeof r.file === "string"
                    ? r.file
                    : r && typeof r.filename === "string"
                      ? r.filename
                      : "";
                const content =
                  r && typeof r.diff === "string"
                    ? r.diff
                    : r && typeof r.content === "string"
                      ? r.content
                      : "";
                const additions = r && Number.isFinite(Number(r.additions)) ? Number(r.additions) : undefined;
                const deletions = r && Number.isFinite(Number(r.deletions)) ? Number(r.deletions) : undefined;
                if (!filename || !content) return null;
                const out: { filename: string; content: string; additions?: number; deletions?: number } = {
                  filename,
                  content,
                };
                if (typeof additions === "number") out.additions = additions;
                if (typeof deletions === "number") out.deletions = deletions;
                return out;
              })
              .filter((d): d is { filename: string; content: string; additions?: number; deletions?: number } => d != null)
          : null;

      const durationMs =
        inner && Number.isFinite(Number(inner.duration_ms))
          ? Number(inner.duration_ms)
          : null;
      const costUsd =
        innerResult && Number.isFinite(Number(innerResult.total_cost_usd))
          ? Number(innerResult.total_cost_usd)
          : null;
      const nextSessionId =
        inner && typeof inner.session_id === "string" && inner.session_id.trim()
          ? inner.session_id.trim()
          : innerResult && typeof innerResult.session_id === "string" && innerResult.session_id.trim()
            ? innerResult.session_id.trim()
            : null;
      const model =
        inner && typeof inner.model === "string" && inner.model.trim()
          ? inner.model.trim()
          : innerResult && typeof innerResult.model === "string" && innerResult.model.trim()
            ? innerResult.model.trim()
            : null;

      await insertClaudeCliMessage({
        supabase,
        userId: verified.userId,
        agentId: codeAgent.agentId,
        role: "assistant",
        content: safeReply.trim() ? safeReply.trim() : "(no reply)",
        diffs: diffs && diffs.length > 0 ? diffs : null,
        model,
        costUsd,
        durationMs,
      });

      if (nextSessionId) {
        await upsertClaudeCliThreadSessionId({
          supabase,
          userId: verified.userId,
          agentId: codeAgent.agentId,
          sessionId: nextSessionId,
        });
      }

      return NextResponse.json({
        ok: true,
        kind: "final",
        agentId: codeAgent.agentId,
        traceId,
        reply: safeReply.trim() ? safeReply.trim() : "(no reply)",
      });
    }

    // First round: persist user message to Code Agent, then ask connector to run Claude CLI.
    if (!hasUserMessage) {
      return NextResponse.json({ error: "message required" }, { status: 400 });
    }

    await insertClaudeCliMessage({
      supabase,
      userId: verified.userId,
      agentId: codeAgent.agentId,
      role: "user",
      content: userMessageToPersist,
    });

    const cliSessionId = await getOrCreateClaudeCliThreadSessionId({
      supabase,
      userId: verified.userId,
      agentId: codeAgent.agentId,
    });

    // Ensure the thread row exists even before we have a claude_session_id.
    await ensureClaudeCliThreadRow({
      supabase,
      userId: verified.userId,
      agentId: codeAgent.agentId,
      sessionId: cliSessionId,
    });

    // Resolve per-provider keys: prefer CLI token (OAuth) over API key
    const resolved = await resolveKeys(verified.userId, supabase, "");
    const useCliToken = !!resolved.claudeCliToken;
    const anthropicMode = resolved.keyModes.anthropic || resolved.globalMode;
    const apiKey = useCliToken
      ? null
      : anthropicMode === "user"
        ? (resolved.userKeys.anthropic || null)
        : (process.env.ANTHROPIC_API_KEY || null);

    console.log("[whatsapp/code] auth resolved", {
      method: useCliToken ? "cli_token" : "api_key",
      source: useCliToken ? "user" : (anthropicMode === "user" ? "user" : "groovy"),
      hasCliToken: !!resolved.claudeCliToken,
      hasApiKey: !!apiKey,
    });

    if (!apiKey && !resolved.claudeCliToken) {
      return NextResponse.json({
        ok: true,
        kind: "final",
        agentId: codeAgent.agentId,
        traceId,
        reply:
          "No API key or CLI token configured. Add your Anthropic key or Claude CLI token in Settings.",
      });
    }

    return NextResponse.json({
      ok: true,
      kind: "needs_connector",
      agentId: codeAgent.agentId,
      traceId,
      partialText: "",
      statusMessage: "Running Claude Code…",
      connectorExecutes: [
        {
          toolCallId: `claude-run-${Date.now()}`,
          toolName: "code_cli_run",
          agent: "code",
          connectorType: "claude_run",
          connectorParams: {
            prompt: userMessageToPersist,
            cwd: codeWorkspaceRootPath,
            // Send either cli_token or api_key (not both)
            ...(useCliToken
              ? { cli_token: resolved.claudeCliToken }
              : { api_key: apiKey }),
            allowed_tools: "Read,Edit,Bash,Write",
            timeout_ms: 5 * 60 * 1000,
            ...(cliSessionId ? { session_id: cliSessionId } : {}),
          },
          message: "Running Claude Code…",
        },
      ],
    });
  }

  const sessionId = await getOrCreateSessionId({
    supabase,
    userId: verified.userId,
    provider,
    threadKey: userScopedThreadKey,
    threadName,
    forceNew,
  });
  const runtimeScope = await resolveRuntimeScope({
    supabase,
    userId: verified.userId,
    sessionId,
    agentId: null,
  });
  const runtimeAgentId = runtimeScope?.agentId || null;
  if (runtimeAgentId) {
    try {
      await supabase.from("orchestrator_external_threads").upsert(
        {
          user_id: verified.userId,
          provider,
          thread_key: userScopedThreadKey,
          thread_name: threadName || null,
          orchestrator_session_id: sessionId,
          orchestrator_agent_id: runtimeAgentId,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "user_id,provider,thread_key" }
      );
    } catch {
      // Best-effort backfill for thread -> agent mapping.
    }
  }

  if (forceNew) {
    return NextResponse.json({
      ok: true,
      kind: "new_session",
      sessionId,
      message: "Started a new session for this WhatsApp thread.",
    });
  }

  const twilioFollowupRaw = asRecord(body.twilioFollowup);
  if (!hasUserMessage && toolResults.length === 0 && twilioFollowupRaw) {
    const sinceCursor = requireString(twilioFollowupRaw.sinceCursor);
    const followupSessionId = requireString(twilioFollowupRaw.sessionId) || sessionId;
    const latestTwilio = await loadLatestTwilioSupervisorStateForSession({
      supabase,
      userId: verified.userId,
      sessionId: followupSessionId,
    });
    const state = latestTwilio?.state || null;
    const cursor = getTwilioSupervisorCursor(state);
    const terminal = isTerminalTwilioSupervisorState(state);
    const childKind = requireString(state?.childKind);
    const pollAfterMs = childKind === "sms" ? 15_000 : 7_000;
    const hasNewCursor = !!cursor && cursor !== sinceCursor;
    const message = hasNewCursor ? buildWhatsAppTwilioFollowupMessage(state) : null;

    return NextResponse.json({
      ok: true,
      kind: "twilio_followup",
      sessionId: followupSessionId,
      twilioFollowup: {
        sessionId: followupSessionId,
        cursor,
        terminal,
        childKind,
        status: requireString(state?.status),
        ...(message ? { message } : {}),
        ...(terminal ? {} : { pollAfterMs }),
      },
    });
  }

  const commandFollowupRaw = asRecord(body.commandFollowup);
  if (!hasUserMessage && toolResults.length > 0 && commandFollowupRaw) {
    const pendingMessageId = requireString(commandFollowupRaw.pendingMessageId);
    const followupReply = requireString(commandFollowupRaw.finalReply);
    const followupTraceId = requireString(body.traceId) || undefined;
    if (!pendingMessageId) {
      return NextResponse.json({ error: "commandFollowup.pendingMessageId required" }, { status: 400 });
    }

    const { data: pendingRow } = await supabase
      .from("orchestrator_messages")
      .select("id,metadata")
      .eq("id", pendingMessageId)
      .eq("user_id", verified.userId)
      .eq("session_id", sessionId)
      .maybeSingle();

    if (pendingRow) {
      const existingMeta = asRecord((pendingRow as { metadata?: unknown }).metadata) || {};
      const summarized = summarizeConnectorToolResults(toolResults);
      const hasFailures = summarized.some((r) => r.ok !== true);
      const mergedMeta: Record<string, unknown> = {
        ...existingMeta,
        connector_followup_pending: false,
        connector_followup_completed_at: new Date().toISOString(),
        connector_followup_results: summarized,
        connector_followup_status: hasFailures ? "partial_failure" : "complete",
      };
      if (followupTraceId) mergedMeta.connector_followup_trace_id = followupTraceId;
      if (followupReply) mergedMeta.connector_followup_final_reply = followupReply;

      await supabase
        .from("orchestrator_messages")
        .update({ metadata: mergedMeta })
        .eq("id", pendingMessageId)
        .eq("user_id", verified.userId)
        .eq("session_id", sessionId);
      await supabase
        .from("orchestrator_sessions")
        .update({ updated_at: new Date().toISOString() })
        .eq("id", sessionId)
        .eq("user_id", verified.userId);
    }

    return NextResponse.json({
      ok: true,
      kind: "connector_followup_persisted",
      sessionId,
      traceId: followupTraceId,
    });
  }

  if (hasUserMessage && toolResults.length === 0 && incomingTraceId) {
    const existingTraceOutcome = await findExistingWhatsAppTraceOutcome({
      supabase,
      userId: verified.userId,
      sessionId,
      traceId: incomingTraceId,
    });

    if (existingTraceOutcome?.kind === "final") {
      return NextResponse.json({
        ok: true,
        kind: "final",
        sessionId,
        traceId: incomingTraceId,
        reply: existingTraceOutcome.reply,
        ...(existingTraceOutcome.files.length > 0 ? { files: existingTraceOutcome.files } : {}),
      });
    }

    if (existingTraceOutcome?.kind === "in_progress") {
      return NextResponse.json(
        {
          ok: true,
          kind: "in_progress",
          sessionId,
          traceId: incomingTraceId,
          statusMessage: existingTraceOutcome.statusMessage,
          pollAfterMs: existingTraceOutcome.pollAfterMs,
        },
        { status: 202 }
      );
    }
  }

  // Persist user message only on the first round (not for toolResults continuation)
  if (hasUserMessage) {
    const userMessageId = await insertMessage({
      supabase,
      userId: verified.userId,
      sessionId,
      agentId: runtimeScope?.agentId || null,
      epochId: runtimeScope?.epochId || null,
      branchId: runtimeScope?.branchId || null,
      role: "user",
      // Persist the user's original message (not the parsed document text),
      // so the dashboard UI doesn't show huge raw blobs.
      content: userMessageToPersist,
      traceId: incomingTraceId || undefined,
      metadata: {
        provider,
        mode,
        threadKey: userScopedThreadKey,
        threadName,
        deviceId: verified.deviceId,
        attachments: allFiles.map((f) => ({
          filename: f.filename || null,
          mediaType: f.mediaType,
          sizeB64: f.base64 ? f.base64.length : 0,
        })),
      },
    });
    if (incomingTraceId && !userMessageId) {
      const existingTraceOutcome = await findExistingWhatsAppTraceOutcome({
        supabase,
        userId: verified.userId,
        sessionId,
        traceId: incomingTraceId,
      });

      if (existingTraceOutcome?.kind === "final") {
        return NextResponse.json({
          ok: true,
          kind: "final",
          sessionId,
          traceId: incomingTraceId,
          reply: existingTraceOutcome.reply,
          ...(existingTraceOutcome.files.length > 0 ? { files: existingTraceOutcome.files } : {}),
        });
      }

      if (existingTraceOutcome?.kind === "in_progress") {
        return NextResponse.json(
          {
            ok: true,
            kind: "in_progress",
            sessionId,
            traceId: incomingTraceId,
            statusMessage: existingTraceOutcome.statusMessage,
            pollAfterMs: existingTraceOutcome.pollAfterMs,
          },
          { status: 202 }
        );
      }

      return NextResponse.json({ error: "Failed to persist WhatsApp message" }, { status: 500 });
    }
    if (runtimeScope?.branchId) {
      await incrementBranchTurnCount({
        supabase,
        userId: verified.userId,
        branchId: runtimeScope.branchId,
      }).catch(() => undefined);
    }
    // Log to activity feed
    await insertActivity({
      supabase,
      userId: verified.userId,
      sessionId,
      agent: "system",
      action: "WhatsApp message",
      detail: userMessageToPersist.slice(0, 100),
      status: "complete",
      traceId: incomingTraceId || undefined,
      metadata: { provider, mode, threadKey: userScopedThreadKey, threadName, source: "whatsapp" },
    });

    if (runtimeAgentId) {
      try {
        const sweep = await applyPendingInboxActionSilencePolicy({
          supabase,
          userId: verified.userId,
          agentId: runtimeAgentId,
          messageText: userMessageToPersist,
        });
        if (sweep.cancelledCount > 0) {
          console.log("[whatsapp][inbox-actions] auto-cancelled pending actions after inactivity", {
            userId: verified.userId,
            agentId: runtimeAgentId,
            cancelledCount: sweep.cancelledCount,
            threshold: sweep.threshold,
          });
        }
      } catch (sweepErr) {
        console.warn("[whatsapp][inbox-actions] silence policy sweep failed:", sweepErr);
      }
    }
  } else if (toolResults.length === 0) {
    return NextResponse.json({ error: "message required" }, { status: 400 });
  }

  // Conversational inbox actions:
  // command intent is parsed into strict JSON and then executed.
  if (hasUserMessage && toolResults.length === 0 && runtimeAgentId) {
    const commandResult = await executeInboxCommand({
      supabase,
      userId: verified.userId,
      agentId: runtimeAgentId,
      text: userMessageToPersist,
    });
    if (commandResult.handled) {
      const traceId = incomingTraceId || undefined;
      const followupText = requireString(commandResult.followupText) || "";
      const connectorExecutes = Array.isArray(commandResult.connectorExecutes)
        ? commandResult.connectorExecutes
        : [];
      if (connectorExecutes.length > 0) {
        const pendingMessageId = await insertMessage({
          supabase,
          userId: verified.userId,
          sessionId,
          agentId: runtimeScope?.agentId || null,
          epochId: runtimeScope?.epochId || null,
          branchId: runtimeScope?.branchId || null,
          role: "assistant",
          content: commandResult.reply,
          traceId,
          metadata: {
            provider,
            mode,
            threadKey: userScopedThreadKey,
            threadName,
            deviceId: verified.deviceId,
            source: "whatsapp",
            kind: "inbox_action_command",
            connector_followup_pending: true,
          },
        });

        return NextResponse.json({
          ok: true,
          kind: "needs_connector",
          sessionId,
          traceId,
          partialText: commandResult.reply,
          connectorExecutes,
          statusMessage: commandResult.statusMessage || "Completing unsubscribe locally...",
          completeAfterConnector: true,
          finalReply: commandResult.reply,
          pendingMessageId: pendingMessageId || undefined,
          ...(followupText ? { followupText } : {}),
        });
      }

      if (!followupText) {
        await insertMessage({
          supabase,
          userId: verified.userId,
          sessionId,
          agentId: runtimeScope?.agentId || null,
          epochId: runtimeScope?.epochId || null,
          branchId: runtimeScope?.branchId || null,
          role: "assistant",
          content: commandResult.reply,
          traceId,
          metadata: {
            provider,
            mode,
            threadKey: userScopedThreadKey,
            threadName,
            deviceId: verified.deviceId,
            source: "whatsapp",
            kind: "inbox_action_command",
          },
        });

        return NextResponse.json({
          ok: true,
          kind: "final",
          sessionId,
          traceId,
          reply: commandResult.reply,
        });
      }

      inboxCommandReplyPrefix = commandResult.reply;
      messageForModel = followupText;
    }
  }

  // Fast-path: connector send completed (avoid another model round-trip)
  // This is used for confirm→send flows where the API returned needs_connector with whatsapp_send_* tools.
  if (!hasUserMessage) {
    const sendToolResults = toolResults.filter(
      (tr) => tr.toolName === "whatsapp_send_text" || tr.toolName === "whatsapp_send_media"
    );
    if (sendToolResults.length > 0) {
      const parsedResults = sendToolResults.map((tr) => {
        let parsed: unknown = null;
        try {
          parsed = JSON.parse(tr.result);
        } catch {
          parsed = null;
        }
        const parsedObj =
          parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
        const innerRaw = parsedObj.result;
        const inner =
          innerRaw && typeof innerRaw === "object" ? (innerRaw as Record<string, unknown>) : parsedObj;
        const ok = parsedObj.ok === true;
        const pendingMessageId =
          typeof inner.pending_message_id === "string" ? inner.pending_message_id.trim() : "";
        const recipientDisplay =
          typeof inner.recipient_display === "string" ? inner.recipient_display.trim() : "";
        const error =
          (typeof inner.error === "string" && inner.error.trim()) ||
          (typeof parsedObj.error === "string" && parsedObj.error.trim()) ||
          "";
        return {
          toolName: tr.toolName,
          ok,
          parsed,
          pendingMessageId,
          recipientDisplay,
          error,
        };
      });

      const firstPendingMessageId =
        parsedResults.find((r) => r.pendingMessageId)?.pendingMessageId || "";
      const fallbackPending =
        firstPendingMessageId
          ? null
          : await findLatestActivePendingWhatsAppSend({
              supabase,
              userId: verified.userId,
              sessionId,
            });
      const pendingMessageIdToConsume =
        firstPendingMessageId || fallbackPending?.pendingMessageId || "";
      const recipientDisplay =
        parsedResults.find((r) => r.recipientDisplay)?.recipientDisplay || "";
      const total = parsedResults.length;
      const okCount = parsedResults.filter((r) => r.ok).length;
      const mediaCount = parsedResults.filter((r) => r.toolName === "whatsapp_send_media").length;
      const failed = parsedResults.filter((r) => !r.ok);

      let reply = "";
      if (failed.length === 0) {
        reply = `✅ Sent${recipientDisplay ? ` to ${recipientDisplay}` : ""}.`;
        if (mediaCount > 0) {
          reply += ` (${mediaCount} attachment${mediaCount === 1 ? "" : "s"})`;
        }
      } else if (okCount > 0) {
        const errPreview = failed
          .slice(0, 2)
          .map((f) => f.error || "send_failed")
          .join("; ");
        reply =
          `⚠️ Partially sent${recipientDisplay ? ` to ${recipientDisplay}` : ""} ` +
          `(${okCount}/${total} actions succeeded).` +
          (errPreview ? ` Errors: ${errPreview}` : "");
      } else {
        const errPreview = failed
          .slice(0, 2)
          .map((f) => f.error || "send_failed")
          .join("; ");
        reply =
          `❌ Failed to send${recipientDisplay ? ` to ${recipientDisplay}` : ""}.` +
          (errPreview ? ` Errors: ${errPreview}` : "");
      }

      await insertMessage({
        supabase,
        userId: verified.userId,
        sessionId,
        agentId: runtimeScope?.agentId || null,
        epochId: runtimeScope?.epochId || null,
        branchId: runtimeScope?.branchId || null,
        role: "assistant",
        content: reply,
        traceId: requireString(body.traceId) || undefined,
        metadata: {
          provider,
          mode,
          threadKey: userScopedThreadKey,
          threadName,
          deviceId: verified.deviceId,
          whatsapp_send_consumed_of: pendingMessageIdToConsume || undefined,
          whatsapp_send_result:
            parsedResults.length === 1
              ? parsedResults[0]?.parsed || undefined
              : parsedResults.map((r) => ({
                  toolName: r.toolName,
                  ok: r.ok,
                  error: r.error || undefined,
                  raw: r.parsed,
                })),
        },
      });

      return NextResponse.json({
        ok: true,
        kind: "final",
        sessionId,
        traceId: requireString(body.traceId) || undefined,
        reply,
      });
    }
  }

  // WhatsApp confirm flow (YES/NO in current thread)
  if (hasUserMessage && toolResults.length === 0) {
    const decision = parseYesNo(userMessageToPersist);
    if (decision) {
      const pending = await findLatestActivePendingWhatsAppSend({
        supabase,
        userId: verified.userId,
        sessionId,
      });
      if (pending) {
        if (decision === "no") {
          const reply = "Cancelled.";
          await insertMessage({
            supabase,
            userId: verified.userId,
            sessionId,
            agentId: runtimeScope?.agentId || null,
            epochId: runtimeScope?.epochId || null,
            branchId: runtimeScope?.branchId || null,
            role: "assistant",
            content: reply,
            traceId: requireString(body.traceId) || undefined,
            metadata: {
              provider,
              mode,
              threadKey: userScopedThreadKey,
              threadName,
              deviceId: verified.deviceId,
              whatsapp_send_consumed_of: pending.pendingMessageId,
              whatsapp_send_cancelled: true,
            },
          });
          return NextResponse.json({
            ok: true,
            kind: "final",
            sessionId,
            traceId: requireString(body.traceId) || undefined,
            reply,
          });
        }

        // YES → send via connector (no model call)
        const pendingText =
          typeof pending.pending.text === "string" ? pending.pending.text.trim() : "";
        const pendingMedia = Array.isArray(pending.pending.media) ? pending.pending.media : [];
        const sessionMediaRefs = await loadSessionGeneratedMediaRefs({
          supabase,
          userId: verified.userId,
          sessionId,
        });
        const allowedFilesSessionIds = await loadLinkedFilesSessionIds({
          supabase,
          userId: verified.userId,
          sessionId,
        });
        const connectorExecutes: Array<{
          toolCallId: string;
          toolName: string;
          agent: string;
          connectorType: string;
          connectorParams: Record<string, unknown>;
          message: string;
        }> = [];
        const resolvedMediaExecutes: typeof connectorExecutes = [];
        const mediaResolutionErrors: string[] = [];

        for (let i = 0; i < pendingMedia.length; i++) {
          const media = pendingMedia[i]!;
          const resolvedMedia = await resolvePendingWhatsAppMediaToUrl({
            supabase,
            userId: verified.userId,
            sessionRefs: sessionMediaRefs,
            allowedFilesSessionIds,
            media,
          });
          if (!resolvedMedia.ok) {
            mediaResolutionErrors.push(
              `attachment_${i + 1}:${resolvedMedia.error || "resolve_failed"}`
            );
            continue;
          }
          resolvedMediaExecutes.push({
            toolCallId: `whatsapp-send-media-${Date.now()}-${i + 1}`,
            toolName: "whatsapp_send_media",
            agent: "files",
            connectorType: "whatsapp_send_media",
            connectorParams: {
              chat_id: pending.pending.chatId,
              recipient_display: pending.pending.recipientDisplay || "",
              pending_message_id: pending.pendingMessageId,
              ...resolvedMedia.connectorParams,
            },
            message: "Sending WhatsApp attachment…",
          });
        }

        if (pendingMedia.length > 0 && resolvedMediaExecutes.length !== pendingMedia.length) {
          const errorsPreview = mediaResolutionErrors.slice(0, 3).join("; ");
          const reply =
            "I couldn't resolve all requested attachment(s) for WhatsApp send. Please regenerate files and try again." +
            (errorsPreview ? ` Details: ${errorsPreview}` : "");
          await insertMessage({
            supabase,
            userId: verified.userId,
            sessionId,
            agentId: runtimeScope?.agentId || null,
            epochId: runtimeScope?.epochId || null,
            branchId: runtimeScope?.branchId || null,
            role: "assistant",
            content: reply,
            traceId: requireString(body.traceId) || undefined,
            metadata: {
              provider,
              mode,
              threadKey: userScopedThreadKey,
              threadName,
              deviceId: verified.deviceId,
              whatsapp_send_resolution_failed: true,
              whatsapp_send_resolution_errors: mediaResolutionErrors,
            },
          });
          return NextResponse.json({
            ok: true,
            kind: "final",
            sessionId,
            traceId: requireString(body.traceId) || undefined,
            reply,
          });
        }

        if (resolvedMediaExecutes.length > 0) {
          connectorExecutes.push(...resolvedMediaExecutes);
        }

        if (pendingText) {
          connectorExecutes.push({
            toolCallId: `whatsapp-send-text-${Date.now()}`,
            toolName: "whatsapp_send_text",
            agent: "files",
            connectorType: "whatsapp_send_text",
            connectorParams: {
              chat_id: pending.pending.chatId,
              text: pendingText,
              pending_message_id: pending.pendingMessageId,
              recipient_display: pending.pending.recipientDisplay || "",
            },
            message: "Sending WhatsApp message…",
          });
        }

        if (connectorExecutes.length === 0) {
          const reply =
            "I couldn't resolve the requested attachment(s) for WhatsApp send. Please regenerate files and try again.";
          await insertMessage({
            supabase,
            userId: verified.userId,
            sessionId,
            agentId: runtimeScope?.agentId || null,
            epochId: runtimeScope?.epochId || null,
            branchId: runtimeScope?.branchId || null,
            role: "assistant",
            content: reply,
            traceId: requireString(body.traceId) || undefined,
            metadata: {
              provider,
              mode,
              threadKey: userScopedThreadKey,
              threadName,
              deviceId: verified.deviceId,
              whatsapp_send_resolution_failed: true,
            },
          });
          return NextResponse.json({
            ok: true,
            kind: "final",
            sessionId,
            traceId: requireString(body.traceId) || undefined,
            reply,
          });
        }

        return NextResponse.json({
          ok: true,
          kind: "needs_connector",
          sessionId,
          traceId: requireString(body.traceId) || undefined,
          partialText: "Sending…",
          statusMessage:
            pendingMedia.length > 0 ? "Sending WhatsApp message and attachments…" : "Sending WhatsApp message…",
          connectorExecutes,
        });
      }
    }
  }

  const persistedHistory = await loadSessionHistory({ supabase, userId: verified.userId, sessionId });
  // Override the last user message for this round only (so the model sees parsed doc text),
  // while keeping persisted messages clean for the dashboard UI.
  const history = [...persistedHistory];
  if (hasUserMessage && messageForModel.trim()) {
    const lastUserIdx = history.findLastIndex((m) => m.role === "user");
    if (lastUserIdx >= 0) {
      history[lastUserIdx] = { role: "user", content: messageForModel };
    }
  }

  // Ensure a linked Files-agent session exists so files_agent_request can work in WhatsApp.
  const filesAgent = await getOrCreateFilesAgentSession({
    supabase,
    userId: verified.userId,
    orchestratorSessionId: sessionId,
    title: threadName || null,
  });
  
  // Debug: log session history
  console.log("[whatsapp-api] Session history loaded:", {
    sessionId,
    mode,
    messageCount: history.length,
    lastMessages: history.slice(-3).map((m) => ({
      role: m.role,
      contentPreview: typeof m.content === "string" ? m.content.slice(0, 100) : "[non-string]",
    })),
  });

  // Load user's AI chat agents for delegation
  const { data: aiChatAgentsData } = await supabase
    .from("agents")
    .select("id, name, system_prompt")
    .eq("user_id", verified.userId)
    .eq("type", "ai-chat")
    .order("created_at", { ascending: false });

  const aiChatAgents = (aiChatAgentsData || []).map((a) => ({
    id: a.id as string,
    name: a.name as string,
    systemPrompt: (a.system_prompt as string) || undefined,
  }));

  // Gather web pixel names (as shown in dashboard) so the model can choose correctly (pixelName).
  let webPixelNames: string[] = [];
  try {
    const { data: pxRows } = await supabase
      .from("datagran_agent_configs")
      .select("provider, connection_id, agents!datagran_agent_configs_agent_id_fkey(name)")
      .eq("user_id", verified.userId)
      .eq("provider", "web_pixel")
      .not("connection_id", "is", null)
      .limit(50);
    webPixelNames =
      (pxRows || [])
        .map((r) => {
          const row = r as unknown as { agents?: { name?: unknown } | null };
          const name = row?.agents?.name;
          return typeof name === "string" ? name.trim() : "";
        })
        .filter((n): n is string => typeof n === "string" && n.trim().length > 0);
  } catch (e) {
    console.warn("[whatsapp-api] Failed to load web pixel names:", e);
  }

  console.log("[whatsapp-api] run_orchestrator_round:start", {
    sessionId,
    mode,
    traceId: incomingTraceId || null,
    hasUserMessage,
    toolResultsCount: toolResults.length,
    hasFiles: files.length > 0,
    webPixelNamesCount: webPixelNames.length,
  });

  const round = await runOrchestratorRound({
    supabase,
    userId: verified.userId,
    userEmail,
    orchestratorAgentId: runtimeScope?.agentId || null,
    orchestratorSessionId: sessionId,
    branchCurrentTurnCount: runtimeScope?.branchTurnCount ?? null,
    branchActiveCount: runtimeScope?.activeBranchCount ?? null,
    turnId: incomingTraceId || undefined,
    // Internal self-calls must use the current request origin, not a stale public URL.
    appBaseUrl: new URL(req.url).origin,
    deviceId: verified.deviceId,
    connectorPlatform,
    obsidianVaultPath,
    codeMode: false,
    codeTerminalId,
    codeWorkspaceRootPath,
    history,
    message: messageForModel,
    memoryEnabled,
    toolResults: toolResults.length ? toolResults : undefined,
    // Attached files from WhatsApp
    files: files.length ? files : undefined,
    // Files agent session for document creation
    filesAgent,
    // Forward device token for sub-agent auth in WhatsApp mode
    deviceToken,
    // No cookies in WhatsApp channel
    cookies: undefined,
    traceId: requireString(body.traceId) || undefined,
    // User's AI chat agents for delegation
    aiChatAgents,
    webPixelNames,
  });
  const runtimeScopeAfterRound = await resolveRuntimeScope({
    supabase,
    userId: verified.userId,
    sessionId,
    agentId: runtimeScope?.agentId || null,
  }).catch(() => runtimeScope);

  console.log("[whatsapp-api] run_orchestrator_round:done", {
    sessionId,
    mode,
    traceId: round.traceId,
    kind: round.kind,
    toolCallsExecuted: round.toolCallsExecuted.length,
  });

  // Log tool executions to activity feed
  for (const toolName of round.toolCallsExecuted) {
    const agent = toolName.startsWith("obsidian_") ? "obsidian"
      : toolName.startsWith("browser_") ? "browser"
      : toolName.startsWith("files_") ? "files"
      : toolName.startsWith("data_") ? "data"
      : toolName.startsWith("schedule_") ? "schedule"
      : toolName.startsWith("code_") ? "code"
      : "system";
    await insertActivity({
      supabase,
      userId: verified.userId,
      sessionId,
      agent,
      action: toolName.replace(/_/g, " "),
      detail: `via WhatsApp`,
      status: "complete",
      traceId: round.traceId,
      metadata: { provider, mode, threadKey: userScopedThreadKey, source: "whatsapp" },
    });
  }

  if (round.kind === "final") {
    const files = (round as unknown as { files?: unknown }).files;
    const generatedFilesRaw = (round as unknown as { generatedFiles?: unknown }).generatedFiles;
    const generatedFiles = Array.isArray(generatedFilesRaw)
      ? generatedFilesRaw
      : [];
    const shouldAttachTwilioFollowup = round.toolCallsExecuted.some((toolName) =>
      WHATSAPP_TWILIO_FOLLOWUP_TOOL_NAMES.has(toolName)
    );
    const latestTwilio = shouldAttachTwilioFollowup
      ? await loadLatestTwilioSupervisorStateForSession({
          supabase,
          userId: verified.userId,
          sessionId,
        }).catch(() => null)
      : null;
    const latestTwilioState = latestTwilio?.state || null;
    const twilioFollowupCursor = getTwilioSupervisorCursor(latestTwilioState);
    const twilioFollowupTerminal = isTerminalTwilioSupervisorState(latestTwilioState);
    const twilioFollowupKind = requireString(latestTwilioState?.childKind);
    const twilioFollowup =
      latestTwilioState && twilioFollowupCursor && !twilioFollowupTerminal
        ? {
            sessionId,
            cursor: twilioFollowupCursor,
            childKind: twilioFollowupKind,
            status: requireString(latestTwilioState.status),
            pollAfterMs: twilioFollowupKind === "sms" ? 15_000 : 7_000,
          }
        : null;
    const hasFiles = Array.isArray(files) && files.length > 0;
    const combinedReplyRaw = [inboxCommandReplyPrefix, typeof round.text === "string" ? round.text : ""]
      .filter((part) => typeof part === "string" && part.trim().length > 0)
      .join("\n\n");
    const MAX_WHATSAPP_REPLY_CHARS = 3500;
    const safeReply =
      combinedReplyRaw.length > MAX_WHATSAPP_REPLY_CHARS
        ? `${combinedReplyRaw.slice(0, MAX_WHATSAPP_REPLY_CHARS)}\n...(truncated)`
        : combinedReplyRaw;

    const extracted = extractWhatsAppSendConfirmation(safeReply);
    const replyText = extracted.cleanText.trim()
      ? extracted.cleanText
      : hasFiles
        ? ""
        : "I ran into an internal processing error. Please resend your last command.";

    const contentToPersist = replyText.trim()
      ? replyText
      : hasFiles
        ? "[generated image]"
        : "";

    if (contentToPersist) {
      await insertMessage({
        supabase,
        userId: verified.userId,
        sessionId,
        agentId: runtimeScopeAfterRound?.agentId || runtimeScope?.agentId || null,
        epochId: runtimeScopeAfterRound?.epochId || runtimeScope?.epochId || null,
        branchId: runtimeScopeAfterRound?.branchId || runtimeScope?.branchId || null,
        role: "assistant",
        content: contentToPersist,
        traceId: round.traceId,
        metadata: {
          provider,
          mode,
          threadKey: userScopedThreadKey,
          threadName,
          deviceId: verified.deviceId,
          ...(inboxCommandReplyPrefix ? { inbox_action_followup_combined: true } : {}),
          ...(generatedFiles.length > 0 ? { generated_files: generatedFiles } : {}),
          ...(extracted.pendingSend ? { whatsapp_pending_send: extracted.pendingSend } : {}),
        },
      });
      // Log assistant reply to activity feed
      await insertActivity({
        supabase,
        userId: verified.userId,
        sessionId,
        agent: "system",
        action: "WhatsApp reply",
        detail: contentToPersist.trim().slice(0, 100),
        status: "complete",
        traceId: round.traceId,
        metadata: { provider, mode, threadKey: userScopedThreadKey, source: "whatsapp" },
      });
    }
    return NextResponse.json({
      ok: true,
      kind: "final",
      sessionId,
      traceId: round.traceId,
      reply: replyText,
      files: (round as unknown as { files?: unknown }).files || undefined,
      ...(twilioFollowup ? { twilioFollowup } : {}),
    });
  }

  if (round.kind === "needs_connector") {
    // Generate status message for WhatsApp to show progress
    const statusMessages = round.connectorExecutes.map((ex) => {
      if (ex.connectorType.startsWith("obsidian_")) return "Searching Obsidian vault...";
      if (ex.connectorType.startsWith("browser_")) return "Working in browser...";
      if (ex.connectorType.startsWith("file_")) return "Accessing files...";
      if (ex.connectorType === "terminal_step") return "Working in Claude Code...";
      return `Running ${ex.connectorType}...`;
    });
    const connectorMessage =
      round.connectorExecutes.find((ex) => typeof ex.message === "string" && ex.message.trim())
        ?.message || "";
    const statusMessage = connectorMessage.trim() || statusMessages[0] || "Processing...";
    
    return NextResponse.json({
      ok: true,
      kind: "needs_connector",
      sessionId,
      traceId: round.traceId,
      partialText: round.partialText,
      connectorExecutes: round.connectorExecutes,
      statusMessage,
    });
  }

  if (round.kind === "browser_task") {
    return NextResponse.json({
      ok: true,
      kind: "browser_task",
      sessionId,
      traceId: round.traceId,
      partialText: round.partialText,
      browserTask: round.browserTask,
      error:
        "browser_task returned a UI-only marker unexpectedly. This should not happen: browser_task should execute via connector in WhatsApp.",
    });
  }

  // ui_open_code in WhatsApp: tell caller to use @code instead
  return NextResponse.json({
    ok: true,
    kind: "ui_open_code",
    sessionId,
    traceId: round.traceId,
    partialText: round.partialText,
    uiOpenCode: round.uiOpenCode,
    message: "Use @code in WhatsApp to enter Claude Code mode.",
  });
}
