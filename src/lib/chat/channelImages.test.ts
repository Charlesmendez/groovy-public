import assert from "node:assert/strict";
import test from "node:test";
import {
  ChatImageValidationError,
  imageOnlyMessage,
  validateChatImages,
  validateChatVoiceNote,
  voiceNoteMessage,
} from "./channelImages";

const png = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00,
]).toString("base64");

test("channel images accept supported image data and sanitize filenames", () => {
  const [image] = validateChatImages([
    {
      mediaType: "image/png",
      base64: `data:image/png;base64,${png}`,
      filename: "../quarterly\u0000 report.png",
    },
  ]);
  assert.equal(image.mediaType, "image/png");
  assert.equal(image.filename, ".. quarterly report.png");
  assert.equal(image.byteSize, 9);
});

test("channel images normalize unreliable browser MIME labels from the bytes", () => {
  const [image] = validateChatImages([
    {
      mediaType: "image/jpeg",
      base64: png,
      filename: "actually-a-png.jpg",
    },
  ]);
  assert.equal(image.mediaType, "image/png");
  assert.equal(image.filename, "actually-a-png.png");
});

test("channel images reject malformed, disguised, and excessive input", () => {
  assert.throws(
    () =>
      validateChatImages([
        { mediaType: "image/png", base64: "not-base64!", filename: "bad.png" },
      ]),
    ChatImageValidationError,
  );
  assert.throws(
    () =>
      validateChatImages([
        {
          mediaType: "image/png",
          base64: Buffer.from("%PDF-1.7").toString("base64"),
          filename: "not-an-image.png",
        },
      ]),
    /does not match/,
  );
  assert.throws(
    () =>
      validateChatImages(
        Array.from({ length: 4 }, (_, index) => ({
          mediaType: "image/png",
          base64: png,
          filename: `${index}.png`,
        })),
      ),
    /up to 3/,
  );
});

test("image-only channel turns have useful visible fallback text", () => {
  assert.equal(imageOnlyMessage(1), "Shared an image");
  assert.equal(imageOnlyMessage(3), "Shared 3 images");
});

test("voice notes accept supported audio signatures and bounded duration", () => {
  const webm = Buffer.from([
    0x1a, 0x45, 0xdf, 0xa3, 0x42, 0x86, 0x81, 0x01,
  ]).toString("base64");
  const voice = validateChatVoiceNote({
    mediaType: "audio/webm;codecs=opus",
    base64: webm,
    filename: "voice-note.webm",
    durationMs: 1_250,
  });
  assert.equal(voice?.mediaType, "audio/webm");
  assert.equal(voice?.durationMs, 1_250);
  assert.equal(voiceNoteMessage(), "Shared a voice note");
});

test("voice notes reject spoofed audio and excessive duration", () => {
  assert.throws(
    () =>
      validateChatVoiceNote({
        mediaType: "audio/webm",
        base64: png,
        durationMs: 1_000,
      }),
    /does not match/,
  );
  assert.throws(
    () =>
      validateChatVoiceNote({
        mediaType: "audio/webm",
        base64: Buffer.from([0x1a, 0x45, 0xdf, 0xa3]).toString("base64"),
        durationMs: 11 * 60 * 1_000,
      }),
    /ten minutes/,
  );
});
