import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { FREE_TRIAL_DAYS, startFreeTrial } from "@/lib/licensing/access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const trial = await startFreeTrial({
      userId: user.id,
      admin: createSupabaseAdminClient(),
    });
    return NextResponse.json({
      ok: trial.status === "active",
      accessStatus: trial.status === "active" ? "trial" : "expired",
      hasAccess: trial.status === "active",
      trial: { ...trial, durationDays: FREE_TRIAL_DAYS },
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not start free trial" },
      { status: 400 }
    );
  }
}
