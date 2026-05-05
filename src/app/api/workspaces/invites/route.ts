import { NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { getAuthedUser } from "@/lib/workspaces";

function safeOrigin() {
  const o = process.env.NEXT_PUBLIC_APP_URL || "";
  return String(o || "").replace(/\/+$/, "");
}

async function sendSendgridInviteEmail(params: {
  toEmail: string;
  inviteUrl: string;
  workspaceName: string;
  inviterEmail: string | null;
}) {
  const apiKey = process.env.SENDGRID_API_KEY || "";
  const fromEmail = process.env.SENDGRID_FROM_EMAIL || "";
  if (!apiKey || !fromEmail) {
    return { ok: false, error: "SendGrid not configured (missing SENDGRID_API_KEY or SENDGRID_FROM_EMAIL)" };
  }

  const subject = `You're invited to ${params.workspaceName} on Groovy`;
  const inviterLine = params.inviterEmail ? `Invited by: ${params.inviterEmail}\n\n` : "";
  const text = `${inviterLine}Join workspace: ${params.workspaceName}\n\nAccept invite:\n${params.inviteUrl}\n\nIf you don't have an account yet, sign up first with this email, then reopen the invite link.\n`;

  const htmlEsc = (s: string) =>
    s
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");

  const html = `<div style="font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif;">
  <p>${params.inviterEmail ? `Invited by: <b>${htmlEsc(params.inviterEmail)}</b>` : "You're invited"}.</p>
  <p>Join workspace: <b>${htmlEsc(params.workspaceName)}</b></p>
  <p><a href="${htmlEsc(params.inviteUrl)}">Accept invite</a></p>
  <p style="color:#666;font-size:12px;">If you don't have an account yet, sign up first with this email, then reopen the invite link.</p>
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
    return { ok: false, error: `SendGrid error (${res.status}): ${errText || "unknown"}` };
  }
  return { ok: true as const };
}

export async function GET() {
  try {
    const user = await getAuthedUser();
    const admin = createSupabaseAdminClient();

    const { data: membership, error: memberErr } = await admin
      .from("workspace_members")
      .select("workspace_id, role")
      .eq("user_id", user.id)
      .limit(1)
      .single();
    if (memberErr || !membership) {
      return NextResponse.json({ error: "Workspace not found" }, { status: 404 });
    }
    if (membership.role !== "admin") {
      return NextResponse.json({ error: "Only admins can view invites" }, { status: 403 });
    }

    const { data: invites, error } = await admin
      .from("workspace_invites")
      .select("id, email, token, expires_at, created_at")
      .eq("workspace_id", membership.workspace_id)
      .order("created_at", { ascending: false });
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    return NextResponse.json({ invites: invites || [] });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load invites";
    const status = message === "Unauthorized" ? 401 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}

type InviteBody = {
  email?: string;
};

export async function POST(req: Request) {
  try {
    const user = await getAuthedUser();
    const body = (await req.json().catch(() => null)) as InviteBody | null;
    if (!body || typeof body.email !== "string" || !body.email.trim()) {
      return NextResponse.json({ error: "Invalid email" }, { status: 400 });
    }

    const admin = createSupabaseAdminClient();
    const { data: membership, error: memberErr } = await admin
      .from("workspace_members")
      .select("workspace_id, role")
      .eq("user_id", user.id)
      .limit(1)
      .single();
    if (memberErr || !membership) {
      return NextResponse.json({ error: "Workspace not found" }, { status: 404 });
    }
    if (membership.role !== "admin") {
      return NextResponse.json({ error: "Only admins can invite" }, { status: 403 });
    }

    const { data: ws } = await admin
      .from("workspaces")
      .select("id, name")
      .eq("id", membership.workspace_id)
      .single();
    const workspaceName = ws?.name ? String(ws.name) : "Workspace";

    const token = randomUUID();
    const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 7).toISOString();

    const { data: invite, error } = await admin
      .from("workspace_invites")
      .insert({
        workspace_id: membership.workspace_id,
        email: body.email.trim().toLowerCase(),
        token,
        expires_at: expiresAt,
      })
      .select("id, email, token, expires_at, created_at")
      .single();
    if (error || !invite) {
      return NextResponse.json({ error: error?.message || "Failed to create invite" }, { status: 500 });
    }

    const origin = safeOrigin();
    const inviteUrl = origin ? `${origin}/invite/${invite.token}` : `/invite/${invite.token}`;

    let emailSent = false;
    let emailError: string | null = null;
    try {
      const emailRes = await sendSendgridInviteEmail({
        toEmail: String(invite.email),
        inviteUrl,
        workspaceName,
        inviterEmail: user.email || null,
      });
      emailSent = emailRes.ok === true;
      emailError = emailSent ? null : (emailRes as { error?: string }).error || "Failed to send";
    } catch (e) {
      emailSent = false;
      emailError = e instanceof Error ? e.message : "Failed to send";
    }

    return NextResponse.json({ invite, inviteUrl, emailSent, emailError });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to create invite";
    const status = message === "Unauthorized" ? 401 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
