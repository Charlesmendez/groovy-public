import assert from "node:assert/strict";
import test from "node:test";
import { readLoadedMessageTail } from "./platform/whatsapp/inboundPoll.mjs";

test("reads only the loaded message tail without invoking a history loader", async (t) => {
  const previousWindow = globalThis.window;
  t.after(() => {
    globalThis.window = previousWindow;
  });
  let historyLoads = 0;
  globalThis.window = {
    Store: {
      Chat: {
        get: (chatId) => ({
          id: chatId,
          msgs: {
            getModelsArray: () => [
              { id: { _serialized: "old", id: "old", remote: { _serialized: chatId } }, body: "old", t: 1 },
              { id: { _serialized: "new", id: "new", remote: { _serialized: chatId }, fromMe: true }, body: "@groovy status", t: 2 },
            ],
            loadEarlierMsgs: () => {
              historyLoads += 1;
            },
          },
        }),
      },
    },
  };
  const page = {
    evaluate: async (callback, argument) => callback(argument),
  };

  const messages = await readLoadedMessageTail(page, "groovy@g.us", 1);
  assert.equal(historyLoads, 0);
  assert.deepEqual(messages, [{
    id: { _serialized: "new", id: "new", remote: "groovy@g.us" },
    body: "@groovy status",
    timestamp: 2,
    fromMe: true,
    from: "",
    to: "",
  }]);
});
