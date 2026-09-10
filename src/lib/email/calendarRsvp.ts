import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { decryptLlmApiKey } from "@/lib/crypto/llmKey";
import type {
  EmailCalendarInvite,
  EmailCalendarResponseStatus,
} from "@/lib/email/types";

type RecordLike = Record<string, unknown>;

type CalendarConnection = {
  connectionId: string;
  datagranApiKey: string;
};

type CalendarEventMatch = {
  connection: CalendarConnection;
  calendarId: string;
  event: RecordLike;
  selfAttendee: RecordLike;
};

type CalendarEventLookup = {
  match: CalendarEventMatch | null;
  accountMismatchConfirmed: boolean;
  connectedAccountEmails: string[];
  resolvedIdentityCount: number;
  eventLookupCount: number;
  failedEventLookupCount: number;
  secondaryCalendarCount: number;
  searchCompletedSuccessfully: boolean;
};

export type CalendarRsvpDiagnostic = {
  outcome: "account_not_connected" | "pending";
  invitationUidHash: string;
  attendeeEmailHash: string;
  calendarConnectionCount: number;
  resolvedIdentityCount: number;
  matchingIdentityCount: number;
  eventLookupCount: number;
  failedEventLookupCount: number;
  secondaryCalendarCount: number;
  searchCompletedSuccessfully: boolean;
};

export class CalendarInvitationPendingError extends Error {
  readonly retryAfterMs = 5_000;

  constructor() {
    super(
      "Google Calendar has not added this invitation yet. Your response was not sent; retry in a moment.",
    );
    this.name = "CalendarInvitationPendingError";
  }
}

export class CalendarInvitationAccountNotConnectedError extends Error {
  readonly code = "calendar_account_not_connected";
  readonly retryable = false;
  readonly requiredEmail: string;

  constructor(requiredEmail: string) {
    const normalizedEmail = requiredEmail.trim().toLowerCase();
    super(
      normalizedEmail
        ? `Connect Google Calendar for ${normalizedEmail} before responding to this invitation.`
        : "Connect the Google Calendar account that received this invitation before responding.",
    );
    this.name = "CalendarInvitationAccountNotConnectedError";
    this.requiredEmail = normalizedEmail;
  }
}

const DATAGRAN_ORIGIN = "https://www.datagran.io";
const CALENDAR_TIMEOUT_MS = 30_000;
const CALENDAR_RETRY_DELAYS_MS = [800, 2_000] as const;
const CALENDAR_VISIBILITY_RETRY_DELAYS_MS = [1_500, 4_000] as const;
const MAX_SECONDARY_CALENDARS_PER_CONNECTION = 24;
const WRITABLE_CALENDAR_ROLES = new Set([
  "owner",
  "writer",
  "writerWithoutPrivateAccess",
]);

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function record(value: unknown): RecordLike {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordLike)
    : {};
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function normalizedEmail(value: unknown): string {
  const normalized = text(value).toLowerCase();
  return /^[^\s@]+@[^\s@]+$/.test(normalized) ? normalized : "";
}

function diagnosticHash(value: string): string {
  return createHash("sha256")
    .update(value.trim().toLowerCase(), "utf8")
    .digest("hex")
    .slice(0, 16);
}

function emitDiagnostic(
  callback: ((diagnostic: CalendarRsvpDiagnostic) => void) | undefined,
  diagnostic: CalendarRsvpDiagnostic,
): void {
  try {
    callback?.(diagnostic);
  } catch {
    // Diagnostics must never affect whether an RSVP is sent.
  }
}

export function authenticatedCalendarAttendee(args: {
  attendees: unknown;
  expectedEmail: string;
}): RecordLike | null {
  const authenticated = array(args.attendees)
    .map(record)
    .filter((attendee) => attendee.self === true && text(attendee.email));
  if (authenticated.length === 0) return null;
  const expectedEmail = args.expectedEmail.trim().toLowerCase();
  return (
    authenticated.find(
      (attendee) => text(attendee.email).toLowerCase() === expectedEmail,
    ) ||
    // Google Calendar can return the canonical account address here while
    // Gmail received the invitation through an alias. `self` is asserted by
    // the authenticated Calendar account, so it is the ownership boundary.
    authenticated[0]
  );
}

