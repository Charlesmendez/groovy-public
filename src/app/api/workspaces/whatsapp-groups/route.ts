import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { getAuthedUser } from "@/lib/workspaces";

type Body = {
  group_name?: string;
  provider?: string;
};

export async function GET() {
  try {
    const user = await getAuthedUser();
    const admin = createSupabaseAdminClient();
    const { data: membership } = await admin
      .from("workspace_members")
      .select("workspace_id, role")
      .eq("user_id", user.id)
      .limit(1)
      .single();
    if (!membership) {
      return NextResponse.json({ error: "Workspace not found" }, { status: 404 });
    }
    if (membership.role === "guest") {
      return NextResponse.json(
        { error: "Workspace settings are not available to channel guests" },
        { status: 403 },
      );
    }
    const { data, error } = await admin
      .from("workspace_whatsapp_groups")
      .select("id, group_name, provider, created_at")
      .eq("workspace_id", membership.workspace_id)
      .order("created_at", { ascending: false });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ groups: data || [] });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load groups";
    const status = message === "Unauthorized" ? 401 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}

export async function POST(req: Request) {
  try {
    const user = await getAuthedUser();
    const body = (await req.json().catch(() => null)) as Body | null;
    if (!body?.group_name) {
      return NextResponse.json({ error: "group_name required" }, { status: 400 });
    }
    const admin = createSupabaseAdminClient();
    const { data: membership } = await admin
      .from("workspace_members")
      .select("workspace_id, role")
      .eq("user_id", user.id)
      .limit(1)
      .single();
    if (!membership) {
      return NextResponse.json({ error: "Workspace not found" }, { status: 404 });
    }
    if (membership.role !== "admin") {
      return NextResponse.json({ error: "Only admins can add groups" }, { status: 403 });
    }
    const { data, error } = await admin
      .from("workspace_whatsapp_groups")
      .insert({
        workspace_id: membership.workspace_id,
        provider: body.provider || "whatsapp_web",
        group_name: body.group_name.trim(),
        created_by_user_id: user.id,
      })
      .select("id, group_name, provider, created_at")
      .single();
    if (error || !data) {
      return NextResponse.json({ error: error?.message || "Failed to add group" }, { status: 500 });
    }
    return NextResponse.json({ group: data });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to add group";
    const status = message === "Unauthorized" ? 401 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}

export async function DELETE(req: Request) {
  try {
    const user = await getAuthedUser();
    const { searchParams } = new URL(req.url);
    const id = searchParams.get("id");
    if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

    const admin = createSupabaseAdminClient();
    const { data: membership } = await admin
      .from("workspace_members")
      .select("workspace_id, role")
      .eq("user_id", user.id)
      .limit(1)
      .single();
    if (!membership) return NextResponse.json({ error: "Workspace not found" }, { status: 404 });
    if (membership.role !== "admin") {
      return NextResponse.json({ error: "Only admins can delete groups" }, { status: 403 });
    }

    await admin
      .from("workspace_whatsapp_groups")
      .delete()
      .eq("id", id)
      .eq("workspace_id", membership.workspace_id);
    return NextResponse.json({ success: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to delete group";
    const status = message === "Unauthorized" ? 401 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
