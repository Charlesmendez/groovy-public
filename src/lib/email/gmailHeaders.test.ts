import assert from "node:assert/strict";
import test from "node:test";
import { encodeEmailSubjectHeader } from "@/lib/email/gmail";

function decodeEncodedWords(value: string): string {
  return value
    .split(" ")
    .map((word) => {
      const match = word.match(/^=\?UTF-8\?B\?([^?]+)\?=$/i);
      return match
        ? Buffer.from(match[1], "base64").toString("utf8")
        : word;
    })
    .join("");
}

test("keeps ordinary ASCII subjects readable", () => {
  assert.equal(
    encodeEmailSubjectHeader("Groovy production verification"),
    "Groovy production verification",
  );
});

test("encodes Unicode subjects as safe RFC 2047 words", () => {
  const subject =
    "Groovy production verification — Sent, tracking, and Focus ✓";
  const encoded = encodeEmailSubjectHeader(subject);
  assert.match(encoded, /^=\?UTF-8\?B\?/);
  assert.equal(decodeEncodedWords(encoded), subject);
  for (const word of encoded.split(" ")) {
    assert.ok(word.length <= 75);
  }
});

test("removes newline injection before subject encoding", () => {
  const encoded = encodeEmailSubjectHeader("Hello\r\nBcc: bad@example.com — safe");
  assert.equal(
    decodeEncodedWords(encoded),
    "Hello Bcc: bad@example.com — safe",
  );
});
