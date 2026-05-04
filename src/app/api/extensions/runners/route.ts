import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import {
  listExtensionRunners,
  upsertExtensionRunner,
} from "@/lib/extensions/runners";

type PostBody = {
  runnerId?: unknown;
  agentId?: unknown;
  name?: unknown;
  runtimeTarget?: unknown;
  transport?: unknown;
  status?: unknown;
  endpoint?: unknown;
  publicKey?: unknown;
  authToken?: unknown;
  metadata?: unknown;
  lastSeenAt?: unknown;
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
    const runners = await listExtensionRunners({
      supabase,
      userId: user.id,
      agentId: agentId || null,
    });
    return NextResponse.json({ runners });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to load runners" },
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
  const name = asTrimmed(body.name);
  if (!agentId) {
    return NextResponse.json({ error: "agentId is required" }, { status: 400 });
  }
  if (!name) {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }

  try {
    const runner = await upsertExtensionRunner({
      supabase,
      userId: user.id,
      runnerId: body.runnerId === undefined ? undefined : asTrimmed(body.runnerId) || null,
      agentId,
      name,
      runtimeTarget:
        body.runtimeTarget === undefined
          ? undefined
          : body.runtimeTarget === "groovy_cloud" || body.runtimeTarget === "device_connector"
          ? body.runtimeTarget
          : "customer_runner",
      transport:
        body.transport === undefined
          ? undefined
          : body.transport === "relay" || body.transport === "local"
            ? body.transport
            : "https",
      status:
        body.status === undefined
          ? undefined
          : body.status === "pending" || body.status === "online" || body.status === "error"
          ? body.status
          : "offline",
      endpoint: body.endpoint === undefined ? undefined : asTrimmed(body.endpoint) || null,
      publicKey: body.publicKey === undefined ? undefined : asTrimmed(body.publicKey) || null,
      authToken: body.authToken === undefined ? undefined : asTrimmed(body.authToken) || null,
      metadata: body.metadata,
      lastSeenAt: body.lastSeenAt === undefined ? undefined : asTrimmed(body.lastSeenAt) || null,
    });

    return NextResponse.json({ runner });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to save runner" },
      { status: 400 }
    );
  }
}
