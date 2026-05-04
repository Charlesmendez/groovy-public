import { randomUUID } from "crypto";
import Stripe from "stripe";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { getStripeServerClient } from "@/lib/billing/stripe";
import { encryptLlmApiKey } from "@/lib/crypto/llmKey";
import {
  generateLicenseKey,
  licenseKeyHash,
  signLicensePayload,
} from "@/lib/licensing/server";

function subscriptionIdFrom(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "id" in value && typeof value.id === "string") {
    return value.id;
  }
  return "";
}

function customerIdFrom(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "id" in value && typeof value.id === "string") {
    return value.id;
  }
  return "";
}

function subscriptionIdFromInvoice(invoice: Stripe.Invoice): string {
  const raw = invoice as unknown as Record<string, unknown>;
  const direct = subscriptionIdFrom(raw.subscription);
  if (direct) return direct;
  const parent = raw.parent as Record<string, unknown> | null | undefined;
  const subscriptionDetails = parent?.subscription_details as
    | Record<string, unknown>
    | null
    | undefined;
  return subscriptionIdFrom(subscriptionDetails?.subscription);
}

function subscriptionStatusToLicenseStatus(status: string | null | undefined) {
  if (status === "active" || status === "trialing") return "active";
  if (status === "past_due" || status === "unpaid") return "past_due";
  if (status === "canceled") return "canceled";
  if (status === "incomplete_expired") return "expired";
  return "past_due";
}

async function getOrCreateOrganization(args: {
  workspaceId: string;
  userId: string;
  customerEmail?: string | null;
}) {
  const admin = createSupabaseAdminClient();
  const { data: existing } = await admin
    .from("organizations")
    .select("id")
    .eq("workspace_id", args.workspaceId)
    .maybeSingle();
  if (existing?.id) return String(existing.id);

  const { data, error } = await admin
    .from("organizations")
    .insert({
      name: args.customerEmail || "Personal Organization",
      type: "personal",
      owner_user_id: args.userId,
      workspace_id: args.workspaceId,
    })
    .select("id")
    .single();
  if (error || !data?.id) throw new Error(error?.message || "Failed to create organization");
  return String(data.id);
}

async function upsertPersonalLicenseForSubscription(args: {
  subscriptionId: string;
  stripeCustomerId: string;
  workspaceId: string;
  userId: string;
  customerEmail?: string | null;
  status: string;
  currentPeriodStartIso: string;
  currentPeriodEndIso: string;
  cancelAtPeriodEnd: boolean;
  stripePriceId?: string | null;
}) {
  const admin = createSupabaseAdminClient();
  const organizationId = await getOrCreateOrganization({
    workspaceId: args.workspaceId,
    userId: args.userId,
    customerEmail: args.customerEmail || null,
  });

  const licenseStatus = subscriptionStatusToLicenseStatus(args.status);
  const { data: existingSub } = await admin
    .from("subscriptions")
    .select("id, license_id")
    .eq("stripe_subscription_id", args.subscriptionId)
    .maybeSingle();
  const existingLicenseId =
    existingSub && typeof existingSub.license_id === "string" ? existingSub.license_id : null;

  const licenseId = existingLicenseId || randomUUID();
  const licenseKey = existingLicenseId ? null : generateLicenseKey("groovy_personal");
  const licenseRow = {
    id: licenseId,
    organization_id: organizationId,
    workspace_id: args.workspaceId,
    user_id: args.userId,
    license_type: "personal",
    status: licenseStatus,
    customer_email: args.customerEmail || null,
    customer_name: args.customerEmail || "Groovy Personal",
    license_key_hash: licenseKey ? licenseKeyHash(licenseKey) : "",
    valid_from: args.currentPeriodStartIso,
    valid_until: args.currentPeriodEndIso,
    fallback_allowed: false,
    max_devices: 2,
    max_users: 1,
    max_agents: null,
    max_environments: null,
    production_environments: null,
    production_agents: null,
    reseller_billing_enabled: false,
    token_consumption_billing_enabled: false,
    features: ["personal_downloads", "personal_updates", "source_snapshots"],
    metadata: { stripeSubscriptionId: args.subscriptionId },
  };

  if (existingLicenseId) {
    const { data: existingLicense } = await admin
      .from("licenses")
      .select("*")
      .eq("id", existingLicenseId)
      .maybeSingle();
    const merged = {
      ...(existingLicense as Record<string, unknown> | null),
      ...licenseRow,
      license_key_hash:
        typeof (existingLicense as Record<string, unknown> | null)?.license_key_hash === "string"
          ? String((existingLicense as Record<string, unknown>).license_key_hash)
          : licenseRow.license_key_hash,
    };
    const signed = signLicensePayload(merged);
    const { error } = await admin
      .from("licenses")
      .update({
        status: licenseStatus,
        valid_from: args.currentPeriodStartIso,
        valid_until: args.currentPeriodEndIso,
        signed_license_payload: signed,
        updated_at: new Date().toISOString(),
      })
      .eq("id", existingLicenseId);
    if (error) throw new Error(error.message);
  } else {
    const signed = signLicensePayload(licenseRow);
    const { error } = await admin.from("licenses").insert({
      ...licenseRow,
      license_key_enc: licenseKey ? encryptLlmApiKey(licenseKey) : null,
      signed_license_payload: signed,
    });
    if (error) throw new Error(error.message);
  }

  const { error: subErr } = await admin.from("subscriptions").upsert(
    {
      id: existingSub?.id || randomUUID(),
      organization_id: organizationId,
      license_id: licenseId,
      workspace_id: args.workspaceId,
      stripe_customer_id: args.stripeCustomerId,
      stripe_subscription_id: args.subscriptionId,
      stripe_price_id: args.stripePriceId || null,
      status: args.status,
      current_period_start: args.currentPeriodStartIso,
      current_period_end: args.currentPeriodEndIso,
      cancel_at_period_end: args.cancelAtPeriodEnd,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "stripe_subscription_id" }
  );
  if (subErr) throw new Error(subErr.message);
}

