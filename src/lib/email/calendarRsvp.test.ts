import assert from "node:assert/strict";
import test from "node:test";
import {
  authenticatedCalendarAttendee,
  CalendarInvitationAccountNotConnectedError,
  CalendarInvitationPendingError,
  type CalendarRsvpDiagnostic,
  primaryCalendarAccountEmail,
  respondToCalendarInvitation,
  writableSecondaryCalendarIds,
} from "./calendarRsvp";

function calendarSupabaseStub(
  connectionIds: string[] = ["calendar-connection"],
) {
  const query = {
    select() {
      return this;
    },
    eq() {
      return this;
    },
    not() {
      return this;
    },
    async order() {
      return {
        data: connectionIds.map((connectionId) => ({
          connection_id: connectionId,
          datagran_api_key_enc: null,
        })),
        error: null,
      };
    },
  };
  return {
    from() {
      return query;
    },
  };
}

test("calendar RSVP accepts the authenticated attendee when Gmail used an alias", () => {
  const attendee = authenticatedCalendarAttendee({
    expectedEmail: "calendar-alias@example.com",
    attendees: [
      {
        email: "canonical-account@example.com",
        responseStatus: "needsAction",
        self: true,
      },
      {
        email: "another-guest@example.com",
        responseStatus: "accepted",
      },
    ],
  });

  assert.equal(attendee?.email, "canonical-account@example.com");
});

test("calendar RSVP prefers an exact mailbox match among authenticated attendees", () => {
  const attendee = authenticatedCalendarAttendee({
    expectedEmail: "work@example.com",
    attendees: [
      { email: "alias@example.com", self: true },
      { email: "work@example.com", self: true },
    ],
  });

  assert.equal(attendee?.email, "work@example.com");
});

test("calendar RSVP trusts Google's authenticated attendee when the mailbox identity is unavailable", () => {
  const attendee = authenticatedCalendarAttendee({
    expectedEmail: "",
    attendees: [
      {
        email: "cm@datagran.io",
        responseStatus: "needsAction",
        self: true,
      },
    ],
  });

  assert.equal(attendee?.email, "cm@datagran.io");
});

test("calendar RSVP searches only writable secondary calendars", () => {
  assert.deepEqual(
    writableSecondaryCalendarIds({
      items: [
        { id: "primary@example.com", primary: true, accessRole: "owner" },
        { id: "team@example.com", accessRole: "writer" },
        { id: "resources@example.com", accessRole: "reader" },
        { id: "private@example.com", accessRole: "writerWithoutPrivateAccess" },
        { id: "deleted@example.com", accessRole: "owner", deleted: true },
        { id: "team@example.com", accessRole: "writer" },
      ],
    }),
    ["team@example.com", "private@example.com"],
  );
  assert.equal(
    primaryCalendarAccountEmail({
      items: [
        {
          id: "deleted@example.com",
          primary: true,
          deleted: true,
        },
        {
          id: "Primary@Example.com",
          primary: true,
          accessRole: "owner",
        },
      ],
    }),
    "primary@example.com",
  );
});

test("calendar RSVP patches the secondary calendar where the invitation lives", async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.DATAGRAN_API_KEY;
  const requestedUrls: string[] = [];
  process.env.DATAGRAN_API_KEY = "test-key";
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    requestedUrls.push(`${init?.method || "GET"} ${url}`);
    if (url.includes("/calendars/primary/events?")) {
      return Response.json({ items: [] });
    }
    if (url.includes("/users/me/calendarList?")) {
      return Response.json({
        items: [
          {
            id: "alias@example.com",
            primary: true,
            accessRole: "owner",
          },
          { id: "team@example.com", accessRole: "writer" },
        ],
      });
    }
    if (url.includes("/calendars/team%40example.com/events?")) {
      return Response.json({
        items: [
          {
            id: "event-123",
            iCalUID: "event-123@example.com",
            summary: "Quarterly planning",
            attendees: [
              {
                email: "canonical@example.com",
                responseStatus: "needsAction",
                self: true,
              },
            ],
          },
        ],
      });
    }
    if (
      init?.method === "PATCH" &&
      url.includes("/calendars/team%40example.com/events/event-123")
    ) {
      return Response.json({
        id: "event-123",
        iCalUID: "event-123@example.com",
        summary: "Quarterly planning",
        attendees: [
          {
            email: "canonical@example.com",
            responseStatus: "accepted",
            self: true,
          },
        ],
      });
    }
    return Response.json({ error: { message: "Unexpected request" } }, {
      status: 500,
    });
  };

  try {
    const invite = await respondToCalendarInvitation({
      supabase: calendarSupabaseStub() as never,
      userId: "user-123",
      iCalUid: "event-123@example.com",
      attendeeEmail: "alias@example.com",
      responseStatus: "accepted",
    });

    assert.equal(invite.responseStatus, "accepted");
    assert.ok(
      requestedUrls.some((request) =>
        request.startsWith(
          "PATCH https://www.datagran.io/api/proxy/google-calendar/calendar/v3/calendars/team%40example.com/events/event-123",
        ),
      ),
    );
    assert.equal(
      requestedUrls.some((request) =>
        request.startsWith(
          "PATCH https://www.datagran.io/api/proxy/google-calendar/calendar/v3/calendars/primary/",
        ),
      ),
      false,
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) {
      delete process.env.DATAGRAN_API_KEY;
    } else {
      process.env.DATAGRAN_API_KEY = originalApiKey;
    }
  }
});

