"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  ExternalLink,
  Hash,
  Loader2,
  LockKeyhole,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Send,
  Webhook,
} from "lucide-react";
import { CustomSelect } from "@/components/ui/CustomSelect";
import { webhookCurlExample } from "@/lib/chat/incomingWebhook";

type Channel = { id: string; name: string; visibility: string };
type Hook = {
  id: string;
  channel_id: string;
  name: string;
  enabled: boolean;
  created_at: string;
  last_received_at: string | null;
  message_count: number;
};
type SettingsData = { channels: Channel[]; webhooks: Hook[] };
const buttonStyle =
  "inline-flex min-h-10 items-center justify-center gap-2 rounded-xl border border-white/10 bg-white/[0.035] px-3.5 py-2 text-sm text-zinc-300 transition hover:border-white/20 hover:bg-white/[0.07] hover:text-white disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-300";
const primaryStyle =
  "inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-cyan-300 px-4 py-2.5 text-sm font-semibold text-zinc-950 transition hover:bg-cyan-200 disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-300";

async function request<T>(
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    ...(body === undefined
      ? {}
      : {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
    cache: "no-store",
    signal,
  });
  const data = await response.json();
  if (!response.ok)
    throw new Error(
      data.message || "Could not load webhooks. Please try again.",
    );
  return data as T;
}

function CopyButton({
  text,
  label = "Copy",
  disabled = false,
}: {
  text: string;
  label?: string;
  disabled?: boolean;
}) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  useEffect(() => {
    if (state === "idle") return;
    const timer = window.setTimeout(() => setState("idle"), 2500);
    return () => window.clearTimeout(timer);
  }, [state]);
  return (
    <span className="inline-flex flex-col items-end gap-1">
      <button
        type="button"
        disabled={disabled}
        className={buttonStyle}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(text);
            setState("copied");
          } catch {
            setState("failed");
          }
        }}
      >
        {state === "copied" ? (
          <Check className="h-4 w-4 text-emerald-300" />
        ) : (
          <Copy className="h-4 w-4" />
        )}
        <span aria-live="polite">{state === "copied" ? "Copied" : label}</span>
      </button>
      {state === "failed" ? (
        <span
          role="status"
          className="max-w-52 text-right text-xs text-amber-200"
        >
          Select the text and copy it manually.
        </span>
      ) : null}
    </span>
  );
}

