import * as webPush from "web-push";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  messageMentionsRecipient,
  notificationExcerpt,
  pushTopicForChannel,
  type ChatNotificationMode,
} from "@/lib/notifications/push";

type PushConfiguration = {
  publicKey: string;
  privateKey: string;
  subject: string;
};

type PushPreferenceRow = {
  user_id: string;
  mode: ChatNotificationMode;
};

type PushSubscriptionRow = {
  id: string;
  user_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  expiration_time: number | string | null;
};

class UnsafePushEndpointError extends Error {}

function isPublicIpAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b] = address.split(".").map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  if (isIP(address) === 6) {
    const value = address.toLowerCase();
    if (value.startsWith("::ffff:")) {
      return isPublicIpAddress(value.slice("::ffff:".length));
    }
    return (
      (value.startsWith("2") || value.startsWith("3")) &&
      !value.startsWith("2001:db8")
    );
  }
  return false;
}

async function assertPublicPushEndpoint(endpoint: string): Promise<void> {
  const url = new URL(endpoint);
  if (url.protocol !== "https:") {
    throw new UnsafePushEndpointError("Push endpoint is not HTTPS");
  }
  const addresses = await lookup(url.hostname, { all: true, verbatim: true });
  if (
    addresses.length === 0 ||
    addresses.some((entry) => !isPublicIpAddress(entry.address))
  ) {
    throw new UnsafePushEndpointError(
      "Push endpoint resolved to a non-public address",
    );
  }
}

function getPushConfiguration(): PushConfiguration | null {
  const publicKey = process.env.WEB_PUSH_VAPID_PUBLIC_KEY?.trim() || "";
  const privateKey = process.env.WEB_PUSH_VAPID_PRIVATE_KEY?.trim() || "";
  const subject =
    process.env.WEB_PUSH_CONTACT?.trim() || "mailto:support@gogroovy.ai";
  if (!publicKey || !privateKey) return null;
  if (!subject.startsWith("mailto:") && !subject.startsWith("https://")) {
    console.error(
      "[web-push] WEB_PUSH_CONTACT must be a mailto: or HTTPS URL",
    );
    return null;
  }
  return { publicKey, privateKey, subject };
}

export function getWebPushPublicKey(): string | null {
  return getPushConfiguration()?.publicKey || null;
}

function userDisplayName(user: {
  email?: string | null;
  user_metadata?: Record<string, unknown> | null;
}): string {
  const metadata = user.user_metadata || {};
  const name =
    (typeof metadata.full_name === "string" && metadata.full_name.trim()) ||
    (typeof metadata.name === "string" && metadata.name.trim()) ||
    user.email?.split("@")[0] ||
    "Teammate";
  return name.replace(/[\r\n]+/g, " ").trim().slice(0, 100) || "Teammate";
}

async function resolveMentionRecipients(args: {
  admin: SupabaseClient;
  preferences: PushPreferenceRow[];
  content: string;
}): Promise<Set<string>> {
  const mentioned = new Set<string>();
  await Promise.all(
    args.preferences
      .filter((preference) => preference.mode === "mentions")
      .map(async (preference) => {
        const { data } = await args.admin.auth.admin.getUserById(
          preference.user_id,
        );
        const user = data.user;
        if (
          user &&
          messageMentionsRecipient({
            content: args.content,
            email: user.email,
            name: userDisplayName(user),
          })
        ) {
          mentioned.add(preference.user_id);
        }
      }),
  );
  return mentioned;
}

export type TeamChatPushInput = {
  admin: SupabaseClient;
  channelId: string;
  messageId: string;
  authorType: "user" | "orchestrator" | "agent" | "system";
  authorUserId?: string | null;
  authorLabel?: string | null;
  content: string;
};

/**
 * Delivers one best-effort Web Push event to users who explicitly opted into
 * this room. Every recipient is re-authorized against current channel
 * membership before an endpoint is used, so a stale preference cannot leak a
 * private-channel message after access is removed.
 */
