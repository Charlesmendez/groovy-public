import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import {
  GUEST_SAFE_MIND_REQUIREMENT,
  isGuestSafeMind,
} from "@/lib/chat/guestMind";

export type WorkspaceAccessRole = "member" | "guest";

export type WorkspaceAccessChannel = {
  id: string;
  name: string;
  profile_id: string | null;
  orchestrator_mode: string;
};

export type WorkspaceAccessChannelValidation =
  | { ok: true; channels: WorkspaceAccessChannel[] }
  | { ok: false; error: string; status: number };

export function normalizeWorkspaceAccessChannelIds(value: unknown): string[] {
  return Array.from(
    new Set(
      (Array.isArray(value) ? value : [])
        .map((id) => String(id).trim())
        .filter(Boolean),
    ),
  );
}

export async function validateWorkspaceAccessChannels(params: {
  admin: ReturnType<typeof createSupabaseAdminClient>;
  workspaceId: string;
  role: WorkspaceAccessRole;
  channelIds: string[];
}): Promise<WorkspaceAccessChannelValidation> {
  if (params.role === "guest" && params.channelIds.length === 0) {
    return {
      ok: false,
      error: "Channel guests must have access to at least one channel",
      status: 400,
    };
  }

  const { data: selectedChannels, error: channelError } =
    params.channelIds.length
      ? await params.admin
          .from("chat_channels")
          .select("id,name,profile_id,orchestrator_mode")
          .eq("workspace_id", params.workspaceId)
          .eq("kind", "channel")
          .eq("is_archived", false)
          .in("id", params.channelIds)
      : { data: [], error: null };
  if (channelError) {
    return { ok: false, error: channelError.message, status: 500 };
  }
  if ((selectedChannels || []).length !== params.channelIds.length) {
    return {
      ok: false,
      error: "One or more selected channels are invalid",
      status: 400,
    };
  }

  const channels = (selectedChannels || []) as WorkspaceAccessChannel[];
  if (params.role !== "guest") {
    return { ok: true, channels };
  }

  const channelsWithMind = channels.filter(
    (channel) => channel.orchestrator_mode !== "off",
  );
  const profileIds = Array.from(
    new Set(
      channelsWithMind
        .map((channel) => String(channel.profile_id || ""))
        .filter(Boolean),
    ),
  );
  const { data: profiles, error: profilesError } = profileIds.length
    ? await params.admin
        .from("orchestrator_profiles")
        .select(
          "id,workspace_id,surface,authorization_stance,memory_scope,inherit_workspace_skills,inherit_workspace_integrations",
        )
        .eq("workspace_id", params.workspaceId)
        .in("id", profileIds)
    : { data: [], error: null };
  if (profilesError) {
    return { ok: false, error: profilesError.message, status: 500 };
  }

  const safeProfileIds = new Set(
    (profiles || [])
      .filter((profile) => isGuestSafeMind(profile))
      .map((profile) => String(profile.id)),
  );
  const invalidChannels = channelsWithMind.filter(
    (channel) =>
      !channel.profile_id || !safeProfileIds.has(String(channel.profile_id)),
  );
  if (invalidChannels.length > 0) {
    return {
      ok: false,
      error: `${GUEST_SAFE_MIND_REQUIREMENT} Configure ${invalidChannels
        .map((channel) => `#${channel.name}`)
        .join(", ")} before granting guest access.`,
      status: 409,
    };
  }

  return { ok: true, channels };
}
