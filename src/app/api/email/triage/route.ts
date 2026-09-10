import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { jsonError, requireEmailUser } from "@/lib/email/auth";
import {
  fetchGmailMailboxHistoryId,
  fetchGmailMessageListItem,
  gmailItemDirection,
  GmailApiError,
  hydrateGmailMailboxProfile,
  listGmailHistoryMessageRefs,
  listGmailMessageRefs,
  loadGmailMailboxes,
  type EmailMailboxConnection,
} from "@/lib/email/gmail";
import {
  buildEmailMailboxSyncCheckpoint,
  loadEmailMailboxSyncStates,
  persistEmailMailboxSyncStates,
  shouldRunEmailMailboxFullSync,
} from "@/lib/email/mailboxSyncState";
import { resolveEmailModel } from "@/lib/email/modelRouting";
import { withEmailProviderRequest } from "@/lib/email/providerRuntime";
import {
  filterUnorganizedEmails,
  gmailTriageInboxQuery,
  interleaveEmailTriageCandidates,
} from "@/lib/email/triageFreshness";
import { EMAIL_TRIAGE_POLICY_VERSION } from "@/lib/email/triagePolicy";
import {
  runInboxTriageForHeartbeat,
  type TriageEmailItem,
} from "@/lib/inbox/actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const TRIAGE_BATCH_SIZE = 12;
const DISCOVERY_PAGE_SIZE = 100;
const MAX_HISTORY_PAGES_PER_MAILBOX = 5;
const FULL_RECONCILIATION_INTERVAL_MS = 24 * 60 * 60_000;

type DiscoveryCandidate = {
  connectionId: string;
  id: string;
  threadId: string;
  mailbox: EmailMailboxConnection;
};

type MailboxDiscovery = {
  connectionId: string;
  candidates: DiscoveryCandidate[];
  checked: number;
  cursorHistoryId: string;
  historyId: string;
  nextPageToken: string | null;
  fullSync: boolean;
  requiresLiveRefresh: boolean;
};

type TriagePayload = {
  body: Record<string, unknown>;
  status?: number;
};

async function unorganizedCandidates(args: {
  supabase: SupabaseClient;
  userId: string;
  mailbox: EmailMailboxConnection;
  refs: DiscoveryCandidate[];
}): Promise<DiscoveryCandidate[]> {
  const ids = args.refs.map((item) => item.id).filter(Boolean);
  const existingResult =
    ids.length > 0
      ? await args.supabase
          .from("inbox_actions")
          .select(
            "connection_id,gmail_message_id,recommended_action,status,reason,metadata",
          )
          .eq("user_id", args.userId)
          .eq("provider", "gmail")
          .eq("connection_id", args.mailbox.connectionId)
          .in("gmail_message_id", ids)
      : { data: [], error: null };
  if (existingResult.error) throw new Error(existingResult.error.message);
  return filterUnorganizedEmails(args.refs, existingResult.data || [], {
    currentPolicyVersion: EMAIL_TRIAGE_POLICY_VERSION,
  });
}

async function discoverFromHistory(args: {
  supabase: SupabaseClient;
  userId: string;
  mailbox: EmailMailboxConnection;
  historyId: string;
  historyPageToken?: string | null;
}): Promise<MailboxDiscovery> {
  const candidates: DiscoveryCandidate[] = [];
  const seenChanged = new Set<string>();
  const seenAdded = new Set<string>();
  let pageToken: string | null = args.historyPageToken || null;
  let latestHistoryId = args.historyId;
  for (
    let page = 0;
    page < MAX_HISTORY_PAGES_PER_MAILBOX;
    page += 1
  ) {
    const result = await listGmailHistoryMessageRefs({
      mailbox: args.mailbox,
      startHistoryId: args.historyId,
      maxResults: DISCOVERY_PAGE_SIZE,
      pageToken,
    });
    latestHistoryId = result.historyId || latestHistoryId;
    for (const item of result.changed) seenChanged.add(item.id);
    const refs = result.added
      .filter((item) => {
        if (seenAdded.has(item.id)) return false;
        seenAdded.add(item.id);
        return true;
      })
      .map((item) => ({
        connectionId: args.mailbox.connectionId,
        id: item.id,
        threadId: item.threadId,
        mailbox: args.mailbox,
      }));
    candidates.push(
      ...(await unorganizedCandidates({
        supabase: args.supabase,
        userId: args.userId,
        mailbox: args.mailbox,
        refs,
      })),
    );
    pageToken = result.nextPageToken;
    if (candidates.length >= TRIAGE_BATCH_SIZE || !pageToken) break;
  }
  return {
    connectionId: args.mailbox.connectionId,
    candidates,
    checked: seenAdded.size,
    cursorHistoryId: args.historyId,
    historyId: latestHistoryId,
    nextPageToken: pageToken,
    fullSync: false,
    requiresLiveRefresh: Array.from(seenChanged).some(
      (id) => !seenAdded.has(id),
    ),
  };
}

