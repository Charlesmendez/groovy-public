import { NextResponse } from "next/server";
import { encryptLlmApiKey } from "@/lib/crypto/llmKey";
import {
  decisionProfileIssues,
  requireDecisionProfile,
} from "@/lib/homeInbox/access";
import { HomeInboxError, harnessRef, uuid } from "@/lib/homeInbox/contracts";
import {
  bindingBody,
  bindingRequestAccess,
  bindingResponseError,
} from "@/lib/homeInbox/http";
import {
  createHomeInboxClient,
  homeInboxOrigin,
} from "@/lib/homeInbox/homeClient";
import { consumerEnabled } from "@/lib/homeInbox/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Params = { params: Promise<{ id: string }> };
const publicFields =
  "id,tenant_id,project_id,harness_ref,home_origin,status,verified_at,last_polled_at,created_at";

export async function GET(req: Request, { params }: Params) {
  try {
    const { id } = await params;
    const { admin, profile } = await bindingRequestAccess(req, id);
    const { data, error } = await admin
      .from("home_inbox_bindings")
      .select(publicFields)
      .eq("profile_id", id)
      .order("created_at", { ascending: false });
    if (error)
      throw new HomeInboxError(
        "binding_load_failed",
        "Could not load the Home connections.",
        503,
      );
    const ids = (data || []).map((binding) => binding.id);
    const runs = ids.length
      ? await admin
          .from("home_inbox_decision_runs")
          .select(
            "id,binding_id,decision_id,state,error_code,applied,trace_id,delivery_attempts,created_at,updated_at",
          )
          .in("binding_id", ids)
          .order("created_at", { ascending: false })
          .limit(25)
      : { data: [], error: null };
    if (runs.error)
      throw new HomeInboxError(
        "decision_history_failed",
        "Could not load decision history.",
        503,
      );
    return NextResponse.json(
      {
        bindings: data || [],
        runs: runs.data || [],
        readiness: {
          consumer_enabled: consumerEnabled(),
          profile_issues: decisionProfileIssues(profile),
          crm_database_reads: "home_grants_required_salesforce_only",
          usage_receipt: "separate_provider_receipt_report",
          queue_verification: "read_access_only",
        },
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return bindingResponseError(error);
  }
}

export async function POST(req: Request, { params }: Params) {
  try {
    const { id } = await params;
    const { admin, profile, workspaceId, userId } = await bindingRequestAccess(
      req,
      id,
      true,
    );
    requireDecisionProfile(profile);
    const body = await bindingBody(req, [
      "tenant_id",
      "project_id",
      "harness_ref",
      "home_project_key",
    ]);
    if (
      !uuid(body.tenant_id) ||
      !uuid(body.project_id) ||
      !harnessRef(body.harness_ref) ||
      typeof body.home_project_key !== "string" ||
      body.home_project_key.length < 16 ||
      body.home_project_key.length > 4096 ||
      /\s/.test(body.home_project_key)
    )
      throw new HomeInboxError(
        "invalid_binding",
        "Provide the Home tenant, project, harness reference and project key.",
        400,
      );
    const scope = {
      tenantId: body.tenant_id,
      projectId: body.project_id,
      harnessRef: body.harness_ref,
    };
    const homeOrigin = homeInboxOrigin();
    const encrypted = encryptLlmApiKey(body.home_project_key);
    // Read-only verification is not advertised as proof of operator permission
    // or provider readiness. A later claim independently enforces both scopes.
    await createHomeInboxClient(
      scope,
      body.home_project_key,
      fetch,
      homeOrigin,
    ).list(1);
    const { data, error } = await admin
      .from("home_inbox_bindings")
      .insert({
        profile_id: id,
        owner_user_id: userId,
        workspace_id: workspaceId,
        tenant_id: scope.tenantId,
        project_id: scope.projectId,
        harness_ref: scope.harnessRef,
        home_key_enc: encrypted,
        home_origin: homeOrigin,
        status: "paused",
        verified_at: new Date().toISOString(),
      })
      .select(publicFields)
      .single();
    if (error?.code === "23514")
      throw new HomeInboxError(
        "mind_project_mismatch",
        "Use a dedicated Mind for this Home project. A previously connected Mind cannot be moved to another client's project.",
      );
    if (error)
      throw new HomeInboxError(
        error.code === "23505" ? "binding_exists" : "binding_save_failed",
        error.code === "23505"
          ? "This project/harness or Mind already has a connection. Pause or revoke it explicitly; history is preserved."
          : "Could not save the Home connection.",
        error.code === "23505" ? 409 : 503,
      );
    return NextResponse.json(
      { binding: data, queue_access_verified: true, activated: false },
      { status: 201, headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return bindingResponseError(error);
  }
}
