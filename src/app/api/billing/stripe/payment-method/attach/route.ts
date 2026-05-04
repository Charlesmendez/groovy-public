import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { getWorkspaceMembershipForUser } from "@/lib/billing/state";
import { attachPaymentMethodToWorkspace } from "@/lib/billing/stripe";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = {
  paymentMethodId?: string;
};

export async function POST(req: Request) {
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

  const body = (await req.json().catch(() => null)) as Body | null;
  const paymentMethodId = body?.paymentMethodId?.trim() || "";
  if (!paymentMethodId) {
    return NextResponse.json({ error: "Missing paymentMethodId" }, { status: 400 });
  }

  try {
    const result = await attachPaymentMethodToWorkspace({
      workspaceId: membership.workspace_id,
      userId: user.id,
      userEmail: user.email || null,
      paymentMethodId,
    });
    return NextResponse.json({
      ok: true,
      customerId: result.customerId,
      paymentMethodId: result.paymentMethodId,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to attach payment method" },
      { status: 500 }
    );
  }
}
