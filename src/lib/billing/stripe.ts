import Stripe from "stripe";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { splitTopupBreakdown } from "@/lib/billing/pricing";

let cachedStripe: Stripe | null = null;

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || !v.trim()) throw new Error(`Missing ${name}`);
  return v.trim();
}

export function getStripeServerClient(): Stripe {
  if (cachedStripe) return cachedStripe;
  const apiKey = requireEnv("STRIPE_SECRET_KEY");
  cachedStripe = new Stripe(apiKey);
  return cachedStripe;
}

export function getStripePublishableKey(): string {
  return requireEnv("NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY");
}

type WorkspaceStripeRow = {
  id: string;
  name: string;
  stripe_customer_id: string | null;
  stripe_default_payment_method_id: string | null;
};

async function getWorkspaceStripeRow(workspaceId: string): Promise<WorkspaceStripeRow> {
  const admin = createSupabaseAdminClient();
  const { data, error } = await admin
    .from("workspaces")
    .select("id, name, stripe_customer_id, stripe_default_payment_method_id")
    .eq("id", workspaceId)
    .maybeSingle();
  if (error || !data) {
    throw new Error(error?.message || "Workspace not found");
  }
  return data as WorkspaceStripeRow;
}

export async function ensureWorkspaceStripeCustomer(args: {
  workspaceId: string;
  userId: string;
  userEmail?: string | null;
}): Promise<string> {
  const admin = createSupabaseAdminClient();
  const row = await getWorkspaceStripeRow(args.workspaceId);
  const existing = row.stripe_customer_id?.trim();
  if (existing) return existing;

  const stripe = getStripeServerClient();
  const customer = await stripe.customers.create({
    email: args.userEmail || undefined,
    name: row.name || undefined,
    metadata: {
      workspace_id: args.workspaceId,
      user_id: args.userId,
    },
  });

  const { error: updateErr } = await admin
    .from("workspaces")
    .update({
      stripe_customer_id: customer.id,
      billing_updated_at: new Date().toISOString(),
    })
    .eq("id", args.workspaceId);
  if (updateErr) throw new Error(updateErr.message);
  return customer.id;
}

function toDefaultPaymentMethodId(
  value: string | Stripe.PaymentMethod | null | undefined
): string | null {
  if (!value) return null;
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "object" && value && "id" in value && typeof value.id === "string" && value.id.trim()) {
    return value.id.trim();
  }
  return null;
}

function toPaymentIntentId(
  value: string | Stripe.PaymentIntent | null | undefined
): string | null {
  if (!value) return null;
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "object" && value && "id" in value && typeof value.id === "string" && value.id.trim()) {
    return value.id.trim();
  }
  return null;
}

export async function ensureWorkspaceDefaultPaymentMethod(args: {
  workspaceId: string;
  userId: string;
  userEmail?: string | null;
}): Promise<{ customerId: string; paymentMethodId: string | null }> {
  const admin = createSupabaseAdminClient();
  const row = await getWorkspaceStripeRow(args.workspaceId);
  const customerId = row.stripe_customer_id?.trim()
    ? row.stripe_customer_id.trim()
    : await ensureWorkspaceStripeCustomer({
        workspaceId: args.workspaceId,
        userId: args.userId,
        userEmail: args.userEmail,
      });

  if (row.stripe_default_payment_method_id?.trim()) {
    return {
      customerId,
      paymentMethodId: row.stripe_default_payment_method_id.trim(),
    };
  }

  const stripe = getStripeServerClient();
  const customer = await stripe.customers.retrieve(customerId);
  if (!customer || customer.deleted) return { customerId, paymentMethodId: null };
  const pmId = toDefaultPaymentMethodId(customer.invoice_settings?.default_payment_method);
  if (!pmId) return { customerId, paymentMethodId: null };

  await admin
    .from("workspaces")
    .update({
      stripe_default_payment_method_id: pmId,
      billing_updated_at: new Date().toISOString(),
    })
    .eq("id", args.workspaceId);

  return { customerId, paymentMethodId: pmId };
}

export async function attachPaymentMethodToWorkspace(args: {
  workspaceId: string;
  userId: string;
  userEmail?: string | null;
  paymentMethodId: string;
}): Promise<{ customerId: string; paymentMethodId: string }> {
  const paymentMethodId = args.paymentMethodId.trim();
  if (!paymentMethodId) throw new Error("Missing paymentMethodId");

  const customerId = await ensureWorkspaceStripeCustomer({
    workspaceId: args.workspaceId,
    userId: args.userId,
    userEmail: args.userEmail,
  });

  const stripe = getStripeServerClient();
  try {
    await stripe.paymentMethods.attach(paymentMethodId, { customer: customerId });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!message.toLowerCase().includes("already attached")) throw err;
  }

  await stripe.customers.update(customerId, {
    invoice_settings: {
      default_payment_method: paymentMethodId,
    },
  });

  const admin = createSupabaseAdminClient();
  const { error } = await admin
    .from("workspaces")
    .update({
      stripe_customer_id: customerId,
      stripe_default_payment_method_id: paymentMethodId,
      billing_updated_at: new Date().toISOString(),
    })
    .eq("id", args.workspaceId);
  if (error) throw new Error(error.message);

  return { customerId, paymentMethodId };
}

