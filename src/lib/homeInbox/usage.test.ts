import assert from "node:assert/strict";
import { test } from "node:test";
import {
  agentSdkUsageObservations,
  createUsageRecorder,
  usageComponent,
  type HarnessUsageReceipt,
} from "./usage";
const observed = (usage: unknown, id = "step-1") => ({
  id,
  provider: "test-provider",
  model: "test-model",
  usage,
});

test("missing, fractional, negative and unsafe counts remain unknown, not zero", () => {
  for (const usage of [
    null,
    {},
    { inputTokens: -1 },
    { inputTokens: 1.5 },
    { inputTokens: Infinity },
    { inputTokens: "50" },
  ]) {
    assert.equal(usageComponent(observed(usage)).input_tokens, null);
    assert.equal(usageComponent(observed(usage)).provider_cost_usd, null);
  }
  assert.equal(
    usageComponent(observed({ inputTokens: 0, outputTokens: 0 })).input_tokens,
    0,
  );
});
test("AI SDK totals include cache already; Anthropic direct totals exclude cache", () => {
  const sdk = usageComponent(
    observed({
      inputTokens: 100,
      outputTokens: 10,
      inputTokenDetails: { cacheReadTokens: 60, cacheWriteTokens: 20 },
    }),
  );
  const direct = usageComponent(
    observed({
      input_tokens: 20,
      output_tokens: 10,
      cache_read_input_tokens: 60,
      cache_creation_input_tokens: 20,
    }),
  );
  assert.deepEqual(sdk, direct);
  assert.equal(sdk.input_tokens, 100);
});
test("each Agent SDK model is measured independently, including explicit zero provider cost", () => {
  const values = agentSdkUsageObservations({
    id: "receipt",
    model: "default-not-used",
    modelUsage: {
      brain: {
        inputTokens: 20,
        outputTokens: 10,
        cacheReadInputTokens: 60,
        cacheCreationInputTokens: 20,
        costUSD: 0.125,
      },
      helper: {
        inputTokens: 5,
        outputTokens: 2,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        costUSD: 0,
      },
    },
  }).map(usageComponent);
  assert.equal(values.length, 2);
  assert.equal(values[0].model, "brain");
  assert.equal(values[0].input_tokens, 100);
  assert.equal(values[0].provider_cost_usd, 0.125);
  assert.equal(values[1].provider_cost_usd, 0);
});
test("an aggregate fallback uses provider-reported usage, never invented per-model counters", () => {
  const [value] = agentSdkUsageObservations({
    id: "receipt",
    model: "selected",
    usage: { input_tokens: 20, output_tokens: 4 },
    totalCostUsd: 0.1,
  });
  assert.equal(usageComponent(value).input_tokens, 20);
  assert.equal(usageComponent(value).provider_cost_usd, 0.1);
});
test("invalid cache subdivisions do not fabricate cache savings", () => {
  const value = usageComponent(
    observed({ inputTokens: 10, outputTokens: 1, cachedInputTokens: 12 }),
  );
  assert.equal(value.cached_input_tokens, null);
});
test("replays count once; changed receipts preserve the original and mark accounting partial", async () => {
  const recorder = createUsageRecorder(async () => {});
  await recorder.observe(observed({ inputTokens: 10, outputTokens: 2 }));
  await recorder.observe(observed({ inputTokens: 10, outputTokens: 2 }));
  assert.equal((await recorder.finish(true)).components.length, 1);
  await recorder.observe(observed({ inputTokens: 30, outputTokens: 2 }));
  const result = await recorder.finish(true);
  assert.equal(result.status, "partial");
  assert.equal(result.components[0].input_tokens, 10);
});
test("overlapping callbacks persist ordered immutable snapshots", async () => {
  const saved: HarnessUsageReceipt[] = [];
  const recorder = createUsageRecorder(async (value) => {
    await Promise.resolve();
    saved.push(value);
  });
  await Promise.all([
    recorder.observe(observed({ inputTokens: 10, outputTokens: 2 })),
    recorder.observe(observed({ inputTokens: 20, outputTokens: 3 }, "step-2")),
  ]);
  await recorder.finish(true);
  assert.deepEqual(
    saved.map((value) => value.components.length),
    [1, 2, 2],
  );
  assert.equal(saved.at(-1)?.status, "reported");
});
test("failed and unknown runs retain completed provider work without claiming complete usage", async () => {
  const recorder = createUsageRecorder(async () => {});
  await recorder.observe(observed({ inputTokens: 10, outputTokens: 2 }));
  const failed = await recorder.finish(false);
  assert.equal(failed.status, "partial");
  assert.equal(failed.components.length, 1);
  recorder.markIncomplete();
  assert.equal((await recorder.finish(true)).status, "partial");
});
test("accounting outages never escape into model fallback; final save retries only data", async () => {
  let calls = 0;
  const recorder = createUsageRecorder(async () => {
    if (++calls === 1) throw new Error("offline");
  });
  await recorder.observe(observed({ inputTokens: 10, outputTokens: 2 }));
  assert.equal((await recorder.finish(true)).components.length, 1);
  assert.equal(calls, 2);
});
test("terminal persistence failure is visible and empty legacy usage is unavailable", async () => {
  const recorder = createUsageRecorder(async () => {
    throw new Error("offline");
  });
  await assert.rejects(recorder.finish(true), /offline/);
  assert.equal(recorder.snapshot().status, "partial");
});
test("receipt size is bounded and overflow marks incomplete instead of truncating silently", async () => {
  const recorder = createUsageRecorder(async () => {});
  for (let n = 0; n < 129; n++)
    await recorder.observe(
      observed({ inputTokens: 1, outputTokens: 1 }, `step-${n}`),
    );
  const value = await recorder.finish(true);
  assert.equal(value.components.length, 128);
  assert.equal(value.status, "partial");
});
