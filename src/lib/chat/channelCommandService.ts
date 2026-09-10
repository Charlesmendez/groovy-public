import type { SupabaseClient } from "@supabase/supabase-js";
import { directMessageDisplayName } from "@/lib/chat/directMessages";
import { memberDisplayName } from "@/lib/chat/social";

export type ChatChannelCommandKind = "channel" | "dm" | "any";
export type ChatWorkspaceRole = "admin" | "member" | "guest";

type ChatChannelAccessRow = {
  id: string;
  workspace_id: string;
  kind: "channel" | "dm";
  name: string;
  slug: string;
  visibility: "workspace" | "private";
  is_archived: boolean;
  created_by: string;
};

type ChatChannelMemberRow = {
  channel_id: string;
  member_type: "user" | "agent" | "orchestrator";
  user_id: string | null;
};

export type AccessibleChatChannel = {
  id: string;
  workspaceId: string;
  kind: "channel" | "dm";
  name: string;
  slug: string;
  displayName: string;
  visibility: "workspace" | "private";
  isArchived: boolean;
};

export type ChatChannelAuthorization =
  | { ok: true; channel: AccessibleChatChannel }
  | { ok: false; reason: "not_found" | "archived" };

export type ChatChannelResolution =
  | { ok: true; channel: AccessibleChatChannel }
  | {
      ok: false;
      reason: "not_found" | "archived";
      message: string;
    }
  | {
      ok: false;
      reason: "ambiguous";
      message: string;
      candidates: AccessibleChatChannel[];
    };

type WorkspaceMembershipCandidate = {
  workspaceId: string;
  role: ChatWorkspaceRole;
};

function value(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function workspaceRole(value: unknown): ChatWorkspaceRole | null {
  if (value === "admin" || value === "member" || value === "guest") {
    return value;
  }
  return null;
}

export function selectActiveWorkspaceMembership(args: {
  memberships: WorkspaceMembershipCandidate[];
  preferredWorkspaceId?: string | null;
  ownedWorkspaceIds?: Iterable<string>;
}): WorkspaceMembershipCandidate | null {
  if (args.memberships.length === 0) return null;
  const preferredWorkspaceId = value(args.preferredWorkspaceId);
  const preferred = args.memberships.find(
    (membership) => membership.workspaceId === preferredWorkspaceId,
  );
  if (preferred) return preferred;
  const ownedWorkspaceIds = new Set(args.ownedWorkspaceIds || []);
  return (
    args.memberships.find((membership) =>
      ownedWorkspaceIds.has(membership.workspaceId),
    ) || args.memberships[0]
  );
}

function parseChannelRow(value: unknown): ChatChannelAccessRow | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const id = valueOf(row.id);
  const workspaceId = valueOf(row.workspace_id);
  const name = valueOf(row.name);
  const slug = valueOf(row.slug);
  const createdBy = valueOf(row.created_by);
  const kind = row.kind === "dm" ? "dm" : row.kind === "channel" ? "channel" : null;
  const visibility =
    row.visibility === "private"
      ? "private"
      : row.visibility === "workspace"
        ? "workspace"
        : null;
  if (!id || !workspaceId || !name || !slug || !createdBy || !kind || !visibility) {
    return null;
  }
  return {
    id,
    workspace_id: workspaceId,
    kind,
    name,
    slug,
    visibility,
    is_archived: row.is_archived === true,
    created_by: createdBy,
  };
}

function valueOf(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function publicChannel(
  row: ChatChannelAccessRow,
  displayName = row.name,
): AccessibleChatChannel {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    kind: row.kind,
    name: row.name,
    slug: row.slug,
    displayName: displayName.trim() || row.name,
    visibility: row.visibility,
    isArchived: row.is_archived,
  };
}

/**
 * Byte-for-byte policy equivalent of can_read_chat_channel for a known active
 * workspace membership. In particular, DMs never inherit creator or workspace
 * admin access; they require an explicit user membership in that room.
 */
export function canUserAccessChatChannel(args: {
  userId: string;
  workspaceRole: ChatWorkspaceRole | null;
  channel: {
    kind: "channel" | "dm";
    visibility: "workspace" | "private";
    createdBy: string;
  };
  isExplicitMember: boolean;
}): boolean {
  if (!args.userId || !args.workspaceRole) return false;
  if (args.isExplicitMember) return true;
  if (args.channel.kind !== "channel") return false;
  if (args.channel.createdBy === args.userId) return true;
  if (args.workspaceRole === "admin") return true;
  return (
    args.workspaceRole === "member" &&
    args.channel.visibility === "workspace"
  );
}

