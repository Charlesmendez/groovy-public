import assert from "node:assert/strict";
import test from "node:test";
import {
  DATAGRAN_CONNECTION_HEALTH_CHECKS,
  isDatagranAuthorizationRequiredError,
} from "./connectionHealth";

test("Google Calendar health uses an endpoint allowed by calendar.events.owned", () => {
  const check = DATAGRAN_CONNECTION_HEALTH_CHECKS.google_calendar;

  assert.equal(check?.method, "GET");
  assert.equal(
    check?.endpoint,
    "/api/proxy/google-calendar/calendar/v3/calendars/primary/events?maxResults=1&singleEvents=true",
  );
  assert.doesNotMatch(check?.endpoint || "", /calendarList/);
});

test("Postgres health executes a bounded read-only query", () => {
  const check = DATAGRAN_CONNECTION_HEALTH_CHECKS.postgres;

  assert.equal(check?.method, "POST");
  assert.equal(check?.endpoint, "/api/proxy/postgres/query");
  assert.deepEqual(check?.body, {
    sql: "SELECT 1 AS connection_ok LIMIT 1",
    params: [],
  });
});

test("scope-related 403 errors are not mislabeled as expired credentials", () => {
  const data = {
    error: {
      code: 403,
      message: "Request had insufficient authentication scopes.",
      errors: [{ reason: "insufficientPermissions" }],
      details: [{ reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT" }],
    },
  };

  assert.equal(
    isDatagranAuthorizationRequiredError(
      403,
      data,
      "google_calendar",
    ),
    false,
  );
});

test("credential failures still request reauthentication", () => {
  assert.equal(
    isDatagranAuthorizationRequiredError(
      401,
      { error: "invalid_token" },
      "google_calendar",
    ),
    true,
  );
  assert.equal(
    isDatagranAuthorizationRequiredError(
      403,
      { status: "authorization_required" },
      "google_calendar",
    ),
    true,
  );
});