test("calendar RSVP preserves a primary-calendar alias match asserted by Google", async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.DATAGRAN_API_KEY;
  let calendarListCalls = 0;
  process.env.DATAGRAN_API_KEY = "test-key";
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (
      init?.method !== "PATCH" &&
      url.includes("/calendars/primary/events?")
    ) {
      return Response.json({
        items: [
          {
            id: "primary-alias-event",
            iCalUID: "primary-alias-event@example.com",
            summary: "Alias invitation",
            attendees: [
              {
                email: "canonical-account@example.com",
                responseStatus: "needsAction",
                self: true,
              },
            ],
          },
        ],
      });
    }
    if (url.includes("/users/me/calendarList?")) {
      calendarListCalls += 1;
      return Response.json({ items: [] });
    }
    if (
      init?.method === "PATCH" &&
      url.includes("/calendars/primary/events/primary-alias-event")
    ) {
      return Response.json({
        id: "primary-alias-event",
        iCalUID: "primary-alias-event@example.com",
        summary: "Alias invitation",
        attendees: [
          {
            email: "canonical-account@example.com",
            responseStatus: "accepted",
            self: true,
          },
        ],
      });
    }
    return Response.json(
      { error: { message: "Unexpected request" } },
      { status: 500 },
    );
  };

  try {
    const invite = await respondToCalendarInvitation({
      supabase: calendarSupabaseStub() as never,
      userId: "user-123",
      iCalUid: "primary-alias-event@example.com",
      attendeeEmail: "calendar-alias@example.com",
      responseStatus: "accepted",
    });

    assert.equal(invite.responseStatus, "accepted");
    assert.equal(calendarListCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) {
      delete process.env.DATAGRAN_API_KEY;
    } else {
      process.env.DATAGRAN_API_KEY = originalApiKey;
    }
  }
});

