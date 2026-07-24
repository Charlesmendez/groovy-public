import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import {
  parseChannelOrchestratorInstructions,
  slugifyChatChannel,
} from "@/lib/teamChat";
import {
  GUEST_SAFE_MIND_REQUIREMENT,
  isGuestSafeMind,
} from "@/lib/chat/guestMind";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Params = { params: Promise<{ id: string }> };

async function channelContainsGuests(
  channelId: string,
  workspaceId: string,
): Promise<boolean> {
  const admin = createSupabaseAdminClient();
  const { data: guests, error: guestsError } = await admin
    .from("workspace_members")
    .select("user_id")
    .eq("workspace_id", workspaceId)
    .eq("role", "guest");
  if (guestsError) throw new Error(guestsError.message);
  const guestIds = (guests || []).map((guest) => String(guest.user_id));
  if (guestIds.length === 0) return false;
  const { data: member, error: memberError } = await admin
    .from("chat_channel_members")
    .select("id")
    .eq("channel_id", channelId)
    .eq("member_type", "user")
    .in("user_id", guestIds)
    .limit(1)
    .maybeSingle();
  if (memberError) throw new Error(memberError.message);
  return Boolean(member);
}

export async function GET(_req: Request, { params }: Params) {
  const { id } = await params;
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const [{ data: channel, error }, { data: members }, { data: messages }] =
    await Promise.all([
      supabase.from("chat_channels").select("*").eq("id", id).maybeSingle(),
      supabase
        .from("chat_channel_members")
        .select("id,member_type,user_id,agent_id,created_at")
        .eq("channel_id", id),
      supabase
        .from("chat_messages")
        .select("*")
        .eq("channel_id", id)
        .order("created_at", { ascending: false })
        .limit(200),
    ]);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!channel) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({
    channel,
    members: members || [],
    messages: [...(messages || [])].reverse(),
  });
}

export async function PATCH(req: Request, { params }: Params) {
  const { id } = await params;
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  const { data: existingChannel, error: channelError } = await supabase
    .from("chat_channels")
    .select("id,workspace_id,profile_id,orchestrator_mode,created_by")
    .eq("id", id)
    .maybeSingle();
  if (channelError) {
    return NextResponse.json({ error: channelError.message }, { status: 500 });
  }
  if (!existingChannel) {
    return NextResponse.json(
      { error: "Not found or not allowed" },
      { status: 404 },
    );
  }
  const { data: actorMembership, error: actorMembershipError } = await supabase
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", existingChannel.workspace_id)
    .eq("user_id", user.id)
    .maybeSingle();
  if (actorMembershipError) {
    return NextResponse.json(
      { error: actorMembershipError.message },
      { status: 500 },
    );
  }
  if (
    actorMembership?.role !== "admin" &&
    existingChannel.created_by !== user.id
  ) {
    return NextResponse.json(
      { error: "Not found or not allowed" },
      { status: 404 },
    );
  }

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (typeof body.name === "string" && body.name.trim()) {
    patch.name = body.name.trim().slice(0, 100);
  }
  if (typeof body.slug === "string" && body.slug.trim()) {
    const slug = slugifyChatChannel(body.slug);
    if (!slug) return NextResponse.json({ error: "Invalid slug" }, { status: 400 });
    patch.slug = slug;
  }
  if ("topic" in body) {
    patch.topic =
      typeof body.topic === "string" && body.topic.trim()
        ? body.topic.trim().slice(0, 500)
        : null;
  }
  if ("profileId" in body) {
    patch.profile_id =
      typeof body.profileId === "string" && body.profileId.trim()
        ? body.profileId.trim()
        : null;
  }
  if (
    body.orchestratorMode === "mention" ||
    body.orchestratorMode === "always" ||
    body.orchestratorMode === "off"
  ) {
    patch.orchestrator_mode = body.orchestratorMode;
  }
  if ("orchestratorInstructions" in body) {
    const instructions = parseChannelOrchestratorInstructions(
      body.orchestratorInstructions,
    );
    if (!instructions.ok) {
      return NextResponse.json(
        { error: instructions.error },
        { status: 400 },
      );
    }
    patch.orchestrator_instructions = instructions.value;
  }
  if (body.visibility === "workspace" || body.visibility === "private") {
    patch.visibility = body.visibility;
  }
  if (typeof body.isArchived === "boolean") patch.is_archived = body.isArchived;

  const changesMindBoundary =
    "profileId" in body ||
    body.orchestratorMode === "mention" ||
    body.orchestratorMode === "always" ||
    body.orchestratorMode === "off";
  if (changesMindBoundary) {
    const effectiveProfileId =
      "profileId" in body
        ? typeof body.profileId === "string" && body.profileId.trim()
          ? body.profileId.trim()
          : null
        : existingChannel.profile_id;
    const effectiveMode =
      body.orchestratorMode === "mention" ||
      body.orchestratorMode === "always" ||
      body.orchestratorMode === "off"
        ? body.orchestratorMode
        : existingChannel.orchestrator_mode;
    const admin = createSupabaseAdminClient();
    const { data: profile, error: profileError } = effectiveProfileId
      ? await admin
          .from("orchestrator_profiles")
          .select(
            "id,workspace_id,surface,authorization_stance,memory_scope,inherit_workspace_skills,inherit_workspace_integrations",
          )
          .eq("id", effectiveProfileId)
          .eq("workspace_id", existingChannel.workspace_id)
          .maybeSingle()
      : { data: null, error: null };
    if (profileError) {
      return NextResponse.json(
        { error: profileError.message },
        { status: 500 },
      );
    }
    if (effectiveProfileId && !profile) {
      return NextResponse.json(
        { error: "The selected Mind is unavailable in this workspace." },
        { status: 400 },
      );
    }
    let hasGuests = false;
    try {
      hasGuests = await channelContainsGuests(
        id,
        String(existingChannel.workspace_id),
      );
    } catch (guestError) {
      return NextResponse.json(
        {
          error:
            guestError instanceof Error
              ? guestError.message
              : "Could not verify channel guests",
        },
        { status: 500 },
      );
    }
    if (hasGuests && effectiveMode !== "off" && !isGuestSafeMind(profile)) {
      return NextResponse.json(
        {
          error: `${GUEST_SAFE_MIND_REQUIREMENT} Configure the selected Mind or set attention to Humans only.`,
        },
        { status: 409 },
      );
    }
  }

  const { data, error } = await supabase
    .from("chat_channels")
    .update(patch)
    .eq("id", id)
    .select("*")
    .maybeSingle();
  if (error) {
    const promptMigrationPending =
      "orchestratorInstructions" in body &&
      (error.code === "42703" ||
        error.code === "PGRST204" ||
        error.message.includes("orchestrator_instructions"));
    return NextResponse.json(
      {
        error: promptMigrationPending
          ? "Channel operating briefs are still being activated. Try again shortly."
          : error.message,
      },
      { status: error.code === "23505" ? 409 : error.code === "42501" ? 403 : 500 },
    );
  }
  if (!data) return NextResponse.json({ error: "Not found or not allowed" }, { status: 404 });
  return NextResponse.json({ channel: data });
}

export async function DELETE(_req: Request, { params }: Params) {
  const { id } = await params;
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { data, error } = await supabase
    .from("chat_channels")
    .delete()
    .eq("id", id)
    .select("id")
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ error: "Not found or not allowed" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
