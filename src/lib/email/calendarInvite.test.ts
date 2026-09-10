import assert from "node:assert/strict";
import test from "node:test";
import {
  actionableEmailCalendarInvite,
  calendarMessageMethod,
  calendarPartsContainInvitation,
  calendarInvitationTitle,
  emailCalendarInviteSummary,
  isCalendarInvitationEmail,
  isCalendarInvitationSubject,
  parseIcsCalendarInvitation,
} from "./calendarInvite";

test("calendar methods are read from MIME parameters and iTIP payloads", () => {
  assert.equal(
    calendarMessageMethod({
      contentType: 'text/calendar; charset="UTF-8"; method="REPLY"',
    }),
    "REPLY",
  );
  assert.equal(
    calendarMessageMethod({
      ics: ["BEGIN:VCALENDAR", "METHOD:REQUEST", "END:VCALENDAR"].join(
        "\r\n",
      ),
    }),
    "REQUEST",
  );
  assert.equal(calendarPartsContainInvitation(["REQUEST", ""]), true);
  assert.equal(calendarPartsContainInvitation(["REPLY", ""]), false);
  assert.equal(calendarPartsContainInvitation([""]), true);
  assert.equal(calendarPartsContainInvitation([]), false);
});

test("calendar invitations are detected before generic email classification", () => {
  assert.equal(
    isCalendarInvitationSubject(
      "Invitation: Avances MP @ Fri Jul 31, 2026 3pm - 4pm (EDT)",
    ),
    true,
  );
  assert.equal(
    isCalendarInvitationEmail({
      subject: "A localized calendar message",
      body: [
        "BEGIN:VCALENDAR",
        "METHOD:REQUEST",
        "BEGIN:VEVENT",
        "END:VEVENT",
        "END:VCALENDAR",
      ].join("\r\n"),
    }),
    true,
  );
  assert.equal(
    calendarInvitationTitle(
      "Invitation: Avances MP @ Fri Jul 31, 2026 3pm - 4pm (EDT)",
    ),
    "Avances MP",
  );
});

test("ICS parsing preserves the event identity and attendee response state", () => {
  const invitation = parseIcsCalendarInvitation(
    [
      "BEGIN:VCALENDAR",
      "METHOD:REQUEST",
      "BEGIN:VEVENT",
      "UID:event-123@google.com",
      "SUMMARY:Quarterly planning",
      "DTSTART;TZID=America/New_York:20260731T150000",
      "DTEND;TZID=America/New_York:20260731T160000",
      "LOCATION:Google Meet",
      'ORGANIZER;CN="Andres Becerra":mailto:andres@example.com',
      'ATTENDEE;CN="Carlos Mendez";PARTSTAT=NEEDS-ACTION:mailto:carlos@',
      " example.com",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n"),
  );

  assert.ok(invitation);
  assert.equal(invitation.uid, "event-123@google.com");
  assert.equal(invitation.title, "Quarterly planning");
  assert.equal(invitation.timeZone, "America/New_York");
  assert.equal(invitation.organizerEmail, "andres@example.com");
  assert.deepEqual(invitation.attendees, [
    {
      email: "carlos@example.com",
      name: "Carlos Mendez",
      responseStatus: "needsAction",
    },
  ]);
});

test("stored RSVP metadata controls whether an invitation still needs action", () => {
  const pending = emailCalendarInviteSummary({
    subject: "Invitation: Quarterly planning @ Friday",
    metadata: {
      calendar_invite_detected: true,
      calendar_invite_verified: true,
    },
  });
  const accepted = emailCalendarInviteSummary({
    subject: "Invitation: Quarterly planning @ Friday",
    metadata: {
      calendar_rsvp_status: "accepted",
      calendar_rsvp_responded_at: "2026-07-29T16:00:00.000Z",
      calendar_invite: {
        eventId: "event-123",
        iCalUid: "event-123@google.com",
      },
    },
  });

  assert.equal(pending?.responseStatus, "needsAction");
  assert.equal(accepted?.responseStatus, "accepted");
  assert.equal(accepted?.eventId, "event-123");
  assert.equal(accepted?.respondedAt, "2026-07-29T16:00:00.000Z");
});

test("a subject-only forwarded calendar update is not an actionable invitation", () => {
  assert.equal(
    isCalendarInvitationEmail({
      subject:
        "Updated invitation: KiwiTech Payment || ACID LABS @ Thursday",
      body: "Reply for satyam@kiwitech.com",
    }),
    false,
  );
  const forwarded = emailCalendarInviteSummary({
    subject:
      "Updated invitation: KiwiTech Payment || ACID LABS @ Thursday",
    metadata: { calendar_invite_detected: true },
    hasCalendarInvitation: false,
  });
  const genuine = emailCalendarInviteSummary({
    subject: "Invitation: Quarterly planning @ Friday",
    hasCalendarInvitation: true,
  });

  assert.equal(forwarded, null);
  assert.equal(genuine?.responseStatus, "needsAction");
  assert.equal(genuine?.title, "Quarterly planning");
});

test("calendar replies and stale verified metadata do not expose RSVP controls", () => {
  const replyBody = [
    "BEGIN:VCALENDAR",
    "METHOD:REPLY",
    "BEGIN:VEVENT",
    "UID:event-123@google.com",
    "SUMMARY:Quarterly planning",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");

  assert.equal(
    isCalendarInvitationEmail({
      subject: "Accepted: Quarterly planning @ Friday",
      body: replyBody,
    }),
    false,
  );
  assert.equal(parseIcsCalendarInvitation(replyBody), null);
  assert.equal(
    emailCalendarInviteSummary({
      subject: "Accepted: Quarterly planning @ Friday",
      hasCalendarInvitation: false,
      metadata: {
        calendar_invite_detected: true,
        calendar_invite_verified: true,
      },
    }),
    null,
  );
});

test("stale cached calendar replies cannot restore RSVP controls", () => {
  const staleInvite = {
    title: "Hibe<>BestRoof",
    responseStatus: "needsAction" as const,
    respondedAt: null,
    eventId: null,
    iCalUid: null,
    start: null,
    end: null,
    timeZone: null,
    location: null,
    htmlLink: null,
  };

  assert.equal(
    actionableEmailCalendarInvite({
      subject:
        "Accepted: Hibe<>BestRoof @ Fri Aug 28, 2026 10am - 10:30am (EDT)",
      body: "Kaylie McGonagle has accepted this invitation.",
      invite: staleInvite,
    }),
    null,
  );
  assert.equal(
    actionableEmailCalendarInvite({
      subject: "Project sync",
      body: "Kaylie McGonagle has declined this invitation.",
      invite: staleInvite,
    }),
    null,
  );
  assert.equal(
    actionableEmailCalendarInvite({
      subject: "Invitation: Hibe<>BestRoof @ Fri Aug 28, 2026",
      body: "You have been invited to this meeting.",
      invite: staleInvite,
    }),
    staleInvite,
  );
});
