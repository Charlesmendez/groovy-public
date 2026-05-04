import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getCellDetail, updateCell } from "@/lib/cells/service";

type RouteParams = { params: Promise<{ id: string }> };

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: RouteParams) {
  const supabase = await createSupabaseServerClient();
  const { id } = await params;
  try {
    const url = new URL(req.url);
    const detail = await getCellDetail(supabase, id, url.searchParams);
    return NextResponse.json({ cell: detail });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load cell";
    const status =
      message === "Unauthorized" ? 401 : message === "Admin access required" ? 403 : message === "Cell not found" || message === "Workspace not found" ? 404 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}

export async function PATCH(req: Request, { params }: RouteParams) {
  const supabase = await createSupabaseServerClient();
  const { id } = await params;
  try {
    const body = (await req.json().catch(() => null)) as
      | {
          name?: unknown;
          objective?: unknown;
          status?: unknown;
          memberUserIds?: unknown;
          regenerateFramework?: unknown;
          keyResults?: unknown;
        }
      | null;

    const status =
      body?.status === "active" || body?.status === "paused" || body?.status === "archived"
        ? body.status
        : undefined;

    const memberUserIds = Array.isArray(body?.memberUserIds)
      ? body.memberUserIds.map((memberId) => String(memberId || "").trim()).filter(Boolean)
      : undefined;

    const keyResults = Array.isArray(body?.keyResults)
      ? body.keyResults
          .map((item) => {
            const entry = item && typeof item === "object" ? (item as Record<string, unknown>) : null;
            if (!entry) return null;
            const label = typeof entry.label === "string" ? entry.label.trim() : "";
            const measurementMode: "computed" | "hybrid" | "manual" | null =
              entry.measurementMode === "computed" ||
              entry.measurementMode === "hybrid" ||
              entry.measurementMode === "manual"
                ? entry.measurementMode
                : null;
            const direction: "increase" | "decrease" | "maintain" | "binary" | null =
              entry.direction === "increase" ||
              entry.direction === "decrease" ||
              entry.direction === "maintain" ||
              entry.direction === "binary"
                ? entry.direction
                : null;
            if (!label || !measurementMode || !direction) return null;
            return {
              id: typeof entry.id === "string" ? entry.id.trim() : undefined,
              label,
              description: typeof entry.description === "string" ? entry.description.trim() : null,
              measurementMode,
              evaluationMethod:
                typeof entry.evaluationMethod === "string" ? entry.evaluationMethod.trim() : null,
              targetValue: typeof entry.targetValue === "string" ? entry.targetValue.trim() : null,
              direction,
            };
          })
          .filter((item): item is NonNullable<typeof item> => !!item)
      : undefined;

    const result = await updateCell(supabase, id, {
      name: typeof body?.name === "string" ? body.name.trim() : undefined,
      objective: typeof body?.objective === "string" ? body.objective.trim() : undefined,
      status,
      memberUserIds,
      regenerateFramework: body?.regenerateFramework === true,
      keyResults,
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to update cell";
    const responseStatus =
      message === "Unauthorized" ? 401 : message === "Admin access required" ? 403 : message === "Cell not found" || message === "Workspace not found" ? 404 : message.includes("required") ? 400 : 500;
    return NextResponse.json({ error: message }, { status: responseStatus });
  }
}
