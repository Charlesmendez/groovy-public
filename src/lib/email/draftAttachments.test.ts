import assert from "node:assert/strict";
import test from "node:test";
import {
  assertOwnedEmailDraftAttachments,
  canInlineEmailDraftMimeType,
  emailDraftContentId,
  normalizeEmailDraftAttachments,
  plainTextWithInlineImageLabels,
  plainTextWithInlineImages,
  safeEmailDraftFilename,
  safeEmailDraftMimeType,
} from "./draftAttachments";
import type { EmailDraftAttachment } from "./types";

function attachment(
  overrides: Partial<EmailDraftAttachment> = {},
): EmailDraftAttachment {
  return {
    id: "image-1",
    storagePath: "user-1/email-drafts/session/image.png",
    filename: "image.png",
    mimeType: "image/png",
    size: 100,
    disposition: "inline",
    contentId: "groovy-image-1@inline",
    ...overrides,
  };
}

test("draft attachment metadata normalizes names, MIME, and inline safety", () => {
  assert.equal(safeEmailDraftFilename("../bad\nname.png"), ".._badname.png");
  assert.equal(safeEmailDraftMimeType("IMAGE/PNG"), "image/png");
  assert.equal(
    safeEmailDraftMimeType("image/png\r\nX-Evil: yes"),
    "application/octet-stream",
  );
  assert.equal(canInlineEmailDraftMimeType("image/webp"), true);
  assert.equal(canInlineEmailDraftMimeType("image/svg+xml"), false);
  assert.equal(emailDraftContentId("unsafe <> id"), "groovy-unsafeid@inline");

  const normalized = normalizeEmailDraftAttachments([
    attachment({
      id: "svg-1",
      filename: "vector.svg",
      mimeType: "image/svg+xml",
      disposition: "inline",
      contentId: "malicious@inline",
    }),
  ]);
  assert.equal(normalized[0].disposition, "attachment");
  assert.equal(normalized[0].contentId, null);
});

test("draft attachment metadata enforces count, total size, and ownership", () => {
  assert.throws(
    () =>
      normalizeEmailDraftAttachments(
        Array.from({ length: 13 }, (_, index) =>
          attachment({
            id: `item-${index}`,
            disposition: "attachment",
            contentId: null,
          }),
        ),
      ),
    /no more than 12/i,
  );
  assert.throws(
    () =>
      normalizeEmailDraftAttachments([
        attachment({
          id: "large-1",
          size: 9 * 1024 * 1024,
          disposition: "attachment",
          contentId: null,
        }),
        attachment({
          id: "large-2",
          size: 9 * 1024 * 1024,
          disposition: "attachment",
          contentId: null,
        }),
      ]),
    /17 MB or less/i,
  );
  assert.doesNotThrow(() =>
    assertOwnedEmailDraftAttachments({
      userId: "user-1",
      attachments: [
        attachment({
          storagePath:
            "user-1/email-drafts/session/quarterly..report.png",
        }),
      ],
    }),
  );
  assert.throws(
    () =>
      assertOwnedEmailDraftAttachments({
        userId: "user-1",
        attachments: [
          attachment({
            storagePath: "user-2/email-drafts/session/image.png",
          }),
        ],
      }),
    /path is invalid/i,
  );
});

test("plain text becomes safe HTML with inline images at the cursor", () => {
  const result = plainTextWithInlineImages({
    body: "Before <tag>\nAfter",
    offset: 12,
    attachments: [attachment()],
  });
  assert.equal(
    result,
    'Before &lt;tag&gt;<img src="cid:groovy-image-1@inline" alt="image.png" ' +
      'style="display:block;max-width:100%;height:auto;margin:10px 0">' +
      "<br>After",
  );
  assert.equal(
    plainTextWithInlineImageLabels({
      body: "Before After",
      offset: 7,
      attachments: [attachment()],
    }),
    "Before [Inline image: image.png]After",
  );
});
