import { NextResponse } from "next/server";
import { jsonError, requireEmailUser } from "@/lib/email/auth";
import {
  loadGmailMailboxes,
  publicMailbox,
} from "@/lib/email/gmail";
import {
  buildIndexedEmailSearchFilter,
  normalizeEmailSearchQuery,
  rankEmailSearchSummaries,
} from "@/lib/email/search";
import {
  latestEmailActionRowsByConversation,
  summaryFromAction,
} from "@/lib/email/service";
import type { EmailSearchResponse } from "@/lib/email/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 10;

type SearchBody = {
  query?: unknown;
  connectionId?: unknown;
  limit?: unknown;
};

type RecordLike = Record<string, unknown>;

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function record(value: unknown): RecordLike {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordLike)
    : {};
}

export async function POST(request: Request) {
  const auth = await requireEmailUser();
  if (!auth.ok) return auth.response;

  const body = (await request.json().catch(() => null)) as SearchBody | null;
  const query = normalizeEmailSearchQuery(text(body?.query));
  const connectionId = text(body?.connectionId);
  const requestedLimit = Number(body?.limit ?? 30);
  const limit = Number.isFinite(requestedLimit)
    ? Math.min(50, Math.max(1, Math.floor(requestedLimit)))
    : 30;
  const filter = buildIndexedEmailSearchFilter(query);
  if (query.length < 2 || !filter) {
    return NextResponse.json(
      { ok: false, error: "Enter at least two characters to search." },
      { status: 400 },
    );
  }

  try {
    const allMailboxes = await loadGmailMailboxes({
      supabase: auth.supabase,
      userId: auth.userId,
      verifyProfile: false,
    });
    const selectedMailboxes = connectionId
      ? allMailboxes.filter(
          (mailbox) => mailbox.connectionId === connectionId,
        )
      : allMailboxes.filter((mailbox) => mailbox.includedInUnified);
    const connectionIds = selectedMailboxes.map(
      (mailbox) => mailbox.connectionId,
    );
    if (connectionIds.length === 0) {
      const empty: EmailSearchResponse = {
        query,
        results: [],
        searchedMailboxCount: 0,
        totalMailboxCount: selectedMailboxes.length,
        warnings: [],
        partial: false,
      };
      return NextResponse.json({ ok: true, ...empty });
    }

    const indexed = await auth.supabase
      .from("inbox_actions")
      .select(
        "id,connection_id,gmail_message_id,gmail_thread_id,sender_email,sender_name," +
          "subject,snippet,reason,recommended_action,status,confidence," +
          "p_important,p_spam,p_actionable,metadata,received_at,created_at,updated_at",
      )
      .eq("user_id", auth.userId)
      .eq("provider", "gmail")
      .in("connection_id", connectionIds)
      .or(filter)
      .order("received_at", { ascending: false, nullsFirst: false })
      .order("created_at", { ascending: false })
      .limit(Math.min(200, Math.max(40, limit * 4)))
      .abortSignal(request.signal);
    if (indexed.error) throw new Error(indexed.error.message);

    const mailboxByConnection = new Map(
      selectedMailboxes.map((mailbox) => [
        mailbox.connectionId,
        publicMailbox(mailbox),
      ]),
    );
    const rows = latestEmailActionRowsByConversation(
      (indexed.data || [])
        .map((row) => record(row))
        .filter(
          (row) => record(row.metadata).email_tracking_record !== true,
        ),
    );
    const summaries = rows.flatMap((row) => {
      const mailbox = mailboxByConnection.get(text(row.connection_id));
      return mailbox ? [summaryFromAction(row, mailbox)] : [];
    });
    const response: EmailSearchResponse = {
      query,
      results: rankEmailSearchSummaries(query, summaries).slice(0, limit),
      searchedMailboxCount: selectedMailboxes.length,
      totalMailboxCount: selectedMailboxes.length,
      warnings: [],
      partial: false,
    };
    return NextResponse.json(
      { ok: true, ...response },
      {
        headers: {
          "Cache-Control": "private, max-age=30, stale-while-revalidate=120",
        },
      },
    );
  } catch (error) {
    return jsonError(error, "Could not search the local email index.");
  }
}
