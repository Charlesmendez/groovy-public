import { NextResponse } from "next/server";

export async function GET() {
  return NextResponse.json(
    {
      error:
        "Session-first orchestrator route removed. Use /api/orchestrator/agents/[id] instead.",
    },
    { status: 410 }
  );
}
