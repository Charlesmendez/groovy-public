"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Loader2,
  LogOut,
  RefreshCw,
  Send,
  Sparkles,
  Wifi,
  WifiOff,
} from "lucide-react";
import { getSupabaseBrowserClient } from "@/lib/supabase/browser";
import {
  useOrchestrator,
  type AgentActivity,
  type ConnectorExecuteCallback,
  type OrchestratorMessage,
} from "@/hooks/useOrchestrator";
import { useRelay, type RelayMessage } from "@/hooks/useRelay";
import { SessionPicker } from "@/components/chat/SessionPicker";
import {
  EnterpriseContextPanel,
  type EnterpriseDocument,
} from "@/components/enterprise/EnterpriseContextPanel";

type EnterpriseReviewShellProps = {
  brandName: string;
  logoUrl: string | null;
  userEmail: string | null;
};

type PendingConnectorRequest = {
  resolve: (result: { ok: boolean; error?: string; [key: string]: unknown }) => void;
  timeout: ReturnType<typeof setTimeout>;
  requestType: string;
  deviceId: string;
};

const DEFAULT_CONNECTOR_TIMEOUT_MS = 30_000;
const BROWSER_CONNECTOR_TIMEOUT_MS = 9 * 60 * 1000;
const CREDENTIAL_CONNECTOR_TIMEOUT_MS = 120_000;
const PENDING_ENTERPRISE_SESSION_TTL_MS = 15_000;
let pendingEnterpriseReviewSessionId: string | null = null;
let pendingEnterpriseReviewSessionCreatedAtMs = 0;
let pendingEnterpriseReviewSessionPromise: Promise<string | null> | null = null;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getSessionStorageKey(sessionId: string) {
  return `enterprise-demo:target-url:${sessionId}`;
}

function formatSessionTitle(title: string | null | undefined) {
  const trimmed = (title || "").trim();
  return trimmed || "Enterprise review";
}

function formatTime(date: Date) {
  try {
    return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  } catch {
    return "";
  }
}

function getConnectorTimeoutMs(type: string) {
  if (type === "browser_task_run") return BROWSER_CONNECTOR_TIMEOUT_MS;
  if (type === "browser_credential_request") return CREDENTIAL_CONNECTOR_TIMEOUT_MS;
  return DEFAULT_CONNECTOR_TIMEOUT_MS;
}

function pickFirstOnlineDevice(messages: Map<string, RelayMessage>, currentId: string | null) {
  if (currentId && messages.has(currentId)) return currentId;
  return Array.from(messages.keys())[0] || null;
}

function mapMessageMetadataFiles(metadata: OrchestratorMessage["metadata"]) {
  const files = Array.isArray(metadata?.files) ? metadata.files : [];
  return files
    .map((file) => (file && typeof file.name === "string" ? file.name : ""))
    .filter(Boolean);
}

function getActiveStatusText(
  isStreaming: boolean,
  streamingContent: string,
  activities: AgentActivity[]
) {
  if (isStreaming && streamingContent.trim()) {
    return streamingContent.trim();
  }
  const runningActivity = [...activities].reverse().find((activity) => activity.status === "running");
  if (!runningActivity) return "";
  const detail = (runningActivity.detail || "").trim();
  return detail || runningActivity.action || "";
}

