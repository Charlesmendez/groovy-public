import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

export type ChatChannelRow = {
  id: string;
  workspace_id: string;
  kind: "channel" | "dm";
  name: string;
  slug: string;
  topic: string | null;
  profile_id: string | null;
  orchestrator_mode: "mention" | "always" | "off";
  visibility: "workspace" | "private";
  is_archived: boolean;
  created_by: string;
};

export type TeamChatControlRequest = {
  action: "stop" | "redirect";
  target: "orchestrator" | "agent";
  taskId: string | null;
  direction: string | null;
};

type ChatChannelMutationError = {
  message: string;
  code?: string | null;
};

export type ChatChannelCreationResult<T> =
  | { data: T; error: null; stage: null }
  | {
      data: null;
      error: ChatChannelMutationError;
      stage: "channel" | "members" | "capabilities" | "read";
    };

export async function createChatChannelInRlsOrder<T>(operations: {
  insertChannelWithoutReturning: () => Promise<ChatChannelMutationError | null>;
  insertMembers: () => Promise<ChatChannelMutationError | null>;
  insertCapabilities?: () => Promise<ChatChannelMutationError | null>;
  readChannel: () => Promise<{
    data: T | null;
    error: ChatChannelMutationError | null;
  }>;
  rollbackChannel: () => Promise<void>;
}): Promise<ChatChannelCreationResult<T>> {
  const channelError = await operations.insertChannelWithoutReturning();
  if (channelError) {
    return { data: null, error: channelError, stage: "channel" };
  }

  const membersError = await operations.insertMembers();
  if (membersError) {
    await operations.rollbackChannel();
    return { data: null, error: membersError, stage: "members" };
  }

  if (operations.insertCapabilities) {
    const capabilitiesError = await operations.insertCapabilities();
    if (capabilitiesError) {
      await operations.rollbackChannel();
      return {
        data: null,
        error: capabilitiesError,
        stage: "capabilities",
      };
    }
  }

  const channelResult = await operations.readChannel();
  if (channelResult.error || !channelResult.data) {
    await operations.rollbackChannel();
    return {
      data: null,
      error: channelResult.error || { message: "Could not load the new channel" },
      stage: "read",
    };
  }

  return { data: channelResult.data, error: null, stage: null };
}

export function parseTeamChatControlRequest(
  input: unknown,
):
  | { ok: true; value: TeamChatControlRequest }
  | { ok: false; error: string } {
  const body =
    input && typeof input === "object" && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : null;
  const action =
    body?.action === "stop" || body?.action === "redirect"
      ? body.action
      : null;
  const target =
    body?.target === "orchestrator" || body?.target === "agent"
      ? body.target
      : null;
  if (!action || !target) {
    return { ok: false, error: "action and target are required" };
  }
  const taskId =
    typeof body?.taskId === "string" && body.taskId.trim()
      ? body.taskId.trim()
      : null;
  if (target === "agent" && !taskId) {
    return { ok: false, error: "taskId is required" };
  }
  const direction =
    typeof body?.direction === "string" && body.direction.trim()
      ? body.direction.trim()
      : null;
  if (action === "redirect" && (!direction || direction.length > 4000)) {
    return {
      ok: false,
      error: "direction must be 1-4000 characters",
    };
  }
  return {
    ok: true,
    value: {
      action,
      target,
      taskId,
      direction: action === "redirect" ? direction : null,
    },
  };
}

export function slugifyChatChannel(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63);
}

export function mentionsHandle(content: string, handle: string): boolean {
  const normalized = handle.trim().replace(/^@/, "");
  if (!normalized) return false;
  const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|\\s)@${escaped}(?=\\s|[.,!?;:]|$)`, "i").test(content);
}

export function shouldRunChannelOrchestrator(args: {
  content: string;
  channel: ChatChannelRow;
  profileName?: string | null;
  profileSlug?: string | null;
  agentNames?: string[];
}): boolean {
  if (args.channel.orchestrator_mode === "off") return false;
  if (args.channel.orchestrator_mode === "always") return true;
  if (mentionsHandle(args.content, "orchestrator")) return true;
  if (args.profileSlug && mentionsHandle(args.content, args.profileSlug)) return true;
  if (args.profileName) {
    const compact = args.profileName.replace(/\s+/g, "");
    const first = args.profileName.split(/\s+/)[0];
    if (mentionsHandle(args.content, compact) || mentionsHandle(args.content, first)) return true;
  }
  return (args.agentNames || []).some((name) => {
    const compact = name.replace(/\s+/g, "");
    const first = name.split(/\s+/)[0];
    return mentionsHandle(args.content, compact) || mentionsHandle(args.content, first);
  });
}

export async function getOrCreateExternalSession(args: {
  admin: SupabaseClient;
  ownerUserId: string;
  provider: string;
  threadKey: string;
  threadName: string;
  profileId?: string | null;
  externalParticipantId?: string | null;
  apiKeyId?: string | null;
}): Promise<{ threadId: string; sessionId: string }> {
  const { data, error } = await args.admin.rpc(
    "get_or_create_orchestrator_external_thread",
    {
      p_user_id: args.ownerUserId,
      p_provider: args.provider,
      p_thread_key: args.threadKey,
      p_thread_name: args.threadName,
      p_profile_id: args.profileId || null,
      p_external_participant_id: args.externalParticipantId || null,
      p_api_key_id: args.apiKeyId || null,
    },
  );
  const row = Array.isArray(data) ? data[0] : data;
  if (error || !row?.thread_id || !row?.session_id) {
    throw new Error(error?.message || "Failed to resolve orchestrator thread");
  }
  return {
    threadId: String(row.thread_id),
    sessionId: String(row.session_id),
  };
}

export async function acquireTurnLock(
  admin: SupabaseClient,
  sessionId: string,
): Promise<{ token: string; release: () => Promise<void> } | null> {
  const token = randomUUID();
  const { data, error } = await admin.rpc("acquire_orchestrator_turn_lock", {
    p_session_id: sessionId,
    p_lock_token: token,
    p_ttl_seconds: 800,
  });
  if (error || data !== true) return null;
  return {
    token,
    release: async () => {
      await admin.rpc("release_orchestrator_turn_lock", {
        p_session_id: sessionId,
        p_lock_token: token,
      });
    },
  };
}
