import { NextResponse } from "next/server";
import {
  decryptLlmApiKey,
  encryptLlmApiKey,
  sha256Hex,
} from "@/lib/crypto/llmKey";
import {
  createDatagranLinkToken,
  resolveDatagranLinkOrigin,
} from "@/lib/datagran/linkToken";
import { jsonError, requireEmailUser } from "@/lib/email/auth";
import { recipientTrackingRolloutEnabledForUser } from "@/lib/email/recipientTrackingRollout";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const GMAIL_REQUIRED_SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.compose",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.labels",
];
const GMAIL_SMTP_SCOPE = "https://mail.google.com/";

type RecordLike = Record<string, unknown>;

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export async function POST(request: Request) {
  const auth = await requireEmailUser();
  if (!auth.ok) return auth.response;
  const body = (await request.json().catch(() => null)) as RecordLike | null;
  const connectionId = text(body?.connectionId);
  const recipientTracking = body?.recipientTracking === true;
  if (!connectionId) {
    return NextResponse.json(
      { ok: false, error: "Choose a mailbox to reconnect." },
      { status: 400 },
    );
  }

  try {
    if (
      recipientTracking &&
      !recipientTrackingRolloutEnabledForUser(
        auth.userId,
        undefined,
        auth.email,
      )
    ) {
      return NextResponse.json(
        {
          ok: false,
          error:
            "Individual group read receipts are not enabled for this account yet.",
        },
        { status: 403 },
      );
    }
    const { data: config, error } = await auth.supabase
      .from("datagran_agent_configs")
      .select(
        "agent_id,provider,connection_id,datagran_api_key_enc,end_user_external_id",
      )
      .eq("user_id", auth.userId)
      .eq("provider", "gmail")
      .eq("connection_id", connectionId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!config) {
      return NextResponse.json(
        { ok: false, error: "Mailbox not found." },
        { status: 404 },
      );
    }

    let savedApiKey = "";
    const encrypted = text(config.datagran_api_key_enc);
    if (encrypted) {
      try {
        savedApiKey = decryptLlmApiKey(encrypted);
      } catch {
        // The deployment key below can repair an older stored key.
      }
    }
    const deploymentApiKey = process.env.DATAGRAN_API_KEY?.trim() || "";

    const result = await createDatagranLinkToken({
      apiKeys: [savedApiKey, deploymentApiKey],
      endUserExternalId:
        text(config.end_user_external_id) || `flow_${auth.userId}`,
      email: auth.email || undefined,
      origin: resolveDatagranLinkOrigin(
        request.url,
        "http://localhost:3000",
      ),
      provider: "gmail",
      scopes: recipientTracking
        ? [...GMAIL_REQUIRED_SCOPES, GMAIL_SMTP_SCOPE]
        : GMAIL_REQUIRED_SCOPES,
    });
    if (!result.ok) {
      return NextResponse.json(
        {
          ok: false,
          error: result.error || "Could not start Gmail reconnection.",
        },
        { status: result.status || 502 },
      );
    }
    if (!result.linkToken) {
      return NextResponse.json(
        {
          ok: false,
          error: "The Gmail connection service did not return a secure token.",
        },
        { status: 502 },
      );
    }
    if (
      deploymentApiKey &&
      (!savedApiKey || result.usedApiKeyIndex > 0)
    ) {
      const { error: refreshError } = await auth.supabase
        .from("datagran_agent_configs")
        .update({
          datagran_api_key_enc: encryptLlmApiKey(deploymentApiKey),
          datagran_api_key_hash: sha256Hex(deploymentApiKey),
          updated_at: new Date().toISOString(),
        })
        .eq("user_id", auth.userId)
        .eq("agent_id", text(config.agent_id))
        .eq("provider", "gmail");
      if (refreshError) {
        throw new Error(refreshError.message);
      }
    }

    return NextResponse.json({
      ok: true,
      agentId: text(config.agent_id),
      linkToken: result.linkToken,
    });
  } catch (error) {
    return jsonError(error, "Could not start Gmail reconnection.");
  }
}
