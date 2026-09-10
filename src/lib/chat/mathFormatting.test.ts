import assert from "node:assert/strict";
import test from "node:test";
import {
  renderChatMathToHtml,
  tokenizeChatMessageInline,
} from "@/lib/chat/mathFormatting";

test("tokenizes the inline LaTeX emitted in math answers", () => {
  assert.deepEqual(
    tokenizeChatMessageInline(
      "\\(1000^1 = 1{,}000\\) → **3 zeros**",
    ),
    [
      {
        type: "math",
        value: "1000^1 = 1{,}000",
        raw: "\\(1000^1 = 1{,}000\\)",
        display: false,
      },
      { type: "text", value: " → " },
      { type: "strong", value: "3 zeros" },
    ],
  );
});

test("tokenizes display math across lines", () => {
  assert.deepEqual(
    tokenizeChatMessageInline("Before\n\\[\n3 \\times 10^9\n\\]\nAfter"),
    [
      { type: "text", value: "Before\n" },
      {
        type: "math",
        value: "\n3 \\times 10^9\n",
        raw: "\\[\n3 \\times 10^9\n\\]",
        display: true,
      },
      { type: "text", value: "\nAfter" },
    ],
  );
});

test("supports double-dollar and AMS display math", () => {
  const tokens = tokenizeChatMessageInline(
    "$$x^2$$\n\\begin{align}a&=b\\end{align}",
  );

  assert.deepEqual(tokens, [
    {
      type: "math",
      value: "x^2",
      raw: "$$x^2$$",
      display: true,
    },
    { type: "text", value: "\n" },
    {
      type: "math",
      value: "\\begin{align}a&=b\\end{align}",
      raw: "\\begin{align}a&=b\\end{align}",
      display: true,
    },
  ]);
});

test("leaves inline code, currency, and unmatched delimiters literal", () => {
  assert.deepEqual(
    tokenizeChatMessageInline("Use `\\(x^2\\)`, pay $5, then \\(unfinished"),
    [
      { type: "text", value: "Use " },
      { type: "code", value: "\\(x^2\\)" },
      { type: "text", value: ", pay $5, then \\(unfinished" },
    ],
  );
});

test("renders valid math with accessible KaTeX markup", () => {
  const html = renderChatMathToHtml("3 \\times 10^9", true);

  assert.ok(html);
  assert.match(html, /class="katex-display"/);
  assert.match(html, /<math[^>]*display="block"/);
  assert.match(html, /3/);
});

test("returns null for malformed or unsupported math", () => {
  assert.equal(renderChatMathToHtml("\\definitelyUnknown{x}", false), null);
});

test("does not enable untrusted KaTeX HTML commands", () => {
  const html = renderChatMathToHtml(
    String.raw`\href{javascript:alert(1)}{click}`,
    false,
  );

  assert.ok(html);
  assert.doesNotMatch(html, /href=/i);
});
