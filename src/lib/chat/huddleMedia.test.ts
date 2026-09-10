import assert from "node:assert/strict";
import test from "node:test";
import {
  canExpandHuddleScreenShare,
  huddleVideoObjectFit,
} from "./huddleMedia";

test("a received screen share with video can be expanded", () => {
  assert.equal(
    canExpandHuddleScreenShare({ hasVideo: true, screenSharing: true }),
    true,
  );
});

test("camera video and empty streams do not show a screen-share expander", () => {
  assert.equal(
    canExpandHuddleScreenShare({ hasVideo: true, screenSharing: false }),
    false,
  );
  assert.equal(
    canExpandHuddleScreenShare({ hasVideo: false, screenSharing: true }),
    false,
  );
});

test("screen shares preserve the full frame while camera video fills its tile", () => {
  assert.equal(huddleVideoObjectFit(true), "object-contain");
  assert.equal(huddleVideoObjectFit(false), "object-cover");
});
