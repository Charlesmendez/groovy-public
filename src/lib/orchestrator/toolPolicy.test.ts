import { strict as assert } from "node:assert";
import test from "node:test";
import {
  buildToolPolicyExecutionContext,
  filterAgentRoster,
  isConnectorToolName,
  isToolAllowed,
  toolPolicyDenialReason,
  toolPolicyParameterDenialReason,
} from "./toolPolicy";
import { DEFAULT_GROOVY_PROFILE } from "./harnessProfiles";

test("Home Inbox decisions cannot escape via skills, delegation, schedules, data writes or internal profile changes", () => {
  for (const surface of ["internal", "external"] as const) {
    const tools = ["web_search", "schedule_create", "chat_send_message", "data_query", "run_skill_action", "read_skill_or_doc", "assign_task", "terminal_exec", "files_agent_request", "remember", "recall", "email_send_draft", "custom_extension"];
    const context = buildToolPolicyExecutionContext({ provider: "home_inbox", profile: { ...DEFAULT_GROOVY_PROFILE, surface, toolPolicy: { mode: "allowlist", tools, dataSources: ["salesforce"] } } });
    assert.equal(isToolAllowed("web_search", context), true);
    assert.equal(isToolAllowed("WebSearch", context), true);
    for (const name of tools.slice(1)) assert.equal(isToolAllowed(name, context), false, name);
  }
  const all = buildToolPolicyExecutionContext({ provider: "home_inbox", profile: DEFAULT_GROOVY_PROFILE });
  assert.equal(isToolAllowed("run_skill_action", all), false);
  assert.equal(isToolAllowed("web_search", all), false);
});

test("internal default profiles retain the complete tool surface", () => {
  const context = buildToolPolicyExecutionContext({
    profile: DEFAULT_GROOVY_PROFILE,
    provider: "dashboard",
  });
  assert.equal(isToolAllowed("terminal_exec", context), true);
  assert.equal(isToolAllowed("assign_task", context), true);
  assert.equal(isToolAllowed("chat_resolve_channel", context), true);
  assert.equal(isToolAllowed("chat_send_message", context), true);
});

test("global Chat commands are unavailable to Team Chat, external Minds, and public API turns", () => {
  const liveVoice = buildToolPolicyExecutionContext({
    provider: "private_live_voice",
  });
  assert.equal(isToolAllowed("chat_resolve_channel", liveVoice), true);
  assert.equal(isToolAllowed("chat_send_message", liveVoice), true);

  for (const provider of [
    "team_chat",
    "team_chat_guest",
    "api",
    "scheduler_cloud",
    "whatsapp_web",
  ]) {
    const context = buildToolPolicyExecutionContext({ provider });
    assert.match(
      toolPolicyDenialReason("chat_resolve_channel", context) || "",
      /authenticated dashboard and Live voice/i,
      provider,
    );
    assert.match(
      toolPolicyDenialReason("chat_send_message", context) || "",
      /authenticated dashboard and Live voice/i,
      provider,
    );
  }

  assert.match(
    toolPolicyDenialReason("chat_send_message", null) || "",
    /authenticated dashboard and Live voice/i,
  );
});

test("in-app navigation is scoped exclusively to authenticated Live voice", () => {
  const liveVoice = buildToolPolicyExecutionContext({ provider: "private_live_voice" });
  assert.equal(toolPolicyDenialReason("app_navigate", liveVoice), null);

  for (const provider of ["dashboard", "team_chat", "api", "whatsapp_web"]) {
    const context = buildToolPolicyExecutionContext({ provider });
    assert.match(
      toolPolicyDenialReason("app_navigate", context) || "",
      /only to authenticated Live voice turns/i,
      provider,
    );
  }
  assert.match(
    toolPolicyDenialReason("app_navigate", null) || "",
    /only to authenticated Live voice turns/i,
  );
});

