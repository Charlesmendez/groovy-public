import { redirect } from "next/navigation";
import { SettingsShell } from "@/components/settings/SettingsShell";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getOrCreateWorkspaceForUser } from "@/lib/workspaces";

export default async function SettingsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login?next=/settings");

  const workspace = await getOrCreateWorkspaceForUser();
  if (workspace.role === "guest") redirect("/chat");

  return <SettingsShell>{children}</SettingsShell>;
}
