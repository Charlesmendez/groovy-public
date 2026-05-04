import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getStripeServerClient } from "@/lib/billing/stripe";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function originFromReq(req: Request): string {
  const url = new URL(req.url);
  return (process.env.NEXT_PUBLIC_APP_URL || `${url.protocol}//${url.host}`).replace(/\/+$/, "");
}

export async function POST(req: Request) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
    error: authErr,
  } = await supabase.auth.getUser();
  if (authErr || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createSupabaseAdminClient();
  const { data: personalLicense, error: licenseErr } = await admin
    .from("licenses")
    .select("id")
    .eq("user_id", user.id)
    .eq("license_type", "personal")
    .order("valid_until", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (licenseErr) return NextResponse.json({ error: licenseErr.message }, { status: 500 });

  const personalLicenseId =
    typeof personalLicense?.id === "string" ? personalLicense.id.trim() : "";
  if (!personalLicenseId) {
    return NextResponse.json({ error: "No personal license found for this account" }, { status: 404 });
  }

  const { data: subscription, error } = await admin
    .from("subscriptions")
    .select("stripe_customer_id")
    .eq("license_id", personalLicenseId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const customerId =
    typeof subscription?.stripe_customer_id === "string"
      ? subscription.stripe_customer_id.trim()
      : "";
  if (!customerId) {
    return NextResponse.json({ error: "No Stripe customer found for this account" }, { status: 404 });
  }

  const stripe = getStripeServerClient();
  const session = await stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: `${originFromReq(req)}/account/billing`,
  });

  return NextResponse.json({ ok: true, url: session.url });
}