export type TopupChargeKind = "manual_topup" | "auto_topup";

export type TopupInvoiceResult =
  | {
      ok: true;
      invoiceId: string;
      invoiceStatus: string;
      paymentIntentId: string | null;
      amountUsd: number;
      modelCostUsd: number;
      groovyFeeUsd: number;
      feeRateBps: number;
      customerId: string;
      paymentMethodId: string;
    }
  | {
      ok: false;
      reason: "card_required" | "payment_failed" | "stripe_error";
      message: string;
      invoiceId?: string;
      invoiceStatus?: string;
    };

export async function createAndPayTopupInvoice(args: {
  workspaceId: string;
  userId: string;
  userEmail?: string | null;
  amountUsd: number;
  kind: TopupChargeKind;
  idempotencyKey: string;
  source: string;
}): Promise<TopupInvoiceResult> {
  const breakdown = splitTopupBreakdown(args.amountUsd);
  if (!breakdown) {
    return { ok: false, reason: "stripe_error", message: "Invalid topup amount" };
  }

  const stripe = getStripeServerClient();
  const { customerId, paymentMethodId } = await ensureWorkspaceDefaultPaymentMethod({
    workspaceId: args.workspaceId,
    userId: args.userId,
    userEmail: args.userEmail,
  });
  if (!paymentMethodId) {
    return { ok: false, reason: "card_required", message: "No default payment method on file" };
  }

  const metadata = {
    workspace_id: args.workspaceId,
    user_id: args.userId,
    billing_kind: args.kind,
    billing_source: args.source,
    billing_idempotency_key: args.idempotencyKey,
    fee_rate_bps: String(breakdown.feeRateBps),
    model_cost_usd: breakdown.modelCostUsd.toFixed(2),
    groovy_fee_usd: breakdown.groovyFeeUsd.toFixed(2),
  };

  try {
    // Create the invoice first, then attach invoice items directly to it.
    // This avoids relying on pending customer invoice items behavior.
    const invoice = await stripe.invoices.create(
      {
        customer: customerId,
        currency: "usd",
        collection_method: "charge_automatically",
        auto_advance: false,
        metadata,
      },
      { idempotencyKey: `${args.idempotencyKey}:invoice` }
    );

    await stripe.invoiceItems.create(
      {
        invoice: invoice.id,
        customer: customerId,
        currency: "usd",
        amount: breakdown.modelCostCents,
        description: "Groovy usage wallet funds",
        metadata,
      },
      { idempotencyKey: `${args.idempotencyKey}:item:model` }
    );

    await stripe.invoiceItems.create(
      {
        invoice: invoice.id,
        customer: customerId,
        currency: "usd",
        amount: breakdown.groovyFeeCents,
        description: "Groovy platform fee allocation",
        metadata,
      },
      { idempotencyKey: `${args.idempotencyKey}:item:fee` }
    );

    const finalized = await stripe.invoices.finalizeInvoice(invoice.id, {}, { idempotencyKey: `${args.idempotencyKey}:finalize` });

    // With collection_method: "charge_automatically", Stripe may auto-charge
    // the invoice upon finalization. The explicit pay() call can then fail with
    // "Invoice is already paid". Handle that gracefully.
    let paid: Stripe.Invoice;
    try {
      paid = await stripe.invoices.pay(
        finalized.id,
        { off_session: true },
        { idempotencyKey: `${args.idempotencyKey}:pay` }
      );
    } catch (payErr) {
      const msg = payErr instanceof Error ? payErr.message : String(payErr);
      if (msg.toLowerCase().includes("invoice is already paid")) {
        // Invoice was auto-charged on finalization — retrieve it.
        paid = await stripe.invoices.retrieve(finalized.id, {
          expand: ["payment_intent"],
        });
      } else {
        throw payErr;
      }
    }

    if (paid.status !== "paid") {
      return {
        ok: false,
        reason: "payment_failed",
        message: `Invoice not paid: ${paid.status}`,
        invoiceId: paid.id,
        invoiceStatus: paid.status || "unknown",
      };
    }

    // Safety guard: never grant wallet credits for a zero-line-item invoice.
    // (This can happen if invoice items weren't attached correctly.)
    if ((paid.subtotal || 0) <= 0) {
      return {
        ok: false,
        reason: "payment_failed",
        message: "Invoice subtotal is 0; refusing to grant topup credits",
        invoiceId: paid.id,
        invoiceStatus: paid.status || "unknown",
      };
    }

    return {
      ok: true,
      invoiceId: paid.id,
      invoiceStatus: paid.status,
      amountUsd: breakdown.amountUsd,
      modelCostUsd: breakdown.modelCostUsd,
      groovyFeeUsd: breakdown.groovyFeeUsd,
      feeRateBps: breakdown.feeRateBps,
      customerId,
      paymentMethodId,
      paymentIntentId: toPaymentIntentId(
        (paid as unknown as { payment_intent?: string | Stripe.PaymentIntent | null }).payment_intent
      ),
    };
  } catch (err) {
    return {
      ok: false,
      reason: "stripe_error",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}
