import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { listCellAgentOptions } from "@/lib/cells/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const supabase = await createSupabaseServerClient();
  try {
    const result = await listCellAgentOptions(supabase);
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load agent options";
    const status =
      message === "Unauthorized" ? 401 : message === "Admin access required" ? 403 : message === "Workspace not found" ? 404 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
