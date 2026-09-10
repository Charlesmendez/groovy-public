import assert from "node:assert/strict";
import test from "node:test";
import {
  cleanEmailAssistOutput,
  generateEmailAssistWithRecovery,
} from "./assistGeneration";

test("email completion retries one empty Luna response with a stricter prompt", async () => {
  const prompts: string[] = [];
  const result = await generateEmailAssistWithRecovery({
    task: "complete",
    prompt: "Continue this email.",
    generate: async (prompt) => {
      prompts.push(prompt);
      return prompts.length === 1
        ? { text: "", finishReason: "stop", outputTokens: 0 }
        : { text: "I will follow up tomorrow.", finishReason: "stop" };
    },
  });

  assert.equal(result.status, "suggestion");
  assert.equal(result.text, "I will follow up tomorrow.");
  assert.equal(result.attempts, 2);
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /do not return an empty response/i);
});

test("two empty completion responses become a normal no-suggestion result", async () => {
  let calls = 0;
  const result = await generateEmailAssistWithRecovery({
    task: "complete",
    prompt: "Continue this email.",
    generate: async () => {
      calls += 1;
      return { text: "   ", finishReason: "stop", outputTokens: 0 };
    },
  });

  assert.equal(calls, 2);
  assert.equal(result.status, "no_suggestion");
  assert.equal(result.text, "");
  assert.equal(result.attempts, 2);
});

test("non-completion email assistance is never retried automatically", async () => {
  let calls = 0;
  const result = await generateEmailAssistWithRecovery({
    task: "rewrite",
    prompt: "Rewrite this email.",
    generate: async () => {
      calls += 1;
      return { text: "" };
    },
  });

  assert.equal(calls, 1);
  assert.equal(result.status, "no_suggestion");
});

test("provider failures remain failures instead of becoming no-suggestion results", async () => {
  await assert.rejects(
    generateEmailAssistWithRecovery({
      task: "complete",
      prompt: "Continue this email.",
      generate: async () => {
        throw new Error("rate_limit_exceeded");
      },
    }),
    /rate_limit_exceeded/,
  );
});

test("email assistance strips fenced model output", () => {
  assert.equal(
    cleanEmailAssistOutput("```text\nI will follow up tomorrow.\n```"),
    "I will follow up tomorrow.",
  );
});