export async function sendTeamChatPush(
  input: TeamChatPushInput,
): Promise<{ attempted: number; delivered: number }> {
  const config = getPushConfiguration();
  if (!config) return { attempted: 0, delivered: 0 };

  const { data: channel, error: channelError } = await input.admin
    .from("chat_channels")
    .select("id,workspace_id,kind,name,visibility,created_by,is_archived")
    .eq("id", input.channelId)
    .maybeSingle();
  if (channelError || !channel || channel.is_archived) {
    if (channelError) {
      console.warn("[web-push] channel lookup failed", {
        channelId: input.channelId,
        code: channelError.code,
      });
    }
    return { attempted: 0, delivered: 0 };
  }

  const { data: preferenceData, error: preferenceError } = await input.admin
    .from("chat_notification_preferences")
    .select("user_id,mode")
    .eq("channel_id", input.channelId)
    .neq("mode", "off");
  if (preferenceError) {
    const migrationPending =
      preferenceError.code === "42P01" ||
      preferenceError.code === "PGRST205" ||
      preferenceError.message.includes("chat_notification_preferences");
    if (!migrationPending) {
      console.warn("[web-push] preference lookup failed", {
        channelId: input.channelId,
        code: preferenceError.code,
      });
    }
    return { attempted: 0, delivered: 0 };
  }

  const preferences = (preferenceData || []) as PushPreferenceRow[];
  const candidateUserIds = Array.from(
    new Set(
      preferences
        .map((preference) => preference.user_id)
        .filter((userId) => userId && userId !== input.authorUserId),
    ),
  );
  if (candidateUserIds.length === 0) return { attempted: 0, delivered: 0 };

  const [{ data: memberships }, { data: workspaceMemberships }] =
    await Promise.all([
      input.admin
        .from("chat_channel_members")
        .select("user_id")
        .eq("channel_id", input.channelId)
        .eq("member_type", "user")
        .in("user_id", candidateUserIds),
      input.admin
        .from("workspace_members")
        .select("user_id,role")
        .eq("workspace_id", channel.workspace_id)
        .in("user_id", candidateUserIds),
    ]);
  const explicitMembers = new Set(
    (memberships || [])
      .map((membership) => String(membership.user_id || ""))
      .filter(Boolean),
  );
  const workspaceRoles = new Map(
    (workspaceMemberships || []).map((membership) => [
      String(membership.user_id),
      String(membership.role),
    ]),
  );
  const eligibleUserIds = new Set(
    candidateUserIds.filter((userId) => {
      if (explicitMembers.has(userId)) return true;
      if (String(channel.created_by) === userId && workspaceRoles.has(userId)) {
        return true;
      }
      if (channel.kind !== "channel") return false;
      const role = workspaceRoles.get(userId);
      if (role === "admin") return true;
      return channel.visibility === "workspace" && role === "member";
    }),
  );
  if (eligibleUserIds.size === 0) return { attempted: 0, delivered: 0 };

  const mentionedUserIds =
    channel.kind === "channel"
      ? await resolveMentionRecipients({
          admin: input.admin,
          preferences: preferences.filter((preference) =>
            eligibleUserIds.has(preference.user_id),
          ),
          content: input.content,
        })
      : new Set<string>();
  const enabledUserIds = new Set(
    preferences
      .filter(
        (preference) =>
          eligibleUserIds.has(preference.user_id) &&
          (preference.mode === "all" ||
            (preference.mode === "mentions" &&
              mentionedUserIds.has(preference.user_id))),
      )
      .map((preference) => preference.user_id),
  );
  if (enabledUserIds.size === 0) return { attempted: 0, delivered: 0 };

  const { data: subscriptionData, error: subscriptionError } =
    await input.admin
      .from("web_push_subscriptions")
      .select("id,user_id,endpoint,p256dh,auth,expiration_time")
      .in("user_id", Array.from(enabledUserIds));
  if (subscriptionError) {
    console.warn("[web-push] subscription lookup failed", {
      channelId: input.channelId,
      code: subscriptionError.code,
    });
    return { attempted: 0, delivered: 0 };
  }

  const subscriptions = (subscriptionData || []) as PushSubscriptionRow[];
  if (subscriptions.length === 0) return { attempted: 0, delivered: 0 };

  let authorLabel = input.authorLabel?.trim() || "";
  if (!authorLabel && input.authorUserId) {
    const { data } = await input.admin.auth.admin.getUserById(
      input.authorUserId,
    );
    if (data.user) authorLabel = userDisplayName(data.user);
  }
  if (!authorLabel) {
    authorLabel =
      input.authorType === "orchestrator"
        ? "Groovy"
        : input.authorType === "agent"
          ? "Agent"
          : input.authorType === "system"
            ? "System"
            : "Teammate";
  }

  const roomLabel =
    channel.kind === "channel" ? `#${channel.name}` : String(channel.name);
  const payload = JSON.stringify({
    title: `${roomLabel} · ${authorLabel}`,
    body: notificationExcerpt(input.content) || "New message",
    url: `/chat/${input.channelId}`,
    tag: `groovy-chat-${input.channelId}`,
    channelId: input.channelId,
    messageId: input.messageId,
    kind: channel.kind,
  });
  const staleSubscriptionIds: string[] = [];
  const successfulSubscriptionIds: string[] = [];

  const settled = await Promise.allSettled(
    subscriptions.map(async (subscription) => {
      try {
        await assertPublicPushEndpoint(subscription.endpoint);
        await webPush.sendNotification(
          {
            endpoint: subscription.endpoint,
            expirationTime:
              subscription.expiration_time === null
                ? null
                : Number(subscription.expiration_time),
            keys: {
              p256dh: subscription.p256dh,
              auth: subscription.auth,
            },
          },
          payload,
          {
            TTL: 60 * 60,
            urgency: "high",
            topic: pushTopicForChannel(input.channelId),
            timeout: 7_500,
            vapidDetails: {
              subject: config.subject,
              publicKey: config.publicKey,
              privateKey: config.privateKey,
            },
          },
        );
        successfulSubscriptionIds.push(subscription.id);
      } catch (cause) {
        if (cause instanceof UnsafePushEndpointError) {
          staleSubscriptionIds.push(subscription.id);
          console.warn("[web-push] removed unsafe push endpoint", {
            channelId: input.channelId,
          });
          return;
        }
        if (
          cause instanceof webPush.WebPushError &&
          (cause.statusCode === 404 || cause.statusCode === 410)
        ) {
          staleSubscriptionIds.push(subscription.id);
          return;
        }
        console.warn("[web-push] delivery failed", {
          channelId: input.channelId,
          status:
            cause instanceof webPush.WebPushError ? cause.statusCode : null,
          error: cause instanceof Error ? cause.message : "Unknown push error",
        });
        throw cause;
      }
    }),
  );

  await Promise.all([
    staleSubscriptionIds.length > 0
      ? input.admin
          .from("web_push_subscriptions")
          .delete()
          .in("id", staleSubscriptionIds)
      : Promise.resolve(),
    successfulSubscriptionIds.length > 0
      ? input.admin
          .from("web_push_subscriptions")
          .update({ last_success_at: new Date().toISOString() })
          .in("id", successfulSubscriptionIds)
      : Promise.resolve(),
  ]);

  return {
    attempted: subscriptions.length,
    delivered: settled.filter(
      (result, index) =>
        result.status === "fulfilled" &&
        successfulSubscriptionIds.includes(subscriptions[index].id),
    ).length,
  };
}