test("calendar RSVP fails immediately when Hibe Gmail has only Datagran Calendar connected", async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.DATAGRAN_API_KEY;
  const diagnostics: CalendarRsvpDiagnostic[] = [];
  let primarySearches = 0;
  let secondarySearches = 0;
  process.env.DATAGRAN_API_KEY = "test-key";
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes("/calendars/primary/events?")) {
      primarySearches += 1;
      return Response.json({ items: [] });
    }
    if (url.includes("/users/me/calendarList?")) {
      return Response.json({
        items: [
          {
            id: "cm@datagran.io",
            primary: true,
            accessRole: "owner",
          },
          ...Array.from({ length: 12 }, (_, index) => ({
            id: `secondary-${index + 1}@datagran.io`,
            accessRole: "writer",
          })),
        ],
      });
    }
    if (url.includes("/calendars/") && url.includes("/events?")) {
      secondarySearches += 1;
      return Response.json({ items: [] });
    }
    return Response.json(
      { error: { message: "Unexpected request" } },
      { status: 500 },
    );
  };

  try {
    await assert.rejects(
      respondToCalendarInvitation({
        // The same external connection may be assigned through more than one
        // local config. It must still consume Calendar quota only once.
        supabase: calendarSupabaseStub([
          "calendar-connection",
          "calendar-connection",
        ]) as never,
        userId: "user-123",
        iCalUid: "mark-rattin-invite@example.com",
        attendeeEmail: "cm@hibe.ai",
        responseStatus: "accepted",
        onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      }),
      (error: unknown) => {
        assert.ok(
          error instanceof CalendarInvitationAccountNotConnectedError,
        );
        assert.equal(error.requiredEmail, "cm@hibe.ai");
        assert.equal(error.retryable, false);
        return true;
      },
    );

    assert.equal(primarySearches, 1);
    assert.equal(secondarySearches, 0);
    assert.equal(diagnostics.length, 1);
    assert.deepEqual(
      {
        outcome: diagnostics[0].outcome,
        calendarConnectionCount: diagnostics[0].calendarConnectionCount,
        resolvedIdentityCount: diagnostics[0].resolvedIdentityCount,
        matchingIdentityCount: diagnostics[0].matchingIdentityCount,
      },
      {
        outcome: "account_not_connected",
        calendarConnectionCount: 1,
        resolvedIdentityCount: 1,
        matchingIdentityCount: 0,
      },
    );
    assert.equal(diagnostics[0].eventLookupCount, 1);
    assert.equal(diagnostics[0].secondaryCalendarCount, 12);
    const serializedDiagnostic = JSON.stringify(diagnostics[0]);
    assert.equal(serializedDiagnostic.includes("cm@hibe.ai"), false);
    assert.equal(
      serializedDiagnostic.includes("mark-rattin-invite@example.com"),
      false,
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) {
      delete process.env.DATAGRAN_API_KEY;
    } else {
      process.env.DATAGRAN_API_KEY = originalApiKey;
    }
  }
});

test("calendar RSVP reports a missing Calendar connection without making API calls", async () => {
  const originalFetch = globalThis.fetch;
  const diagnostics: CalendarRsvpDiagnostic[] = [];
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return Response.json({});
  };

  try {
    await assert.rejects(
      respondToCalendarInvitation({
        supabase: calendarSupabaseStub([]) as never,
        userId: "user-123",
        iCalUid: "event-without-calendar@example.com",
        attendeeEmail: "cm@hibe.ai",
        responseStatus: "accepted",
        onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      }),
      (error: unknown) => {
        assert.ok(
          error instanceof CalendarInvitationAccountNotConnectedError,
        );
        assert.equal(error.requiredEmail, "cm@hibe.ai");
        assert.equal(error.retryable, false);
        return true;
      },
    );

    assert.equal(fetchCalls, 0);
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0].outcome, "account_not_connected");
    assert.equal(diagnostics[0].calendarConnectionCount, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("calendar RSVP waits for a newly delivered invitation to appear", async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.DATAGRAN_API_KEY;
  let primarySearches = 0;
  process.env.DATAGRAN_API_KEY = "test-key";
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (
      init?.method !== "PATCH" &&
      url.includes("/calendars/primary/events?")
    ) {
      primarySearches += 1;
      if (primarySearches === 1) return Response.json({ items: [] });
      return Response.json({
        items: [
          {
            id: "event-delayed",
            iCalUID: "event-delayed@example.com",
            summary: "Delayed invitation",
            attendees: [
              {
                email: "work@example.com",
                responseStatus: "needsAction",
                self: true,
              },
            ],
          },
        ],
      });
    }
    if (url.includes("/users/me/calendarList?")) {
      return Response.json({
        items: [
          {
            id: "work@example.com",
            primary: true,
            accessRole: "owner",
          },
        ],
      });
    }
    if (
      init?.method === "PATCH" &&
      url.includes("/calendars/primary/events/event-delayed")
    ) {
      return Response.json({
        id: "event-delayed",
        iCalUID: "event-delayed@example.com",
        summary: "Delayed invitation",
        attendees: [
          {
            email: "work@example.com",
            responseStatus: "tentative",
            self: true,
          },
        ],
      });
    }
    return Response.json(
      { error: { message: "Unexpected request" } },
      { status: 500 },
    );
  };

  try {
    const invite = await respondToCalendarInvitation({
      supabase: calendarSupabaseStub() as never,
      userId: "user-123",
      iCalUid: "event-delayed@example.com",
      attendeeEmail: "work@example.com",
      responseStatus: "tentative",
    });

    assert.equal(primarySearches, 2);
    assert.equal(invite.responseStatus, "tentative");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) {
      delete process.env.DATAGRAN_API_KEY;
    } else {
      process.env.DATAGRAN_API_KEY = originalApiKey;
    }
  }
});

