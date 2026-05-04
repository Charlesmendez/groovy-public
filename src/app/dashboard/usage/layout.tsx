import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
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
  const { data: membership, error: membershipErr } = await admin
    .from("workspace_members")
    .select("role")
    .eq("user_id", user.id)
    .limit(1)
    .single();

  if (membershipErr || !membership || membership.role !== "admin") {
    redirect("/dashboard");
  }

  return <>{children}</>;
}

