import assert from "node:assert/strict";
import test from "node:test";
import {
  canRenderEmailAttachmentAsInlineImage,
  canOpenEmailAttachmentInline,
  emailAttachmentContentDisposition,
  emailAttachmentUrl,
  resolvedEmailAttachmentMimeType,
  safeEmailAttachmentFilename,
  safeEmailAttachmentMimeType,
} from "./attachment";

test("attachment links preserve mailbox and Gmail attachment identity", () => {
  assert.equal(
    emailAttachmentUrl({
      connectionId: "mailbox one",
      messageId: "message/2",
      attachmentId: "attachment+3",
      threadId: "thread/4",
      partId: "2.1",
      filename: "chart one.png",
      mimeType: "image/png",
    }),
    "/api/email/attachment?connectionId=mailbox+one&messageId=message%2F2&attachmentId=attachment%2B3&threadId=thread%2F4&partId=2.1&filename=chart+one.png&mimeType=image%2Fpng",
  );
  assert.equal(
    emailAttachmentUrl({
      connectionId: "mailbox one",
      messageId: "message/2",
      attachmentId: "attachment+3",
      filename: "agreement.pdf",
      mimeType: "application/pdf",
      open: true,
    }),
    "/api/email/attachment?connectionId=mailbox+one&messageId=message%2F2&attachmentId=attachment%2B3&filename=agreement.pdf&mimeType=application%2Fpdf&open=1",
  );
  assert.equal(
    emailAttachmentUrl({
      connectionId: "mailbox one",
      messageId: "message/2",
      attachmentId: "attachment+3",
      filename: "chart one.png",
      download: true,
    }),
    "/api/email/attachment?connectionId=mailbox+one&messageId=message%2F2&attachmentId=attachment%2B3&filename=chart+one.png&download=1",
  );
});

test("attachment filenames cannot inject paths or response headers", () => {
  assert.equal(
    safeEmailAttachmentFilename("../contract\r\n.pdf"),
    ".._contract.pdf",
  );
  assert.equal(
    safeEmailAttachmentMimeType("text/html\r\nX-Test: injected"),
    "application/octet-stream",
  );
});

test("only inert browser-viewable attachment types open inline", () => {
  assert.equal(canOpenEmailAttachmentInline("application/pdf"), true);
  assert.equal(canOpenEmailAttachmentInline("image/png"), true);
  assert.equal(canOpenEmailAttachmentInline("image/svg+xml"), false);
  assert.equal(canOpenEmailAttachmentInline("text/html"), false);
  assert.match(
    emailAttachmentContentDisposition({
      filename: "signed agreement.pdf",
      mimeType: "application/pdf",
    }),
    /^inline;/,
  );
  assert.match(
    emailAttachmentContentDisposition({
      filename: "signed agreement.pdf",
      mimeType: "application/pdf",
      download: true,
    }),
    /^attachment;/,
  );
});

test("generic PDF attachments recover a safe browser-viewable MIME type", () => {
  assert.equal(
    resolvedEmailAttachmentMimeType({
      mimeType: "application/octet-stream",
      filename: "signed agreement.PDF",
    }),
    "application/pdf",
  );
  assert.equal(
    resolvedEmailAttachmentMimeType({
      mimeType: "application/octet-stream",
      filename: "signed agreement.html",
    }),
    "application/octet-stream",
  );
  assert.equal(
    resolvedEmailAttachmentMimeType({
      mimeType: "application/x-pdf",
      filename: "legacy-document",
    }),
    "application/pdf",
  );
});

test("only safe image MIME parts can disappear into the HTML body", () => {
  assert.equal(canRenderEmailAttachmentAsInlineImage("image/png"), true);
  assert.equal(canRenderEmailAttachmentAsInlineImage("application/pdf"), false);
  assert.equal(canRenderEmailAttachmentAsInlineImage("image/svg+xml"), false);
});
