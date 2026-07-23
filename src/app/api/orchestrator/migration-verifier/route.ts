import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

type CheckResult = {
  name: string;
  ok: boolean;
  error?: string;
};

async function runCheck(
  checks: CheckResult[],
  name: string,
  fn: () => Promise<{ error?: { message?: string } | null }>
) {
  try {
    const { error } = await fn();
    if (error) {
      checks.push({
        name,
        ok: false,
        error: error.message || "Unknown error",
      });
      return;
    }
    checks.push({ name, ok: true });
  } catch (err) {
    checks.push({
      name,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export async function GET() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();
  if (userError || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const checks: CheckResult[] = [];

  await runCheck(checks, "branch_controller_column", async () =>
    supabase.from("user_preferences").select("branch_controller").eq("user_id", user.id).limit(1)
  );
  await runCheck(checks, "branch_telemetry_columns", async () =>
    supabase
      .from("orchestrator_branches")
      .select("fork_reason,merge_reason,abort_reason,budget_limit_hit,budget_hit_at")
      .eq("user_id", user.id)
      .limit(1)
  );
  await runCheck(checks, "branch_worker_columns", async () =>
    supabase
      .from("orchestrator_branches")
      .select("branch_kind,goal,result_summary,result_payload,completed_at")
      .eq("user_id", user.id)
      .limit(1)
  );
  await runCheck(checks, "session_runtime_agent_scope", async () =>
    supabase
      .from("orchestrator_session_runtime")
      .select("session_id,user_id,agent_id,active_epoch_id,active_branch_id")
      .eq("user_id", user.id)
      .limit(1)
  );
  await runCheck(checks, "skills_registry", async () =>
    supabase
      .from("orchestrator_skills")
      .select("id,agent_id,active_version_id,rollback_version_id,lifecycle,runner")
      .eq("user_id", user.id)
      .limit(1)
  );
  await runCheck(checks, "skills_versions", async () =>
    supabase
      .from("orchestrator_skill_versions")
      .select(
        "id,skill_id,version,lifecycle,runner,default_state,metadata,validation_status,validation_task,validation_token,validation_output_preview,validation_requested_at,validated_at"
      )
      .eq("user_id", user.id)
      .limit(1)
  );
  await runCheck(checks, "skills_runtime_state", async () =>
    supabase
      .from("orchestrator_skill_runtime_state")
      .select("id,skill_version_id,agent_id,epoch_id,branch_id,state")
      .eq("user_id", user.id)
      .limit(1)
  );
  await runCheck(checks, "workspace_agent_acl", async () =>
    supabase
      .from("workspace_orchestrator_agents")
      .select("id,workspace_id,agent_id,created_by_user_id")
      .limit(1)
  );
  await runCheck(checks, "agent_members_acl", async () =>
    supabase
      .from("orchestrator_agent_members")
      .select("agent_id,user_id,role")
      .limit(1)
  );
  await runCheck(checks, "workspace_requests_agent_scope", async () =>
    supabase
      .from("workspace_orchestrator_requests")
      .select("id,session_id,agent_id,status")
      .limit(1)
  );
  await runCheck(checks, "whatsapp_agent_mapping", async () =>
    supabase
      .from("orchestrator_external_threads")
      .select("thread_key,orchestrator_session_id,orchestrator_agent_id")
      .eq("user_id", user.id)
      .limit(1)
  );

  const ok = checks.every((check) => check.ok);
  return NextResponse.json({
    ok,
    checkedAt: new Date().toISOString(),
    checks,
  });
}
