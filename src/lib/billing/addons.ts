import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import {
  ensureWorkspaceDefaultPaymentMethod,
  ensureWorkspaceStripeCustomer,
  getStripeServerClient,
} from "@/lib/billing/stripe";
import {
  GROOVY_MAC_MIN_SEATS,
  GROOVY_MAC_SEAT_PRICE_USD,
  KAPSO_ALLOWLIST_PRICE_USD,
} from "@/lib/billing/pricing";
export {
  GROOVY_MAC_MIN_SEATS,
  GROOVY_MAC_SEAT_PRICE_USD,
  KAPSO_ALLOWLIST_PRICE_USD,
} from "@/lib/billing/pricing";

type WorkspaceAddonRow = {
  id: string;
  stripe_customer_id: string | null;
  stripe_default_payment_method_id: string | null;
  stripe_subscription_id: string | null;
  stripe_subscription_status: string | null;
  stripe_item_groovy_mac_id: string | null;
  stripe_item_kapso_allowlist_id: string | null;
  billing_groovy_mac_enabled: boolean;
  billing_kapso_enabled: boolean;
};

export type WorkspaceAddonQuantities = {
  memberCount: number;
  groovyMacSeats: number;
  kapsoAllowlistCount: number;
};

export type WorkspaceAddonSummary = {
  groovyMacEnabled: boolean;
  kapsoEnabled: boolean;
  memberCount: number;
  groovyMacSeats: number;
  kapsoAllowlistCount: number;
  groovyMacMonthlyUsd: number;
  kapsoMonthlyUsd: number;
  recurringMonthlyUsd: number;
};

export type AddonSyncFailureReason =
  | "card_required"
  | "payment_failed"
  | "stripe_error";

export type AddonSyncResult =
  | {
      ok: true;
      customerId: string | null;
      subscriptionId: string | null;
      subscriptionStatus: string | null;
      groovyMacEnabled: boolean;
      kapsoEnabled: boolean;
      groovyMacSeats: number;
      kapsoAllowlistCount: number;
      recurringMonthlyUsd: number;
    }
  | {
      ok: false;
      reason: AddonSyncFailureReason;
      message: string;
    };

function toCount(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

function readEnv(name: string): string {
  const value = process.env[name];
  if (!value || !value.trim()) throw new Error(`Missing ${name}`);
  return value.trim();
}

async function getWorkspaceAddonRow(args: {
  workspaceId: string;
  admin?: SupabaseClient;
}): Promise<WorkspaceAddonRow> {
  const admin = args.admin || createSupabaseAdminClient();
  const { data, error } = await admin
    .from("workspaces")
    .select(
      [
        "id",
        "stripe_customer_id",
        "stripe_default_payment_method_id",
        "stripe_subscription_id",
        "stripe_subscription_status",
        "stripe_item_groovy_mac_id",
        "stripe_item_kapso_allowlist_id",
        "billing_groovy_mac_enabled",
        "billing_kapso_enabled",
      ].join(",")
    )
    .eq("id", args.workspaceId)
    .maybeSingle();
  if (error || !data) {
    throw new Error(error?.message || "Workspace not found");
  }
  const row = data as unknown as Record<string, unknown>;
  return {
    id: String(row.id || ""),
    stripe_customer_id:
      typeof row.stripe_customer_id === "string" ? row.stripe_customer_id : null,
    stripe_default_payment_method_id:
      typeof row.stripe_default_payment_method_id === "string"
        ? row.stripe_default_payment_method_id
        : null,
    stripe_subscription_id:
      typeof row.stripe_subscription_id === "string"
        ? row.stripe_subscription_id
        : null,
    stripe_subscription_status:
      typeof row.stripe_subscription_status === "string"
        ? row.stripe_subscription_status
        : null,
    stripe_item_groovy_mac_id:
      typeof row.stripe_item_groovy_mac_id === "string"
        ? row.stripe_item_groovy_mac_id
        : null,
    stripe_item_kapso_allowlist_id:
      typeof row.stripe_item_kapso_allowlist_id === "string"
        ? row.stripe_item_kapso_allowlist_id
        : null,
    billing_groovy_mac_enabled: row.billing_groovy_mac_enabled === true,
    billing_kapso_enabled: row.billing_kapso_enabled === true,
  };
}

async function countRows(args: {
  table: "workspace_members" | "workspace_whatsapp_allowlist";
  workspaceId: string;
  admin?: SupabaseClient;
}): Promise<number> {
  const admin = args.admin || createSupabaseAdminClient();
  const { count, error } = await admin
    .from(args.table)
    .select("workspace_id", { count: "exact", head: true })
    .eq("workspace_id", args.workspaceId);
  if (error) throw new Error(error.message);
  return toCount(count);
}

function findSubscriptionItemByPrice(
  subscription: Stripe.Subscription,
  priceId: string
): Stripe.SubscriptionItem | null {
  for (const item of subscription.items.data) {
    const currentPriceId = item?.price?.id;
    if (typeof currentPriceId === "string" && currentPriceId === priceId) {
      return item;
    }
  }
  return null;
}

async function retrieveSubscriptionSafe(args: {
  stripe: Stripe;
  subscriptionId: string;
}): Promise<Stripe.Subscription | null> {
  try {
    const sub = await args.stripe.subscriptions.retrieve(args.subscriptionId, {
      expand: ["items.data.price", "latest_invoice.payment_intent"],
    });
    if (sub.status === "canceled" || sub.status === "incomplete_expired") {
      return null;
    }
    return sub;
  } catch {
    return null;
  }
}

function isLikelyPaymentFailure(err: unknown): boolean {
  const e = err as {
    type?: unknown;
    code?: unknown;
    message?: unknown;
    raw?: { code?: unknown; decline_code?: unknown; type?: unknown };
  };
  const haystack = [
    typeof e.type === "string" ? e.type : "",
    typeof e.code === "string" ? e.code : "",
    typeof e.message === "string" ? e.message : "",
    typeof e.raw?.type === "string" ? e.raw.type : "",
    typeof e.raw?.code === "string" ? e.raw.code : "",
    typeof e.raw?.decline_code === "string" ? e.raw.decline_code : "",
  ]
    .join(" ")
    .toLowerCase();
  return /(card|payment|declin|insufficient|expired|authentication|invoice)/.test(
    haystack
  );
}

function stripeErrorMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  return "Stripe billing operation failed";
}

