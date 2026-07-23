import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import {
  getAuthedUser,
  getOrCreateWorkspaceForUser,
  isWorkspaceOperatorRole,
} from "@/lib/workspaces";

export async function GET() {
  try {
    const workspace = await getOrCreateWorkspaceForUser();
    if (!isWorkspaceOperatorRole(workspace.role)) {
      return NextResponse.json(
        { error: "Workspace settings are not available to channel guests" },
        { status: 403 },
      );
    }
    return NextResponse.json({ workspace });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load workspace";
    const status = message === "Unauthorized" ? 401 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}

type UpdateBody = {
  name?: string;
};

export async function POST(req: Request) {
  try {
    const user = await getAuthedUser();
    const body = (await req.json().catch(() => null)) as UpdateBody | null;
    if (!body || typeof body !== "object") {
      return NextResponse.json({ error: "Invalid request" }, { status: 400 });
    }

    const admin = createSupabaseAdminClient();
    const { data: membership, error: memberErr } = await admin
      .from("workspace_members")
      .select("workspace_id, role")
      .eq("user_id", user.id)
      .limit(1)
      .single();
    if (memberErr || !membership) {
      return NextResponse.json({ error: "Workspace not found" }, { status: 404 });
    }
    if (membership.role !== "admin") {
      return NextResponse.json({ error: "Only admins can update workspace settings" }, { status: 403 });
    }

    const updates: Record<string, unknown> = {};
    if (typeof body.name === "string" && body.name.trim()) {
      updates.name = body.name.trim();
    }
    if (Object.keys(updates).length === 0) {
      return NextResponse.json({ error: "No updates provided" }, { status: 400 });
    }

    const { data: workspace, error } = await admin
      .from("workspaces")
      .update(updates)
      .eq("id", membership.workspace_id)
      .select("id, name, billing_admin_user_id")
      .single();
    if (error || !workspace) {
      return NextResponse.json({ error: error?.message || "Failed to update workspace" }, { status: 500 });
    }
    return NextResponse.json({ workspace });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to update workspace";
    const status = message === "Unauthorized" ? 401 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