test("private Email tools are limited to authenticated dashboard and Live voice turns", () => {
  for (const provider of ["dashboard", "private_live_voice"]) {
    const context = buildToolPolicyExecutionContext({ provider });
    assert.equal(toolPolicyDenialReason("email_search", context), null);
    assert.equal(toolPolicyDenialReason("email_create_draft", context), null);
    assert.equal(toolPolicyDenialReason("email_send_draft", context), null);
  }

  for (const provider of [
    "team_chat",
    "team_chat_guest",
    "api",
    "scheduler_cloud",
    "whatsapp_web",
  ]) {
    const context = buildToolPolicyExecutionContext({ provider });
    assert.match(
      toolPolicyDenialReason("email_search", context) || "",
      /authenticated dashboard and Live voice/i,
      provider,
    );
  }
  assert.match(
    toolPolicyDenialReason("email_search", null) || "",
    /authenticated dashboard and Live voice/i,
  );
});

test("channel skill action authoring stays scoped to Team Chat", () => {
  const teamChat = buildToolPolicyExecutionContext({ provider: "team_chat" });
  const dashboard = buildToolPolicyExecutionContext({ provider: "dashboard" });
  assert.equal(
    toolPolicyDenialReason("update_channel_skill_actions", teamChat),
    null,
  );
  assert.match(
    toolPolicyDenialReason("update_channel_skill_actions", dashboard) || "",
    /only in Team Chat/i,
  );
});

test("internal allowlists are enforced", () => {
  const context = buildToolPolicyExecutionContext({
    profile: {
      ...DEFAULT_GROOVY_PROFILE,
      toolPolicy: { mode: "allowlist", tools: ["recall"] },
    },
    provider: "dashboard",
  });
  assert.equal(isToolAllowed("recall", context), true);
  assert.equal(isToolAllowed("remember", context), false);
  assert.equal(isToolAllowed("read_skill_or_doc", context), true);
});

test("external profiles are deny-by-default and hard-block connector tools", () => {
  const context = buildToolPolicyExecutionContext({
    profile: {
      ...DEFAULT_GROOVY_PROFILE,
      id: "external",
      authorizationStance: "restricted",
      surface: "external",
    },
    provider: "api",
  });
  assert.equal(isToolAllowed("web_search", context), true);
  assert.equal(isToolAllowed("recall", context), true);
  assert.equal(isToolAllowed("files_agent_request", context), true);
  assert.equal(isToolAllowed("data_query", context), false);
  assert.equal(isToolAllowed("assign_task", context), false);
  assert.equal(isToolAllowed("terminal_exec", context), false);
  assert.equal(isToolAllowed("browser_task", context), false);
  assert.equal(isToolAllowed("whatsapp_send_text", context), false);
});

test("web_search allowlists authorize the Anthropic WebSearch alias", () => {
  const context = buildToolPolicyExecutionContext({
    profile: {
      ...DEFAULT_GROOVY_PROFILE,
      id: "external",
      authorizationStance: "restricted",
      surface: "external",
      toolPolicy: { mode: "allowlist", tools: ["web_search"] },
    },
    provider: "api",
  });
  assert.equal(isToolAllowed("web_search", context), true);
  assert.equal(isToolAllowed("WebSearch", context), true);
});

test("external allowlists permit files and source-scoped data but not unsafe tools", () => {
  const context = buildToolPolicyExecutionContext({
    profile: {
      ...DEFAULT_GROOVY_PROFILE,
      id: "external",
      authorizationStance: "restricted",
      surface: "external",
      toolPolicy: {
        mode: "allowlist",
        tools: [
          "files_agent_request",
          "data_query",
          "terminal_exec",
          "gmail_send",
          "custom_extension_mutate",
        ],
        dataSources: ["gmail"],
      },
    },
    provider: "api",
  });
  assert.equal(isToolAllowed("data_query", context), true);
  assert.equal(isToolAllowed("files_agent_request", context), true);
  assert.equal(isToolAllowed("terminal_exec", context), false);
  assert.equal(isToolAllowed("gmail_send", context), false);
  assert.equal(isToolAllowed("custom_extension_mutate", context), false);
  assert.equal(
    toolPolicyParameterDenialReason("data_query", { provider: "gmail" }, context),
    null,
  );
  assert.ok(toolPolicyParameterDenialReason("data_query", { provider: "slack" }, context));
});

