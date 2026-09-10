import { redirect } from "next/navigation";
import { DesktopDatagranConnect } from "@/components/datagran/DesktopDatagranConnect";
import { providerUsesDesktopBrowserOAuth } from "@/lib/datagran/desktopConnect";
import type { DatagranProvider } from "@/lib/datagran/prompts";
import { createSupabaseServerClient } from "@/lib/supabase/server";

function value(input: string | string[] | undefined): string {
  return typeof input === "string" ? input.trim() : "";
}

export default async function DesktopDatagranConnectPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const providerValue = value(params.provider);
  const agentId = value(params.agentId);
  const recipientTracking = value(params.recipientTracking) === "1";
  if (
    !providerUsesDesktopBrowserOAuth(providerValue as DatagranProvider)
  ) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-[#09090b] px-6 text-white">
        <p className="text-sm text-red-300">
          This integration cannot be connected from the desktop handoff.
        </p>
      </main>
    );
  }
  const provider = providerValue as DatagranProvider;

  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    const next = new URLSearchParams({ provider });
    if (agentId) next.set("agentId", agentId);
    if (recipientTracking) next.set("recipientTracking", "1");
    redirect(
      `/login?next=${encodeURIComponent(`/connect/datagran?${next.toString()}`)}`,
    );
  }

  return (
    <DesktopDatagranConnect
      provider={provider}
      agentId={agentId || undefined}
      recipientTracking={recipientTracking}
    />
  );
}
