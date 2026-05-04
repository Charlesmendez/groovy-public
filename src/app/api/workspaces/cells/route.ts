import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createCell, listCells } from "@/lib/cells/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const supabase = await createSupabaseServerClient();
  try {
    const url = new URL(req.url);
    const result = await listCells(supabase, url.searchParams);
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load cells";
    const status =
      message === "Unauthorized" ? 401 : message === "Admin access required" ? 403 : message === "Workspace not found" ? 404 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}

export async function POST(req: Request) {
  const supabase = await createSupabaseServerClient();
  try {
    const body = (await req.json().catch(() => null)) as
      | {
          agentId?: unknown;
          name?: unknown;
          objective?: unknown;
          memberUserIds?: unknown;
        }
      | null;

    const agentId = typeof body?.agentId === "string" ? body.agentId.trim() : "";
    const name = typeof body?.name === "string" ? body.name.trim() : "";
    const objective = typeof body?.objective === "string" ? body.objective.trim() : "";
    const memberUserIds = Array.isArray(body?.memberUserIds)
      ? body.memberUserIds.map((id) => String(id || "").trim()).filter(Boolean)
      : [];

    if (!agentId || !name || !objective || memberUserIds.length === 0) {
      return NextResponse.json(
        { error: "agentId, name, objective, and at least one memberUserId are required" },
        { status: 400 }
      );
    }

    const result = await createCell(supabase, {
      agentId,
      name,
      objective,
      memberUserIds,
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to create cell";
    const status =
      message === "Unauthorized" ? 401 : message === "Admin access required" ? 403 : message.includes("required") ? 400 : message === "Workspace not found" ? 404 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
