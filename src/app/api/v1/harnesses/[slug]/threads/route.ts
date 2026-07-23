import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import {
  authenticateHarnessApiRequest,
  corsHeaders,
  PublicApiAuthError,
  rateLimitHeaders,
} from "@/lib/publicApi/auth";
import { createHarnessThreadToken } from "@/lib/publicApi/threadToken";
import { getOrCreateExternalSession } from "@/lib/teamChat";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Params = { params: Promise<{ slug: string }> };

export async function OPTIONS(req: Request) {
  const origin = req.headers.get("origin");
  return new Response(null, {
    status: 204,
    headers: {
      ...corsHeaders(req),
      ...(origin ? { "Access-Control-Allow-Origin": origin, Vary: "Origin" } : {}),
    },
  });
}

export async function POST(req: Request, { params }: Params) {
  const { slug } = await params;
  const admin = createSupabaseAdminClient();
  try {
    const auth = await authenticateHarnessApiRequest({
      req,
      admin,
      slug,
      requiredScope: "threads:write",
    });
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const participantBody =
      body.participant && typeof body.participant === "object"
        ? (body.participant as Record<string, unknown>)
        : {};
    const externalId =
      typeof participantBody.externalId === "string" && participantBody.externalId.trim()
        ? participantBody.externalId.trim().slice(0, 300)
        : `anonymous:${randomUUID()}`;
    const displayName =
      typeof participantBody.displayName === "string" && participantBody.displayName.trim()
        ? participantBody.displayName.trim().slice(0, 200)
        : null;
    const metadata =
      participantBody.metadata &&
      typeof participantBody.metadata === "object" &&
      !Array.isArray(participantBody.metadata)
        ? participantBody.metadata
        : {};
    if (Buffer.byteLength(JSON.stringify(metadata), "utf8") > 16_384) {
      return NextResponse.json(
        {
          error: {
            code: "invalid_participant_metadata",
            message: "participant.metadata must be at most 16 KB",
          },
        },
        {
          status: 400,
          headers: { ...rateLimitHeaders(auth), ...corsHeaders(req, auth) },
        },
      );
    }
    const { data: participant, error: participantError } = await admin
      .from("external_participants")
      .upsert(
        {
          profile_id: auth.profile.id,
          external_id: externalId,
          display_name: displayName,
          metadata,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "profile_id,external_id" },
      )
      .select("*")
      .single();
    if (participantError || !participant) {
      throw new Error(participantError?.message || "Could not create participant");
    }

    const threadKey = `${auth.key.id}:${randomUUID()}`;
    const thread = await getOrCreateExternalSession({
      admin,
      ownerUserId: auth.key.ownerUserId,
      provider: "api",
      threadKey,
      threadName:
        typeof body.title === "string" && body.title.trim()
          ? body.title.trim().slice(0, 200)
          : `${auth.profile.name} conversation`,
      profileId: auth.profile.id,
      externalParticipantId: participant.id,
      apiKeyId: auth.key.id,
    });
    const threadToken = createHarnessThreadToken({
      threadId: thread.threadId,
      keyId: auth.key.id,
      requestOrigin: auth.requestOrigin,
    });
    return NextResponse.json(
      {
        id: thread.threadId,
        harness: auth.profile.slug,
        participant: {
          id: participant.id,
          externalId: participant.external_id,
          displayName: participant.display_name,
        },
        threadToken,
        createdAt: new Date().toISOString(),
      },
      {
        status: 201,
        headers: {
          ...rateLimitHeaders(auth),
          ...corsHeaders(req, auth),
        },
      },
    );
  } catch (error) {
    if (error instanceof PublicApiAuthError) {
      return NextResponse.json(
        { error: { code: error.code, message: error.message } },
        { status: error.status, headers: { ...error.headers, ...corsHeaders(req) } },
      );
    }
    console.error("[public-harness] thread_create_failed", {
      slug,
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json(
      {
        error: {
          code: "thread_create_failed",
          message: "Could not create thread",
        },
      },
      { status: 500, headers: corsHeaders(req) },
    );
  }
}
