import {
  PushNotificationSettings,
  type NotificationRoom,
} from "@/components/notifications/PushNotificationSettings";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getOrCreateWorkspaceForUser } from "@/lib/workspaces";

export const dynamic = "force-dynamic";

export default async function SettingsNotificationsPage() {
  const supabase = await createSupabaseServerClient();
  const workspace = await getOrCreateWorkspaceForUser();
  const { data, error } = await supabase
    .from("chat_channels")
    .select("id,kind,name,topic,visibility")
    .eq("workspace_id", workspace.id)
    .eq("is_archived", false)
    .order("kind", { ascending: true })
    .order("name", { ascending: true });
  if (error) throw new Error(error.message);
  const rooms = (data || []).map((room) => ({
    id: String(room.id),
    kind: room.kind === "dm" ? "dm" : "channel",
    name: String(room.name),
    topic: typeof room.topic === "string" ? room.topic : null,
    visibility: room.visibility === "private" ? "private" : "workspace",
  })) satisfies NotificationRoom[];

  return <PushNotificationSettings rooms={rooms} />;
}
