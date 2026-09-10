import assert from "node:assert/strict";
import test from "node:test";
import {
  schedulerDispatchRedirectTarget,
  schedulerDispatchUrl,
} from "./cloudRunner";

test("dispatches scheduled jobs through the stable public app origin", () => {
  assert.equal(
    schedulerDispatchUrl("https://www.gogroovy.ai"),
    "https://www.gogroovy.ai/api/scheduler/run",
  );
});

test("allows the scheduler endpoint to follow the app's www canonical redirect", () => {
  assert.equal(
    schedulerDispatchRedirectTarget(
      "https://gogroovy.ai/api/scheduler/run",
      "https://www.gogroovy.ai/api/scheduler/run",
    ),
    "https://www.gogroovy.ai/api/scheduler/run",
  );
});

test("allows the reverse www redirect for custom-domain configurations", () => {
  assert.equal(
    schedulerDispatchRedirectTarget(
      "https://www.example.com/api/scheduler/run",
      "https://example.com/api/scheduler/run",
    ),
    "https://example.com/api/scheduler/run",
  );
});

test("never forwards scheduler credentials to an unrelated host or path", () => {
  assert.equal(
    schedulerDispatchRedirectTarget(
      "https://gogroovy.ai/api/scheduler/run",
      "https://attacker.example/api/scheduler/run",
    ),
    null,
  );
  assert.equal(
    schedulerDispatchRedirectTarget(
      "https://gogroovy.ai/api/scheduler/run",
      "https://www.gogroovy.ai/collect",
    ),
    null,
  );
  assert.equal(
    schedulerDispatchRedirectTarget(
      "https://gogroovy.ai/api/scheduler/run",
      "http://www.gogroovy.ai/api/scheduler/run",
    ),
    null,
  );
});