function allWritableSecondaryCalendarIds(value: unknown): string[] {
  const seen = new Set<string>();
  const calendarIds: string[] = [];
  for (const raw of array(record(value).items)) {
    const entry = record(raw);
    const calendarId = text(entry.id);
    if (
      !calendarId ||
      entry.deleted === true ||
      entry.primary === true ||
      !WRITABLE_CALENDAR_ROLES.has(text(entry.accessRole)) ||
      seen.has(calendarId)
    ) {
      continue;
    }
    seen.add(calendarId);
    calendarIds.push(calendarId);
  }
  return calendarIds;
}

export function writableSecondaryCalendarIds(value: unknown): string[] {
  return allWritableSecondaryCalendarIds(value).slice(
    0,
    MAX_SECONDARY_CALENDARS_PER_CONNECTION,
  );
}

export function primaryCalendarAccountEmail(value: unknown): string | null {
  for (const raw of array(record(value).items)) {
    const entry = record(raw);
    if (entry.primary !== true || entry.deleted === true) continue;
    const email = normalizedEmail(entry.id);
    if (email) return email;
  }
  return null;
}

function calendarError(data: unknown, fallback: string): string {
  const root = record(data);
  const nested = record(root.error);
  return (
    text(nested.message) ||
    text(root.message) ||
    text(root.error) ||
    fallback
  );
}

async function wait(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function calendarApiCall(args: {
  connection: CalendarConnection;
  method: "GET" | "PATCH";
  endpoint: string;
  body?: unknown;
}): Promise<RecordLike> {
  const url = new URL(args.endpoint, DATAGRAN_ORIGIN);
  if (
    url.origin !== DATAGRAN_ORIGIN ||
    !url.pathname.startsWith("/api/proxy/google-calendar/")
  ) {
    throw new Error("Blocked Google Calendar endpoint.");
  }
  url.searchParams.set("connection_id", args.connection.connectionId);

  let lastError = "Google Calendar request failed.";
  for (
    let attempt = 0;
    attempt <= CALENDAR_RETRY_DELAYS_MS.length;
    attempt += 1
  ) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CALENDAR_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        method: args.method,
        headers: {
          "x-api-key": args.connection.datagranApiKey,
          "Content-Type": "application/json",
        },
        ...(args.body === undefined
          ? {}
          : { body: JSON.stringify(args.body) }),
        signal: controller.signal,
      });
      const responseText = await response.text();
      let data: unknown = {};
      try {
        data = responseText ? JSON.parse(responseText) : {};
      } catch {
        data = {};
      }
      if (response.ok) return record(data);
      lastError = calendarError(data, `Google Calendar returned ${response.status}.`);
      const retryable =
        response.status === 429 ||
        response.status >= 500 ||
        (response.status === 403 &&
          /(?:rate|quota|limit)/i.test(lastError));
      if (
        attempt >= CALENDAR_RETRY_DELAYS_MS.length ||
        !retryable
      ) {
        throw new Error(lastError);
      }
      const retryAfterSeconds = Number(response.headers.get("retry-after") || 0);
      const retryAfterMs = Number.isFinite(retryAfterSeconds)
        ? Math.min(10_000, Math.max(0, retryAfterSeconds * 1_000))
        : 0;
      await wait(
        Math.max(CALENDAR_RETRY_DELAYS_MS[attempt], retryAfterMs),
      );
    } catch (error) {
      if (
        error instanceof Error &&
        error.name !== "AbortError" &&
        !/fetch failed/i.test(error.message)
      ) {
        throw error;
      }
      lastError =
        error instanceof Error && error.name === "AbortError"
          ? "Google Calendar timed out."
          : "Could not reach Google Calendar.";
      if (attempt >= CALENDAR_RETRY_DELAYS_MS.length) {
        throw new Error(lastError);
      }
      await wait(CALENDAR_RETRY_DELAYS_MS[attempt]);
    } finally {
      clearTimeout(timeout);
    }
  }
  throw new Error(lastError);
}

