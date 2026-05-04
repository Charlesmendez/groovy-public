"use client";

import { useEffect, useMemo, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import type { RelayMessage } from "@/hooks/useRelay";

// Batch input to reduce round-trips (improves perceived latency)
const INPUT_BATCH_MS = 16; // ~60fps, feels instant but batches rapid typing
const WEBRTC_CONNECT_TIMEOUT_MS = 8000;

const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
  { urls: ["stun:stun.l.google.com:19302"] },
];

export function TerminalView({
  terminalId,
  send,
  subscribe,
  className,
  onActivity,
}: {
  terminalId: string;
  send: (msg: RelayMessage) => void;
  subscribe: (handler: (msg: RelayMessage) => void) => () => void;
  className?: string;
  onActivity?: (evt: { type: "input" | "output" | "closed"; data?: string }) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const inputBufferRef = useRef<string>("");
  const inputTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const webrtcIdRef = useRef<string | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);
  const webrtcOpenRef = useRef(false);

  const resize = useMemo(() => {
    return () => {
      const term = terminalRef.current;
      const fit = fitRef.current;
      if (!term || !fit) return;
      try {
        fit.fit();
      } catch {
        // ignore
      }
      send({
        type: "terminal_resize",
        terminal_id: terminalId,
        cols: term.cols,
        rows: term.rows,
      });
    };
  }, [send, terminalId]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const term = new Terminal({
      convertEol: true,
      cursorBlink: true,
      fontFamily:
        'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
      fontSize: 12,
      theme: {
        background: "#000000",
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);

    terminalRef.current = term;
    fitRef.current = fit;

    // initial fit + size publish
    resize();

    const sendInput = (data: string) => {
      const dc = dcRef.current;
      if (dc && dc.readyState === "open") {
        try {
          dc.send(data);
          return;
        } catch {
          // fall through to relay
        }
      }
      send({ type: "terminal_input", terminal_id: terminalId, data });
    };

    // Batched input: accumulate keystrokes and flush after a short delay.
    // This reduces WebSocket messages and improves perceived latency.
    const flushInput = () => {
      const data = inputBufferRef.current;
      if (!data) return;
      inputBufferRef.current = "";
      inputTimerRef.current = null;
      try {
        onActivity?.({ type: "input", data });
      } catch {
        // ignore
      }
      sendInput(data);
    };

    const dataDisposable = term.onData((data) => {
      inputBufferRef.current += data;

      // Flush immediately for special keys (Enter, Ctrl+C, etc.)
      // These need immediate response for good UX
      const isSpecial = data.includes("\r") || data.includes("\n") || data.charCodeAt(0) < 32;
      if (isSpecial) {
        if (inputTimerRef.current) {
          clearTimeout(inputTimerRef.current);
          inputTimerRef.current = null;
        }
        flushInput();
        return;
      }

      // Batch normal typing
      if (!inputTimerRef.current) {
        inputTimerRef.current = setTimeout(flushInput, INPUT_BATCH_MS);
      }
    });

    const unsubscribe = subscribe((msg) => {
      if (msg.type === "terminal_backlog" && msg.terminal_id === terminalId) {
        const data = String(msg.data || "");
        if (data) {
          term.write(data);
          try {
            onActivity?.({ type: "output", data });
          } catch {
            // ignore
          }
        }
        return;
      }

      // WebRTC signaling (relay -> browser)
      if (msg.type === "webrtc_answer" && msg.terminal_id === terminalId) {
        const webrtcId = String(msg.webrtc_id || "");
        if (!webrtcId || webrtcId !== webrtcIdRef.current) return;
        const sdp = String(msg.sdp || "");
        const sdpType = String(msg.sdp_type || "answer");
        if (!sdp || sdpType !== "answer") return;
        const pc = pcRef.current;
        if (!pc) return;
        pc.setRemoteDescription({ type: "answer", sdp }).catch(() => {});
        return;
      }

      if (msg.type === "webrtc_ice" && msg.terminal_id === terminalId) {
        const webrtcId = String(msg.webrtc_id || "");
        if (!webrtcId || webrtcId !== webrtcIdRef.current) return;
        const pc = pcRef.current;
        if (!pc) return;
        const cand = msg.candidate as RTCIceCandidateInit | undefined;
        if (!cand) return;
        pc.addIceCandidate(cand).catch(() => {});
        return;
      }

      if (msg.type === "webrtc_error" && msg.terminal_id === terminalId) {
        const webrtcId = String(msg.webrtc_id || "");
        if (webrtcId && webrtcIdRef.current && webrtcId !== webrtcIdRef.current) return;
        webrtcOpenRef.current = false;
        try {
          dcRef.current?.close();
        } catch {
          // ignore
        }
        try {
          pcRef.current?.close();
        } catch {
          // ignore
        }
        dcRef.current = null;
        pcRef.current = null;
        webrtcIdRef.current = null;
        return;
      }

      if (msg.type === "terminal_data" && msg.terminal_id === terminalId) {
        // If WebRTC is active, ignore relay output to avoid duplicates.
        if (webrtcOpenRef.current) return;
        const data = String(msg.data || "");
        try {
          onActivity?.({ type: "output", data });
        } catch {
          // ignore
        }
        term.write(data);
      }
      if (msg.type === "terminal_closed" && msg.terminal_id === terminalId) {
        webrtcOpenRef.current = false;
        try {
          dcRef.current?.close();
        } catch {
          // ignore
        }
        try {
          pcRef.current?.close();
        } catch {
          // ignore
        }
        dcRef.current = null;
        pcRef.current = null;
        webrtcIdRef.current = null;
        try {
          onActivity?.({ type: "closed" });
        } catch {
          // ignore
        }
        term.write("\r\n[terminal closed]\r\n");
      }
    });

    // Subscribe after handler is registered so we don't miss backlog messages.
    send({ type: "terminal_subscribe", terminal_id: terminalId });

    // Attempt WebRTC DataChannel for low-latency terminal I/O (falls back to relay)
    let webrtcCancelled = false;
    let webrtcTimeout: ReturnType<typeof setTimeout> | null = null;
    const startWebRTC = async () => {
      if (typeof RTCPeerConnection === "undefined") return;

      const webrtcId = crypto.randomUUID();
      webrtcIdRef.current = webrtcId;

      const pc = new RTCPeerConnection({ iceServers: DEFAULT_ICE_SERVERS });
      pcRef.current = pc;

      const dc = pc.createDataChannel("terminal", { ordered: true });
      dcRef.current = dc;

      dc.onopen = () => {
        webrtcOpenRef.current = true;
        send({ type: "webrtc_connected", terminal_id: terminalId, webrtc_id: webrtcId });
        if (webrtcTimeout) {
          clearTimeout(webrtcTimeout);
          webrtcTimeout = null;
        }
      };

      dc.onmessage = (evt) => {
        if (webrtcCancelled) return;
        const data = typeof evt.data === "string" ? evt.data : String(evt.data || "");
        if (!data) return;
        try {
          onActivity?.({ type: "output", data });
        } catch {
          // ignore
        }
        term.write(data);
      };

      dc.onclose = () => {
        webrtcOpenRef.current = false;
        send({ type: "webrtc_disconnected", terminal_id: terminalId, webrtc_id: webrtcId });
      };

      pc.onicecandidate = (evt) => {
        if (webrtcCancelled) return;
        const c = evt.candidate;
        if (!c) return;
        const candidate = typeof c.toJSON === "function" ? c.toJSON() : {
          candidate: c.candidate,
          sdpMid: c.sdpMid,
          sdpMLineIndex: c.sdpMLineIndex,
          usernameFragment: (c as unknown as { usernameFragment?: string }).usernameFragment,
        };
        send({
          type: "webrtc_ice",
          terminal_id: terminalId,
          webrtc_id: webrtcId,
          candidate,
        });
      };

      pc.onconnectionstatechange = () => {
        if (webrtcCancelled) return;
        if (pc.connectionState === "failed" || pc.connectionState === "disconnected") {
          webrtcOpenRef.current = false;
        }
      };

      webrtcTimeout = setTimeout(() => {
        if (webrtcCancelled) return;
        if (webrtcOpenRef.current) return;
        // Give up quietly and stay on relay transport.
        send({ type: "webrtc_disconnected", terminal_id: terminalId, webrtc_id: webrtcId });
        try {
          dc.close();
        } catch {}
        try {
          pc.close();
        } catch {}
        dcRef.current = null;
        pcRef.current = null;
        webrtcIdRef.current = null;
      }, WEBRTC_CONNECT_TIMEOUT_MS);

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      send({
        type: "webrtc_offer",
        terminal_id: terminalId,
        webrtc_id: webrtcId,
        sdp: offer.sdp,
        sdp_type: offer.type,
      });
    };

    startWebRTC().catch(() => {});

    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(() => resize());
      ro.observe(el);
    } else {
      window.addEventListener("resize", resize);
    }

    return () => {
      webrtcCancelled = true;
      if (webrtcTimeout) {
        clearTimeout(webrtcTimeout);
        webrtcTimeout = null;
      }
      webrtcOpenRef.current = false;
      if (webrtcIdRef.current) {
        send({
          type: "webrtc_disconnected",
          terminal_id: terminalId,
          webrtc_id: webrtcIdRef.current,
        });
      }
      try {
        dcRef.current?.close();
      } catch {
        // ignore
      }
      try {
        pcRef.current?.close();
      } catch {
        // ignore
      }
      dcRef.current = null;
      pcRef.current = null;
      webrtcIdRef.current = null;

      // Flush any pending input before cleanup
      if (inputTimerRef.current) {
        clearTimeout(inputTimerRef.current);
        inputTimerRef.current = null;
      }
      if (inputBufferRef.current) {
        sendInput(inputBufferRef.current);
        inputBufferRef.current = "";
      }

      unsubscribe();
      dataDisposable.dispose();
      try {
        ro?.disconnect();
      } catch {
        // ignore
      }
      window.removeEventListener("resize", resize);
      // Intentionally do not send terminal_unsubscribe so the PTY session stays alive
      // while the panel is not visible. The relay will clean up on websocket close.
      try {
        term.dispose();
      } catch {
        // ignore
      }
      terminalRef.current = null;
      fitRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onActivity, terminalId]);

  return (
    <div
      ref={containerRef}
      className={
        className ||
        "h-full min-h-0 w-full rounded-2xl border border-white/10 bg-black/70 overflow-hidden"
      }
    />
  );
}

