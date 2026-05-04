import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { getWorkspaceMembershipForUser } from "@/lib/billing/state";
import {
  ensureWorkspaceStripeCustomer,
  getStripePublishableKey,
  getStripeServerClient,
} from "@/lib/billing/stripe";

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

  try {
    const stripe = getStripeServerClient();
    const customerId = await ensureWorkspaceStripeCustomer({
      workspaceId: membership.workspace_id,
      userId: user.id,
      userEmail: user.email || null,
    });

    const setupIntent = await stripe.setupIntents.create({
      customer: customerId,
      payment_method_types: ["card"],
      usage: "off_session",
      metadata: {
        workspace_id: membership.workspace_id,
        user_id: user.id,
      },
    });

    return NextResponse.json({
      clientSecret: setupIntent.client_secret,
      customerId,
      publishableKey: getStripePublishableKey(),
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to create SetupIntent" },
      { status: 500 }
    );
  }
}