async function loadCalendarConnections(args: {
  supabase: SupabaseClient;
  userId: string;
}): Promise<CalendarConnection[]> {
  const result = await args.supabase
    .from("datagran_agent_configs")
    .select("connection_id,datagran_api_key_enc")
    .eq("user_id", args.userId)
    .eq("provider", "google_calendar")
    .not("connection_id", "is", null)
    .order("created_at", { ascending: true });
  if (result.error) throw new Error(result.error.message);
  const fallbackKey = process.env.DATAGRAN_API_KEY?.trim() || "";
  const connections: CalendarConnection[] = [];
  const seenConnectionIds = new Set<string>();
  for (const row of result.data || []) {
    const connectionId = text(row.connection_id);
    if (!connectionId || seenConnectionIds.has(connectionId)) continue;
    let datagranApiKey = fallbackKey;
    const encrypted = text(row.datagran_api_key_enc);
    if (encrypted) {
      try {
        datagranApiKey = decryptLlmApiKey(encrypted);
      } catch {
        // A valid deployment fallback can still serve an older connection.
      }
    }
    if (!datagranApiKey) continue;
    seenConnectionIds.add(connectionId);
    connections.push({ connectionId, datagranApiKey });
  }
  return connections;
}

function eventDate(value: unknown): string | null {
  const date = record(value);
  return text(date.dateTime) || text(date.date) || null;
}

function eventResponseStatus(value: unknown): EmailCalendarResponseStatus {
  const normalized = text(value);
  return normalized === "accepted" ||
    normalized === "tentative" ||
    normalized === "declined"
    ? normalized
    : "needsAction";
}

function eventSummary(args: {
  event: RecordLike;
  responseStatus: EmailCalendarResponseStatus;
}): EmailCalendarInvite {
  const start = record(args.event.start);
  return {
    title: text(args.event.summary) || "Calendar invitation",
    responseStatus: args.responseStatus,
    respondedAt:
      args.responseStatus === "needsAction" ? null : new Date().toISOString(),
    eventId: text(args.event.id) || null,
    iCalUid: text(args.event.iCalUID) || null,
    start: eventDate(args.event.start),
    end: eventDate(args.event.end),
    timeZone: text(start.timeZone) || null,
    location: text(args.event.location) || null,
    htmlLink: text(args.event.htmlLink) || null,
  };
}

