import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(
  new URL("./EmailWorkspace.tsx", import.meta.url),
  "utf8",
);

test("the Drafts list exposes a confirmed delete action", () => {
  const draftsStart = source.indexOf('view === "drafts"');
  const draftsEnd = source.indexOf(") : (", draftsStart);
  const draftsView = source.slice(draftsStart, draftsEnd);

  assert.notEqual(draftsStart, -1, "expected the Drafts view");
  assert.match(draftsView, /aria-label=\{`Delete draft/);
  assert.match(draftsView, /onClick=\{\(\) => setDraftDeleteTarget\(draft\)\}/);
  assert.match(source, /aria-labelledby="delete-email-draft-title"/);
  assert.match(source, /This cannot be undone\./);
});

test("deleting a listed draft removes Gmail and uploaded attachment state", () => {
  const handlerStart = source.indexOf("const deleteRecoverableDraft =");
  const handlerEnd = source.indexOf("const openRecoverableDraft =", handlerStart);
  const handler = source.slice(handlerStart, handlerEnd);

  assert.notEqual(handlerStart, -1, "expected a draft deletion handler");
  assert.match(handler, /readPendingEmailSends/);
  assert.match(handler, /method: "DELETE"/);
  assert.match(handler, /EMAIL_DRAFT_ATTACHMENT_BUCKET/);
  assert.match(handler, /removeRecoverableDraft\(draft\.localId\)/);
});

test("rich draft serialization preserves browser-created line blocks", () => {
  const serializerStart = source.indexOf("function serializeRichComposerBody");
  const serializerEnd = source.indexOf(
    "function hydrateRichComposerHtml",
    serializerStart,
  );
  const serializer = source.slice(serializerStart, serializerEnd);

  assert.notEqual(serializerStart, -1, "expected the rich body serializer");
  assert.match(serializer, /node\.tagName === "DIV"/);
  assert.match(serializer, /node\.tagName === "P"/);
  assert.match(serializer, /htmlValue = `<\$\{tag\}>\$\{htmlValue\}<\/\$\{tag\}>`/);
});

test("autosave preserves the live rich body and syncs drafts across devices", () => {
  const saveStart = source.indexOf("const save = useCallback");
  const saveEnd = source.indexOf("const send = useCallback", saveStart);
  const save = source.slice(saveStart, saveEnd);

  assert.match(save, /body: requestDraft\.body/);
  assert.match(save, /bodyHtml: requestDraft\.bodyHtml/);
  assert.match(source, /jsonRequest<\{ ok: true; drafts: unknown\[\] \}>/);
  assert.match(source, /mergeEmailComposerDraftSnapshots\(current, synced\)/);
  assert.match(source, /aria-label="Sync email drafts"/);
  assert.match(source, /method: "PUT"/);
});
