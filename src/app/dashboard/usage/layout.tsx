import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { getWorkspaceMembershipForUser } from "@/lib/billing/state";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export default async function UsageLayout({
  children,
}: {
  children: ReactNode;
}) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
    error: authErr,
  } = await supabase.auth.getUser();

  if (authErr || !user) {
    redirect("/login");
  }

  const admin = createSupabaseAdminClient();
  const membership = await getWorkspaceMembershipForUser({
    userId: user.id,
    admin,
  });
  if (!membership || membership.role !== "admin") {
    redirect("/dashboard");
  }

  return <>{children}</>;
}