function supportsPaidStatus(status: string | null): boolean {
  return status === "active" || status === "trialing";
}

export async function getWorkspaceAddonQuantities(args: {
  workspaceId: string;
  admin?: SupabaseClient;
}): Promise<WorkspaceAddonQuantities> {
  const admin = args.admin || createSupabaseAdminClient();
  const memberCount = await countRows({
    table: "workspace_members",
    workspaceId: args.workspaceId,
    admin,
  });
  const kapsoAllowlistCount = await countRows({
    table: "workspace_whatsapp_allowlist",
    workspaceId: args.workspaceId,
    admin,
  });
  return {
    memberCount,
    groovyMacSeats: Math.max(GROOVY_MAC_MIN_SEATS, memberCount),
    kapsoAllowlistCount,
  };
}

export async function getWorkspaceAddonSummary(args: {
  workspaceId: string;
  admin?: SupabaseClient;
}): Promise<WorkspaceAddonSummary> {
  const admin = args.admin || createSupabaseAdminClient();
  const row = await getWorkspaceAddonRow({
    workspaceId: args.workspaceId,
    admin,
  });
  const counts = await getWorkspaceAddonQuantities({
    workspaceId: args.workspaceId,
    admin,
  });
  const groovyMacEnabled = row.billing_groovy_mac_enabled === true;
  const kapsoEnabled = row.billing_kapso_enabled === true;
  const groovyMacMonthlyUsd = groovyMacEnabled
    ? counts.groovyMacSeats * GROOVY_MAC_SEAT_PRICE_USD
    : 0;
  const kapsoMonthlyUsd = kapsoEnabled
    ? counts.kapsoAllowlistCount * KAPSO_ALLOWLIST_PRICE_USD
    : 0;
  return {
    groovyMacEnabled,
    kapsoEnabled,
    memberCount: counts.memberCount,
    groovyMacSeats: counts.groovyMacSeats,
    kapsoAllowlistCount: counts.kapsoAllowlistCount,
    groovyMacMonthlyUsd,
    kapsoMonthlyUsd,
    recurringMonthlyUsd: groovyMacMonthlyUsd + kapsoMonthlyUsd,
  };
}