async function activeWorkspaceMembership(args: {
  admin: SupabaseClient;
  userId: string;
}): Promise<{ workspaceId: string; role: ChatWorkspaceRole } | null> {
  const { data: membershipRows, error: membershipsError } = await args.admin
    .from("workspace_members")
    .select("workspace_id,role,created_at")
    .eq("user_id", args.userId)
    .order("created_at", { ascending: true });
  if (membershipsError) throw new Error(membershipsError.message);
  const memberships = (membershipRows || [])
    .map((row) => {
      const record = row as Record<string, unknown>;
      const role = workspaceRole(record.role);
      const workspaceId = value(record.workspace_id);
      return role && workspaceId ? { workspaceId, role } : null;
    })
    .filter(
      (
        membership,
      ): membership is { workspaceId: string; role: ChatWorkspaceRole } =>
        Boolean(membership),
    );
  if (memberships.length === 0) return null;

  let preferences: Record<string, unknown> | null = null;
  const primaryPreference = await args.admin
    .from("user_preferences")
    .select("active_workspace_id,onboarding_data")
    .eq("user_id", args.userId)
    .maybeSingle();
  if (!primaryPreference.error) {
    preferences =
      (primaryPreference.data as Record<string, unknown> | null) || null;
  } else if (
    primaryPreference.error.code === "PGRST204" ||
    primaryPreference.error.message.includes("active_workspace_id")
  ) {
    const fallbackPreference = await args.admin
      .from("user_preferences")
      .select("onboarding_data")
      .eq("user_id", args.userId)
      .maybeSingle();
    if (!fallbackPreference.error) {
      preferences =
        (fallbackPreference.data as Record<string, unknown> | null) || null;
    }
  } else {
    console.warn(
      "[team-chat] active workspace preference lookup failed:",
      primaryPreference.error.message,
    );
  }
  const onboardingData =
    preferences?.onboarding_data &&
    typeof preferences.onboarding_data === "object" &&
    !Array.isArray(preferences.onboarding_data)
      ? (preferences.onboarding_data as Record<string, unknown>)
      : null;
  const preferredWorkspaceId = value(
    preferences?.active_workspace_id || onboardingData?.activeWorkspaceId,
  );
  const preferred = selectActiveWorkspaceMembership({
    memberships,
    preferredWorkspaceId,
  });
  if (preferred && preferred.workspaceId === preferredWorkspaceId) {
    return preferred;
  }

  const workspaceIds = memberships.map((membership) => membership.workspaceId);
  const { data: workspaces, error: workspacesError } = await args.admin
    .from("workspaces")
    .select("id,billing_admin_user_id")
    .in("id", workspaceIds);
  if (workspacesError) {
    console.warn(
      "[team-chat] owned workspace lookup failed:",
      workspacesError.message,
    );
    return memberships[0];
  }
  const ownedWorkspaceIds = new Set(
    (workspaces || [])
      .filter(
        (workspace) =>
          value((workspace as Record<string, unknown>).billing_admin_user_id) ===
          args.userId,
      )
      .map((workspace) =>
        value((workspace as Record<string, unknown>).id),
      ),
  );
  return selectActiveWorkspaceMembership({
    memberships,
    preferredWorkspaceId,
    ownedWorkspaceIds,
  });
}

async function loadExplicitMembership(args: {
  admin: SupabaseClient;
  channelId: string;
  userId: string;
}): Promise<boolean> {
  const { data, error } = await args.admin
    .from("chat_channel_members")
    .select("id")
    .eq("channel_id", args.channelId)
    .eq("member_type", "user")
    .eq("user_id", args.userId)
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return Boolean(data);
}

