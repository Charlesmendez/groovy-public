import { NextResponse } from "next/server";
import { createHash } from "crypto";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function appBaseUrl(): string {
  const fromEnv = (process.env.NEXT_PUBLIC_APP_URL || "").trim();
  return fromEnv.replace(/\/+$/, "") || "http://localhost:3000";
}

function redirectToDashboard(status: "linked" | "invalid" | "expired" | "conflict") {
  const base = appBaseUrl();
  const path = `/dashboard?upready_link=${status}`;
  const dest = new URL(path, base).toString();
  return NextResponse.redirect(dest, 302);
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const token = (url.searchParams.get("token") || "").trim();
  if (!token) {
    return redirectToDashboard("invalid");
  }

  const admin = createSupabaseAdminClient();
  const tokenHash = hashToken(token);

  const { data: tokenRow } = await admin
    .from("upready_link_tokens")
    .select("id, flow_user_id, upready_user_id, upready_email, expires_at, consumed_at")
    .eq("token_hash", tokenHash)
    .maybeSingle();

  const row = tokenRow as
    | {
        id?: unknown;
        flow_user_id?: unknown;
        upready_user_id?: unknown;
        upready_email?: unknown;
        expires_at?: unknown;
        consumed_at?: unknown;
      }
    | null;

  const id = typeof row?.id === "string" ? row.id : "";
  const flowUserId = typeof row?.flow_user_id === "string" ? row.flow_user_id : "";
  const upreadyUserId = typeof row?.upready_user_id === "string" ? row.upready_user_id : "";
  const upreadyEmail = typeof row?.upready_email === "string" ? row.upready_email.trim().toLowerCase() : "";
  const consumedAt = typeof row?.consumed_at === "string" ? row.consumed_at : "";
  const expiresAt =
    typeof row?.expires_at === "string" && row.expires_at
      ? Date.parse(row.expires_at)
      : NaN;

  if (!id || !flowUserId || !upreadyUserId || !upreadyEmail) {
    return redirectToDashboard("invalid");
  }
  if (consumedAt) {
    return redirectToDashboard("invalid");
  }
  if (!Number.isFinite(expiresAt) || Date.now() > expiresAt) {
    return redirectToDashboard("expired");
  }

  const nowIso = new Date().toISOString();
  const { error: upsertErr } = await admin
    .from("upready_account_links")
    .upsert(
      {
        flow_user_id: flowUserId,
        upready_user_id: upreadyUserId,
        upready_email: upreadyEmail,
        verified_at: nowIso,
        updated_at: nowIso,
      },
      { onConflict: "flow_user_id" }
    );

  if (upsertErr) {
    return redirectToDashboard("conflict");
  }

  await admin
    .from("upready_link_tokens")
    .update({ consumed_at: nowIso })
    .eq("id", id);

  return redirectToDashboard("linked");
}
