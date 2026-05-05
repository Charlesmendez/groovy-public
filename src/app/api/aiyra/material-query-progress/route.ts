import { createHmac, timingSafeEqual } from "crypto";
import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { verifyRelayDeviceToken } from "@/lib/relay/deviceToken";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type MaterialQueryClaimRow = {
  request_fingerprint: string | null;
  trace_id: string | null;
  status: string | null;
  response_text: string | null;
  error_text: string | null;
  updated_at: string | null;
  expires_at: string | null;
};

type PollTokenPayload = {
  conversationId: string;
  requestFingerprint: string;
  exp: number;
};

function trimmed(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function toMs(value: string | null | undefined): number {
  if (!value) return NaN;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : NaN;
}

function sanitizeProgressText(value: string): string {
  const text = value.replace(/\s+/g, " ").trim();
  if (!text) return "";
  return text.length > 120 ? `${text.slice(0, 117).trimEnd()}...` : text;
}

function getMaterialQueryPollSecret(): string {
  const secret = trimmed(process.env.AIYRA_MATERIAL_QUERY_POLL_SECRET);
  if (!secret) {
    throw new Error("Missing material-query poll secret");
  }
  return secret;
}

function timingSafeStringEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function verifyMaterialQueryPollToken(token: string): PollTokenPayload | null {
  const [encodedPayload, encodedSignature] = token.split(".");
  if (!encodedPayload || !encodedSignature) return null;
  const expectedSignature = createHmac("sha256", getMaterialQueryPollSecret())
    .update(encodedPayload)
    .digest("base64url");
  if (!timingSafeStringEqual(expectedSignature, encodedSignature)) return null;
  try {
    const payload = JSON.parse(
      Buffer.from(encodedPayload, "base64url").toString("utf8")
    ) as Record<string, unknown>;
    const conversationId = trimmed(payload.conversationId);
    const requestFingerprint = trimmed(payload.requestFingerprint);
    const exp = Number(payload.exp);
    if (!conversationId || !requestFingerprint || !Number.isFinite(exp)) {
      return null;
    }
    if (Date.now() >= exp) {
      return null;
    }
    return {
      conversationId,
      requestFingerprint,
      exp: Math.trunc(exp),
    };
  } catch {
    return null;
  }
}

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const pollToken = trimmed(url.searchParams.get("token"));
    let conversationId = "";
    let expectedRequestFingerprint = "";
    let usingSignedPollToken = false;

    if (pollToken) {
      const payload = verifyMaterialQueryPollToken(pollToken);
      if (!payload) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      }
      conversationId = payload.conversationId;
      expectedRequestFingerprint = payload.requestFingerprint;
      usingSignedPollToken = true;
    } else {
      const relaySecret = trimmed(process.env.RELAY_JWT_SECRET);
      if (!relaySecret) {
        return NextResponse.json({ error: "Missing RELAY_JWT_SECRET" }, { status: 500 });
      }

      const token =
        req.headers.get("x-device-token") || req.headers.get("X-Device-Token") || "";
      const verified = verifyRelayDeviceToken(token, relaySecret);
      if (!verified?.userId || !verified?.deviceId) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      }

      conversationId =
        trimmed(url.searchParams.get("conversationId")) ||
        trimmed(url.searchParams.get("conversation_id"));
      if (!conversationId) {
        return NextResponse.json({ error: "conversationId required" }, { status: 400 });
      }

      const supabase = createSupabaseAdminClient();
      const { data: binding, error: bindingErr } = await supabase
        .from("aiyra_conversations")
        .select("conversation_id, user_id, device_id")
        .eq("conversation_id", conversationId)
        .maybeSingle();
      if (bindingErr) {
        return NextResponse.json({ error: bindingErr.message }, { status: 500 });
      }

      const bindingRow =
        binding && typeof binding === "object"
          ? (binding as { user_id?: unknown; device_id?: unknown })
          : null;
      const bindingUserId = trimmed(bindingRow?.user_id);
      const bindingDeviceId = trimmed(bindingRow?.device_id);
      if (!bindingUserId || bindingUserId !== verified.userId) {
        return NextResponse.json({ error: "Unknown conversationId" }, { status: 404 });
      }
      if (bindingDeviceId && bindingDeviceId !== verified.deviceId) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
      }
    }

    const supabase = createSupabaseAdminClient();
    const { data: claim, error: claimErr } = await supabase
      .from("aiyra_material_query_claims")
      .select(
        "request_fingerprint, trace_id, status, response_text, error_text, updated_at, expires_at"
      )
      .eq("conversation_id", conversationId)
      .maybeSingle();
    if (claimErr) {
      return NextResponse.json({ error: claimErr.message }, { status: 500 });
    }

    const claimRow = (claim || null) as MaterialQueryClaimRow | null;
    if (!claimRow) {
      if (usingSignedPollToken) {
        return NextResponse.json({ status: "failed", errorText: "That request is no longer available." });
      }
      return NextResponse.json({
        ok: true,
        conversationId,
        status: "idle",
        traceId: null,
        progressText: null,
        updatedAt: null,
      });
    }

    if (
      usingSignedPollToken &&
      trimmed(claimRow.request_fingerprint) !== expectedRequestFingerprint
    ) {
      return NextResponse.json({ status: "failed", errorText: "That request is no longer active." });
    }

    const expiresAtMs = toMs(claimRow.expires_at);
    const expired = Number.isFinite(expiresAtMs) && expiresAtMs <= Date.now();
    const rawStatus = trimmed(claimRow.status).toLowerCase();
    const answerText = trimmed(claimRow.response_text) || null;
    const progressText = sanitizeProgressText(trimmed(claimRow.response_text));
    const storedErrorText = sanitizeProgressText(trimmed(claimRow.error_text));
    let status = "idle";
    let errorText: string | null = null;

    if (rawStatus === "completed" && answerText) {
      status = "completed";
    } else if (rawStatus === "failed") {
      status = "failed";
      errorText = storedErrorText || "I couldn't finish that request.";
    } else if (rawStatus === "running" && !expired) {
      status = "running";
    } else if (usingSignedPollToken) {
      status = "failed";
      errorText = expired
        ? "That request timed out before it finished."
        : "I couldn't finish that request.";
    }

    if (usingSignedPollToken) {
      if (status === "running") {
        return NextResponse.json({
          status: "running",
          progressText: progressText || "I'm still working on that.",
        });
      }
      if (status === "completed") {
        return NextResponse.json({
          status: "completed",
          answerText,
        });
      }
      if (status === "failed") {
        return NextResponse.json({
          status: "failed",
          errorText,
        });
      }
      return NextResponse.json({
        status: "failed",
        errorText: "That request is no longer active.",
      });
    }

    return NextResponse.json({
      ok: true,
      conversationId,
      status,
      traceId: trimmed(claimRow.trace_id) || null,
      progressText:
        status === "running"
          ? progressText || null
          : null,
      answerText:
        status === "completed"
          ? answerText
          : null,
      errorText:
        status === "failed"
          ? errorText
          : null,
      updatedAt: claimRow.updated_at || null,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Internal error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
