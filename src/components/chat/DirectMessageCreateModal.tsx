"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Search, Users, X } from "lucide-react";

export type DirectMessagePersonOption = {
  userId: string;
  label: string;
  email?: string | null;
  role?: "admin" | "member" | "guest";
};

export function DirectMessageCreateModal({
  people,
  onClose,
  onStart,
}: {
  people: DirectMessagePersonOption[];
  onClose: () => void;
  onStart: (userIds: string[]) => Promise<void>;
}) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [busy, onClose]);

  const visiblePeople = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) return people;
    return people.filter((person) =>
      [person.label, person.email, person.role].some((value) =>
        String(value || "")
          .toLowerCase()
          .includes(normalizedQuery),
      ),
    );
  }, [people, query]);

  const togglePerson = (userId: string) => {
    setSelected((current) =>
      current.includes(userId)
        ? current.filter((candidate) => candidate !== userId)
        : [...current, userId],
    );
    setError(null);
  };

  const startConversation = async () => {
    if (selected.length === 0 || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onStart(selected);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not start this conversation.",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[60] flex items-end justify-center bg-black/75 backdrop-blur-sm sm:items-center sm:p-4"
      onClick={() => {
        if (!busy) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-direct-message-title"
        className="flex max-h-[88dvh] w-full max-w-lg flex-col overflow-hidden rounded-t-2xl border border-white/10 bg-[#0b0c10] shadow-2xl sm:rounded-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="flex items-start gap-3 border-b border-white/10 px-5 py-4">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-cyan-300/20 bg-cyan-300/[0.07] text-cyan-300">
            <Users className="h-4 w-4" />
          </span>
          <div className="min-w-0 flex-1">
            <h2
              id="new-direct-message-title"
              className="text-base font-semibold text-white"
            >
              New direct message
            </h2>
            <p className="mt-0.5 text-xs text-zinc-500">
              Choose one person or create a private group conversation.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="flex h-9 w-9 items-center justify-center rounded-lg text-zinc-500 transition hover:bg-white/5 hover:text-white disabled:opacity-40"
            aria-label="Close new direct message"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="border-b border-white/[0.07] p-4">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-600" />
            <input
              ref={searchRef}
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search people"
              className="w-full rounded-xl border border-white/10 bg-black/25 py-2.5 pl-10 pr-3 text-sm text-white outline-none placeholder:text-zinc-600 focus:border-cyan-400/40 focus:ring-2 focus:ring-cyan-400/10"
              aria-label="Search people for a direct message"
            />
          </div>
          {selected.length > 0 ? (
            <p className="mt-2 text-[11px] text-cyan-300">
              {selected.length}{" "}
              {selected.length === 1 ? "person selected" : "people selected"}
            </p>
          ) : null}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          {visiblePeople.length > 0 ? (
            <div className="space-y-1">
              {visiblePeople.map((person) => {
                const checked = selected.includes(person.userId);
                return (
                  <button
                    key={person.userId}
                    type="button"
                    role="checkbox"
                    aria-checked={checked}
                    onClick={() => togglePerson(person.userId)}
                    className={`group flex w-full cursor-pointer items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition ${
                      checked
                        ? "border-cyan-300/30 bg-cyan-300/[0.08]"
                        : "border-transparent hover:border-white/10 hover:bg-white/[0.045]"
                    }`}
                  >
                    <span
                      className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${
                        checked
                          ? "bg-cyan-300 text-[#071014]"
                          : "bg-white/[0.06] text-zinc-400 group-hover:bg-white/[0.09] group-hover:text-white"
                      }`}
                    >
                      {person.label.trim().slice(0, 1).toUpperCase() || "?"}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm text-zinc-100">
                        {person.label}
                      </span>
                      <span className="block truncate text-[10px] text-zinc-600">
                        {person.email || person.role || "Workspace member"}
                      </span>
                    </span>
                    <span
                      className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-md border ${
                        checked
                          ? "border-cyan-300 bg-cyan-300 text-[#071014]"
                          : "border-white/15"
                      }`}
                      aria-hidden="true"
                    >
                      {checked ? <Check className="h-3.5 w-3.5" /> : null}
                    </span>
                  </button>
                );
              })}
            </div>
          ) : (
            <p className="px-3 py-8 text-center text-sm text-zinc-600">
              {people.length === 0
                ? "No teammates are available yet."
                : `No people match “${query.trim()}”.`}
            </p>
          )}
        </div>

        <footer className="border-t border-white/10 bg-black/15 px-5 py-4">
          {error ? (
            <p className="mb-3 text-xs text-red-300" role="alert">
              {error}
            </p>
          ) : null}
          <div className="flex items-center justify-between gap-4">
            <p className="text-[10px] leading-relaxed text-zinc-600">
              Only the selected people can open this conversation.
            </p>
            <button
              type="button"
              onClick={() => void startConversation()}
              disabled={selected.length === 0 || busy}
              className="shrink-0 rounded-xl bg-cyan-300 px-4 py-2.5 text-sm font-semibold text-[#071014] transition hover:bg-cyan-200 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {busy
                ? "Starting…"
                : selected.length > 1
                  ? "Start group DM"
                  : "Start message"}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
