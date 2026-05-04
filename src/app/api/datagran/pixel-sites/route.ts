import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const DATAGRAN_API_KEY = process.env.DATAGRAN_API_KEY;
const PIXEL_SITES_TIMEOUT_MS = 5_000;

async function fetchPixelSites(apiKey: string) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PIXEL_SITES_TIMEOUT_MS);
  try {
    return await fetch("https://www.datagran.io/api/pixel/sites", {
      headers: { "x-api-key": apiKey },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

// GET: Fetch pixel sites using server-side API key (for authenticated users)
export async function GET() {
  try {
    const supabase = await createSupabaseServerClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Use server-side Datagran API key
    if (!DATAGRAN_API_KEY) {
      return NextResponse.json({ sites: [] }); // No API key configured, return empty
    }

    const res = await fetchPixelSites(DATAGRAN_API_KEY);

    const data = await res.json();

    if (!res.ok) {
      console.error("Datagran pixel sites error:", data);
      return NextResponse.json({ sites: [] }); // Return empty on error
    }

    const sites = Array.isArray(data) ? data : data.sites || [];
    return NextResponse.json({ sites });
  } catch (err) {
    console.error("Pixel sites fetch error:", err);
    return NextResponse.json({ sites: [] });
  }
}

// POST: Fetch pixel sites with user-provided API key (legacy)
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const apiKey = body.apiKey;

    if (!apiKey) {
      return NextResponse.json({ error: "API key required" }, { status: 400 });
    }

    const res = await fetchPixelSites(apiKey);

    const data = await res.json();

    if (!res.ok) {
      return NextResponse.json(
        { error: data.error || "Failed to fetch pixel sites" },
        { status: res.status }
      );
    }

    // Return sites array - handle both array and {sites: []} response formats
    const sites = Array.isArray(data) ? data : data.sites || [];
    return NextResponse.json({ sites });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 }
    );
  }
}
