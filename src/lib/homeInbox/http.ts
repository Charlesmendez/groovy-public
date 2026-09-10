import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "../supabase/admin";
import { createSupabaseServerClient } from "../supabase/server";
import { isSameOriginVoiceMutation } from "../voice/requestSecurity";
import { requireProfileAdmin } from "./access";
import { HomeInboxError, record } from "./contracts";

export async function bindingRequestAccess(
  req: Request,
  profileId: string,
  mutate = false,
) {
  if (mutate && !isSameOriginVoiceMutation(req))
    throw new HomeInboxError(
      "same_origin_required",
      "Use the Groovy settings page to change this connection.",
      403,
    );
  const client = await createSupabaseServerClient();
  const {
    data: { user },
    error,
  } = await client.auth.getUser();
  if (error || !user)
    throw new HomeInboxError(
      "unauthorized",
      "Sign in to manage this connection.",
      401,
    );
  const admin = createSupabaseAdminClient();
  const access = await requireProfileAdmin(admin, profileId, user.id);
  return { ...access, admin, userId: user.id };
}

export async function bindingBody(req: Request, keys: string[]) {
  // Do not parse unbounded JSON containing a submitted credential.
  if (Number(req.headers.get("content-length")) > 16_384)
    throw new HomeInboxError(
      "body_too_large",
      "The connection request is too large.",
      413,
    );
  const reader = req.body?.getReader();
  if (!reader)
    throw new HomeInboxError(
      "invalid_body",
      "Provide the connection settings.",
      400,
    );
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > 16_384) {
        await reader.cancel();
        throw new HomeInboxError(
          "body_too_large",
          "The connection request is too large.",
          413,
        );
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  let body: unknown;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HomeInboxError(
      "invalid_body",
      "Provide valid connection JSON.",
      400,
    );
  }
  if (
    !record(body) ||
    Object.keys(body).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(body, key))
  )
    throw new HomeInboxError(
      "invalid_body",
      "Provide only the documented connection settings.",
      400,
    );
  return body;
}

export function bindingResponseError(error: unknown) {
  const known = error instanceof HomeInboxError;
  // Never return/log database errors, tokens, input payloads or upstream bodies.
  return NextResponse.json(
    {
      error: {
        code: known ? error.code : "home_connection_failed",
        message: known
          ? error.message
          : "Could not complete the Home connection request.",
      },
    },
    {
      status: known ? error.status : 503,
      headers: { "cache-control": "no-store" },
    },
  );
}
