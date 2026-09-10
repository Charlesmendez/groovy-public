import assert from "node:assert/strict";
import test from "node:test";
import {
  completedDesktopConnection,
  desktopDatagranConnectUrl,
  providerUsesDesktopBrowserOAuth,
} from "./desktopConnect";

test("desktop browser handoff is limited to OAuth providers", () => {
  assert.equal(providerUsesDesktopBrowserOAuth("google_calendar"), true);
  assert.equal(providerUsesDesktopBrowserOAuth("gmail"), true);
  assert.equal(providerUsesDesktopBrowserOAuth("postgres"), false);
  assert.equal(providerUsesDesktopBrowserOAuth("firecrawl"), false);
  assert.equal(providerUsesDesktopBrowserOAuth("web_pixel"), false);
});

test("desktop OAuth handoff uses the system-browser origin", () => {
  const url = new URL(
    desktopDatagranConnectUrl({
      provider: "google_calendar",
      agentId: "agent-1",
      currentOrigin: "https://www.gogroovy.ai",
    }),
  );

  assert.equal(url.origin, "https://gogroovy.ai");
  assert.equal(url.pathname, "/connect/datagran");
  assert.equal(url.searchParams.get("provider"), "google_calendar");
  assert.equal(url.searchParams.get("agentId"), "agent-1");
});

test("desktop handoff remains cross-origin when the app uses the apex domain", () => {
  const url = new URL(
    desktopDatagranConnectUrl({
      provider: "google_calendar",
      currentOrigin: "https://gogroovy.ai",
    }),
  );

  assert.equal(url.origin, "https://www.gogroovy.ai");
});

test("desktop Gmail handoff carries explicit recipient-tracking consent", () => {
  const url = new URL(
    desktopDatagranConnectUrl({
      provider: "gmail",
      agentId: "gmail-agent",
      recipientTracking: true,
      currentOrigin: "https://gogroovy.ai",
    }),
  );

  assert.equal(url.searchParams.get("recipientTracking"), "1");
});

test("new desktop connections complete only when a new configured agent appears", () => {
  const baseline = [
    {
      agentId: "existing",
      provider: "google_calendar",
      connectionId: "calendar-1",
      updatedAt: "2026-07-29T10:00:00.000Z",
    },
  ];
  const current = [
    ...baseline,
    {
      agentId: "new-agent",
      provider: "google_calendar",
      connectionId: "calendar-2",
      updatedAt: "2026-07-29T10:01:00.000Z",
    },
  ];

  assert.equal(
    completedDesktopConnection({
      provider: "google_calendar",
      baseline,
      current,
    })?.agentId,
    "new-agent",
  );
});

test("desktop reconnects wait for the existing config update", () => {
  const baseline = [
    {
      agentId: "agent-1",
      provider: "google_calendar",
      connectionId: "calendar-1",
      updatedAt: "2026-07-29T10:00:00.000Z",
    },
  ];

  assert.equal(
    completedDesktopConnection({
      provider: "google_calendar",
      targetAgentId: "agent-1",
      baseline,
      current: baseline,
    }),
    null,
  );
  assert.equal(
    completedDesktopConnection({
      provider: "google_calendar",
      targetAgentId: "agent-1",
      baseline,
      current: [
        {
          ...baseline[0],
          updatedAt: "2026-07-29T10:01:00.000Z",
        },
      ],
    })?.connectionId,
    "calendar-1",
  );
});
