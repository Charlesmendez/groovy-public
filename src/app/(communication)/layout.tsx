import { EmailCacheScopeProvider } from "@/components/email/EmailCacheScope";
import { CommunicationLoginRedirect } from "@/components/navigation/CommunicationLoginRedirect";
import { CommunicationWorkspaceShell } from "@/components/navigation/CommunicationWorkspaceShell";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export default async function CommunicationLayout() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return <CommunicationLoginRedirect />;

  return (
    <EmailCacheScopeProvider scope={user.id}>
      <CommunicationWorkspaceShell />
    </EmailCacheScopeProvider>
  );
}
