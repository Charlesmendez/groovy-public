import assert from "node:assert/strict";
import test from "node:test";
import { buildEmailReaderDocument } from "./readerDocument";

test("email reader uses a mobile viewport and a light isolated canvas", () => {
  const document = buildEmailReaderDocument("<p>Hello</p>");

  assert.match(document, /width=device-width/);
  assert.match(document, /color-scheme: light only/);
  assert.match(document, /background: #ffffff/);
  assert.match(document, /color: #202124/);
});

test("email reader constrains fixed sender layouts without horizontal scrolling", () => {
  const document = buildEmailReaderDocument(
    '<table style="width: 900px; min-width: 900px"><tr><td>Wide</td></tr></table>',
  );

  assert.match(document, /overflow-x: hidden/);
  assert.match(document, /max-width: 100% !important/);
  assert.match(document, /min-width: 0 !important/);
  assert.match(document, /overflow-wrap: anywhere/);
  assert.match(document, /width: 900px/);
  assert.ok(
    document.lastIndexOf("data-groovy-email-reader") >
      document.lastIndexOf("width: 900px"),
  );
});

test("email reader keeps active content disabled while allowing safe images", () => {
  const document = buildEmailReaderDocument(
    '<img src="https://images.example.test/receipt.png" alt="Receipt">',
  );

  assert.match(document, /script-src 'none'/);
  assert.match(document, /form-action 'none'/);
  assert.match(document, /object-src 'none'/);
  assert.match(document, /img-src 'self' data: http: https:/);
});
