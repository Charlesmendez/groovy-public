"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Headphones,
  Loader2,
  Maximize2,
  Mic,
  MicOff,
  Minimize2,
  MonitorUp,
  PhoneOff,
  PictureInPicture2,
  UsersRound,
  Video,
  VideoOff,
  X,
} from "lucide-react";
import { createPortal } from "react-dom";
import { getSupabaseBrowserClient } from "@/lib/supabase/browser";
import { ChatMemberAvatar } from "@/components/chat/ChatMemberAvatar";
import {
  canExpandHuddleScreenShare,
  huddleVideoObjectFit,
} from "@/lib/chat/huddleMedia";
import type {
  ChatHuddle,
  ChatHuddleParticipant,
  ChatMemberPresence,
  ChatMemberProfile,
} from "@/lib/chat/social";
import {
  chatHuddlePeerPlan,
  mergeChatHuddleParticipant,
} from "@/lib/chat/social";

type HuddleSignal = {
  id: string;
  huddle_id: string;
  channel_id: string;
  sender_user_id: string;
  recipient_user_id: string;
  signal_type: "offer" | "answer" | "ice";
  payload: Record<string, unknown>;
  created_at: string;
};

type PeerState = {
  connection: RTCPeerConnection;
  makingOffer: boolean;
  ignoreOffer: boolean;
  pendingCandidates: RTCIceCandidateInit[];
};

const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
  {
    urls: [
      "stun:stun.l.google.com:19302",
      "stun:stun1.l.google.com:19302",
    ],
  },
];
const HUDDLE_RECONCILE_INTERVAL_MS = 2_500;