test("external Team Chat can use only its explicit channel agent roster", () => {
  const teamChat = buildToolPolicyExecutionContext({
    profile: {
      ...DEFAULT_GROOVY_PROFILE,
      id: "guest-mind",
      authorizationStance: "restricted",
      surface: "external",
      agentRoster: ["mind-default"],
    },
    provider: "team_chat_guest",
    allowedAgentIds: ["channel-agent"],
    agentRosterMode: "replace",
  });
  assert.deepEqual(teamChat.agentRoster, ["channel-agent"]);
  assert.equal(isToolAllowed("list_agents", teamChat), true);
  assert.equal(isToolAllowed("assign_task", teamChat), true);
  assert.equal(isToolAllowed("consult_agent", teamChat), true);
  assert.equal(isToolAllowed("terminal_exec", teamChat), true);
  assert.equal(isToolAllowed("read_skill_or_doc", teamChat), true);
  assert.equal(isToolAllowed("run_skill_action", teamChat), true);
  assert.equal(isToolAllowed("list_channel_skills", teamChat), true);
  assert.equal(isToolAllowed("create_channel_skill", teamChat), true);
  assert.equal(isToolAllowed("assign_channel_skill", teamChat), true);
  assert.equal(isToolAllowed("remove_channel_skill", teamChat), true);
  assert.equal(isToolAllowed("assign_skill_or_doc", teamChat), false);
  assert.equal(isToolAllowed("code_cli_run", teamChat), false);
  assert.equal(isToolAllowed("browser_task", teamChat), false);

  const publicApi = buildToolPolicyExecutionContext({
    profile: {
      ...DEFAULT_GROOVY_PROFILE,
      id: "guest-mind",
      authorizationStance: "restricted",
      surface: "external",
    },
    provider: "api",
    allowedAgentIds: ["channel-agent"],
    agentRosterMode: "replace",
  });
  assert.equal(isToolAllowed("assign_task", publicApi), false);
  assert.equal(isToolAllowed("terminal_exec", publicApi), false);
  assert.equal(isToolAllowed("read_skill_or_doc", publicApi), true);
  assert.equal(isToolAllowed("run_skill_action", publicApi), false);
  assert.equal(isToolAllowed("assign_channel_skill", publicApi), false);
  assert.equal(isToolAllowed("create_channel_skill", publicApi), false);
  assert.equal(isToolAllowed("remove_channel_skill", publicApi), false);
});

test("external Team Chat exposes channel schedules only to an authorized member turn", () => {
  const profile = {
    ...DEFAULT_GROOVY_PROFILE,
    id: "guest-mind",
    authorizationStance: "restricted" as const,
    surface: "external" as const,
    memoryScope: "profile" as const,
    toolPolicy: { mode: "allowlist" as const, tools: [] },
  };
  const memberTurn = buildToolPolicyExecutionContext({
    profile,
    provider: "team_chat_guest",
    canManageTeamChatSchedules: true,
  });
  assert.equal(isToolAllowed("schedule_create", memberTurn), true);
  assert.equal(isToolAllowed("schedule_list", memberTurn), true);
  assert.equal(isToolAllowed("schedule_update", memberTurn), true);
  assert.equal(isToolAllowed("schedule_pause", memberTurn), true);

  const guestTurn = buildToolPolicyExecutionContext({
    profile,
    provider: "team_chat_guest",
  });
  assert.equal(isToolAllowed("schedule_create", guestTurn), false);
  assert.equal(isToolAllowed("schedule_list", guestTurn), false);

  const publicApi = buildToolPolicyExecutionContext({
    profile,
    provider: "api",
    canManageTeamChatSchedules: true,
  });
  assert.equal(isToolAllowed("schedule_create", publicApi), false);
});

