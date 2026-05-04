import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const CURSOR_API_BASE = "https://api.cursor.com/v0";

// POST /api/cursor/validate - Validate API key and optionally fetch repos
export async function POST(req: Request) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => null);
  if (!body) {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const { apiKey, fetchRepos } = body;

  if (!apiKey || typeof apiKey !== "string") {
    return NextResponse.json({ error: "API key is required" }, { status: 400 });
  }

  const authHeader = `Basic ${Buffer.from(apiKey + ":").toString("base64")}`;

  try {
    // Validate by calling /v0/me
    const meRes = await fetch(`${CURSOR_API_BASE}/me`, {
      headers: { Authorization: authHeader },
    });

    if (!meRes.ok) {
      if (meRes.status === 401) {
        return NextResponse.json({ error: "Invalid API key" }, { status: 401 });
      }
      const text = await meRes.text();
      return NextResponse.json(
        { error: `Cursor API error: ${meRes.status} ${text}` },
        { status: meRes.status }
      );
    }

    const meData = await meRes.json();

    // Optionally fetch repositories
    let repositories: Array<{ owner: string; name: string; repository: string }> = [];
    if (fetchRepos) {
      try {
        const reposRes = await fetch(`${CURSOR_API_BASE}/repositories`, {
          headers: { Authorization: authHeader },
        });

        if (reposRes.ok) {
          const reposData = await reposRes.json();
          repositories = reposData.repositories || [];
        } else if (reposRes.status === 429) {
          // Rate limited - return empty array but don't fail
          console.log("Rate limited on /repositories endpoint");
        }
      } catch (e) {
        // Don't fail validation if repos fetch fails
        console.error("Failed to fetch repositories:", e);
      }
    }

    return NextResponse.json({
      valid: true,
      email: meData.userEmail,
      apiKeyName: meData.apiKeyName,
      repositories,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed to validate API key" },
      { status: 500 }
    );
  }
}
