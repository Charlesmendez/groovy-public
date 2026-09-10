import { NextResponse } from "next/server";
import { decryptLlmApiKey } from "@/lib/crypto/llmKey";
import {
  requireDecisionProfile,
  requireProfileAdmin,
} from "@/lib/homeInbox/access";
import { HomeInboxError, uuid } from "@/lib/homeInbox/contracts";
import {
  bindingBody,
  bindingRequestAccess,
  bindingResponseError,
} from "@/lib/homeInbox/http";
import { createHomeInboxClient } from "@/lib/homeInbox/homeClient";
import { consumerEnabled } from "@/lib/homeInbox/runtime";
import { bindingFromRow, type BindingRow } from "@/lib/homeInbox/store";
import { createHomeDataBridge } from "@/lib/homeInbox/dataBridge";
import {
  homeDataCatalog,
  HOME_DATA_TOOLS,
} from "@/lib/homeInbox/dataContracts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Params = { params: Promise<{ id: string; bindingId: string }> };

export async function PATCH(req: Request, { params }: Params) {
  try {
    const { id, bindingId } = await params;
    const { admin } = await bindingRequestAccess(req, id, true);
    if (!uuid(bindingId))
      throw new HomeInboxError(
        "binding_unavailable",
        "Connection not found.",
        404,
      );
    const body = await bindingBody(req, ["status"]);
    if (
      typeof body.status !== "string" ||
      !["active", "paused", "revoked"].includes(body.status)
    )
      throw new HomeInboxError(
        "invalid_status",
        "Choose active, paused or revoked.",
        400,
      );
    const loaded = await admin
      .from("home_inbox_bindings")
      .select("*")
      .eq("id", bindingId)
      .eq("profile_id", id)
      .maybeSingle();
    if (loaded.error)
      throw new HomeInboxError(
        "binding_load_failed",
        "Could not load this connection.",
        503,
      );
    if (!loaded.data)
      throw new HomeInboxError(
        "binding_unavailable",
        "Connection not found.",
        404,
      );
    const binding = bindingFromRow(loaded.data as BindingRow);
    if (binding.status === "revoked")
      throw new HomeInboxError(
        "binding_revoked",
        "Revoked credentials cannot be reactivated. Create a new connection.",
      );
    if (body.status === "active") {
      if (!consumerEnabled())
        throw new HomeInboxError(
          "consumer_disabled",
          "The server's Inbox decision consumer is not enabled yet.",
          503,
        );
      const access = await requireProfileAdmin(
        admin,
        binding.profileId,
        binding.ownerUserId,
      );
      if (access.workspaceId !== binding.workspaceId)
        throw new HomeInboxError(
          "binding_scope_changed",
          "Reconnect this Mind in its current workspace.",
        );
      requireDecisionProfile(access.profile);
      await createHomeInboxClient(
        binding,
        decryptLlmApiKey(binding.homeKeyEnc),
        fetch,
        binding.homeOrigin,
      ).list(1);
      if (
        access.profile.toolPolicy.mode === "allowlist" &&
        HOME_DATA_TOOLS.some(
          (tool) =>
            access.profile.toolPolicy.mode === "allowlist" &&
            access.profile.toolPolicy.tools.includes(tool),
        )
      ) {
        const bridge = createHomeDataBridge({
          scope: binding,
          key: decryptLlmApiKey(binding.homeKeyEnc),
          origin: binding.homeOrigin,
          signal: AbortSignal.timeout(20_000),
          deadlineAt: Date.now() + 20_000,
          authorize: async () => {
            const current = await requireProfileAdmin(
              admin,
              binding.profileId,
              binding.ownerUserId,
            );
            if (
              current.workspaceId !== binding.workspaceId ||
              JSON.stringify(current.profile) !== JSON.stringify(access.profile)
            )
              throw new HomeInboxError(
                "profile_changed",
                "The Mind changed during connection verification.",
              );
          },
        });
        const catalog = homeDataCatalog.parse(
          await bridge.execute("home_data_operations", { limit: 1 }),
        );
        if (!catalog.operations.length)
          throw new HomeInboxError(
            "home_data_grants_missing",
            "This Mind has no active Home data grants. Grant read operations to its dedicated project key in Home before activation.",
          );
        // Metadata only. This never queries customer records or proves provider
        // health; every actual read must independently pass Home authorization.
      }
    }
    const { data, error } = await admin
      .from("home_inbox_bindings")
      .update({ status: body.status, updated_at: new Date().toISOString() })
      .eq("id", bindingId)
      .eq("profile_id", id)
      .eq("status", binding.status)
      .select("id,status")
      .maybeSingle();
    if (error || !data)
      throw new HomeInboxError(
        "binding_changed",
        "The connection changed. Refresh before trying again.",
      );
    return NextResponse.json(
      { binding: data },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return bindingResponseError(error);
  }
}