function WebhookSetup({
  hook,
  channel,
  initialUrl,
  onUpdate,
  onRemove,
}: {
  hook: Hook;
  channel: Channel;
  initialUrl?: string;
  onUpdate: (hook: Hook) => void;
  onRemove: () => void;
}) {
  const [url, setUrl] = useState(initialUrl || "");
  const [showUrl, setShowUrl] = useState(false);
  const [example, setExample] = useState("json");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tested, setTested] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<"rotate" | "revoke" | null>(null);
  const [urlVersion, setUrlVersion] = useState(0);
  const urlRequest = useRef<AbortController | null>(null);
  useEffect(() => {
    if (initialUrl) return;
    const controller = new AbortController();
    urlRequest.current = controller;
    void request<{ url: string }>(
      `/api/chat/webhooks/${hook.id}`,
      { operation: "url" },
      controller.signal,
    )
      .then((data) => {
        if (!controller.signal.aborted) setUrl(data.url);
      })
      .catch((reason) => {
        if (!controller.signal.aborted) setError(reason.message);
      });
    return () => controller.abort();
  }, [hook.id, initialUrl, urlVersion]);

  const run = async (operation: string) => {
    if (busy) return;
    setBusy(operation);
    setError(null);
    setNotice(null);
    try {
      const data = await request<{ webhook?: Hook; url?: string }>(
        `/api/chat/webhooks/${hook.id}`,
        { operation },
      );
      if (data.url) {
        // A slower reveal request must never overwrite a newly rotated URL.
        urlRequest.current?.abort();
        setUrl(data.url);
        setTested(false);
        setNotice("New URL ready. Copy it into your service to reconnect.");
      }
      if (data.webhook) onUpdate(data.webhook);
      if (operation === "test") {
        setTested(true);
        onUpdate({
          ...hook,
          last_received_at: new Date().toISOString(),
          message_count: Number(hook.message_count) + 1,
        });
      }
      if (operation === "revoke") onRemove();
      setConfirm(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Please try again.");
    } finally {
      setBusy(null);
    }
  };
  const code =
    example === "json"
      ? '{\n  "text": "Hello from my service!"\n}'
      : example === "javascript"
        ? `await fetch(${JSON.stringify(url || "YOUR_WEBHOOK_URL")}, {\n  method: "POST",\n  headers: { "Content-Type": "application/json" },\n  body: JSON.stringify({ text: "Hello from my service!" })\n});`
        : webhookCurlExample(url || "YOUR_WEBHOOK_URL");
  return (
    <div className="border-t border-white/[0.08] px-4 pb-5 pt-5 sm:px-6 sm:pb-6">
      <div className="flex items-center gap-2 text-xs font-medium text-zinc-300">
        <LockKeyhole className="h-3.5 w-3.5 text-zinc-500" />
        Your webhook URL
      </div>
      <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-start">
        <div className="flex min-w-0 flex-1 items-center rounded-xl border border-white/10 bg-black/30 px-3">
          <input
            aria-label="Webhook URL"
            type={showUrl ? "text" : "password"}
            readOnly
            value={url}
            placeholder="Loading URL…"
            onFocus={(event) => event.target.select()}
            className="min-h-11 min-w-0 flex-1 bg-transparent font-mono text-xs text-zinc-300 outline-none"
            autoComplete="off"
            spellCheck={false}
          />
          <button
            type="button"
            className="min-h-11 shrink-0 px-2 text-xs text-zinc-400 hover:text-white"
            onClick={() => setShowUrl(!showUrl)}
          >
            {showUrl ? "Hide" : "Show"}
          </button>
        </div>
        <CopyButton
          text={url}
          label="Copy URL"
          disabled={!url || Boolean(busy)}
        />
      </div>
      <p className="mt-2 text-xs leading-relaxed text-zinc-500">
        Anyone with this URL can post to{" "}
        <span className="text-zinc-300">#{channel.name}</span>. Keep it in your
        service’s secrets.
      </p>

      <div className="mt-5 rounded-xl border border-white/[0.08] bg-black/20 p-4">
        <h4 className="text-sm font-medium text-zinc-200">
          Connect your service
        </h4>
        <p className="mt-1 text-xs leading-relaxed text-zinc-400">
          Choose <span className="font-medium text-zinc-200">HTTP request</span>{" "}
          in your automation tool. Paste the URL, use{" "}
          <code className="text-cyan-200">POST</code>, and send JSON with a{" "}
          <code className="text-cyan-200">text</code> field.
        </p>
        <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
          <div
            className="flex gap-1 rounded-lg bg-white/[0.035] p-1"
            role="group"
            aria-label="Request example"
          >
            {[
              ["json", "JSON body"],
              ["curl", "cURL"],
              ["javascript", "JavaScript"],
            ].map(([value, label]) => (
              <button
                key={value}
                type="button"
                aria-pressed={example === value}
                onClick={() => setExample(value)}
                className={`rounded-md px-2.5 py-1.5 text-xs transition ${example === value ? "bg-white/10 text-white" : "text-zinc-500 hover:text-zinc-200"}`}
              >
                {label}
              </button>
            ))}
          </div>
          <CopyButton
            text={code}
            label="Copy example"
            disabled={Boolean(busy) || (!url && example !== "json")}
          />
        </div>
        <pre
          className="mt-3 overflow-x-auto rounded-lg bg-[#08090b] p-3 text-[11px] leading-6 text-zinc-300"
          tabIndex={0}
          aria-label={`${example} webhook example`}
        >
          <code>{code}</code>
        </pre>
        <div className="mt-3 text-xs text-zinc-500">
          Header:{" "}
          <code className="text-zinc-400">Content-Type: application/json</code>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button
          type="button"
          className={buttonStyle}
          disabled={Boolean(busy) || !hook.enabled}
          onClick={() => void run("test")}
        >
          {busy === "test" ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : tested ? (
            <Check className="h-4 w-4 text-emerald-300" />
          ) : (
            <Send className="h-4 w-4" />
          )}
          {busy === "test"
            ? "Sending…"
            : tested
              ? "Send another test"
              : "Send test message"}
        </button>
        <Link
          href={`/chat/${channel.id}`}
          className="inline-flex min-h-10 items-center gap-1.5 text-sm text-cyan-200 hover:text-cyan-100"
        >
          Open #{channel.name}
          <ExternalLink className="h-3.5 w-3.5" />
        </Link>
      </div>
      {tested && hook.enabled ? (
        <p
          role="status"
          className="mt-3 flex items-center gap-2 text-sm text-emerald-300"
        >
          <Check className="h-4 w-4" />
          Test delivered. Your channel is ready.
        </p>
      ) : null}
      {notice ? (
        <p role="status" className="mt-3 text-sm text-emerald-300">
          {notice}
        </p>
      ) : null}
      {!hook.enabled ? (
        <p role="status" className="mt-3 text-sm text-amber-200">
          Paused. Resume this webhook to accept messages again.
        </p>
      ) : null}
      {error ? (
        <div
          role="alert"
          className="mt-3 rounded-xl border border-red-400/20 bg-red-400/[0.06] p-3 text-sm text-red-200"
        >
          {error}
          {!url ? (
            <button
              type="button"
              className="ml-2 underline"
              onClick={() => {
                setError(null);
                setUrlVersion((value) => value + 1);
              }}
            >
              Retry
            </button>
          ) : null}
        </div>
      ) : null}

      <details className="mt-5 border-t border-white/[0.07] pt-4">
        <summary className="cursor-pointer text-xs text-zinc-400 hover:text-white">
          Options &amp; delivery details
        </summary>
        <p className="mt-3 text-xs leading-relaxed text-zinc-500">
          Up to 60 messages per minute and 40,000 characters per message. To
          avoid duplicates when retrying, send a unique{" "}
          <code>Idempotency-Key</code> header and reuse it for the same message.
          A successful request returns <code>{'{"ok":true}'}</code> with the
          message ID.
        </p>
        <p className="mt-2 text-xs leading-relaxed text-zinc-500">
          Text and Markdown are supported. Slack blocks and attachments are not
          rendered. Messages follow your channel’s notification preferences and
          do not automatically run a Mind.
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          <button
            type="button"
            className={buttonStyle}
            disabled={Boolean(busy)}
            onClick={() => void run(hook.enabled ? "pause" : "resume")}
          >
            {hook.enabled ? (
              <Pause className="h-3.5 w-3.5" />
            ) : (
              <Play className="h-3.5 w-3.5" />
            )}
            {hook.enabled ? "Pause" : "Resume"}
          </button>
          <button
            type="button"
            className={buttonStyle}
            disabled={Boolean(busy)}
            onClick={() => setConfirm("rotate")}
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Replace URL
          </button>
          <button
            type="button"
            className={`${buttonStyle} text-red-300`}
            disabled={Boolean(busy)}
            onClick={() => setConfirm("revoke")}
          >
            Remove webhook
          </button>
        </div>
        {confirm ? (
          <div className="mt-3 rounded-xl border border-amber-300/20 bg-amber-300/[0.04] p-4">
            <p className="text-sm font-medium text-zinc-200">
              {confirm === "rotate"
                ? "Replace this webhook URL?"
                : `Remove ${hook.name}?`}
            </p>
            <p className="mt-1 text-xs leading-relaxed text-zinc-400">
              {confirm === "rotate"
                ? "The current URL will stop working immediately. Copy the new URL into your service afterward."
                : "Your service will no longer be able to post. Messages already in the channel will stay."}
            </p>
            <div className="mt-3 flex gap-2">
              <button
                type="button"
                className={buttonStyle}
                disabled={Boolean(busy)}
                onClick={() => void run(confirm)}
              >
                {busy
                  ? "Working…"
                  : confirm === "rotate"
                    ? "Replace URL"
                    : "Remove webhook"}
              </button>
              <button
                type="button"
                className={buttonStyle}
                disabled={Boolean(busy)}
                onClick={() => setConfirm(null)}
              >
                Cancel
              </button>
            </div>
          </div>
        ) : null}
      </details>
    </div>
  );
}