test("calendar RSVP reads the event back when PATCH omits attendee state", async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.DATAGRAN_API_KEY;
  let confirmationReads = 0;
  process.env.DATAGRAN_API_KEY = "test-key";
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (
      init?.method !== "PATCH" &&
      url.includes("/calendars/primary/events?")
    ) {
      return Response.json({
        items: [
          {
            id: "event-confirm",
            iCalUID: "event-confirm@example.com",
            summary: "Confirmed invitation",
            attendees: [
              {
                email: "work@example.com",
                responseStatus: "needsAction",
                self: true,
              },
            ],
          },
        ],
      });
    }
    if (
      init?.method === "PATCH" &&
      url.includes("/calendars/primary/events/event-confirm")
    ) {
      return Response.json({
        id: "event-confirm",
        iCalUID: "event-confirm@example.com",
        summary: "Confirmed invitation",
      });
    }
    if (
      init?.method !== "PATCH" &&
      url.includes("/calendars/primary/events/event-confirm?")
    ) {
      confirmationReads += 1;
      return Response.json({
        id: "event-confirm",
        iCalUID: "event-confirm@example.com",
        summary: "Confirmed invitation",
        attendees: [
          {
            email: "work@example.com",
            responseStatus: "accepted",
            self: true,
          },
        ],
      });
    }
    return Response.json(
      { error: { message: "Unexpected request" } },
      { status: 500 },
    );
  };

  try {
    const invite = await respondToCalendarInvitation({
      supabase: calendarSupabaseStub() as never,
      userId: "user-123",
      iCalUid: "event-confirm@example.com",
      attendeeEmail: "work@example.com",
      responseStatus: "accepted",
    });

    assert.equal(confirmationReads, 1);
    assert.equal(invite.responseStatus, "accepted");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) {
      delete process.env.DATAGRAN_API_KEY;
    } else {
      process.env.DATAGRAN_API_KEY = originalApiKey;
    }
  }
});

test("calendar RSVP keeps an invitation pending when Google has not exposed the event", async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.DATAGRAN_API_KEY;
  const originalSetTimeout = globalThis.setTimeout;
  process.env.DATAGRAN_API_KEY = "test-key";
  globalThis.setTimeout = ((
    callback: (...args: unknown[]) => void,
    _delay?: number,
    ...args: unknown[]
  ) => originalSetTimeout(callback, 0, ...args)) as typeof setTimeout;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (
      url.includes("/calendars/primary/events?") ||
      url.includes("/calendars/team%40datagran.io/events?")
    ) {
      return Response.json({ items: [] });
    }
    if (url.includes("/users/me/calendarList?")) {
      return Response.json({
        items: [
          {
            id: "cm@datagran.io",
            primary: true,
            accessRole: "owner",
          },
          {
            id: "team@datagran.io",
            accessRole: "writer",
          },
        ],
      });
    }
    return Response.json(
      { error: { message: "Unexpected request" } },
      { status: 500 },
    );
  };

  try {
    await assert.rejects(
      respondToCalendarInvitation({
        supabase: calendarSupabaseStub() as never,
        userId: "user-123",
        iCalUid: "roberto-invite@datagran.io",
        attendeeEmail: "cm@datagran.io",
        responseStatus: "accepted",
      }),
      (error: unknown) =>
        error instanceof CalendarInvitationPendingError &&
        error.message.includes("has not added this invitation yet"),
    );
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalSetTimeout;
    if (originalApiKey === undefined) {
      delete process.env.DATAGRAN_API_KEY;
    } else {
      process.env.DATAGRAN_API_KEY = originalApiKey;
    }
  }
});

