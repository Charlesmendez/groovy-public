import assert from "node:assert/strict";
import test from "node:test";
import { scopeChatTypingQuery } from "./typingScope";

class FakeTypingQuery {
  filters: Array<[string, string, string | null]> = [];

  eq(column: string, value: string): this {
    this.filters.push(["eq", column, value]);
    return this;
  }

  is(column: string, value: null): this {
    this.filters.push(["is", column, value]);
    return this;
  }
}

test("typing refresh updates only the channel composer scope", () => {
  const query = scopeChatTypingQuery(new FakeTypingQuery(), null);
  assert.deepEqual(query.filters, [["is", "thread_root_message_id", null]]);
});

test("typing refresh updates only the matching thread scope", () => {
  const query = scopeChatTypingQuery(new FakeTypingQuery(), "thread-1");
  assert.deepEqual(query.filters, [
    ["eq", "thread_root_message_id", "thread-1"],
  ]);
});