async function findCalendarEvent(args: {
  connections: CalendarConnection[];
  iCalUid: string;
  expectedAttendeeEmail: string;
  includeSecondaryCalendars: boolean;
}): Promise<CalendarEventLookup> {
  let successfulLookup = false;
  let lastError: unknown = null;
  let resolvedIdentityCount = 0;
  let eventLookupCount = 0;
  let failedEventLookupCount = 0;
  let secondaryCalendarCount = 0;
  let searchCompletedSuccessfully = true;
  const connectedAccountEmails = new Set<string>();
  const searchCalendar = async (
    connection: CalendarConnection,
    calendarId: string,
  ): Promise<CalendarEventMatch | null> => {
    eventLookupCount += 1;
    try {
      const search = new URLSearchParams({
        iCalUID: args.iCalUid,
        maxResults: "10",
        maxAttendees: "100",
        showDeleted: "false",
        showHiddenInvitations: "true",
      });
      const result = await calendarApiCall({
        connection,
        method: "GET",
        endpoint:
          `/api/proxy/google-calendar/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?` +
          search.toString(),
      });
      successfulLookup = true;
      for (const raw of array(result.items)) {
        const event = record(raw);
        if (text(event.status) === "cancelled") continue;
        const selfAttendee = authenticatedCalendarAttendee({
          attendees: event.attendees,
          expectedEmail: args.expectedAttendeeEmail,
        });
        if (selfAttendee) {
          return { connection, calendarId, event, selfAttendee };
        }
      }
    } catch (error) {
      lastError = error;
      failedEventLookupCount += 1;
      searchCompletedSuccessfully = false;
      // Another calendar or connected account may own this invitation.
    }
    return null;
  };
  const matchesExpectedMailbox = (match: CalendarEventMatch): boolean =>
    text(match.selfAttendee.email).toLowerCase() ===
    args.expectedAttendeeEmail;

  // Most invitations belong to a primary calendar. Check every connected
  // account there first so the common path remains one request per account.
  let aliasMatch: CalendarEventMatch | null = null;
  for (const connection of args.connections) {
    const match = await searchCalendar(connection, "primary");
    if (!match) continue;
    if (matchesExpectedMailbox(match)) {
      return {
        match,
        accountMismatchConfirmed: false,
        connectedAccountEmails: [],
        resolvedIdentityCount,
        eventLookupCount,
        failedEventLookupCount,
        secondaryCalendarCount,
        searchCompletedSuccessfully,
      };
    }
    aliasMatch ||= match;
  }
  if (aliasMatch) {
    return {
      match: aliasMatch,
      accountMismatchConfirmed: false,
      connectedAccountEmails: [],
      resolvedIdentityCount,
      eventLookupCount,
      failedEventLookupCount,
      secondaryCalendarCount,
      searchCompletedSuccessfully,
    };
  }

  if (!args.includeSecondaryCalendars) {
    if (!successfulLookup && lastError) throw lastError;
    return {
      match: null,
      accountMismatchConfirmed: false,
      connectedAccountEmails: [],
      resolvedIdentityCount,
      eventLookupCount,
      failedEventLookupCount,
      secondaryCalendarCount,
      searchCompletedSuccessfully,
    };
  }

  // Only pay for calendar-list and secondary-calendar calls after all primary
  // lookups miss. This keeps fallback coverage from increasing normal quota.
  const secondaryCalendarsByConnection: Array<{
    connection: CalendarConnection;
    calendarIds: string[];
  }> = [];
  let secondaryEnumerationComplete = true;
  for (const connection of args.connections) {
    let calendarIds: string[] = [];
    try {
      const calendars = await calendarApiCall({
        connection,
        method: "GET",
        endpoint:
          "/api/proxy/google-calendar/calendar/v3/users/me/calendarList?" +
          new URLSearchParams({
            maxResults: "250",
            showDeleted: "false",
            showHidden: "true",
          }).toString(),
      });
      const accountEmail = primaryCalendarAccountEmail(calendars);
      if (accountEmail) {
        resolvedIdentityCount += 1;
        connectedAccountEmails.add(accountEmail);
      }
      const allCalendarIds = allWritableSecondaryCalendarIds(calendars);
      calendarIds = allCalendarIds.slice(
        0,
        MAX_SECONDARY_CALENDARS_PER_CONNECTION,
      );
      if (
        allCalendarIds.length > calendarIds.length ||
        text(calendars.nextPageToken)
      ) {
        secondaryEnumerationComplete = false;
      }
      secondaryCalendarCount += calendarIds.length;
    } catch (error) {
      lastError = error;
      searchCompletedSuccessfully = false;
      secondaryEnumerationComplete = false;
      // The connection may not have calendar-list scope. Primary was already
      // checked, and another connected account may still find the event.
    }
    secondaryCalendarsByConnection.push({ connection, calendarIds });
  }

  const accountMismatchConfirmed =
    Boolean(args.expectedAttendeeEmail) &&
    searchCompletedSuccessfully &&
    resolvedIdentityCount === args.connections.length &&
    !connectedAccountEmails.has(args.expectedAttendeeEmail);
  if (accountMismatchConfirmed) {
    return {
      match: null,
      accountMismatchConfirmed: true,
      connectedAccountEmails: Array.from(connectedAccountEmails),
      resolvedIdentityCount,
      eventLookupCount,
      failedEventLookupCount,
      secondaryCalendarCount,
      searchCompletedSuccessfully,
    };
  }

  // If the Gmail identity might belong to one of these Calendar connections,
  // search its writable secondary calendars before declaring the invitation
  // pending. A definitive cross-account mismatch above needs no such calls.
  searchCompletedSuccessfully &&= secondaryEnumerationComplete;
  for (const { connection, calendarIds } of secondaryCalendarsByConnection) {
    for (const calendarId of calendarIds) {
      const match = await searchCalendar(connection, calendarId);
      if (!match) continue;
      if (matchesExpectedMailbox(match)) {
        return {
          match,
          accountMismatchConfirmed: false,
          connectedAccountEmails: Array.from(connectedAccountEmails),
          resolvedIdentityCount,
          eventLookupCount,
          failedEventLookupCount,
          secondaryCalendarCount,
          searchCompletedSuccessfully,
        };
      }
      aliasMatch ||= match;
    }
  }
  if (aliasMatch) {
    return {
      match: aliasMatch,
      accountMismatchConfirmed: false,
      connectedAccountEmails: Array.from(connectedAccountEmails),
      resolvedIdentityCount,
      eventLookupCount,
      failedEventLookupCount,
      secondaryCalendarCount,
      searchCompletedSuccessfully,
    };
  }
  if (!successfulLookup && lastError) throw lastError;
  return {
    match: null,
    accountMismatchConfirmed: false,
    connectedAccountEmails: Array.from(connectedAccountEmails),
    resolvedIdentityCount,
    eventLookupCount,
    failedEventLookupCount,
    secondaryCalendarCount,
    searchCompletedSuccessfully,
  };
}

