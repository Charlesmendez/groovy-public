import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  authorizeChatChannelForUser,
  resolveAccessibleChatChannel,
  type AccessibleChatChannel,
  type ChatChannelCommandKind,
} from "@/lib/chat/channelCommandService";
import { CHAT_MESSAGE_SEND_INTERNAL_SCOPE } from "@/lib/chat/internalScopes";
import { MAX_CHAT_MESSAGE_CHARACTERS } from "@/lib/chat/messageLimits";
import { buildInternalRouteAuthHeaders } from "@/lib/internalRouteAuth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export type ChatCommandUiAction = {
  type: "open_chat";
  url: string;
  label: string;
};

export type ChatCommandDependencies = {
  createAdmin: () => SupabaseClient;
  resolveChannel: typeof resolveAccessibleChatChannel;
  authorizeChannel: typeof authorizeChatChannelForUser;
  buildInternalHeaders: typeof buildInternalRouteAuthHeaders;
  fetchImpl: typeof fetch;
  createClientMessageId: () => string;
};

const defaultDependencies: ChatCommandDependencies = {
  createAdmin: createSupabaseAdminClient,
  resolveChannel: resolveAccessibleChatChannel,
  authorizeChannel: authorizeChatChannelForUser,
  buildInternalHeaders: buildInternalRouteAuthHeaders,
  fetchImpl: fetch,
  createClientMessageId: randomUUID,
};

type ChatChannelSummary = Pick<
  AccessibleChatChannel,
  "id" | "workspaceId" | "kind" | "name" | "slug" | "displayName"
>;

function chatUrl(channelId: string): string {
  return `/chat/${encodeURIComponent(channelId)}`;
}

function channelSummary(channel: AccessibleChatChannel): ChatChannelSummary {
  return {
    id: channel.id,
    workspaceId: channel.workspaceId,
    kind: channel.kind,
    name: channel.name,
    slug: channel.slug,
    displayName: channel.displayName,
  };
}

function uiAction(channel: AccessibleChatChannel): ChatCommandUiAction {
  return {
    type: "open_chat",
    url: chatUrl(channel.id),
    label: channel.displayName,
  };
}

function normalizedAppBaseUrl(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("The Groovy Chat service URL is unavailable.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("The Groovy Chat service URL is unavailable.");
  }
  return parsed.toString().replace(/\/$/, "");
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}

function safeError(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized ? normalized.slice(0, 500) : null;
}

function emitOpenAction(args: {
  channel: AccessibleChatChannel;
  shouldOpen: boolean;
  onUiAction?: (action: ChatCommandUiAction) => void;
}): { url: string; opened: boolean; navigationWarning?: string } {
  const action = uiAction(args.channel);
  if (!args.shouldOpen || !args.onUiAction) {
    return { url: action.url, opened: false };
  }
  try {
    args.onUiAction(action);
    return { url: action.url, opened: true };
  } catch {
    return {
      url: action.url,
      opened: false,
      navigationWarning:
        "The conversation is available at the returned URL, but Groovy could not open it automatically.",
    };
  }
}

export async function resolveGroovyChatChannel(
  args: {
    userId: string;
    query: string;
    kind?: Exclude<ChatChannelCommandKind, "any">;
    open?: boolean;
    onUiAction?: (action: ChatCommandUiAction) => void;
  },
  dependencies: ChatCommandDependencies = defaultDependencies,
): Promise<Record<string, unknown>> {
  const query = args.query.trim();
  if (!query) throw new Error("Name a Groovy Chat channel or direct message.");
  const result = await dependencies.resolveChannel({
    admin: dependencies.createAdmin(),
    userId: args.userId,
    query,
    kind: args.kind,
  });
  if (!result.ok) {
    return {
      resolved: false,
      reason: result.reason,
      message: result.message,
      ...(result.reason === "ambiguous"
        ? { candidates: result.candidates.map(channelSummary) }
        : {}),
    };
  }

  const openState = emitOpenAction({
    channel: result.channel,
    shouldOpen: args.open === true,
    onUiAction: args.onUiAction,
  });
  return {
    resolved: true,
    channel: channelSummary(result.channel),
    url: openState.url,
    opened: openState.opened,
    ...(openState.navigationWarning
      ? { navigationWarning: openState.navigationWarning }
      : {}),
  };
}

