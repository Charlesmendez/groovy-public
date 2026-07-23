import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import {
  authenticateHarnessApiRequest,
  corsHeaders,
  PublicApiAuthError,
  rateLimitHeaders,
} from "@/lib/publicApi/auth";

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

export async function GET(req: Request, { params }: Params) {
  const { slug } = await params;
  const admin = createSupabaseAdminClient();
  try {
    const auth = await authenticateHarnessApiRequest({
      req,
      admin,
      slug,
      requiredScope: "threads:read",
    });
    const config = auth.profile.widgetConfig || {};
    return NextResponse.json(
      {
        name:
          typeof config.name === "string" && config.name.trim()
            ? config.name.trim()
            : auth.profile.name,
        greeting:
          typeof config.greeting === "string" && config.greeting.trim()
            ? config.greeting.trim()
            : `Hi — how can ${auth.profile.name} help?`,
        primaryColor:
          typeof config.primaryColor === "string" && /^#[0-9a-f]{6}$/i.test(config.primaryColor)
            ? config.primaryColor
            : "#06b6d4",
        avatar:
          typeof config.avatar === "string" && /^https:\/\//i.test(config.avatar)
            ? config.avatar
            : null,
      },
      { headers: { ...rateLimitHeaders(auth), ...corsHeaders(req, auth) } },
    );
  } catch (error) {
    if (error instanceof PublicApiAuthError) {
      return NextResponse.json(
        { error: { code: error.code, message: error.message } },
        { status: error.status, headers: { ...error.headers, ...corsHeaders(req) } },
      );
    }
    return NextResponse.json(
      { error: { code: "config_failed", message: "Could not load widget config" } },
      { status: 500, headers: corsHeaders(req) },
    );
  }
}
