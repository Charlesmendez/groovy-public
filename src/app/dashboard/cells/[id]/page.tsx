import { redirect } from "next/navigation";
import { CellDetailContent } from "@/components/cells/CellDetailContent";
import { getOrCreateWorkspaceForUser } from "@/lib/workspaces";

type CellPageProps = {
  params: Promise<{ id: string }>;
};

export const dynamic = "force-dynamic";

export default async function CellPage({ params }: CellPageProps) {
  const workspace = await getOrCreateWorkspaceForUser();
  if (workspace.role !== "admin") {
    redirect("/dashboard");
  }
  const { id } = await params;
  return <CellDetailContent cellId={id} />;
}
