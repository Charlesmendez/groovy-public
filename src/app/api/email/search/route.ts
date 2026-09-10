import { NextResponse } from "next/server";
import { jsonError, requireEmailUser } from "@/lib/email/auth";
import {
  gmailItemDirection,
  isGmailDraftMessage,
  listGmailThreads,
  loadGmailMailboxes,
  publicMailbox,
} from "@/lib/email/gmail";
import {
  buildGmailSearchQuery,
  normalizeEmailSearchQuery,
  rankEmailSearchConversations,
} from "@/lib/email/search";
import {
  dedupeEmailConversationSummaries,
  summaryFromGmail,
} from "@/lib/email/service";
import type {
  EmailSearchResponse,
  EmailSearchResult,
} from "@/lib/email/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

type SearchBody = {
  query?: unknown;
  connectionId?: unknown;
  limit?: unknown;
};

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
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
  if (query.length < 2) {
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
      : allMailboxes;
    if (connectionId && selectedMailboxes.length === 0) {
      return NextResponse.json(
        { ok: false, error: "Mailbox not found." },
        { status: 404 },
      );
    }

    const connected = selectedMailboxes.filter(
      (mailbox) => mailbox.status === "connected",
    );
    const warnings = selectedMailboxes
      .filter((mailbox) => mailbox.status !== "connected")
      .map((mailbox) =>
        mailbox.status === "reauth_required"
          ? `${mailbox.displayName || mailbox.address}: reconnect to include this mailbox.`
          : `${mailbox.displayName || mailbox.address}: unavailable during this search.`,
      );
    if (connected.length === 0) {
      return NextResponse.json(
        {
          ok: false,
          error:
            selectedMailboxes.length === 0
              ? "Connect a mailbox before searching."
              : "No connected mailbox is currently available to search.",
          warnings,
        },
        { status: 409 },
      );
    }

    const perMailbox = Math.min(
      50,
      Math.max(10, Math.ceil((limit * 1.15) / connected.length)),
    );
    const gmailQuery = buildGmailSearchQuery(query);
    const ownedAddresses = allMailboxes
      .map((mailbox) => mailbox.address)
      .filter(Boolean);
    const searchMailboxes = (searchQuery: string, maxResults: number) =>
      Promise.all(
        connected.map(async (mailbox) => {
          const controller = new AbortController();
          const abortMailboxSearch = () => controller.abort();
          if (request.signal.aborted) {
            controller.abort();
          } else {
            request.signal.addEventListener("abort", abortMailboxSearch, {
              once: true,
            });
          }
          try {
            const result = await listGmailThreads({
              mailbox,
              query: searchQuery,
              maxResults,
              signal: controller.signal,
              latestInThread: true,
              detailConcurrency: 6,
            });
            return { ok: true as const, mailbox, items: result.items };
          } catch (error) {
            return {
              ok: false as const,
              mailbox,
              error:
                error instanceof Error
                  ? error.message
                  : "Mailbox search failed.",
            };
          } finally {
            request.signal.removeEventListener(
              "abort",
              abortMailboxSearch,
            );
          }
        }),
      );
    // Gmail already handles the exact phrase and bounded fallback terms in
    // this query. Running a second preliminary search doubled provider work
    // and could return only four exact hits even when many more existed.
    const rawSearched = await searchMailboxes(gmailQuery, perMailbox);
    const searched = rawSearched.map((result) => {
      if (!result.ok) return result;
      const publicIdentity = publicMailbox(result.mailbox);
      const conversations = result.items
        .filter((item) => !isGmailDraftMessage(item.labelIds))
        .map((item) => {
          const matchedItem = item.matchedItem || item;
          return {
            display: summaryFromGmail(
              item,
              publicIdentity,
              undefined,
              {
                direction: gmailItemDirection(item, ownedAddresses),
              },
            ),
            match: summaryFromGmail(
              matchedItem,
              publicIdentity,
              undefined,
              {
                direction: gmailItemDirection(
                  matchedItem,
                  ownedAddresses,
                ),
              },
            ),
          };
        });
      return { ok: true as const, mailbox: result.mailbox, conversations };
    });

    const successful = searched.filter((result) => result.ok);
    for (const failed of searched.filter((result) => !result.ok)) {
      warnings.push(
        `${failed.mailbox.displayName || failed.mailbox.address}: could not be searched.`,
      );
    }
    if (successful.length === 0) {
      return NextResponse.json(
        {
          ok: false,
          error: "Could not search any connected mailbox. Try again shortly.",
          warnings,
        },
        { status: 502 },
      );
    }

    const conversations = successful.flatMap(
      (result) => result.conversations,
    );
    const ranked = rankEmailSearchConversations(
      query,
      conversations,
      { providerMatched: true },
    );
    const deduped = dedupeEmailConversationSummaries(
      ranked,
    ) as EmailSearchResult[];
    const response: EmailSearchResponse = {
      query,
      results: deduped.slice(0, limit),
      searchedMailboxCount: successful.length,
      totalMailboxCount: selectedMailboxes.length,
      warnings,
      partial: warnings.length > 0,
    };
    return NextResponse.json(
      { ok: true, ...response },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return jsonError(error, "Could not search your mailboxes.");
  }
}
