import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { ensureWorkspaceStripeCustomer, getStripeServerClient } from "@/lib/billing/stripe";
import { getOrCreateWorkspaceIdForUser } from "@/lib/billing/workspace";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PERSONAL_PRICE_LOOKUP_KEY = "groovy_personal_yearly_usd";

async function personalPriceId(stripe: ReturnType<typeof getStripeServerClient>): Promise<string> {
  const priceId =
    process.env.STRIPE_GROOVY_PERSONAL_PRICE_ID ||
    process.env.STRIPE_PERSONAL_PRICE_ID ||
    process.env.STRIPE_PRICE_GROOVY_PERSONAL_YEARLY ||
    "";
  if (priceId.trim()) return priceId.trim();

  const prices = await stripe.prices.list({
    active: true,
    lookup_keys: [PERSONAL_PRICE_LOOKUP_KEY],
    limit: 1,
  });
  const lookupPriceId = prices.data[0]?.id;
  if (lookupPriceId) return lookupPriceId;

  throw new Error(
    `Missing STRIPE_GROOVY_PERSONAL_PRICE_ID and no active Stripe price found for lookup key ${PERSONAL_PRICE_LOOKUP_KEY}`
  );
}

function originFromReq(req: Request): string {
  const url = new URL(req.url);
  const requestOrigin = `${url.protocol}//${url.host}`;
  const configuredOrigin = process.env.NEXT_PUBLIC_APP_URL || "";
  const isLocalRequest =
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "::1";

  return (isLocalRequest ? requestOrigin : configuredOrigin || requestOrigin).replace(/\/+$/, "");
}

export async function POST(req: Request) {
  try {
    const supabase = await createSupabaseServerClient();
    const {
      data: { user },
      error: authErr,
    } = await supabase.auth.getUser();
    if (authErr || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const workspaceId = await getOrCreateWorkspaceIdForUser({
      userId: user.id,
      email: user.email || null,
    });
    if (!workspaceId) {
      return NextResponse.json({ error: "Workspace not found" }, { status: 404 });
    }

    const stripe = getStripeServerClient();
    const customerId = await ensureWorkspaceStripeCustomer({
      workspaceId,
      userId: user.id,
      userEmail: user.email || null,
    });
    const origin = originFromReq(req);
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customerId,
      line_items: [{ price: await personalPriceId(stripe), quantity: 1 }],
      allow_promotion_codes: true,
      success_url: `${origin}/account/license?checkout=success`,
      cancel_url: `${origin}/pricing?checkout=cancelled`,
      client_reference_id: user.id,
      metadata: {
        product: "groovy_personal",
        user_id: user.id,
        workspace_id: workspaceId,
      },
      subscription_data: {
        metadata: {
          product: "groovy_personal",
          user_id: user.id,
          workspace_id: workspaceId,
        },
      },
    });

    return NextResponse.json({
      ok: true,
      checkoutSessionId: session.id,
      url: session.url,
    });
  } catch (err) {
    console.error("[licenses/personal/checkout] failed", err);
    const message = err instanceof Error ? err.message : "Unable to start checkout";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
