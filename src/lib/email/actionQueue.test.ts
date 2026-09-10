import assert from "node:assert/strict";
import test from "node:test";
import {
  emailActionRetryDelayMs,
  retryableEmailActionError,
  runEmailActionWithRetry,
  SerialEmailActionQueue,
} from "./actionQueue";

test("email action queue runs mutations one at a time in FIFO order", async () => {
  const queue = new SerialEmailActionQueue();
  const events: string[] = [];
  let active = 0;
  let maxActive = 0;

  const finished = ["first", "second", "third"].map(
    (key) =>
      new Promise<void>((resolve) => {
        assert.equal(
          queue.enqueue({
            key,
            run: async () => {
              active += 1;
              maxActive = Math.max(maxActive, active);
              events.push(`start:${key}`);
              await Promise.resolve();
              events.push(`finish:${key}`);
              active -= 1;
              resolve();
            },
          }),
          true,
        );
      }),
  );

  await Promise.all(finished);
  assert.equal(maxActive, 1);
  assert.deepEqual(events, [
    "start:first",
    "finish:first",
    "start:second",
    "finish:second",
    "start:third",
    "finish:third",
  ]);
});

test("a failed queued mutation does not block the next mutation", async () => {
  const queue = new SerialEmailActionQueue();
  const events: string[] = [];
  let finishSecond: (() => void) | null = null;
  const secondFinished = new Promise<void>((resolve) => {
    finishSecond = resolve;
  });

  queue.enqueue({
    key: "first",
    run: async () => {
      events.push("first");
      throw new Error("rejected");
    },
  });
  queue.enqueue({
    key: "second",
    run: async () => {
      events.push("second");
      finishSecond?.();
    },
  });

  await secondFinished;
  await Promise.resolve();
  assert.deepEqual(events, ["first", "second"]);
  assert.equal(queue.size, 0);
});

test("email action retries only transient failures and honors server delay", async () => {
  let attempts = 0;
  const states: string[] = [];
  const delays: number[] = [];

  const result = await runEmailActionWithRetry({
    execute: async () => {
      attempts += 1;
      if (attempts < 3) {
        throw Object.assign(new Error("Rate limit exceeded"), {
          status: 429,
          payload: { retryable: true, retryAfterMs: 2_500 },
        });
      }
      return "confirmed";
    },
    onState: (state) => states.push(state.phase),
    sleep: async (delayMs) => {
      delays.push(delayMs);
    },
  });

  assert.equal(attempts, 3);
  assert.deepEqual(states, [
    "processing",
    "retrying",
    "processing",
    "retrying",
    "processing",
  ]);
  assert.deepEqual(delays, [2_500, 3_000]);
  assert.equal(result, "confirmed");
});

test("email action retry policy retries server failures but not client errors", () => {
  assert.equal(retryableEmailActionError({ status: 429 }), true);
  assert.equal(retryableEmailActionError({ status: 503 }), true);
  assert.equal(retryableEmailActionError({ status: 400 }), false);
  assert.equal(retryableEmailActionError({ status: 500 }), true);
  assert.equal(
    emailActionRetryDelayMs(
      { payload: { retryAfterMs: 120_000 } },
      1_000,
    ),
    20_000,
  );
});
