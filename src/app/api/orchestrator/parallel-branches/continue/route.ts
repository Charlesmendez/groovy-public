import { NextResponse } from "next/server";
import { getAppUrl } from "@/lib/config/appConfig";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { verifyRelayDeviceToken } from "@/lib/relay/deviceToken";
import { loadBranchControllerSettings } from "@/lib/orchestrator/branchController";
import {
  continueParallelBranchRuntime,
  type ParallelBranchConnectorToolResultInput,
  type ParallelBranchRuntimeState,
} from "@/lib/orchestrator/parallelBranchRuntime";

type PostBody = {
  state?: ParallelBranchRuntimeState;
  toolResults?: ParallelBranchConnectorToolResultInput[];
};

export const runtime = "nodejs";

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as PostBody | null;
  if (!body || typeof body !== "object" || !body.state || typeof body.state !== "object") {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  const deviceToken = req.headers.get("x-device-token") || req.headers.get("X-Device-Token") || "";
  const secret = process.env.RELAY_JWT_SECRET || "";
  const verified = deviceToken
    ? verifyRelayDeviceToken(deviceToken, secret)
    : null;
  if (!verified) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = verified.userId;
  const supabase = createSupabaseAdminClient();
  const state = body.state;
  const workers = Array.isArray(state.workers) ? state.workers : [];
  const context =
    state.context && typeof state.context === "object"
      ? state.context
      : null;
  const branchIds = workers
    .map((worker) =>
      worker && typeof worker === "object" && typeof worker.branchId === "string"
        ? worker.branchId.trim()
        : "",
    )
    .filter(Boolean);
  const uniqueBranchIds = new Set(branchIds);
  if (
    state.version !== 1 ||
    !context ||
    context.deviceId !== verified.deviceId ||
    typeof context.orchestratorAgentId !== "string" ||
    typeof context.epochId !== "string" ||
    workers.length === 0 ||
    workers.length > 12 ||
    uniqueBranchIds.size !== workers.length
  ) {
    return NextResponse.json({ error: "Invalid parallel branch state" }, { status: 400 });
  }

  const { data: ownedBranches, error: branchesError } = await supabase
    .from("orchestrator_branches")
    .select("id")
    .eq("user_id", userId)
    .eq("agent_id", context.orchestratorAgentId)
    .eq("epoch_id", context.epochId)
    .in("id", branchIds);
  if (branchesError || (ownedBranches || []).length !== uniqueBranchIds.size) {
    return NextResponse.json({ error: "Invalid parallel branch ownership" }, { status: 403 });
  }

  if (context.orchestratorSessionId) {
    const { data: session } = await supabase
      .from("orchestrator_sessions")
      .select("id")
      .eq("id", context.orchestratorSessionId)
      .eq("user_id", userId)
      .maybeSingle();
    if (!session) {
      return NextResponse.json({ error: "Invalid orchestrator session" }, { status: 403 });
    }
  }

  const currentBranchController = await loadBranchControllerSettings(
    supabase,
    userId,
  );
  state.branchController = currentBranchController;
  state.launchedTasks = workers.length;
  state.requestedTasks = Math.max(
    workers.length,
    Math.min(12, Math.floor(Number(state.requestedTasks) || workers.length)),
  );
  state.skippedTasks = Math.max(
    0,
    state.requestedTasks - state.launchedTasks,
  );
  state.context.appBaseUrl = getAppUrl();
  state.context.deviceId = verified.deviceId;
  for (const worker of workers) {
    const remaining = Number(worker.budgetRemaining);
    worker.budgetRemaining = Math.max(
      0,
      Math.min(
        currentBranchController.maxTurnsPerBranch,
        Number.isFinite(remaining) ? Math.floor(remaining) : 0,
      ),
    );
  }

  const pending = Array.isArray(state.pendingConnectorExecutes)
    ? state.pendingConnectorExecutes
    : [];
  const pendingKeys = new Set<string>();
  if (
    pending.length > 256 ||
    pending.some(
      (execute) => {
        if (
          !execute ||
          typeof execute.branchId !== "string" ||
          !uniqueBranchIds.has(execute.branchId) ||
          typeof execute.toolCallId !== "string" ||
          !execute.toolCallId.trim() ||
          typeof execute.toolName !== "string" ||
          !execute.toolName.trim() ||
          typeof execute.connectorType !== "string" ||
          !execute.connectorType.trim()
        ) {
          return true;
        }
        const key = `${execute.branchId}\u0000${execute.toolCallId.trim()}`;
        if (pendingKeys.has(key)) return true;
        pendingKeys.add(key);
        return false;
      },
    )
  ) {
    return NextResponse.json({ error: "Invalid pending connector state" }, { status: 400 });
  }
  const waitingBranchIds = new Set(
    workers
      .filter((worker) => worker.waitingForConnector === true)
      .map((worker) => worker.branchId),
  );
  if (
    pending.some((execute) => !waitingBranchIds.has(execute.branchId)) ||
    Array.from(waitingBranchIds).some(
      (branchId) =>
        !pending.some((execute) => execute.branchId === branchId),
    )
  ) {
    return NextResponse.json(
      { error: "Inconsistent parallel connector state" },
      { status: 400 },
    );
  }

  const toolResults = Array.isArray(body.toolResults)
    ? body.toolResults.filter(
        (row): row is ParallelBranchConnectorToolResultInput =>
          !!row &&
          typeof row.branchId === "string" &&
          typeof row.toolCallId === "string" &&
          typeof row.toolName === "string" &&
          typeof row.result === "string"
      )
      .slice(0, 256)
      .map((row) => ({
        ...row,
        result: row.result.slice(0, 8_000),
      }))
    : [];

  try {
    const result = await continueParallelBranchRuntime({
      supabase,
      userId,
      state,
      toolResults,
      deviceToken: deviceToken || undefined,
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Failed to continue parallel branches.",
      },
      { status: 500 }
    );
  }
}
