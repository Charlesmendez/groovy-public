import { redirect } from "next/navigation";
import { CellsDashboardContent } from "@/components/cells/CellsDashboardContent";
import { getOrCreateWorkspaceForUser } from "@/lib/workspaces";

export const dynamic = "force-dynamic";

export default async function CellsPage() {
  const workspace = await getOrCreateWorkspaceForUser();
  if (workspace.role !== "admin") {
    redirect("/dashboard");
  }
  return <CellsDashboardContent />;
}
