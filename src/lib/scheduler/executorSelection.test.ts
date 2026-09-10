import assert from "node:assert/strict";
import test from "node:test";
import { resolveScheduledExecutionDeviceId } from "./executorSelection";

test("worker schedules use the worker connector instead of a generic account device", () => {
  assert.equal(
    resolveScheduledExecutionDeviceId({
      fallbackDeviceId: "recent-device",
      workerDeviceId: "worker-device",
    }),
    "worker-device",
  );
  assert.equal(
    resolveScheduledExecutionDeviceId({
      fallbackDeviceId: "recent-device",
      workerDeviceId: null,
    }),
    "recent-device",
  );
  assert.equal(
    resolveScheduledExecutionDeviceId({
      fallbackDeviceId: null,
      workerDeviceId: "worker-device",
    }),
    "worker-device",
  );
});