export async function sendGroovyChatMessage(
  args: {
    userId: string;
    appBaseUrl: string;
    channelId: string;
    content: string;
    timezone?: string | null;
    openAfterSend?: boolean;
    onUiAction?: (action: ChatCommandUiAction) => void;
  },
  dependencies: ChatCommandDependencies = defaultDependencies,
): Promise<Record<string, unknown>> {
  const channelId = args.channelId.trim();
  const content = args.content.trim();
  if (!isUuid(channelId)) throw new Error("An exact Groovy Chat channel ID is required.");
  if (!content) throw new Error("A message is required.");
  if (content.length > MAX_CHAT_MESSAGE_CHARACTERS) {
    throw new Error(
      `The message exceeds Groovy Chat's ${MAX_CHAT_MESSAGE_CHARACTERS.toLocaleString()} character limit.`,
    );
  }

  const admin = dependencies.createAdmin();
  const authorization = await dependencies.authorizeChannel({
    admin,
    userId: args.userId,
    channelId,
  });
  if (!authorization.ok) {
    throw new Error(
      authorization.reason === "archived"
        ? "That Groovy Chat conversation is archived and read-only."
        : "That Groovy Chat conversation is unavailable or you no longer have access.",
    );
  }

  const internalHeaders = dependencies.buildInternalHeaders({
    userId: args.userId,
    scope: CHAT_MESSAGE_SEND_INTERNAL_SCOPE,
  });
  if (
    !internalHeaders["x-groovy-internal-user-id"] ||
    !internalHeaders["x-groovy-internal-auth"]
  ) {
    throw new Error("Secure Groovy Chat delivery is unavailable.");
  }

  const clientMessageId = dependencies.createClientMessageId();
  if (!isUuid(clientMessageId)) {
    throw new Error("Secure Groovy Chat delivery could not create a request ID.");
  }
  const baseUrl = normalizedAppBaseUrl(args.appBaseUrl);
  const endpoint = new URL(
    `/api/chat/channels/${encodeURIComponent(channelId)}/messages`,
    baseUrl,
  );
  const response = await dependencies.fetchImpl(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...internalHeaders,
    },
    body: JSON.stringify({
      content,
      clientMessageId,
      timezone: args.timezone || "UTC",
    }),
  });
  const payload = (await response.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;
  if (!response.ok) {
    throw new Error(
      safeError(payload.error) ||
        `Groovy Chat could not deliver the message (HTTP ${response.status}).`,
    );
  }
  const message =
    payload.message &&
    typeof payload.message === "object" &&
    !Array.isArray(payload.message)
      ? (payload.message as Record<string, unknown>)
      : null;
  const messageId = typeof message?.id === "string" ? message.id : "";
  if (!messageId) {
    throw new Error("Groovy Chat returned an invalid delivery result.");
  }

  const openState = emitOpenAction({
    channel: authorization.channel,
    shouldOpen: args.openAfterSend === true,
    onUiAction: args.onUiAction,
  });
  return {
    delivered: true,
    replayed: payload.replayed === true,
    channel: channelSummary(authorization.channel),
    message: {
      id: messageId,
      content:
        typeof message?.content === "string" ? message.content : content,
    },
    clientMessageId,
    url: openState.url,
    opened: openState.opened,
    ...(openState.navigationWarning
      ? { navigationWarning: openState.navigationWarning }
      : {}),
    ...(safeError(payload.error) ? { warning: safeError(payload.error) } : {}),
  };
}