async function discoverFromFullInbox(args: {
  supabase: SupabaseClient;
  userId: string;
  mailbox: EmailMailboxConnection;
  historyId?: string;
  pageToken?: string | null;
}): Promise<MailboxDiscovery> {
  // Capture the cursor before listing. Mail arriving during the full scan is
  // then guaranteed to appear in the next history request instead of falling
  // into the gap between a list response and a later profile read.
  const historyId =
    args.historyId ||
    (await fetchGmailMailboxHistoryId({
      userId: args.userId,
      mailbox: args.mailbox,
    }));
  // A durable page token lets a large first reconciliation advance with one
  // Gmail list call per 15-second cycle. This avoids a burst of deep scans and
  // still guarantees that mail arriving after historyId is caught afterward.
  const result = await listGmailMessageRefs({
    mailbox: args.mailbox,
    query: gmailTriageInboxQuery(7),
    maxResults: DISCOVERY_PAGE_SIZE,
    pageToken: args.pageToken,
  });
  const refs = result.items.map((item) => ({
    connectionId: args.mailbox.connectionId,
    id: item.id,
    threadId: item.threadId,
    mailbox: args.mailbox,
  }));
  const candidates = await unorganizedCandidates({
    supabase: args.supabase,
    userId: args.userId,
    mailbox: args.mailbox,
    refs,
  });
  return {
    connectionId: args.mailbox.connectionId,
    candidates,
    checked: refs.length,
    cursorHistoryId: historyId,
    historyId,
    nextPageToken: result.nextPageToken,
    fullSync: true,
    requiresLiveRefresh: false,
  };
}

async function discoverMailbox(args: {
  supabase: SupabaseClient;
  userId: string;
  mailbox: EmailMailboxConnection;
  historyId?: string;
  historyPageToken?: string | null;
  syncMode?: "history" | "full";
  forceFullSync?: boolean;
}): Promise<MailboxDiscovery> {
  if (args.historyId && args.syncMode === "full") {
    try {
      return await discoverFromFullInbox({
        supabase: args.supabase,
        userId: args.userId,
        mailbox: args.mailbox,
        historyId: args.historyId,
        pageToken: args.historyPageToken,
      });
    } catch (error) {
      const expiredFullPage =
        error instanceof GmailApiError &&
        Boolean(args.historyPageToken) &&
        (error.status === 400 || error.status === 404);
      if (!expiredFullPage) throw error;
      return discoverFromFullInbox(args);
    }
  }
  if (args.forceFullSync) {
    return discoverFromFullInbox({
      supabase: args.supabase,
      userId: args.userId,
      mailbox: args.mailbox,
    });
  }
  if (args.historyId) {
    try {
      return await discoverFromHistory({
        supabase: args.supabase,
        userId: args.userId,
        mailbox: args.mailbox,
        historyId: args.historyId,
        historyPageToken: args.historyPageToken,
      });
    } catch (error) {
      const expiredPageToken =
        error instanceof GmailApiError &&
        Boolean(args.historyPageToken) &&
        error.status === 400;
      if (expiredPageToken) {
        // Restart the incremental walk from its durable start cursor when only
        // the transient page token expired. This is cheaper than a full scan
        // and cannot skip history events.
        try {
          return await discoverFromHistory({
            supabase: args.supabase,
            userId: args.userId,
            mailbox: args.mailbox,
            historyId: args.historyId,
          });
        } catch (restartError) {
          if (
            !(restartError instanceof GmailApiError) ||
            restartError.status !== 404
          ) {
            throw restartError;
          }
        }
      } else if (!(error instanceof GmailApiError) || error.status !== 404) {
        throw error;
      }
      // Gmail expires startHistoryId values. A 404 is the documented signal
      // to run a full reconciliation and capture a new current cursor. Do not
      // pass the expired cursor into the fallback or every cycle will rescan.
      return discoverFromFullInbox({
        supabase: args.supabase,
        userId: args.userId,
        mailbox: args.mailbox,
      });
    }
  }
  return discoverFromFullInbox(args);
}