export async function syncWorkspaceAddonSubscription(args: {
  workspaceId: string;
  userId: string;
  userEmail?: string | null;
  enableGroovyMac?: boolean;
  enableKapsoAllowlist?: boolean;
  enforcePaymentSuccess?: boolean;
  admin?: SupabaseClient;
}): Promise<AddonSyncResult> {
  const admin = args.admin || createSupabaseAdminClient();
  const enforcePaymentSuccess = args.enforcePaymentSuccess !== false;

  const row = await getWorkspaceAddonRow({
    workspaceId: args.workspaceId,
    admin,
  });
  const counts = await getWorkspaceAddonQuantities({
    workspaceId: args.workspaceId,
    admin,
  });

  const groovyMacEnabled =
    typeof args.enableGroovyMac === "boolean"
      ? args.enableGroovyMac
      : row.billing_groovy_mac_enabled;
  const kapsoEnabled =
    typeof args.enableKapsoAllowlist === "boolean"
      ? args.enableKapsoAllowlist
      : row.billing_kapso_enabled;

  const desiredGroovyQty = groovyMacEnabled ? counts.groovyMacSeats : 0;
  const desiredKapsoQty = kapsoEnabled ? counts.kapsoAllowlistCount : 0;

  const nowIso = new Date().toISOString();
  const recurringMonthlyUsd =
    desiredGroovyQty * GROOVY_MAC_SEAT_PRICE_USD +
    desiredKapsoQty * KAPSO_ALLOWLIST_PRICE_USD;

  let customerId = row.stripe_customer_id?.trim() || null;
  let paymentMethodId = row.stripe_default_payment_method_id?.trim() || null;

  const stripe = getStripeServerClient();
  const existingSubscriptionId = row.stripe_subscription_id?.trim() || "";
  let subscription = existingSubscriptionId
    ? await retrieveSubscriptionSafe({
        stripe,
        subscriptionId: existingSubscriptionId,
      })
    : null;

  // If nothing is enabled and no subscription exists, persist flags and exit fast.
  if (!groovyMacEnabled && !kapsoEnabled && !subscription) {
    const { error: updateErr } = await admin
      .from("workspaces")
      .update({
        billing_groovy_mac_enabled: false,
        billing_kapso_enabled: false,
        billing_addons_updated_at: nowIso,
        billing_updated_at: nowIso,
      })
      .eq("id", args.workspaceId);
    if (updateErr) {
      return {
        ok: false,
        reason: "stripe_error",
        message: updateErr.message,
      };
    }
    return {
      ok: true,
      customerId,
      subscriptionId: null,
      subscriptionStatus: null,
      groovyMacEnabled,
      kapsoEnabled,
      groovyMacSeats: desiredGroovyQty,
      kapsoAllowlistCount: desiredKapsoQty,
      recurringMonthlyUsd,
    };
  }

  if (!customerId) {
    customerId = await ensureWorkspaceStripeCustomer({
      workspaceId: args.workspaceId,
      userId: args.userId,
      userEmail: args.userEmail || null,
    });
  }
  const pmResult = await ensureWorkspaceDefaultPaymentMethod({
    workspaceId: args.workspaceId,
    userId: args.userId,
    userEmail: args.userEmail || null,
  });
  if (!pmResult.paymentMethodId) {
    return {
      ok: false,
      reason: "card_required",
      message: "No default payment method on file",
    };
  }
  customerId = pmResult.customerId || customerId;
  paymentMethodId = pmResult.paymentMethodId;

  const groovyPriceId = readEnv("STRIPE_PRICE_GROOVY_MAC_SEAT_MONTHLY");
  const kapsoPriceId = readEnv("STRIPE_PRICE_KAPSO_ALLOWLIST_MONTHLY");

  try {
    if (!subscription && (desiredGroovyQty > 0 || desiredKapsoQty > 0)) {
      const items: Stripe.SubscriptionCreateParams.Item[] = [];
      if (desiredGroovyQty > 0) {
        items.push({ price: groovyPriceId, quantity: desiredGroovyQty });
      }
      if (desiredKapsoQty > 0) {
        items.push({ price: kapsoPriceId, quantity: desiredKapsoQty });
      }
      subscription = await stripe.subscriptions.create({
        customer: customerId || undefined,
        default_payment_method: paymentMethodId,
        collection_method: "charge_automatically",
        payment_behavior: enforcePaymentSuccess
          ? "error_if_incomplete"
          : "allow_incomplete",
        items,
        metadata: {
          workspace_id: args.workspaceId,
          billing_kind: "workspace_addons",
        },
        expand: ["items.data.price", "latest_invoice.payment_intent"],
      });
    } else if (subscription) {
      const existingGroovyItem = findSubscriptionItemByPrice(
        subscription,
        groovyPriceId
      );
      const existingKapsoItem = findSubscriptionItemByPrice(
        subscription,
        kapsoPriceId
      );
      const nonAddonItemCount = subscription.items.data.filter((item) => {
        const priceId = item?.price?.id;
        if (typeof priceId !== "string") return true;
        return priceId !== groovyPriceId && priceId !== kapsoPriceId;
      }).length;

      if (
        desiredGroovyQty === 0 &&
        desiredKapsoQty === 0 &&
        nonAddonItemCount === 0 &&
        (existingGroovyItem || existingKapsoItem)
      ) {
        await stripe.subscriptions.cancel(subscription.id, { prorate: true });
        subscription = null;
      } else {
        const items: Stripe.SubscriptionUpdateParams.Item[] = [];
        if (existingGroovyItem?.id) {
          if (desiredGroovyQty > 0) {
            items.push({ id: existingGroovyItem.id, quantity: desiredGroovyQty });
          } else {
            items.push({ id: existingGroovyItem.id, deleted: true });
          }
        } else if (desiredGroovyQty > 0) {
          items.push({ price: groovyPriceId, quantity: desiredGroovyQty });
        }

        if (existingKapsoItem?.id) {
          if (desiredKapsoQty > 0) {
            items.push({ id: existingKapsoItem.id, quantity: desiredKapsoQty });
          } else {
            items.push({ id: existingKapsoItem.id, deleted: true });
          }
        } else if (desiredKapsoQty > 0) {
          items.push({ price: kapsoPriceId, quantity: desiredKapsoQty });
        }

        if (items.length > 0) {
          subscription = await stripe.subscriptions.update(subscription.id, {
            default_payment_method: paymentMethodId,
            items,
            proration_behavior: "always_invoice",
            payment_behavior: enforcePaymentSuccess
              ? "error_if_incomplete"
              : "allow_incomplete",
            metadata: {
              workspace_id: args.workspaceId,
              billing_kind: "workspace_addons",
            },
            expand: ["items.data.price", "latest_invoice.payment_intent"],
          });
        }
      }
    }
  } catch (err) {
    return {
      ok: false,
      reason: isLikelyPaymentFailure(err) ? "payment_failed" : "stripe_error",
      message: stripeErrorMessage(err),
    };
  }

  if (
    enforcePaymentSuccess &&
    (desiredGroovyQty > 0 || desiredKapsoQty > 0) &&
    !subscription
  ) {
    return {
      ok: false,
      reason: "payment_failed",
      message: "Subscription is not active yet",
    };
  }
  if (
    enforcePaymentSuccess &&
    subscription &&
    !supportsPaidStatus(subscription.status)
  ) {
    return {
      ok: false,
      reason: "payment_failed",
      message: `Subscription payment is not complete (${subscription.status})`,
    };
  }

  const nextGroovyItem =
    subscription && desiredGroovyQty > 0
      ? findSubscriptionItemByPrice(subscription, groovyPriceId)
      : null;
  const nextKapsoItem =
    subscription && desiredKapsoQty > 0
      ? findSubscriptionItemByPrice(subscription, kapsoPriceId)
      : null;

  const { error: updateErr } = await admin
    .from("workspaces")
    .update({
      stripe_customer_id: customerId,
      stripe_default_payment_method_id: paymentMethodId,
      stripe_subscription_id: subscription?.id || null,
      stripe_subscription_status: subscription?.status || null,
      stripe_item_groovy_mac_id: nextGroovyItem?.id || null,
      stripe_item_kapso_allowlist_id: nextKapsoItem?.id || null,
      billing_groovy_mac_enabled: groovyMacEnabled,
      billing_kapso_enabled: kapsoEnabled,
      billing_addons_updated_at: nowIso,
      billing_updated_at: nowIso,
    })
    .eq("id", args.workspaceId);

  if (updateErr) {
    return {
      ok: false,
      reason: "stripe_error",
      message: updateErr.message,
    };
  }

  return {
    ok: true,
    customerId,
    subscriptionId: subscription?.id || null,
    subscriptionStatus: subscription?.status || null,
    groovyMacEnabled,
    kapsoEnabled,
    groovyMacSeats: desiredGroovyQty,
    kapsoAllowlistCount: desiredKapsoQty,
    recurringMonthlyUsd,
  };
}

export async function syncWorkspaceAddonSubscriptionBestEffort(args: {
  workspaceId: string;
  userId: string;
  userEmail?: string | null;
  admin?: SupabaseClient;
  context: string;
}): Promise<void> {
  try {
    const result = await syncWorkspaceAddonSubscription({
      workspaceId: args.workspaceId,
      userId: args.userId,
      userEmail: args.userEmail || null,
      admin: args.admin,
      enforcePaymentSuccess: false,
    });
    if (!result.ok) {
      console.warn("[billing:addons] best-effort sync failed", {
        context: args.context,
        workspaceId: args.workspaceId,
        reason: result.reason,
        message: result.message,
      });
    }
  } catch (err) {
    console.warn("[billing:addons] best-effort sync error", {
      context: args.context,
      workspaceId: args.workspaceId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
