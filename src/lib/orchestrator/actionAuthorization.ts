export type ActionAuthorizationMode = "default" | "confirmation_required";

const WRITE_LIKE_TOOLS = new Set<string>([
  "schedule_create",
  "schedule_update",
  "schedule_pause",
  "schedule_resume",
  "schedule_cancel_next",
  "schedule_delete",
  "remember",
  "wiki_file_learning",
  "files_write",
  "files_delete",
  "files_move",
  "files_mkdir",
  "obsidian_write",
  "obsidian_delete",
  "obsidian_daily",
  "whatsapp_send_text",
  "whatsapp_send_media",
  "telegram_send_text",
  "telegram_send_media",
  "telegram_create_topic",
  "start_twilio_call",
  "start_twilio_sms",
  "coach_twilio_child",
  "handshake_send",
  "code_open_session",
  "code_terminal_step",
  "terminal_exec",
  "code_cli_run",
  "browser_task",
  "computer_use_action",
  "runtime_branch_parallel",
  "files_agent_request",
  "ai_agent_delegate",
  "email_create_draft",
  "email_send_draft",
  "chat_send_message",
  "run_skill_action",
  "transfer_context",
  "linkdb_init",
  "linkdb_upsert_links",
  "linkdb_update",
  "sqlite_exec",
  "sqlite_project_get_or_create",
  "sqlite_project_update",
  "site_dev",
  "site_dev_stop",
  "site_publish",
  "site_attach_domain",
  "site_unpublish",
  "site_delete",
  "skill_registry_create_draft",
  "skill_registry_validate_draft",
  "skill_registry_activate_draft",
  "assign_skill_or_doc",
  "remove_skill_or_doc_assignment",
  "create_channel_skill",
  "update_channel_skill_actions",
  "assign_channel_skill",
  "remove_channel_skill",
  "set_workspace_secret_assignment",
]);

const REVERSIBLE_WITHOUT_CONFIRMATION = new Set([
  "remember",
  "wiki_file_learning",
  "finalize_plan",
  "email_create_draft",
]);

export function isBuiltInWriteLikeTool(
  toolName: string,
  params: Record<string, unknown>,
): boolean {
  if (toolName === "assign_task") {
    return params.access_mode !== "read_only" && params.plan_mode !== true;
  }
  if (toolName === "data_query") {
    const query = typeof params.query === "string" ? params.query : "";
    return /\b(?:send|reply|respond|forward|post|publish|delete|remove|archive|unsubscribe|mark\s+(?:as\s+)?spam|update|insert|upsert|alter|drop|truncate|grant|revoke|create\s+(?:an?\s+)?(?:event|meeting|task))\b/i.test(
      query,
    );
  }
  if (WRITE_LIKE_TOOLS.has(toolName)) return true;
  if (toolName === "skill_registry_list") return false;
  if (toolName.startsWith("skill_")) return true;
  return toolName.startsWith("browser_");
}

export function actionAuthorizationDenialReason(args: {
  mode?: ActionAuthorizationMode;
  toolName: string;
  params: Record<string, unknown>;
  extensionRiskLevel?: "read" | "write" | "destructive" | "privileged" | null;
}): string | null {
  if (args.mode !== "confirmation_required") return null;
  const writeLike =
    isBuiltInWriteLikeTool(args.toolName, args.params) ||
    (args.extensionRiskLevel != null && args.extensionRiskLevel !== "read");
  if (!writeLike || REVERSIBLE_WITHOUT_CONFIRMATION.has(args.toolName)) return null;
  return "Action authorization blocked this side effect because the user has not confirmed it.";
}