export async function handlePersonalCheckoutCompleted(session: Stripe.Checkout.Session) {
  const metadata = session.metadata || {};
  if (metadata.product !== "groovy_personal") return;
  const subscriptionId = subscriptionIdFrom(session.subscription);
  const workspaceId = (metadata.workspace_id || "").trim();
  const userId = (metadata.user_id || session.client_reference_id || "").trim();
  if (!subscriptionId || !workspaceId || !userId) return;

  const stripe = getStripeServerClient();
  const subscription = await stripe.subscriptions.retrieve(subscriptionId);
  await handlePersonalSubscriptionChanged(subscription, {
    customerEmail: session.customer_details?.email || session.customer_email || null,
  });
}

export async function handlePersonalSubscriptionChanged(
  subscription: Stripe.Subscription,
  options: { customerEmail?: string | null } = {}
) {
  const metadata = subscription.metadata || {};
  if (metadata.product !== "groovy_personal") return;
  const workspaceId = (metadata.workspace_id || "").trim();
  const userId = (metadata.user_id || "").trim();
  if (!workspaceId || !userId) return;
  const sub = subscription as unknown as Record<string, unknown>;
  const currentPeriodStart = Number(sub.current_period_start || 0);
  const currentPeriodEnd = Number(sub.current_period_end || 0);
  const priceId = subscription.items.data[0]?.price?.id || null;

  await upsertPersonalLicenseForSubscription({
    subscriptionId: subscription.id,
    stripeCustomerId: customerIdFrom(subscription.customer),
    workspaceId,
    userId,
    customerEmail: options.customerEmail || null,
    status: subscription.status,
    currentPeriodStartIso: new Date((currentPeriodStart || Date.now() / 1000) * 1000).toISOString(),
    currentPeriodEndIso: new Date((currentPeriodEnd || Date.now() / 1000) * 1000).toISOString(),
    cancelAtPeriodEnd: subscription.cancel_at_period_end || false,
    stripePriceId: priceId,
  });
}

export async function handlePersonalInvoicePaid(invoice: Stripe.Invoice) {
  const subscriptionId = subscriptionIdFromInvoice(invoice);
  if (!subscriptionId) return;
  const stripe = getStripeServerClient();
  const subscription = await stripe.subscriptions.retrieve(subscriptionId);
  await handlePersonalSubscriptionChanged(subscription);
}

export async function handlePersonalChargeRefunded(charge: Stripe.Charge) {
  const amount = typeof charge.amount === "number" ? charge.amount : 0;
  const refunded = typeof charge.amount_refunded === "number" ? charge.amount_refunded : 0;
  if (amount <= 0 || refunded < amount) return;

  const invoiceId = subscriptionIdFrom((charge as unknown as Record<string, unknown>).invoice);
  if (!invoiceId) return;

  const stripe = getStripeServerClient();
  const invoice = await stripe.invoices.retrieve(invoiceId);
  const subscriptionId = subscriptionIdFromInvoice(invoice);
  if (!subscriptionId) return;

  const admin = createSupabaseAdminClient();
  const { data: subscription } = await admin
    .from("subscriptions")
    .select("license_id, organization_id")
    .eq("stripe_subscription_id", subscriptionId)
    .maybeSingle();
  const licenseId =
    subscription && typeof subscription.license_id === "string" ? subscription.license_id : "";
  if (!licenseId) return;

  const { data: license } = await admin.from("licenses").select("*").eq("id", licenseId).maybeSingle();
  if (!license) return;
  const nextLicense = {
    ...(license as Record<string, unknown>),
    status: "suspended",
    metadata: {
      ...(((license as Record<string, unknown>).metadata as Record<string, unknown> | null) || {}),
      suspendedReason: "stripe_charge_refunded",
      stripeChargeId: charge.id,
    },
  };
  const signed = signLicensePayload(nextLicense);

  await admin
    .from("licenses")
    .update({
      status: "suspended",
      signed_license_payload: signed,
      metadata: nextLicense.metadata,
      updated_at: new Date().toISOString(),
    })
    .eq("id", licenseId);

  await admin.from("license_admin_audit_events").insert({
    organization_id:
      subscription && typeof subscription.organization_id === "string"
        ? subscription.organization_id
        : null,
    license_id: licenseId,
    action: "license.suspended.full_refund",
    payload: {
      stripeChargeId: charge.id,
      amount,
      amountRefunded: refunded,
    },
  });
}
