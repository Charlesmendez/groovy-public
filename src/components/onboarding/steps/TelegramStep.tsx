"use client";

/**
 * TelegramStep — BotFather bot connect flow.
 *
 * Extracted (behavior-preserving) from WelcomeOnboarding.tsx: render block was
 * lines 1656-1803 plus the inline /api/telegram/setup connect handler.
 */

import { useState } from "react";
import { motion } from "framer-motion";
import { AlertCircle, ArrowRight, CheckCircle2, Send } from "lucide-react";

export type TelegramMode = "connect" | "skip";

type TelegramStepProps = {
  initialMode?: TelegramMode | null;
  /** Persist the selected mode (e.g. saveStep). */
  onModeChange?: (mode: TelegramMode) => void;
  onBack?: () => void;
  onContinue: (mode: TelegramMode) => void;
  hideHeader?: boolean;
  title?: string;
  subtitle?: string;
};

export function TelegramStep({
  initialMode = null,
  onModeChange,
  onBack,
  onContinue,
  hideHeader = false,
  title = "Step 4: Connect Telegram (optional)",
  subtitle = "Connect a Telegram bot to chat with Groovy and receive heartbeats",
}: TelegramStepProps) {
  const [telegramMode, setTelegramMode] = useState<TelegramMode | null>(initialMode);
  const [telegramBotTokenInput, setTelegramBotTokenInput] = useState("");
  const [telegramConnecting, setTelegramConnecting] = useState(false);
  const [telegramConnected, setTelegramConnected] = useState(false);
  const [telegramBotUsername, setTelegramBotUsername] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const selectMode = (mode: TelegramMode) => {
    setTelegramMode(mode);
    onModeChange?.(mode);
  };

  const connectBot = async () => {
    setTelegramConnecting(true);
    setError(null);
    try {
      const res = await fetch("/api/telegram/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "connect", botToken: telegramBotTokenInput.trim() }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(json.error || "Failed to connect bot");
        return;
      }
      setTelegramConnected(true);
      setTelegramBotUsername(json.botUsername || null);
      setTelegramBotTokenInput("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Connection failed");
    } finally {
      setTelegramConnecting(false);
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -20 }}
      className="relative z-10"
    >
      {!hideHeader && (
        <div className="text-center mb-8">
          <h2 className="text-2xl font-semibold text-white mb-2">{title}</h2>
          <p className="text-zinc-500 text-sm">{subtitle}</p>
        </div>
      )}

      {error && (
        <div className="mb-4 p-3 rounded-xl bg-red-500/10 border border-red-500/20 text-red-300 text-sm flex items-center gap-2">
          <AlertCircle className="w-4 h-4 shrink-0" />
          {error}
        </div>
      )}

      <div className="grid gap-4">
        <button
          type="button"
          onClick={() => selectMode("connect")}
          className={`p-5 rounded-2xl border text-left transition-all ${
            telegramMode === "connect"
              ? "bg-cyan-500/15 border-cyan-500/40 text-cyan-200"
              : "bg-zinc-900/80 border-white/10 text-zinc-400 hover:border-white/20"
          }`}
        >
          <div className="flex items-start gap-3">
            <div className="w-10 h-10 rounded-xl bg-cyan-500/10 border border-cyan-500/20 flex items-center justify-center shrink-0">
              <Send className="w-5 h-5 text-cyan-300" />
            </div>
            <div>
              <div className="text-sm font-medium text-white">Connect Telegram Bot</div>
              <div className="text-xs text-zinc-500 mt-1">
                Create a bot via <span className="text-white">@BotFather</span>, paste the token
                below. Works with groups, DMs, and forum topics.
              </div>
            </div>
          </div>
        </button>

        {telegramMode === "connect" && !telegramConnected && (
          <div className="p-4 rounded-2xl border border-cyan-500/20 bg-cyan-500/5 space-y-4">
            <div className="space-y-2">
              <div className="text-xs text-zinc-400">
                <span className="text-white font-medium">1.</span> Open Telegram and message{" "}
                <a
                  href="https://t.me/BotFather"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-cyan-400 hover:underline"
                >
                  @BotFather
                </a>
              </div>
              <div className="text-xs text-zinc-400">
                <span className="text-white font-medium">2.</span> Send{" "}
                <code className="text-cyan-400">/newbot</code>, choose a name and username
              </div>
              <div className="text-xs text-zinc-400">
                <span className="text-white font-medium">3.</span> Copy the bot token and paste it
                below
              </div>
            </div>
            <div>
              <label className="text-xs text-zinc-400 block mb-1">Bot token from @BotFather</label>
              <input
                type="password"
                value={telegramBotTokenInput}
                onChange={(e) => setTelegramBotTokenInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && telegramBotTokenInput.trim() && !telegramConnecting) {
                    void connectBot();
                  }
                }}
                placeholder="123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11"
                className="w-full px-3 py-2 rounded-lg bg-black/40 border border-white/10 text-white text-sm font-mono focus:outline-none focus:border-cyan-500/40"
              />
            </div>
            <button
              type="button"
              disabled={!telegramBotTokenInput.trim() || telegramConnecting}
              onClick={connectBot}
              className="w-full px-4 py-2.5 rounded-xl bg-cyan-500/20 border border-cyan-500/30 text-cyan-200 font-medium text-sm hover:bg-cyan-500/30 transition-all disabled:opacity-50"
            >
              {telegramConnecting ? "Connecting..." : "Connect Bot"}
            </button>
          </div>
        )}

        {telegramMode === "connect" && telegramConnected && (
          <div className="p-4 rounded-2xl border border-emerald-500/20 bg-emerald-500/5 space-y-3">
            <div className="flex items-center gap-2 text-emerald-300 text-sm">
              <CheckCircle2 className="w-4 h-4" />
              Connected as @{telegramBotUsername}
            </div>
            <div className="text-xs text-zinc-400 space-y-1.5">
              <div>
                <span className="text-white font-medium">Next:</span> Add the bot to a Telegram
                group and send <code className="text-cyan-400">/register</code> to activate it.
              </div>
              <div>You can also DM the bot directly for private conversations.</div>
            </div>
          </div>
        )}

        <button
          type="button"
          onClick={() => selectMode("skip")}
          className={`p-4 rounded-2xl border text-left transition-all ${
            telegramMode === "skip"
              ? "bg-white/10 border-white/20 text-white"
              : "bg-black/30 border-white/10 text-zinc-400 hover:border-white/20"
          }`}
        >
          Skip for now
        </button>
      </div>

      <div className="flex items-center gap-3 mt-6">
        {onBack && (
          <button
            type="button"
            onClick={onBack}
            className="px-5 py-3 rounded-xl text-sm text-zinc-400 hover:text-white hover:bg-white/5 transition-all"
          >
            Back
          </button>
        )}
        <button
          type="button"
          onClick={() => onContinue(telegramMode || "skip")}
          className="flex-1 px-5 py-3 rounded-xl bg-cyan-500 text-black font-medium text-sm hover:bg-cyan-400 transition-all flex items-center justify-center gap-2"
        >
          Continue
          <ArrowRight className="w-4 h-4" />
        </button>
      </div>
    </motion.div>
  );
}
