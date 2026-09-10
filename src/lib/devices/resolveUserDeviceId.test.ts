import { strict as assert } from "node:assert";
import test from "node:test";
import { chooseUserDeviceId, chooseUserDeviceIds } from "./resolveUserDeviceId";

const NOW = Date.parse("2026-07-30T03:45:00.000Z");

test("uses the preferred connector while it is still active", () => {
  assert.equal(
    chooseUserDeviceId({
      preferredDeviceId: "preferred",
      nowMs: NOW,
      devices: [
        { id: "latest", last_seen: "2026-07-30T03:44:55.000Z" },
        { id: "preferred", last_seen: "2026-07-30T03:44:20.000Z" },
      ],
    }),
    "preferred",
  );
});

test("falls back to the freshest connector when the preference is stale", () => {
  assert.equal(
    chooseUserDeviceId({
      preferredDeviceId: "stale-preference",
      nowMs: NOW,
      devices: [
        { id: "active", last_seen: "2026-07-30T03:44:55.000Z" },
        {
          id: "stale-preference",
          last_seen: "2026-03-14T16:06:13.087Z",
        },
      ],
    }),
    "active",
  );
});

test("falls back to the freshest owned connector for missing preferences", () => {
  assert.equal(
    chooseUserDeviceId({
      preferredDeviceId: "deleted-device",
      nowMs: NOW,
      devices: [
        { id: "active", last_seen: "2026-07-30T03:44:55.000Z" },
        { id: "older", last_seen: "2026-07-29T20:00:00.000Z" },
      ],
    }),
    "active",
  );
});

test("returns null when the user has no connector records", () => {
  assert.equal(
    chooseUserDeviceId({
      preferredDeviceId: null,
      nowMs: NOW,
      devices: [],
    }),
    null,
  );
});

test("returns fallback connector candidates after a recent preference", () => {
  assert.deepEqual(
    chooseUserDeviceIds({
      preferredDeviceId: "preferred",
      nowMs: NOW,
      devices: [
        { id: "latest", last_seen: "2026-07-30T03:44:55.000Z" },
        { id: "preferred", last_seen: "2026-07-30T03:44:20.000Z" },
        { id: "older", last_seen: "2026-07-29T20:00:00.000Z" },
      ],
    }),
    ["preferred", "latest", "older"],
  );
});

test("returns freshest connector first when the preference is stale", () => {
  assert.deepEqual(
    chooseUserDeviceIds({
      preferredDeviceId: "stale-preference",
      nowMs: NOW,
      devices: [
        { id: "active", last_seen: "2026-07-30T03:44:55.000Z" },
        { id: "stale-preference", last_seen: "2026-03-14T16:06:13.087Z" },
      ],
    }),
    ["active", "stale-preference"],
  );
});
