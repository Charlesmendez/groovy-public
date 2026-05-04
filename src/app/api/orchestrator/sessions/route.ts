import { NextResponse } from "next/server";

function deprecatedResponse() {
  return NextResponse.json(
    {
      error:
        "Session-first orchestrator routes are removed. Use /api/orchestrator/agents and /api/orchestrator/agents/[id].",
    },
    { status: 410 }
  );
}

export async function GET() {
  return deprecatedResponse();
}

export async function POST() {
  return deprecatedResponse();
}

export async function DELETE() {
  return deprecatedResponse();
}

export async function PATCH() {
  return deprecatedResponse();
}
