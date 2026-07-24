import assert from "node:assert/strict";
import test from "node:test";
import {
  ChatImageValidationError,
  imageOnlyMessage,
  validateChatImages,
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

test("channel images reject malformed, spoofed, and excessive input", () => {
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
          mediaType: "image/jpeg",
          base64: png,
          filename: "actually-a-png.jpg",
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
