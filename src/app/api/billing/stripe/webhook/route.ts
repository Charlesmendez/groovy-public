import Stripe from "stripe";
import { NextResponse } from "next/server";
import { getStripeServerClient } from "@/lib/billing/stripe";
import {
  handleTopupInvoiceFailed,
  handleTopupInvoicePaid,
} from "@/lib/billing/stripeTopupWebhook";
import {
  handlePersonalChargeRefunded,
  handlePersonalCheckoutCompleted,
  handlePersonalInvoicePaid,
  handlePersonalSubscriptionChanged,
} from "@/lib/licensing/stripePersonal";
import { isSelfHosted } from "@/lib/config/edition";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function handleEvent(event: Stripe.Event) {
  if (event.type === "invoice.payment_succeeded") {
    const invoice = event.data.object as Stripe.Invoice;
    await Promise.all([handlePersonalInvoicePaid(invoice), handleTopupInvoicePaid(invoice)]);
    return;
  }
  if (event.type === "invoice.payment_failed") {
    await handleTopupInvoiceFailed(event.data.object as Stripe.Invoice);
    return;
  }
  if (event.type === "charge.refunded") {
    await handlePersonalChargeRefunded(event.data.object as Stripe.Charge);
    return;
  }
  if (event.type === "checkout.session.completed") {
    await handlePersonalCheckoutCompleted(event.data.object as Stripe.Checkout.Session);
    return;
  }
  if (
    event.type === "customer.subscription.created" ||
    event.type === "customer.subscription.updated" ||
    event.type === "customer.subscription.deleted"
  ) {
    await handlePersonalSubscriptionChanged(event.data.object as Stripe.Subscription);
  }
}

export async function POST(req: Request) {
  if (isSelfHosted()) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const signature = (req.headers.get("stripe-signature") || "").trim();
  const webhookSecret = (process.env.STRIPE_WEBHOOK_SECRET || "").trim();
  if (!webhookSecret) {
    return NextResponse.json({ error: "Missing STRIPE_WEBHOOK_SECRET" }, { status: 500 });
  }
  if (!signature) {
    return NextResponse.json({ error: "Missing stripe-signature" }, { status: 400 });
  }

  const stripe = getStripeServerClient();
  const rawBody = await req.text();
  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Invalid signature" },
      { status: 400 }
    );
  }

  try {
    await handleEvent(event);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Webhook handling failed" },
      { status: 500 }
    );
  }

  return NextResponse.json({ received: true });
}
