import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import {
  ENTERPRISE_DEMO_ROUTE,
  getEnterpriseDemoConfig,
  isEnterpriseDemoUserId,
} from "@/lib/enterpriseDemo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();

  if (error || !user) {
    return NextResponse.json({
      enabled: false,
      route: ENTERPRISE_DEMO_ROUTE,
    });
  }

  const config = getEnterpriseDemoConfig();
  const enabled = config.enabled && isEnterpriseDemoUserId(user.id);

  return NextResponse.json({
    enabled,
    route: ENTERPRISE_DEMO_ROUTE,
    brandName: enabled ? config.brandName : null,
  });
}
