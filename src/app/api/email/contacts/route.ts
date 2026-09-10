import { NextResponse } from "next/server";
import { jsonError, requireEmailUser } from "@/lib/email/auth";
import { recipientAddresses } from "@/lib/email/recipients";
import { normalizeEmailSearchQuery } from "@/lib/email/search";
import type { EmailContactSuggestion } from "@/lib/email/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RecordLike = Record<string, unknown>;

type IndexedContactRow = {
  connection_id?: unknown;
  mailbox_label?: unknown;
  sender_email?: unknown;
  sender_name?: unknown;
  draft_to?: unknown;
  draft_cc?: unknown;
  draft_bcc?: unknown;
  metadata?: unknown;
  received_at?: unknown;
  created_at?: unknown;
};

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function record(value: unknown): RecordLike {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordLike)
    : {};
}

function comparable(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase().trim();
}

function candidateScore(
  query: string,
  emailValue: string,
  nameValue: string,
): number {
  const email = comparable(emailValue);
  const name = comparable(nameValue);
  const localPart = email.split("@")[0] || "";
  if (email === query) return 1_000;
  if (email.startsWith(query)) return 900;
  if (localPart.startsWith(query)) return 860;
  if (name.startsWith(query)) return 820;
  if (email.includes(query)) return 620;
  if (name.includes(query)) return 580;
  return 0;
}

export async function GET(request: Request) {
  const auth = await requireEmailUser();
  if (!auth.ok) return auth.response;

  const url = new URL(request.url);
  const query = normalizeEmailSearchQuery(
    url.searchParams.get("query") || "",
  );
  const requestedLimit = Number(url.searchParams.get("limit") || 10);
  const limit = Number.isFinite(requestedLimit)
    ? Math.min(20, Math.max(1, Math.floor(requestedLimit)))
    : 10;
  if (query.length < 2) {
    return NextResponse.json(
      { ok: false, error: "Enter at least two characters." },
      { status: 400 },
    );
  }

  try {
    /*
     * Typeahead must not fan out into Gmail. The old implementation fetched
     * up to 24 complete messages from every connected mailbox for each query,
     * competing with sends and feed refreshes for the same rate limit. Inbox
     * actions and sender affinity already form a durable, user-scoped contact
     * index and are kept fresh by normal triage/send activity.
     */
    const [indexed, affinity] = await Promise.all([
      auth.supabase
        .from("inbox_actions")
        .select(
          "connection_id,mailbox_label,sender_email,sender_name,draft_to,draft_cc,draft_bcc,metadata,received_at,created_at",
        )
        .eq("user_id", auth.userId)
        .eq("provider", "gmail")
        .order("created_at", { ascending: false })
        .limit(600),
      auth.supabase
        .from("email_sender_affinity_cache")
        .select(
          "connection_id,sender_email,last_received_at,last_replied_at,updated_at",
        )
        .eq("user_id", auth.userId)
        .order("updated_at", { ascending: false })
        .limit(600),
    ]);
    if (indexed.error) throw new Error(indexed.error.message);
    if (affinity.error) throw new Error(affinity.error.message);

    const normalizedQuery = comparable(query);
    const owned = new Set(
      recipientAddresses(
        [
          auth.email || "",
          ...url.searchParams.getAll("ownedAddress"),
        ].join(", "),
      ),
    );
    for (const raw of indexed.data || []) {
      for (const address of recipientAddresses(
        String(record((raw as IndexedContactRow).metadata).owned_addresses || ""),
      )) {
        owned.add(address);
      }
    }
    const candidates = new Map<
      string,
      EmailContactSuggestion & { score: number; timestamp: number }
    >();
    const connections = new Set<string>();

    const add = (
      emailValue: string,
      nameValue: string,
      lastContactAt: string,
      mailboxAddress: string,
      mailboxDisplayName: string,
    ) => {
      const email = comparable(emailValue);
      if (!email || owned.has(email)) return;
      const score = candidateScore(normalizedQuery, email, nameValue);
      if (!score) return;
      const timestamp = Number.isFinite(Date.parse(lastContactAt))
        ? Date.parse(lastContactAt)
        : 0;
      const existing = candidates.get(email);
      if (
        existing &&
        (existing.score > score ||
          (existing.score === score && existing.timestamp >= timestamp))
      ) {
        return;
      }
      candidates.set(email, {
        email,
        name: nameValue.trim() || email,
        lastContactAt,
        mailboxAddress,
        mailboxDisplayName,
        score,
        timestamp,
      });
    };

    for (const raw of indexed.data || []) {
      const row = raw as IndexedContactRow;
      const connectionId = text(row.connection_id);
      if (connectionId) connections.add(connectionId);
      const mailboxDisplayName = text(row.mailbox_label);
      const lastContactAt =
        text(row.received_at) ||
        text(row.created_at) ||
        new Date(0).toISOString();
      add(
        text(row.sender_email),
        text(row.sender_name),
        lastContactAt,
        "",
        mailboxDisplayName,
      );
      const metadata = record(row.metadata);
      const participantValues = [
        row.draft_to,
        row.draft_cc,
        row.draft_bcc,
        metadata.draft_cc,
        metadata.email_tracking_recipients,
        metadata.original_to_header,
        metadata.original_cc_header,
        metadata.target_to_header,
        metadata.target_cc_header,
      ];
      for (const email of recipientAddresses(
        participantValues
          .flatMap((value) => (Array.isArray(value) ? value : [value]))
          .map((value) => String(value || ""))
          .join(", "),
      )) {
        add(
          email,
          email,
          lastContactAt,
          "",
          mailboxDisplayName,
        );
      }
    }
    for (const raw of affinity.data || []) {
      const row = raw as RecordLike;
      const connectionId = text(row.connection_id);
      if (connectionId) connections.add(connectionId);
      const email = text(row.sender_email);
      add(
        email,
        email,
        text(row.last_received_at) ||
          text(row.last_replied_at) ||
          text(row.updated_at) ||
          new Date(0).toISOString(),
        "",
        "",
      );
    }

    const suggestions = [...candidates.values()]
      .sort(
        (a, b) =>
          b.score - a.score ||
          b.timestamp - a.timestamp ||
          a.email.localeCompare(b.email),
      )
      .slice(0, limit)
      .map(
        ({
          email,
          name,
          lastContactAt,
          mailboxAddress,
          mailboxDisplayName,
        }) => ({
          email,
          name,
          lastContactAt,
          mailboxAddress,
          mailboxDisplayName,
        }),
      );

    return NextResponse.json(
      {
        ok: true,
        query,
        suggestions,
        searchedMailboxCount: connections.size,
        totalMailboxCount: connections.size,
        warnings: [],
      },
      {
        headers: {
          "Cache-Control": "private, max-age=30, stale-while-revalidate=120",
        },
      },
    );
  } catch (error) {
    return jsonError(error, "Could not search email contacts.");
  }
}