export async function respondToCalendarInvitation(args: {
  supabase: SupabaseClient;
  userId: string;
  iCalUid: string;
  attendeeEmail: string;
  responseStatus: Exclude<EmailCalendarResponseStatus, "needsAction">;
  onDiagnostic?: (diagnostic: CalendarRsvpDiagnostic) => void;
}): Promise<EmailCalendarInvite> {
  const expectedAttendeeEmail = args.attendeeEmail.trim().toLowerCase();
  const connections = await loadCalendarConnections(args);
  if (connections.length === 0) {
    emitDiagnostic(args.onDiagnostic, {
      outcome: "account_not_connected",
      invitationUidHash: diagnosticHash(args.iCalUid),
      attendeeEmailHash: diagnosticHash(expectedAttendeeEmail),
      calendarConnectionCount: 0,
      resolvedIdentityCount: 0,
      matchingIdentityCount: 0,
      eventLookupCount: 0,
      failedEventLookupCount: 0,
      secondaryCalendarCount: 0,
      searchCompletedSuccessfully: true,
    });
    throw new CalendarInvitationAccountNotConnectedError(
      expectedAttendeeEmail,
    );
  }
  const initialLookup = await findCalendarEvent({
    connections,
    iCalUid: args.iCalUid,
    expectedAttendeeEmail,
    includeSecondaryCalendars: true,
  });
  let match = initialLookup.match;
  const matchingIdentityCount = initialLookup.connectedAccountEmails.filter(
    (email) => email === expectedAttendeeEmail,
  ).length;
  if (
    !match &&
    expectedAttendeeEmail &&
    initialLookup.accountMismatchConfirmed
  ) {
    emitDiagnostic(args.onDiagnostic, {
      outcome: "account_not_connected",
      invitationUidHash: diagnosticHash(args.iCalUid),
      attendeeEmailHash: diagnosticHash(expectedAttendeeEmail),
      calendarConnectionCount: connections.length,
      resolvedIdentityCount: initialLookup.resolvedIdentityCount,
      matchingIdentityCount,
      eventLookupCount: initialLookup.eventLookupCount,
      failedEventLookupCount: initialLookup.failedEventLookupCount,
      secondaryCalendarCount: initialLookup.secondaryCalendarCount,
      searchCompletedSuccessfully:
        initialLookup.searchCompletedSuccessfully,
    });
    throw new CalendarInvitationAccountNotConnectedError(
      expectedAttendeeEmail,
    );
  }
  let eventLookupCount = initialLookup.eventLookupCount;
  let failedEventLookupCount = initialLookup.failedEventLookupCount;
  let searchCompletedSuccessfully =
    initialLookup.searchCompletedSuccessfully;
  for (const delayMs of CALENDAR_VISIBILITY_RETRY_DELAYS_MS) {
    if (match) break;
    await wait(delayMs);
    const retryLookup = await findCalendarEvent({
      connections,
      iCalUid: args.iCalUid,
      expectedAttendeeEmail,
      includeSecondaryCalendars: false,
    });
    eventLookupCount += retryLookup.eventLookupCount;
    failedEventLookupCount += retryLookup.failedEventLookupCount;
    searchCompletedSuccessfully &&=
      retryLookup.searchCompletedSuccessfully;
    match = retryLookup.match;
  }
  if (!match) {
    emitDiagnostic(args.onDiagnostic, {
      outcome: "pending",
      invitationUidHash: diagnosticHash(args.iCalUid),
      attendeeEmailHash: diagnosticHash(expectedAttendeeEmail),
      calendarConnectionCount: connections.length,
      resolvedIdentityCount: initialLookup.resolvedIdentityCount,
      matchingIdentityCount,
      eventLookupCount,
      failedEventLookupCount,
      secondaryCalendarCount: initialLookup.secondaryCalendarCount,
      searchCompletedSuccessfully,
    });
    throw new CalendarInvitationPendingError();
  }
  const eventId = text(match.event.id);
  const attendeeEmail = text(match.selfAttendee.email);
  if (!eventId || !attendeeEmail) {
    throw new Error("Google Calendar did not identify this invitation.");
  }

  const updated = await calendarApiCall({
    connection: match.connection,
    method: "PATCH",
    endpoint:
      `/api/proxy/google-calendar/calendar/v3/calendars/${encodeURIComponent(match.calendarId)}/events/` +
      encodeURIComponent(eventId),
    body: {
      attendeesOmitted: true,
      attendees: [
        {
          email: attendeeEmail,
          responseStatus: args.responseStatus,
        },
      ],
    },
  });
  let confirmedEvent = updated;
  let selfAttendee = authenticatedCalendarAttendee({
    attendees: updated.attendees,
    expectedEmail: attendeeEmail,
  });
  if (!selfAttendee) {
    // Some Calendar proxies return a partial PATCH response. Never report a
    // successful RSVP from the requested value alone; read the exact event
    // back and require Google's authenticated attendee state to confirm it.
    confirmedEvent = await calendarApiCall({
      connection: match.connection,
      method: "GET",
      endpoint:
        `/api/proxy/google-calendar/calendar/v3/calendars/${encodeURIComponent(match.calendarId)}/events/` +
        `${encodeURIComponent(eventId)}?maxAttendees=100`,
    });
    selfAttendee = authenticatedCalendarAttendee({
      attendees: confirmedEvent.attendees,
      expectedEmail: attendeeEmail,
    });
  }
  if (!selfAttendee) {
    throw new Error("Google Calendar did not confirm the RSVP response.");
  }
  const confirmedStatus = eventResponseStatus(selfAttendee.responseStatus);
  if (confirmedStatus !== args.responseStatus) {
    throw new Error("Google Calendar did not confirm the RSVP response.");
  }
  return eventSummary({
    event: { ...match.event, ...updated, ...confirmedEvent },
    responseStatus: confirmedStatus,
  });
}
