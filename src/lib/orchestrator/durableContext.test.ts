import assert from "node:assert/strict";
import test from "node:test";
import {
  checkpointRollupCount,
  durableContextScopeKey,
} from "./durableContextPolicy";

test("durable context scope follows branch, epoch, then session", () => {
  assert.equal(durableContextScopeKey({}), "session");
  assert.equal(
    durableContextScopeKey({ epochId: "epoch-1" }),
    "epoch:epoch-1",
  );
  assert.equal(
    durableContextScopeKey({
      epochId: "epoch-1",
      branchId: "branch-1",
      useBranchScope: true,
    }),
    "branch:branch-1",
  );
});

test("checkpoint rollup keeps a bounded recent message tail", () => {
  const withinLimit = Array.from({ length: 160 }, () => ({ content: "ok" }));
  assert.equal(checkpointRollupCount(withinLimit), 0);

  const overMessageLimit = Array.from({ length: 161 }, () => ({
    content: "ok",
  }));
  assert.equal(checkpointRollupCount(overMessageLimit), 81);

  const overCharacterLimit = Array.from({ length: 31 }, () => ({
    content: "x".repeat(10_000),
  }));
  assert.equal(checkpointRollupCount(overCharacterLimit), 19);

  const historicalOversizedMessage = [
    { content: "x".repeat(400_000) },
    { content: "current request" },
  ];
  assert.equal(checkpointRollupCount(historicalOversizedMessage), 1);
});