/** Resolve and authorize one exact room without exposing cross-workspace rows. */
export async function authorizeChatChannelForUser(args: {
  admin: SupabaseClient;
  userId: string;
  channelId: string;
}): Promise<ChatChannelAuthorization> {
  const membership = await activeWorkspaceMembership(args);
  if (!membership) return { ok: false, reason: "not_found" };

  const { data, error } = await args.admin
    .from("chat_channels")
    .select(
      "id,workspace_id,kind,name,slug,visibility,is_archived,created_by",
    )
    .eq("workspace_id", membership.workspaceId)
    .eq("id", args.channelId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  const channel = parseChannelRow(data);
  if (!channel) return { ok: false, reason: "not_found" };

  const isExplicitMember = await loadExplicitMembership({
    admin: args.admin,
    channelId: channel.id,
    userId: args.userId,
  });
  if (
    !canUserAccessChatChannel({
      userId: args.userId,
      workspaceRole: membership.role,
      channel: {
        kind: channel.kind,
        visibility: channel.visibility,
        createdBy: channel.created_by,
      },
      isExplicitMember,
    })
  ) {
    return { ok: false, reason: "not_found" };
  }
  if (channel.is_archived) return { ok: false, reason: "archived" };
  return { ok: true, channel: publicChannel(channel) };
}

async function loadAccessibleChatChannels(args: {
  admin: SupabaseClient;
  userId: string;
}): Promise<AccessibleChatChannel[]> {
  const membership = await activeWorkspaceMembership(args);
  if (!membership) return [];

  const { data: rawChannels, error: channelsError } = await args.admin
    .from("chat_channels")
    .select(
      "id,workspace_id,kind,name,slug,visibility,is_archived,created_by",
    )
    .eq("workspace_id", membership.workspaceId);
  if (channelsError) throw new Error(channelsError.message);
  const channels = (rawChannels || [])
    .map(parseChannelRow)
    .filter((row): row is ChatChannelAccessRow => Boolean(row));
  if (channels.length === 0) return [];

  const channelIds = channels.map((channel) => channel.id);
  const { data: rawMembers, error: membersError } = await args.admin
    .from("chat_channel_members")
    .select("channel_id,member_type,user_id")
    .in("channel_id", channelIds);
  if (membersError) throw new Error(membersError.message);
  const members = (rawMembers || []) as ChatChannelMemberRow[];
  const explicitChannelIds = new Set(
    members
      .filter(
        (member) =>
          member.member_type === "user" && member.user_id === args.userId,
      )
      .map((member) => String(member.channel_id)),
  );
  const accessible = channels.filter((channel) =>
    canUserAccessChatChannel({
      userId: args.userId,
      workspaceRole: membership.role,
      channel: {
        kind: channel.kind,
        visibility: channel.visibility,
        createdBy: channel.created_by,
      },
      isExplicitMember: explicitChannelIds.has(channel.id),
    }),
  );
  if (accessible.length === 0) return [];

  const accessibleDmIds = new Set(
    accessible
      .filter((channel) => channel.kind === "dm")
      .map((channel) => channel.id),
  );
  const participantUserIds = Array.from(
    new Set(
      members
        .filter(
          (member) =>
            member.member_type === "user" &&
            accessibleDmIds.has(String(member.channel_id)) &&
            typeof member.user_id === "string",
        )
        .map((member) => String(member.user_id)),
    ),
  );
  const { data: activeParticipants, error: activeParticipantsError } =
    participantUserIds.length
      ? await args.admin
          .from("workspace_members")
          .select("user_id")
          .eq("workspace_id", membership.workspaceId)
          .in("user_id", participantUserIds)
      : { data: [], error: null };
  if (activeParticipantsError) throw new Error(activeParticipantsError.message);
  const activeParticipantIds = (activeParticipants || []).map((participant) =>
    valueOf((participant as Record<string, unknown>).user_id),
  );
  const { data: profiles, error: profilesError } = activeParticipantIds.length
    ? await args.admin
        .from("chat_member_profiles")
        .select("user_id,display_name")
        .in("user_id", activeParticipantIds)
    : { data: [], error: null };
  if (profilesError) throw new Error(profilesError.message);
  const profileByUserId = new Map(
    (profiles || []).map((profile) => [
      valueOf((profile as Record<string, unknown>).user_id),
      {
        display_name:
          valueOf((profile as Record<string, unknown>).display_name) || null,
      },
    ] as const),
  );
  const emailByUserId = new Map<string, string | null>();
  const participantIdsNeedingEmail = activeParticipantIds.filter(
    (userId) => !profileByUserId.get(userId)?.display_name,
  );
  const EMAIL_LOOKUP_CONCURRENCY = 8;
  for (
    let index = 0;
    index < participantIdsNeedingEmail.length;
    index += EMAIL_LOOKUP_CONCURRENCY
  ) {
    const chunk = participantIdsNeedingEmail.slice(
      index,
      index + EMAIL_LOOKUP_CONCURRENCY,
    );
    const resolved = await Promise.all(
      chunk.map(async (userId) => {
        try {
          const { data } = await args.admin.auth.admin.getUserById(userId);
          return [userId, data.user?.email || null] as const;
        } catch {
          return [userId, null] as const;
        }
      }),
    );
    for (const [userId, email] of resolved) emailByUserId.set(userId, email);
  }
  const memberNames = new Map(
    activeParticipantIds.map((userId) => [
      userId,
      memberDisplayName({
        email: emailByUserId.get(userId) || null,
        profile: profileByUserId.get(userId) || null,
      }),
    ]),
  );

  return accessible.map((channel) => {
    const channelMembers = members.filter(
      (member) => String(member.channel_id) === channel.id,
    );
    const displayName =
      channel.kind === "dm"
        ? directMessageDisplayName({
            fallbackName: channel.name,
            currentUserId: args.userId,
            memberUserIds: channelMembers
              .filter((member) => member.member_type === "user")
              .map((member) => member.user_id),
            hasAgent: channelMembers.some(
              (member) => member.member_type === "agent",
            ),
            memberNames,
          })
        : channel.name;
    return publicChannel(channel, displayName);
  });
}

function normalizedLookup(value: string): string {
  return value
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, " ")
    .toLocaleLowerCase("en-US");
}

