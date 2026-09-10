import assert from "node:assert/strict";
import test from "node:test";
import {
  clearEmailFeedCache,
  type EmailFeedCacheStorage,
} from "./feedCache";
import { EMAIL_FEED_SCHEMA_VERSION, type EmailFeedResponse } from "./types";
import {
  clearEmailNavigationFeedsForTest,
  EMAIL_NAVIGATION_FEED_MAX_AGE_MS,
  readEmailNavigationFeed,
  readEmailNavigationLocation,
  rememberEmailNavigationFeed,
  shouldPersistEmailNavigationAcrossLaunches,
  shouldRefreshRestoredEmailNavigation,
} from "./navigationFeed";

class MemoryStorage implements EmailFeedCacheStorage {
  private readonly values = new Map<string, string>();

  get length() {
    return this.values.size;
  }

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }

  removeItem(key: string) {
    this.values.delete(key);
  }

  key(index: number) {
    return Array.from(this.values.keys())[index] ?? null;
  }
}

const focusFeed: EmailFeedResponse = {
  schemaVersion: EMAIL_FEED_SCHEMA_VERSION,
  view: "focus",
  mailboxes: [],
  threads: [],
  nextCursor: null,
  warnings: [],
  stats: {
    focus: 0,
    processed: 0,
    draftsReady: 0,
    needsReview: 0,
    noiseCaught: 0,
  },
};

test("a quick route return reuses the in-memory email feed", () => {
  clearEmailNavigationFeedsForTest();
  rememberEmailNavigationFeed({
    scope: "user-1",
    view: "focus",
    connectionId: null,
    entry: { feed: focusFeed, limit: 24, savedAt: 100 },
    capturedAt: 1_000,
  });

  assert.deepEqual(
    readEmailNavigationFeed({
      scope: "user-1",
      view: "focus",
      connectionId: null,
      now: 1_500,
    }),
    { feed: focusFeed, limit: 24, savedAt: 100 },
  );
  assert.deepEqual(
    readEmailNavigationLocation({ scope: "user-1", now: 1_500 }),
    { view: "focus", connectionId: null },
  );
  assert.equal(
    readEmailNavigationFeed({
      scope: "another-user",
      view: "focus",
      connectionId: null,
      now: 1_500,
    }),
    null,
  );
});

test("navigation feeds expire instead of becoming a stale Focus source", () => {
  clearEmailNavigationFeedsForTest();
  rememberEmailNavigationFeed({
    scope: "user-1",
    view: "focus",
    connectionId: "work",
    entry: { feed: focusFeed, limit: 24, savedAt: 100 },
    capturedAt: 1_000,
  });

  assert.equal(
    readEmailNavigationFeed({
      scope: "user-1",
      view: "focus",
      connectionId: "work",
      now: 1_000 + EMAIL_NAVIGATION_FEED_MAX_AGE_MS + 1,
    }),
    null,
  );
});

test("standalone Home Screen contexts use launch-persistent navigation storage", () => {
  assert.equal(
    shouldPersistEmailNavigationAcrossLaunches({
      standaloneDisplayMode: true,
      navigatorStandalone: false,
    }),
    true,
  );
  assert.equal(
    shouldPersistEmailNavigationAcrossLaunches({
      standaloneDisplayMode: false,
      navigatorStandalone: true,
    }),
    true,
  );
  assert.equal(
    shouldPersistEmailNavigationAcrossLaunches({
      standaloneDisplayMode: false,
      navigatorStandalone: false,
    }),
    false,
  );
});

test("a restored Home Screen always revalidates cross-device state", () => {
  assert.equal(
    shouldRefreshRestoredEmailNavigation({
      cachedSavedAt: 9_500,
      attentionCount: 0,
      now: 10_000,
      refreshCooldownMs: 30_000,
    }),
    true,
  );
  assert.equal(
    shouldRefreshRestoredEmailNavigation({
      cachedSavedAt: 9_500,
      attentionCount: 1,
      now: 10_000,
      refreshCooldownMs: 30_000,
    }),
    true,
  );
  assert.equal(
    shouldRefreshRestoredEmailNavigation({
      cachedSavedAt: 1_000,
      attentionCount: 0,
      now: 40_000,
      refreshCooldownMs: 30_000,
    }),
    true,
  );
  assert.equal(
    shouldRefreshRestoredEmailNavigation({
      cachedSavedAt: null,
      attentionCount: 0,
      now: 10_000,
      refreshCooldownMs: 30_000,
    }),
    true,
  );
});

test("an iOS-style page recreation restores the recent Email screen", () => {
  const storage = new MemoryStorage();
  clearEmailNavigationFeedsForTest();
  clearEmailFeedCache("ios-user", null);
  rememberEmailNavigationFeed({
    scope: "ios-user",
    view: "focus",
    connectionId: "work",
    entry: { feed: focusFeed, limit: 24, savedAt: 900 },
    capturedAt: 1_000,
    storage,
  });

  clearEmailNavigationFeedsForTest();
  clearEmailFeedCache("ios-user", null);

  assert.deepEqual(
    readEmailNavigationLocation({
      scope: "ios-user",
      now: 2 * 60 * 60_000,
      storage,
    }),
    { view: "focus", connectionId: "work" },
  );
  assert.deepEqual(
    readEmailNavigationFeed({
      scope: "ios-user",
      view: "focus",
      connectionId: "work",
      now: 2 * 60 * 60_000,
      storage,
    }),
    { feed: focusFeed, limit: 24, savedAt: 900, revision: 0 },
  );
});
