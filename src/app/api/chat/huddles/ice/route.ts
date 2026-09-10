import { createHmac } from "node:crypto";
import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type IceServer = {
  urls: string[];
  username?: string;
  credential?: string;
};

function configuredTurnUrls(): string[] {
  return (process.env.CHAT_TURN_URLS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(
      (value) =>
        value.startsWith("turn:") || value.startsWith("turns:"),
    )
    .slice(0, 6);
}

export async function GET() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const iceServers: IceServer[] = [
    {
      urls: [
        "stun:stun.l.google.com:19302",
        "stun:stun1.l.google.com:19302",
      ],
    },
  ];
  const turnUrls = configuredTurnUrls();
  const sharedSecret = process.env.CHAT_TURN_SHARED_SECRET?.trim();
  const staticUsername = process.env.CHAT_TURN_USERNAME?.trim();
  const staticCredential = process.env.CHAT_TURN_CREDENTIAL?.trim();

  if (turnUrls.length > 0 && sharedSecret) {
    // coturn REST credentials expire automatically and avoid exposing a
    // reusable server secret to the browser.
    const expiresAt = Math.floor(Date.now() / 1000) + 60 * 60;
    const username = `${expiresAt}:${user.id}`;
    const credential = createHmac("sha1", sharedSecret)
      .update(username)
      .digest("base64");
    iceServers.push({ urls: turnUrls, username, credential });
  } else if (
    turnUrls.length > 0 &&
    staticUsername &&
    staticCredential
  ) {
    iceServers.push({
      urls: turnUrls,
      username: staticUsername,
      credential: staticCredential,
    });
  }

  return NextResponse.json(
    { iceServers, relayAvailable: iceServers.length > 1 },
    {
      headers: {
        "Cache-Control": "private, no-store",
      },
    },
  );
}
