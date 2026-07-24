import Link from "next/link";
import {
  ArrowUpRight,
  Hash,
  Lock,
  MessageSquareText,
  Settings2,
  Sparkles,
} from "lucide-react";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getOrCreateWorkspaceForUser } from "@/lib/workspaces";

export const dynamic = "force-dynamic";

type ChannelRow = {
  id: string;
  name: string;
  topic: string | null;
  visibility: "workspace" | "private";
  profile_id: string | null;
  orchestrator_mode: "mention" | "always" | "off";
  orchestrator_instructions: string | null;
  created_by: string;
};

export default async function SettingsChannelsPage() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const workspace = await getOrCreateWorkspaceForUser();
  const channelResult = await supabase
    .from("chat_channels")
    .select(
      "id,name,topic,visibility,profile_id,orchestrator_mode,orchestrator_instructions,created_by",
    )
    .eq("workspace_id", workspace.id)
    .eq("kind", "channel")
    .eq("is_archived", false)
    .order("name", { ascending: true });
  let channels = (channelResult.data || []) as ChannelRow[];
  if (
    channelResult.error &&
    (channelResult.error.code === "42703" ||
      channelResult.error.code === "PGRST204" ||
      channelResult.error.message.includes("orchestrator_instructions"))
  ) {
    const { data: legacyChannels } = await supabase
      .from("chat_channels")
      .select(
        "id,name,topic,visibility,profile_id,orchestrator_mode,created_by",
      )
      .eq("workspace_id", workspace.id)
      .eq("kind", "channel")
      .eq("is_archived", false)
      .order("name", { ascending: true });
    channels = (legacyChannels || []).map((channel) => ({
      ...(channel as Omit<ChannelRow, "orchestrator_instructions">),
      orchestrator_instructions: null,
    }));
  } else if (channelResult.error) {
    throw new Error(channelResult.error.message);
  }
  const profileIds = Array.from(
    new Set(
      channels
        .map((channel) => channel.profile_id)
        .filter((id): id is string => Boolean(id)),
    ),
  );
  const admin = createSupabaseAdminClient();
  const { data: profileData } = profileIds.length
    ? await admin
        .from("orchestrator_profiles")
        .select("id,name")
        .eq("workspace_id", workspace.id)
        .in("id", profileIds)
    : { data: [] };
  const profileNames = new Map(
    (profileData || []).map((profile) => [
      String(profile.id),
      String(profile.name),
    ]),
  );

  return (
    <main className="mx-auto max-w-6xl px-4 py-7 sm:px-6 sm:py-9">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="max-w-2xl">
          <p className="text-[10px] font-medium uppercase tracking-[0.18em] text-cyan-300/70">
            Workspace channels
          </p>
          <h2 className="mt-2 text-2xl font-semibold tracking-tight">
            A clear operating model for every room
          </h2>
          <p className="mt-2 text-sm leading-relaxed text-zinc-500">
            Review each channel’s Mind, attention mode, operating brief,
            participants, and capabilities in one place.
          </p>
        </div>
        <Link
          href="/chat"
          className="inline-flex w-fit items-center gap-2 rounded-xl border border-white/10 bg-white/[0.035] px-3.5 py-2.5 text-sm text-zinc-300 transition hover:border-white/20 hover:text-white"
        >
          Open Chat
          <ArrowUpRight className="h-4 w-4" />
        </Link>
      </div>

      {channels.length > 0 ? (
        <div className="mt-7 grid gap-3 md:grid-cols-2">
          {channels.map((channel) => {
            const canManage =
              workspace.role === "admin" || channel.created_by === user?.id;
            const mindName = channel.profile_id
              ? profileNames.get(channel.profile_id) || "Unavailable Mind"
              : "Groovy default";
            const attention =
              channel.orchestrator_mode === "always"
                ? "Always listening"
                : channel.orchestrator_mode === "off"
                  ? "Humans only"
                  : "@mention";
            return (
              <Link
                key={channel.id}
                href={`/chat/${channel.id}?settings=1`}
                className="group rounded-2xl border border-white/10 bg-white/[0.025] p-4 transition hover:border-cyan-400/25 hover:bg-cyan-400/[0.025] sm:p-5"
              >
                <div className="flex items-start gap-3">
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-white/10 bg-black/20 text-zinc-500 group-hover:text-cyan-300">
                    {channel.visibility === "private" ? (
                      <Lock className="h-4 w-4" />
                    ) : (
                      <Hash className="h-4 w-4" />
                    )}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <h3 className="truncate text-sm font-medium text-zinc-100">
                        {channel.name}
                      </h3>
                      {channel.visibility === "private" ? (
                        <span className="rounded-full border border-white/10 px-2 py-0.5 text-[9px] uppercase tracking-wider text-zinc-500">
                          Private
                        </span>
                      ) : null}
                    </div>
                    <p className="mt-1 line-clamp-2 min-h-8 text-xs leading-relaxed text-zinc-500">
                      {channel.topic || "No channel topic yet."}
                    </p>
                  </div>
                  <Settings2 className="h-4 w-4 shrink-0 text-zinc-700 transition group-hover:text-zinc-300" />
                </div>

                <div className="mt-4 grid grid-cols-2 gap-2">
                  <div className="rounded-xl border border-white/[0.07] bg-black/15 px-3 py-2.5">
                    <div className="flex items-center gap-1.5 text-[9px] uppercase tracking-wider text-zinc-600">
                      <Sparkles className="h-3 w-3" />
                      Mind
                    </div>
                    <div className="mt-1 truncate text-xs text-zinc-300">
                      {mindName}
                    </div>
                  </div>
                  <div className="rounded-xl border border-white/[0.07] bg-black/15 px-3 py-2.5">
                    <div className="flex items-center gap-1.5 text-[9px] uppercase tracking-wider text-zinc-600">
                      <MessageSquareText className="h-3 w-3" />
                      Attention
                    </div>
                    <div className="mt-1 truncate text-xs text-zinc-300">
                      {attention}
                    </div>
                  </div>
                </div>

                <div className="mt-3 flex items-center justify-between gap-3 border-t border-white/[0.06] pt-3 text-[10px]">
                  <span
                    className={
                      channel.orchestrator_instructions
                        ? "text-cyan-300/80"
                        : "text-zinc-600"
                    }
                  >
                    {channel.orchestrator_instructions
                      ? "Channel brief configured"
                      : "No channel brief"}
                  </span>
                  <span className="text-zinc-600">
                    {canManage ? "Configure" : "View settings"} →
                  </span>
                </div>
              </Link>
            );
          })}
        </div>
      ) : (
        <div className="mt-7 flex min-h-72 flex-col items-center justify-center rounded-2xl border border-dashed border-white/10 bg-white/[0.015] px-6 text-center">
          <span className="flex h-12 w-12 items-center justify-center rounded-2xl border border-white/10 bg-white/[0.03] text-zinc-500">
            <Hash className="h-5 w-5" />
          </span>
          <h3 className="mt-4 text-base font-medium">No channels yet</h3>
          <p className="mt-2 max-w-sm text-sm leading-relaxed text-zinc-500">
            Create a channel in Chat, then return here to manage its Mind and
            operating brief.
          </p>
          <Link
            href="/chat"
            className="mt-5 rounded-xl border border-cyan-400/25 bg-cyan-400/[0.07] px-4 py-2.5 text-sm text-cyan-200"
          >
            Create a channel
          </Link>
        </div>
      )}
    </main>
  );
}