export function EnterpriseReviewShell({
  brandName,
  logoUrl,
  userEmail,
}: EnterpriseReviewShellProps) {
  const router = useRouter();
  const supabase = getSupabaseBrowserClient();
  const relay = useRelay();

  const relayStatusRef = useRef(relay.status);
  const onlineDevicesRef = useRef<Map<string, RelayMessage>>(new Map());
  const activeDeviceIdRef = useRef<string | null>(null);
  const pendingConnectorRequestsRef = useRef<Map<string, PendingConnectorRequest>>(new Map());
  const filesAgentBootstrapPromiseRef = useRef<Promise<void> | null>(null);
  const autoCreateReviewRef = useRef(false);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const activeReviewSessionIdRef = useRef<string | null>(null);
  const reviewContextLoadIdRef = useRef(0);

  const [activeDeviceId, setActiveDeviceId] = useState<string | null>(null);
  const [targetUrl, setTargetUrl] = useState("");
  const [linkedFilesSessionId, setLinkedFilesSessionId] = useState<string | null>(null);
  const [documents, setDocuments] = useState<EnterpriseDocument[]>([]);
  const [documentsLoading, setDocumentsLoading] = useState(false);
  const [uploadInProgress, setUploadInProgress] = useState(false);
  const [contextError, setContextError] = useState<string | null>(null);
  const [composerValue, setComposerValue] = useState("");

  useEffect(() => {
    relayStatusRef.current = relay.status;
  }, [relay.status]);

  useEffect(() => {
    activeDeviceIdRef.current = activeDeviceId;
  }, [activeDeviceId]);

  const failPendingConnectorRequestsForDevice = useCallback((deviceId: string, errorText: string) => {
    if (!deviceId) return;
    const pending = pendingConnectorRequestsRef.current;
    for (const [requestId, request] of Array.from(pending.entries())) {
      if (request.deviceId !== deviceId) continue;
      clearTimeout(request.timeout);
      request.resolve({ ok: false, error: errorText });
      pending.delete(requestId);
    }
  }, []);

  useEffect(() => {
    if (!relay.subscribe) return;

    return relay.subscribe((msg) => {
      const msgType = typeof msg.type === "string" ? msg.type : "";
      const requestId = typeof msg.request_id === "string" ? msg.request_id : "";

      if (msgType === "device_online") {
        const deviceId = typeof msg.device_id === "string" ? msg.device_id : "";
        if (deviceId) {
          onlineDevicesRef.current.set(deviceId, msg);
          setActiveDeviceId((current) => pickFirstOnlineDevice(onlineDevicesRef.current, current));
        }
      } else if (msgType === "device_offline") {
        const deviceId = typeof msg.device_id === "string" ? msg.device_id : "";
        if (deviceId) {
          onlineDevicesRef.current.delete(deviceId);
          failPendingConnectorRequestsForDevice(
            deviceId,
            "Connector went offline while the request was running."
          );
          setActiveDeviceId((current) => pickFirstOnlineDevice(onlineDevicesRef.current, current));
        }
      }

      if (!requestId) return;
      const pending = pendingConnectorRequestsRef.current.get(requestId);
      if (!pending) return;
      if (msgType === "claude_run_progress") return;

      clearTimeout(pending.timeout);
      pendingConnectorRequestsRef.current.delete(requestId);
      pending.resolve(msg as unknown as { ok: boolean; error?: string; [key: string]: unknown });
    });
  }, [failPendingConnectorRequestsForDevice, relay.subscribe]);

  const ensureActiveDeviceIdReady = useCallback(async () => {
    if (activeDeviceIdRef.current) return activeDeviceIdRef.current;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await sleep(300 + attempt * 100);
      const candidate = pickFirstOnlineDevice(onlineDevicesRef.current, activeDeviceIdRef.current);
      if (candidate) {
        setActiveDeviceId(candidate);
        return candidate;
      }
    }
    return null;
  }, []);

  const handleConnectorExecute = useCallback<ConnectorExecuteCallback>(
    async ({ type, params }) => {
      if (String(relayStatusRef.current) !== "ready") {
        for (let attempt = 0; attempt < 8; attempt += 1) {
          await sleep(250 + attempt * 100);
          if (String(relayStatusRef.current) === "ready") break;
        }
      }

      if (String(relayStatusRef.current) !== "ready") {
        return {
          ok: false,
          error: "Connector not connected. Start the Groovy Connector and refresh the page.",
        };
      }

      const resolvedDeviceId =
        activeDeviceIdRef.current || activeDeviceId || (await ensureActiveDeviceIdReady());
      if (!resolvedDeviceId) {
        return {
          ok: false,
          error: "No online connector device found for this demo user.",
        };
      }

      const connectorParams = { ...(params || {}) };
      const requestId = `enterprise-req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      return new Promise((resolve) => {
        const timeoutMs = getConnectorTimeoutMs(type);
        const timeout = setTimeout(() => {
          pendingConnectorRequestsRef.current.delete(requestId);
          if (type === "browser_task_run") {
            try {
              relay.send({
                type: "browser_task_cancel",
                request_id: `enterprise-cancel-${Date.now()}-${Math.random()
                  .toString(36)
                  .slice(2, 8)}`,
                device_id: resolvedDeviceId,
                target_request_id: requestId,
              });
            } catch {
              // ignore best-effort cancellation
            }
          }
          resolve({
            ok: false,
            error: `Connector request timed out (${Math.round(timeoutMs / 1000)}s).`,
          });
        }, timeoutMs);

        pendingConnectorRequestsRef.current.set(requestId, {
          resolve,
          timeout,
          requestType: type,
          deviceId: resolvedDeviceId,
        });

        const sent = relay.send({
          type,
          request_id: requestId,
          device_id: resolvedDeviceId,
          ...connectorParams,
        });

        if (!sent) {
          clearTimeout(timeout);
          pendingConnectorRequestsRef.current.delete(requestId);
          resolve({
            ok: false,
            error: "Failed to send the request to the connector.",
          });
        }
      });
    },
    [activeDeviceId, ensureActiveDeviceIdReady, relay]
  );

  const orchestrator = useOrchestrator({
    onConnectorExecute: handleConnectorExecute,
  });

  useEffect(() => {
    activeReviewSessionIdRef.current = orchestrator.currentSessionId;
  }, [orchestrator.currentSessionId]);

  const ensureReviewSession = useCallback(async () => {
    if (orchestrator.currentSessionId) return orchestrator.currentSessionId;
    if (pendingEnterpriseReviewSessionPromise) {
      return pendingEnterpriseReviewSessionPromise;
    }

    const pendingAgeMs = pendingEnterpriseReviewSessionCreatedAtMs
      ? Date.now() - pendingEnterpriseReviewSessionCreatedAtMs
      : Number.POSITIVE_INFINITY;
    const hasFreshPendingSessionId =
      !!pendingEnterpriseReviewSessionId &&
      pendingAgeMs >= 0 &&
      pendingAgeMs < PENDING_ENTERPRISE_SESSION_TTL_MS;
    const pendingSessionIdKnownLocally =
      !!pendingEnterpriseReviewSessionId &&
      orchestrator.sessions.some((session) => session.id === pendingEnterpriseReviewSessionId);

    if (
      pendingEnterpriseReviewSessionId &&
      (pendingSessionIdKnownLocally || (hasFreshPendingSessionId && orchestrator.isLoading))
    ) {
      orchestrator.selectSession(pendingEnterpriseReviewSessionId);
      return pendingEnterpriseReviewSessionId;
    }
    if (pendingEnterpriseReviewSessionId) {
      pendingEnterpriseReviewSessionId = null;
      pendingEnterpriseReviewSessionCreatedAtMs = 0;
    }

    const createPromise = (async () => {
      const created = await orchestrator.createSession("Enterprise review");
      if (created) {
        pendingEnterpriseReviewSessionId = created;
        pendingEnterpriseReviewSessionCreatedAtMs = Date.now();
      }
      return created;
    })();

    pendingEnterpriseReviewSessionPromise = createPromise;
    try {
      return await createPromise;
    } finally {
      if (pendingEnterpriseReviewSessionPromise === createPromise) {
        pendingEnterpriseReviewSessionPromise = null;
      }
    }
  }, [
    orchestrator.createSession,
    orchestrator.currentSessionId,
    orchestrator.isLoading,
    orchestrator.selectSession,
    orchestrator.sessions,
  ]);

  useEffect(() => {
    if (orchestrator.currentSessionId || orchestrator.sessions.length > 0) {
      autoCreateReviewRef.current = false;
    }
  }, [orchestrator.currentSessionId, orchestrator.sessions.length]);

  useEffect(() => {
    return () => {
      for (const [requestId, pending] of pendingConnectorRequestsRef.current.entries()) {
        clearTimeout(pending.timeout);
        pending.resolve({ ok: false, error: "cancelled" });
        pendingConnectorRequestsRef.current.delete(requestId);
      }
    };
  }, []);

  useEffect(() => {
    if (orchestrator.isLoading) return;
    if (orchestrator.currentSessionId) return;
    if (orchestrator.sessions.length > 0) return;
    if (autoCreateReviewRef.current) return;
    autoCreateReviewRef.current = true;
    void ensureReviewSession();
  }, [
    orchestrator.currentSessionId,
    orchestrator.isLoading,
    orchestrator.sessions.length,
    ensureReviewSession,
  ]);

  const getLinkedFilesSession = useCallback(
    async (orchestratorSessionId: string, createIfMissing = false) => {
      const ensureDemoFilesAgentExists = async () => {
        if (filesAgentBootstrapPromiseRef.current) {
          await filesAgentBootstrapPromiseRef.current;
          return;
        }

        const bootstrapPromise = (async () => {
          const bootstrap = await fetch("/api/agents", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              type: "files-agent",
              name: "Enterprise Review Files",
            }),
          });
          const bootstrapJson = await bootstrap.json().catch(() => ({}));
          if (!bootstrap.ok) {
            throw new Error(
              typeof bootstrapJson?.error === "string"
                ? bootstrapJson.error
                : "Failed to create the hidden Files agent for this demo."
            );
          }
        })();

        filesAgentBootstrapPromiseRef.current = bootstrapPromise;
        try {
          await bootstrapPromise;
        } finally {
          filesAgentBootstrapPromiseRef.current = null;
        }
      };

      try {
        const lookup = await fetch(
          `/api/orchestrator/agent-sessions?orchestratorSessionId=${encodeURIComponent(
            orchestratorSessionId
          )}&agentType=files`,
          { cache: "no-store" }
        );
        const lookupJson = await lookup.json().catch(() => ({}));
        if (lookup.ok && lookupJson?.session?.agentSessionId) {
          return String(lookupJson.session.agentSessionId);
        }

        if (!createIfMissing) return null;

        const create = await fetch("/api/orchestrator/agent-sessions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            orchestratorSessionId,
            agentType: "files",
          }),
        });
        const createJson = await create.json().catch(() => ({}));
        if (create.ok && createJson?.session?.agentSessionId) {
          return String(createJson.session.agentSessionId);
        }

        const createError =
          typeof createJson?.error === "string" ? createJson.error.toLowerCase() : "";
        if (createIfMissing && createError.includes("no files agent configured")) {
          await ensureDemoFilesAgentExists();

          const retry = await fetch("/api/orchestrator/agent-sessions", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              orchestratorSessionId,
              agentType: "files",
            }),
          });
          const retryJson = await retry.json().catch(() => ({}));
          if (retry.ok && retryJson?.session?.agentSessionId) {
            return String(retryJson.session.agentSessionId);
          }
          throw new Error(
            typeof retryJson?.error === "string"
              ? retryJson.error
              : "Failed to create the hidden files session for this review."
          );
        }
      } catch {
        // ignore lookup errors and let the caller surface a user-facing message
      }
      return null;
    },
    []
  );

  const loadDocumentsForFilesSession = useCallback(async (filesSessionId: string) => {
    const res = await fetch(`/api/chat/messages?sessionId=${encodeURIComponent(filesSessionId)}`, {
      cache: "no-store",
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(typeof json?.error === "string" ? json.error : "Failed to load documents");
    }

    const attachments = Array.isArray(json?.attachments) ? json.attachments : [];
    return attachments.map((attachment: Record<string, unknown>) => ({
      id: typeof attachment.id === "string" ? attachment.id : "",
      fileName: typeof attachment.file_name === "string" ? attachment.file_name : "upload",
      mimeType:
        typeof attachment.mime_type === "string"
          ? attachment.mime_type
          : "application/octet-stream",
      sizeBytes: Number(attachment.size_bytes || 0),
      createdAt: typeof attachment.created_at === "string" ? attachment.created_at : undefined,
    })) as EnterpriseDocument[];
  }, []);

  const loadReviewContext = useCallback(
    async (orchestratorSessionId: string) => {
      const loadId = ++reviewContextLoadIdRef.current;
      setDocumentsLoading(true);
      setContextError(null);

      try {
        const nextTargetUrl =
          typeof window !== "undefined"
            ? window.localStorage.getItem(getSessionStorageKey(orchestratorSessionId)) || ""
            : "";
        setTargetUrl(nextTargetUrl);

        const filesSessionId = await getLinkedFilesSession(orchestratorSessionId, false);
        if (reviewContextLoadIdRef.current !== loadId) return;
        setLinkedFilesSessionId(filesSessionId);
        if (!filesSessionId) {
          setDocuments([]);
          return;
        }

        const nextDocuments = await loadDocumentsForFilesSession(filesSessionId);
        if (reviewContextLoadIdRef.current !== loadId) return;
        setDocuments(nextDocuments);
      } catch (error) {
        if (reviewContextLoadIdRef.current !== loadId) return;
        setDocuments([]);
        setContextError(error instanceof Error ? error.message : "Failed to load review context");
      } finally {
        if (reviewContextLoadIdRef.current !== loadId) return;
        setDocumentsLoading(false);
      }
    },
    [getLinkedFilesSession, loadDocumentsForFilesSession]
  );

  useEffect(() => {
    const sessionId = orchestrator.currentSessionId;
    if (!sessionId) {
      reviewContextLoadIdRef.current += 1;
      setTargetUrl("");
      setLinkedFilesSessionId(null);
      setDocuments([]);
      setDocumentsLoading(false);
      return;
    }
    void loadReviewContext(sessionId);
  }, [loadReviewContext, orchestrator.currentSessionId]);

  useEffect(() => {
    const sessionId = orchestrator.currentSessionId;
    if (!sessionId || typeof window === "undefined") return;
    window.localStorage.setItem(getSessionStorageKey(sessionId), targetUrl);
  }, [orchestrator.currentSessionId, targetUrl]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [orchestrator.messages, orchestrator.streamingContent]);

  const handleUploadFiles = useCallback(
    async (files: File[]) => {
      if (files.length === 0) return;
      let orchestratorSessionId: string | null = null;
      setUploadInProgress(true);
      setContextError(null);

      try {
        orchestratorSessionId = await ensureReviewSession();
        if (!orchestratorSessionId) {
          throw new Error("Failed to create a review session before uploading.");
        }

        const filesSessionId =
          linkedFilesSessionId || (await getLinkedFilesSession(orchestratorSessionId, true));
        if (!filesSessionId) {
          throw new Error("Failed to create the hidden files session for this review.");
        }

        if (activeReviewSessionIdRef.current === orchestratorSessionId) {
          setLinkedFilesSessionId(filesSessionId);
        }

        let firstUploadError: string | null = null;
        for (const file of files) {
          const formData = new FormData();
          formData.set("sessionId", filesSessionId);
          formData.set("file", file);

          const res = await fetch("/api/chat/files", {
            method: "POST",
            body: formData,
          });
          const json = await res.json().catch(() => ({}));
          if (!res.ok && !firstUploadError) {
            firstUploadError =
              typeof json?.error === "string" ? json.error : `Failed to upload ${file.name}`;
          }
        }

        const nextDocuments = await loadDocumentsForFilesSession(filesSessionId);
        if (activeReviewSessionIdRef.current === orchestratorSessionId) {
          setDocuments(nextDocuments);
        }

        if (firstUploadError && activeReviewSessionIdRef.current === orchestratorSessionId) {
          setContextError(firstUploadError);
        }
      } catch (error) {
        if (
          orchestratorSessionId &&
          activeReviewSessionIdRef.current &&
          activeReviewSessionIdRef.current !== orchestratorSessionId
        ) {
          return;
        }
        setContextError(error instanceof Error ? error.message : "Failed to upload documents");
      } finally {
        setUploadInProgress(false);
      }
    },
    [ensureReviewSession, getLinkedFilesSession, linkedFilesSessionId, loadDocumentsForFilesSession]
  );

  const handleSend = useCallback(async () => {
    const message = composerValue.trim();
    if (!message || orchestrator.isStreaming) return;

    setComposerValue("");
    setContextError(null);

    const sessionId = await ensureReviewSession();
    if (!sessionId) {
      setComposerValue(message);
      setContextError("Failed to create a review session.");
      return;
    }

    const messageMetadata: Record<string, unknown> = {
      enterprise_demo: true,
    };
    const trimmedTargetUrl = targetUrl.trim();
    if (trimmedTargetUrl) {
      messageMetadata.enterprise_target_url = trimmedTargetUrl;
    }
    if (linkedFilesSessionId) {
      messageMetadata.enterprise_files_session_id = linkedFilesSessionId;
    }

    await orchestrator.sendMessage(message, {
      deviceId: activeDeviceId || undefined,
      messageMetadata,
      sessionIdOverride: sessionId,
    });
  }, [
    activeDeviceId,
    composerValue,
    ensureReviewSession,
    linkedFilesSessionId,
    orchestrator,
    targetUrl,
  ]);

  const handleComposerKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key !== "Enter" || event.shiftKey) return;
      event.preventDefault();
      void handleSend();
    },
    [handleSend]
  );

  const handleNewReview = useCallback(async () => {
    setContextError(null);
    setComposerValue("");
    await orchestrator.createSession("Enterprise review");
  }, [orchestrator]);

  const handleSignOut = useCallback(async () => {
    pendingEnterpriseReviewSessionId = null;
    pendingEnterpriseReviewSessionCreatedAtMs = 0;
    pendingEnterpriseReviewSessionPromise = null;
    await supabase.auth.signOut();
    router.push("/login");
  }, [router, supabase.auth]);

  const connectorReady = relay.status === "ready" && !!activeDeviceId;
  const sessionTitle = useMemo(() => {
    const current = orchestrator.sessions.find((session) => session.id === orchestrator.currentSessionId);
    return formatSessionTitle(current?.title);
  }, [orchestrator.currentSessionId, orchestrator.sessions]);
  const activeStatusText = getActiveStatusText(
    orchestrator.isStreaming,
    orchestrator.streamingContent,
    orchestrator.agentActivities
  );
  const sessionPickerSessions = useMemo(
    () =>
      orchestrator.sessions.map((session) => ({
        id: session.id,
        title: session.title,
        created_at: session.createdAt,
        updated_at: session.updatedAt,
      })),
    [orchestrator.sessions]
  );

  return (
    <div className="h-screen bg-zinc-950 text-white">
      <div className="flex h-full flex-col">
        <header className="relative z-20 border-b border-white/10 bg-zinc-950/90 backdrop-blur-xl">
          <div className="mx-auto flex max-w-[1600px] items-center justify-between gap-4 px-6 py-4">
            <div className="flex items-center gap-4">
              {logoUrl ? (
                <img
                  src={logoUrl}
                  alt={brandName}
                  className="h-12 w-auto max-w-[220px] object-contain invert brightness-200"
                />
              ) : (
                <div className="flex h-12 items-center rounded-2xl border border-cyan-400/20 bg-cyan-500/10 px-4 text-sm font-semibold text-cyan-200">
                  {brandName}
                </div>
              )}
            </div>

            <div className="flex items-center gap-3">
              <SessionPicker
                sessions={sessionPickerSessions}
                activeSessionId={orchestrator.currentSessionId}
                onSelect={(sessionId) => orchestrator.selectSession(sessionId)}
                onNew={() => {
                  void handleNewReview();
                }}
              />

              <button
                type="button"
                onClick={() => relay.reconnect()}
                className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-zinc-200 transition hover:bg-white/10"
                title="Reconnect relay"
              >
                <RefreshCw className="h-4 w-4" />
                {connectorReady ? "Reconnect" : "Refresh"}
              </button>

              <div
                className={`inline-flex items-center gap-2 rounded-xl border px-3 py-2 text-sm ${
                  connectorReady
                    ? "border-emerald-400/20 bg-emerald-500/10 text-emerald-200"
                    : "border-amber-400/20 bg-amber-500/10 text-amber-200"
                }`}
              >
                {connectorReady ? <Wifi className="h-4 w-4" /> : <WifiOff className="h-4 w-4" />}
                <span>{connectorReady ? "Connector ready" : "Connector offline"}</span>
              </div>

              <button
                type="button"
                onClick={handleSignOut}
                className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-zinc-200 transition hover:bg-white/10"
              >
                <LogOut className="h-4 w-4" />
                Sign out
              </button>
            </div>
          </div>
        </header>

        <main className="mx-auto flex min-h-0 w-full max-w-[1600px] flex-1 gap-4 p-4">
          <EnterpriseContextPanel
            targetUrl={targetUrl}
            onTargetUrlChange={setTargetUrl}
            documents={documents}
            documentsLoading={documentsLoading}
            uploadInProgress={uploadInProgress}
            sessionTitle={sessionTitle}
            contextError={contextError}
            connectorReady={connectorReady}
            onUploadFiles={handleUploadFiles}
            onStartNewReview={() => {
              void handleNewReview();
            }}
          />

          <section className="flex min-w-0 flex-1 flex-col rounded-3xl border border-white/10 bg-zinc-950/80 backdrop-blur-xl overflow-hidden">
            <div className="border-b border-white/10 px-6 py-4">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <div className="flex items-center gap-2 text-sm font-medium text-zinc-200">
                    <Sparkles className="h-4 w-4 text-cyan-300" />
                    Main chat
                  </div>
                  <p className="mt-1 text-sm text-zinc-500">
                    Ask the assistant to inspect the page and compare what it finds against the
                    uploaded documents.
                  </p>
                </div>
                <div className="text-right text-xs text-zinc-500">
                  <div>{userEmail || "Enterprise demo user"}</div>
                  <div>{sessionTitle}</div>
                </div>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto px-6 py-5">
              <div className="mx-auto flex max-w-4xl flex-col gap-4">
                {orchestrator.messages.length === 0 && !orchestrator.isStreaming && (
                  <div className="rounded-3xl border border-dashed border-white/10 bg-white/5 px-6 py-8 text-center">
                    <div className="text-lg font-semibold text-white">Start the review conversation</div>
                    <p className="mt-2 text-sm text-zinc-500">
                      Example: Compare the pricing table on the target page against the uploaded
                      spreadsheet and call out every mismatch.
                    </p>
                  </div>
                )}

                {orchestrator.messages.map((message) => {
                  const attachmentNames = mapMessageMetadataFiles(message.metadata);
                  const isUser = message.role === "user";
                  return (
                    <div
                      key={message.id}
                      className={`flex ${isUser ? "justify-end" : "justify-start"}`}
                    >
                      <div
                        className={`max-w-[85%] rounded-3xl px-5 py-4 ${
                          isUser
                            ? "bg-cyan-500 text-black"
                            : "border border-white/10 bg-white/5 text-zinc-100"
                        }`}
                      >
                        <div className="whitespace-pre-wrap break-words text-sm leading-6">
                          {message.content}
                        </div>
                        {attachmentNames.length > 0 && (
                          <div
                            className={`mt-3 text-xs ${
                              isUser ? "text-black/70" : "text-zinc-400"
                            }`}
                          >
                            Files: {attachmentNames.join(", ")}
                          </div>
                        )}
                        <div
                          className={`mt-3 text-[11px] ${
                            isUser ? "text-black/60" : "text-zinc-500"
                          }`}
                        >
                          {formatTime(message.timestamp)}
                        </div>
                      </div>
                    </div>
                  );
                })}

                {orchestrator.isStreaming && (
                  <div className="flex justify-start">
                    <div className="max-w-[85%] rounded-3xl border border-white/10 bg-white/5 px-5 py-4 text-zinc-100">
                      <div className="whitespace-pre-wrap break-words text-sm leading-6">
                        {orchestrator.streamingContent || "Working..."}
                      </div>
                    </div>
                  </div>
                )}

                <div ref={messagesEndRef} />
              </div>
            </div>

            <div className="border-t border-white/10 px-6 py-4">
              {activeStatusText && (
                <div className="mb-3 flex items-center gap-2 rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-zinc-300">
                  {orchestrator.isStreaming ? (
                    <Loader2 className="h-4 w-4 animate-spin text-cyan-300" />
                  ) : (
                    <Sparkles className="h-4 w-4 text-cyan-300" />
                  )}
                  <span className="truncate">{activeStatusText}</span>
                </div>
              )}

              {orchestrator.error && !orchestrator.isStreaming && (
                <div className="mb-3 rounded-2xl border border-red-400/20 bg-red-500/10 px-4 py-3 text-sm text-red-200">
                  {orchestrator.error}
                </div>
              )}

              <div className="rounded-3xl border border-white/10 bg-black/20 px-4 py-4">
                <textarea
                  value={composerValue}
                  onChange={(event) => setComposerValue(event.target.value)}
                  onKeyDown={handleComposerKeyDown}
                  rows={4}
                  disabled={orchestrator.isStreaming}
                  placeholder="Ask the assistant to inspect the page and compare it against the uploaded documents..."
                  className="w-full resize-none bg-transparent text-sm leading-6 text-white outline-none placeholder:text-zinc-500 disabled:opacity-60"
                />
                <div className="mt-4 flex items-center justify-between gap-3">
                  <div className="text-xs text-zinc-500">
                    Press Enter to send. Use Shift+Enter for a new line.
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      void handleSend();
                    }}
                    disabled={!composerValue.trim() || orchestrator.isStreaming}
                    className="inline-flex items-center gap-2 rounded-2xl bg-cyan-500 px-4 py-2.5 text-sm font-medium text-black transition hover:bg-cyan-400 disabled:cursor-not-allowed disabled:bg-zinc-800 disabled:text-zinc-500"
                  >
                    <Send className="h-4 w-4" />
                    Send
                  </button>
                </div>
              </div>
            </div>
          </section>
        </main>
      </div>
    </div>
  );
}
