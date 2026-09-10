import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeEmailHtml } from "./html";

test("email HTML keeps safe linked buttons and table layout", () => {
  const result = sanitizeEmailHtml(`
    <table width="100%" cellpadding="12">
      <tr><td bgcolor="#eeeeee">
        <a href="https://drive.google.com/example"
           style="display:inline-block;background-color:#dde5ee;border-radius:24px;padding:12px 18px">
          Recording
        </a>
      </td></tr>
    </table>
  `);

  assert.ok(result);
  assert.match(result, /<table width="100%" cellpadding="12">/);
  assert.match(result, /href="https:\/\/drive\.google\.com\/example"/);
  assert.match(result, /background-color:#dde5ee/);
  assert.match(result, /target="_blank"/);
  assert.match(result, /rel="noopener noreferrer nofollow"/);
  assert.match(result, />\s*Recording\s*<\/a>/);
});

test("email HTML keeps document spacing and list structure for the reader", () => {
  const result = sanitizeEmailHtml(`
    <h2 style="margin-bottom:18px">Weekly update</h2>
    <p style="line-height:1.6">Executive summary</p>
    <ul style="padding-left:24px">
      <li>Sales rebounded</li>
      <li>Pipeline recovered</li>
    </ul>
  `);

  assert.ok(result);
  assert.match(result, /<h2 style="margin-bottom:18px">Weekly update<\/h2>/);
  assert.match(result, /<p style="line-height:1\.6">Executive summary<\/p>/);
  assert.match(result, /<ul style="padding-left:24px">/);
  assert.match(result, /<li>Sales rebounded<\/li>/);
  assert.match(result, /<li>Pipeline recovered<\/li>/);
});

test("email HTML preserves isolated responsive styles and their class hooks", () => {
  const result = sanitizeEmailHtml(
    `
      <style>
        .receipt { background: #f7f7f7; color: #1f2937; }
        @media (max-width: 480px) { .receipt { width: 100%; } }
      </style>
      <body bgcolor="#f7f7f7" style="background:#f7f7f7;color:#1f2937">
        <table class="receipt" id="receipt-main"><tr><td>Receipt</td></tr></table>
      </body>
      <script>alert("no")</script>
    `,
    { preserveDocumentStyles: true },
  );

  assert.ok(result);
  assert.match(result, /<style>[\s\S]*\.receipt/);
  assert.match(result, /@media \(max-width: 480px\)/);
  assert.match(result, /<div bgcolor="#f7f7f7" style="background:#f7f7f7;color:#1f2937">/);
  assert.match(result, /class="receipt"/);
  assert.match(result, /id="receipt-main"/);
  assert.doesNotMatch(result, /script|alert/i);
});

test("embedded styles remain disabled outside the sandboxed reader path", () => {
  const result = sanitizeEmailHtml(
    '<style>.hidden { display:none }</style><p class="hidden">Visible</p>',
  );

  assert.equal(result, '<p class="hidden">Visible</p>');
});

test("email HTML removes executable content and UI-escaping styles", () => {
  const result = sanitizeEmailHtml(`
    <script>alert("no")</script>
    <form action="https://attacker.test"><input name="secret"></form>
    <a href="javascript:alert(1)" onclick="alert(2)"
       style="position:fixed;inset:0;background-image:url(https://tracker.test/pixel)">
      Unsafe
    </a>
    <img src="https://tracker.test/pixel" width="1" height="1" onerror="alert(3)">
  `);

  assert.ok(result);
  assert.doesNotMatch(result, /script|form|input|onclick|onerror/i);
  assert.doesNotMatch(result, /javascript:|position:|background-image|tracker\.test/i);
  assert.match(result, />\s*Unsafe\s*<\/a>/);
});

test("empty email HTML stays absent", () => {
  assert.equal(sanitizeEmailHtml(" \n "), null);
});

test("email HTML resolves inline CID images through authenticated URLs", () => {
  const cidImageSources = new Map([
    [
      "ii-inline-image",
      "/api/email/attachment?connectionId=mailbox-1&messageId=message-1&attachmentId=image-1",
    ],
  ]);
  const result = sanitizeEmailHtml(
    '<p>Before</p><img src="cid:ii-inline-image" alt="Job card" width="562" height="85"><p>After</p>',
    { cidImageSources },
  );

  assert.ok(result);
  assert.match(
    result,
    /src="\/api\/email\/attachment\?connectionId=mailbox-1&amp;messageId=message-1&amp;attachmentId=image-1"/,
  );
  assert.doesNotMatch(result, /cid:/i);
  assert.match(result, /loading="lazy"/);
});

test("email HTML removes unresolved CID image placeholders", () => {
  const result = sanitizeEmailHtml(
    '<p>Before</p><img src="cid:missing-image" alt="image.png" width="562" height="85"><p>After</p>',
    { cidImageSources: new Map() },
  );

  assert.equal(result, "<p>Before</p><p>After</p>");
});

test("email HTML removes embedded data images from function responses", () => {
  const result = sanitizeEmailHtml(
    `<p>Before</p><img src="data:image/png;base64,${"a".repeat(100_000)}" alt="Embedded"><p>After</p>`,
    { preserveDocumentStyles: true },
  );

  assert.equal(result, "<p>Before</p><p>After</p>");
});
