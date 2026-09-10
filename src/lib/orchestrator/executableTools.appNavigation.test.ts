import assert from "node:assert/strict";
import test from "node:test";
import type { AppUiAction } from "@/lib/navigation/appUiAction";
import {
  appNavigateSchema,
  createExecutableTools,
  toolDefinitions,
} from "./executableTools";
import { buildToolPolicyExecutionContext } from "./toolPolicy";

function liveContext(onUiAction?: (action: AppUiAction) => void) {
  return {
    userId: "user-1",
    toolPolicy: buildToolPolicyExecutionContext({ provider: "private_live_voice" }),
    onUiAction,
  };
}

test("Live voice exposes model-driven app navigation only with an interactive client", () => {
  assert.ok(createExecutableTools(liveContext(() => undefined)).app_navigate);
  assert.equal(createExecutableTools(liveContext()).app_navigate, undefined);

  const dashboardPolicy = buildToolPolicyExecutionContext({ provider: "dashboard" });
  assert.equal(
    createExecutableTools({
      userId: "user-1",
      toolPolicy: dashboardPolicy,
      onUiAction: () => undefined,
    }).app_navigate,
    undefined,
  );
  assert.match(toolDefinitions.app_navigate.description, /regardless of how they phrase it/i);
  assert.match(toolDefinitions.app_navigate.description, /does not require confirmation/i);
});

test("app navigation turns the model's typed destination into a trusted UI action", async () => {
  const actions: AppUiAction[] = [];
  const tools = createExecutableTools(liveContext((action) => actions.push(action)));
  assert.ok(tools.app_navigate);

  const output = JSON.parse(
    await tools.app_navigate.execute(appNavigateSchema.parse({ destination: "email" })),
  ) as Record<string, unknown>;

  assert.deepEqual(actions, [{ type: "open_email", url: "/email", label: "Email" }]);
  assert.deepEqual(output, {
    opened: true,
    destination: "email",
    url: "/email",
    label: "Email",
  });
});

test("app navigation supports each bounded top-level destination", async () => {
  const expected: Record<string, AppUiAction> = {
    command_center: { type: "navigate", url: "/dashboard", label: "Command Center" },
    email: { type: "open_email", url: "/email", label: "Email" },
    chat: { type: "open_chat", url: "/chat", label: "Chat" },
    settings: { type: "navigate", url: "/settings", label: "Settings" },
  };

  for (const destination of appNavigateSchema.shape.destination.options) {
    const actions: AppUiAction[] = [];
    const tools = createExecutableTools(liveContext((action) => actions.push(action)));
    assert.ok(tools.app_navigate);
    await tools.app_navigate.execute({ destination });
    assert.deepEqual(actions, [expected[destination]], destination);
  }
});
