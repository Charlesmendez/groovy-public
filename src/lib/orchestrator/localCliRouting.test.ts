import { strict as assert } from "node:assert";
import test from "node:test";
import {
  explicitlyRequestsWorker,
  shouldUseDirectLocalCliForDiagnostic,
} from "./localCliRouting";

const workers = ["Compensar", "Compensar 2", "Hibe"];

test("plain project diagnostics stay with the Mind's local CLI", () => {
  assert.equal(
    shouldUseDirectLocalCliForDiagnostic({
      message:
        "@internalops can you now check the Vercel logs in the Compensar project and see what is the reason of the failure of the last commit?",
      workerNames: workers,
    }),
    true,
  );
  assert.equal(
    shouldUseDirectLocalCliForDiagnostic({
      message: "Please inspect the latest deployment status for Hibe.",
      workerNames: workers,
    }),
    true,
  );
});

test("a project name is not treated as a worker assignment", () => {
  assert.equal(
    explicitlyRequestsWorker({
      message: "Check the logs in the Compensar project.",
      workerNames: workers,
    }),
    false,
  );
});

test("explicit worker assignments keep delegation available", () => {
  for (const message of [
    "@Compensar check the Vercel logs.",
    "Ask Compensar to check the deployment logs.",
    "Delegate this to Compensar 2 and inspect the build failure.",
    "Hibe: check the service status.",
  ]) {
    assert.equal(
      shouldUseDirectLocalCliForDiagnostic({
        message,
        workerNames: workers,
      }),
      false,
      message,
    );
  }
});

test("mutating and broad repository work remains worker-owned", () => {
  for (const message of [
    "Check the Vercel logs and fix the deployment.",
    "Inspect the error and implement the solution.",
    "Do a comprehensive review of the build system.",
    "Review the entire repository for deployment problems.",
  ]) {
    assert.equal(
      shouldUseDirectLocalCliForDiagnostic({
        message,
        workerNames: workers,
      }),
      false,
      message,
    );
  }
});
