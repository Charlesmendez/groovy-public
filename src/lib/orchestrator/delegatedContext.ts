import type { SupabaseClient } from "@supabase/supabase-js";
import type { ModelMessage } from "ai";
import type { LiveTurnProgress } from "@/lib/live/turn";
import { loadLiveOrchestratorContext } from "@/lib/live/context/orchestrator";
import type { ToolExecutionContext } from "@/lib/orchestrator/toolExecutor";

/**
 * Provider-neutral entry point for channels that delegate work to Groovy's
 * orchestrator. The legacy Live canvas remains one caller; voice and future
 * channels use this boundary without depending on a transport-specific name.
 */
export function loadDelegatedOrchestratorContext(args: {
  supabase: SupabaseClient;
  userId: string;
  userEmail?: string | null;
  message: string;
  history?: ModelMessage[];
  orchestratorAgentId?: string | null;
  orchestratorSessionId?: string | null;
  sourceProvider?: string;
  actionAuthorization?: "default" | "confirmation_required";
  cookies?: string;
  userAgent?: string;
  progress?: LiveTurnProgress;
  /** Keep raw tool output out of speech-oriented delegated responses. */
  includeToolOutput?: boolean;
  onUiAction?: ToolExecutionContext["onUiAction"];
}): Promise<string> {
  return loadLiveOrchestratorContext(args);
}
