import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { socialSchemaUnavailable } from "@/lib/chat/social";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };
const EMPTY_HUDDLE_RECLAIM_MS = 15_000;

function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  );
}

function huddleError(error: {
  code?: string | null;
  message: string;
}) {
  const pending = socialSchemaUnavailable(error);
  return NextResponse.json(
    {
      error: pending
        ? "Huddles are still being activated. Try again shortly."
        : error.message,
    },
    {
      status: pending
        ? 503
        : error.code === "42501"
          ? 403
          : error.code === "P0001" || error.code === "23505"
            ? 409
            : 500,
    },
  );
}

async function loadActiveHuddle(
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>,
  channelId: string,
) {
  const { data: huddle, error } = await supabase
    .from("chat_huddles")
    .select(
      "id,channel_id,started_by,status,title,started_at,ended_at,updated_at",
    )
    .eq("channel_id", channelId)
    .eq("status", "active")
    .maybeSingle();
  if (error) return { huddle: null, participants: [], error };
  if (!huddle) return { huddle: null, participants: [], error: null };
  const { data: participants, error: participantsError } = await supabase
    .from("chat_huddle_participants")
    .select(
      "huddle_id,channel_id,user_id,muted,camera_on,screen_sharing,joined_at,left_at,updated_at",
    )
    .eq("huddle_id", huddle.id)
    .is("left_at", null)
    .order("joined_at", { ascending: true });
  return {
    huddle,
    participants: participants || [],
    error: participantsError,
  };
}

export async function GET(_req: Request, { params }: Params) {
  const { id } = await params;
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const result = await loadActiveHuddle(supabase, id);
  if (result.error) return huddleError(result.error);
  return NextResponse.json(result);
}

