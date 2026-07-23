import { UsageDashboardContent } from "@/components/usage/UsageDashboardContent";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export default async function SettingsUsagePage() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const admin = createSupabaseAdminClient();
  const { data: membership } = user
    ? await admin
        .from("workspace_members")
        .select("role")
        .eq("user_id", user.id)
        .limit(1)
        .maybeSingle()
    : { data: null };
  const canViewWorkspaceUsage = membership?.role === "admin";

  return (
    <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
      <div className="mb-5">
        <h2 className="text-xl font-semibold">Usage</h2>
        <p className="mt-1 text-sm text-zinc-500">
          Consumption across every surface that uses this workspace.
        </p>
      </div>
      {canViewWorkspaceUsage ? (
        <UsageDashboardContent />
      ) : (
        <div className="rounded-xl border border-white/10 bg-white/[0.03] p-5 text-sm text-zinc-500">
          Workspace-wide usage and cost details are available to workspace
          administrators.
        </div>
      )}
    </main>
  );
}
