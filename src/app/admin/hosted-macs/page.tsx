"use client";

import { useEffect, useState } from "react";
import { Loader2, Server, CheckCircle2 } from "lucide-react";

type HostedMacRequest = {
  id: string;
  workspace_id: string;
  requested_by_user_id: string;
  status: string;
  requested_provider?: string | null;
  requested_region?: string | null;
  notes?: string | null;
  created_at: string;
};

type HostedMacAssignment = {
  id: string;
  request_id: string;
  provider: string;
  hostname: string;
  ssh_port: number;
  ssh_user: string;
  created_at: string;
  updated_at: string;
};

export default function HostedMacAdminPage() {
  const [loading, setLoading] = useState(true);
  const [requests, setRequests] = useState<HostedMacRequest[]>([]);
  const [assignments, setAssignments] = useState<HostedMacAssignment[]>([]);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [bootstrappingId, setBootstrappingId] = useState<string | null>(null);
  const [generatingCodeId, setGeneratingCodeId] = useState<string | null>(null);
  const [pairingCodes, setPairingCodes] = useState<Record<string, string>>({});

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const res = await fetch("/api/admin/hosted-macs", { cache: "no-store" });
        const json = await res.json().catch(() => ({}));
        if (res.ok) {
          setRequests(Array.isArray(json.requests) ? json.requests : []);
          setAssignments(Array.isArray(json.assignments) ? json.assignments : []);
        }
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const saveAssignment = async (requestId: string, data: Record<string, unknown>) => {
    setSavingId(requestId);
    try {
      await fetch("/api/admin/hosted-macs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ request_id: requestId, ...data }),
      });
    } finally {
      setSavingId(null);
    }
  };

  const bootstrap = async (requestId: string, pairingCode?: string, enableWhatsapp?: boolean) => {
    setBootstrappingId(requestId);
    try {
      const res = await fetch("/api/admin/hosted-macs/bootstrap", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          request_id: requestId,
          pairing_code: pairingCode || "",
          enable_whatsapp: enableWhatsapp || false,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        alert(`Bootstrap failed: ${json.error || "unknown error"}`);
      } else {
        alert("Bootstrap completed!");
      }
    } finally {
      setBootstrappingId(null);
    }
  };

  const getAssignment = (requestId: string) =>
    assignments.find((a) => a.request_id === requestId) || null;

  const generatePairingCode = async (requestId: string) => {
    setGeneratingCodeId(requestId);
    try {
      const res = await fetch("/api/admin/hosted-macs/pairing-code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ request_id: requestId }),
      });
      const json = await res.json().catch(() => ({}));
      if (res.ok && json.code) {
        setPairingCodes((prev) => ({ ...prev, [requestId]: json.code }));
        // Auto-fill the pairing code input
        const card = document.querySelector(`[data-request-id="${requestId}"]`);
        if (card) {
          const input = card.querySelector('input[name="pairing_code"]') as HTMLInputElement;
          if (input) input.value = json.code;
        }
      } else {
        alert(`Failed to generate code: ${json.error || "unknown error"}`);
      }
    } finally {
      setGeneratingCodeId(null);
    }
  };

  if (loading) {
    return (
      <div className="app-scroll-page bg-zinc-950 text-white flex items-center justify-center">
        <Loader2 className="w-6 h-6 animate-spin text-cyan-400" />
      </div>
    );
  }

  return (
    <div className="app-scroll-page bg-zinc-950 text-white p-6">
      <div className="max-w-5xl mx-auto">
        <div className="flex items-center gap-3 mb-6">
          <div className="w-10 h-10 rounded-xl bg-cyan-500/10 border border-cyan-500/20 flex items-center justify-center">
            <Server className="w-5 h-5 text-cyan-300" />
          </div>
          <div>
            <h1 className="text-xl font-semibold">Groovy Mac Admin</h1>
            <p className="text-sm text-zinc-500">Provisioning queue & credentials</p>
          </div>
        </div>

        <div className="space-y-4">
          {requests.length === 0 && (
            <div className="text-sm text-zinc-500">No requests yet.</div>
          )}
          {requests.map((req) => {
            const assignment = getAssignment(req.id);
            return (
              <div key={req.id} data-request-id={req.id} className="rounded-2xl border border-white/10 bg-zinc-900/60 p-5">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-sm text-white font-medium">
                      Request {req.id.slice(0, 8)}
                    </div>
                    <div className="text-xs text-zinc-500 mt-1">
                      Workspace {req.workspace_id.slice(0, 8)} · Status: {req.status}
                    </div>
                  </div>
                  {assignment && (
                    <div className="text-xs text-emerald-300 flex items-center gap-1">
                      <CheckCircle2 className="w-4 h-4" />
                      Credentials saved
                    </div>
                  )}
                </div>

                <div className="grid md:grid-cols-2 gap-4 mt-4">
                  <div className="space-y-2">
                    <div className="text-xs text-zinc-500">Provider</div>
                    <input
                      defaultValue={assignment?.provider || req.requested_provider || ""}
                      name="provider"
                      className="w-full px-3 py-2 rounded-lg bg-black/40 border border-white/10 text-xs"
                    />
                    <div className="text-xs text-zinc-500">Hostname</div>
                    <input
                      defaultValue={assignment?.hostname || ""}
                      name="hostname"
                      className="w-full px-3 py-2 rounded-lg bg-black/40 border border-white/10 text-xs"
                    />
                    <div className="text-xs text-zinc-500">Pairing code</div>
                    <div className="flex gap-2">
                      <input
                        name="pairing_code"
                        placeholder="XXXX-XXXX-XXXX-XXXX"
                        defaultValue={pairingCodes[req.id] || ""}
                        className="flex-1 px-3 py-2 rounded-lg bg-black/40 border border-white/10 text-xs font-mono"
                      />
                      <button
                        type="button"
                        disabled={generatingCodeId === req.id}
                        onClick={() => generatePairingCode(req.id)}
                        className="px-3 py-2 rounded-lg bg-purple-500/20 border border-purple-500/30 text-purple-200 text-xs whitespace-nowrap disabled:opacity-50"
                      >
                        {generatingCodeId === req.id ? "…" : "Generate"}
                      </button>
                    </div>
                    <div className="text-xs text-zinc-500">Device ID (after pairing)</div>
                    <input
                      name="device_id"
                      placeholder="uuid"
                      className="w-full px-3 py-2 rounded-lg bg-black/40 border border-white/10 text-xs"
                    />
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <div className="text-xs text-zinc-500">SSH user</div>
                        <input
                          defaultValue={assignment?.ssh_user || ""}
                          name="ssh_user"
                          className="w-full px-3 py-2 rounded-lg bg-black/40 border border-white/10 text-xs"
                        />
                      </div>
                      <div>
                        <div className="text-xs text-zinc-500">SSH port</div>
                        <input
                          defaultValue={assignment?.ssh_port || 22}
                          name="ssh_port"
                          className="w-full px-3 py-2 rounded-lg bg-black/40 border border-white/10 text-xs"
                        />
                      </div>
                    </div>
                  </div>
                  <div className="space-y-2">
                    <div className="text-xs text-zinc-500">SSH private key</div>
                    <textarea
                      name="ssh_private_key"
                      placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                      className="w-full h-28 px-3 py-2 rounded-lg bg-black/40 border border-white/10 text-xs font-mono"
                    />
                    <div className="text-xs text-zinc-500">SSH password (optional)</div>
                    <input
                      name="ssh_password"
                      type="password"
                      className="w-full px-3 py-2 rounded-lg bg-black/40 border border-white/10 text-xs"
                    />
                    <label className="flex items-center gap-2 mt-2">
                      <input type="checkbox" name="enable_whatsapp" className="rounded" />
                      <span className="text-xs text-zinc-400">Enable WhatsApp Web</span>
                    </label>
                  </div>
                </div>

                <div className="mt-4 flex flex-wrap gap-2">
                  <button
                    type="button"
                    disabled={savingId === req.id}
                    onClick={(e) => {
                      const card = (e.currentTarget.closest(".rounded-2xl") as HTMLElement) || null;
                      if (!card) return;
                      const inputs = card.querySelectorAll("input,textarea") as NodeListOf<
                        HTMLInputElement | HTMLTextAreaElement
                      >;
                      const payload: Record<string, unknown> = {};
                      inputs.forEach((el) => {
                        payload[el.name] = el.value;
                      });
                      saveAssignment(req.id, payload);
                    }}
                    className="px-4 py-2 rounded-lg bg-cyan-500/20 border border-cyan-500/30 text-cyan-200 text-xs disabled:opacity-50"
                  >
                    {savingId === req.id ? "Saving…" : "Save credentials"}
                  </button>
                  <button
                    type="button"
                    disabled={bootstrappingId === req.id}
                    onClick={(e) => {
                      const card = (e.currentTarget.closest(".rounded-2xl") as HTMLElement) || null;
                      if (!card) return;
                      const pairingInput = card.querySelector('input[name="pairing_code"]') as HTMLInputElement;
                      const whatsappInput = card.querySelector('input[name="enable_whatsapp"]') as HTMLInputElement;
                      bootstrap(req.id, pairingInput?.value || "", whatsappInput?.checked || false);
                    }}
                    className="px-4 py-2 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-emerald-200 text-xs disabled:opacity-50"
                  >
                    {bootstrappingId === req.id ? "Bootstrapping…" : "Run bootstrap"}
                  </button>
                  <button
                    type="button"
                    onClick={() => saveAssignment(req.id, { mark_status: "bootstrapping" })}
                    className="px-4 py-2 rounded-lg bg-white/5 border border-white/10 text-zinc-300 text-xs"
                  >
                    Mark bootstrapping
                  </button>
                  <button
                    type="button"
                    onClick={() => saveAssignment(req.id, { mark_status: "ready" })}
                    className="px-4 py-2 rounded-lg bg-emerald-500/20 border border-emerald-500/30 text-emerald-200 text-xs"
                  >
                    Mark ready
                  </button>
                  <button
                    type="button"
                    onClick={() => saveAssignment(req.id, { mark_status: "connector_online" })}
                    className="px-4 py-2 rounded-lg bg-cyan-500/20 border border-cyan-500/30 text-cyan-200 text-xs"
                  >
                    Mark online
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
