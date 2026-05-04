import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

function asTrimmed(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

const VALID_KINDS = ["traces", "audit", "usage", "analytics", "overview"] as const;
type TelemetryKind = (typeof VALID_KINDS)[number];

export async function GET(
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

  const url = new URL(req.url);
  const kind = (asTrimmed(url.searchParams.get("kind")) || "overview") as TelemetryKind;
  if (!VALID_KINDS.includes(kind)) {
    return NextResponse.json(
      { error: `Invalid kind. Must be one of: ${VALID_KINDS.join(", ")}` },
      { status: 400 }
    );
  }
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 50, 1), 200);
  const offset = Math.max(Number(url.searchParams.get("offset")) || 0, 0);

  try {
    if (kind === "overview") {
      const [tracesRes, usageRes] = await Promise.all([
        supabase
          .from("orchestrator_extension_runtime_traces")
          .select("id,status,duration_ms,created_at,tool_name", { count: "exact" })
          .eq("extension_id", extensionId)
          .eq("user_id", user.id)
          .order("created_at", { ascending: false })
          .limit(0),
        supabase
          .from("orchestrator_extension_usage_meter")
          .select("id,status,duration_ms,created_at,tool_name,risk_level", { count: "exact" })
          .eq("extension_id", extensionId)
          .eq("user_id", user.id)
          .order("created_at", { ascending: false })
          .limit(0),
      ]);

      const totalTraces = tracesRes.count ?? 0;
      const totalUsage = usageRes.count ?? 0;

      const { data: recentTraces } = await supabase
        .from("orchestrator_extension_runtime_traces")
        .select("id,tool_name,status,duration_ms,error_code,error_message,created_at")
        .eq("extension_id", extensionId)
        .eq("user_id", user.id)
        .order("created_at", { ascending: false })
        .limit(10);

      const { data: recentUsage } = await supabase
        .from("orchestrator_extension_usage_meter")
        .select("id,tool_name,status,duration_ms,risk_level,error_code,created_at")
        .eq("extension_id", extensionId)
        .eq("user_id", user.id)
        .order("created_at", { ascending: false })
        .limit(10);

      const traceRows = (recentTraces || []) as Array<Record<string, unknown>>;
      const usageRows = (recentUsage || []) as Array<Record<string, unknown>>;
      const successCount = usageRows.filter((r) => r.status === "success").length;
      const errorCount = usageRows.filter((r) => r.status === "error").length;
      const avgDuration =
        traceRows.length > 0
          ? Math.round(
              traceRows.reduce((sum, r) => sum + (Number(r.duration_ms) || 0), 0) /
                traceRows.length
            )
          : 0;

      return NextResponse.json({
        overview: {
          totalTraces,
          totalUsage,
          recentSuccessCount: successCount,
          recentErrorCount: errorCount,
          avgDurationMs: avgDuration,
          recentTraces: traceRows,
          recentUsage: usageRows,
        },
      });
    }

    if (kind === "traces") {
      const { data, error, count } = await supabase
        .from("orchestrator_extension_runtime_traces")
        .select(
          "id,trace_id,turn_id,tool_name,runtime_target,adapter,status,duration_ms,request_payload,response_payload,error_code,error_message,metadata,created_at",
          { count: "exact" }
        )
        .eq("extension_id", extensionId)
        .eq("user_id", user.id)
        .order("created_at", { ascending: false })
        .range(offset, offset + limit - 1);

      if (error) throw error;
      return NextResponse.json({ traces: data || [], total: count ?? 0 });
    }

    if (kind === "audit") {
      const { data, error, count } = await supabase
        .from("orchestrator_extension_audit_events")
        .select(
          "id,trace_id,turn_id,tool_name,action,actor_scope,approval_state,status,request_preview,result_preview,metadata,created_at",
          { count: "exact" }
        )
        .eq("extension_id", extensionId)
        .eq("user_id", user.id)
        .order("created_at", { ascending: false })
        .range(offset, offset + limit - 1);

      if (error) throw error;
      return NextResponse.json({ audit: data || [], total: count ?? 0 });
    }

    if (kind === "usage") {
      const { data, error, count } = await supabase
        .from("orchestrator_extension_usage_meter")
        .select(
          "id,trace_id,turn_id,tool_name,runtime_target,adapter,auth_scope,risk_level,approval_state,status,duration_ms,input_bytes,output_bytes,error_code,metadata,created_at",
          { count: "exact" }
        )
        .eq("extension_id", extensionId)
        .eq("user_id", user.id)
        .order("created_at", { ascending: false })
        .range(offset, offset + limit - 1);

      if (error) throw error;
      return NextResponse.json({ usage: data || [], total: count ?? 0 });
    }

    if (kind === "analytics") {
      const { data, error, count } = await supabase
        .from("orchestrator_extension_analytics_events")
        .select("id,trace_id,event_name,payload,created_at", { count: "exact" })
        .eq("extension_id", extensionId)
        .eq("user_id", user.id)
        .order("created_at", { ascending: false })
        .range(offset, offset + limit - 1);

      if (error) throw error;
      return NextResponse.json({ analytics: data || [], total: count ?? 0 });
    }

    return NextResponse.json({ error: "Unknown kind" }, { status: 400 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to load telemetry" },
      { status: 500 }
    );
  }
}