function HuddleMediaTile({
  stream,
  muted,
  label,
  profile,
  presence,
  userId,
  cameraOn,
  screenSharing,
}: {
  stream: MediaStream | null;
  muted: boolean;
  label: string;
  profile?: ChatMemberProfile | null;
  presence?: ChatMemberPresence | null;
  userId: string;
  cameraOn: boolean;
  screenSharing: boolean;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const expandedVideoRef = useRef<HTMLVideoElement>(null);
  const [expanded, setExpanded] = useState(false);
  const hasVideo = Boolean(stream?.getVideoTracks().length);
  const canExpand = canExpandHuddleScreenShare({
    hasVideo,
    screenSharing,
  });

  useEffect(() => {
    if (videoRef.current) videoRef.current.srcObject = stream;
  }, [stream]);

  useEffect(() => {
    if (expandedVideoRef.current) {
      expandedVideoRef.current.srcObject = stream;
    }
  }, [expanded, stream]);

  useEffect(() => {
    if (!expanded) return;
    const previousBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setExpanded(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.body.style.overflow = previousBodyOverflow;
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [expanded]);

  useEffect(() => {
    if (canExpand || !expanded) return;
    const frame = window.requestAnimationFrame(() => setExpanded(false));
    return () => window.cancelAnimationFrame(frame);
  }, [canExpand, expanded]);

  return (
    <>
      <div
        className={`group/media relative flex aspect-video min-h-28 items-center justify-center overflow-hidden rounded-2xl border border-white/[0.08] bg-[#090b0e] ${
          canExpand ? "cursor-zoom-in" : ""
        }`}
        onDoubleClick={() => {
          if (canExpand) setExpanded(true);
        }}
      >
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted={muted}
          className={`h-full w-full ${huddleVideoObjectFit(screenSharing)} ${
            hasVideo ? "block" : "hidden"
          }`}
        />
        {!hasVideo ? (
          <ChatMemberAvatar
            userId={userId}
            name={label}
            profile={profile}
            presence={presence}
            size={58}
          />
        ) : null}
        {canExpand ? (
          <button
            type="button"
            onClick={() => setExpanded(true)}
            className="absolute right-2 top-2 z-10 flex h-9 w-9 items-center justify-center rounded-xl border border-white/15 bg-black/65 text-white shadow-lg backdrop-blur transition hover:scale-105 hover:bg-black/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300/70"
            aria-label={`Expand shared screen from ${label}`}
            title="Expand shared screen"
          >
            <Maximize2 className="h-4 w-4" />
          </button>
        ) : null}
        <div className="absolute inset-x-0 bottom-0 flex items-center justify-between bg-gradient-to-t from-black/85 to-transparent px-3 pb-2 pt-8">
          <span className="truncate text-xs font-medium text-white">
            {label}
          </span>
          <span className="flex items-center gap-1">
            {screenSharing ? (
              <>
                <span className="hidden text-[10px] font-medium text-emerald-200 sm:inline">
                  Sharing screen
                </span>
                <MonitorUp className="h-3.5 w-3.5 text-emerald-300" />
              </>
            ) : cameraOn ? (
              <Video className="h-3.5 w-3.5 text-cyan-200" />
            ) : null}
          </span>
        </div>
      </div>

      {expanded && canExpand
        ? createPortal(
            <div
              className="fixed inset-0 z-[120] flex flex-col bg-black/95 backdrop-blur-xl"
              role="dialog"
              aria-modal="true"
              aria-label={`Shared screen from ${label}`}
            >
              <header className="flex h-14 shrink-0 items-center gap-3 border-b border-white/10 bg-[#0b0d10]/95 px-4 sm:px-6">
                <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-300/10 text-emerald-200">
                  <MonitorUp className="h-4 w-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold text-white">
                    {label}
                  </p>
                  <p className="text-[10px] text-emerald-300/70">
                    Sharing screen
                  </p>
                </div>
                <span className="hidden text-[10px] text-zinc-600 sm:block">
                  Press Esc to close
                </span>
                <button
                  type="button"
                  onClick={() => setExpanded(false)}
                  className="flex h-9 w-9 items-center justify-center rounded-xl border border-white/10 bg-white/[0.04] text-zinc-300 transition hover:bg-white/[0.09] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300/70"
                  aria-label="Close expanded shared screen"
                  title="Close expanded view"
                  autoFocus
                >
                  <Minimize2 className="h-4 w-4" />
                </button>
              </header>
              <div className="flex min-h-0 flex-1 items-center justify-center p-2 sm:p-5">
                <video
                  ref={expandedVideoRef}
                  autoPlay
                  playsInline
                  muted
                  className="max-h-full max-w-full rounded-lg bg-black object-contain shadow-2xl"
                />
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

function RemoteAudioSink({
  stream,
  userId,
}: {
  stream: MediaStream;
  userId: string;
}) {
  const audioRef = useRef<HTMLAudioElement>(null);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.srcObject = stream;
    void audio.play().catch(() => undefined);
    return () => {
      audio.pause();
      audio.srcObject = null;
    };
  }, [stream]);

  return (
    <audio
      ref={audioRef}
      autoPlay
      className="hidden"
      data-huddle-audio-peer={userId}
    />
  );
}

function elapsedLabel(startedAt: string, now: number): string {
  const seconds = Math.max(
    0,
    Math.floor((now - Date.parse(startedAt)) / 1000),
  );
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}:${String(remainder).padStart(2, "0")}`;
}

export function ChannelHuddle({
  channelId,
  channelName,
  currentUserId,
  huddle,
  initialParticipants,
  memberNames,
  memberProfiles,
  memberPresence,
  onChanged,
}: {
  channelId: string;
  channelName: string;
  currentUserId: string;
  huddle: ChatHuddle | null;
  initialParticipants: ChatHuddleParticipant[];
  memberNames: Map<string, string>;
  memberProfiles: Map<string, ChatMemberProfile>;
  memberPresence: Map<string, ChatMemberPresence>;
  onChanged: () => void;
}) {
  const [localHuddle, setLocalHuddle] = useState<ChatHuddle | null>(huddle);
  const [participants, setParticipants] =
    useState<ChatHuddleParticipant[]>(initialParticipants);
  const [joined, setJoined] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const [dismissedHuddleId, setDismissedHuddleId] = useState<string | null>(
    null,
  );
  const [muted, setMuted] = useState(true);
  const [cameraOn, setCameraOn] = useState(false);
  const [screenSharing, setScreenSharing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [remoteStreams, setRemoteStreams] = useState<Map<string, MediaStream>>(
    () => new Map(),
  );
  const [now, setNow] = useState(Date.now());
  const localStreamRef = useRef<MediaStream | null>(null);
  const cameraTrackRef = useRef<MediaStreamTrack | null>(null);
  const screenTrackRef = useRef<MediaStreamTrack | null>(null);
  const peersRef = useRef<Map<string, PeerState>>(new Map());
  const iceServersRef = useRef<RTCIceServer[]>(DEFAULT_ICE_SERVERS);
  const relayAvailableRef = useRef(false);
  const processedSignalIdsRef = useRef<Set<string>>(new Set());
  const joinedRef = useRef(false);
  const huddleIdRef = useRef<string | null>(huddle?.id || null);
  const participantsRef =
    useRef<ChatHuddleParticipant[]>(initialParticipants);
  const onChangedRef = useRef(onChanged);
  const reconcileInFlightRef = useRef(false);

  useEffect(() => {
    onChangedRef.current = onChanged;
  }, [onChanged]);

  useEffect(() => {
    // A racing sidebar response can briefly omit a huddle that the joined
    // client has already confirmed. The huddle-specific GET/subscription below
    // is authoritative for ending an active session.
    if (joinedRef.current && !huddle && huddleIdRef.current) return;
    setLocalHuddle(huddle);
    huddleIdRef.current = huddle?.id || null;
    let nextParticipants = initialParticipants;
    if (joinedRef.current && huddle) {
      nextParticipants = initialParticipants.reduce(
        mergeChatHuddleParticipant,
        participantsRef.current,
      );
    }
    setParticipants(nextParticipants);
    participantsRef.current = nextParticipants;
    if (!huddle && joinedRef.current) {
      joinedRef.current = false;
      setJoined(false);
      setPanelOpen(false);
    }
  }, [huddle, initialParticipants]);

  useEffect(() => {
    if (!localHuddle) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [localHuddle]);

  const closePeer = useCallback((peerId: string) => {
    const peer = peersRef.current.get(peerId);
    if (peer) {
      peer.connection.ontrack = null;
      peer.connection.onicecandidate = null;
      peer.connection.onconnectionstatechange = null;
      peer.connection.close();
      peersRef.current.delete(peerId);
    }
    setRemoteStreams((current) => {
      if (!current.has(peerId)) return current;
      const next = new Map(current);
      next.delete(peerId);
      return next;
    });
  }, []);

  const stopLocalMedia = useCallback(() => {
    screenTrackRef.current?.stop();
    cameraTrackRef.current?.stop();
    for (const track of localStreamRef.current?.getTracks() || []) track.stop();
    screenTrackRef.current = null;
    cameraTrackRef.current = null;
    localStreamRef.current = null;
    for (const peerId of peersRef.current.keys()) closePeer(peerId);
    peersRef.current.clear();
    setRemoteStreams(new Map());
    setMuted(true);
    setCameraOn(false);
    setScreenSharing(false);
  }, [closePeer]);

  const sendSignal = useCallback(
    async (
      peerId: string,
      signalType: HuddleSignal["signal_type"],
      payload: Record<string, unknown>,
    ) => {
      const currentHuddleId = huddleIdRef.current;
      if (!currentHuddleId || !joinedRef.current) return;
      const supabase = getSupabaseBrowserClient();
      const { error } = await supabase.from("chat_huddle_signals").insert({
        huddle_id: currentHuddleId,
        channel_id: channelId,
        sender_user_id: currentUserId,
        recipient_user_id: peerId,
        signal_type: signalType,
        payload,
      });
      if (error) throw new Error(error.message);
    },
    [channelId, currentUserId],
  );

  const createPeer = useCallback(
    (peerId: string) => {
      const current = peersRef.current.get(peerId);
      if (current) return current;
      const connection = new RTCPeerConnection({
        iceServers: iceServersRef.current,
        bundlePolicy: "max-bundle",
      });
      const peerState: PeerState = {
        connection,
        makingOffer: false,
        ignoreOffer: false,
        pendingCandidates: [],
      };
      peersRef.current.set(peerId, peerState);
      for (const track of localStreamRef.current?.getTracks() || []) {
        connection.addTrack(track, localStreamRef.current!);
      }
      connection.onicecandidate = (event) => {
        if (!event.candidate) return;
        void sendSignal(peerId, "ice", {
          candidate: event.candidate.toJSON(),
        }).catch(() => undefined);
      };
      connection.ontrack = (event) => {
        const stream =
          event.streams[0] ||
          new MediaStream(
            connection
              .getReceivers()
              .map((receiver) => receiver.track)
              .filter(Boolean),
          );
        setRemoteStreams((currentStreams) => {
          const next = new Map(currentStreams);
          next.set(peerId, stream);
          return next;
        });
      };
      connection.onconnectionstatechange = () => {
        if (connection.connectionState === "connected") {
          setError((currentError) =>
            currentError?.startsWith("Could not connect to a teammate")
              ? null
              : currentError,
          );
        }
        if (
          connection.connectionState === "failed" ||
          connection.connectionState === "closed"
        ) {
          if (connection.connectionState === "failed") {
            setError(
              relayAvailableRef.current
                ? "Could not connect to a teammate. Retrying…"
                : "Could not connect to a teammate. This deployment needs a TURN relay for this network.",
            );
          }
          closePeer(peerId);
        }
      };
      return peerState;
    },
    [closePeer, sendSignal],
  );

  const offerToPeer = useCallback(
    async (peerId: string) => {
      if (!joinedRef.current) return;
      const peer = createPeer(peerId);
      if (
        peer.makingOffer ||
        peer.connection.signalingState !== "stable"
      ) {
        return;
      }
      peer.makingOffer = true;
      try {
        const offer = await peer.connection.createOffer();
        if (peer.connection.signalingState !== "stable") return;
        await peer.connection.setLocalDescription(offer);
        await sendSignal(peerId, "offer", {
          description: peer.connection.localDescription?.toJSON(),
        });
      } catch (cause) {
        // A failed durable-signal write otherwise strands this peer in
        // have-local-offer forever. The periodic reconciliation will recreate
        // it and negotiate again.
        closePeer(peerId);
        throw cause;
      } finally {
        peer.makingOffer = false;
      }
    },
    [closePeer, createPeer, sendSignal],
  );

  const syncPeers = useCallback(
    (nextParticipants: ChatHuddleParticipant[]) => {
      const peerPlan = chatHuddlePeerPlan({
        currentUserId,
        currentPeerIds: peersRef.current.keys(),
        participants: nextParticipants,
      });
      for (const peerId of peerPlan.closePeerIds) closePeer(peerId);
      for (const peerId of peerPlan.activePeerIds) {
        createPeer(peerId);
        // Every newly created peer offers. This lets the joining browser
        // connect even when the existing browser misses the participant-row
        // event; perfect-negotiation glare handling resolves simultaneous
        // offers without repeated polling renegotiations.
        if (peerPlan.offerPeerIds.includes(peerId)) {
          void offerToPeer(peerId).catch(() => undefined);
        }
      }
    },
    [closePeer, createPeer, currentUserId, offerToPeer],
  );

  const disconnectEndedHuddle = useCallback(() => {
    joinedRef.current = false;
    setJoined(false);
    setPanelOpen(false);
    setLocalHuddle(null);
    huddleIdRef.current = null;
    setParticipants([]);
    participantsRef.current = [];
    processedSignalIdsRef.current.clear();
    stopLocalMedia();
  }, [stopLocalMedia]);

  const refreshHuddle = useCallback(async () => {
    const response = await fetch(`/api/chat/channels/${channelId}/huddles`, {
      cache: "no-store",
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.error || "Could not refresh this huddle.");
    }
    const nextHuddle = (payload.huddle as ChatHuddle | null) || null;
    if (!nextHuddle) {
      if (joinedRef.current) disconnectEndedHuddle();
      return;
    }
    setLocalHuddle(nextHuddle);
    huddleIdRef.current = nextHuddle.id;
    const nextParticipants = Array.isArray(payload.participants)
      ? (payload.participants as ChatHuddleParticipant[])
      : [];
    setParticipants(nextParticipants);
    participantsRef.current = nextParticipants;
    if (joinedRef.current) syncPeers(nextParticipants);
  }, [channelId, disconnectEndedHuddle, syncPeers]);

  const handleSignal = useCallback(
    async (signal: HuddleSignal) => {
      if (
        !joinedRef.current ||
        signal.huddle_id !== huddleIdRef.current ||
        signal.recipient_user_id !== currentUserId ||
        signal.sender_user_id === currentUserId
      ) {
        return;
      }
      if (processedSignalIdsRef.current.has(signal.id)) return;
      if (processedSignalIdsRef.current.size >= 500) {
        processedSignalIdsRef.current.clear();
      }
      processedSignalIdsRef.current.add(signal.id);
      if (
        !participantsRef.current.some(
          (participant) =>
            participant.user_id === signal.sender_user_id &&
            !participant.left_at,
        )
      ) {
        try {
          await refreshHuddle();
        } catch (cause) {
          processedSignalIdsRef.current.delete(signal.id);
          throw cause;
        }
        if (!joinedRef.current) return;
      }
      const peer = createPeer(signal.sender_user_id);
      const connection = peer.connection;
      const flushPendingCandidates = async () => {
        const pending = peer.pendingCandidates.splice(0);
        for (const candidate of pending) {
          await connection.addIceCandidate(candidate).catch(() => undefined);
        }
      };
      let handled = false;
      try {
        if (signal.signal_type === "offer") {
          const description = signal.payload.description as
            | RTCSessionDescriptionInit
            | undefined;
          if (!description) {
            handled = true;
            return;
          }
          const collision =
            peer.makingOffer || connection.signalingState !== "stable";
          const polite =
            currentUserId.localeCompare(signal.sender_user_id) > 0;
          peer.ignoreOffer = !polite && collision;
          if (peer.ignoreOffer) {
            handled = true;
            return;
          }
          if (collision && connection.signalingState !== "stable") {
            await connection.setLocalDescription({ type: "rollback" });
          }
          await connection.setRemoteDescription(description);
          await flushPendingCandidates();
          const answer = await connection.createAnswer();
          await connection.setLocalDescription(answer);
          await sendSignal(signal.sender_user_id, "answer", {
            description: connection.localDescription?.toJSON(),
          });
        } else if (signal.signal_type === "answer") {
          const description = signal.payload.description as
            | RTCSessionDescriptionInit
            | undefined;
          if (
            description &&
            connection.signalingState === "have-local-offer"
          ) {
            await connection.setRemoteDescription(description);
            await flushPendingCandidates();
          }
        } else {
          const candidate = signal.payload.candidate as
            | RTCIceCandidateInit
            | undefined;
          if (candidate && !peer.ignoreOffer) {
            if (connection.remoteDescription) {
              await connection
                .addIceCandidate(candidate)
                .catch(() => undefined);
            } else {
              peer.pendingCandidates.push(candidate);
            }
          }
        }
        handled = true;
      } catch (cause) {
        processedSignalIdsRef.current.delete(signal.id);
        throw cause;
      } finally {
        if (handled) {
          const supabase = getSupabaseBrowserClient();
          await supabase
            .from("chat_huddle_signals")
            .delete()
            .eq("id", signal.id)
            .eq("recipient_user_id", currentUserId);
        }
      }
    },
    [createPeer, currentUserId, refreshHuddle, sendSignal],
  );

  const drainPendingSignals = useCallback(async () => {
    const currentHuddleId = huddleIdRef.current;
    if (!currentHuddleId || !joinedRef.current) return;
    const supabase = getSupabaseBrowserClient();
    const { data, error: signalError } = await supabase
      .from("chat_huddle_signals")
      .select(
        "id,huddle_id,channel_id,sender_user_id,recipient_user_id,signal_type,payload,created_at",
      )
      .eq("huddle_id", currentHuddleId)
      .eq("recipient_user_id", currentUserId)
      .order("created_at", { ascending: true })
      .limit(200);
    if (signalError) throw new Error(signalError.message);
    for (const signal of data || []) {
      await handleSignal(signal as HuddleSignal);
    }
  }, [currentUserId, handleSignal]);

  const applyParticipantRealtimeRow = useCallback(
    (incoming: ChatHuddleParticipant) => {
      if (incoming.huddle_id !== huddleIdRef.current) return;
      const nextParticipants = mergeChatHuddleParticipant(
        participantsRef.current,
        incoming,
      );
      participantsRef.current = nextParticipants;
      setParticipants(nextParticipants);
      if (joinedRef.current) syncPeers(nextParticipants);
    },
    [syncPeers],
  );

  useEffect(() => {
    if (!joined || !localHuddle?.id) return;
    const supabase = getSupabaseBrowserClient();
    const realtime = supabase
      .channel(`chat-huddle:${localHuddle.id}:${currentUserId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "chat_huddle_participants",
          filter: `huddle_id=eq.${localHuddle.id}`,
        },
        (payload) => {
          if (payload.eventType === "DELETE") {
            void refreshHuddle().catch(() => undefined);
            return;
          }
          applyParticipantRealtimeRow(
            payload.new as ChatHuddleParticipant,
          );
        },
      )
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "chat_huddles",
          filter: `id=eq.${localHuddle.id}`,
        },
        (payload) => {
          const nextHuddle = payload.new as ChatHuddle;
          if (nextHuddle.status === "ended") {
            disconnectEndedHuddle();
          } else {
            setLocalHuddle(nextHuddle);
          }
        },
      )
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "chat_huddle_signals",
          filter: `recipient_user_id=eq.${currentUserId}`,
        },
        (payload) => {
          void handleSignal(payload.new as HuddleSignal).catch((cause) => {
            setError(
              cause instanceof Error
                ? cause.message
                : "A participant could not connect.",
            );
          });
        },
      )
      .subscribe((status) => {
        if (status === "SUBSCRIBED") {
          void drainPendingSignals()
            .then(() => syncPeers(participantsRef.current))
            .catch((cause) => {
              setError(
                cause instanceof Error
                  ? cause.message
                  : "Could not connect to this huddle.",
              );
            });
        }
      });
    return () => {
      void supabase.removeChannel(realtime);
    };
  }, [
    applyParticipantRealtimeRow,
    currentUserId,
    disconnectEndedHuddle,
    drainPendingSignals,
    handleSignal,
    joined,
    localHuddle?.id,
    refreshHuddle,
    syncPeers,
  ]);

  useEffect(() => {
    if (!joined || !localHuddle?.id) return;
    const reconcile = async () => {
      if (reconcileInFlightRef.current || !joinedRef.current) return;
      reconcileInFlightRef.current = true;
      try {
        await refreshHuddle();
        await drainPendingSignals();
      } catch (cause) {
        if (joinedRef.current) {
          setError(
            cause instanceof Error
              ? cause.message
              : "Could not reconcile this huddle.",
          );
        }
      } finally {
        reconcileInFlightRef.current = false;
      }
    };
    const timer = window.setInterval(
      () => void reconcile(),
      HUDDLE_RECONCILE_INTERVAL_MS,
    );
    return () => window.clearInterval(timer);
  }, [drainPendingSignals, joined, localHuddle?.id, refreshHuddle]);

  useEffect(
    () => () => {
      if (joinedRef.current && huddleIdRef.current) {
        void fetch(`/api/chat/channels/${channelId}/huddles`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "leave",
            huddleId: huddleIdRef.current,
          }),
          keepalive: true,
        }).catch(() => undefined);
      }
      joinedRef.current = false;
      stopLocalMedia();
    },
    [channelId, stopLocalMedia],
  );

  const updateParticipant = useCallback(
    async (patch: {
      muted?: boolean;
      cameraOn?: boolean;
      screenSharing?: boolean;
    }) => {
      const currentHuddleId = huddleIdRef.current;
      if (!currentHuddleId) return;
      const response = await fetch(`/api/chat/channels/${channelId}/huddles`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "update",
          huddleId: currentHuddleId,
          muted,
          cameraOn,
          screenSharing,
          ...patch,
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload.error || "Could not update huddle controls.");
      }
      if (Array.isArray(payload.participants)) {
        const nextParticipants =
          payload.participants as ChatHuddleParticipant[];
        setParticipants(nextParticipants);
        participantsRef.current = nextParticipants;
      }
    },
    [cameraOn, channelId, muted, screenSharing],
  );

  const join = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      iceServersRef.current = DEFAULT_ICE_SERVERS;
      relayAvailableRef.current = false;
      const iceResponse = await fetch("/api/chat/huddles/ice", {
        cache: "no-store",
      });
      if (iceResponse.ok) {
        const icePayload = await iceResponse.json().catch(() => ({}));
        relayAvailableRef.current = icePayload.relayAvailable === true;
        if (
          Array.isArray(icePayload.iceServers) &&
          icePayload.iceServers.length > 0
        ) {
          iceServersRef.current =
            icePayload.iceServers as RTCIceServer[];
        }
      }
      let localStream: MediaStream;
      try {
        localStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
          video: false,
        });
        for (const track of localStream.getAudioTracks()) {
          track.enabled = false;
        }
      } catch {
        // Permission denial or an unavailable microphone should not exclude a
        // teammate from listening to the room.
        localStream = new MediaStream();
        setError("Joined in listen-only mode. Allow microphone access to speak.");
      }
      localStreamRef.current = localStream;
      const response = await fetch(`/api/chat/channels/${channelId}/huddles`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: localHuddle ? "join" : "start",
          huddleId: localHuddle?.id,
          muted: true,
          cameraOn: false,
          screenSharing: false,
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload.error || "Could not join this huddle.");
      }
      const nextHuddle = payload.huddle as ChatHuddle;
      const nextParticipants = Array.isArray(payload.participants)
        ? (payload.participants as ChatHuddleParticipant[])
        : [];
      setLocalHuddle(nextHuddle);
      huddleIdRef.current = nextHuddle.id;
      setParticipants(nextParticipants);
      participantsRef.current = nextParticipants;
      processedSignalIdsRef.current.clear();
      joinedRef.current = true;
      setJoined(true);
      setPanelOpen(true);
      setDismissedHuddleId(null);
      setMuted(true);
      syncPeers(nextParticipants);
      onChangedRef.current();
    } catch (cause) {
      stopLocalMedia();
      setError(
        cause instanceof Error ? cause.message : "Could not join this huddle.",
      );
    } finally {
      setBusy(false);
    }
  };

  const leave = async () => {
    if (busy) return;
    setBusy(true);
    let huddleEnded = false;
    try {
      const currentHuddleId = huddleIdRef.current;
      if (currentHuddleId) {
        const response = await fetch(`/api/chat/channels/${channelId}/huddles`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "leave",
            huddleId: currentHuddleId,
          }),
        });
        const payload = await response.json().catch(() => ({}));
        huddleEnded = response.ok && payload.ended === true;
      }
    } finally {
      joinedRef.current = false;
      setJoined(false);
      setPanelOpen(false);
      if (huddleEnded) {
        setLocalHuddle(null);
        huddleIdRef.current = null;
        setParticipants([]);
        participantsRef.current = [];
      } else {
        setParticipants((current) => {
          const next = current.filter(
            (participant) => participant.user_id !== currentUserId,
          );
          participantsRef.current = next;
          return next;
        });
      }
      processedSignalIdsRef.current.clear();
      stopLocalMedia();
      setBusy(false);
      onChangedRef.current();
    }
  };

  const endHuddle = async () => {
    const currentHuddleId = huddleIdRef.current;
    if (!currentHuddleId || busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/chat/channels/${channelId}/huddles`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "end", huddleId: currentHuddleId }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload.error || "Could not end this huddle.");
      }
      joinedRef.current = false;
      setJoined(false);
      setPanelOpen(false);
      setLocalHuddle(null);
      huddleIdRef.current = null;
      setParticipants([]);
      participantsRef.current = [];
      processedSignalIdsRef.current.clear();
      stopLocalMedia();
      onChangedRef.current();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not end this huddle.",
      );
    } finally {
      setBusy(false);
    }
  };

  const toggleMute = async () => {
    const next = !muted;
    const audioTrack = localStreamRef.current?.getAudioTracks()[0];
    if (!audioTrack && !next) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
          video: false,
        });
        const track = stream.getAudioTracks()[0];
        if (!track) throw new Error("Microphone unavailable");
        localStreamRef.current ||= new MediaStream();
        localStreamRef.current.addTrack(track);
        for (const [peerId, peer] of peersRef.current) {
          peer.connection.addTrack(track, localStreamRef.current);
          void offerToPeer(peerId);
        }
      } catch {
        setError("Allow microphone access to speak in the huddle.");
        return;
      }
    }
    for (const track of localStreamRef.current?.getAudioTracks() || []) {
      track.enabled = !next;
    }
    setMuted(next);
    await updateParticipant({ muted: next }).catch((cause) =>
      setError(cause instanceof Error ? cause.message : "Could not update mic."),
    );
  };

  const toggleCamera = async () => {
    if (!cameraOn) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { width: { ideal: 1280 }, height: { ideal: 720 } },
        });
        const track = stream.getVideoTracks()[0];
        if (!track) throw new Error("Camera unavailable");
        cameraTrackRef.current = track;
        localStreamRef.current ||= new MediaStream();
        localStreamRef.current.addTrack(track);
        for (const [peerId, peer] of peersRef.current) {
          peer.connection.addTrack(track, localStreamRef.current);
          void offerToPeer(peerId);
        }
        setCameraOn(true);
        await updateParticipant({ cameraOn: true });
      } catch (cause) {
        setError(
          cause instanceof Error
            ? cause.message
            : "Allow camera access to turn on video.",
        );
      }
      return;
    }
    const track = cameraTrackRef.current;
    if (track) {
      for (const [peerId, peer] of peersRef.current) {
        const sender = peer.connection
          .getSenders()
          .find((candidate) => candidate.track === track);
        if (sender) peer.connection.removeTrack(sender);
        void offerToPeer(peerId);
      }
      localStreamRef.current?.removeTrack(track);
      track.stop();
    }
    cameraTrackRef.current = null;
    setCameraOn(false);
    await updateParticipant({ cameraOn: false }).catch(() => undefined);
  };

  const stopScreenShare = useCallback(async () => {
    const screenTrack = screenTrackRef.current;
    if (!screenTrack) return;
    for (const [peerId, peer] of peersRef.current) {
      const sender = peer.connection
        .getSenders()
        .find((candidate) => candidate.track === screenTrack);
      if (sender) {
        if (cameraTrackRef.current) {
          await sender.replaceTrack(cameraTrackRef.current);
        } else {
          peer.connection.removeTrack(sender);
        }
      }
      void offerToPeer(peerId);
    }
    localStreamRef.current?.removeTrack(screenTrack);
    screenTrack.onended = null;
    screenTrack.stop();
    screenTrackRef.current = null;
    setScreenSharing(false);
    await updateParticipant({ screenSharing: false }).catch(() => undefined);
  }, [offerToPeer, updateParticipant]);

  const toggleScreenShare = async () => {
    if (screenSharing) {
      await stopScreenShare();
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: false,
      });
      const track = stream.getVideoTracks()[0];
      if (!track) return;
      screenTrackRef.current = track;
      localStreamRef.current ||= new MediaStream();
      localStreamRef.current.addTrack(track);
      track.onended = () => void stopScreenShare();
      for (const [peerId, peer] of peersRef.current) {
        const sender = peer.connection
          .getSenders()
          .find((candidate) => candidate.track?.kind === "video");
        if (sender) await sender.replaceTrack(track);
        else peer.connection.addTrack(track, localStreamRef.current);
        void offerToPeer(peerId);
      }
      setScreenSharing(true);
      await updateParticipant({ screenSharing: true });
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === "NotAllowedError") {
        return;
      }
      setError(
        cause instanceof Error ? cause.message : "Could not share your screen.",
      );
    }
  };

  const activeParticipants = participants.filter(
    (participant) => !participant.left_at,
  );
  const remoteTiles = activeParticipants.filter(
    (participant) => participant.user_id !== currentUserId,
  );
  const localStream = localStreamRef.current;
  const title = localHuddle?.title || `#${channelName} huddle`;
  const startedByYou = localHuddle?.started_by === currentUserId;
  const participantSummary = useMemo(() => {
    if (activeParticipants.length === 0) return "Nobody joined yet";
    const names = activeParticipants
      .slice(0, 2)
      .map(
        (participant) =>
          memberNames.get(participant.user_id) || "Teammate",
      );
    if (activeParticipants.length <= 2) return names.join(" and ");
    return `${names.join(", ")} +${activeParticipants.length - 2}`;
  }, [activeParticipants, memberNames]);

  return (
    <div className="relative">
      <button
        id={`chat-huddle-trigger-${channelId}`}
        type="button"
        onClick={() => {
          if (joined) {
            setPanelOpen((current) => !current);
          } else {
            void join();
          }
        }}
        disabled={busy}
        className={`inline-flex h-9 items-center gap-2 rounded-xl border px-2.5 text-xs font-medium transition disabled:opacity-45 sm:px-3 ${
          localHuddle
            ? "border-emerald-300/25 bg-emerald-300/[0.08] text-emerald-200 hover:bg-emerald-300/[0.13]"
            : "border-white/[0.08] bg-white/[0.025] text-zinc-400 hover:bg-white/[0.06] hover:text-white"
        }`}
        aria-label={
          localHuddle
            ? joined
              ? "Open huddle controls"
              : "Join active huddle"
            : "Start huddle"
        }
      >
        {busy ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : localHuddle ? (
          <span className="relative">
            <Headphones className="h-3.5 w-3.5" />
            <span className="absolute -right-1 -top-1 h-1.5 w-1.5 rounded-full bg-emerald-300 shadow-[0_0_7px_rgba(110,231,183,.8)]" />
          </span>
        ) : (
          <Headphones className="h-3.5 w-3.5" />
        )}
        <span className="hidden sm:inline">
          {localHuddle
            ? joined
              ? "Huddle"
              : "Join"
            : "Huddle"}
        </span>
        {localHuddle ? (
          <span className="rounded-full bg-emerald-200/10 px-1.5 py-0.5 text-[10px] tabular-nums">
            {activeParticipants.length}
          </span>
        ) : null}
      </button>

      {localHuddle &&
      !joined &&
      dismissedHuddleId !== localHuddle.id ? (
        <div className="absolute right-0 top-[calc(100%+8px)] z-30 hidden w-72 rounded-2xl border border-emerald-300/15 bg-[#14171a] p-3 shadow-2xl xl:block">
          <div className="flex items-start gap-2.5">
            <span className="mt-0.5 flex h-8 w-8 items-center justify-center rounded-xl bg-emerald-300/10 text-emerald-200">
              <Headphones className="h-4 w-4" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-white">{title}</p>
              <p className="mt-0.5 truncate text-[11px] text-zinc-500">
                {participantSummary}
              </p>
            </div>
            <button
              type="button"
              onClick={() => setDismissedHuddleId(localHuddle.id)}
              className="rounded-lg p-1.5 text-zinc-500 transition hover:bg-white/[0.06] hover:text-white"
              aria-label="Dismiss huddle invitation"
            >
              <X className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={() => void join()}
              className="rounded-lg bg-emerald-300 px-2.5 py-1.5 text-xs font-semibold text-[#07120e]"
            >
              Join
            </button>
          </div>
        </div>
      ) : null}

      {joined
        ? remoteTiles.map((participant) => {
            const stream = remoteStreams.get(participant.user_id);
            return stream ? (
              <RemoteAudioSink
                key={participant.user_id}
                stream={stream}
                userId={participant.user_id}
              />
            ) : null;
          })
        : null}

      {joined && panelOpen && localHuddle ? (
        <div className="fixed inset-x-2 bottom-[calc(.5rem+env(safe-area-inset-bottom))] z-[80] max-h-[78dvh] overflow-y-auto rounded-3xl border border-white/10 bg-[#111418]/98 shadow-[0_24px_80px_rgba(0,0,0,.65)] backdrop-blur-xl sm:inset-auto sm:right-4 sm:top-[76px] sm:w-[min(520px,calc(100vw-2rem))]">
          <div className="sticky top-0 z-10 flex items-center gap-3 border-b border-white/[0.07] bg-[#111418]/95 px-4 py-3 backdrop-blur">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl border border-emerald-300/20 bg-emerald-300/[0.08] text-emerald-200">
              <Headphones className="h-4 w-4" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <h3 className="truncate text-sm font-semibold text-white">
                  {title}
                </h3>
                <span className="shrink-0 text-[10px] tabular-nums text-emerald-300/70">
                  {elapsedLabel(localHuddle.started_at, now)}
                </span>
              </div>
              <p className="mt-0.5 flex items-center gap-1 text-[11px] text-zinc-500">
                <UsersRound className="h-3 w-3" />
                {activeParticipants.length} in the huddle
              </p>
            </div>
            <button
              type="button"
              onClick={() => setPanelOpen(false)}
              className="rounded-full p-2 text-zinc-500 hover:bg-white/[0.06] hover:text-white"
              aria-label="Minimize huddle"
            >
              <PictureInPicture2 className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => setPanelOpen(false)}
              className="rounded-full p-2 text-zinc-500 hover:bg-white/[0.06] hover:text-white sm:hidden"
              aria-label="Close huddle controls"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <div
            className={`grid gap-2 p-3 ${
              activeParticipants.length > 1 ? "grid-cols-2" : "grid-cols-1"
            }`}
          >
            <HuddleMediaTile
              stream={localStream}
              muted
              label={`${memberNames.get(currentUserId) || "You"} (you)`}
              profile={memberProfiles.get(currentUserId)}
              presence={memberPresence.get(currentUserId)}
              userId={currentUserId}
              cameraOn={cameraOn}
              screenSharing={screenSharing}
            />
            {remoteTiles.map((participant) => (
              <HuddleMediaTile
                key={participant.user_id}
                stream={remoteStreams.get(participant.user_id) || null}
                muted
                label={memberNames.get(participant.user_id) || "Teammate"}
                profile={memberProfiles.get(participant.user_id)}
                presence={memberPresence.get(participant.user_id)}
                userId={participant.user_id}
                cameraOn={participant.camera_on}
                screenSharing={participant.screen_sharing}
              />
            ))}
          </div>

          {error ? (
            <p className="mx-3 mb-2 rounded-xl border border-amber-300/15 bg-amber-300/[0.06] px-3 py-2 text-xs text-amber-100">
              {error}
            </p>
          ) : null}

          <div className="sticky bottom-0 flex items-center justify-center gap-2 border-t border-white/[0.07] bg-[#111418]/95 px-3 py-3 pb-[calc(.75rem+env(safe-area-inset-bottom))] backdrop-blur">
            <button
              type="button"
              onClick={() => void toggleMute()}
              className={`flex h-11 w-11 items-center justify-center rounded-full border transition ${
                muted
                  ? "border-rose-300/20 bg-rose-300/[0.09] text-rose-200"
                  : "border-white/10 bg-white/[0.06] text-white"
              }`}
              aria-label={muted ? "Unmute microphone" : "Mute microphone"}
            >
              {muted ? (
                <MicOff className="h-4 w-4" />
              ) : (
                <Mic className="h-4 w-4" />
              )}
            </button>
            <button
              type="button"
              onClick={() => void toggleCamera()}
              className={`flex h-11 w-11 items-center justify-center rounded-full border transition ${
                cameraOn
                  ? "border-cyan-300/25 bg-cyan-300/[0.09] text-cyan-100"
                  : "border-white/10 bg-white/[0.04] text-zinc-300"
              }`}
              aria-label={cameraOn ? "Turn camera off" : "Turn camera on"}
            >
              {cameraOn ? (
                <Video className="h-4 w-4" />
              ) : (
                <VideoOff className="h-4 w-4" />
              )}
            </button>
            <button
              type="button"
              onClick={() => void toggleScreenShare()}
              className={`flex h-11 w-11 items-center justify-center rounded-full border transition ${
                screenSharing
                  ? "border-emerald-300/25 bg-emerald-300/[0.09] text-emerald-100"
                  : "border-white/10 bg-white/[0.04] text-zinc-300"
              }`}
              aria-label={screenSharing ? "Stop sharing screen" : "Share screen"}
            >
              <MonitorUp className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => void leave()}
              disabled={busy}
              className="ml-2 inline-flex h-11 items-center gap-2 rounded-full bg-rose-500 px-4 text-xs font-semibold text-white shadow-lg shadow-rose-950/30 transition hover:bg-rose-400 disabled:opacity-50"
            >
              <PhoneOff className="h-4 w-4" />
              Leave
            </button>
            {startedByYou ? (
              <button
                type="button"
                onClick={() => void endHuddle()}
                disabled={busy}
                className="hidden rounded-full px-3 py-2 text-[11px] text-zinc-500 hover:bg-white/[0.05] hover:text-white sm:block"
              >
                End for all
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
