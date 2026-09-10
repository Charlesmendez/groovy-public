import assert from "node:assert/strict";
import test from "node:test";
import {
  mergeEmailNavigationStats,
  navigationStatsFromCachedFeeds,
  type EmailNavigationStats,
} from "./navigationStats";

const focusStats: EmailNavigationStats = {
  focus: 12,
  processed: 40,
  draftsReady: 4,
  needsReview: 3,
  noiseCaught: 8,
};

test("Needs Review cannot replace an authoritative Focus count with its estimate", () => {
  assert.deepEqual(
    mergeEmailNavigationStats({
      current: focusStats,
      incoming: {
        focus: 5,
        processed: 41,
        draftsReady: 2,
        needsReview: 99,
        noiseCaught: 9,
      },
      sourceView: "inbox",
      authoritativeNeedsReviewCount: 6,
    }),
    {
      focus: 12,
      processed: 41,
      draftsReady: 4,
      needsReview: 6,
      noiseCaught: 9,
    },
  );
});

test("a completed Focus load replaces the Focus count", () => {
  assert.equal(
    mergeEmailNavigationStats({
      current: focusStats,
      incoming: { ...focusStats, focus: 14 },
      sourceView: "focus",
    }).focus,
    14,
  );
});

test("cache hydration takes Focus totals from the Focus cache", () => {
  assert.deepEqual(
    navigationStatsFromCachedFeeds({
      fallback: { ...focusStats, focus: 5, draftsReady: 2 },
      focus: focusStats,
      needsReviewCount: 7,
    }),
    { ...focusStats, needsReview: 7 },
  );
});
