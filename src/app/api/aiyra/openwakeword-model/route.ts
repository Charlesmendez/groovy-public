import path from "path";
import { promises as fsp } from "fs";
import { NextResponse } from "next/server";
import { verifyRelayDeviceToken } from "@/lib/relay/deviceToken";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const MAX_MODEL_BYTES = 20 * 1024 * 1024;

function trimmed(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeWakeWord(value: unknown): string {
  const raw = trimmed(value).toLowerCase();
  if (!raw) return "hey groovy";
  return raw.replace(/\s+/g, " ");
}

function wakeWordEnvSuffix(wakeWord: string): string {
  const raw = wakeWord
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+/, "")
    .replace(/_+$/, "");
  return (raw || "hey_groovy").toUpperCase();
}

function normalizeModelFormat(value: unknown): "onnx" | "tflite" | "" {
  const raw = trimmed(value).toLowerCase().replace(/^\./, "");
  if (raw === "onnx" || raw === "tflite") return raw;
  return "";
}

function detectFormatFromPath(filePath: string): "onnx" | "tflite" | "" {
  const ext = path.extname(filePath).toLowerCase().replace(/^\./, "");
  return normalizeModelFormat(ext);
}

async function fetchModelBytesFromUrl(url: string): Promise<Buffer | null> {
  const target = trimmed(url);
  if (!target) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => {
    try {
      controller.abort();
    } catch {
      // ignore
    }
  }, 12000);
  try {
    const res = await fetch(target, {
      method: "GET",
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length <= 0 || bytes.length > MAX_MODEL_BYTES) return null;
    return bytes;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function loadModelBytesForWakeWord(
  wakeWord: string
): Promise<{ bytes: Buffer; format: "onnx" | "tflite" } | null> {
  const suffix = wakeWordEnvSuffix(wakeWord);
  const format =
    normalizeModelFormat(
      process.env[`AIYRA_OPENWAKEWORD_MODEL_FORMAT_${suffix}`]
    ) || normalizeModelFormat(process.env.AIYRA_OPENWAKEWORD_MODEL_FORMAT);

  const modelUrl =
    trimmed(process.env[`AIYRA_OPENWAKEWORD_MODEL_URL_${suffix}`]) ||
    trimmed(process.env.AIYRA_OPENWAKEWORD_MODEL_URL);
  if (modelUrl) {
    const bytes = await fetchModelBytesFromUrl(modelUrl);
    if (bytes) {
      let detected: "onnx" | "tflite" | "" = "";
      try {
        detected = detectFormatFromPath(new URL(modelUrl).pathname);
      } catch {
        detected = detectFormatFromPath(modelUrl);
      }
      return { bytes, format: format || detected || "onnx" };
    }
  }

  const fromBase64 =
    trimmed(process.env[`AIYRA_OPENWAKEWORD_MODEL_BASE64_${suffix}`]) ||
    trimmed(process.env.AIYRA_OPENWAKEWORD_MODEL_BASE64);
  if (fromBase64) {
    try {
      const bytes = Buffer.from(fromBase64, "base64");
      if (bytes.length > 0 && bytes.length <= MAX_MODEL_BYTES) {
        return { bytes, format: format || "onnx" };
      }
    } catch {
      // ignore invalid base64 env
    }
  }

  const modelPathRaw =
    trimmed(process.env[`AIYRA_OPENWAKEWORD_MODEL_PATH_${suffix}`]) ||
    trimmed(process.env.AIYRA_OPENWAKEWORD_MODEL_PATH);
  if (!modelPathRaw) return null;

  const modelPath = path.isAbsolute(modelPathRaw)
    ? modelPathRaw
    : path.join(process.cwd(), modelPathRaw);
  try {
    const bytes = await fsp.readFile(modelPath);
    if (bytes.length <= 0 || bytes.length > MAX_MODEL_BYTES) return null;
    const detected = detectFormatFromPath(modelPath);
    return { bytes, format: format || detected || "onnx" };
  } catch {
    return null;
  }
}

export async function GET(req: Request) {
  const relaySecret = trimmed(process.env.RELAY_JWT_SECRET);
  if (!relaySecret) {
    return NextResponse.json(
      { error: "Missing RELAY_JWT_SECRET" },
      { status: 500 }
    );
  }

  const token =
    req.headers.get("x-device-token") || req.headers.get("X-Device-Token") || "";
  const verified = verifyRelayDeviceToken(token, relaySecret);
  if (!verified?.userId || !verified?.deviceId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const wakeWord = normalizeWakeWord(url.searchParams.get("wakeWord"));
  const model = await loadModelBytesForWakeWord(wakeWord);

  const baseHeaders: Record<string, string> = {
    "cache-control": "no-store",
    "x-aiyra-wake-word": wakeWord,
  };

  if (!model) {
    return NextResponse.json(
      { error: "OpenWakeWord model is not configured on the server" },
      { status: 404, headers: baseHeaders }
    );
  }

  return new NextResponse(new Uint8Array(model.bytes), {
    status: 200,
    headers: {
      "content-type": "application/octet-stream",
      "x-aiyra-openwakeword-model-format": model.format,
      ...baseHeaders,
    },
  });
}
