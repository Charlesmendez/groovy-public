import assert from "node:assert/strict";
import test from "node:test";
import {
  insertTextAtSelection,
  pasteTextPreservingStructure,
} from "./pasteFormatting";

test("rich unordered lists become Markdown-compatible bullet lines", () => {
  const result = pasteTextPreservingStructure({
    html: `
      <ul>
        <li><p><span>United matches principally by address.</span></p></li>
        <li><strong>Dolan</strong> uses external/job numbers.</li>
        <li>Prime uses PO numbers &amp; document numbers.</li>
      </ul>
    `,
    text: "United matches principally by address.\nDolan uses external/job numbers.",
  });

  assert.equal(
    result,
    "- United matches principally by address.\n" +
      "- Dolan uses external/job numbers.\n" +
      "- Prime uses PO numbers & document numbers.",
  );
});

test("ordered and nested lists retain their hierarchy", () => {
  const result = pasteTextPreservingStructure({
    html: "<ol start=3><li>Third<ul><li>Nested</li></ul></li><li>Fourth</li></ol>",
    text: "Third\nNested\nFourth",
  });

  assert.equal(result, "3. Third\n  - Nested\n4. Fourth");
});

test("ordinary clipboard text is not rewritten", () => {
  assert.equal(
    pasteTextPreservingStructure({
      html: "<p>First paragraph</p><p>Second paragraph</p>",
      text: "First paragraph\n\nSecond paragraph",
    }),
    "First paragraph\n\nSecond paragraph",
  );
});

test("structured paste replaces the selected text and returns the new caret", () => {
  assert.deepEqual(
    insertTextAtSelection({
      value: "Hello old world",
      insertion: "- one\n- two",
      selectionStart: 6,
      selectionEnd: 9,
    }),
    { value: "Hello - one\n- two world", caret: 17 },
  );
});
