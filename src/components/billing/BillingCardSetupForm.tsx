"use client";

import { useMemo, useState } from "react";
import { Elements, CardElement, useElements, useStripe } from "@stripe/react-stripe-js";
import { loadStripe } from "@stripe/stripe-js";
import { Loader2 } from "lucide-react";

type BillingCardSetupFormProps = {
  publishableKey: string;
  clientSecret: string;
  onSuccess: () => Promise<void> | void;
  onCancel?: () => void;
  onError: (message: string) => void;
};

function CardSetupInner(props: BillingCardSetupFormProps) {
  const stripe = useStripe();
  const elements = useElements();
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (saving) return;
    if (!stripe || !elements) return;
    const card = elements.getElement(CardElement);
    if (!card) {
      props.onError("Card form is not ready yet.");
      return;
    }

    setSaving(true);
    props.onError("");
    try {
      const confirm = await stripe.confirmCardSetup(props.clientSecret, {
        payment_method: {
          card,
        },
      });
      if (confirm.error) {
        props.onError(confirm.error.message || "Failed to confirm card setup.");
        return;
      }
      const paymentMethod = confirm.setupIntent?.payment_method;
      const paymentMethodId =
        typeof paymentMethod === "string"
          ? paymentMethod
          : paymentMethod && typeof paymentMethod === "object" && "id" in paymentMethod
            ? paymentMethod.id
            : "";
      if (!paymentMethodId) {
        props.onError("Card setup completed but payment method is missing.");
        return;
      }

      const attachRes = await fetch("/api/billing/stripe/payment-method/attach", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paymentMethodId }),
      });
      const attachJson = await attachRes.json().catch(() => ({}));
      if (!attachRes.ok) {
        props.onError(
          typeof attachJson?.error === "string"
            ? attachJson.error
            : "Failed to attach payment method."
        );
        return;
      }
      await props.onSuccess();
    } catch (err) {
      props.onError(err instanceof Error ? err.message : "Card setup failed.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-white/10 bg-black/30 p-3">
        <CardElement
          options={{
            style: {
              base: {
                color: "#f4f4f5",
                iconColor: "#a1a1aa",
                fontSize: "14px",
                "::placeholder": {
                  color: "#71717a",
                },
              },
              invalid: {
                color: "#fca5a5",
                iconColor: "#fca5a5",
              },
            },
          }}
        />
      </div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={submit}
          disabled={saving || !stripe || !elements}
          className="px-4 py-2 rounded-lg bg-cyan-500/20 border border-cyan-500/30 text-cyan-200 text-sm disabled:opacity-50 inline-flex items-center gap-2"
        >
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
          Save card
        </button>
        {props.onCancel ? (
          <button
            type="button"
            onClick={props.onCancel}
            disabled={saving}
            className="px-4 py-2 rounded-lg bg-white/5 border border-white/10 text-zinc-300 text-sm disabled:opacity-50"
          >
            Cancel
          </button>
        ) : null}
      </div>
    </div>
  );
}

export function BillingCardSetupForm(props: BillingCardSetupFormProps) {
  const stripePromise = useMemo(() => loadStripe(props.publishableKey), [props.publishableKey]);
  return (
    <Elements
      stripe={stripePromise}
      options={{
        clientSecret: props.clientSecret,
        appearance: {
          theme: "night",
        },
      }}
    >
      <CardSetupInner {...props} />
    </Elements>
  );
}