async function persistFinishedCursors(args: {
  supabase: SupabaseClient;
  userId: string;
  discoveries: MailboxDiscovery[];
  attemptedIds: ReadonlySet<string>;
}): Promise<void> {
  await persistEmailMailboxSyncStates({
    supabase: args.supabase,
    userId: args.userId,
    states: args.discoveries
      .map((discovery) =>
        buildEmailMailboxSyncCheckpoint({
          connectionId: discovery.connectionId,
          cursorHistoryId: discovery.cursorHistoryId,
          historyId: discovery.historyId,
          nextPageToken: discovery.nextPageToken,
          fullSync: discovery.fullSync,
          triagePolicyVersion: EMAIL_TRIAGE_POLICY_VERSION,
          discoveredCandidateIds: discovery.candidates.map(
            (item) => `${item.connectionId}:${item.id}`,
          ),
          attemptedCandidateIds: args.attemptedIds,
        }),
      )
      .filter((state) => state !== null),
  });
}

function emptyTriageResult() {
  return {
    runId: `email-fresh-${Date.now()}`,
    pendingActionIds: [],
    pendingCount: 0,
    autoExecutedCount: 0,
    criticalCount: 0,
    notes: [],
    focusArrivals: [],
    focusNotification: { attempted: 0, delivered: 0 },
  };
}

