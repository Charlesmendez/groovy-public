import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MobileNotificationGuide } from "./MobileNotificationGuide";
import { PushNotificationSettings } from "./PushNotificationSettings";
import { RoomNotificationPanel } from "./RoomNotificationControl";

function plainText(markup: string): string {
  return markup.replace(/<[^>]+>/g, "").replace(/\s+/g, " ");
}

for (const compact of [false, true]) {
  test(`mobile guidance keeps the iOS requirement visible (${compact ? "compact" : "full"})`, () => {
    const markup = renderToStaticMarkup(
      createElement(MobileNotificationGuide, { compact }),
    );
    const beforeSteps = plainText(markup.split("<details")[0]);
    assert.match(beforeSteps, /iPhone &amp; iPad:/);
    assert.match(
      beforeSteps,
      /only work in the Home Screen app, not in a browser tab/,
    );
    assert.match(beforeSteps, /open it from its icon first/);
    assert.match(markup, /aria-label="Mobile notification setup"/);
    assert.match(
      markup,
      /<summary[^>]*>How to set up iPhone or iPad<\/summary>/,
    );
    assert.doesNotMatch(markup, /<details[^>]*\sopen(?:[\s=>])/);
    assert.equal((markup.match(/<li>/g) || []).length, 3);
    const text = plainText(markup);
    assert.match(text, /Share, then Add to Home Screen/);
    assert.match(text, /keep Open as Web App on/);
    assert.match(text, /sign in if asked/);
    assert.match(text, /tap Allow when prompted/);
    assert.match(text, /iOS or iPadOS 16\.4 or later/);
    assert.match(
      text,
      /Android: supported browsers such as Chrome can notify you without installing Groovy/,
    );
  });
}

test("Settings explains mobile setup before the room opt-in controls", () => {
  const markup = renderToStaticMarkup(
    createElement(PushNotificationSettings, {
      rooms: [
        {
          id: "room-1",
          kind: "channel",
          name: "Design",
          topic: null,
          visibility: "workspace",
        },
      ],
    }),
  );
  const guidanceIndex = markup.indexOf(
    'aria-label="Mobile notification setup"',
  );
  assert.ok(guidanceIndex >= 0);
  assert.ok(
    guidanceIndex <
      markup.indexOf('placeholder="Search channels and direct messages"'),
  );
});

test("channel settings explain mobile setup before the alert choices", () => {
  const markup = renderToStaticMarkup(
    createElement(RoomNotificationPanel, {
      room: { id: "room-1", kind: "channel", name: "Design" },
    }),
  );
  const guidanceIndex = markup.indexOf(
    'aria-label="Mobile notification setup"',
  );
  assert.ok(guidanceIndex >= 0);
  assert.ok(guidanceIndex < markup.indexOf("All new messages"));
});
