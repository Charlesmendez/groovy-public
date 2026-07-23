import { NextResponse } from "next/server";
import { createHash, randomUUID } from "crypto";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { findUpreadyUserByEmail } from "@/lib/upready/client";
import { getConfiguredAppUrl } from "@/lib/config/appConfig";

type LinkBody = {
  email?: unknown;
};

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function safeOrigin(): string {
  const fromEnv = getConfiguredAppUrl() || "";
  return fromEnv.replace(/\/+$/, "");
}

function isLikelyEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

async function sendUpreadyLinkEmail(params: {
  toEmail: string;
  confirmUrl: string;
}) {
  const apiKey = (process.env.SENDGRID_API_KEY || "").trim();
  const fromEmail = (process.env.SENDGRID_FROM_EMAIL || "").trim();
  if (!apiKey || !fromEmail) {
    return {
      ok: false as const,
      error: "SendGrid not configured (missing SENDGRID_API_KEY or SENDGRID_FROM_EMAIL)",
    };
  }

  const htmlEsc = (value: string) =>
    value
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");

  const subject = "Confirm your Upready link to Groovy";
  const text = `Confirm your Upready account link to Groovy:\n\n${params.confirmUrl}\n\nThis link expires in 15 minutes.`;
  const html = `<div style="font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif;">
  <p>Confirm your Upready account link to Groovy.</p>
  <p><a href="${htmlEsc(params.confirmUrl)}">Confirm Upready Link</a></p>
  <p style="font-size:12px;color:#666;">This link expires in 15 minutes.</p>
</div>`;

  const res = await fetch("https://api.sendgrid.com/v3/mail/send", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: params.toEmail }], subject }],
      from: { email: fromEmail, name: "Groovy" },
      content: [
        { type: "text/plain", value: text },
        { type: "text/html", value: html },
      ],
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    return {
      ok: false as const,
      error: `SendGrid error (${res.status}): ${errText || "unknown"}`,
    };
  }

  return { ok: true as const };
}

export async function GET() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
    error: authErr,
  } = await supabase.auth.getUser();
  if (authErr || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const admin = createSupabaseAdminClient();
  const { data: link } = await admin
    .from("upready_account_links")
    .select("upready_user_id, upready_email, verified_at, updated_at")
    .eq("flow_user_id", user.id)
    .maybeSingle();

  const row = link as
    | {
        upready_user_id?: unknown;
        upready_email?: unknown;
        verified_at?: unknown;
        updated_at?: unknown;
      }
    | null;

  const upreadyUserId =
    typeof row?.upready_user_id === "string" && row.upready_user_id.trim()
      ? row.upready_user_id.trim()
      : null;
  const upreadyEmail =
    typeof row?.upready_email === "string" && row.upready_email.trim()
      ? normalizeEmail(row.upready_email)
      : null;
  const verifiedAt =
    typeof row?.verified_at === "string" && row.verified_at.trim()
      ? row.verified_at.trim()
      : null;
  const updatedAt =
    typeof row?.updated_at === "string" && row.updated_at.trim()
      ? row.updated_at.trim()
      : null;

  const connected = !!(upreadyUserId && upreadyEmail && verifiedAt);

  return NextResponse.json({
    connected,
    link: connected
      ? {
          upreadyUserId,
          upreadyEmail,
          verifiedAt,
          updatedAt,
        }
      : null,
  });
}

export async function POST(req: Request) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
    error: authErr,
  } = await supabase.auth.getUser();
  if (authErr || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await req.json().catch(() => null)) as LinkBody | null;
  const emailRaw = typeof body?.email === "string" ? body.email : "";
  const email = normalizeEmail(emailRaw);
  if (!email || !isLikelyEmail(email)) {
    return NextResponse.json({ error: "Valid email is required" }, { status: 400 });
  }
  const currentUserEmail = normalizeEmail(user.email || "");
  if (!currentUserEmail || email !== currentUserEmail) {
    return NextResponse.json(
      { error: "Upready link email must match your Groovy account email." },
      { status: 403 }
    );
  }

  let upreadyUser: { upreadyUserId: string; email: string } | null = null;
  try {
    upreadyUser = await findUpreadyUserByEmail(email);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed to query Upready account" },
      { status: 502 }
    );
  }

  if (!upreadyUser) {
    return NextResponse.json(
      { error: "No Upready account found for this email." },
      { status: 404 }
    );
  }

  const token = randomUUID();
  const tokenHash = hashToken(token);
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const expiresAtIso = new Date(now + 15 * 60_000).toISOString();

  const admin = createSupabaseAdminClient();
  await admin
    .from("upready_link_tokens")
    .delete()
    .eq("flow_user_id", user.id)
    .is("consumed_at", null);

  const { error: insertErr } = await admin.from("upready_link_tokens").insert({
    flow_user_id: user.id,
    upready_user_id: upreadyUser.upreadyUserId,
    upready_email: upreadyUser.email,
    token_hash: tokenHash,
    expires_at: expiresAtIso,
    created_at: nowIso,
  });

  if (insertErr) {
    return NextResponse.json(
      { error: insertErr.message || "Failed to create confirmation token" },
      { status: 500 }
    );
  }

  const origin = safeOrigin();
  if (!origin) {
    return NextResponse.json(
      { error: "Missing app origin configuration for confirmation URL" },
      { status: 500 }
    );
  }
  const confirmPath = `/api/upready/link/confirm?token=${encodeURIComponent(token)}`;
  const confirmUrl = `${origin}${confirmPath}`;

  const sendResult = await sendUpreadyLinkEmail({
    toEmail: upreadyUser.email,
    confirmUrl,
  });

  if (!sendResult.ok) {
    return NextResponse.json(
      { error: sendResult.error || "Failed to send confirmation email" },
      { status: 502 }
    );
  }

  return NextResponse.json({
    ok: true,
    emailSent: true,
    message: `Confirmation email sent to ${upreadyUser.email}.`,
  });
}

export async function DELETE() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
    error: authErr,
  } = await supabase.auth.getUser();
  if (authErr || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const admin = createSupabaseAdminClient();
  await admin.from("upready_link_tokens").delete().eq("flow_user_id", user.id);
  const { error } = await admin
    .from("upready_account_links")
    .delete()
    .eq("flow_user_id", user.id);

  if (error) {
    return NextResponse.json({ error: error.message || "Failed to disconnect" }, { status: 500 });
  }

  return NextResponse.json({ ok: true, disconnected: true });
}
