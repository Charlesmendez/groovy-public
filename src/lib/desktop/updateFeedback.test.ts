import assert from "node:assert/strict";
import test from "node:test";
import { desktopUpdateCheckFeedback } from "./updateFeedback";

test("explains when a required Desktop release is absent from the feed", () => {
  assert.equal(
    desktopUpdateCheckFeedback({
      requiredVersion: "0.24.27",
      status: { state: "idle" },
    }),
    "Groovy Desktop 0.24.27 has not reached the updater feed yet. Try again shortly.",
  );
  assert.equal(
    desktopUpdateCheckFeedback({
      requiredVersion: "0.24.27",
      status: { state: "downloading", version: "0.24.27" },
    }),
    null,
  );
  assert.equal(
    desktopUpdateCheckFeedback({
      status: { state: "idle" },
    }),
    null,
  );
});
