import type {
  EmailCalendarInvite,
  EmailCalendarResponseStatus,
} from "@/lib/email/types";

type RecordLike = Record<string, unknown>;

export type ParsedCalendarAttendee = {
  email: string;
  name: string;
  responseStatus: EmailCalendarResponseStatus;
};

export type ParsedCalendarInvitation = {
  method: string;
  uid: string;
  title: string;
  start: string;
  end: string;
  timeZone: string;
  location: string;
  organizerEmail: string;
  organizerName: string;
  attendees: ParsedCalendarAttendee[];
};

const INVITATION_SUBJECT = /^(?:updated\s+)?invitation\s*:/i;
const RESPONSE_NOTIFICATION_SUBJECT =
  /^(?:accepted|declined|tentative|tentatively accepted|cancell?ed|proposed new time|new time proposed)\s*:/i;
const RESPONSE_NOTIFICATION_BODY =
  /\bhas (?:accepted|declined|tentatively accepted|proposed a new time for|cancell?ed) (?:this|the) invitation\b/i;

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function record(value: unknown): RecordLike {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordLike)
    : {};
}

export function isCalendarInvitationSubject(subject: unknown): boolean {
  return INVITATION_SUBJECT.test(text(subject));
}

export function isCalendarInvitationEmail(args: {
  subject?: unknown;
  body?: unknown;
  hasCalendarInvitation?: unknown;
}): boolean {
  // An invitation-looking subject is only a routing hint. Forwarded Google
  // Calendar notifications retain that subject but contain no iTIP payload,
  // so treating the subject as proof would expose RSVP controls for somebody
  // else's invitation.
  if (args.hasCalendarInvitation === true) return true;
  const body = text(args.body);
  return (
    /BEGIN:VCALENDAR/i.test(body) &&
    /BEGIN:VEVENT/i.test(body) &&
    calendarMessageMethod({ ics: body }) === "REQUEST"
  );
}

export function calendarInvitationTitle(subject: unknown): string {
  const normalized = text(subject).replace(INVITATION_SUBJECT, "").trim();
  const separator = normalized.indexOf(" @ ");
  return (
    (separator >= 0 ? normalized.slice(0, separator) : normalized) ||
    "Calendar invitation"
  );
}

/**
 * Cached feed snapshots can outlive a server-side calendar parser correction.
 * Do not let a stale `calendarInvite` object bring RSVP controls back for an
 * iTIP response notification while the refreshed feed is still loading.
 */
export function actionableEmailCalendarInvite(args: {
  subject?: unknown;
  body?: unknown;
  invite?: EmailCalendarInvite | null;
}): EmailCalendarInvite | null {
  if (!args.invite) return null;
  const subject = text(args.subject);
  const body = text(args.body);
  if (
    RESPONSE_NOTIFICATION_SUBJECT.test(subject) ||
    RESPONSE_NOTIFICATION_BODY.test(body)
  ) {
    return null;
  }
  return args.invite;
}

export function emailCalendarInviteSummary(args: {
  subject?: unknown;
  metadata?: unknown;
  hasCalendarInvitation?: unknown;
}): EmailCalendarInvite | null {
  const metadata = record(args.metadata);
  const stored = record(metadata.calendar_invite);
  // A live Gmail MIME inspection is more authoritative than old triage
  // metadata. This lets corrected parsing immediately remove RSVP controls
  // from calendar replies that were previously misclassified as invitations.
  if (args.hasCalendarInvitation === false) return null;
  const verified =
    args.hasCalendarInvitation === true ||
    metadata.calendar_invite_verified === true ||
    Object.keys(stored).length > 0;
  if (
    !verified
  ) {
    return null;
  }
  const responseStatus = calendarResponseStatus(
    metadata.calendar_rsvp_status || stored.responseStatus,
  );
  return {
    title:
      text(stored.title) ||
      calendarInvitationTitle(args.subject),
    responseStatus,
    respondedAt: text(metadata.calendar_rsvp_responded_at) || null,
    eventId: text(stored.eventId) || null,
    iCalUid: text(stored.iCalUid) || null,
    start: text(stored.start) || null,
    end: text(stored.end) || null,
    timeZone: text(stored.timeZone) || null,
    location: text(stored.location) || null,
    htmlLink: text(stored.htmlLink) || null,
  };
}

function normalizeCalendarMethod(value: unknown): string {
  return text(value).replace(/^"|"$/g, "").toUpperCase();
}

