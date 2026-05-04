import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import {
  createExtensionDraft,
  listExtensionsForUser,
} from "@/lib/extensions/registry";

type PostBody = {
  extensionId?: unknown;
  agentId?: unknown;
  slug?: unknown;
  name?: unknown;
  description?: unknown;
  visibility?: unknown;
  runtimeTargetDefault?: unknown;
  status?: unknown;
  versionLabel?: unknown;
  manifest?: unknown;
  activate?: unknown;
};

function asTrimmed(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export async function GET(req: Request) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const agentId = asTrimmed(url.searchParams.get("agentId"));

  try {
    const extensions = await listExtensionsForUser({
      supabase,
      userId: user.id,
      agentId: agentId || null,
    });
    return NextResponse.json({ extensions });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to load extensions" },
      { status: 500 }
    );
  }
}

export async function POST(req: Request) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => null)) as PostBody | null;
  if (!body) return NextResponse.json({ error: "Invalid request" }, { status: 400 });

  const agentId = asTrimmed(body.agentId);
  const slug = asTrimmed(body.slug);
  const name = asTrimmed(body.name);
  if (!agentId) {
    return NextResponse.json({ error: "agentId is required" }, { status: 400 });
  }
  if (!slug) {
    return NextResponse.json({ error: "slug is required" }, { status: 400 });
  }
  if (!name) {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }

  try {
    const result = await createExtensionDraft({
      supabase,
      userId: user.id,
      agentId,
      extensionId: asTrimmed(body.extensionId) || null,
      slug,
      name,
      description: body.description === undefined ? undefined : asTrimmed(body.description) || null,
      visibility:
        body.visibility === undefined
          ? undefined
          : body.visibility === "org" || body.visibility === "public"
            ? body.visibility
            : "private",
      runtimeTargetDefault:
        body.runtimeTargetDefault === undefined
          ? undefined
          : body.runtimeTargetDefault === "customer_runner" ||
              body.runtimeTargetDefault === "device_connector"
          ? body.runtimeTargetDefault
          : "groovy_cloud",
      status:
        body.status === undefined
          ? undefined
          : body.status === "active" || body.status === "disabled"
            ? body.status
            : "draft",
      versionLabel: asTrimmed(body.versionLabel) || "draft",
      manifest: body.manifest || {},
      activate: body.activate === true,
    });

    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to save extension" },
      { status: 400 }
    );
  }
}
