import type { Artifact } from "./types";

export function formatDate(value?: string | null) {
  if (!value) return "Not available";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "Not available";
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(date);
}

export function Field({ label, value }: { label: string; value: string | number | null | undefined }) {
  return (
    <div className="rounded-lg border border-white/10 bg-white/[0.03] p-4">
      <div className="text-xs uppercase tracking-wide text-zinc-500">{label}</div>
      <div className="mt-2 break-words text-sm text-white">{value ?? "Not available"}</div>
    </div>
  );
}

export function LoadingState({ label }: { label: string }) {
  return <p className="mt-6 text-sm text-zinc-400">{label}</p>;
}

export function ErrorState({ error }: { error: string }) {
  return <p className="mt-6 rounded-lg border border-red-400/20 bg-red-500/10 p-4 text-sm text-red-200">{error}</p>;
}

export function ArtifactList({ items, kind }: { items: Artifact[]; kind: "download" | "source" }) {
  if (!items.length) {
    return <p className="mt-6 text-sm text-zinc-400">No {kind === "download" ? "downloads" : "source snapshots"} are available yet.</p>;
  }
  return (
    <div className="mt-8 space-y-3">
      {items.map((item) => {
        const href = kind === "download" ? item.file_url : item.archive_url;
        return (
          <div key={item.id} className="rounded-lg border border-white/10 bg-white/[0.03] p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="font-medium text-white">
                  {item.version}
                  {item.platform ? <span className="text-zinc-500"> · {item.platform}</span> : null}
                </div>
                <div className="mt-1 text-xs text-zinc-500">
                  {kind === "source" && item.git_ref ? `Git ref: ${item.git_ref} · ` : ""}
                  Added {formatDate(item.created_at)}
                </div>
              </div>
              {href ? (
                <a
                  href={href}
                  className="rounded-lg bg-cyan-400 px-3 py-2 text-sm font-semibold text-zinc-950 hover:bg-cyan-300"
                >
                  Download
                </a>
              ) : (
                <span className="text-sm text-red-300">URL unavailable</span>
              )}
            </div>
            {item.checksum ? (
              <code className="mt-3 block break-all rounded bg-black/30 p-2 text-xs text-zinc-400">
                {item.checksum}
              </code>
            ) : null}
            {item.release_notes_url ? (
              <a className="mt-3 inline-block text-sm text-cyan-300 hover:text-cyan-200" href={item.release_notes_url}>
                Release notes
              </a>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
