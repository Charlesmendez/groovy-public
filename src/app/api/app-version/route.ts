import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export function GET() {
  const revision =
    process.env.VERCEL_DEPLOYMENT_ID ||
    process.env.VERCEL_URL ||
    process.env.VERCEL_GIT_COMMIT_SHA ||
    process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA ||
    "local";

  return NextResponse.json(
    { revision },
    {
      headers: {
        "Cache-Control": "no-store, max-age=0",
      },
    }
  );
}
