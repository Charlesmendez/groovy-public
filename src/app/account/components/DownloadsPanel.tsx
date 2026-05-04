"use client";

import { ArtifactList, ErrorState, LoadingState } from "./common";
import { useDownloadsStatus } from "./useAccountData";

export function DownloadsPanel() {
  const { data, loading, error } = useDownloadsStatus();
  if (loading) return <LoadingState label="Loading downloads..." />;
  if (error) return <ErrorState error={error} />;
  if (!data?.licensed) return <p className="mt-6 text-sm text-zinc-400">Buy or activate Groovy to access downloads.</p>;
  if (data.canReceiveUpdates === false) {
    return <p className="mt-6 text-sm text-zinc-400">{data.message || "This license cannot access new downloads."}</p>;
  }
  return <ArtifactList items={data.downloads || []} kind="download" />;
}

export function SourceSnapshotsPanel() {
  const { data, loading, error } = useDownloadsStatus();
  if (loading) return <LoadingState label="Loading source snapshots..." />;
  if (error) return <ErrorState error={error} />;
  if (!data?.licensed) return <p className="mt-6 text-sm text-zinc-400">Buy or activate Groovy to access source snapshots.</p>;
  if (data.canReceiveUpdates === false) {
    return <p className="mt-6 text-sm text-zinc-400">{data.message || "This license cannot access source snapshots."}</p>;
  }
  return <ArtifactList items={data.sourceSnapshots || []} kind="source" />;
}
