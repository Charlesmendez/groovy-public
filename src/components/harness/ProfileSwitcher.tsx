"use client";

/**
 * ProfileSwitcher — pick which harness profile ("Mind") powers the command
 * bar. Hidden until the user has at least one profile row, so profile-less
 * installs see zero UI change. Selection is stored client-side
 * (harnessProfileClient) and sent as profileId with each orchestrator turn;
 * the server makes it sticky on the session.
 */

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { AnimatePresence, motion } from "framer-motion";
import { Check, ChevronDown, Sparkles } from "lucide-react";
import {
  BUILT_IN_PROFILE_ID,
  getActiveProfileId,
  setActiveProfileId,
  PROFILE_CHANGED_EVENT,
} from "@/lib/harnessProfileClient";

type ProfileRow = {
  id: string;
  name: string;
  slug: string;
  surface: string;
  is_default: boolean;
};

export function ProfileSwitcher() {
  const [profiles, setProfiles] = useState<ProfileRow[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/harness/profiles", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : { profiles: [] }))
      .then((data) => {
        if (!cancelled) setProfiles(Array.isArray(data.profiles) ? data.profiles : []);
      })
      .catch(() => {});
    const sync = () => setActiveId(getActiveProfileId());
    sync();
    window.addEventListener(PROFILE_CHANGED_EVENT, sync);
    return () => {
      cancelled = true;
      window.removeEventListener(PROFILE_CHANGED_EVENT, sync);
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  if (profiles.length === 0) return null;

  const active =
    activeId === BUILT_IN_PROFILE_ID
      ? null
      : profiles.find((p) => p.id === activeId) ??
        (activeId === null ? profiles.find((p) => p.is_default) ?? null : null);
  const builtInSelected =
    activeId === BUILT_IN_PROFILE_ID ||
    (activeId === null && !profiles.some((profile) => profile.is_default));

  const select = (id: string | null) => {
    setActiveProfileId(id);
    setOpen(false);
  };

  return (
    <div className="relative shrink-0" ref={menuRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex h-9 shrink-0 items-center gap-1.5 rounded-xl bg-white/5 px-2.5 text-zinc-300 transition-colors hover:bg-white/10 hover:text-white"
        title="Mind — which harness profile answers here"
      >
        <Sparkles className="h-3.5 w-3.5 shrink-0 text-purple-400" />
        <span className="hidden max-w-[9rem] truncate text-xs font-medium sm:inline">
          {active ? active.name : "Groovy"}
        </span>
        <ChevronDown className="hidden h-3 w-3 shrink-0 text-zinc-500 sm:block" />
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: 6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 6, scale: 0.98 }}
            transition={{ duration: 0.12 }}
            className="absolute bottom-full left-0 z-30 mb-2 w-64 overflow-hidden rounded-xl border border-white/10 bg-zinc-900/95 shadow-2xl backdrop-blur-xl"
          >
            <div className="border-b border-white/5 px-3 py-1.5 text-[10px] uppercase tracking-wider text-zinc-500">
              Mind for this conversation
            </div>
            <button
              type="button"
              onClick={() => select(BUILT_IN_PROFILE_ID)}
              className="flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors hover:bg-white/5"
            >
              <span className="text-sm text-white">Groovy</span>
              <span className="text-[10px] text-zinc-500">built-in default</span>
              {builtInSelected && <Check className="ml-auto h-3.5 w-3.5 text-cyan-400" />}
            </button>
            {profiles.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => select(p.id)}
                className="flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors hover:bg-white/5"
              >
                <span className="truncate text-sm text-white">{p.name}</span>
                {p.surface === "external" && (
                  <span className="rounded-full border border-amber-400/40 px-1.5 text-[9px] uppercase tracking-wider text-amber-300">
                    external
                  </span>
                )}
                {p.is_default && <span className="text-[10px] text-zinc-500">default</span>}
                {active?.id === p.id && <Check className="ml-auto h-3.5 w-3.5 text-cyan-400" />}
              </button>
            ))}
            <Link
              href="/dashboard/harness"
              className="block border-t border-white/5 px-3 py-2 text-xs text-zinc-400 transition-colors hover:bg-white/5 hover:text-white"
            >
              Manage minds →
            </Link>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
