"use client";

import { ArtifactList, ErrorState, LoadingState } from "./common";
import { useDownloadsStatus } from "./useAccountData";

export function DownloadsPanel() {
  const { data, loading, error } = useDownloadsStatus();
  if (loading) return <LoadingState label="Loading downloads..." />;
  if (error === "Unauthorized") return <DownloadAccessPrompt kind="downloads" href="/account/downloads" />;
  if (error) return <ErrorState error={error} />;
  if (!data?.licensed) return <DownloadAccessPrompt kind="downloads" href="/account/downloads" />;
  if (data.canReceiveUpdates === false) {
    return <p className="mt-6 text-sm text-zinc-400">{data.message || "This license cannot access new downloads."}</p>;
  }
  return <ArtifactList items={data.downloads || []} kind="download" />;
}

export function SourceSnapshotsPanel() {
  const { data, loading, error } = useDownloadsStatus();
  if (loading) return <LoadingState label="Loading source snapshots..." />;
  if (error === "Unauthorized") return <DownloadAccessPrompt kind="source snapshots" href="/account/source" />;
  if (error) return <ErrorState error={error} />;
  if (!data?.licensed) return <DownloadAccessPrompt kind="source snapshots" href="/account/source" />;
  if (data.canReceiveUpdates === false) {
    return <p className="mt-6 text-sm text-zinc-400">{data.message || "This license cannot access source snapshots."}</p>;
  }
  return <ArtifactList items={data.sourceSnapshots || []} kind="source" />;
}

function DownloadAccessPrompt({ kind, href }: { kind: "downloads" | "source snapshots"; href: string }) {
  return (
    <div className="mt-8 rounded-lg border border-cyan-400/20 bg-cyan-400/10 p-5">
      <div className="text-sm font-medium text-cyan-100">Licensed access required</div>
      <p className="mt-2 text-sm leading-relaxed text-zinc-300">
        Current Groovy {kind} are available through the account portal for active paid users.
        Buy Groovy Personal or sign in with the account that owns the license.
      </p>
      <div className="mt-4 flex flex-wrap gap-3">
        <a
          href="/pricing?checkout=personal"
          className="rounded-lg bg-cyan-400 px-4 py-2 text-sm font-semibold text-zinc-950 hover:bg-cyan-300"
        >
          Buy Personal
        </a>
        <a
          href={`/login?next=${encodeURIComponent(href)}`}
          className="rounded-lg border border-white/15 px-4 py-2 text-sm font-semibold text-white hover:bg-white/10"
        >
          Sign in
        </a>
      </div>
    </div>
  );
}
