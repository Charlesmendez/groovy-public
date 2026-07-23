"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type WidgetMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
};

type WidgetConfig = {
  name: string;
  greeting: string;
  primaryColor: string;
  avatar: string | null;
};

type StoredThread = {
  id: string;
  token: string;
  participantExternalId: string;
};

export function HarnessWidget({
  slug,
  publishableKey,
  parentOrigin,
}: {
  slug: string;
  publishableKey: string;
  parentOrigin: string;
}) {
  // The iframe is hosted on the Groovy origin, so its localStorage may be
  // shared by embeds on different top-level sites in browsers without storage
  // partitioning. Scope continuity to the verified parent origin explicitly.
  const storageKey = `groovy.widget.${slug}.${publishableKey.slice(0, 20)}.${encodeURIComponent(parentOrigin)}`;
  const [config, setConfig] = useState<WidgetConfig>({
    name: "Support",
    greeting: "Hi — how can we help?",
    primaryColor: "#06b6d4",
    avatar: null,
  });
  const [thread, setThread] = useState<StoredThread | null>(null);
  const [messages, setMessages] = useState<WidgetMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [embedState, setEmbedState] = useState<"checking" | "allowed" | "blocked">(
    "checking",
  );
  const scrollRef = useRef<HTMLDivElement>(null);

  const headers = useCallback(
    (threadToken?: string) => ({
      Authorization: `Bearer ${publishableKey}`,
      "Content-Type": "application/json",
      "X-Harness-Origin": parentOrigin,
      ...(threadToken ? { "X-Harness-Thread-Token": threadToken } : {}),
    }),
    [parentOrigin, publishableKey],
  );

  useEffect(() => {
    let referrerOrigin = "";
    try {
      referrerOrigin = new URL(document.referrer).origin;
    } catch {}
    setEmbedState(
      window.parent !== window && referrerOrigin === parentOrigin ? "allowed" : "blocked",
    );
  }, [parentOrigin]);

  useEffect(() => {
    if (embedState !== "allowed") return;
    try {
      const raw = window.localStorage.getItem(storageKey);
      if (raw) setThread(JSON.parse(raw) as StoredThread);
    } catch {}
    void fetch(`/api/v1/harnesses/${encodeURIComponent(slug)}/config`, {
      headers: headers(),
      cache: "no-store",
    })
      .then(async (response) => {
        if (response.ok) setConfig(await response.json());
      })
      .catch(() => undefined);
  }, [embedState, headers, slug, storageKey]);

  useEffect(() => {
    if (embedState !== "allowed" || !thread) return;
    void fetch(
      `/api/v1/harnesses/${encodeURIComponent(slug)}/threads/${thread.id}/messages`,
      { headers: headers(thread.token), cache: "no-store" },
    )
      .then(async (response) => {
        if (!response.ok) return;
        const payload = await response.json();
        setMessages(Array.isArray(payload.data) ? payload.data : []);
      })
      .catch(() => undefined);
  }, [embedState, headers, slug, thread]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
    window.parent.postMessage(
      { type: "groovy-widget-resize", height: document.documentElement.scrollHeight },
      parentOrigin,
    );
  }, [messages, busy, parentOrigin]);

  const ensureThread = async (): Promise<StoredThread> => {
    if (embedState !== "allowed") {
      throw new Error("This widget is not embedded from an allowed origin.");
    }
    if (thread) return thread;
    let participantExternalId = "";
    try {
      participantExternalId =
        window.localStorage.getItem(`${storageKey}.participant`) || "";
    } catch {}
    if (!participantExternalId) participantExternalId = crypto.randomUUID();
    const response = await fetch(
      `/api/v1/harnesses/${encodeURIComponent(slug)}/threads`,
      {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({
          participant: { externalId: participantExternalId },
        }),
      },
    );
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.error?.message || "Could not start the conversation.");
    }
    const next = {
      id: String(payload.id),
      token: String(payload.threadToken),
      participantExternalId,
    };
    setThread(next);
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(next));
      window.localStorage.setItem(`${storageKey}.participant`, participantExternalId);
    } catch {}
    return next;
  };

  const send = async () => {
    const content = draft.trim();
    if (!content || busy) return;
    setDraft("");
    setBusy(true);
    setError(null);
    const optimistic: WidgetMessage = {
      id: `local-${Date.now()}`,
      role: "user",
      content,
    };
    setMessages((current) => [...current, optimistic]);
    try {
      const activeThread = await ensureThread();
      const response = await fetch(
        `/api/v1/harnesses/${encodeURIComponent(slug)}/threads/${activeThread.id}/messages`,
        {
          method: "POST",
          headers: headers(activeThread.token),
          body: JSON.stringify({ content }),
        },
      );
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload.error?.message || "Could not send the message.");
      }
      setMessages((current) => [...current, payload.data as WidgetMessage]);
    } catch (cause) {
      setMessages((current) =>
        current.filter((message) => message.id !== optimistic.id),
      );
      setDraft((current) => current || content);
      setError(cause instanceof Error ? cause.message : "Could not send the message.");
    } finally {
      setBusy(false);
    }
  };

  if (embedState === "checking") {
    return (
      <div className="flex h-dvh items-center justify-center bg-white text-sm text-zinc-500">
        Loading…
      </div>
    );
  }

  if (embedState === "blocked") {
    return (
      <div className="flex h-dvh items-center justify-center bg-white p-6 text-center text-sm text-zinc-600">
        This widget is not embedded from an allowed origin.
      </div>
    );
  }

  return (
    <div className="flex h-dvh flex-col bg-white text-zinc-900">
      <header
        className="flex items-center gap-3 px-4 py-3 text-white"
        style={{ backgroundColor: config.primaryColor }}
      >
        {config.avatar ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={config.avatar} alt="" className="h-8 w-8 rounded-full object-cover" />
        ) : (
          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-white/20">✦</div>
        )}
        <div>
          <div className="text-sm font-semibold">{config.name}</div>
          <div className="text-[11px] text-white/75">Usually replies in a moment</div>
        </div>
      </header>
      <div ref={scrollRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
        {messages.length === 0 ? (
          <div className="max-w-[85%] rounded-2xl rounded-tl-sm bg-zinc-100 px-3 py-2 text-sm">
            {config.greeting}
          </div>
        ) : null}
        {messages.map((message) => (
          <div
            key={message.id}
            className={`max-w-[85%] whitespace-pre-wrap rounded-2xl px-3 py-2 text-sm ${
              message.role === "user"
                ? "ml-auto rounded-tr-sm text-white"
                : "rounded-tl-sm bg-zinc-100"
            }`}
            style={
              message.role === "user" ? { backgroundColor: config.primaryColor } : undefined
            }
          >
            {message.content}
          </div>
        ))}
        {busy ? <div className="text-xs text-zinc-400">Working…</div> : null}
      </div>
      <div className="border-t border-zinc-200 p-3">
        <div className="flex items-end gap-2 rounded-xl border border-zinc-200 px-3 py-2">
          <textarea
            rows={1}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void send();
              }
            }}
            placeholder="Type a message…"
            className="max-h-28 flex-1 resize-none text-sm outline-none"
          />
          <button
            onClick={() => void send()}
            disabled={busy || !draft.trim()}
            className="rounded-lg px-3 py-1.5 text-xs text-white disabled:opacity-40"
            style={{ backgroundColor: config.primaryColor }}
          >
            Send
          </button>
        </div>
        {error ? <p className="mt-1 text-[11px] text-red-600">{error}</p> : null}
        <p className="mt-1 text-center text-[10px] text-zinc-400">Powered by Groovy</p>
      </div>
    </div>
  );
}
