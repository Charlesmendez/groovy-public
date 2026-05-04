"use client";

import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Mic, Loader2, X, Square } from "lucide-react";
import { useVoiceControl, VoiceCommand } from "@/hooks/useVoiceControl";

interface VoiceControlProps {
  onCommand: (command: VoiceCommand) => void;
}

export function VoiceControl({ onCommand }: VoiceControlProps) {
  const [transcript, setTranscript] = useState<string>("");
  const [showTranscript, setShowTranscript] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const {
    isListening,
    isConnected,
    isProcessing,
    connect,
    disconnect,
    toggleListening,
  } = useVoiceControl({
    onCommand: (cmd) => {
      onCommand(cmd);
      setShowTranscript(true);
      setTimeout(() => setShowTranscript(false), 2000);
    },
    onTranscript: (text, isFinal) => {
      setTranscript(text);
      if (isFinal) {
        setShowTranscript(true);
        setTimeout(() => {
          setShowTranscript(false);
          setTranscript("");
        }, 3000);
      }
    },
    onError: (err) => {
      setError(err);
      setTimeout(() => setError(null), 5000);
    },
  });

  // Keyboard shortcut: Escape to stop listening
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && isListening) {
        disconnect();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isListening, disconnect]);

  const handleStart = () => {
    if (!isConnected) {
      connect();
    } else {
      toggleListening();
    }
  };

  const handleStop = () => {
    disconnect();
  };

  // When listening, show a full-width stop bar
  if (isListening) {
    return (
      <>
        {/* Listening indicator bar - clicks anywhere to stop */}
        <motion.div
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -10 }}
          className="flex items-center gap-3"
        >
          {/* Pulsing indicator */}
          <div className="flex items-center gap-2">
            <motion.div
              className="w-3 h-3 rounded-full bg-red-500"
              animate={{ scale: [1, 1.3, 1], opacity: [1, 0.5, 1] }}
              transition={{ duration: 1, repeat: Infinity }}
            />
            <span className="text-sm text-red-400 font-medium">Listening...</span>
          </div>

          {/* Big obvious STOP button */}
          <motion.button
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
            onClick={handleStop}
            className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-red-500/20 border border-red-500/40 text-red-400 hover:bg-red-500/30 hover:text-red-300 transition-all font-medium"
          >
            <Square className="w-4 h-4 fill-current" />
            <span>Stop</span>
            <kbd className="ml-1 px-1.5 py-0.5 text-[10px] rounded bg-red-500/20 border border-red-500/30">ESC</kbd>
          </motion.button>
        </motion.div>

        {/* Transcript Popup */}
        <AnimatePresence>
          {showTranscript && transcript && (
            <motion.div
              initial={{ opacity: 0, y: 10, scale: 0.95 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -10, scale: 0.95 }}
              className="absolute top-full mt-2 right-0 w-72 p-3 rounded-xl glass border border-white/10 shadow-xl z-50"
            >
              <p className="text-xs text-zinc-500 mb-1">You said:</p>
              <p className="text-sm text-white">{transcript}</p>
            </motion.div>
          )}
        </AnimatePresence>
      </>
    );
  }

  // Normal state: Hey Groovy button
  return (
    <div className="relative flex items-center gap-1">
      <motion.button
        whileHover={{ scale: 1.05 }}
        whileTap={{ scale: 0.95 }}
        onClick={handleStart}
        className={`
          relative flex items-center gap-2 px-4 py-2.5 rounded-xl font-medium text-sm
          transition-all duration-300
          ${isConnected
            ? "bg-gradient-to-r from-emerald-500 to-emerald-600 text-white shadow-lg shadow-emerald-500/25"
            : "glass hover:bg-white/5 text-zinc-300"
          }
          ${isProcessing ? "opacity-70 cursor-wait" : ""}
        `}
        disabled={isProcessing}
      >
        <div className="flex items-center gap-2">
          {isProcessing ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <Mic className="w-4 h-4" />
          )}
          <span>
            {isProcessing 
              ? "Connecting..." 
              : isConnected 
                ? "Voice Ready" 
                : "Hey Groovy"
            }
          </span>
        </div>
      </motion.button>

      {/* Disconnect X when connected but not listening */}
      {isConnected && (
        <button
          onClick={handleStop}
          className="p-2 rounded-lg hover:bg-white/10 text-zinc-400 hover:text-white transition-colors"
          title="Disconnect voice"
        >
          <X className="w-4 h-4" />
        </button>
      )}

      {/* Error Popup */}
      <AnimatePresence>
        {error && (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="absolute top-full mt-2 right-0 w-64 p-3 rounded-xl bg-red-500/10 border border-red-500/20 text-red-400 text-sm z-50"
          >
            {error}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// API Key Modal
export function ApiKeyModal({ 
  isOpen, 
  onClose, 
  onSave 
}: { 
  isOpen: boolean; 
  onClose: () => void; 
  onSave: (key: string) => void;
}) {
  const [key, setKey] = useState("");

  if (!isOpen) return null;

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={onClose}
    >
      <motion.div
        initial={{ scale: 0.95, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0.95, opacity: 0 }}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md p-6 rounded-2xl glass border border-white/10"
      >
        <h2 className="text-xl font-semibold text-white mb-2">OpenAI API Key</h2>
        <p className="text-sm text-zinc-400 mb-4">
          Enter your OpenAI API key to enable voice control. Your key is stored locally.
        </p>
        
        <input
          type="password"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder="sk-..."
          className="w-full px-4 py-3 rounded-xl bg-black/30 border border-white/10 text-white placeholder-zinc-500 outline-none focus:border-cyan-500/50 transition-colors mb-4"
        />

        <div className="flex gap-3">
          <button
            onClick={onClose}
            className="flex-1 px-4 py-2.5 rounded-xl bg-white/5 text-zinc-300 hover:bg-white/10 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={() => {
              if (key.startsWith("sk-")) {
                onSave(key);
                onClose();
              }
            }}
            disabled={!key.startsWith("sk-")}
            className="flex-1 px-4 py-2.5 rounded-xl bg-cyan-500 text-black font-medium hover:bg-cyan-400 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            Save
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}
