import { NextResponse } from "next/server";

export async function POST() {
  return NextResponse.json(
    {
      error:
        "Session sharing endpoint removed. Use /api/orchestrator/agents/share with agent/conversation identifiers.",
    },
    { status: 410 }
  );
}
