import assert from "node:assert/strict";
import test from "node:test";
import {
  lastChatChannelStorageKey,
  readLastChatChannel,
  rememberLastChatChannel,
  resolveLastChatChannel,
} from "./lastChannel";

test("last chat channel is scoped by workspace and user", () => {
  assert.notEqual(
    lastChatChannelStorageKey("workspace-a", "user-a"),
    lastChatChannelStorageKey("workspace-a", "user-b"),
  );
  assert.notEqual(
    lastChatChannelStorageKey("workspace-a", "user-a"),
    lastChatChannelStorageKey("workspace-b", "user-a"),
  );
});

test("remembered chat channel round-trips through storage", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) || null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
  rememberLastChatChannel(storage, "workspace-a", "user-a", "channel-b");
  assert.equal(
    readLastChatChannel(storage, "workspace-a", "user-a"),
    "channel-b",
  );
});

test("current channel wins, then a valid remembered channel, then the first", () => {
  const channels = ["channel-a", "channel-b"];
  assert.equal(
    resolveLastChatChannel(channels, "channel-a", "channel-b"),
    "channel-a",
  );
  assert.equal(
    resolveLastChatChannel(channels, null, "channel-b"),
    "channel-b",
  );
  assert.equal(
    resolveLastChatChannel(channels, null, "removed-channel"),
    "channel-a",
  );
  assert.equal(resolveLastChatChannel([], null, "channel-b"), null);
});
