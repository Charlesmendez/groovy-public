import assert from "node:assert/strict";
import test from "node:test";
import { chatMessageMenuPlacement } from "./messageActions";

test("the actions menu opens below when a message is close to the top", () => {
  assert.equal(
    chatMessageMenuPlacement({
      rootTop: 90,
      rootBottom: 120,
      viewportHeight: 800,
    }),
    "below",
  );
});

test("the actions menu opens above when there is enough room", () => {
  assert.equal(
    chatMessageMenuPlacement({
      rootTop: 600,
      rootBottom: 630,
      viewportHeight: 800,
    }),
    "above",
  );
});

test("the actions menu uses the roomier side when neither side fits", () => {
  assert.equal(
    chatMessageMenuPlacement({
      rootTop: 170,
      rootBottom: 200,
      viewportHeight: 380,
    }),
    "below",
  );
});