function matchRank(channel: AccessibleChatChannel, rawQuery: string): number {
  const query = normalizedLookup(rawQuery);
  if (!query) return Number.POSITIVE_INFINITY;
  if (normalizedLookup(channel.id) === query) return 0;
  if (
    rawQuery.trim().startsWith("#") &&
    channel.kind === "channel" &&
    normalizedLookup(channel.slug) === normalizedLookup(rawQuery.trim().slice(1))
  ) {
    return 1;
  }
  if (normalizedLookup(channel.slug) === query) return 2;
  if (
    normalizedLookup(channel.displayName) === query ||
    normalizedLookup(channel.name) === query
  ) {
    return 3;
  }
  const fields = [channel.slug, channel.displayName, channel.name].map(
    normalizedLookup,
  );
  if (fields.some((field) => field.startsWith(query))) return 4;
  if (fields.some((field) => field.includes(query))) return 5;
  return Number.POSITIVE_INFINITY;
}

function compareChannels(
  left: AccessibleChatChannel,
  right: AccessibleChatChannel,
): number {
  return (
    left.kind.localeCompare(right.kind) ||
    normalizedLookup(left.displayName).localeCompare(
      normalizedLookup(right.displayName),
    ) ||
    left.id.localeCompare(right.id)
  );
}

/**
 * Pure resolver used by the database-backed command service and tests. The
 * input must already contain only rooms the actor may access.
 */
export function resolveAccessibleChatChannelFromCandidates(args: {
  channels: AccessibleChatChannel[];
  query: string;
  kind?: ChatChannelCommandKind;
}): ChatChannelResolution {
  const query = args.query.trim();
  if (!query) {
    return {
      ok: false,
      reason: "not_found",
      message: "Name a Team Chat channel or direct message.",
    };
  }
  const requestedKind = args.kind || "any";
  const ranked = args.channels
    .filter(
      (channel) => requestedKind === "any" || channel.kind === requestedKind,
    )
    .map((channel) => ({ channel, rank: matchRank(channel, query) }))
    .filter((match) => Number.isFinite(match.rank));
  if (ranked.length === 0) {
    return {
      ok: false,
      reason: "not_found",
      message: "No accessible Team Chat conversation matched that name.",
    };
  }

  const bestRank = Math.min(...ranked.map((match) => match.rank));
  const best = ranked
    .filter((match) => match.rank === bestRank)
    .map((match) => match.channel);
  const active = best.filter((channel) => !channel.isArchived);
  const eligible = (active.length > 0 ? active : best).sort(compareChannels);
  if (eligible.length > 1) {
    return {
      ok: false,
      reason: "ambiguous",
      message: "More than one accessible Team Chat conversation has that name.",
      candidates: eligible.slice(0, 5),
    };
  }
  const channel = eligible[0];
  if (channel.isArchived) {
    return {
      ok: false,
      reason: "archived",
      message: "That Team Chat conversation is archived and read-only.",
    };
  }
  return { ok: true, channel };
}

export async function resolveAccessibleChatChannel(args: {
  admin: SupabaseClient;
  userId: string;
  query: string;
  kind?: ChatChannelCommandKind;
}): Promise<ChatChannelResolution> {
  const channels = await loadAccessibleChatChannels(args);
  return resolveAccessibleChatChannelFromCandidates({
    channels,
    query: args.query,
    kind: args.kind,
  });
}

export function isMatchingInternalChatMessageReplay(args: {
  row: unknown;
  channelId: string;
  userId: string;
  clientMessageId: string;
  content: string;
}): boolean {
  if (!args.row || typeof args.row !== "object" || Array.isArray(args.row)) {
    return false;
  }
  const row = args.row as Record<string, unknown>;
  const metadata =
    row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata)
      ? (row.metadata as Record<string, unknown>)
      : {};
  return (
    row.id === args.clientMessageId &&
    row.channel_id === args.channelId &&
    row.author_type === "user" &&
    row.author_user_id === args.userId &&
    row.content === args.content &&
    metadata.client_message_id === args.clientMessageId
  );
}