export function calendarMessageMethod(args: {
  contentType?: unknown;
  ics?: unknown;
}): string {
  const contentType = text(args.contentType);
  const contentTypeMatch = contentType.match(
    /(?:^|;)\s*method\s*=\s*(?:"([^"]+)"|([^;\s]+))/i,
  );
  const fromContentType = normalizeCalendarMethod(
    contentTypeMatch?.[1] || contentTypeMatch?.[2],
  );
  if (fromContentType) return fromContentType;

  const source = text(args.ics).replace(/\r?\n[ \t]/g, "");
  const icsMatch = source.match(/^METHOD(?:;[^:]*)?:\s*([^\r\n]+)/im);
  return normalizeCalendarMethod(icsMatch?.[1]);
}

export function calendarPartsContainInvitation(
  methods: readonly unknown[],
): boolean {
  const normalized = methods.map(normalizeCalendarMethod);
  if (normalized.includes("REQUEST")) return true;
  // Some providers omit METHOD entirely. Preserve that legacy compatibility
  // only when another calendar part does not explicitly identify the message
  // as a REPLY, CANCEL, or other non-request iTIP method.
  return normalized.includes("") && !normalized.some(Boolean);
}

export function calendarResponseStatus(
  value: unknown,
): EmailCalendarResponseStatus {
  const normalized = text(value);
  return normalized === "accepted" ||
    normalized === "tentative" ||
    normalized === "declined"
    ? normalized
    : "needsAction";
}

function decodeIcsText(value: string): string {
  return value
    .replace(/\\n/gi, "\n")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\")
    .trim();
}

function propertyParts(line: string): {
  name: string;
  params: Record<string, string>;
  value: string;
} | null {
  const colon = line.indexOf(":");
  if (colon <= 0) return null;
  const definition = line.slice(0, colon);
  const [rawName, ...rawParams] = definition.split(";");
  const params: Record<string, string> = {};
  for (const raw of rawParams) {
    const equals = raw.indexOf("=");
    if (equals <= 0) continue;
    params[raw.slice(0, equals).toUpperCase()] = raw
      .slice(equals + 1)
      .replace(/^"|"$/g, "");
  }
  return {
    name: rawName.toUpperCase(),
    params,
    value: decodeIcsText(line.slice(colon + 1)),
  };
}

function calendarEmail(value: string): string {
  return value.replace(/^mailto:/i, "").trim().toLowerCase();
}

function partStat(value: unknown): EmailCalendarResponseStatus {
  const normalized = text(value).toUpperCase();
  if (normalized === "ACCEPTED") return "accepted";
  if (normalized === "TENTATIVE") return "tentative";
  if (normalized === "DECLINED") return "declined";
  return "needsAction";
}

export function parseIcsCalendarInvitation(
  input: unknown,
): ParsedCalendarInvitation | null {
  const source = text(input).replace(/\r?\n[ \t]/g, "");
  if (!source) return null;
  const eventMatch = source.match(/BEGIN:VEVENT\r?\n([\s\S]*?)\r?\nEND:VEVENT/i);
  if (!eventMatch) return null;
  const method = calendarMessageMethod({ ics: source });
  if (method && method !== "REQUEST") return null;

  let uid = "";
  let title = "";
  let start = "";
  let end = "";
  let timeZone = "";
  let location = "";
  let organizerEmail = "";
  let organizerName = "";
  const attendees: ParsedCalendarAttendee[] = [];

  for (const line of eventMatch[1].split(/\r?\n/)) {
    const property = propertyParts(line);
    if (!property) continue;
    if (property.name === "UID") uid = property.value;
    else if (property.name === "SUMMARY") title = property.value;
    else if (property.name === "DTSTART") {
      start = property.value;
      timeZone = property.params.TZID || timeZone;
    } else if (property.name === "DTEND") {
      end = property.value;
      timeZone = timeZone || property.params.TZID || "";
    } else if (property.name === "LOCATION") {
      location = property.value;
    } else if (property.name === "ORGANIZER") {
      organizerEmail = calendarEmail(property.value);
      organizerName = property.params.CN || "";
    } else if (property.name === "ATTENDEE") {
      const email = calendarEmail(property.value);
      if (!email) continue;
      attendees.push({
        email,
        name: property.params.CN || "",
        responseStatus: partStat(property.params.PARTSTAT),
      });
    }
  }
  if (!uid || !title) return null;
  return {
    method: method || "REQUEST",
    uid,
    title,
    start,
    end,
    timeZone,
    location,
    organizerEmail,
    organizerName,
    attendees,
  };
}
