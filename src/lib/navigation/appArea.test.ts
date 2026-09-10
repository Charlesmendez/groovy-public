import assert from "node:assert/strict";
import test from "node:test";
import {
  appAreaHrefForShortcut,
  appAreaNavigationState,
  isAppAreaActive,
} from "./appArea";

test("Command and Control number shortcuts select the main product areas", () => {
  assert.equal(
    appAreaHrefForShortcut({ key: "1", metaKey: true }),
    "/dashboard",
  );
  assert.equal(
    appAreaHrefForShortcut({ key: "2", ctrlKey: true }),
    "/chat",
  );
  assert.equal(
    appAreaHrefForShortcut({
      key: "Unidentified",
      code: "Digit3",
      metaKey: true,
    }),
    "/email",
  );
});

test("area shortcuts reject plain, shifted, repeated, and composing keys", () => {
  assert.equal(appAreaHrefForShortcut({ key: "1" }), null);
  assert.equal(
    appAreaHrefForShortcut({ key: "2", metaKey: true, shiftKey: true }),
    null,
  );
  assert.equal(
    appAreaHrefForShortcut({ key: "3", ctrlKey: true, repeat: true }),
    null,
  );
  assert.equal(
    appAreaHrefForShortcut({
      key: "1",
      metaKey: true,
      isComposing: true,
    }),
    null,
  );
});

test("each main product surface has one stable active area", () => {
  assert.equal(isAppAreaActive("/dashboard", "/dashboard"), true);
  assert.equal(isAppAreaActive("/dashboard/cells/123", "/dashboard"), true);
  assert.equal(isAppAreaActive("/chat/channel-1", "/chat"), true);
  assert.equal(isAppAreaActive("/email", "/email"), true);
  assert.equal(isAppAreaActive("/settings", "/dashboard"), false);
  assert.equal(isAppAreaActive("/dashboardish", "/dashboard"), false);
});

test("clicked destinations show pending feedback until they become active", () => {
  assert.deepEqual(
    appAreaNavigationState({
      pathname: "/email",
      href: "/chat",
      pendingHref: "/chat",
    }),
    { active: false, pending: true },
  );
  assert.deepEqual(
    appAreaNavigationState({
      pathname: "/chat/channel-1",
      href: "/chat",
      pendingHref: "/chat",
    }),
    { active: true, pending: false },
  );
});