async function runTriage(args: {
  request: Request;
  auth: Extract<Awaited<ReturnType<typeof requireEmailUser>>, { ok: true }>;
}): Promise<TriagePayload> {
  const allMailboxes = await loadGmailMailboxes({
    supabase: args.auth.supabase,
    userId: args.auth.userId,
    verifyProfile: false,
  });
  const mailboxes = allMailboxes.filter((mailbox) => mailbox.includedInUnified);
  if (mailboxes.length === 0) {
    return {
      status: 409,
      body: {
        ok: false,
        error: "Connect Gmail before running email triage.",
      },
    };
  }
  const states = await loadEmailMailboxSyncStates({
    supabase: args.auth.supabase,
    userId: args.auth.userId,
    connectionIds: mailboxes.map((mailbox) => mailbox.connectionId),
  });
  const discoveredByMailbox = await Promise.all(
    mailboxes.map((mailbox) => {
      const state = states.get(mailbox.connectionId);
      return discoverMailbox({
        supabase: args.auth.supabase,
        userId: args.auth.userId,
        mailbox,
        historyId: state?.historyId,
        historyPageToken: state?.historyPageToken,
        syncMode: state?.syncMode,
        forceFullSync:
          state !== undefined &&
          shouldRunEmailMailboxFullSync({
            syncMode: state.syncMode,
            triagePolicyVersion: state.triagePolicyVersion,
            currentTriagePolicyVersion: EMAIL_TRIAGE_POLICY_VERSION,
            lastFullSyncAt: state.lastFullSyncAt,
            intervalMs: FULL_RECONCILIATION_INTERVAL_MS,
          }),
      });
    }),
  );
  const unorganizedRefs = interleaveEmailTriageCandidates(
    discoveredByMailbox.map((result) => result.candidates),
  );
  const checkedCount = discoveredByMailbox.reduce(
    (count, result) => count + result.checked,
    0,
  );
  const requiresLiveRefresh = discoveredByMailbox.some(
    (result) => result.requiresLiveRefresh,
  );
  const discoveryMode = discoveredByMailbox.every((result) => !result.fullSync)
    ? "history"
    : "full";
  if (unorganizedRefs.length === 0) {
    await persistFinishedCursors({
      supabase: args.auth.supabase,
      userId: args.auth.userId,
      discoveries: discoveredByMailbox,
      attemptedIds: new Set(),
    });
    return {
      body: {
        ok: true,
        result: emptyTriageResult(),
        discovery: {
          checked: checkedCount,
          newMessages: 0,
          alreadyOrganized: checkedCount,
          requiresLiveRefresh,
          mode: discoveryMode,
        },
        model: null,
      },
    };
  }

  const verifiedMailboxes = await Promise.all(
    mailboxes.map((mailbox) =>
      hydrateGmailMailboxProfile({
        userId: args.auth.userId,
        mailbox,
      }),
    ),
  );
  const verifiedMailboxByConnection = new Map(
    verifiedMailboxes.map((mailbox) => [mailbox.connectionId, mailbox]),
  );
  const candidateBatch = unorganizedRefs.slice(0, TRIAGE_BATCH_SIZE);
  const attemptedIds = new Set(
    candidateBatch.map(
      (candidate) => `${candidate.connectionId}:${candidate.id}`,
    ),
  );
  const ownedAddresses = verifiedMailboxes
    .map((mailbox) => mailbox.address)
    .filter(Boolean);
  const hydrated = await Promise.all(
    candidateBatch.map(async (candidate): Promise<TriageEmailItem | null> => {
      const mailbox =
        verifiedMailboxByConnection.get(candidate.connectionId) ||
        candidate.mailbox;
      const item = await fetchGmailMessageListItem({
        mailbox,
        messageId: candidate.id,
        threadId: candidate.threadId,
        throwOnTransientError: true,
      });
      if (
        !item ||
        !item.labelIds.includes("INBOX") ||
        gmailItemDirection(item, ownedAddresses) !== "incoming"
      ) {
        return null;
      }
      return {
        connectionId: candidate.connectionId,
        mailboxLabel: mailbox.displayName || mailbox.address,
        id: item.id,
        threadId: item.threadId,
        from: item.from,
        to: item.to,
        cc: item.cc,
        subject: item.subject,
        date: item.internalDate || item.date,
        snippet: item.snippet,
        listUnsubscribe: item.listUnsubscribe,
        authenticationResults: item.authenticationResults,
        autoSubmitted: item.autoSubmitted,
        precedence: item.precedence,
        listId: item.listId,
        labelIds: item.labelIds,
        messageIdHeader: item.messageIdHeader,
      };
    }),
  );
  const triageBatch = hydrated.filter(
    (item): item is TriageEmailItem => item !== null,
  );
  if (triageBatch.length === 0) {
    await persistFinishedCursors({
      supabase: args.auth.supabase,
      userId: args.auth.userId,
      discoveries: discoveredByMailbox,
      attemptedIds,
    });
    return {
      body: {
        ok: true,
        result: emptyTriageResult(),
        discovery: {
          checked: checkedCount,
          newMessages: 0,
          alreadyOrganized: checkedCount - unorganizedRefs.length,
          remaining: Math.max(0, unorganizedRefs.length - candidateBatch.length),
          requiresLiveRefresh,
          mode: discoveryMode,
        },
        model: null,
      },
    };
  }

  const route = await resolveEmailModel({
    supabase: args.auth.supabase,
    userId: args.auth.userId,
    tier: "quality",
    cookieHeader: args.request.headers.get("cookie") || "",
  });
  const result = await runInboxTriageForHeartbeat({
    supabase: args.auth.supabase,
    userId: args.auth.userId,
    userEmail: args.auth.email,
    policyModel: {
      provider: route.provider,
      modelName: route.modelName,
      apiKey: route.apiKey,
      reasoningEffort: route.reasoningEffort,
    },
    mailboxes: verifiedMailboxes.map((mailbox) => ({
      connectionId: mailbox.connectionId,
      mailboxLabel: mailbox.displayName || mailbox.address,
      address: mailbox.address,
      ownedAddresses,
      datagranApiKey: mailbox.datagranApiKey,
    })),
    emails: triageBatch,
  });
  await persistFinishedCursors({
    supabase: args.auth.supabase,
    userId: args.auth.userId,
    discoveries: discoveredByMailbox,
    attemptedIds,
  });
  return {
    body: {
      ok: true,
      result,
      discovery: {
        checked: checkedCount,
        newMessages: triageBatch.length,
        alreadyOrganized: checkedCount - unorganizedRefs.length,
        remaining: Math.max(0, unorganizedRefs.length - candidateBatch.length),
        requiresLiveRefresh,
        mode: discoveryMode,
      },
      model: {
        provider: route.provider,
        name: route.modelName,
        tier: route.tier,
        reasoningEffort: route.reasoningEffort,
      },
    },
  };
}

export async function POST(request: Request) {
  const auth = await requireEmailUser();
  if (!auth.ok) return auth.response;
  try {
    const coordinated = await withEmailProviderRequest({
      supabase: auth.supabase,
      userId: auth.userId,
      scope: "triage",
      execute: () => runTriage({ request, auth }),
      leaseMs: 290_000,
      freshMs: 12_000,
      staleMs: 20_000,
      waitMs: 3_000,
      serializeProvider: true,
    });
    return NextResponse.json(coordinated.value.body, {
      status: coordinated.value.status || 200,
      headers: {
        "X-Groovy-Email-Provider-Result": coordinated.disposition,
      },
    });
  } catch (error) {
    return jsonError(error, "Could not run email triage.");
  }
}
