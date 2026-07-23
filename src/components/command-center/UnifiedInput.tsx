"use client";

import { useState, useRef, useCallback, useEffect, KeyboardEvent, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
// #disabled - Mic, MicOff removed because of major implementation change (realtime voice)
import { Brain, Send, Loader2, X, AtSign, Globe, FileText, BookOpen, Database, Flame, Server, BarChart3, Facebook, Instagram, Linkedin, Terminal, Plus, FileSpreadsheet, Presentation, File, MessageCircle, MessageSquare, Clock, User, Image as ImageIcon } from "lucide-react";

type UnifiedInputProps = {
  onSend: (message: string, files?: File[]) => void;
  isStreaming: boolean;
  onCancel: () => void;
  memoryEnabled: boolean;
  onMemoryToggle: () => void;
  // #disabled - voice props removed because of major implementation change (realtime voice)
  // voiceEnabled: boolean;
  // isListening: boolean;
  // isVoiceConnected: boolean;
  // onVoiceToggle: () => void;
  placeholder?: string;
  // AI Chat agent picker (slash "/")
  chatAgents?: Array<{ id: string; name: string }>;
  activeChatAgentId?: string | null;
  onSelectChatAgent?: (agentId: string) => void;
  // AI Chat session picker (slash "/session")
  chatSessions?: Array<{ id: string; title: string }>;
  activeChatSessionId?: string | null;
  onSelectChatSession?: (sessionId: string) => void;
  onCreateChatSession?: () => Promise<{ id: string; title: string } | null>;
  // Files agent picker (slash "/files")
  filesAgents?: Array<{ id: string; name: string }>;
  activeFilesAgentId?: string | null;
  onSelectFilesAgent?: (agentId: string) => void;
  // Files session picker (slash "/fsession")
  filesSessions?: Array<{ id: string; title: string }>;
  activeFilesSessionId?: string | null;
  onSelectFilesSession?: (sessionId: string) => void;
  onCreateFilesSession?: () => Promise<{ id: string; title: string } | null>;
  // Claude Code session picker (slash "/sessions" combined view)
  codeSessions?: Array<{ id: string; name: string }>;
  activeCodeSessionId?: string | null;
  onSelectCodeSession?: (sessionId: string) => void;
  teamMembers?: Array<{ id: string; handle: string; label: string; description?: string }>;
};

const FILE_ACCEPT = "image/png,image/jpeg,image/webp,image/gif,.png,.jpg,.jpeg,.webp,.gif,.xlsx,.pptx,.docx,.pdf,application/pdf,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.openxmlformats-officedocument.presentationml.presentation,application/vnd.openxmlformats-officedocument.wordprocessingml.document";

function getUploadIcon(file: File) {
  if (file.type.startsWith("image/")) return ImageIcon;
  const ext = file.name.toLowerCase().split(".").pop();
  switch (ext) {
    case "xlsx":
    case "xls":
      return FileSpreadsheet;
    case "pptx":
    case "ppt":
      return Presentation;
    case "docx":
    case "doc":
    case "pdf":
      return FileText;
    default:
      return File;
  }
}

type MentionOption = {
  id: string;
  label: string;
  description: string;
  color: string;
  icon: React.ReactNode;
  category: "agent" | "provider" | "person";
};

const MENTION_OPTIONS: MentionOption[] = [
  // Main agents
  { id: "browser", label: "Browser", description: "Web browsing & automation", color: "cyan", icon: <Globe className="w-4 h-4" />, category: "agent" },
  { id: "files", label: "Files", description: "File management & analysis", color: "amber", icon: <FileText className="w-4 h-4" />, category: "agent" },
  { id: "obsidian", label: "Obsidian", description: "Search notes & vault", color: "violet", icon: <BookOpen className="w-4 h-4" />, category: "agent" },
  { id: "data", label: "Data", description: "Analytics & integrations", color: "emerald", icon: <Database className="w-4 h-4" />, category: "agent" },
  { id: "code", label: "Code", description: "Claude Code CLI sessions", color: "sky", icon: <Terminal className="w-4 h-4" />, category: "agent" },
  { id: "chat", label: "AI Chat", description: "Conversational AI assistant", color: "rose", icon: <MessageCircle className="w-4 h-4" />, category: "agent" },
  { id: "schedule", label: "Schedule", description: "Local scheduled tasks (cron)", color: "blue", icon: <Clock className="w-4 h-4" />, category: "agent" },
  // Data providers
  { id: "firecrawl", label: "Firecrawl", description: "Web scraping & crawling", color: "orange", icon: <Flame className="w-4 h-4" />, category: "provider" },
  { id: "postgres", label: "Postgres", description: "Database queries", color: "blue", icon: <Server className="w-4 h-4" />, category: "provider" },
  { id: "pixel", label: "Web Pixel", description: "Website analytics", color: "pink", icon: <BarChart3 className="w-4 h-4" />, category: "provider" },
  { id: "google_ads", label: "Google Ads", description: "Ad campaigns & metrics", color: "red", icon: <BarChart3 className="w-4 h-4" />, category: "provider" },
  { id: "facebook", label: "Facebook", description: "Facebook Ads & insights", color: "blue", icon: <Facebook className="w-4 h-4" />, category: "provider" },
  { id: "instagram", label: "Instagram", description: "Instagram insights", color: "pink", icon: <Instagram className="w-4 h-4" />, category: "provider" },
  { id: "linkedin", label: "LinkedIn", description: "LinkedIn Ads", color: "blue", icon: <Linkedin className="w-4 h-4" />, category: "provider" },
];

// Color classes mapping
const colorClasses: Record<string, { bg: string; text: string; border: string }> = {
  cyan: { bg: "bg-cyan-500/20", text: "text-cyan-400", border: "border-cyan-500/30" },
  amber: { bg: "bg-amber-500/20", text: "text-amber-400", border: "border-amber-500/30" },
  violet: { bg: "bg-violet-500/20", text: "text-violet-400", border: "border-violet-500/30" },
  emerald: { bg: "bg-emerald-500/20", text: "text-emerald-400", border: "border-emerald-500/30" },
  orange: { bg: "bg-orange-500/20", text: "text-orange-400", border: "border-orange-500/30" },
  blue: { bg: "bg-blue-500/20", text: "text-blue-400", border: "border-blue-500/30" },
  pink: { bg: "bg-pink-500/20", text: "text-pink-400", border: "border-pink-500/30" },
  red: { bg: "bg-red-500/20", text: "text-red-400", border: "border-red-500/30" },
  rose: { bg: "bg-rose-500/20", text: "text-rose-400", border: "border-rose-500/30" },
  sky: { bg: "bg-sky-500/20", text: "text-sky-400", border: "border-sky-500/30" },
};

export function UnifiedInput({
  onSend,
  isStreaming,
  onCancel,
  memoryEnabled,
  onMemoryToggle,
  // #disabled - voice props removed because of major implementation change (realtime voice)
  // voiceEnabled,
  // isListening,
  // isVoiceConnected,
  // onVoiceToggle,
  placeholder = "What do you need?",
  chatAgents = [],
  activeChatAgentId = null,
  onSelectChatAgent,
  chatSessions = [],
  activeChatSessionId = null,
  onSelectChatSession,
  onCreateChatSession,
  filesAgents = [],
  activeFilesAgentId = null,
  onSelectFilesAgent,
  filesSessions = [],
  activeFilesSessionId = null,
  onSelectFilesSession,
  onCreateFilesSession,
  codeSessions = [],
  activeCodeSessionId = null,
  onSelectCodeSession,
  teamMembers = [],
}: UnifiedInputProps) {
  const [input, setInput] = useState("");
  const teamMentionOptions = useMemo<MentionOption[]>(
    () =>
      teamMembers.map((member) => ({
        id: member.handle,
        label: member.label,
        description: member.description || "Team member",
        color: "blue",
        icon: <User className="w-4 h-4" />,
        category: "person",
      })),
    [teamMembers]
  );

  const allMentionOptions = useMemo(
    () => [...MENTION_OPTIONS, ...teamMentionOptions],
    [teamMentionOptions]
  );

  const findMentionOption = useCallback(
    (text: string): MentionOption | null => {
      const lower = text.toLowerCase();
      return (
        allMentionOptions.find(
          (opt) =>
            opt.id.toLowerCase() === lower || opt.label.toLowerCase() === lower
        ) || null
      );
    },
    [allMentionOptions]
  );
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [selectedMentionIndex, setSelectedMentionIndex] = useState(0);
  const prevMentionFilterRef = useRef<string>("");
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const mentionOverlayRef = useRef<HTMLDivElement>(null);
  const mentionMenuRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Mention overlay paints only mention tokens so the textarea remains native/visible.
  // Keep overlay disabled on narrow screens where browser text metrics are less stable.
  const [disableMentionOverlay, setDisableMentionOverlay] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia("(max-width: 640px)");
    const update = () => setDisableMentionOverlay(!!mq.matches);
    update();
    if (typeof mq.addEventListener === "function") {
      mq.addEventListener("change", update);
      return () => mq.removeEventListener("change", update);
    }
    mq.addListener(update);
    return () => mq.removeListener(update);
  }, []);

  // Check if currently typing a mention at the end (for dropdown)
  const atMatch = input.match(/@(\w*)$/);
  // Also support "at <agent>" as a mention-style shortcut
  const atWordMatch = input.match(/(^|\s)at\s+(\w*)$/i);
  // Slash commands for agent/session pickers:
  // - "/" or "/<agent>" -> AI Chat agent picker
  // - "/session" -> context-aware: Files sessions if @files is in input, else AI Chat sessions
  // - "/files" or "/files <agent>" -> Files agent picker
  // - "/fsession" or "/fsession <filter>" -> Files session picker (explicit)
  const slashMatch = input.match(/(^|\s)\/(\w*)(?:\s+([^\n]*))?\s*$/);
  const showMentionMenu = Boolean(atMatch) || Boolean(atWordMatch) || Boolean(slashMatch);
  const slashCommandRaw = slashMatch?.[2] || "";
  const slashArgRaw = (slashMatch?.[3] || "").trim();
  const mentionFilter = atMatch?.[1] || atWordMatch?.[2] || slashCommandRaw || "";
  const isSlashMode = Boolean(slashMatch);
  const isAtWordMode = Boolean(atWordMatch) && !Boolean(atMatch) && !isSlashMode;
  
  // Detect if @files or @chat is in the input (for context-aware /session)
  const hasFilesMention = /@files(?::[^\s]+)?(?:\s|$)/i.test(input);
  const hasChatMention = /@chat(?::[^\s]+)?(?:\s|$)/i.test(input);
  const hasCodeMention = /@code(?::[^\s]+)?(?:\s|$)/i.test(input);
  
  // Detect which slash command type
  const slashCmd = slashCommandRaw.toLowerCase();
  const isGenericSessionSlash = isSlashMode && /^sess(ion)?s?$/.test(slashCmd);
  const isFilesSlash = isSlashMode && /^files?$/.test(slashCmd);
  const isExplicitFilesSessionSlash = isSlashMode && /^(f|files?)sess(ion)?s?$/.test(slashCmd);
  
  // Context-aware session detection:
  // - /fsession -> only Files sessions
  // - /session with @files -> only Files sessions
  // - /session with @chat -> only AI Chat sessions
  // - /session alone -> BOTH AI Chat and Files sessions
  const showFilesSessionsOnly = isExplicitFilesSessionSlash || (isGenericSessionSlash && hasFilesMention && !hasChatMention);
  const showChatSessionsOnly = isGenericSessionSlash && hasChatMention && !hasFilesMention;
  const showCodeSessionsOnly = isGenericSessionSlash && hasCodeMention && !hasChatMention && !hasFilesMention;
  const showAllSessions = isGenericSessionSlash && !hasFilesMention && !hasChatMention;
  
  const isFilesSessionSlash = showFilesSessionsOnly || showAllSessions;
  const isChatSessionSlash = showChatSessionsOnly || showAllSessions;
  const isCodeSessionSlash = showCodeSessionsOnly || showAllSessions;
  const isChatAgentSlash = isSlashMode && !isGenericSessionSlash && !isFilesSlash && !isExplicitFilesSessionSlash;

  const filteredChatAgents = useMemo(() => {
    if (!isChatAgentSlash) return [];
    const q = slashCommandRaw.toLowerCase();
    if (!q) return chatAgents;
    return chatAgents.filter((a) => a.name.toLowerCase().includes(q));
  }, [chatAgents, isChatAgentSlash, slashCommandRaw]);

  const filteredChatSessions = useMemo(() => {
    if (!isChatSessionSlash) return [];
    const q = slashArgRaw.toLowerCase();
    if (!q) return chatSessions;
    return chatSessions.filter((s) => s.title.toLowerCase().includes(q));
  }, [chatSessions, isChatSessionSlash, slashArgRaw]);

  const filteredFilesAgents = useMemo(() => {
    if (!isFilesSlash) return [];
    const q = slashArgRaw.toLowerCase();
    if (!q) return filesAgents;
    return filesAgents.filter((a) => a.name.toLowerCase().includes(q));
  }, [filesAgents, isFilesSlash, slashArgRaw]);

  const filteredFilesSessions = useMemo(() => {
    if (!isFilesSessionSlash) return [];
    const q = slashArgRaw.toLowerCase();
    if (!q) return filesSessions;
    return filesSessions.filter((s) => s.title.toLowerCase().includes(q));
  }, [filesSessions, isFilesSessionSlash, slashArgRaw]);

  const filteredCodeSessions = useMemo(() => {
    if (!isCodeSessionSlash) return [];
    const q = slashArgRaw.toLowerCase();
    if (!q) return codeSessions;
    return codeSessions.filter((s) => s.name.toLowerCase().includes(q));
  }, [codeSessions, isCodeSessionSlash, slashArgRaw]);

  // Find ALL mentions in the input (for coloring and chip)
  const mentionsInInput = useMemo(() => {
    const matches: { match: string; option: MentionOption; start: number; end: number }[] = [];
    const regex = /@(\w+)/g;
    let m;
    while ((m = regex.exec(input)) !== null) {
      const option = findMentionOption(m[1]);
      if (option) {
        matches.push({
          match: m[0],
          option,
          start: m.index,
          end: m.index + m[0].length,
        });
      }
    }
    return matches;
  }, [findMentionOption, input]);

  // The first valid mention found (for the "Addressing" chip)
  const activeMention = mentionsInInput.length > 0 ? mentionsInInput[0].option : null;

  // Filter mention options based on what user is typing after @
  const filteredOptions = mentionFilter
    ? allMentionOptions.filter(
        (opt) =>
          opt.id.toLowerCase().includes(mentionFilter.toLowerCase()) ||
          opt.label.toLowerCase().includes(mentionFilter.toLowerCase())
      )
    : allMentionOptions;

  // Use a single menu index for all menus
  // When showing all sessions, combine both counts
  const menuSize = showAllSessions
    ? (onCreateChatSession ? 1 : 0) +
      filteredChatSessions.length +
      (onCreateFilesSession ? 1 : 0) +
      filteredFilesSessions.length +
      filteredCodeSessions.length
    : isChatSessionSlash
    ? filteredChatSessions.length + (onCreateChatSession ? 1 : 0)
    : isFilesSessionSlash
    ? filteredFilesSessions.length + (onCreateFilesSession ? 1 : 0)
    : isCodeSessionSlash
    ? filteredCodeSessions.length
    : isFilesSlash
    ? filteredFilesAgents.length
    : isChatAgentSlash
    ? filteredChatAgents.length
    : filteredOptions.length;

  // Reset selection when filter changes (synchronously during render, not in effect)
  if (mentionFilter !== prevMentionFilterRef.current) {
    prevMentionFilterRef.current = mentionFilter;
    if (selectedMentionIndex !== 0) {
      setSelectedMentionIndex(0);
    }
  }

  const syncMentionOverlayScroll = useCallback(() => {
    if (disableMentionOverlay) return;
    const textarea = inputRef.current;
    const overlay = mentionOverlayRef.current;
    if (!textarea || !overlay) return;
    overlay.scrollTop = textarea.scrollTop;
    overlay.scrollLeft = textarea.scrollLeft;
    overlay.style.height = `${textarea.clientHeight}px`;
  }, [disableMentionOverlay]);

  // Auto-resize textarea
  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.style.height = "auto";
      inputRef.current.style.height = `${Math.min(inputRef.current.scrollHeight, 150)}px`;
      syncMentionOverlayScroll();
    }
  }, [input, syncMentionOverlayScroll]);

  useEffect(() => {
    syncMentionOverlayScroll();
  }, [mentionsInInput.length, syncMentionOverlayScroll]);

  const handleSend = useCallback(() => {
    const trimmed = input.trim();
    if ((!trimmed && selectedFiles.length === 0) || isStreaming) return;
    onSend(trimmed, selectedFiles);
    setInput("");
    setSelectedFiles([]);
  }, [input, isStreaming, onSend, selectedFiles]);

  const onPickFiles = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files ? Array.from(e.target.files) : [];
    e.target.value = "";
    if (!files.length) return;
    setSelectedFiles((prev) => [...prev, ...files]);
  }, []);

  const removeFile = useCallback((idx: number) => {
    setSelectedFiles((prev) => prev.filter((_, i) => i !== idx));
  }, []);

  const selectMention = useCallback((option: MentionOption, fromSlash = false) => {
    if (fromSlash) {
      // Slash menu is reserved for AI Chat agents; keep this path defensive.
      setInput((prev) => prev.replace(/(^|\s)\/\w*\s*$/, "$1"));
    } else if (isAtWordMode) {
      // Replace the trailing "at partial" with "@selected"
      setInput((prev) =>
        prev.replace(/(^|\s)at\s+\w*$/i, (_, ws: string) => `${ws}@${option.id} `)
      );
    } else {
      // Replace the @partial at the end with @selected
      setInput((prev) => prev.replace(/@\w*$/, `@${option.id} `));
    }
    inputRef.current?.focus();
  }, [isAtWordMode]);

  const selectChatAgent = useCallback(
    (agentId: string) => {
      onSelectChatAgent?.(agentId);
      const agentName =
        chatAgents.find((a) => a.id === agentId)?.name?.trim() || "chat";
      const slug = agentName
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "")
        .slice(0, 40);

      // Replace trailing "/partial" token with "@chat:<agent>" so it's visible which one you picked.
      setInput((prev) =>
        prev.replace(
          /(^|\s)\/\w*\s*$/,
          (_, ws: string) => `${ws}@chat:${slug || "chat"} `
        )
      );
      inputRef.current?.focus();
    },
    [chatAgents, onSelectChatAgent]
  );

  const selectChatSession = useCallback(
    (sessionId: string) => {
      onSelectChatSession?.(sessionId);
      const title = chatSessions.find((s) => s.id === sessionId)?.title?.trim() || "session";
      // Replace trailing "/session" token with a cosmetic "@session(title)" tag.
      setInput((prev) =>
        prev.replace(/(^|\s)\/\w+(?:\s+[^\n]*)?\s*$/, (_, ws: string) => `${ws}@session(${title}) `)
      );
      inputRef.current?.focus();
    },
    [chatSessions, onSelectChatSession]
  );

  const selectFilesAgent = useCallback(
    (agentId: string) => {
      onSelectFilesAgent?.(agentId);
      const agentName = filesAgents.find((a) => a.id === agentId)?.name?.trim() || "files";
      const slug = agentName
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "")
        .slice(0, 40);

      // Replace trailing "/files" token with "@files:<agent>" so it's visible which one you picked.
      setInput((prev) =>
        prev.replace(
          /(^|\s)\/files?\s*(?:[^\n]*)?\s*$/i,
          (_, ws: string) => `${ws}@files:${slug || "files"} `
        )
      );
      inputRef.current?.focus();
    },
    [filesAgents, onSelectFilesAgent]
  );

  const selectFilesSession = useCallback(
    (sessionId: string) => {
      onSelectFilesSession?.(sessionId);
      const title = filesSessions.find((s) => s.id === sessionId)?.title?.trim() || "files-session";
      // Replace trailing "/fsession" token with a cosmetic "@fsession(title)" tag.
      setInput((prev) =>
        prev.replace(/(^|\s)\/(f|files?)sess(ion)?s?(?:\s+[^\n]*)?\s*$/i, (_, ws: string) => `${ws}@fsession(${title}) `)
      );
      inputRef.current?.focus();
    },
    [filesSessions, onSelectFilesSession]
  );

  const selectCodeSession = useCallback(
    (sessionId: string) => {
      onSelectCodeSession?.(sessionId);
      // Remove the trailing "/sessions" token; switching panes is the primary action.
      setInput((prev) => prev.replace(/(^|\s)\/\w+(?:\s+[^\n]*)?\s*$/i, "$1").trimStart());
      inputRef.current?.focus();
    },
    [onSelectCodeSession]
  );

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (showMentionMenu && menuSize > 0) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setSelectedMentionIndex((prev) => (prev + 1) % menuSize);
        } else if (e.key === "ArrowUp") {
          e.preventDefault();
          setSelectedMentionIndex((prev) => (prev - 1 + menuSize) % menuSize);
        } else if (e.key === "Enter" || e.key === "Tab") {
          e.preventDefault();
          if (isSlashMode) {
            if (showAllSessions) {
              // Combined menu: [new chat?, chat sessions..., new files?, files sessions..., code sessions...]
              const chatCreateOffset = onCreateChatSession ? 1 : 0;
              const chatEnd = chatCreateOffset + filteredChatSessions.length;
              const filesCreateOffset = onCreateFilesSession ? 1 : 0;
              const filesEnd = chatEnd + filesCreateOffset + filteredFilesSessions.length;
              
              if (selectedMentionIndex < chatCreateOffset) {
                // New chat session
                (async () => {
                  const created = await onCreateChatSession?.();
                  if (created) selectChatSession(created.id);
                })();
              } else if (selectedMentionIndex < chatEnd) {
                // Chat session
                const ses = filteredChatSessions[selectedMentionIndex - chatCreateOffset];
                if (ses) selectChatSession(ses.id);
              } else if (selectedMentionIndex < chatEnd + filesCreateOffset) {
                // New files session
                (async () => {
                  const created = await onCreateFilesSession?.();
                  if (created) selectFilesSession(created.id);
                })();
              } else if (selectedMentionIndex < filesEnd) {
                // Files session
                const ses = filteredFilesSessions[selectedMentionIndex - chatEnd - filesCreateOffset];
                if (ses) selectFilesSession(ses.id);
              } else {
                // Code session
                const ses = filteredCodeSessions[selectedMentionIndex - filesEnd];
                if (ses) selectCodeSession(ses.id);
              }
            } else if (isChatSessionSlash && !showAllSessions) {
              if (onCreateChatSession && selectedMentionIndex === 0) {
                // New session row
                (async () => {
                  const created = await onCreateChatSession();
                  if (created) selectChatSession(created.id);
                })();
              } else {
                const idx = selectedMentionIndex - (onCreateChatSession ? 1 : 0);
                const ses = filteredChatSessions[idx];
                if (ses) selectChatSession(ses.id);
              }
            } else if (isFilesSessionSlash && !showAllSessions) {
              if (onCreateFilesSession && selectedMentionIndex === 0) {
                // New files session row
                (async () => {
                  const created = await onCreateFilesSession();
                  if (created) selectFilesSession(created.id);
                })();
              } else {
                const idx = selectedMentionIndex - (onCreateFilesSession ? 1 : 0);
                const ses = filteredFilesSessions[idx];
                if (ses) selectFilesSession(ses.id);
              }
            } else if (isCodeSessionSlash && !showAllSessions) {
              const ses = filteredCodeSessions[selectedMentionIndex];
              if (ses) selectCodeSession(ses.id);
            } else if (isFilesSlash) {
              const agent = filteredFilesAgents[selectedMentionIndex];
              if (agent) selectFilesAgent(agent.id);
            } else {
              // Chat agent slash
              const agent = filteredChatAgents[selectedMentionIndex];
              if (agent) selectChatAgent(agent.id);
            }
          } else {
            selectMention(filteredOptions[selectedMentionIndex], false);
          }
        } else if (e.key === "Escape") {
          // Exit mention mode by removing the trailing "@word" or leading "/word"
          if (isSlashMode) {
            setInput((prev) => prev.replace(/(^|\s)\/\w+(?:\s+[^\n]*)?\s*$/, "$1"));
          } else {
            setInput((prev) => prev.replace(/@\w*$/, ""));
          }
        }
      } else if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [
      showMentionMenu,
      menuSize,
      filteredChatAgents,
      filteredChatSessions,
      filteredFilesAgents,
      filteredFilesSessions,
      filteredCodeSessions,
      filteredOptions,
      selectedMentionIndex,
      selectMention,
      selectChatAgent,
      selectChatSession,
      selectFilesAgent,
      selectFilesSession,
      selectCodeSession,
      handleSend,
      isSlashMode,
      showAllSessions,
      isChatSessionSlash,
      isFilesSlash,
      isFilesSessionSlash,
      isCodeSessionSlash,
      onCreateChatSession,
      onCreateFilesSession,
    ]
  );

  const removeMention = useCallback((mentionText: string) => {
    setInput((prev) => prev.replace(mentionText + " ", "").replace(mentionText, ""));
  }, []);

  // Render input with colored mentions
  const renderStyledText = useMemo(() => {
    if (mentionsInInput.length === 0) return null;

    const parts: React.ReactNode[] = [];
    let lastIndex = 0;

    mentionsInInput.forEach((m, idx) => {
      // Text before this mention
      if (m.start > lastIndex) {
        parts.push(
          <span key={`text-${idx}`} className="text-transparent">
            {input.slice(lastIndex, m.start)}
          </span>
        );
      }
      const colors = colorClasses[m.option.color];
      parts.push(
        <span key={`mention-${idx}`} className={`${colors.text} font-medium bg-zinc-900`}>
          {m.match}
        </span>
      );
      lastIndex = m.end;
    });

    // Text after the last mention
    if (lastIndex < input.length) {
      parts.push(
        <span key="text-end" className="text-transparent">
          {input.slice(lastIndex)}
        </span>
      );
    }

    return parts;
  }, [input, mentionsInInput]);

  return (
    <div className="relative">
      {/* Mention autocomplete menu */}
      <AnimatePresence>
        {showMentionMenu && (
          <motion.div
            ref={mentionMenuRef}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 10 }}
            className="absolute bottom-full left-0 right-0 mb-2 mx-4 bg-zinc-900 border border-white/10 rounded-xl shadow-2xl overflow-hidden max-h-64 overflow-y-auto z-50"
          >
            {/* Slash: AI Chat agents */}
            {isChatAgentSlash && (
              <>
                <div className="px-3 py-2 border-b border-white/5">
                  <span className="text-[10px] text-zinc-500 uppercase tracking-wider">
                    AI Chat Agents
                  </span>
                </div>
                {filteredChatAgents.length === 0 ? (
                  <div className="px-3 py-3 text-xs text-zinc-500">
                    No AI Chat agents found. Create one first.
                  </div>
                ) : (
                  filteredChatAgents.map((agent, idx) => {
                    const isSelected = idx === selectedMentionIndex;
                    const isActive = activeChatAgentId === agent.id;
                    return (
                      <button
                        key={agent.id}
                        onClick={() => selectChatAgent(agent.id)}
                        className={`w-full px-3 py-2 flex items-center gap-3 transition-colors ${
                          isSelected ? "bg-white/10" : "hover:bg-white/5"
                        }`}
                      >
                        <div
                          className={`w-8 h-8 rounded-lg bg-rose-500/20 text-rose-400 border border-rose-500/30 flex items-center justify-center`}
                        >
                          <MessageCircle className="w-4 h-4" />
                        </div>
                        <div className="flex-1 text-left min-w-0">
                          <div className="text-sm text-white font-medium truncate">
                            /{agent.name}
                            {isActive ? (
                              <span className="ml-2 text-[10px] text-rose-400">active</span>
                            ) : null}
                          </div>
                          <div className="text-xs text-zinc-500">Use this AI Chat agent</div>
                        </div>
                      </button>
                    );
                  })
                )}
              </>
            )}

            {/* Slash: AI Chat sessions (shown alone or in combined view) */}
            {(isChatSessionSlash || showAllSessions) && (
              <>
                <div className="px-3 py-2 border-b border-white/5">
                  <span className="text-[10px] text-zinc-500 uppercase tracking-wider">
                    AI Chat Sessions
                  </span>
                </div>

                {onCreateChatSession && (
                  <button
                    onClick={async () => {
                      const created = await onCreateChatSession();
                      if (created) selectChatSession(created.id);
                    }}
                    className={`w-full px-3 py-2 flex items-center gap-3 transition-colors ${
                      selectedMentionIndex === 0 ? "bg-white/10" : "hover:bg-white/5"
                    }`}
                  >
                    <div className="w-8 h-8 rounded-lg bg-white/10 text-zinc-200 border border-white/10 flex items-center justify-center">
                      +
                    </div>
                    <div className="flex-1 text-left">
                      <div className="text-sm text-white font-medium">New chat session</div>
                      <div className="text-xs text-zinc-500">Start a fresh AI chat session</div>
                    </div>
                  </button>
                )}

                {filteredChatSessions.length === 0 ? (
                  <div className="px-3 py-3 text-xs text-zinc-500">
                    No AI chat sessions yet.
                  </div>
                ) : (
                  filteredChatSessions.map((s, idx) => {
                    const base = onCreateChatSession ? 1 : 0;
                    const isSelected = idx + base === selectedMentionIndex;
                    const isActive = activeChatSessionId === s.id;
                    return (
                      <button
                        key={s.id}
                        onClick={() => selectChatSession(s.id)}
                        className={`w-full px-3 py-2 flex items-center gap-3 transition-colors ${
                          isSelected ? "bg-white/10" : "hover:bg-white/5"
                        }`}
                      >
                        <div className="w-8 h-8 rounded-lg bg-rose-500/10 text-rose-400 border border-rose-500/20 flex items-center justify-center">
                          <MessageSquare className="w-4 h-4" />
                        </div>
                        <div className="flex-1 text-left min-w-0">
                          <div className="text-sm text-white font-medium truncate">
                            {s.title}
                            {isActive ? (
                              <span className="ml-2 text-[10px] text-rose-400">active</span>
                            ) : null}
                          </div>
                          <div className="text-xs text-zinc-500">Use this session</div>
                        </div>
                      </button>
                    );
                  })
                )}
              </>
            )}

            {/* Slash: Files agents */}
            {isFilesSlash && (
              <>
                <div className="px-3 py-2 border-b border-white/5">
                  <span className="text-[10px] text-zinc-500 uppercase tracking-wider">
                    Files Agents
                  </span>
                </div>
                {filteredFilesAgents.length === 0 ? (
                  <div className="px-3 py-3 text-xs text-zinc-500">
                    No Files agents found. Create one first.
                  </div>
                ) : (
                  filteredFilesAgents.map((agent, idx) => {
                    const isSelected = idx === selectedMentionIndex;
                    const isActive = activeFilesAgentId === agent.id;
                    return (
                      <button
                        key={agent.id}
                        onClick={() => selectFilesAgent(agent.id)}
                        className={`w-full px-3 py-2 flex items-center gap-3 transition-colors ${
                          isSelected ? "bg-white/10" : "hover:bg-white/5"
                        }`}
                      >
                        <div
                          className="w-8 h-8 rounded-lg bg-amber-500/20 text-amber-400 border border-amber-500/30 flex items-center justify-center"
                        >
                          <FileText className="w-4 h-4" />
                        </div>
                        <div className="flex-1 text-left min-w-0">
                          <div className="text-sm text-white font-medium truncate">
                            /files {agent.name}
                            {isActive ? (
                              <span className="ml-2 text-[10px] text-amber-400">active</span>
                            ) : null}
                          </div>
                          <div className="text-xs text-zinc-500">Use this Files agent</div>
                        </div>
                      </button>
                    );
                  })
                )}
              </>
            )}

            {/* Slash: Files sessions (shown alone or in combined view) */}
            {(isFilesSessionSlash || showAllSessions) && (
              <>
                <div className="px-3 py-2 border-b border-white/5">
                  <span className="text-[10px] text-zinc-500 uppercase tracking-wider">
                    Files Sessions
                  </span>
                </div>

                {(() => {
                  // Calculate offset for files section when in combined view
                  const filesBaseOffset = showAllSessions
                    ? (onCreateChatSession ? 1 : 0) + filteredChatSessions.length
                    : 0;
                  return (
                    <>
                      {onCreateFilesSession && (
                        <button
                          onClick={async () => {
                            const created = await onCreateFilesSession();
                            if (created) selectFilesSession(created.id);
                          }}
                          className={`w-full px-3 py-2 flex items-center gap-3 transition-colors ${
                            selectedMentionIndex === filesBaseOffset ? "bg-white/10" : "hover:bg-white/5"
                          }`}
                        >
                          <div className="w-8 h-8 rounded-lg bg-white/10 text-zinc-200 border border-white/10 flex items-center justify-center">
                            +
                          </div>
                          <div className="flex-1 text-left">
                            <div className="text-sm text-white font-medium">New files session</div>
                            <div className="text-xs text-zinc-500">Start a fresh files session</div>
                          </div>
                        </button>
                      )}

                      {filteredFilesSessions.length === 0 ? (
                        <div className="px-3 py-3 text-xs text-zinc-500">
                          No files sessions yet.
                        </div>
                      ) : (
                        filteredFilesSessions.map((s, idx) => {
                          const base = filesBaseOffset + (onCreateFilesSession ? 1 : 0);
                          const isSelected = idx + base === selectedMentionIndex;
                          const isActive = activeFilesSessionId === s.id;
                          return (
                            <button
                              key={s.id}
                              onClick={() => selectFilesSession(s.id)}
                              className={`w-full px-3 py-2 flex items-center gap-3 transition-colors ${
                                isSelected ? "bg-white/10" : "hover:bg-white/5"
                              }`}
                            >
                              <div className="w-8 h-8 rounded-lg bg-amber-500/10 text-amber-400 border border-amber-500/20 flex items-center justify-center">
                                <FileText className="w-4 h-4" />
                              </div>
                              <div className="flex-1 text-left min-w-0">
                                <div className="text-sm text-white font-medium truncate">
                                  {s.title}
                                  {isActive ? (
                                    <span className="ml-2 text-[10px] text-amber-400">active</span>
                                  ) : null}
                                </div>
                                <div className="text-xs text-zinc-500">Use this session</div>
                              </div>
                            </button>
                          );
                        })
                      )}
                    </>
                  );
                })()}
              </>
            )}

            {/* Slash: Claude Code sessions (shown alone or in combined view) */}
            {(isCodeSessionSlash || showAllSessions) && (
              <>
                <div className="px-3 py-2 border-b border-white/5">
                  <span className="text-[10px] text-zinc-500 uppercase tracking-wider">
                    Claude Code Sessions
                  </span>
                </div>

                {(() => {
                  const chatCreateOffset = onCreateChatSession ? 1 : 0;
                  const filesCreateOffset = onCreateFilesSession ? 1 : 0;
                  const codeBaseOffset = showAllSessions
                    ? chatCreateOffset +
                      filteredChatSessions.length +
                      filesCreateOffset +
                      filteredFilesSessions.length
                    : 0;
                  return (
                    <>
                      {filteredCodeSessions.length === 0 ? (
                        <div className="px-3 py-3 text-xs text-zinc-500">
                          No Claude Code sessions yet.
                        </div>
                      ) : (
                        filteredCodeSessions.map((s, idx) => {
                          const isSelected = idx + codeBaseOffset === selectedMentionIndex;
                          const isActive = activeCodeSessionId === s.id;
                          return (
                            <button
                              key={s.id}
                              onClick={() => selectCodeSession(s.id)}
                              className={`w-full px-3 py-2 flex items-center gap-3 transition-colors ${
                                isSelected ? "bg-white/10" : "hover:bg-white/5"
                              }`}
                            >
                              <div className="w-8 h-8 rounded-lg bg-sky-500/10 text-sky-400 border border-sky-500/20 flex items-center justify-center">
                                <Terminal className="w-4 h-4" />
                              </div>
                              <div className="flex-1 text-left min-w-0">
                                <div className="text-sm text-white font-medium truncate">
                                  {s.name}
                                  {isActive ? (
                                    <span className="ml-2 text-[10px] text-sky-400">active</span>
                                  ) : null}
                                </div>
                                <div className="text-xs text-zinc-500">Open this code session</div>
                              </div>
                            </button>
                          );
                        })
                      )}
                    </>
                  );
                })()}
              </>
            )}

            {/* Agents section */}
            {!isSlashMode && filteredOptions.some((o) => o.category === "agent") && (
              <>
                <div className="px-3 py-2 border-b border-white/5">
                  <span className="text-[10px] text-zinc-500 uppercase tracking-wider">Agents</span>
                </div>
                {filteredOptions.filter((o) => o.category === "agent").map((option) => {
                  const globalIdx = filteredOptions.indexOf(option);
                  const colors = colorClasses[option.color];
                  return (
                    <button
                      key={option.id}
                      onClick={() => selectMention(option, false)}
                      className={`w-full px-3 py-2 flex items-center gap-3 transition-colors ${
                        globalIdx === selectedMentionIndex ? "bg-white/10" : "hover:bg-white/5"
                      }`}
                    >
                      <div className={`w-8 h-8 rounded-lg ${colors.bg} ${colors.text} flex items-center justify-center`}>
                        {option.icon}
                      </div>
                      <div className="flex-1 text-left">
                        <div className="text-sm text-white font-medium">@{option.label.toLowerCase()}</div>
                        <div className="text-xs text-zinc-500">{option.description}</div>
                      </div>
                    </button>
                  );
                })}
              </>
            )}

            {/* Team section */}
            {!isSlashMode && filteredOptions.some((o) => o.category === "person") && (
              <>
                <div className="px-3 py-2 border-t border-b border-white/5">
                  <span className="text-[10px] text-zinc-500 uppercase tracking-wider">Team</span>
                </div>
                {filteredOptions.filter((o) => o.category === "person").map((option) => {
                  const globalIdx = filteredOptions.indexOf(option);
                  const colors = colorClasses[option.color];
                  return (
                    <button
                      key={option.id}
                      onClick={() => selectMention(option, false)}
                      className={`w-full px-3 py-2 flex items-center gap-3 transition-colors ${
                        globalIdx === selectedMentionIndex ? "bg-white/10" : "hover:bg-white/5"
                      }`}
                    >
                      <div className={`w-8 h-8 rounded-lg ${colors.bg} ${colors.text} flex items-center justify-center`}>
                        {option.icon}
                      </div>
                      <div className="flex-1 text-left">
                        <div className="text-sm text-white font-medium">@{option.id}</div>
                        <div className="text-xs text-zinc-500">{option.description}</div>
                      </div>
                    </button>
                  );
                })}
              </>
            )}

            {/* Providers section */}
            {!isSlashMode && filteredOptions.some((o) => o.category === "provider") && (
              <>
                <div className="px-3 py-2 border-t border-b border-white/5">
                  <span className="text-[10px] text-zinc-500 uppercase tracking-wider">Data Providers</span>
                </div>
                {filteredOptions.filter((o) => o.category === "provider").map((option) => {
                  const globalIdx = filteredOptions.indexOf(option);
                  const colors = colorClasses[option.color];
                  return (
                    <button
                      key={option.id}
                      onClick={() => selectMention(option, false)}
                      className={`w-full px-3 py-2 flex items-center gap-3 transition-colors ${
                        globalIdx === selectedMentionIndex ? "bg-white/10" : "hover:bg-white/5"
                      }`}
                    >
                      <div className={`w-8 h-8 rounded-lg ${colors.bg} ${colors.text} flex items-center justify-center`}>
                        {option.icon}
                      </div>
                      <div className="flex-1 text-left">
                        <div className="text-sm text-white font-medium">@{option.label.toLowerCase()}</div>
                        <div className="text-xs text-zinc-500">{option.description}</div>
                      </div>
                    </button>
                  );
                })}
              </>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Main input container */}
      <div className="bg-zinc-900/80 backdrop-blur-xl border border-white/10 rounded-2xl overflow-hidden">
        {/* Active mention indicator */}
        <AnimatePresence>
          {activeMention && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              className="px-3 pt-2 pb-1 border-b border-white/5"
            >
              <div className="flex items-center gap-2">
                <span className="text-[10px] text-zinc-500 uppercase tracking-wider">Addressing:</span>
                <span
                  className={`px-2 py-0.5 rounded-full text-xs font-medium flex items-center gap-1.5 ${colorClasses[activeMention.color].bg} ${colorClasses[activeMention.color].text} border ${colorClasses[activeMention.color].border}`}
                >
                  {activeMention.icon}
                  {activeMention.label}
                </span>
                <button
                  onClick={() => removeMention(`@${activeMention.id}`)}
                  className="text-zinc-600 hover:text-zinc-400 transition-colors"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Selected files */}
        <AnimatePresence>
          {selectedFiles.length > 0 && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              className="px-3 pt-2 pb-2 border-b border-white/5"
            >
              <div className="flex flex-wrap gap-2">
                {selectedFiles.map((f, idx) => {
                  const Icon = getUploadIcon(f);
                  return (
                    <span
                      key={`${f.name}-${idx}`}
                      className="inline-flex items-center gap-2 px-2.5 py-1 rounded-full bg-white/5 border border-white/10 text-xs text-zinc-200"
                      title={f.name}
                    >
                      <Icon className="w-3.5 h-3.5 text-zinc-400" />
                      <span className="max-w-[220px] truncate">{f.name}</span>
                      <button
                        type="button"
                        onClick={() => removeFile(idx)}
                        className="text-zinc-500 hover:text-zinc-200"
                        title="Remove"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </span>
                  );
                })}
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        <div className="flex items-end gap-2 p-3">
          <input
            ref={fileInputRef}
            type="file"
            accept={FILE_ACCEPT}
            multiple
            className="hidden"
            onChange={onPickFiles}
          />

          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="shrink-0 w-10 h-10 rounded-xl flex items-center justify-center text-zinc-400 bg-white/5 border border-white/10 hover:text-zinc-100 hover:bg-white/10 transition-all"
            title="Attach image or file"
            disabled={isStreaming}
          >
            <Plus className="w-5 h-5" />
          </button>

          {/* #disabled - Voice button removed because of major implementation change (realtime voice)
          <button
            onClick={onVoiceToggle}
            disabled={!voiceEnabled}
            className={`shrink-0 w-10 h-10 rounded-xl flex items-center justify-center transition-all ${
              isListening
                ? "bg-red-500/20 text-red-400 border border-red-500/30"
                : isVoiceConnected
                ? "bg-cyan-500/10 text-cyan-400 border border-cyan-500/20 hover:bg-cyan-500/20"
                : "bg-white/5 text-zinc-500 border border-white/10 hover:bg-white/10"
            } ${!voiceEnabled ? "opacity-50 cursor-not-allowed" : ""}`}
            title={isListening ? "Stop listening" : "Voice input"}
          >
            {isListening ? (
              <motion.div
                animate={{ scale: [1, 1.2, 1] }}
                transition={{ repeat: Infinity, duration: 1 }}
              >
                <MicOff className="w-5 h-5" />
              </motion.div>
            ) : (
              <Mic className="w-5 h-5" />
            )}
          </button>
          */}

          {/* Text input with overlay */}
          <div className="flex-1 min-w-0 relative">
            {/* Colored overlay */}
            {mentionsInInput.length > 0 && !disableMentionOverlay && (
              <div 
                ref={mentionOverlayRef}
                aria-hidden="true"
                className="absolute inset-0 z-20 pointer-events-none py-2.5 px-1 text-base sm:text-sm leading-relaxed whitespace-pre-wrap overflow-auto"
                style={{ maxHeight: "150px", scrollbarWidth: "none" }}
              >
                {renderStyledText}
              </div>
            )}
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              onScroll={syncMentionOverlayScroll}
              placeholder={placeholder}
              rows={1}
              disabled={isStreaming}
              className="w-full bg-transparent placeholder-zinc-500 outline-none resize-none text-base sm:text-sm leading-relaxed py-2.5 px-1 disabled:opacity-50 relative z-10 caret-white"
              style={{ 
                maxHeight: "150px",
                color: "white",
                overflowY: "auto",
              }}
            />
          </div>

          {/* Right side controls */}
          <div className="flex items-center gap-2 shrink-0">
            {/* @ mention button */}
            <button
              onClick={() => {
                setInput((prev) => prev + "@");
                inputRef.current?.focus();
              }}
              className="w-8 h-8 rounded-lg flex items-center justify-center text-zinc-500 hover:text-zinc-300 hover:bg-white/5 transition-all"
              title="Mention agent (@browser, @files, @obsidian, @data, @code)"
            >
              <AtSign className="w-4 h-4" />
            </button>

            {/* Memory toggle */}
            <button
              onClick={onMemoryToggle}
              className={`w-8 h-8 rounded-lg flex items-center justify-center transition-all ${
                memoryEnabled
                  ? "text-violet-400 bg-violet-500/10"
                  : "text-zinc-500 hover:text-zinc-300 hover:bg-white/5"
              }`}
              title={memoryEnabled ? "Memory enabled" : "Memory disabled"}
            >
              <Brain className="w-4 h-4" />
            </button>

            {/* Send/Cancel button */}
            {isStreaming ? (
              <button
                onClick={onCancel}
                className="w-10 h-10 rounded-xl bg-red-500/20 text-red-400 border border-red-500/30 flex items-center justify-center hover:bg-red-500/30 transition-all"
                title="Cancel"
              >
                <X className="w-5 h-5" />
              </button>
            ) : (
              <button
                onClick={handleSend}
                disabled={!input.trim() && selectedFiles.length === 0}
                className={`w-10 h-10 rounded-xl flex items-center justify-center transition-all ${
                  input.trim() || selectedFiles.length > 0
                    ? "bg-cyan-500 text-black hover:bg-cyan-400"
                    : "bg-white/5 text-zinc-500 cursor-not-allowed"
                }`}
                title="Send (Enter)"
              >
                <Send className="w-5 h-5" />
              </button>
            )}
          </div>
        </div>

        {/* Streaming indicator */}
        <AnimatePresence>
          {isStreaming && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              className="border-t border-white/5 px-4 py-2 flex items-center gap-2"
            >
              <Loader2 className="w-4 h-4 text-cyan-400 animate-spin" />
              <span className="text-xs text-zinc-400">Thinking...</span>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Quick tips */}
      <div className="mt-2 px-4 flex items-center justify-center gap-4 text-[10px] text-zinc-600">
        <span>
          <kbd className="px-1.5 py-0.5 rounded bg-white/5 text-zinc-500">Enter</kbd> to send
        </span>
        <span>
          <kbd className="px-1.5 py-0.5 rounded bg-white/5 text-zinc-500">Shift+Enter</kbd> new line
        </span>
        <span>
          <kbd className="px-1.5 py-0.5 rounded bg-white/5 text-zinc-500">@</kbd> or <kbd className="px-1.5 py-0.5 rounded bg-white/5 text-zinc-500">/</kbd> select agent
        </span>
      </div>
    </div>
  );
}
