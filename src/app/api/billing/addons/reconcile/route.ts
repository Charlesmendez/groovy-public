import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { getWorkspaceMembershipForUser } from "@/lib/billing/state";
import {
  getWorkspaceAddonSummary,
  syncWorkspaceAddonSubscription,
} from "@/lib/billing/addons";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
    error: authErr,
  } = await supabase.auth.getUser();
  if (authErr || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const admin = createSupabaseAdminClient();
  const membership = await getWorkspaceMembershipForUser({
    userId: user.id,
    admin,
  });
  if (!membership) {
    return NextResponse.json({ error: "Workspace not found" }, { status: 404 });
  }
  if (membership.role !== "admin") {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 });
  }

  const result = await syncWorkspaceAddonSubscription({
    workspaceId: membership.workspace_id,
    userId: user.id,
    userEmail: user.email || null,
    enforcePaymentSuccess: false,
    admin,
  });

  if (!result.ok) {
    const status =
      result.reason === "card_required"
        ? 400
        : result.reason === "payment_failed"
          ? 402
          : 500;
    return NextResponse.json(
      { error: result.message, code: result.reason },
      { status }
    );
  }

  const summary = await getWorkspaceAddonSummary({
    workspaceId: membership.workspace_id,
    admin,
  });

  return NextResponse.json({
    ok: true,
    sync: result,
    summary,
  });
}
