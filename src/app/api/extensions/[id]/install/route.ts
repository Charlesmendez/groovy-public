import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { upsertExtensionInstallation } from "@/lib/extensions/registry";

type PostBody = {
  installStatus?: unknown;
  runtimeTargetOverride?: unknown;
  approvalPolicy?: unknown;
  enabled?: unknown;
  versionId?: unknown;
  runnerId?: unknown;
};

function asTrimmed(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
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
    const installation = await upsertExtensionInstallation({
      supabase,
      userId: user.id,
      extensionId,
      installStatus:
        body.installStatus === undefined
          ? undefined
          : body.installStatus === "disabled" || body.installStatus === "error"
          ? body.installStatus
          : "installed",
      runtimeTargetOverride:
        body.runtimeTargetOverride === undefined
          ? undefined
          : body.runtimeTargetOverride === "customer_runner" ||
              body.runtimeTargetOverride === "device_connector" ||
              body.runtimeTargetOverride === "groovy_cloud"
          ? body.runtimeTargetOverride
          : null,
      approvalPolicy: body.approvalPolicy,
      enabled: body.enabled === undefined ? undefined : body.enabled === true,
      versionId: body.versionId === undefined ? undefined : asTrimmed(body.versionId) || null,
      runnerId: body.runnerId === undefined ? undefined : asTrimmed(body.runnerId) || null,
    });

    return NextResponse.json({ installation });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to install extension" },
      { status: 400 }
    );
  }
}
