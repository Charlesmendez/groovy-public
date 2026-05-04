import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { upsertExtensionConnection } from "@/lib/extensions/registry";

type PostBody = {
  authScope?: unknown;
  status?: unknown;
  config?: unknown;
  secrets?: unknown;
};

function asTrimmed(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> }
) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await ctx.params;
  const extensionId = asTrimmed(id);
  if (!extensionId) {
    return NextResponse.json({ error: "Extension id is required" }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("orchestrator_extension_connections")
    .select("id,installation_id,auth_scope,status,config,last_error,created_at,updated_at")
    .eq("extension_id", extensionId)
    .eq("user_id", user.id)
    .order("updated_at", { ascending: false });

  if (error) {
    return NextResponse.json({ error: error.message || "Failed to load connections" }, { status: 500 });
  }

  return NextResponse.json({ connections: data || [] });
}

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> }
) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await ctx.params;
  const extensionId = asTrimmed(id);
  if (!extensionId) {
    return NextResponse.json({ error: "Extension id is required" }, { status: 400 });
  }

  const body = (await req.json().catch(() => null)) as PostBody | null;
  if (!body) return NextResponse.json({ error: "Invalid request" }, { status: 400 });

  try {
    const connection = await upsertExtensionConnection({
      supabase,
      userId: user.id,
      extensionId,
      authScope:
        body.authScope === undefined
          ? undefined
          : body.authScope === "shared_org" ||
              body.authScope === "service_identity" ||
              body.authScope === "none"
          ? body.authScope
          : "end_user",
      status:
        body.status === undefined
          ? undefined
          : body.status === "connected" ||
              body.status === "disconnected" ||
              body.status === "error"
          ? body.status
          : "pending",
      config: body.config,
      secrets: body.secrets,
    });

    return NextResponse.json({ connection });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to save connection" },
      { status: 400 }
    );
  }
}