export async function POST(req: Request, { params }: Params) {
  const { id } = await params;
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const body = (await req.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  const action =
    body?.action === "start" ||
    body?.action === "join" ||
    body?.action === "update" ||
    body?.action === "leave" ||
    body?.action === "end"
      ? body.action
      : null;
  if (!action) {
    return NextResponse.json(
      { error: "Choose a huddle action" },
      { status: 400 },
    );
  }
  const requestBody = body ?? {};

  const { data: channel, error: channelError } = await supabase
    .from("chat_channels")
    .select("id,name,is_archived")
    .eq("id", id)
    .maybeSingle();
  if (channelError) {
    return NextResponse.json({ error: channelError.message }, { status: 500 });
  }
  if (!channel) {
    return NextResponse.json({ error: "Channel not found" }, { status: 404 });
  }
  if (
    channel.is_archived &&
    (action === "start" || action === "join")
  ) {
    return NextResponse.json(
      { error: "Archived channels cannot start huddles" },
      { status: 409 },
    );
  }

  let active = await loadActiveHuddle(supabase, id);
  if (active.error) return huddleError(active.error);
  if (
    action === "start" &&
    active.huddle &&
    active.participants.length === 0 &&
    Date.now() - Date.parse(active.huddle.updated_at) >=
      EMPTY_HUDDLE_RECLAIM_MS
  ) {
    const staleHuddleId = active.huddle.id;
    const endedAt = new Date().toISOString();
    const admin = createSupabaseAdminClient();
    const { data: endedHuddle, error: endError } = await admin
      .from("chat_huddles")
      .update({
        status: "ended",
        ended_at: endedAt,
        updated_at: endedAt,
      })
      .eq("id", staleHuddleId)
      .eq("status", "active")
      .select("id")
      .maybeSingle();
    if (endError) return huddleError(endError);
    if (endedHuddle) {
      await admin
        .from("chat_huddle_signals")
        .delete()
        .eq("huddle_id", staleHuddleId);
      await admin.from("chat_messages").insert({
        channel_id: id,
        author_type: "system",
        content: "Huddle ended.",
        metadata: {
          huddle_event: "ended",
          huddle_id: staleHuddleId,
          reason: "empty",
        },
      });
      active = { huddle: null, participants: [], error: null };
    } else {
      active = await loadActiveHuddle(supabase, id);
      if (active.error) return huddleError(active.error);
    }
  }
  if (action === "start" && !active.huddle) {
    const now = new Date().toISOString();
    const { data, error } = await supabase
      .from("chat_huddles")
      .insert({
        channel_id: id,
        started_by: user.id,
        status: "active",
        title:
          typeof requestBody.title === "string" && requestBody.title.trim()
            ? requestBody.title.trim().slice(0, 120)
            : null,
        updated_at: now,
      })
      .select(
        "id,channel_id,started_by,status,title,started_at,ended_at,updated_at",
      )
      .single();
    if (error) {
      if (error.code !== "23505") return huddleError(error);
      active = await loadActiveHuddle(supabase, id);
      if (active.error) return huddleError(active.error);
    } else {
      active = { huddle: data, participants: [], error: null };
      const speaker =
        (typeof user.user_metadata?.full_name === "string" &&
          user.user_metadata.full_name.trim()) ||
        (typeof user.user_metadata?.name === "string" &&
          user.user_metadata.name.trim()) ||
        user.email?.split("@")[0] ||
        "A teammate";
      const admin = createSupabaseAdminClient();
      await admin.from("chat_messages").insert({
        channel_id: id,
        author_type: "system",
        content: `${speaker} started a huddle.`,
        metadata: {
          huddle_event: "started",
          huddle_id: data.id,
          started_by: user.id,
        },
      });
    }
  }

  const huddleId =
    isUuid(requestBody.huddleId) && active.huddle?.id === requestBody.huddleId
      ? requestBody.huddleId
      : active.huddle?.id;
  if (!huddleId || !active.huddle) {
    return NextResponse.json(
      { error: "There is no active huddle in this channel" },
      { status: 409 },
    );
  }

  if (action === "end") {
    if (active.huddle.started_by !== user.id) {
      return NextResponse.json(
        { error: "Only the teammate who started this huddle can end it" },
        { status: 403 },
      );
    }
    const endedAt = new Date().toISOString();
    const { error } = await supabase
      .from("chat_huddles")
      .update({
        status: "ended",
        ended_at: endedAt,
        updated_at: endedAt,
      })
      .eq("id", huddleId)
      .eq("status", "active");
    if (error) return huddleError(error);
    const admin = createSupabaseAdminClient();
    await admin
      .from("chat_huddle_participants")
      .update({
        left_at: endedAt,
        muted: true,
        camera_on: false,
        screen_sharing: false,
        updated_at: endedAt,
      })
      .eq("huddle_id", huddleId)
      .is("left_at", null);
    await admin
      .from("chat_huddle_signals")
      .delete()
      .eq("huddle_id", huddleId);
    await admin.from("chat_messages").insert({
      channel_id: id,
      author_type: "system",
      content: "Huddle ended.",
      metadata: { huddle_event: "ended", huddle_id: huddleId },
    });
    return NextResponse.json({ ended: true });
  }

  if (action === "leave") {
    const leftAt = new Date().toISOString();
    const { error } = await supabase
      .from("chat_huddle_participants")
      .update({
        left_at: leftAt,
        muted: true,
        camera_on: false,
        screen_sharing: false,
        updated_at: leftAt,
      })
      .eq("huddle_id", huddleId)
      .eq("user_id", user.id);
    if (error) return huddleError(error);
    const admin = createSupabaseAdminClient();
    await admin
      .from("chat_huddle_signals")
      .delete()
      .eq("huddle_id", huddleId)
      .or(`sender_user_id.eq.${user.id},recipient_user_id.eq.${user.id}`);
    const { count: remainingParticipants, error: countError } = await admin
      .from("chat_huddle_participants")
      .select("user_id", { count: "exact", head: true })
      .eq("huddle_id", huddleId)
      .is("left_at", null);
    if (countError) return huddleError(countError);
    let ended = false;
    if ((remainingParticipants || 0) === 0) {
      const { data: endedHuddle, error: endError } = await admin
        .from("chat_huddles")
        .update({
          status: "ended",
          ended_at: leftAt,
          updated_at: leftAt,
        })
        .eq("id", huddleId)
        .eq("status", "active")
        .select("id")
        .maybeSingle();
      if (endError) return huddleError(endError);
      ended = Boolean(endedHuddle);
      if (ended) {
        await admin
          .from("chat_huddle_signals")
          .delete()
          .eq("huddle_id", huddleId);
        await admin.from("chat_messages").insert({
          channel_id: id,
          author_type: "system",
          content: "Huddle ended.",
          metadata: {
            huddle_event: "ended",
            huddle_id: huddleId,
            reason: "empty",
          },
        });
      }
    }
    return NextResponse.json({ left: true, ended });
  }

  if (
    action === "update" &&
    !active.participants.some(
      (participant) =>
        participant.user_id === user.id && participant.left_at === null,
    )
  ) {
    return NextResponse.json(
      { error: "Join this huddle before changing its controls" },
      { status: 409 },
    );
  }

  const now = new Date().toISOString();
  const participant = {
    huddle_id: huddleId,
    channel_id: id,
    user_id: user.id,
    muted: typeof requestBody.muted === "boolean" ? requestBody.muted : true,
    camera_on:
      typeof requestBody.cameraOn === "boolean" ? requestBody.cameraOn : false,
    screen_sharing:
      typeof requestBody.screenSharing === "boolean"
        ? requestBody.screenSharing
        : false,
    left_at: null,
    updated_at: now,
    ...(action === "join" || action === "start" ? { joined_at: now } : {}),
  };
  const { data, error } = await supabase
    .from("chat_huddle_participants")
    .upsert(participant, { onConflict: "huddle_id,user_id" })
    .select(
      "huddle_id,channel_id,user_id,muted,camera_on,screen_sharing,joined_at,left_at,updated_at",
    )
    .single();
  if (error) return huddleError(error);
  const refreshed = await loadActiveHuddle(supabase, id);
  if (refreshed.error) return huddleError(refreshed.error);
  if (!refreshed.huddle) {
    const leftAt = new Date().toISOString();
    const admin = createSupabaseAdminClient();
    await admin
      .from("chat_huddle_participants")
      .update({
        left_at: leftAt,
        muted: true,
        camera_on: false,
        screen_sharing: false,
        updated_at: leftAt,
      })
      .eq("huddle_id", huddleId)
      .eq("user_id", user.id)
      .is("left_at", null);
    return NextResponse.json(
      { error: "This huddle just ended. Start a new one." },
      { status: 409 },
    );
  }
  return NextResponse.json({
    huddle: refreshed.huddle,
    participant: data,
    participants: refreshed.participants,
  });
}