test("calendar RSVP does not claim an account mismatch when one Calendar identity cannot be resolved", async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.DATAGRAN_API_KEY;
  const originalSetTimeout = globalThis.setTimeout;
  const diagnostics: CalendarRsvpDiagnostic[] = [];
  let primarySearches = 0;
  process.env.DATAGRAN_API_KEY = "test-key";
  globalThis.setTimeout = ((
    callback: (...args: unknown[]) => void,
    _delay?: number,
    ...args: unknown[]
  ) => originalSetTimeout(callback, 0, ...args)) as typeof setTimeout;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    const connectionId = url.searchParams.get("connection_id");
    if (url.pathname.includes("/calendars/primary/events")) {
      primarySearches += 1;
      return Response.json({ items: [] });
    }
    if (url.pathname.includes("/users/me/calendarList")) {
      if (connectionId === "calendar-unresolved") {
        return Response.json(
          { error: { message: "Insufficient Permission" } },
          { status: 403 },
        );
      }
      return Response.json({
        items: [
          {
            id: "cm@datagran.io",
            primary: true,
            accessRole: "owner",
          },
        ],
      });
    }
    return Response.json(
      { error: { message: "Unexpected request" } },
      { status: 500 },
    );
  };

  try {
    await assert.rejects(
      respondToCalendarInvitation({
        supabase: calendarSupabaseStub([
          "calendar-datagran",
          "calendar-unresolved",
        ]) as never,
        userId: "user-123",
        iCalUid: "possibly-hibe@example.com",
        attendeeEmail: "cm@hibe.ai",
        responseStatus: "tentative",
        onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      }),
      (error: unknown) => {
        assert.ok(error instanceof CalendarInvitationPendingError);
        assert.equal(
          error instanceof CalendarInvitationAccountNotConnectedError,
          false,
        );
        return true;
      },
    );

    assert.equal(primarySearches, 6);
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0].outcome, "pending");
    assert.equal(diagnostics[0].calendarConnectionCount, 2);
    assert.equal(diagnostics[0].resolvedIdentityCount, 1);
    assert.equal(diagnostics[0].matchingIdentityCount, 0);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalSetTimeout;
    if (originalApiKey === undefined) {
      delete process.env.DATAGRAN_API_KEY;
    } else {
      process.env.DATAGRAN_API_KEY = originalApiKey;
    }
  }
});

test("calendar RSVP does not claim an account mismatch when an event lookup fails", async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.DATAGRAN_API_KEY;
  const originalSetTimeout = globalThis.setTimeout;
  const diagnostics: CalendarRsvpDiagnostic[] = [];
  let primarySearches = 0;
  let secondarySearches = 0;
  process.env.DATAGRAN_API_KEY = "test-key";
  globalThis.setTimeout = ((
    callback: (...args: unknown[]) => void,
    _delay?: number,
    ...args: unknown[]
  ) => originalSetTimeout(callback, 0, ...args)) as typeof setTimeout;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes("/calendars/primary/events?")) {
      primarySearches += 1;
      return Response.json({ items: [] });
    }
    if (url.includes("/users/me/calendarList?")) {
      return Response.json({
        items: [
          {
            id: "cm@hibe.ai",
            primary: true,
            accessRole: "owner",
          },
          {
            id: "team@datagran.io",
            accessRole: "writer",
          },
        ],
      });
    }
    if (url.includes("/calendars/team%40datagran.io/events?")) {
      secondarySearches += 1;
      return Response.json(
        { error: { message: "Insufficient Permission" } },
        { status: 403 },
      );
    }
    return Response.json(
      { error: { message: "Unexpected request" } },
      { status: 500 },
    );
  };

  try {
    await assert.rejects(
      respondToCalendarInvitation({
        supabase: calendarSupabaseStub() as never,
        userId: "user-123",
        iCalUid: "possible-alias-event@example.com",
        attendeeEmail: "cm@hibe.ai",
        responseStatus: "accepted",
        onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      }),
      (error: unknown) => {
        assert.ok(error instanceof CalendarInvitationPendingError);
        assert.equal(
          error instanceof CalendarInvitationAccountNotConnectedError,
          false,
        );
        return true;
      },
    );

    assert.equal(primarySearches, 3);
    assert.equal(secondarySearches, 1);
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0].outcome, "pending");
    assert.equal(diagnostics[0].failedEventLookupCount, 1);
    assert.equal(diagnostics[0].searchCompletedSuccessfully, false);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalSetTimeout;
    if (originalApiKey === undefined) {
      delete process.env.DATAGRAN_API_KEY;
    } else {
      process.env.DATAGRAN_API_KEY = originalApiKey;
    }
  }
});
