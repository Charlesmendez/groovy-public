import assert from "node:assert/strict";
import test from "node:test";
import { resolveChatRoundText } from "./orchestratorResponse";

test("keeps a normal final assistant response", () => {
  assert.equal(
    resolveChatRoundText({ kind: "final", text: "Here is the result." }),
    "Here is the result.",
  );
});

test("extracts a delegated task message from wrapped tool output", () => {
  assert.equal(
    resolveChatRoundText({
      kind: "final",
      text: "",
      toolOutputText: JSON.stringify({
        success: true,
        result: { message: "Task queued on Groovy." },
      }),
    }),
    "Task queued on Groovy.",
  );
});

test("never reports an empty turn as Done", () => {
  assert.equal(
    resolveChatRoundText({ kind: "final", text: "", toolOutputText: "" }),
    "Groovy could not produce a response for this turn. Please try again.",
  );
});

test("explains unsupported connector round trips", () => {
  assert.equal(
    resolveChatRoundText({ kind: "needs_connector" }),
    "This channel turn could not be completed without a local connector.",
  );
});
