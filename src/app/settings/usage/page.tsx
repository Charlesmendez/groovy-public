import { UsageDashboardContent } from "@/components/usage/UsageDashboardContent";
import { getOrCreateWorkspaceForUser } from "@/lib/workspaces";

export default async function SettingsUsagePage() {
  const workspace = await getOrCreateWorkspaceForUser();
  const canViewWorkspaceUsage = workspace.role === "admin";

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
