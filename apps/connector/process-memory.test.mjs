import assert from "node:assert/strict";
import test from "node:test";
import { summarizeProcessTreeMemory } from "./platform/process/index.mjs";

test("summarizes RSS for a process and all descendants", () => {
  const result = summarizeProcessTreeMemory(
    [
      { pid: 10, parentPid: 1, rssBytes: 100 },
      { pid: 11, parentPid: 10, rssBytes: 200 },
      { pid: 12, parentPid: 10, rssBytes: 300 },
      { pid: 13, parentPid: 11, rssBytes: 400 },
      { pid: 20, parentPid: 1, rssBytes: 10_000 },
    ],
    10
  );

  assert.deepEqual(result, {
    rootPid: 10,
    processCount: 4,
    totalRssBytes: 1_000,
    maxRssBytes: 400,
  });
});

test("returns null when the process tree root is absent", () => {
  assert.equal(summarizeProcessTreeMemory([], 10), null);
});
