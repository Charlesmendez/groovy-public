import assert from "node:assert/strict";
import test from "node:test";
import {
  splitEmailBodyHistory,
  tokenizeEmailBody,
} from "./bodyFormatting";

test("turns angle-bracket email URLs into links without showing the brackets", () => {
  assert.deepEqual(
    tokenizeEmailBody(
      "Sign the agreement\n  <https://ironcladapp.com/public-launch/123>",
    ),
    [
      { type: "text", value: "Sign the agreement\n  " },
      {
        type: "link",
        label: "https://ironcladapp.com/public-launch/123",
        href: "https://ironcladapp.com/public-launch/123",
      },
    ],
  );
});

test("supports labeled and bare links while keeping punctuation outside", () => {
  assert.deepEqual(
    tokenizeEmailBody(
      "Review [the document](https://example.com/doc), then visit https://example.com/help.",
    ),
    [
      { type: "text", value: "Review " },
      {
        type: "link",
        label: "the document",
        href: "https://example.com/doc",
      },
      { type: "text", value: ", then visit " },
      {
        type: "link",
        label: "https://example.com/help",
        href: "https://example.com/help",
      },
      { type: "text", value: "." },
    ],
  );
});

test("does not turn unsafe schemes into links", () => {
  assert.deepEqual(tokenizeEmailBody("<javascript:alert(1)>"), [
    { type: "text", value: "<javascript:alert(1)>" },
  ]);
});

test("separates a reply from Gmail-style quoted history", () => {
  assert.deepEqual(
    splitEmailBodyHistory(
      "The revised contract looks good.\n\nOn Mon, Jul 27, 2026 at 9:15 AM Alex <alex@example.com> wrote:\nPlease review the contract.",
    ),
    {
      visible: "The revised contract looks good.",
      quoted:
        "On Mon, Jul 27, 2026 at 9:15 AM Alex <alex@example.com> wrote:\nPlease review the contract.",
    },
  );
});

test("keeps a forwarded message visible when it is the entire email", () => {
  const body =
    "---------- Forwarded message ----------\nFrom: Alex <alex@example.com>\nSubject: Launch\n\nThe launch is Tuesday.";
  assert.deepEqual(splitEmailBodyHistory(body), {
    visible: body,
    quoted: null,
  });
});
