import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import {
  loadBranchControllerSettings,
  normalizeBranchControllerSettings,
  saveBranchControllerSettings,
} from "@/lib/orchestrator/branchController";

export async function GET() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
    error: userErr,
  } = await supabase.auth.getUser();
  if (userErr || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const settings = await loadBranchControllerSettings(supabase, user.id);
  return NextResponse.json({ settings });
}

type PostBody = {
  maxBranches?: number;
  maxTurnsPerBranch?: number;
  mode?: "read_only" | "read_write";
};

export async function POST(req: Request) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
    error: userErr,
  } = await supabase.auth.getUser();
  if (userErr || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const body = (await req.json().catch(() => null)) as PostBody | null;
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }
  const normalized = normalizeBranchControllerSettings(body);
  const saved = await saveBranchControllerSettings({
    supabase,
    userId: user.id,
    settings: normalized,
  });
  return NextResponse.json({ ok: true, settings: saved });
}
