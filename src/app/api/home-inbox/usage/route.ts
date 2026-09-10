import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { readHomeJson } from "@/lib/homeInbox/boundedJson";
import { homeInboxOrigin } from "@/lib/homeInbox/homeClient";
import {
  groovyUsageReport,
  usageWindowSchema,
} from "@/lib/homeInbox/reporting";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "cache-control": "private, no-store" };
const failure = (error: string, status: number) =>
  NextResponse.json({ error }, { status, headers });

/** Home is the trusted reader and MUST authorize its current session for this
 * product/project before requesting and again before displaying this report.
 * A separate server secret grants reporting only, not execution or billing. */
export async function POST(request: Request) {
  const expected = process.env.DATAGRAN_HOME_REPORTING_SECRET;
  const received = request.headers.get("x-datagran-platform-secret");
  if (
    !expected ||
    expected.length < 32 ||
    !received ||
    received.length > 4096 ||
    Buffer.byteLength(expected) !== Buffer.byteLength(received) ||
    !timingSafeEqual(Buffer.from(expected), Buffer.from(received))
  )
    return failure("unauthorized_platform", 401);
  if (
    request.headers.get("content-type")?.split(";")[0].trim() !==
    "application/json"
  )
    return failure("invalid_content_type", 415);
  try {
    const body = await readHomeJson(request, 4096, AbortSignal.timeout(5000));
    const parsed = usageWindowSchema.safeParse(body);
    if (!parsed.success) return failure("invalid_usage_scope", 400);
    const admin = createSupabaseAdminClient();
    const report = await groovyUsageReport(parsed.data, {
      homeOrigin: homeInboxOrigin(),
      query: async (params) => admin.rpc("home_inbox_usage_report", params),
    });
    return NextResponse.json(report, { headers });
  } catch {
    return failure("usage_report_unavailable", 503);
  }
}
