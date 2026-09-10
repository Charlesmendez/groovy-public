import assert from "node:assert/strict";
import test from "node:test";
import {
  CHAT_WORKSPACE_CACHE_MAX_AGE_MS,
  clearChatWorkspaceCaches,
  readChatChannelMessages,
  readChatComposerDrafts,
  readChatWorkspaceCache,
  writeChatChannelMessages,
  writeChatComposerDraft,
  writeChatWorkspaceCache,
  type ChatCacheStorage,
} from "./workspaceCache";

class MemoryStorage implements ChatCacheStorage {
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

const channelsPayload = {
  workspace: { id: "ws-1", currentUserId: "user-1" },
  channels: [{ id: "channel-1", name: "general" }],
};
const profilesPayload = { profiles: [] };

test("workspace cache round-trips for the same user only", () => {
  const storage = new MemoryStorage();
  writeChatWorkspaceCache(
    "user-1",
    { channelsPayload, profilesPayload, savedAt: 1_000 },
    { storage },
  );
  const restored = readChatWorkspaceCache("user-1", { storage, now: 2_000 });
  assert.deepEqual(restored, {
    channelsPayload,
    profilesPayload,
    savedAt: 1_000,
  });
  assert.equal(readChatWorkspaceCache("user-2", { storage, now: 2_000 }), null);
});

test("workspace cache expires after the max age", () => {
  const storage = new MemoryStorage();
  writeChatWorkspaceCache(
    "user-1",
    { channelsPayload, profilesPayload, savedAt: 1_000 },
    { storage },
  );
  assert.equal(
    readChatWorkspaceCache("user-1", {
      storage,
      now: 1_000 + CHAT_WORKSPACE_CACHE_MAX_AGE_MS + 1,
    }),
    null,
  );
});

test("channel messages round-trip and are trimmed to the newest 50", () => {
  const storage = new MemoryStorage();
  const messages = Array.from({ length: 60 }, (_, index) => ({
    id: `message-${index}`,
    content: `hello ${index}`,
  }));
  writeChatChannelMessages("user-1", "channel-1", messages, {
    storage,
    now: 1_000,
  });
  const restored = readChatChannelMessages("user-1", "channel-1", {
    storage,
    now: 2_000,
  });
  assert.ok(restored);
  assert.equal(restored.length, 50);
  assert.equal(restored[0].id, "message-10");
  assert.equal(restored[49].id, "message-59");
  assert.equal(
    readChatChannelMessages("user-1", "channel-2", { storage, now: 2_000 }),
    null,
  );
});

test("older channel snapshots are pruned beyond the cap", () => {
  const storage = new MemoryStorage();
  for (let index = 0; index < 9; index += 1) {
    writeChatChannelMessages(
      "user-1",
      `channel-${index}`,
      [{ id: `message-${index}` }],
      { storage, now: 1_000 + index },
    );
  }
  const surviving = Array.from({ length: 9 }, (_, index) =>
    readChatChannelMessages("user-1", `channel-${index}`, {
      storage,
      now: 2_000,
    }),
  );
  assert.equal(surviving.filter(Boolean).length, 6);
  assert.equal(surviving[0], null);
  assert.ok(surviving[8]);
});

test("malformed stored data is ignored", () => {
  const storage = new MemoryStorage();
  storage.setItem("groovy.chat.workspace.v1:user-1", "{not json");
  storage.setItem("groovy.chat.messages.v1:user-1:channel-1", '{"messages":1}');
  assert.equal(readChatWorkspaceCache("user-1", { storage }), null);
  assert.equal(
    readChatChannelMessages("user-1", "channel-1", { storage }),
    null,
  );
});

test("composer drafts persist per user and channel until cleared", () => {
  const storage = new MemoryStorage();
  writeChatComposerDraft("user-1", "channel-1", "unfinished message", storage);
  writeChatComposerDraft("user-1", "channel-2", "another draft", storage);
  assert.deepEqual(readChatComposerDrafts("user-1", storage), {
    "channel-1": "unfinished message",
    "channel-2": "another draft",
  });
  assert.deepEqual(readChatComposerDrafts("user-2", storage), {});

  writeChatComposerDraft("user-1", "channel-1", "", storage);
  assert.deepEqual(readChatComposerDrafts("user-1", storage), {
    "channel-2": "another draft",
  });

  clearChatWorkspaceCaches(storage);
  assert.deepEqual(readChatComposerDrafts("user-1", storage), {});
});
