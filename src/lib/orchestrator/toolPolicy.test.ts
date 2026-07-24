import { strict as assert } from "node:assert";
import test from "node:test";
import {
  buildToolPolicyExecutionContext,
  filterAgentRoster,
  isConnectorToolName,
  isToolAllowed,
  toolPolicyParameterDenialReason,
} from "./toolPolicy";
import { DEFAULT_GROOVY_PROFILE } from "./harnessProfiles";

test("internal default profiles retain the complete tool surface", () => {
  const context = buildToolPolicyExecutionContext({
    profile: DEFAULT_GROOVY_PROFILE,
    provider: "dashboard",
  });
  assert.equal(isToolAllowed("terminal_exec", context), true);
  assert.equal(isToolAllowed("assign_task", context), true);
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
