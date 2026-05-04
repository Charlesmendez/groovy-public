import path from "path";
import { promises as fsp } from "fs";
import { NextResponse } from "next/server";
import { verifyRelayDeviceToken } from "@/lib/relay/deviceToken";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const MAX_WAKEWORD_MODEL_BYTES = 2 * 1024 * 1024;

function trimmed(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeWakeWord(value: unknown): string {
  const raw = trimmed(value).toLowerCase();
  if (!raw) return "hey groovy";
  return raw.replace(/\s+/g, " ");
}

async function loadWakewordModelBytes(): Promise<Buffer | null> {
  const fromBase64 = trimmed(process.env.AIYRA_WAKEWORD_PPN_BASE64);
  if (fromBase64) {
    try {
      const bytes = Buffer.from(fromBase64, "base64");
      if (bytes.length > 0 && bytes.length <= MAX_WAKEWORD_MODEL_BYTES) {
        return bytes;
      }
    } catch {
      // ignore invalid base64 env
    }
  }

  const modelPathRaw = trimmed(
    process.env.AIYRA_WAKEWORD_PPN_PATH ||
      process.env.AIYRA_PORCUPINE_KEYWORD_PATH ||
      ""
  );
  if (!modelPathRaw) return null;
  const modelPath = path.isAbsolute(modelPathRaw)
    ? modelPathRaw
    : path.join(process.cwd(), modelPathRaw);
  try {
    const bytes = await fsp.readFile(modelPath);
    if (bytes.length > 0 && bytes.length <= MAX_WAKEWORD_MODEL_BYTES) {
      return bytes;
    }
  } catch {
    // ignore unreadable path
  }
  return null;
}

export async function GET(req: Request) {
  const relaySecret = trimmed(process.env.RELAY_JWT_SECRET);
  if (!relaySecret) {
    return NextResponse.json({ error: "Missing RELAY_JWT_SECRET" }, { status: 500 });
  }

  const token =
    req.headers.get("x-device-token") || req.headers.get("X-Device-Token") || "";
  const verified = verifyRelayDeviceToken(token, relaySecret);
  if (!verified?.userId || !verified?.deviceId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const wakeWord = normalizeWakeWord(url.searchParams.get("wakeWord"));
  const porcupineAccessKey = trimmed(
    process.env.AIYRA_PORCUPINE_ACCESS_KEY || process.env.PICOVOICE_ACCESS_KEY || ""
  );
  const baseHeaders: Record<string, string> = {
    "cache-control": "no-store",
    "x-aiyra-wake-word": wakeWord,
    ...(porcupineAccessKey
      ? { "x-aiyra-porcupine-access-key": porcupineAccessKey }
      : {}),
  };
  const model = await loadWakewordModelBytes();
  if (!model) {
    return NextResponse.json(
      { error: "Wakeword model is not configured on the server" },
      {
        status: 404,
        headers: baseHeaders,
      }
    );
  }

  return new NextResponse(new Uint8Array(model), {
    status: 200,
    headers: {
      "content-type": "application/octet-stream",
      ...baseHeaders,
    },
  });
}

