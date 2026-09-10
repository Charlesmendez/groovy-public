import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import {
  EMAIL_TRACKING_METADATA_KEY,
  EMAIL_TRACKING_RECIPIENT_HASHES_KEY,
  hashEmailTrackingToken,
  recordEmailTrackingOpen,
  shouldCountEmailOpen,
} from "@/lib/email/openTracking";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TRANSPARENT_GIF = Buffer.from(
  "R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==",
  "base64",
);

function pixelResponse(): Response {
  return new Response(TRANSPARENT_GIF, {
    status: 200,
    headers: {
      "Content-Type": "image/gif",
      "Content-Length": String(TRANSPARENT_GIF.length),
      "Cache-Control": "private, no-store, no-cache, max-age=0, must-revalidate",
      Pragma: "no-cache",
      Expires: "0",
      "X-Content-Type-Options": "nosniff",
      "Cross-Origin-Resource-Policy": "cross-origin",
    },
  });
}

export async function GET(
  request: Request,
  context: { params: Promise<{ token: string }> },
): Promise<Response> {
  try {
    const { token: rawToken } = await context.params;
    const token = decodeURIComponent(rawToken || "").replace(/\.gif$/i, "");
    if (!/^[A-Za-z0-9_-]{32,160}$/.test(token)) return pixelResponse();

    const admin = createSupabaseAdminClient();
    const tokenHash = hashEmailTrackingToken(token);
    const legacyResult = await admin
      .from("inbox_actions")
      .select("id,metadata")
      .eq("provider", "gmail")
      .contains("metadata", {
        [EMAIL_TRACKING_METADATA_KEY]: true,
        email_tracking_token_hash: tokenHash,
      })
      .limit(1)
      .maybeSingle();
    const recipientResult = legacyResult.data
      ? null
      : await admin
          .from("inbox_actions")
          .select("id,metadata")
          .eq("provider", "gmail")
          .contains("metadata", {
            [EMAIL_TRACKING_METADATA_KEY]: true,
            [EMAIL_TRACKING_RECIPIENT_HASHES_KEY]: [tokenHash],
          })
          .limit(1)
          .maybeSingle();
    const data = legacyResult.data || recipientResult?.data;
    if (!data) return pixelResponse();

    const metadata =
      data.metadata &&
      typeof data.metadata === "object" &&
      !Array.isArray(data.metadata)
        ? (data.metadata as Record<string, unknown>)
        : {};
    if (
      !shouldCountEmailOpen({
        sentAt:
          typeof metadata.email_tracking_sent_at === "string"
            ? metadata.email_tracking_sent_at
            : null,
        userAgent: request.headers.get("user-agent"),
      })
    ) {
      return pixelResponse();
    }

    const now = new Date().toISOString();
    const updatedMetadata = recordEmailTrackingOpen({
      metadata,
      tokenHash,
      now,
    });
    if (!updatedMetadata) return pixelResponse();
    await admin
      .from("inbox_actions")
      .update({
        metadata: updatedMetadata,
        updated_at: now,
      })
      .eq("id", data.id);
  } catch {
    // A tracking failure must never break image loading for a recipient.
  }
  return pixelResponse();
}

export async function HEAD(): Promise<Response> {
  return pixelResponse();
}