export function IncomingWebhookSettings({
  initialChannelId = "",
}: {
  initialChannelId?: string;
}) {
  const [data, setData] = useState<SettingsData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [channelId, setChannelId] = useState(initialChannelId);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [createdUrl, setCreatedUrl] = useState<{
    id: string;
    url: string;
  } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const createdRef = useRef<HTMLDivElement>(null);
  const revision = useRef(0);
  const load = useCallback(async (signal?: AbortSignal) => {
    const startedAt = revision.current;
    setRefreshing(true);
    try {
      const result = await request<SettingsData>(
        "/api/chat/webhooks",
        undefined,
        signal,
      );
      if (startedAt !== revision.current || signal?.aborted) return;
      setData(result);
      setError(null);
      setChannelId((current) =>
        result.channels.some((channel) => channel.id === current)
          ? current
          : result.channels[0]?.id || "",
      );
    } catch (reason) {
      if (!signal?.aborted)
        setError(
          reason instanceof Error ? reason.message : "Please try again.",
        );
    } finally {
      if (!signal?.aborted) setRefreshing(false);
    }
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const create = async (event: React.FormEvent) => {
    event.preventDefault();
    if (creating || !channelId) return;
    revision.current += 1;
    setCreating(true);
    setError(null);
    setNotice(null);
    try {
      const result = await request<{ webhook: Hook; url: string }>(
        "/api/chat/webhooks",
        { channelId, name },
      );
      revision.current += 1;
      setData((current) =>
        current
          ? { ...current, webhooks: [result.webhook, ...current.webhooks] }
          : current,
      );
      setExpandedId(result.webhook.id);
      setCreatedUrl({ id: result.webhook.id, url: result.url });
      setName("");
      setNotice(
        "Webhook created. Copy your URL below to connect your service.",
      );
      window.requestAnimationFrame(() => {
        createdRef.current?.scrollIntoView({
          behavior: "smooth",
          block: "nearest",
        });
        createdRef.current?.focus({ preventScroll: true });
      });
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Could not create the webhook.",
      );
    } finally {
      setCreating(false);
    }
  };
  return (
    <main className="mx-auto max-w-4xl px-4 py-7 sm:px-7 sm:py-10">
      <div className="flex items-start gap-4">
        <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl border border-cyan-300/20 bg-cyan-300/[0.07] text-cyan-200">
          <Webhook className="h-6 w-6" />
        </span>
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">
            Bring your updates into Chat
          </h2>
          <p className="mt-2 max-w-xl text-sm leading-relaxed text-zinc-400">
            Alerts, releases, new leads—right where your team talks. Create a
            webhook and let your services post to a Groovy channel.
          </p>
        </div>
      </div>
      <div
        className="mt-7 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-zinc-400"
        aria-label="Setup steps"
      >
        <span>
          <span className="mr-2 text-cyan-300">01</span>Choose a channel
        </span>
        <ArrowRight className="h-3 w-3 text-zinc-700" />
        <span>
          <span className="mr-2 text-cyan-300">02</span>Copy your URL
        </span>
        <ArrowRight className="h-3 w-3 text-zinc-700" />
        <span>
          <span className="mr-2 text-cyan-300">03</span>Send a message
        </span>
      </div>

      {error ? (
        <div
          role="alert"
          className="mt-6 rounded-xl border border-red-400/20 bg-red-400/[0.06] p-4 text-sm text-red-200"
        >
          {error}
          <button
            type="button"
            className="ml-3 underline"
            onClick={() => void load()}
          >
            Try again
          </button>
        </div>
      ) : null}
      {!data ? (
        !error ? (
          <div
            className="mt-7 space-y-3"
            aria-label="Loading webhooks"
            role="status"
          >
            <div className="h-40 animate-pulse rounded-2xl bg-white/[0.035]" />
            <p className="text-sm text-zinc-500">Loading your channels…</p>
          </div>
        ) : null
      ) : (
        <>
          {data.channels.length > 0 ? (
            <form
              onSubmit={create}
              className="mt-7 rounded-2xl border border-white/10 bg-white/[0.025] p-4 sm:p-6"
            >
              <h3 className="text-sm font-medium">Create a webhook</h3>
              <div className="mt-4 grid items-end gap-4 sm:grid-cols-2">
                <div>
                  <label className="mb-2 block text-xs text-zinc-400">
                    Post to channel
                  </label>
                  <CustomSelect
                    value={channelId}
                    onChange={setChannelId}
                    ariaLabel="Post to channel"
                    disabled={creating}
                    options={data.channels.map((channel) => ({
                      value: channel.id,
                      label: `# ${channel.name}`,
                      description:
                        channel.visibility === "private"
                          ? "Private channel"
                          : undefined,
                    }))}
                  />
                </div>
                <div>
                  <label
                    htmlFor="webhook-service-name"
                    className="mb-2 block text-xs text-zinc-400"
                  >
                    Service name{" "}
                    <span className="text-zinc-600">· optional</span>
                  </label>
                  <input
                    id="webhook-service-name"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    maxLength={60}
                    placeholder="e.g. Release updates"
                    disabled={creating}
                    className="min-h-10 w-full rounded-xl border border-white/10 bg-white/[0.025] px-3.5 py-2 text-sm outline-none placeholder:text-zinc-600 focus:border-cyan-300/50"
                  />
                </div>
              </div>
              <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <p className="text-xs text-zinc-500">
                  This name appears next to each message.
                </p>
                <button
                  type="submit"
                  disabled={creating || !channelId}
                  className={primaryStyle}
                >
                  {creating ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Plus className="h-4 w-4" />
                  )}
                  {creating ? "Creating…" : "Create webhook"}
                </button>
              </div>
            </form>
          ) : (
            <div className="mt-7 rounded-2xl border border-dashed border-white/15 p-7 text-center">
              <Hash className="mx-auto h-7 w-7 text-zinc-500" />
              <h3 className="mt-3 font-medium">Start with a channel</h3>
              <p className="mt-2 text-sm text-zinc-400">
                Create a channel in Chat, or ask a workspace admin to set up
                your webhook. You can manage webhooks for channels you own.
              </p>
              <Link href="/chat" className={`${buttonStyle} mt-4`}>
                Open Chat
                <ArrowRight className="h-4 w-4" />
              </Link>
            </div>
          )}

          <div
            ref={createdRef}
            tabIndex={-1}
            className="mt-8 scroll-mt-24 outline-none"
          >
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-sm font-medium text-zinc-300">
                Your webhooks{" "}
                <span className="ml-1 text-zinc-600">
                  {data.webhooks.length}
                </span>
              </h3>
              <button
                type="button"
                disabled={refreshing || creating}
                onClick={() => void load()}
                className="inline-flex min-h-10 items-center gap-1.5 text-xs text-zinc-500 hover:text-zinc-200 disabled:opacity-40"
              >
                <RefreshCw
                  className={`h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`}
                />
                Refresh status
              </button>
            </div>
            {notice ? (
              <p role="status" className="mb-3 text-sm text-emerald-300">
                {notice}
              </p>
            ) : null}
            {data.webhooks.length === 0 ? (
              <div className="mt-2 rounded-2xl border border-dashed border-white/10 px-5 py-8 text-center text-sm text-zinc-500">
                Your first webhook will appear here, with everything you need to
                connect it.
              </div>
            ) : (
              <div className="mt-2 space-y-3">
                {data.webhooks.map((hook) => {
                  const channel = data.channels.find(
                    (item) => item.id === hook.channel_id,
                  );
                  if (!channel) return null;
                  const expanded = expandedId === hook.id;
                  return (
                    <section
                      key={hook.id}
                      className={`overflow-hidden rounded-2xl border transition ${expanded ? "border-cyan-300/25 bg-white/[0.025]" : "border-white/10 bg-white/[0.015]"}`}
                    >
                      <button
                        type="button"
                        onClick={() => setExpandedId(expanded ? null : hook.id)}
                        aria-expanded={expanded}
                        aria-controls={`webhook-${hook.id}`}
                        className="flex w-full items-center gap-3 px-4 py-4 text-left transition hover:bg-white/[0.025] sm:px-6"
                      >
                        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-white/[0.04] text-zinc-400">
                          <Webhook className="h-4 w-4" />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium">
                            {hook.name}
                          </span>
                          <span className="mt-1 block truncate text-xs text-zinc-500">
                            #{channel.name} ·{" "}
                            {hook.last_received_at
                              ? `Last received ${new Date(hook.last_received_at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`
                              : "Waiting for your first message"}
                          </span>
                        </span>
                        <span
                          className={`flex shrink-0 items-center gap-1.5 text-[11px] ${hook.enabled ? "text-emerald-300" : "text-amber-200"}`}
                        >
                          <span
                            className={`h-1.5 w-1.5 rounded-full ${hook.enabled ? "bg-emerald-300" : "bg-amber-200"}`}
                          />
                          {hook.enabled ? "Active" : "Paused"}
                        </span>
                        {expanded ? (
                          <ChevronDown className="h-4 w-4 shrink-0 text-zinc-500" />
                        ) : (
                          <ChevronRight className="h-4 w-4 shrink-0 text-zinc-500" />
                        )}
                      </button>
                      {expanded ? (
                        <div id={`webhook-${hook.id}`}>
                          <WebhookSetup
                            hook={hook}
                            channel={channel}
                            initialUrl={
                              createdUrl?.id === hook.id
                                ? createdUrl.url
                                : undefined
                            }
                            onUpdate={(updated) => {
                              revision.current += 1;
                              // Once rotated, load the saved URL next time this card opens.
                              setCreatedUrl(null);
                              setData((current) =>
                                current
                                  ? {
                                      ...current,
                                      webhooks: current.webhooks.map((item) =>
                                        item.id === updated.id ? updated : item,
                                      ),
                                    }
                                  : current,
                              );
                            }}
                            onRemove={() => {
                              revision.current += 1;
                              setData((current) =>
                                current
                                  ? {
                                      ...current,
                                      webhooks: current.webhooks.filter(
                                        (item) => item.id !== hook.id,
                                      ),
                                    }
                                  : current,
                              );
                              setCreatedUrl(null);
                              setNotice(
                                "Webhook removed. Existing channel messages are unchanged.",
                              );
                            }}
                          />
                        </div>
                      ) : null}
                    </section>
                  );
                })}
              </div>
            )}
          </div>
        </>
      )}
    </main>
  );
}
