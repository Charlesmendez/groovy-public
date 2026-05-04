import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import {
  ENTERPRISE_DEMO_ROUTE,
  getEnterpriseDemoConfig,
  isEnterpriseDemoUserId,
} from "@/lib/enterpriseDemo";
import { EnterpriseReviewShell } from "@/components/enterprise/EnterpriseReviewShell";

export const dynamic = "force-dynamic";

export default async function EnterpriseReviewPage() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();

  if (error || !user) {
    redirect(`/login?next=${encodeURIComponent(ENTERPRISE_DEMO_ROUTE)}`);
  }

  const config = getEnterpriseDemoConfig();
  if (!config.enabled || !isEnterpriseDemoUserId(user.id)) {
    redirect("/dashboard");
  }

  return (
    <EnterpriseReviewShell
      brandName={config.brandName}
      logoUrl={config.logoUrl}
      userEmail={user.email || null}
    />
  );
}
