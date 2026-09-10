import assert from "node:assert/strict";
import test from "node:test";
import { readHomeJson } from "./boundedJson";

test("Home body reader rejects declared and streamed overflow, bad JSON and invalid UTF-8", async () => {
  for (const response of [
    new Response("{}", { headers: { "content-length": "1000" } }),
    new Response("x".repeat(101)),
    new Response("not json"),
    new Response(new Uint8Array([0xff])),
  ])
    await assert.rejects(() =>
      readHomeJson(response, 100, new AbortController().signal),
    );
});

test("a stalled Home response is cancelled when the decision stops", async () => {
  const controller = new AbortController();
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    cancel() {
      cancelled = true;
    },
  });
  const pending = readHomeJson(new Response(body), 100, controller.signal);
  controller.abort();
  await assert.rejects(() => pending);
  assert.equal(cancelled, true);
});

test("bounded reader supports multibyte UTF-8 split across chunks", async () => {
  const encoded = new TextEncoder().encode(
    JSON.stringify({ label: "Salud · Bogotá" }),
  );
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const byte of encoded) controller.enqueue(new Uint8Array([byte]));
      controller.close();
    },
  });
  assert.deepEqual(
    await readHomeJson(new Response(body), 100, new AbortController().signal),
    { label: "Salud · Bogotá" },
  );
});
