import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { promisify } from "node:util";
import { webhookCurlExample } from "./incomingWebhook";

const exec = promisify(execFile);

test("the exact copied cURL command follows POST redirects and surfaces delivery failures", async () => {
  const deliveries: Array<{
    method?: string;
    contentType?: string;
    body: string;
  }> = [];
  const server = createServer(async (req, res) => {
    if (req.url === "/redirect-307" || req.url === "/redirect-308") {
      req.resume();
      res.writeHead(req.url === "/redirect-307" ? 307 : 308, {
        Location: "/deliver",
      });
      res.end();
      return;
    }
    if (req.url === "/failure") {
      req.resume();
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({ ok: false, message: "This webhook is paused." }),
      );
      return;
    }
    let body = "";
    for await (const chunk of req) body += chunk;
    deliveries.push({
      method: req.method,
      contentType: req.headers["content-type"],
      body,
    });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    for (const path of ["/deliver", "/redirect-307", "/redirect-308"]) {
      // Execute the literal copyable snippet, with test-only URLs/payloads.
      const { stdout } = await exec(
        "/bin/sh",
        ["-c", webhookCurlExample(origin + path)],
        { timeout: 10_000 },
      );
      assert.deepEqual(JSON.parse(stdout), { ok: true });
    }
    assert.equal(deliveries.length, 3);
    for (const delivery of deliveries) {
      assert.equal(delivery.method, "POST");
      assert.equal(delivery.contentType, "application/json");
      assert.deepEqual(JSON.parse(delivery.body), {
        text: "Hello from my service!",
      });
    }
    await assert.rejects(
      exec("/bin/sh", ["-c", webhookCurlExample(origin + "/failure")], {
        timeout: 10_000,
      }),
      (error: unknown) => {
        const result = error as { code?: number; stdout?: string };
        assert.equal(result.code, 22);
        assert.match(result.stdout || "", /This webhook is paused/);
        return true;
      },
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