test("API provider classification covers every connector capability family", () => {
  for (const toolName of [
    "terminal_exec",
    "code_cli_run",
    "code_terminal_step",
    "code_open_session",
    "computer_use_action",
    "browser_task",
    "browser_navigate",
    "credential_get",
    "files_read",
    "linkdb_query",
    "sqlite_query",
    "obsidian_read",
    "whatsapp_send_text",
    "site_dev",
    "site_publish",
    "runtime_branch_parallel",
    "skill_registry_validate_draft",
    "run_skill_action",
  ]) {
    assert.equal(isConnectorToolName(toolName), true, toolName);
  }
  assert.equal(isConnectorToolName("files_agent_request"), false);
  assert.equal(isConnectorToolName("web_search"), false);
});

test("agent rosters filter both discovery and delegation candidates", () => {
  assert.deepEqual(
    filterAgentRoster(
      [
        { id: "a", name: "A" },
        { id: "b", name: "B" },
      ],
      ["b"],
    ),
    [{ id: "b", name: "B" }],
  );
});

test("caller agent rosters narrow a Mind roster and can deny every agent", () => {
  const narrowed = buildToolPolicyExecutionContext({
    profile: {
      ...DEFAULT_GROOVY_PROFILE,
      agentRoster: ["profile-only", "shared"],
    },
    provider: "team_chat",
    allowedAgentIds: ["shared", "channel-only", "shared"],
  });
  assert.deepEqual(narrowed.agentRoster, ["shared"]);

  const unrestrictedMind = buildToolPolicyExecutionContext({
    profile: DEFAULT_GROOVY_PROFILE,
    provider: "team_chat",
    allowedAgentIds: ["selected"],
  });
  assert.deepEqual(unrestrictedMind.agentRoster, ["selected"]);

  const denyAll = buildToolPolicyExecutionContext({
    profile: DEFAULT_GROOVY_PROFILE,
    provider: "team_chat",
    allowedAgentIds: [],
  });
  assert.deepEqual(denyAll.agentRoster, []);
});

test("an admin-managed channel roster can replace Mind defaults", () => {
  const channelScoped = buildToolPolicyExecutionContext({
    profile: {
      ...DEFAULT_GROOVY_PROFILE,
      agentRoster: ["mind-default"],
    },
    provider: "team_chat",
    allowedAgentIds: ["channel-a", "channel-b", "channel-a"],
    agentRosterMode: "replace",
  });
  assert.deepEqual(channelScoped.agentRoster, ["channel-a", "channel-b"]);
  assert.equal(isToolAllowed("assign_channel_skill", channelScoped), true);
  assert.equal(isToolAllowed("list_skills_and_docs", channelScoped), false);
  assert.equal(isToolAllowed("assign_skill_or_doc", channelScoped), false);
  assert.equal(
    isToolAllowed("remove_skill_or_doc_assignment", channelScoped),
    false,
  );
});

test("verified Team Chat admins may manage workspace assignments", () => {
  const admin = buildToolPolicyExecutionContext({
    provider: "team_chat",
    canManageWorkspaceAssignments: true,
  });
  assert.equal(isToolAllowed("assign_skill_or_doc", admin), true);
  assert.equal(isToolAllowed("set_workspace_secret_assignment", admin), true);

  const member = buildToolPolicyExecutionContext({ provider: "team_chat" });
  assert.equal(isToolAllowed("assign_skill_or_doc", member), false);
  assert.equal(isToolAllowed("set_workspace_secret_assignment", member), false);
});

test("a caller can narrow profile memory to a per-thread namespace", () => {
  const context = buildToolPolicyExecutionContext({
    profile: {
      ...DEFAULT_GROOVY_PROFILE,
      id: "profile-id",
      memoryScope: "profile",
    },
    provider: "api",
    memoryScopeId: "thread-id",
  });
  assert.equal(context.profileId, "profile-id");
  assert.equal(context.memoryScopeId, "thread-id");
});
