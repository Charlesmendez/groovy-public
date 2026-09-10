import assert from "node:assert/strict";
import test from "node:test";
import {
  assertUsableModelRound,
  EmptyModelResponseError,
  isInsufficientQuotaError,
  ModelStreamCompletionError,
  modelStreamEventError,
  quotaExhaustedResponseText,
} from "./modelStreamReliability";

test("rejects an empty provider turn instead of treating it as success", () => {
  assert.throws(
    () =>
      assertUsableModelRound({
        text: "",
        finishReason: "error",
      }),
    (error) =>
      error instanceof EmptyModelResponseError &&
      error.finishReason === "error",
  );
});

test("accepts text, tool output, or a continuation request", () => {
  assert.doesNotThrow(() => assertUsableModelRound({ text: "Done." }));
  assert.doesNotThrow(() =>
    assertUsableModelRound({ text: "", toolOutputText: "Tool result" }),
  );
  assert.doesNotThrow(() =>
    assertUsableModelRound({ text: "", connectorExecuteCount: 1 }),
  );
});

test("preserves provider status fields from AI SDK error events", () => {
  const error = modelStreamEventError({
    message: "Provider overloaded",
    statusCode: 529,
    responseBody: "{\"type\":\"overloaded_error\"}",
  }) as Error & { statusCode?: number; responseBody?: string };
  assert.equal(error.message, "Provider overloaded");
  assert.equal(error.statusCode, 529);
  assert.equal(error.responseBody, "{\"type\":\"overloaded_error\"}");
});

test("normalizes and classifies the OpenAI Responses API quota event", () => {
  const error = modelStreamEventError({
    type: "error",
    sequence_number: 2,
    error: {
      type: "insufficient_quota",
      code: "insufficient_quota",
      message:
        "You exceeded your current quota, please check your plan and billing details.",
      param: null,
    },
  }) as Error & { code?: string; type?: string };

  assert.equal(
    error.message,
    "You exceeded your current quota, please check your plan and billing details.",
  );
  assert.equal(error.code, "insufficient_quota");
  assert.equal(error.type, "insufficient_quota");
  assert.equal(isInsufficientQuotaError(error), true);
});

test("does not classify an ordinary request rate limit as exhausted quota", () => {
  assert.equal(
    isInsufficientQuotaError({
      code: "rate_limit_exceeded",
      message: "Rate limit reached for requests. Please retry after 20 seconds.",
    }),
    false,
  );
});

test("builds key-owner-specific quota responses", () => {
  assert.match(
    quotaExhaustedResponseText({
      provider: "openai",
      keyMode: "groovy",
    }),
    /Groovy's managed OpenAI API key/,
  );
  assert.match(
    quotaExhaustedResponseText({
      provider: "openai",
      keyMode: "user",
    }),
    /project linked to your OpenAI API key/,
  );
});

test("represents an error finish as a retryable failed completion", () => {
  const error = new ModelStreamCompletionError("error");
  assert.equal(error.finishReason, "error");
  assert.match(error.message, /finish reason "error"/);
});
