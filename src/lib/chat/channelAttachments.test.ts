import assert from "node:assert/strict";
import test from "node:test";
import {
  attachmentOnlyMessage,
  validateChatAttachments,
} from "./channelAttachments";

const base64 = (value: string | Buffer) =>
  Buffer.from(value).toString("base64");

test("chat attachments accept PDFs and normalize PNG MIME from bytes", () => {
  const png = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00,
  ]);
  const attachments = validateChatAttachments([
    {
      mediaType: "application/pdf",
      base64: base64("%PDF-1.7\nexample"),
      filename: "proposal.pdf",
    },
    {
      mediaType: "image/jpeg",
      base64: base64(png),
      filename: "screenshot.jpg",
    },
  ]);

  assert.deepEqual(
    attachments.map(({ kind, mediaType, filename }) => ({
      kind,
      mediaType,
      filename,
    })),
    [
      {
        kind: "file",
        mediaType: "application/pdf",
        filename: "proposal.pdf",
      },
      {
        kind: "image",
        mediaType: "image/png",
        filename: "screenshot.png",
      },
    ],
  );
});

test("chat attachments recognize Office formats from filename and bytes", () => {
  const openXml = Buffer.concat([
    Buffer.from([0x50, 0x4b, 0x03, 0x04]),
    Buffer.from("[Content_Types].xml xl/workbook.xml"),
  ]);
  const [attachment] = validateChatAttachments([
    {
      mediaType: "application/zip",
      base64: base64(openXml),
      filename: "forecast.xlsx",
    },
  ]);
  assert.equal(
    attachment.mediaType,
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  );
});

test("chat attachments reject disguised files and invalid JSON", () => {
  assert.throws(
    () =>
      validateChatAttachments([
        {
          mediaType: "application/pdf",
          base64: base64("plain text"),
          filename: "fake.pdf",
        },
      ]),
    /does not match/,
  );
  assert.throws(
    () =>
      validateChatAttachments([
        {
          mediaType: "application/json",
          base64: base64("not json"),
          filename: "broken.json",
        },
      ]),
    /does not match/,
  );
});

test("chat attachments enforce count and provide attachment-only copy", () => {
  assert.throws(
    () =>
      validateChatAttachments(
        Array.from({ length: 6 }, (_, index) => ({
          mediaType: "text/plain",
          base64: base64(`file ${index}`),
          filename: `${index}.txt`,
        })),
      ),
    /up to 5/,
  );
  assert.equal(attachmentOnlyMessage([{ kind: "file" }]), "Shared a file");
  assert.equal(
    attachmentOnlyMessage([{ kind: "image" }, { kind: "file" }]),
    "Shared 2 attachments",
  );
});
