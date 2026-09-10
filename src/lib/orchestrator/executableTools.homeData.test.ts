import assert from "node:assert/strict";
import test from "node:test";
import { createExecutableTools } from "./executableTools";
import { executeTool, type ToolExecutionContext } from "./toolExecutor";
import { buildToolPolicyExecutionContext, isToolAllowed } from "./toolPolicy";
import { HOME_DATA_TOOLS } from "../homeInbox/dataContracts";
import { profile } from "../homeInbox/fixtures.test-support";

function context(provider = "home_inbox"): ToolExecutionContext {
  return {
    userId: "synthetic-owner",
    toolPolicy: buildToolPolicyExecutionContext({
      provider,
      profile: {
        ...profile,
        toolPolicy: { mode: "allowlist", tools: [...HOME_DATA_TOOLS] },
      },
    }),
    actionAuthorization: "confirmation_required",
    homeData: {
      execute: async () => ({ records: [], limit_reached: false }),
      assertHealthy() {},
    },
  };
}

test("Home tools require a trusted decision bridge and an explicit Mind allowlist", () => {
  const ctx = context();
  assert.deepEqual(
    Object.keys(createExecutableTools(ctx)).sort(),
    [...HOME_DATA_TOOLS].sort(),
  );
  assert.deepEqual(
    Object.keys(createExecutableTools({ ...ctx, homeData: undefined })),
    [],
  );
  const noGrants = {
    ...ctx,
    toolPolicy: buildToolPolicyExecutionContext({
      provider: "home_inbox",
      profile,
    }),
  };
  for (const name of HOME_DATA_TOOLS) {
    assert.equal(createExecutableTools(noGrants)[name], undefined);
    assert.equal(isToolAllowed(name, undefined), false);
  }
});

test("dashboard, public API, voice, schedules and channel Minds cannot obtain Home data via an allowlist", async () => {
  for (const provider of [
    "dashboard",
    "api",
    "private_live_voice",
    "scheduler_cloud",
    "team_chat",
    "team_chat_guest",
    "whatsapp_web",
  ]) {
    const ctx = context(provider);
    let called = false;
    ctx.homeData!.execute = async () => {
      called = true;
      return {};
    };
    for (const name of HOME_DATA_TOOLS) {
      assert.equal(createExecutableTools(ctx)[name], undefined);
      assert.equal((await executeTool(name, {}, ctx)).success, false);
    }
    assert.equal(called, false);
  }
});

test("actual executor invokes the read bridge without generic parameter logs or extension dispatch", async () => {
  const ctx = context();
  const calls: unknown[] = [];
  // A colliding extension entry must never receive the project's customer data.
  ctx.extensionToolsByName = { home_data_read: { riskLevel: "read" } as never };
  ctx.homeData!.execute = async (tool, input) => {
    calls.push({ tool, input });
    return { records: [{ client_field: "synthetic-private-result" }] };
  };
  const logs: unknown[][] = [];
  const original = console.log;
  console.log = (...args) => {
    logs.push(args);
  };
  try {
    const tools = createExecutableTools(ctx);
    const parameters = {
      operation_id: profile.id,
      parameters: { customer: "synthetic-private-input" },
    };
    const result = JSON.parse(await tools.home_data_read.execute(parameters));
    assert.deepEqual(calls, [{ tool: "home_data_read", input: parameters }]);
    assert.deepEqual(result.records, [
      { client_field: "synthetic-private-result" },
    ]);
    assert.doesNotMatch(JSON.stringify(logs), /synthetic-private/);
    ctx.homeData!.execute = async () => {
      throw new Error("synthetic-private-provider-error");
    };
    const failed = await tools.home_data_read.execute(parameters);
    assert.match(failed, /held/);
    assert.doesNotMatch(failed, /synthetic-private/);
    assert.doesNotMatch(JSON.stringify(logs), /synthetic-private/);
  } finally {
    console.log = original;
  }
});

test("Home decision tools cannot smuggle messaging, schedules or general data operations", async () => {
  const ctx = context();
  let called = false;
  ctx.homeData!.execute = async () => {
    called = true;
    return {};
  };
  for (const name of [
    "data_query",
    "run_skill_action",
    "assign_task",
    "schedule_create",
    "chat_send_message",
    "email_send_draft",
    "remember",
  ]) {
    assert.equal((await executeTool(name, {}, ctx)).success, false);
  }
  assert.equal(called, false);
  const tools = createExecutableTools(ctx);
  assert.equal(
    tools.home_data_read.inputSchema.safeParse({
      operation_id: profile.id,
      parameters: {},
      query: "UPDATE",
    }).success,
    false,
  );
  assert.equal(
    tools.home_data_operations.inputSchema.safeParse({ tenant_id: profile.id })
      .success,
    false,
  );
});
