import WebSocket from "ws";
import os from "os";
import path from "path";
import { promises as fsp } from "fs";
import { fileURLToPath } from "url";
import { spawn } from "child_process";
import { createAecProcessor, normalizeAecBackend } from "./aec.mjs";
import { createRnnoiseProcessor } from "./rnnoise.mjs";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const OPENWAKEWORD_WAKE_FRAME_LENGTH = 1280;
const VOICE_PLAYBACK_SAMPLE_RATE = 24000;
const VOICE_PLAYBACK_CHANNELS = 1;
const VOICE_PLAYBACK_BYTES_PER_SAMPLE = 2;
const DEFAULT_OPENWAKEWORD_THRESHOLD = 0.27;
const DEFAULT_OPENWAKEWORD_ALLOW_APPROXIMATE = false;

function trimmed(value) {
  return typeof value === "string" ? value.trim() : "";
}

function toFiniteNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function normalizeMultiple(value, step, fallback, min = step) {
  const rounded = Math.round(toFiniteNumber(value, fallback) / step) * step;
  return Math.max(min, rounded);
}

function greatestCommonDivisor(a, b) {
  let x = Math.max(1, Math.abs(Math.trunc(a)));
  let y = Math.max(1, Math.abs(Math.trunc(b)));
  while (y !== 0) {
    const next = x % y;
    x = y;
    y = next;
  }
  return x;
}

function leastCommonMultiple(a, b) {
  const x = Math.max(1, Math.abs(Math.trunc(a)));
  const y = Math.max(1, Math.abs(Math.trunc(b)));
  return (x / greatestCommonDivisor(x, y)) * y;
}

function parseBooleanLike(value, fallback = false) {
  if (typeof value === "boolean") return value;
  const s = trimmed(value).toLowerCase();
  if (!s) return fallback;
  if (["1", "true", "yes", "on"].includes(s)) return true;
  if (["0", "false", "no", "off"].includes(s)) return false;
  return fallback;
}

function pcm16ToBase64(int16Samples) {
  return Buffer.from(
    int16Samples.buffer,
    int16Samples.byteOffset,
    int16Samples.byteLength
  ).toString("base64");
}

function pcm16ToBuffer(int16Samples) {
  return Buffer.from(
    int16Samples.buffer,
    int16Samples.byteOffset,
    int16Samples.byteLength
  );
}

function buildThinkingPulseBuffer({
  sampleRate = VOICE_PLAYBACK_SAMPLE_RATE,
  toneMs = 150,
  tailMs = 140,
  baseFrequencyHz = 880,
  pitchDropCents = -90,
  volume = 0.24,
  shimmerRatio = 2.63,
  shimmerGain = 0.08,
  roomDelayMs = 72,
  roomGain = 0.1,
} = {}) {
  const tailSamples = Math.max(0, Math.round((sampleRate * tailMs) / 1000));
  const toneSamples = Math.max(1, Math.round((sampleRate * toneMs) / 1000));
  const roomDelaySamples = Math.max(0, Math.round((sampleRate * roomDelayMs) / 1000));
  const totalSamples = toneSamples + tailSamples + roomDelaySamples;
  const out = new Float32Array(totalSamples);
  const amplitude = clamp(volume, 0.01, 0.4);
  const safeShimmerGain = clamp(shimmerGain, 0, 0.18);
  const safeRoomGain = clamp(roomGain, 0, 0.25);

  let phase = 0;
  let shimmerPhase = 0;
  for (let i = 0; i < toneSamples; i += 1) {
    const progress = toneSamples <= 1 ? 1 : i / (toneSamples - 1);
    const frequencyHz =
      baseFrequencyHz * 2 ** ((pitchDropCents * progress) / 1200);
    const attack = Math.sin((Math.PI * clamp(progress / 0.12, 0, 1)) / 2) ** 2;
    const decay = Math.exp(-5.2 * progress);
    const envelope = attack * decay;
    phase += (2 * Math.PI * frequencyHz) / sampleRate;
    shimmerPhase += (2 * Math.PI * frequencyHz * shimmerRatio) / sampleRate;
    const fundamental = Math.sin(phase);
    const shimmer = Math.sin(shimmerPhase);
    const sample = fundamental * 0.94 + shimmer * safeShimmerGain;
    out[i] += sample * amplitude * envelope;
  }

  if (roomDelaySamples > 0 && safeRoomGain > 0) {
    for (let i = 0; i + roomDelaySamples < out.length; i += 1) {
      const progress = toneSamples <= 1 ? 1 : Math.min(1, i / toneSamples);
      const roomDecay = Math.exp(-3.8 * progress);
      out[i + roomDelaySamples] += out[i] * safeRoomGain * roomDecay;
    }
  }

  const pcm = new Int16Array(totalSamples);
  for (let i = 0; i < totalSamples; i += 1) {
    pcm[i] = Math.round(clamp(out[i], -1, 1) * 32767);
  }

  return pcm16ToBuffer(pcm);
}

function pcm16ByteDurationMs(
  byteLength,
  sampleRate = VOICE_PLAYBACK_SAMPLE_RATE,
  channels = VOICE_PLAYBACK_CHANNELS
) {
  const bytesPerFrame =
    Math.max(1, channels) * VOICE_PLAYBACK_BYTES_PER_SAMPLE;
  const frames = Math.max(0, Math.trunc(byteLength / bytesPerFrame));
  if (!frames) return 0;
  return (frames * 1000) / Math.max(1, sampleRate);
}

function resamplePcm16(input, inputRate, outputRate) {
  if (!input || input.length === 0) return new Int16Array(0);
  if (inputRate === outputRate) return input;
  const ratio = outputRate / inputRate;
  const outLength = Math.max(1, Math.floor(input.length * ratio));
  const out = new Int16Array(outLength);
  for (let i = 0; i < outLength; i += 1) {
    const src = i / ratio;
    const i0 = Math.floor(src);
    const i1 = Math.min(i0 + 1, input.length - 1);
    const frac = src - i0;
    const v0 = input[i0];
    const v1 = input[i1];
    out[i] = Math.round(v0 + (v1 - v0) * frac);
  }
  return out;
}

function upsamplePcm16(input, inputRate = 16000, outputRate = 24000) {
  return resamplePcm16(input, inputRate, outputRate);
}

function downsamplePlaybackBuffer(buffer, fromRate, toRate) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4 || fromRate === toRate) return buffer;
  const sampleCount = Math.floor(buffer.length / 2);
  const input = new Int16Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    input[i] = buffer.readInt16LE(i * 2);
  }
  const resampled = resamplePcm16(input, fromRate, toRate);
  return Buffer.from(resampled.buffer, resampled.byteOffset, resampled.byteLength);
}

function smoothToward(current, target, ratio) {
  const start = Math.max(0, toFiniteNumber(current, 0));
  const goal = Math.max(0, toFiniteNumber(target, start));
  const mix = clamp(toFiniteNumber(ratio, 0.5), 0, 1);
  return start + (goal - start) * mix;
}

function framePeakAbs(int16Samples) {
  if (!int16Samples || int16Samples.length === 0) return 0;
  let peak = 0;
  for (let i = 0; i < int16Samples.length; i += 1) {
    const abs = Math.abs(int16Samples[i] || 0);
    if (abs > peak) peak = abs;
  }
  return peak;
}

function safeRatio(numerator, denominator) {
  const num = toFiniteNumber(numerator, 0);
  const den = Math.max(0, toFiniteNumber(denominator, 0));
  if (!Number.isFinite(num) || den <= 0.0001) return null;
  return num / den;
}

function scalePcm16Frame(int16Samples, gain, maxAbsSample = 32767) {
  if (!int16Samples || int16Samples.length === 0) {
    return { frame: new Int16Array(0), clippedSamples: 0, peakAbs: 0 };
  }
  const safeGain = Math.max(0, toFiniteNumber(gain, 1));
  const clipLimit = clamp(Math.round(toFiniteNumber(maxAbsSample, 32767)), 1, 32767);
  if (safeGain <= 1.0001) {
    return {
      frame: int16Samples,
      clippedSamples: 0,
      peakAbs: framePeakAbs(int16Samples),
    };
  }
  const out = new Int16Array(int16Samples.length);
  let clippedSamples = 0;
  let peakAbs = 0;
  for (let i = 0; i < int16Samples.length; i += 1) {
    const scaled = Math.round((int16Samples[i] || 0) * safeGain);
    const clipped = Math.max(-clipLimit, Math.min(clipLimit, scaled));
    if (clipped !== scaled) clippedSamples += 1;
    out[i] = clipped;
    const abs = Math.abs(clipped);
    if (abs > peakAbs) peakAbs = abs;
  }
  return { frame: out, clippedSamples, peakAbs };
}

function applyVoiceCaptureGainCompensation({
  frame,
  rawRms,
  processedRms,
  currentGain = 1,
  speechFloorRms = 180,
  targetRms = 1800,
  maxGain = 4,
  attack = 0.55,
  release = 0.2,
  clipHeadroom = 0.92,
}) {
  if (!(frame instanceof Int16Array) || frame.length === 0) {
    return {
      frame: new Int16Array(0),
      inputRms: 0,
      outputRms: 0,
      inputPeakAbs: 0,
      outputPeakAbs: 0,
      targetGain: 1,
      appliedGain: 1,
      nextGain: 1,
      clippedSamples: 0,
      meaningfulSpeech: false,
    };
  }

  const inputRms = Math.max(0, toFiniteNumber(processedRms, frameRms(frame)));
  const referenceRms = Math.max(0, toFiniteNumber(rawRms, inputRms));
  const floorRms = Math.max(1, toFiniteNumber(speechFloorRms, 180));
  const desiredTargetRms = Math.max(floorRms, toFiniteNumber(targetRms, 1800));
  const safeMaxGain = Math.max(1, toFiniteNumber(maxGain, 4));
  const meaningfulSpeech =
    referenceRms >= floorRms || inputRms >= Math.max(24, Math.round(floorRms * 0.7));
  const attenuatedSignal =
    meaningfulSpeech && inputRms > 0 && referenceRms > 0 && inputRms < referenceRms * 0.92;

  let targetGain = 1;
  if (meaningfulSpeech && inputRms > 0 && (attenuatedSignal || inputRms < desiredTargetRms)) {
    const preserveGain = referenceRms > 0 ? referenceRms / inputRms : 1;
    const floorGain = desiredTargetRms / inputRms;
    targetGain = clamp(Math.max(1, preserveGain, floorGain), 1, safeMaxGain);
  }

  const safeCurrentGain = Math.max(1, toFiniteNumber(currentGain, 1));
  const smoothedGain = smoothToward(
    safeCurrentGain,
    targetGain,
    targetGain >= safeCurrentGain ? attack : release
  );
  const clipLimit = Math.max(
    1,
    Math.round(32767 * clamp(toFiniteNumber(clipHeadroom, 0.92), 0.25, 1))
  );
  const peakAbs = framePeakAbs(frame);
  const appliedGain = peakAbs > 0 ? Math.min(smoothedGain, clipLimit / peakAbs) : smoothedGain;

  if (appliedGain <= 1.0001) {
    return {
      frame,
      inputRms,
      outputRms: inputRms,
      inputPeakAbs: peakAbs,
      outputPeakAbs: peakAbs,
      targetGain,
      appliedGain: 1,
      nextGain: 1,
      clippedSamples: 0,
      meaningfulSpeech,
    };
  }

  const scaled = scalePcm16Frame(frame, appliedGain, clipLimit);
  return {
    frame: scaled.frame,
    inputRms,
    outputRms: frameRms(scaled.frame),
    inputPeakAbs: peakAbs,
    outputPeakAbs: scaled.peakAbs,
    targetGain,
    appliedGain,
    nextGain: appliedGain,
    clippedSamples: scaled.clippedSamples,
    meaningfulSpeech,
  };
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function wakeWordSlug(wakeWord) {
  const raw = trimmed(wakeWord).toLowerCase();
  if (!raw) return "hey-groovy";
  const slug = raw
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
  return slug || "hey-groovy";
}

async function pathExists(filePath) {
  const candidate = trimmed(filePath);
  if (!candidate) return false;
  try {
    await fsp.access(candidate);
    return true;
  } catch {
    return false;
  }
}

function normalizeBaseUrl(url) {
  return trimmed(url).replace(/\/+$/, "");
}

async function fetchWakewordModelFromServer({
  appUrl,
  deviceToken,
  wakeWord,
  onLog,
  onWarn,
}) {
  const baseUrl = normalizeBaseUrl(appUrl);
  if (!baseUrl || !deviceToken) {
    return { bytes: null, porcupineAccessKey: "" };
  }

  const endpoint = `${baseUrl}/api/aiyra/wakeword-model?wakeWord=${encodeURIComponent(
    wakeWord
  )}`;
  const controller = new AbortController();
  const timer = setTimeout(() => {
    try {
      controller.abort();
    } catch {
      // ignore
    }
  }, 12000);

  try {
    const res = await fetch(endpoint, {
      method: "GET",
      headers: {
        "x-device-token": deviceToken,
      },
      signal: controller.signal,
    });
    const serverPorcupineAccessKey = trimmed(
      res.headers.get("x-aiyra-porcupine-access-key") || ""
    );
    if (res.status === 204 || res.status === 404) {
      onLog("aiyra wakeword model not configured server-side", {
        status: res.status,
      });
      return { bytes: null, porcupineAccessKey: serverPorcupineAccessKey };
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      onWarn("aiyra wakeword model fetch failed", {
        status: res.status,
        body: text.slice(0, 180),
      });
      return { bytes: null, porcupineAccessKey: serverPorcupineAccessKey };
    }
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length === 0) {
      onWarn("aiyra wakeword model fetch returned empty payload");
      return { bytes: null, porcupineAccessKey: serverPorcupineAccessKey };
    }
    return { bytes, porcupineAccessKey: serverPorcupineAccessKey };
  } catch (error) {
    onWarn("aiyra wakeword model fetch error", {
      error: error instanceof Error ? error.message : String(error),
    });
    return { bytes: null, porcupineAccessKey: "" };
  } finally {
    clearTimeout(timer);
  }
}

async function resolveKeywordPath({
  appUrl,
  deviceToken,
  wakeWord,
  explicitKeywordPath,
  onLog,
  onWarn,
}) {
  const wakeSlug = wakeWordSlug(wakeWord);
  const cacheDir = path.join(os.homedir(), ".groovy", "wakewords");
  const cachePath = path.join(cacheDir, `${wakeSlug}.ppn`);

  const explicit = trimmed(explicitKeywordPath);
  const candidates = [
    explicit,
    trimmed(process.env.AIYRA_WAKEWORD_PPN_PATH),
    trimmed(process.env.AIYRA_PORCUPINE_KEYWORD_PATH),
    path.join(MODULE_DIR, "wakewords", `${wakeSlug}.ppn`),
    path.join(MODULE_DIR, "wakewords", "hey-groovy.ppn"),
    cachePath,
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (await pathExists(candidate)) {
      return { keywordPath: candidate, porcupineAccessKey: "" };
    }
  }

  const fetched = await fetchWakewordModelFromServer({
    appUrl,
    deviceToken,
    wakeWord,
    onLog,
    onWarn,
  });
  if (!fetched?.bytes) {
    return {
      keywordPath: "",
      porcupineAccessKey: trimmed(fetched?.porcupineAccessKey),
    };
  }

  try {
    await fsp.mkdir(cacheDir, { recursive: true });
    await fsp.writeFile(cachePath, fetched.bytes);
    onLog("aiyra wakeword model cached", { path: cachePath });
    return {
      keywordPath: cachePath,
      porcupineAccessKey: trimmed(fetched.porcupineAccessKey),
    };
  } catch (error) {
    onWarn("failed to cache wakeword model", {
      path: cachePath,
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      keywordPath: "",
      porcupineAccessKey: trimmed(fetched.porcupineAccessKey),
    };
  }
}

function normalizeOpenWakewordFormat(value) {
  const raw = trimmed(value).toLowerCase().replace(/^\./, "");
  if (raw === "onnx" || raw === "tflite") return raw;
  return "";
}

async function fetchOpenWakewordModelFromServer({
  appUrl,
  deviceToken,
  wakeWord,
  onLog,
  onWarn,
}) {
  const baseUrl = normalizeBaseUrl(appUrl);
  if (!baseUrl || !deviceToken) {
    return { bytes: null, format: "" };
  }

  const endpoint = `${baseUrl}/api/aiyra/openwakeword-model?wakeWord=${encodeURIComponent(
    wakeWord
  )}`;
  const controller = new AbortController();
  const timer = setTimeout(() => {
    try {
      controller.abort();
    } catch {
      // ignore
    }
  }, 12000);

  try {
    const res = await fetch(endpoint, {
      method: "GET",
      headers: {
        "x-device-token": deviceToken,
      },
      signal: controller.signal,
    });
    const format = normalizeOpenWakewordFormat(
      res.headers.get("x-aiyra-openwakeword-model-format") ||
        res.headers.get("x-aiyra-openwakeword-format") ||
        ""
    );
    if (res.status === 204 || res.status === 404) {
      onLog("aiyra openwakeword model not configured server-side", {
        status: res.status,
      });
      return { bytes: null, format };
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      onWarn("aiyra openwakeword model fetch failed", {
        status: res.status,
        body: text.slice(0, 180),
      });
      return { bytes: null, format };
    }
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length === 0) {
      onWarn("aiyra openwakeword model fetch returned empty payload");
      return { bytes: null, format };
    }
    return { bytes, format };
  } catch (error) {
    onWarn("aiyra openwakeword model fetch error", {
      error: error instanceof Error ? error.message : String(error),
    });
    return { bytes: null, format: "" };
  } finally {
    clearTimeout(timer);
  }
}

async function resolveOpenWakewordModelPath({
  appUrl,
  deviceToken,
  wakeWord,
  explicitModelPath,
  onLog,
  onWarn,
}) {
  const wakeSlug = wakeWordSlug(wakeWord);
  const cacheDir = path.join(os.homedir(), ".groovy", "openwakeword");
  const cacheOnnx = path.join(cacheDir, `${wakeSlug}.onnx`);
  const cacheTflite = path.join(cacheDir, `${wakeSlug}.tflite`);

  const explicit = trimmed(explicitModelPath);
  const candidates = [
    explicit,
    trimmed(process.env.AIYRA_OPENWAKEWORD_MODEL_PATH),
    path.join(MODULE_DIR, "platform", "wake", "models", `${wakeSlug}.onnx`),
    path.join(MODULE_DIR, "platform", "wake", "models", `${wakeSlug}.tflite`),
    path.join(MODULE_DIR, "platform", "wake", "models", "hey-groovy.onnx"),
    path.join(MODULE_DIR, "platform", "wake", "models", "hey-groovy.tflite"),
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (await pathExists(candidate)) {
      return candidate;
    }
  }

  const fetched = await fetchOpenWakewordModelFromServer({
    appUrl,
    deviceToken,
    wakeWord,
    onLog,
    onWarn,
  });
  if (!fetched?.bytes) {
    for (const cacheCandidate of [cacheOnnx, cacheTflite]) {
      if (await pathExists(cacheCandidate)) {
        onLog("using cached openwakeword model", { path: cacheCandidate });
        return cacheCandidate;
      }
    }
    return "";
  }

  const format = fetched.format || "onnx";
  const ext = normalizeOpenWakewordFormat(format) || "onnx";
  const cachePath = path.join(cacheDir, `${wakeSlug}.${ext}`);
  try {
    await fsp.mkdir(cacheDir, { recursive: true });
    await fsp.writeFile(cachePath, fetched.bytes);
    onLog("aiyra openwakeword model cached", {
      path: cachePath,
      format: ext,
      bytes: fetched.bytes.length,
    });
    return cachePath;
  } catch (error) {
    onWarn("failed to cache openwakeword model", {
      path: cachePath,
      error: error instanceof Error ? error.message : String(error),
    });
    return "";
  }
}

function resolveBuiltinWakeword(wakeWord, BuiltinKeyword) {
  if (!BuiltinKeyword || typeof BuiltinKeyword !== "object") return null;
  const normalized = wakeWordSlug(wakeWord).replace(/-/g, " ");
  const phraseToKey = {
    alexa: "ALEXA",
    americano: "AMERICANO",
    blueberry: "BLUEBERRY",
    bumblebee: "BUMBLEBEE",
    computer: "COMPUTER",
    grapefruit: "GRAPEFRUIT",
    grasshopper: "GRASSHOPPER",
    "hey google": "HEY_GOOGLE",
    "hey siri": "HEY_SIRI",
    jarvis: "JARVIS",
    "ok google": "OK_GOOGLE",
    picovoice: "PICOVOICE",
    porcupine: "PORCUPINE",
    terminator: "TERMINATOR",
    // Practical fallback so runtime works out-of-box until a custom "hey groovy" model is configured.
    "hey groovy": "PORCUPINE",
  };
  const key = phraseToKey[normalized];
  if (!key) return null;
  const keywordValue = BuiltinKeyword[key];
  if (!keywordValue) return null;
  return {
    keywordValue,
    builtinName: key,
    effectiveWakeWord: key.toLowerCase().replace(/_/g, " "),
  };
}

function uniqueNonEmpty(values) {
  const out = [];
  for (const value of values) {
    const v = trimmed(value);
    if (!v) continue;
    if (out.includes(v)) continue;
    out.push(v);
  }
  return out;
}

function defaultPythonCandidatePaths() {
  const out = [];
  if (process.platform === "darwin") {
    out.push(
      "/opt/homebrew/bin/python3.11",
      "/usr/local/bin/python3.11",
      "/opt/homebrew/opt/python@3.11/bin/python3.11",
      "/usr/local/opt/python@3.11/bin/python3.11"
    );
  } else if (process.platform === "win32") {
    const localAppData = trimmed(process.env.LOCALAPPDATA);
    const home = os.homedir();
    if (localAppData) {
      out.push(path.join(localAppData, "Programs", "Python", "Python311", "python.exe"));
    }
    if (home) {
      out.push(path.join(home, "AppData", "Local", "Programs", "Python", "Python311", "python.exe"));
    }
    out.push(
      "C:\\Python311\\python.exe",
      "C:\\Program Files\\Python311\\python.exe",
      "C:\\Program Files (x86)\\Python311\\python.exe"
    );
  } else {
    out.push("/usr/bin/python3.11", "/usr/local/bin/python3.11");
  }
  return uniqueNonEmpty(out);
}

function buildPythonCandidateList(preferredCandidates = []) {
  const absolutePreferred = [];
  const namedPreferred = [];
  for (const candidate of uniqueNonEmpty(preferredCandidates)) {
    // Packaged app / launchd runs often have a much smaller PATH than a dev shell.
    if (path.isAbsolute(candidate)) {
      absolutePreferred.push(candidate);
    } else {
      namedPreferred.push(candidate);
    }
  }
  return uniqueNonEmpty([
    ...absolutePreferred,
    ...defaultPythonCandidatePaths(),
    ...namedPreferred,
    "python3.12",
    "python3.11",
    "python3.10",
    "python3",
    "python",
    "py",
  ]);
}

function createJsonLineConsumer(onJson, onWarn) {
  let buffer = "";
  return (chunk) => {
    buffer += String(chunk || "");
    while (true) {
      const newlineIdx = buffer.indexOf("\n");
      if (newlineIdx < 0) break;
      const rawLine = buffer.slice(0, newlineIdx);
      buffer = buffer.slice(newlineIdx + 1);
      const line = trimmed(rawLine);
      if (!line) continue;
      try {
        const parsed = JSON.parse(line);
        onJson(parsed);
      } catch {
        onWarn("openwakeword runner emitted invalid json line", line.slice(0, 240));
      }
    }
  };
}

async function maybeInstallOpenWakewordDeps({ pythonBin, onLog, onWarn }) {
  const requirementsPath = path.join(
    MODULE_DIR,
    "platform",
    "wake",
    "requirements-openwakeword.txt"
  );
  if (!(await pathExists(requirementsPath))) {
    onWarn(
      "openwakeword requirements file missing; skipping dependency bootstrap",
      requirementsPath
    );
    return false;
  }
  onLog("attempting openwakeword dependency bootstrap", {
    python_bin: pythonBin,
    requirements_path: requirementsPath,
  });
  const pipOk = await new Promise((resolve) => {
    const child = spawn(
      pythonBin,
      ["-m", "pip", "install", "--user", "-r", requirementsPath],
      {
        stdio: ["ignore", "pipe", "pipe"],
      }
    );
    let done = false;
    const settle = (ok) => {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      resolve(ok);
    };
    const timeout = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // ignore
      }
      settle(false);
    }, 180000);
    child.stdout.on("data", (chunk) => {
      const text = trimmed(String(chunk || ""));
      if (text) onLog("openwakeword pip", text.slice(0, 400));
    });
    child.stderr.on("data", (chunk) => {
      const text = trimmed(String(chunk || ""));
      if (text) onWarn("openwakeword pip", text.slice(0, 400));
    });
    child.once("error", () => settle(false));
    child.once("close", (code) => settle(Number(code) === 0));
  });
  if (!pipOk) return false;

  onLog("downloading openwakeword resource models (melspectrogram, embedding, etc.)");
  const downloadOk = await new Promise((resolve) => {
    const child = spawn(
      pythonBin,
      ["-c", "import openwakeword; openwakeword.utils.download_models()"],
      { stdio: ["ignore", "pipe", "pipe"] }
    );
    let done = false;
    const settle = (ok) => {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      resolve(ok);
    };
    const timeout = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // ignore
      }
      settle(false);
    }, 120000);
    child.stdout.on("data", (chunk) => {
      const text = trimmed(String(chunk || ""));
      if (text) onLog("openwakeword download_models", text.slice(0, 400));
    });
    child.stderr.on("data", (chunk) => {
      const text = trimmed(String(chunk || ""));
      if (text) onWarn("openwakeword download_models", text.slice(0, 400));
    });
    child.once("error", () => settle(false));
    child.once("close", (code) => settle(Number(code) === 0));
  });
  if (!downloadOk) {
    onWarn("openwakeword resource model download failed (melspectrogram/embedding)");
  }
  return true;
}

async function getPythonVersion(pythonBin) {
  return await new Promise((resolve) => {
    const child = spawn(
      pythonBin,
      [
        "-c",
        "import sys; print(f'{sys.version_info[0]}.{sys.version_info[1]}.{sys.version_info[2]}')",
      ],
      {
        stdio: ["ignore", "pipe", "pipe"],
      }
    );
    let stdout = "";
    let stderr = "";
    let settled = false;
    const settle = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // ignore
      }
      settle({
        ok: false,
        version: "",
        major: 0,
        minor: 0,
        patch: 0,
        error: "python_version_timeout",
      });
    }, 4000);

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk || "");
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk || "");
    });
    child.once("error", (error) => {
      settle({
        ok: false,
        version: "",
        major: 0,
        minor: 0,
        patch: 0,
        error: error instanceof Error ? error.message : String(error),
      });
    });
    child.once("close", (code) => {
      if (code !== 0) {
        settle({
          ok: false,
          version: "",
          major: 0,
          minor: 0,
          patch: 0,
          error: trimmed(stderr) || `python_version_exit_code_${Number(code)}`,
        });
        return;
      }
      const version = trimmed(stdout);
      const m = version.match(/^(\d+)\.(\d+)\.(\d+)/);
      if (!m) {
        settle({
          ok: false,
          version,
          major: 0,
          minor: 0,
          patch: 0,
          error: "python_version_parse_failed",
        });
        return;
      }
      settle({
        ok: true,
        version,
        major: Number(m[1]),
        minor: Number(m[2]),
        patch: Number(m[3]),
        error: "",
      });
    });
  });
}

async function runCommandCapture(command, args = [], options = {}) {
  const timeoutMs = Math.max(1000, Number(options?.timeoutMs) || 30_000);
  const env =
    options?.env && typeof options.env === "object"
      ? { ...process.env, ...options.env }
      : process.env;
  return await new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const settle = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // ignore
      }
      settle({
        ok: false,
        stdout,
        stderr,
        code: null,
        error: "command_timeout",
      });
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk || "");
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk || "");
    });
    child.once("error", (error) => {
      settle({
        ok: false,
        stdout,
        stderr,
        code: null,
        error: error instanceof Error ? error.message : String(error),
      });
    });
    child.once("close", (code) => {
      settle({
        ok: Number(code) === 0,
        stdout,
        stderr,
        code: Number.isFinite(Number(code)) ? Number(code) : null,
        error: Number(code) === 0 ? "" : "command_exit_nonzero",
      });
    });
  });
}

async function maybeAutoInstallPython311({ onLog, onWarn }) {
  const now = Date.now();
  const installStatePath = path.join(
    os.homedir(),
    ".groovy",
    "openwakeword",
    "python-install-state.json"
  );
  try {
    const raw = await fsp.readFile(installStatePath, "utf8");
    const parsed = JSON.parse(raw || "{}");
    const lastAttemptMs = Number(parsed?.last_attempt_ms || 0);
    if (Number.isFinite(lastAttemptMs) && now - lastAttemptMs < 6 * 60 * 60 * 1000) {
      onLog("openwakeword python auto-install skipped due to recent attempt", {
        last_attempt_ms: lastAttemptMs,
      });
      return false;
    }
  } catch {
    // ignore missing/invalid state
  }

  const persistState = async (ok, detail = "") => {
    try {
      await fsp.mkdir(path.dirname(installStatePath), { recursive: true });
      await fsp.writeFile(
        installStatePath,
        JSON.stringify(
          {
            ok: ok === true,
            detail: trimmed(detail).slice(0, 240),
            last_attempt_ms: now,
            updated_at: new Date(now).toISOString(),
          },
          null,
          2
        )
      );
    } catch {
      // ignore state write failures
    }
  };

  const hasPython311 = async () => {
    for (const candidate of buildPythonCandidateList(["python3.11", "python3.10"])) {
      const version = await getPythonVersion(candidate);
      if (
        version.ok &&
        (version.major > 3 || (version.major === 3 && version.minor >= 10))
      ) {
        return true;
      }
    }
    return false;
  };

  if (await hasPython311()) {
    await persistState(true, "already_installed");
    return true;
  }

  onLog("attempting automatic python 3.11 installation for openwakeword", {
    platform: process.platform,
  });

  let installed = false;
  let installDetail = "";

  if (process.platform === "darwin") {
    const brewCandidates = ["brew", "/opt/homebrew/bin/brew", "/usr/local/bin/brew"];
    let brewBin = "";
    for (const candidate of brewCandidates) {
      const check = await runCommandCapture(candidate, ["--version"], {
        timeoutMs: 10_000,
      });
      if (check.ok) {
        brewBin = candidate;
        break;
      }
    }
    if (!brewBin) {
      installDetail = "brew_not_available";
    } else {
      const install = await runCommandCapture(brewBin, ["install", "python@3.11"], {
        timeoutMs: 20 * 60 * 1000,
        env: {
          HOMEBREW_NO_AUTO_UPDATE: "1",
        },
      });
      if (!install.ok && !install.stderr.includes("already installed")) {
        installDetail = trimmed(install.stderr || install.stdout || install.error).slice(
          0,
          240
        );
      }
      installed = await hasPython311();
      if (!installed && !installDetail) {
        installDetail = "python_3_11_not_found_after_brew_install";
      }
    }
  } else if (process.platform === "win32") {
    const wingetCandidates = uniqueNonEmpty([
      "winget",
      path.join(
        trimmed(process.env.LOCALAPPDATA),
        "Microsoft",
        "WindowsApps",
        "winget.exe"
      ),
      path.join(
        os.homedir(),
        "AppData",
        "Local",
        "Microsoft",
        "WindowsApps",
        "winget.exe"
      ),
    ]);
    let wingetBin = "";
    for (const candidate of wingetCandidates) {
      const check = await runCommandCapture(candidate, ["--version"], {
        timeoutMs: 10_000,
      });
      if (check.ok) {
        wingetBin = candidate;
        break;
      }
    }
    if (!wingetBin) {
      installDetail = "winget_not_available";
    } else {
      const install = await runCommandCapture(
        wingetBin,
        [
          "install",
          "--id",
          "Python.Python.3.11",
          "-e",
          "--accept-package-agreements",
          "--accept-source-agreements",
          "--silent",
        ],
        { timeoutMs: 20 * 60 * 1000 }
      );
      if (!install.ok && !install.stdout.toLowerCase().includes("already installed")) {
        installDetail = trimmed(install.stderr || install.stdout || install.error).slice(
          0,
          240
        );
      }
      installed = await hasPython311();
      if (!installed && !installDetail) {
        installDetail = "python_3_11_not_found_after_winget_install";
      }
    }
  } else if (process.platform === "linux") {
    const aptCandidates = ["apt-get", "/usr/bin/apt-get"];
    let aptBin = "";
    for (const candidate of aptCandidates) {
      const check = await runCommandCapture(candidate, ["--version"], {
        timeoutMs: 10_000,
      });
      if (check.ok) {
        aptBin = candidate;
        break;
      }
    }
    if (!aptBin) {
      installDetail = "apt_get_not_available";
    } else {
      const runWithSudo = typeof process.getuid === "function" && process.getuid() !== 0;
      const cmd = runWithSudo ? "sudo" : aptBin;
      const updateArgs = runWithSudo ? ["-n", aptBin, "update"] : ["update"];
      const installArgs = runWithSudo
        ? ["-n", aptBin, "install", "-y", "python3.11", "python3.11-venv"]
        : ["install", "-y", "python3.11", "python3.11-venv"];
      const update = await runCommandCapture(cmd, updateArgs, {
        timeoutMs: 2 * 60 * 1000,
      });
      if (update.ok) {
        const install = await runCommandCapture(cmd, installArgs, {
          timeoutMs: 10 * 60 * 1000,
        });
        if (!install.ok) {
          installDetail = trimmed(
            install.stderr || install.stdout || install.error
          ).slice(0, 240);
        }
      } else {
        installDetail = trimmed(update.stderr || update.stdout || update.error).slice(
          0,
          240
        );
      }
      installed = await hasPython311();
      if (!installed && !installDetail) {
        installDetail = "python_3_11_not_found_after_apt_install";
      }
    }
  } else {
    installDetail = `unsupported_platform_${process.platform}`;
  }

  if (installed) {
    onLog("automatic python installation completed for openwakeword");
    await persistState(true, "installed");
    return true;
  }
  onWarn("automatic python installation for openwakeword failed", installDetail);
  await persistState(false, installDetail || "install_failed");
  return false;
}

async function startOpenWakewordDetector(args) {
  const wakeWord = trimmed(args?.wakeWord) || "hey groovy";
  const threshold = clamp(toFiniteNumber(args?.threshold, 0.5), 0, 1);
  const modelPath = trimmed(args?.modelPath);
  const scriptPath = trimmed(args?.scriptPath);
  const onLog = typeof args?.onLog === "function" ? args.onLog : () => {};
  const onWarn = typeof args?.onWarn === "function" ? args.onWarn : onLog;
  const onMetric = typeof args?.onMetric === "function" ? args.onMetric : () => {};
  const allowApproximate = parseBooleanLike(
    args?.allowApproximate ?? process.env.AIYRA_OPENWAKEWORD_ALLOW_APPROXIMATE,
    true
  );
  const autoInstallRaw =
    typeof args?.autoInstallDeps === "boolean"
      ? args.autoInstallDeps
        ? "1"
        : "0"
      : trimmed(args?.autoInstallDeps) ||
        trimmed(process.env.AIYRA_OPENWAKEWORD_AUTO_INSTALL) ||
        "1";
  const autoInstallEnabled = !["0", "false", "no", "off"].includes(
    autoInstallRaw.toLowerCase()
  );
  const autoInstallPythonEnabled = parseBooleanLike(
    args?.autoInstallPython ??
      process.env.AIYRA_OPENWAKEWORD_AUTO_INSTALL_PYTHON,
    true
  );
  const readyTimeoutMs = clamp(
    toFiniteNumber(
      args?.readyTimeoutMs ?? process.env.AIYRA_OPENWAKEWORD_READY_TIMEOUT_MS,
      60_000
    ),
    10_000,
    120_000
  );

  if (!scriptPath) {
    throw new Error("openwakeword_runner_script_missing");
  }
  if (!(await pathExists(scriptPath))) {
    throw new Error(`openwakeword_runner_script_not_found:${scriptPath}`);
  }

  let pythonCandidates = buildPythonCandidateList([
    args?.pythonPath,
    process.env.AIYRA_OPENWAKEWORD_PYTHON,
  ]);
  let lastError = null;
  const launchWithPython = (pythonBin) =>
    new Promise((resolve, reject) => {
      const childArgs = [
        scriptPath,
        "--wake-word",
        wakeWord,
        "--threshold",
        String(threshold),
      ];
      if (modelPath) {
        childArgs.push("--model-path", modelPath);
      }
      if (allowApproximate) {
        childArgs.push("--allow-approximate");
      }

      const child = spawn(pythonBin, childArgs, {
        stdio: ["pipe", "pipe", "pipe"],
      });
      let running = true;
      let readyInfo = null;
      const detections = [];
      let readyTimer = null;
      let finalized = false;

      const finalizeReject = (error) => {
        if (finalized) return;
        finalized = true;
        if (readyTimer) clearTimeout(readyTimer);
        try {
          child.kill();
        } catch {
          // ignore
        }
        reject(error);
      };
      const finalizeResolve = () => {
        if (finalized) return;
        finalized = true;
        if (readyTimer) clearTimeout(readyTimer);
        resolve({
          engine: "openwakeword",
          pythonBin,
          wakeWord: wakeWord,
          effectiveWakeWord:
            trimmed(readyInfo?.effective_wake_word) || wakeWord,
          modelLabel: trimmed(readyInfo?.model_label),
          threshold: Number.isFinite(Number(readyInfo?.threshold))
            ? Number(readyInfo.threshold)
            : threshold,
          approximateMatch: readyInfo?.approximate_match === true,
          availableModelsCount: Number.isFinite(Number(readyInfo?.available_models_count))
            ? Number(readyInfo.available_models_count)
            : null,
          modelPath: trimmed(readyInfo?.model_path) || modelPath,
          sendFrame: async (frameInput) => {
            if (!running) throw new Error("openwakeword_runner_not_running");
            const frame =
              frameInput &&
              typeof frameInput === "object" &&
              ArrayBuffer.isView(frameInput.frame)
                ? frameInput.frame
                : frameInput;
            if (!ArrayBuffer.isView(frame) || typeof frame.length !== "number") {
              throw new Error("openwakeword_frame_invalid");
            }
            const rawRms =
              frameInput &&
              typeof frameInput === "object" &&
              Number.isFinite(Number(frameInput.rawRms))
                ? Number(frameInput.rawRms)
                : undefined;
            const denoisedRms =
              frameInput &&
              typeof frameInput === "object" &&
              Number.isFinite(Number(frameInput.denoisedRms))
                ? Number(frameInput.denoisedRms)
                : undefined;
            const payload =
              JSON.stringify({
                type: "frame",
                audio: pcm16ToBase64(frame),
                raw_rms: rawRms,
                denoised_rms: denoisedRms,
              }) + "\n";
            const canContinue = child.stdin.write(payload);
            if (!canContinue) {
              await new Promise((resolveDrain) => {
                const timeout = setTimeout(resolveDrain, 1500);
                child.stdin.once("drain", () => {
                  clearTimeout(timeout);
                  resolveDrain();
                });
              });
            }
            return true;
          },
          pollDetection: () => detections.shift() || null,
          stop: async () => {
            if (!running) return;
            running = false;
            try {
              child.stdin.end();
            } catch {
              // ignore
            }
            try {
              child.kill();
            } catch {
              // ignore
            }
            await new Promise((resolveClose) => {
              const timeout = setTimeout(resolveClose, 2000);
              child.once("close", () => {
                clearTimeout(timeout);
                resolveClose();
              });
            });
          },
        });
      };

      child.once("error", (error) => {
        finalizeReject(
          new Error(
            `openwakeword_spawn_failed:${pythonBin}:${error instanceof Error ? error.message : String(error)}`
          )
        );
      });
      const consumeStdoutLine = createJsonLineConsumer(
        (msg) => {
          const type = trimmed(msg?.type);
          if (type === "ready") {
            readyInfo = msg;
            onMetric("openwakeword_ready", {
              python_bin: pythonBin,
              requested_wake_word: wakeWord,
              effective_wake_word: trimmed(msg?.effective_wake_word) || wakeWord,
              model_label: trimmed(msg?.model_label) || "",
              threshold: Number.isFinite(Number(msg?.threshold))
                ? Number(msg.threshold)
                : threshold,
              approximate_match: msg?.approximate_match === true,
              allow_approximate: msg?.allow_approximate === true,
              available_models_count: Number.isFinite(Number(msg?.available_models_count))
                ? Number(msg.available_models_count)
                : undefined,
              model_path: trimmed(msg?.model_path) || modelPath || "",
            });
            finalizeResolve();
            return;
          }
          if (type === "wake_detected") {
            detections.push(msg);
            return;
          }
          if (type === "wake_near_miss") {
            onMetric("wake_near_miss", {
              wake_word: wakeWord,
              model_label: trimmed(msg?.model_label) || "",
              target_label: trimmed(msg?.target_label) || "",
              top_label: trimmed(msg?.top_label) || "",
              score: Number.isFinite(Number(msg?.score))
                ? Number(msg.score)
                : undefined,
              top_score: Number.isFinite(Number(msg?.top_score))
                ? Number(msg.top_score)
                : undefined,
              threshold: Number.isFinite(Number(msg?.threshold))
                ? Number(msg.threshold)
                : threshold,
              score_ratio: Number.isFinite(Number(msg?.score_ratio))
                ? Number(msg.score_ratio)
                : undefined,
              near_miss_threshold: Number.isFinite(Number(msg?.near_miss_threshold))
                ? Number(msg.near_miss_threshold)
                : undefined,
              rms: Number.isFinite(Number(msg?.rms))
                ? Number(msg.rms)
                : undefined,
              raw_rms: Number.isFinite(Number(msg?.raw_rms))
                ? Number(msg.raw_rms)
                : undefined,
              denoised_rms: Number.isFinite(Number(msg?.denoised_rms))
                ? Number(msg.denoised_rms)
                : Number.isFinite(Number(msg?.rms))
                  ? Number(msg.rms)
                  : undefined,
              frames: Number.isFinite(Number(msg?.frames))
                ? Number(msg.frames)
                : undefined,
            });
            return;
          }
          if (type === "score_debug") {
            onLog("openwakeword score_debug", {
              model_label: trimmed(msg?.model_label),
              target_label: trimmed(msg?.target_label),
              top_label: trimmed(msg?.top_label),
              current_score: msg?.current_score,
              peak_score: msg?.peak_score,
              avg_score: msg?.avg_score,
              top_score: msg?.top_score,
              threshold: msg?.threshold,
              near_miss_threshold: msg?.near_miss_threshold,
              rms: msg?.rms,
              peak_rms: msg?.peak_rms,
              avg_rms: msg?.avg_rms,
              raw_rms: msg?.raw_rms,
              peak_raw_rms: msg?.peak_raw_rms,
              avg_raw_rms: msg?.avg_raw_rms,
              denoised_rms: msg?.denoised_rms,
              peak_denoised_rms: msg?.peak_denoised_rms,
              avg_denoised_rms: msg?.avg_denoised_rms,
              frames: msg?.frames,
              frames_since_debug: msg?.frames_since_debug,
              near_miss_count: msg?.near_miss_count,
            });
            return;
          }
          if (type === "error" && !finalized) {
            const detail = trimmed(msg?.detail) || "openwakeword_runner_error";
            finalizeReject(new Error(detail));
          }
        },
        onWarn
      );
      child.stdout.on("data", consumeStdoutLine);
      child.stderr.on("data", (chunk) => {
        const text = trimmed(String(chunk || ""));
        if (text) onWarn("openwakeword stderr", text);
      });
      child.on("close", (code) => {
        running = false;
        if (finalized) return;
        finalizeReject(
          new Error(`openwakeword_runner_exited:${pythonBin}:code_${Number(code)}`)
        );
      });

      readyTimer = setTimeout(() => {
        onWarn("openwakeword runner ready timeout", {
          python_bin: pythonBin,
          timeout_ms: readyTimeoutMs,
        });
        finalizeReject(
          new Error(`openwakeword_runner_ready_timeout:${pythonBin}`)
        );
      }, readyTimeoutMs);
    });

  let candidateIdx = 0;
  let attemptedAutoInstallPython = false;
  while (candidateIdx < pythonCandidates.length) {
    const pythonBin = pythonCandidates[candidateIdx];
    candidateIdx += 1;
    const pyVersion = await getPythonVersion(pythonBin);
    if (!pyVersion.ok) {
      onWarn(
        "openwakeword python candidate unavailable",
        `${pythonBin}: ${pyVersion.error || "unknown_error"}`
      );
      continue;
    }
    const tooOld =
      pyVersion.major < 3 ||
      (pyVersion.major === 3 && pyVersion.minor < 10);
    if (tooOld) {
      onWarn(
        "openwakeword requires Python >=3.10; skipping candidate",
        `${pythonBin} (${pyVersion.version})`
      );
      continue;
    }
    let attemptedBootstrap = false;
    while (true) {
      try {
        const detector = await launchWithPython(pythonBin);

        onLog("openwakeword wake detector ready", {
          python_bin: detector.pythonBin,
          effective_wake_word: detector.effectiveWakeWord,
          model_label: detector.modelLabel || null,
          threshold: detector.threshold,
          approximate_match: detector.approximateMatch,
          available_models_count: detector.availableModelsCount,
          model_path: detector.modelPath || null,
        });
        return detector;
      } catch (error) {
        lastError = error;
        const message = error instanceof Error ? error.message : String(error);
        const missingDeps =
          message.includes("openwakeword_import_failed") ||
          message.includes("No module named 'openwakeword'");
        if (autoInstallEnabled && !attemptedBootstrap && missingDeps) {
          attemptedBootstrap = true;
          const installed = await maybeInstallOpenWakewordDeps({
            pythonBin,
            onLog,
            onWarn,
          });
          if (installed) {
            onLog("openwakeword dependency bootstrap finished; retrying runner start", {
              python_bin: pythonBin,
            });
            continue;
          }
        }
        if (message.includes("openwakeword_model_not_found_for_wake_word")) {
          onWarn(
            "openwakeword has no exact model for requested wake word; configure AIYRA_OPENWAKEWORD_MODEL_PATH on connector or server /api/aiyra/openwakeword-model env, or enable AIYRA_OPENWAKEWORD_ALLOW_APPROXIMATE=1"
          );
        }
        onWarn("openwakeword detector start attempt failed", message);
        break;
      }
    }
  }

  if (autoInstallPythonEnabled && !attemptedAutoInstallPython) {
    attemptedAutoInstallPython = true;
    const installed = await maybeAutoInstallPython311({ onLog, onWarn });
    if (installed) {
      pythonCandidates = buildPythonCandidateList([
        "python3.11",
        "python3.10",
        ...pythonCandidates,
      ]);
      candidateIdx = 0;
      while (candidateIdx < pythonCandidates.length) {
        const pythonBin = pythonCandidates[candidateIdx];
        candidateIdx += 1;
        const pyVersion = await getPythonVersion(pythonBin);
        if (!pyVersion.ok) continue;
        const tooOld =
          pyVersion.major < 3 ||
          (pyVersion.major === 3 && pyVersion.minor < 10);
        if (tooOld) continue;
        let attemptedBootstrap = false;
        while (true) {
          try {
            const detector = await launchWithPython(pythonBin);
            onLog("openwakeword wake detector ready", {
              python_bin: detector.pythonBin,
              effective_wake_word: detector.effectiveWakeWord,
              model_label: detector.modelLabel || null,
            });
            return detector;
          } catch (error) {
            lastError = error;
            const message = error instanceof Error ? error.message : String(error);
            const missingDeps =
              message.includes("openwakeword_import_failed") ||
              message.includes("No module named 'openwakeword'");
            if (autoInstallEnabled && !attemptedBootstrap && missingDeps) {
              attemptedBootstrap = true;
              const installedDeps = await maybeInstallOpenWakewordDeps({
                pythonBin,
                onLog,
                onWarn,
              });
              if (installedDeps) {
                continue;
              }
            }
            if (message.includes("openwakeword_model_not_found_for_wake_word")) {
              onWarn(
                "openwakeword has no exact model for requested wake word; configure AIYRA_OPENWAKEWORD_MODEL_PATH on connector or server /api/aiyra/openwakeword-model env, or enable AIYRA_OPENWAKEWORD_ALLOW_APPROXIMATE=1"
              );
            }
            onWarn("openwakeword detector start attempt failed", message);
            break;
          }
        }
      }
    }
  }

  throw (
    lastError ||
    new Error("openwakeword_detector_start_failed")
  );
}

function frameRms(int16Samples) {
  if (!int16Samples || int16Samples.length === 0) return 0;
  let sumSq = 0;
  for (let i = 0; i < int16Samples.length; i += 1) {
    const v = int16Samples[i] || 0;
    sumSq += v * v;
  }
  return Math.sqrt(sumSq / int16Samples.length);
}

async function importPicovoice() {
  const [porcupineMod, recorderMod] = await Promise.all([
    import("@picovoice/porcupine-node"),
    import("@picovoice/pvrecorder-node"),
  ]);
  const Porcupine = porcupineMod?.Porcupine || porcupineMod?.default?.Porcupine;
  const BuiltinKeyword =
    porcupineMod?.BuiltinKeyword || porcupineMod?.default?.BuiltinKeyword || null;
  const PvRecorder = recorderMod?.PvRecorder || recorderMod?.default?.PvRecorder;
  if (!Porcupine || !PvRecorder) {
    throw new Error("picovoice_import_failed");
  }
  return { Porcupine, PvRecorder, BuiltinKeyword };
}

async function importSpeakerCtor() {
  for (const packageName of ["@mastra/node-speaker", "speaker"]) {
    try {
      const mod = await import(packageName);
      const ctor = mod?.default || mod?.Speaker || null;
      if (ctor) return ctor;
    } catch {
      // try the next speaker implementation
    }
  }
  return null;
}

function isAudioDeltaEvent(msg) {
  const type = trimmed(msg?.type);
  return (
    type === "response.audio.delta" ||
    type === "response_audio_delta" ||
    type === "response.audio.chunk"
  );
}

function parseAudioDelta(msg) {
  if (!msg || typeof msg !== "object") return "";
  const delta =
    trimmed(msg.delta) ||
    trimmed(msg.audio) ||
    trimmed(msg.chunk) ||
    trimmed(msg.data);
  return delta;
}

function parseAudioDeltaSampleRate(msg) {
  if (!msg || typeof msg !== "object") return null;
  const candidates = [
    msg.sample_rate,
    msg.sampleRate,
    msg.audio_sample_rate,
    msg.audioSampleRate,
    msg.output_audio_sample_rate,
    msg.outputAudioSampleRate,
    msg.audio_format?.sample_rate,
    msg.audio_format?.sampleRate,
    msg.audioFormat?.sample_rate,
    msg.audioFormat?.sampleRate,
    msg.output_audio?.sample_rate,
    msg.output_audio?.sampleRate,
    msg.outputAudio?.sample_rate,
    msg.outputAudio?.sampleRate,
    msg.response?.audio?.sample_rate,
    msg.response?.audio?.sampleRate,
  ];
  for (const candidate of candidates) {
    const rate = Number(candidate);
    if (Number.isFinite(rate) && rate >= 8000 && rate <= 192000) {
      return Math.round(rate);
    }
  }
  return null;
}

function parseAssistantTranscriptDelta(msg) {
  if (!msg || typeof msg !== "object") return "";
  return (
    trimmed(msg.delta) ||
    trimmed(msg.transcript) ||
    trimmed(msg.text) ||
    trimmed(msg.audio_transcript)
  );
}

function readAssistantResponseId(msg) {
  if (!msg || typeof msg !== "object") return "";
  return trimmed(
    msg.response_id ||
      msg.responseId ||
      msg.response?.id ||
      msg.response?.response_id ||
      msg.response?.responseId
  );
}

function buildAudioDeltaFingerprint(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return "";
  const sampleCount = Math.min(32, buffer.length);
  const step = Math.max(1, Math.floor(buffer.length / sampleCount));
  let acc = 2166136261;
  for (let i = 0; i < buffer.length; i += step) {
    acc ^= buffer[i];
    acc = Math.imul(acc, 16777619) >>> 0;
  }
  const edgeSize = Math.min(6, buffer.length);
  const prefix = buffer.subarray(0, edgeSize).toString("hex");
  const suffix = buffer.subarray(buffer.length - edgeSize).toString("hex");
  return `${buffer.length}:${acc.toString(16)}:${prefix}:${suffix}`;
}

function appendPreviewText(current, delta, maxChars = 240) {
  const base = typeof current === "string" ? current : "";
  const addition = trimmed(delta);
  if (!addition || base.length >= maxChars) return base;
  return (base ? `${base} ${addition}` : addition).slice(0, maxChars);
}

function analyzeAudioDeltaPcm(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) return null;
  const sampleCount = Math.floor(buffer.length / 2);
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  let sumSq = 0;
  let zeroCrossings = 0;
  let prevSample = 0;
  const firstSamples = [];
  for (let i = 0; i < sampleCount; i++) {
    const sample = buffer.readInt16LE(i * 2);
    if (i < 16) firstSamples.push(sample);
    if (sample < min) min = sample;
    if (sample > max) max = sample;
    sum += sample;
    sumSq += sample * sample;
    if (i > 0 && ((prevSample >= 0 && sample < 0) || (prevSample < 0 && sample >= 0))) {
      zeroCrossings += 1;
    }
    prevSample = sample;
  }
  const mean = sum / sampleCount;
  const rms = Math.sqrt(sumSq / sampleCount);
  const durationMs = (sampleCount / VOICE_PLAYBACK_SAMPLE_RATE) * 1000;
  const zeroCrossingRateHz = durationMs > 0
    ? (zeroCrossings / (durationMs / 1000))
    : 0;
  return {
    samples: sampleCount,
    duration_ms: Math.round(durationMs * 10) / 10,
    min,
    max,
    mean: Math.round(mean * 100) / 100,
    rms: Math.round(rms * 100) / 100,
    zero_crossings: zeroCrossings,
    zero_crossing_rate_hz: Math.round(zeroCrossingRateHz),
    first_16_samples: firstSamples,
    looks_like_pcm16: min >= -32768 && max <= 32767 && rms > 0,
    high_frequency_hint: zeroCrossingRateHz > 8000
      ? "possible_wrong_sample_rate_or_encoded"
      : zeroCrossingRateHz > 4000
        ? "high_frequency_content"
        : "normal",
  };
}

function isAssistantResponseStartedEvent(msg) {
  const type = trimmed(msg?.type);
  return (
    type === "response.created" ||
    type === "response.started" ||
    type === "response.in_progress" ||
    type === "stage_registered" ||
    type === "first_chunk"
  );
}

function isAssistantResponseFinishedEvent(msg) {
  const type = trimmed(msg?.type);
  return (
    type === "response.done" ||
    type === "response.completed" ||
    type === "response.failed" ||
    type === "response.cancelled"
  );
}

function isAssistantTranscriptEvent(msg) {
  const type = trimmed(msg?.type);
  return (
    type === "response.output_audio_transcript.delta" ||
    type === "response.audio_transcript.delta"
  );
}

async function openWebSocketWithTimeout(wsUrl, timeoutMs = 10000) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try {
        ws.close();
      } catch {
        // ignore
      }
      reject(new Error("aiyra_ws_open_timeout"));
    }, Math.max(1000, timeoutMs));
    ws.once("open", () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(null);
    });
    ws.once("error", (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(err instanceof Error ? err : new Error(String(err)));
    });
  });
  return ws;
}

export async function startAiyraVoiceRuntime(opts) {
  const onLog = typeof opts?.log === "function" ? opts.log : () => {};
  const onWarn = typeof opts?.warn === "function" ? opts.warn : onLog;
  const onHealth = typeof opts?.onHealth === "function" ? opts.onHealth : () => {};
  const onMetric =
    typeof opts?.onMetric === "function" ? opts.onMetric : () => {};

  const appUrl = trimmed(opts?.appUrl);
  const deviceToken = trimmed(opts?.deviceToken);
  const wakeWord = trimmed(opts?.wakeWord) || "hey groovy";
  const wakeSensitivity = clamp(toFiniteNumber(opts?.wakeSensitivity, 0.5), 0, 1);
  const idleTimeoutMs = clamp(toFiniteNumber(opts?.idleTimeoutMs, 12000), 2000, 120000);
  const wakeCooldownMs = clamp(toFiniteNumber(opts?.wakeCooldownMs, 5000), 1000, 30000);
  const wakeEnginePreference = (
    trimmed(opts?.wakeEngine) ||
    trimmed(process.env.AIYRA_WAKE_ENGINE) ||
    "openwakeword"
  ).toLowerCase();
  const openWakewordThreshold = clamp(
    toFiniteNumber(
      opts?.openWakewordThreshold ?? process.env.AIYRA_OPENWAKEWORD_THRESHOLD,
      DEFAULT_OPENWAKEWORD_THRESHOLD
    ),
    0,
    1
  );
  const openWakewordAllowApproximate = parseBooleanLike(
    opts?.openWakewordAllowApproximate ??
      process.env.AIYRA_OPENWAKEWORD_ALLOW_APPROXIMATE,
    DEFAULT_OPENWAKEWORD_ALLOW_APPROXIMATE
  );
  const openWakewordAllowPorcupineFallback = parseBooleanLike(
    opts?.openWakewordAllowPorcupineFallback ??
      process.env.AIYRA_OPENWAKEWORD_ALLOW_PORCUPINE_FALLBACK,
    false
  );
  const rnnoiseEnabled = parseBooleanLike(
    opts?.rnnoiseEnabled ?? process.env.AIYRA_RNNOISE_ENABLED,
    true
  );
  const voiceAecEnabled = parseBooleanLike(
    opts?.aecEnabled ?? process.env.AIYRA_AEC_ENABLED,
    true
  );
  onLog("aiyra runtime init", {
    app_url: appUrl || null,
    has_device_token: !!deviceToken,
    wake_word: wakeWord,
    wake_engine_preference: wakeEnginePreference,
    device_index:
      Number.isFinite(Number(opts?.deviceIndex)) ? Number(opts.deviceIndex) : null,
  });
  const voiceAecBackend = normalizeAecBackend(
    opts?.aecBackend ?? process.env.AIYRA_AEC_BACKEND,
    "webrtc"
  );
  const voiceAecFrameSize = normalizeMultiple(
    opts?.aecFrameSize ?? process.env.AIYRA_AEC_FRAME_SIZE,
    160,
    320
  );
  const voiceAecFilterLength = normalizeMultiple(
    opts?.aecFilterLength ?? process.env.AIYRA_AEC_FILTER_LENGTH,
    voiceAecFrameSize,
    3200,
    voiceAecFrameSize
  );
  const voiceAecRenderQueueCapacityMs = clamp(
    toFiniteNumber(
      opts?.aecRenderQueueCapacityMs ?? process.env.AIYRA_AEC_RENDER_QUEUE_CAPACITY_MS,
      2000
    ),
    250,
    5000
  );
  const assistantPlaybackHoldFallbackMs = clamp(
    toFiniteNumber(
      opts?.assistantPlaybackHoldMs ?? process.env.AIYRA_ASSISTANT_PLAYBACK_HOLD_MS,
      1500
    ),
    0,
    5000
  );
  const assistantPlaybackHoldWithAecMs = clamp(
    toFiniteNumber(
      opts?.aecPlaybackHoldMs ?? process.env.AIYRA_AEC_PLAYBACK_HOLD_MS,
      350
    ),
    0,
    assistantPlaybackHoldFallbackMs
  );
  const thinkingPulseEnabled = parseBooleanLike(
    opts?.thinkingPulseEnabled ?? process.env.AIYRA_THINKING_PULSE_ENABLED,
    true
  );
  const thinkingPulseStartDelayMs = clamp(
    toFiniteNumber(
      opts?.thinkingPulseStartDelayMs ??
        process.env.AIYRA_THINKING_PULSE_START_DELAY_MS,
      900
    ),
    0,
    10_000
  );
  const thinkingPulseIntervalMs = clamp(
    toFiniteNumber(
      opts?.thinkingPulseIntervalMs ??
        process.env.AIYRA_THINKING_PULSE_INTERVAL_MS,
      3000
    ),
    250,
    10_000
  );
  const thinkingPulseHoldMs = clamp(
    toFiniteNumber(
      opts?.thinkingPulseHoldMs ?? process.env.AIYRA_THINKING_PULSE_HOLD_MS,
      24
    ),
    0,
    assistantPlaybackHoldFallbackMs
  );
  const thinkingPulseChunkMs = clamp(
    toFiniteNumber(
      opts?.thinkingPulseChunkMs ?? process.env.AIYRA_THINKING_PULSE_CHUNK_MS,
      18
    ),
    6,
    80
  );
  const thinkingPulseBuffer = thinkingPulseEnabled
    ? buildThinkingPulseBuffer()
    : null;
  const spokenProgressEnabled = parseBooleanLike(
    opts?.spokenProgressEnabled ?? process.env.AIYRA_SPOKEN_PROGRESS_ENABLED,
    false
  );
  const forceNewConversationPerSession = parseBooleanLike(
    opts?.forceNewConversationPerSession ??
      process.env.AIYRA_FORCE_NEW_CONVERSATION_PER_SESSION,
    false
  );
  const spokenProgressInitialDelayMs = clamp(
    toFiniteNumber(
      opts?.spokenProgressInitialDelayMs ??
        process.env.AIYRA_SPOKEN_PROGRESS_INITIAL_DELAY_MS,
      2500
    ),
    0,
    15_000
  );
  const spokenProgressPollMs = clamp(
    toFiniteNumber(
      opts?.spokenProgressPollMs ?? process.env.AIYRA_SPOKEN_PROGRESS_POLL_MS,
      2500
    ),
    500,
    15_000
  );
  const spokenProgressMinIntervalMs = clamp(
    toFiniteNumber(
      opts?.spokenProgressMinIntervalMs ??
        process.env.AIYRA_SPOKEN_PROGRESS_MIN_INTERVAL_MS,
      2500
    ),
    500,
    20_000
  );
  const materialQueryIdleGraceMs = clamp(
    toFiniteNumber(
      opts?.materialQueryIdleGraceMs ??
        process.env.AIYRA_MATERIAL_QUERY_IDLE_GRACE_MS,
      20_000
    ),
    1000,
    120_000
  );
  const callEndedMaterialQueryGraceMs = clamp(
    toFiniteNumber(
      opts?.callEndedMaterialQueryGraceMs ??
        process.env.AIYRA_CALL_ENDED_MATERIAL_QUERY_GRACE_MS,
      4000
    ),
    500,
    300_000
  );
  const callEndedFinalResponseGraceMs = clamp(
    toFiniteNumber(
      opts?.callEndedFinalResponseGraceMs ??
        process.env.AIYRA_CALL_ENDED_FINAL_RESPONSE_GRACE_MS,
      30_000
    ),
    2_000,
    120_000
  );
  const callEndedMaterialQueryPollMs = clamp(
    toFiniteNumber(
      opts?.callEndedMaterialQueryPollMs ??
        process.env.AIYRA_CALL_ENDED_MATERIAL_QUERY_POLL_MS,
      400
    ),
    200,
    5_000
  );
  let openWakewordModelPath =
    trimmed(opts?.openWakewordModelPath) ||
    trimmed(process.env.AIYRA_OPENWAKEWORD_MODEL_PATH);
  const openWakewordPython =
    trimmed(opts?.openWakewordPython) ||
    trimmed(process.env.AIYRA_OPENWAKEWORD_PYTHON);
  const openWakewordScriptPath =
    trimmed(opts?.openWakewordScriptPath) ||
    path.join(MODULE_DIR, "platform", "wake", "openwakeword_runner.py");
  const initialDeviceIndex = Number.isFinite(Number(opts?.deviceIndex))
    ? Number(opts.deviceIndex)
    : -1;
  const resolveDeviceIndex =
    typeof opts?.resolveDeviceIndex === "function"
      ? opts.resolveDeviceIndex
      : () => initialDeviceIndex;
  const wsBootstrapPath = trimmed(opts?.deviceSessionPath) || "/api/aiyra/device-session";
  const materialQueryProgressPath =
    trimmed(opts?.materialQueryProgressPath) ||
    trimmed(process.env.AIYRA_MATERIAL_QUERY_PROGRESS_PATH) ||
    "/api/aiyra/material-query-progress";
  const localPorcupineAccessKey =
    trimmed(opts?.porcupineAccessKey) ||
    trimmed(process.env.AIYRA_PORCUPINE_ACCESS_KEY) ||
    trimmed(process.env.PICOVOICE_ACCESS_KEY);
  const keywordPathInput = trimmed(opts?.keywordPath);

  if (!appUrl) throw new Error("aiyra_missing_app_url");
  if (!deviceToken) throw new Error("aiyra_missing_device_token");
  const { Porcupine, PvRecorder, BuiltinKeyword } = await importPicovoice();
  const getCurrentDeviceIndex = async () => {
    try {
      const resolved = await resolveDeviceIndex();
      return Number.isFinite(Number(resolved)) ? Number(resolved) : initialDeviceIndex;
    } catch {
      return initialDeviceIndex;
    }
  };
  let keywordPath = "";
  let porcupineAccessKey = "";
  let builtinWakeword = null;
  let effectiveWakeWord = wakeWord;
  let wakewordSource = wakeEnginePreference === "porcupine" ? "custom_model" : "openwakeword";
  let wakeDetectorEngine = wakeEnginePreference;

  const ensurePorcupineWakewordReady = async () => {
    if (porcupineAccessKey && (keywordPath || builtinWakeword)) {
      return;
    }
    const resolvedKeyword = await resolveKeywordPath({
      appUrl,
      deviceToken,
      wakeWord,
      explicitKeywordPath: keywordPathInput,
      onLog,
      onWarn,
    });
    keywordPath = trimmed(resolvedKeyword?.keywordPath);
    porcupineAccessKey =
      localPorcupineAccessKey || trimmed(resolvedKeyword?.porcupineAccessKey);
    if (!porcupineAccessKey) throw new Error("aiyra_missing_porcupine_access_key");
    builtinWakeword = keywordPath
      ? null
      : resolveBuiltinWakeword(wakeWord, BuiltinKeyword);
    effectiveWakeWord = builtinWakeword?.effectiveWakeWord || wakeWord;
    wakewordSource = keywordPath ? "custom_model" : "builtin_keyword";
    if (!keywordPath && !builtinWakeword) {
      throw new Error(
        "aiyra_missing_keyword_path (no bundled model and wakeword-model endpoint returned no model)"
      );
    }
    if (builtinWakeword) {
      onWarn("aiyra wakeword custom model missing, using builtin keyword fallback", {
        requested_wake_word: wakeWord,
        builtin_keyword: builtinWakeword.builtinName,
        effective_wake_word: effectiveWakeWord,
      });
    }
  };

  onLog("aiyra runtime importing speaker module");
  const SpeakerCtor = await importSpeakerCtor();
  onLog("aiyra runtime speaker module ready", {
    available: !!SpeakerCtor,
  });

  let stopRequested = false;
  let wakeRecorder = null;
  let wakeRnnoiseProcessor = null;
  let wakeEngine = null;
  let openWakewordDetector = null;
  let wakeLoopPromise = null;
  let activeSession = null;
  let sessionMicMuted = false;
  let lastWakeAt = 0;
  let wakeSuppressedUntilMs = 0;
  let wakeSilentInputAccumulatedMs = 0;
  let wakeSilentInputAlerted = false;
  let wakeZeroInputAccumulatedMs = 0;
  let wakeZeroInputRecoveryCount = 0;
  let wakeZeroInputLastRecoveryAtMs = 0;
  let preferredConversationId = "";
  let adaptiveVoiceCaptureGainServerBias = 1;
  let lastResolvedTtsSpeed = 1.03;
  let spokenProgressAvailable = spokenProgressEnabled;
  const detachedMaterialQueryFollowups = new Map();
  const localDeferredFollowupSpeechEnabled = parseBooleanLike(
    process.env.AIYRA_ENABLE_LOCAL_DEFERRED_FOLLOWUP_SPEECH,
    false
  );
  const speechRmsThreshold = clamp(
    toFiniteNumber(opts?.speechRmsThreshold, 450),
    50,
    5000
  );
  const hotMicWindowMs = clamp(
    toFiniteNumber(
      opts?.hotMicWindowMs ?? process.env.AIYRA_HOT_MIC_WINDOW_MS,
      10_000
    ),
    3000,
    60_000
  );
  const hotMicSpeechRmsThreshold = clamp(
    toFiniteNumber(
      opts?.hotMicSpeechRmsThreshold ??
        process.env.AIYRA_HOT_MIC_SPEECH_RMS_THRESHOLD,
      speechRmsThreshold
    ),
    20,
    speechRmsThreshold
  );
  const wakeSilentInputRmsThreshold = clamp(
    toFiniteNumber(
      opts?.wakeSilentInputRmsThreshold ??
        process.env.AIYRA_WAKE_SILENT_INPUT_RMS_THRESHOLD,
      2
    ),
    0,
    200
  );
  const wakeSilentInputWindowMs = clamp(
    toFiniteNumber(
      opts?.wakeSilentInputWindowMs ??
        process.env.AIYRA_WAKE_SILENT_INPUT_WINDOW_MS,
      4000
    ),
    500,
    30000
  );
  const wakeZeroInputWindowMs = clamp(
    toFiniteNumber(
      opts?.wakeZeroInputWindowMs ?? process.env.AIYRA_WAKE_ZERO_INPUT_WINDOW_MS,
      Math.max(6000, wakeSilentInputWindowMs * 2)
    ),
    1000,
    60000
  );
  const wakeZeroInputRecoveryCooldownMs = clamp(
    toFiniteNumber(
      opts?.wakeZeroInputRecoveryCooldownMs ??
        process.env.AIYRA_WAKE_ZERO_INPUT_RECOVERY_COOLDOWN_MS,
      15000
    ),
    1000,
    120000
  );
  const wakeZeroInputRecoveryMax = Math.trunc(
    clamp(
      toFiniteNumber(
        opts?.wakeZeroInputRecoveryMax ??
          process.env.AIYRA_WAKE_ZERO_INPUT_RECOVERY_MAX,
        3
      ),
      1,
      10
    )
  );
  const wakeWordPostConnectDiscardMs = clamp(
    toFiniteNumber(
      opts?.wakeWordPostConnectDiscardMs ??
        process.env.AIYRA_WAKE_WORD_POST_CONNECT_DISCARD_MS,
      650
    ),
    0,
    3000
  );
  const voiceSpeechRnnoiseVadThreshold = clamp(
    toFiniteNumber(
      opts?.voiceSpeechRnnoiseVadThreshold ??
        process.env.AIYRA_VOICE_RNNOISE_VAD_THRESHOLD,
      0.35
    ),
    0.05,
    0.99
  );
  const voiceDenoisedSpeechRmsThreshold = clamp(
    toFiniteNumber(
      opts?.voiceSpeechDenoisedRmsThreshold ??
        process.env.AIYRA_VOICE_DENOISED_SPEECH_RMS_THRESHOLD,
      Math.max(12, Math.round(hotMicSpeechRmsThreshold * 0.03))
    ),
    1,
    hotMicSpeechRmsThreshold
  );
  const voiceCaptureGainTargetRms = clamp(
    toFiniteNumber(
      opts?.voiceCaptureGainTargetRms ??
        process.env.AIYRA_VOICE_CAPTURE_GAIN_TARGET_RMS,
      Math.max(1800, Math.round(hotMicSpeechRmsThreshold * 4.0))
    ),
    Math.max(64, voiceDenoisedSpeechRmsThreshold),
    12000
  );
  const voiceCaptureGainMax = clamp(
    toFiniteNumber(
      opts?.voiceCaptureGainMax ?? process.env.AIYRA_VOICE_CAPTURE_GAIN_MAX,
      12
    ),
    1,
    16
  );
  const voiceCaptureGainAttack = clamp(
    toFiniteNumber(
      opts?.voiceCaptureGainAttack ?? process.env.AIYRA_VOICE_CAPTURE_GAIN_ATTACK,
      0.55
    ),
    0.01,
    1
  );
  const voiceCaptureGainRelease = clamp(
    toFiniteNumber(
      opts?.voiceCaptureGainRelease ?? process.env.AIYRA_VOICE_CAPTURE_GAIN_RELEASE,
      0.2
    ),
    0.01,
    1
  );
  const voiceCaptureGainSpeechFloorRms = clamp(
    toFiniteNumber(
      opts?.voiceCaptureGainSpeechFloorRms ??
        process.env.AIYRA_VOICE_CAPTURE_GAIN_SPEECH_FLOOR_RMS,
      // Keep AGC willing to ramp on normal-distance speech instead of only near-hot-mic input.
      Math.max(60, Math.round(hotMicSpeechRmsThreshold * 0.12))
    ),
    20,
    hotMicSpeechRmsThreshold
  );
  const voiceCaptureGainClipHeadroom = clamp(
    toFiniteNumber(
      opts?.voiceCaptureGainClipHeadroom ??
        process.env.AIYRA_VOICE_CAPTURE_GAIN_CLIP_HEADROOM,
      0.92
    ),
    0.5,
    1
  );
  const voiceCaptureGainOnsetAttack = clamp(
    toFiniteNumber(
      opts?.voiceCaptureGainOnsetAttack ??
        process.env.AIYRA_VOICE_CAPTURE_GAIN_ONSET_ATTACK,
      Math.max(1, voiceCaptureGainAttack)
    ),
    voiceCaptureGainAttack,
    1
  );
  const voiceCaptureGainHoldMs = clamp(
    toFiniteNumber(
      opts?.voiceCaptureGainHoldMs ??
        process.env.AIYRA_VOICE_CAPTURE_GAIN_HOLD_MS,
      700
    ),
    0,
    5000
  );
  const voiceCaptureGainHoldRelease = clamp(
    toFiniteNumber(
      opts?.voiceCaptureGainHoldRelease ??
        process.env.AIYRA_VOICE_CAPTURE_GAIN_HOLD_RELEASE,
      Math.min(0.08, voiceCaptureGainRelease)
    ),
    0.01,
    voiceCaptureGainRelease
  );
  const voiceCaptureGainServerBiasMax = clamp(
    toFiniteNumber(
      opts?.voiceCaptureGainServerBiasMax ??
        process.env.AIYRA_VOICE_CAPTURE_GAIN_SERVER_BIAS_MAX,
      2.5
    ),
    1,
    6
  );
  const voiceCaptureGainServerBiasMargin = clamp(
    toFiniteNumber(
      opts?.voiceCaptureGainServerBiasMargin ??
        process.env.AIYRA_VOICE_CAPTURE_GAIN_SERVER_BIAS_MARGIN,
      1.15
    ),
    1,
    3
  );
  const speakerSamplesPerFrame = normalizeMultiple(
    opts?.speakerSamplesPerFrame ?? process.env.AIYRA_SPEAKER_SAMPLES_PER_FRAME,
    256,
    2048,
    256
  );
  const playbackPrimeBufferMs = clamp(
    toFiniteNumber(
      opts?.playbackPrimeBufferMs ??
        process.env.AIYRA_PLAYBACK_PRIME_BUFFER_MS,
      320
    ),
    0,
    1000
  );
  const playbackPrimeMaxWaitMs = clamp(
    toFiniteNumber(
      opts?.playbackPrimeMaxWaitMs ??
        process.env.AIYRA_PLAYBACK_PRIME_MAX_WAIT_MS,
      Math.max(240, playbackPrimeBufferMs)
    ),
    20,
    1500
  );

  const emitMetric = (event, data = {}) => {
    try {
      onMetric({
        event: trimmed(event),
        ts: new Date().toISOString(),
        ...(data && typeof data === "object" ? data : {}),
      });
    } catch {
      // ignore metric sink errors
    }
  };

  const emitHealth = (status, reason, detail, extra = {}) => {
    const payload = {
      status,
      reason,
      detail,
      updated_at: new Date().toISOString(),
      ...extra,
    };
    onHealth(payload);
  };

  const normalizeTwilioSupervisorState = (raw) => {
    const root = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : null;
    const update =
      root?.update && typeof root.update === "object" && !Array.isArray(root.update)
        ? root.update
        : root;
    if (!update) return null;
    const readString = (...values) => {
      for (const value of values) {
        const text = trimmed(value);
        if (text) return text;
      }
      return null;
    };
    const state = {
      id: readString(update.id),
      at: readString(update.at, update.updated_at),
      childConversationId: readString(
        update.childConversationId,
        update.child_conversation_id
      ),
      childKind: readString(update.childKind, update.child_kind),
      status: readString(update.status),
      stage: readString(update.stage),
      summary: readString(update.summary),
      rawText: readString(update.rawText, update.raw_text),
      callSid: readString(update.callSid, update.call_sid),
      messageSid: readString(update.messageSid, update.message_sid),
      speakSuggested:
        typeof update.speakSuggested === "boolean"
          ? update.speakSuggested
          : typeof update.speak_suggested === "boolean"
            ? update.speak_suggested
            : null,
    };
    return Object.values(state).some((value) => value !== null) ? state : null;
  };

  const normalizeDeferredSpeechText = (value, max = 260) => {
    const normalized = trimmed(value)
      .replace(/\[(.*?)\]\((.*?)\)/g, "$1")
      .replace(/[*_`>#]+/g, " ")
      .replace(/\|/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!normalized) return "";
    if (normalized.length <= max) return normalized;
    const sliced = normalized.slice(0, Math.max(0, max - 3)).trimEnd();
    return `${sliced}...`;
  };

  const buildDeferredFollowupSpeechText = ({ answerText = "", errorText = "" } = {}) => {
    const failureText = normalizeDeferredSpeechText(errorText, 220);
    if (failureText) {
      return `I hit a problem finishing that request. ${failureText}`;
    }
    return normalizeDeferredSpeechText(answerText, 260);
  };

  const estimateDeferredSpeechDurationMs = (text) => {
    const normalized = normalizeDeferredSpeechText(text, 400);
    if (!normalized) return 0;
    const wordCount = normalized.split(/\s+/).filter(Boolean).length;
    const wordsPerMinute = Math.max(120, Math.round(175 * lastResolvedTtsSpeed));
    const durationMs = Math.round((wordCount / (wordsPerMinute / 60)) * 1000);
    return clamp(durationMs + 2500, 4000, 90000);
  };

  const suppressWakeDetections = (durationMs, reason = "deferred_followup") => {
    const untilMs = Date.now() + Math.max(0, durationMs);
    wakeSuppressedUntilMs = Math.max(wakeSuppressedUntilMs, untilMs);
    lastWakeAt = Date.now();
    emitMetric("wake_suppressed", {
      reason,
      duration_ms: Math.max(0, durationMs),
    });
  };

  const speakDeferredFollowupLocally = async (text, opts = {}) => {
    if (!localDeferredFollowupSpeechEnabled) {
      emitMetric("voice_deferred_followup_suppressed", {
        reason: opts?.reason || "deferred_followup_local_tts",
        suppression: "disabled_by_default",
      });
      return false;
    }
    const spokenText = normalizeDeferredSpeechText(text, 260);
    if (!spokenText) return false;
    if (os.platform() !== "darwin") {
      emitMetric("voice_deferred_followup_unavailable", {
        reason: "unsupported_platform",
        platform: os.platform(),
      });
      return false;
    }
    const rate = clamp(Math.round(175 * lastResolvedTtsSpeed), 120, 320);
    const estimatedDurationMs = estimateDeferredSpeechDurationMs(spokenText);
    suppressWakeDetections(
      estimatedDurationMs + 5000,
      opts?.reason || "deferred_followup_local_tts"
    );
    emitMetric("voice_deferred_followup_started", {
      reason: opts?.reason || "deferred_followup_local_tts",
      transport: "macos_say",
      text_preview: spokenText.slice(0, 96),
      rate_wpm: rate,
      estimated_duration_ms: estimatedDurationMs || undefined,
    });
    onLog("aiyra deferred followup speech starting", {
      reason: opts?.reason || "deferred_followup_local_tts",
      transport: "macos_say",
      rate_wpm: rate,
      text_preview: spokenText.slice(0, 160),
    });
    const child = spawn("say", ["-r", String(rate), spokenText], {
      stdio: "ignore",
    });
    const finished = await new Promise((resolve) => {
      let settled = false;
      const done = (ok) => {
        if (settled) return;
        settled = true;
        resolve(ok);
      };
      child.once("error", () => done(false));
      child.once("close", (code) => done(code === 0));
    });
    emitMetric("voice_deferred_followup_finished", {
      reason: opts?.reason || "deferred_followup_local_tts",
      transport: "macos_say",
      ok: finished === true,
    });
    return finished === true;
  };

  const startDetachedMaterialQueryFollowup = ({
    conversationId,
    materialQueryTimeoutMs = 0,
    reason = "session_ended_while_waiting",
  } = {}) => {
    const normalizedConversationId = trimmed(conversationId);
    if (!normalizedConversationId || stopRequested) return;
    if (detachedMaterialQueryFollowups.has(normalizedConversationId)) return;
    const followupPromise = (async () => {
      const timeoutMs = clamp(
        Math.max(
          callEndedMaterialQueryGraceMs,
          materialQueryTimeoutMs > 0 ? materialQueryTimeoutMs + 10_000 : 30_000
        ),
        5_000,
        300_000
      );
      const deadlineMs = Date.now() + timeoutMs;
      const baseUrl = appUrl.replace(/\/+$/, "");
      const endpoint = materialQueryProgressPath.startsWith("/")
        ? materialQueryProgressPath
        : `/${materialQueryProgressPath}`;
      const url = `${baseUrl}${endpoint}?conversationId=${encodeURIComponent(
        normalizedConversationId
      )}`;
      let sawRunningState = false;
      emitMetric("voice_deferred_followup_poll_started", {
        reason,
        conversation_id: normalizedConversationId,
        timeout_ms: timeoutMs,
      });
      while (!stopRequested && Date.now() < deadlineMs) {
        if (activeSession?.running) {
          await wait(500);
          continue;
        }
        try {
          const res = await fetch(url, {
            headers: {
              "x-device-token": deviceToken,
            },
          });
          if (!res.ok) {
            await wait(callEndedMaterialQueryPollMs);
            continue;
          }
          const json = await res.json().catch(() => ({}));
          const status = trimmed(json?.status).toLowerCase();
          const progressText =
            trimmed(json?.progressText) || trimmed(json?.progress_text);
          const answerText =
            trimmed(json?.answerText) || trimmed(json?.answer_text);
          const errorText =
            trimmed(json?.errorText) || trimmed(json?.error_text);
          if (status === "running") {
            sawRunningState = sawRunningState || !!progressText;
            await wait(callEndedMaterialQueryPollMs);
            continue;
          }
          if (status === "completed") {
            const speechText = buildDeferredFollowupSpeechText({ answerText });
            if (speechText) {
              await speakDeferredFollowupLocally(speechText, {
                reason: "material_query_completed_after_call_end",
              });
            }
            return;
          }
          if (status === "failed") {
            const speechText = buildDeferredFollowupSpeechText({ errorText });
            if (speechText) {
              await speakDeferredFollowupLocally(speechText, {
                reason: "material_query_failed_after_call_end",
              });
            }
            return;
          }
          if (status === "idle" && sawRunningState) {
            return;
          }
        } catch {
          // ignore detached followup polling failures
        }
        await wait(callEndedMaterialQueryPollMs);
      }
      emitMetric("voice_deferred_followup_poll_timeout", {
        reason,
        conversation_id: normalizedConversationId,
        timeout_ms: timeoutMs,
      });
    })().finally(() => {
      detachedMaterialQueryFollowups.delete(normalizedConversationId);
    });
    detachedMaterialQueryFollowups.set(normalizedConversationId, followupPromise);
  };

  const bootstrapSession = async ({ forceNewConversation = false } = {}) => {
    const url = `${appUrl.replace(/\/+$/, "")}${wsBootstrapPath.startsWith("/") ? wsBootstrapPath : `/${wsBootstrapPath}`}`;
    const startedAtMs = Date.now();
    const requestedConversationId = forceNewConversation ? "" : preferredConversationId;
    const body = {
      channelMode: "mic_main",
      ...(forceNewConversation ? { forceNewConversation: true } : {}),
      ...(requestedConversationId ? { conversationId: requestedConversationId } : {}),
    };
    onLog("aiyra bootstrap request", {
      channel_mode: "mic_main",
      requested_conversation_id: requestedConversationId || null,
      force_new_conversation: forceNewConversation,
    });
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-device-token": deviceToken,
      },
      body: JSON.stringify(body),
    });
    const latencyMs = Math.max(0, Date.now() - startedAtMs);
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      emitMetric("bootstrap_failed", {
        status: res.status,
        latency_ms: latencyMs,
      });
      throw new Error(`aiyra_bootstrap_failed:${res.status}:${text.slice(0, 240)}`);
    }
    emitMetric("bootstrap_ok", { status: res.status, latency_ms: latencyMs });
    const json = await res.json().catch(() => ({}));
    const wsUrl = trimmed(json?.wsUrl);
    const conversationId = trimmed(json?.conversationId);
    const orchestratorSessionId =
      trimmed(json?.orchestratorSessionId) || trimmed(json?.orchestrator_session_id);
    const bindingMode = trimmed(json?.bindingMode || json?.binding_mode);
    const sessionIdleTimeoutMs = clamp(
      toFiniteNumber(json?.idleTimeoutMs ?? json?.idle_timeout_ms, idleTimeoutMs),
      2000,
      120000
    );
    const materialQueryEnabled =
      json?.materialQueryEnabled === true || json?.material_query_enabled === true;
    const materialQueryTimeoutMs =
      materialQueryEnabled
        ? clamp(
            toFiniteNumber(
              json?.materialQueryTimeoutMs ?? json?.material_query_timeout_ms,
              0
            ),
            0,
            300000
          )
        : 0;
    const ttsSpeed = clamp(
      toFiniteNumber(json?.ttsSpeed ?? json?.tts_speed, lastResolvedTtsSpeed),
      0.5,
      2
    );
    if (!wsUrl || !conversationId) {
      emitMetric("bootstrap_invalid_response");
      throw new Error("aiyra_bootstrap_invalid_response");
    }
    onLog("aiyra bootstrap response", {
      requested_conversation_id: requestedConversationId || null,
      conversation_id: conversationId,
      orchestrator_session_id: orchestratorSessionId || null,
      binding_mode: bindingMode || null,
      idle_timeout_ms: sessionIdleTimeoutMs,
      material_query_enabled: materialQueryEnabled,
      material_query_timeout_ms: materialQueryTimeoutMs || null,
      tts_speed: ttsSpeed,
      latency_ms: latencyMs,
    });
    if (
      requestedConversationId &&
      conversationId &&
      requestedConversationId !== conversationId
    ) {
      onWarn("aiyra bootstrap conversation switched", {
        requested_conversation_id: requestedConversationId,
        conversation_id: conversationId,
        orchestrator_session_id: orchestratorSessionId || null,
        binding_mode: bindingMode || null,
      });
    }
    if (bindingMode) {
      onLog("aiyra bootstrap binding", {
        conversationId,
        bindingMode,
      });
    }
    return {
      wsUrl,
      conversationId,
      orchestratorSessionId,
      bindingMode,
      idleTimeoutMs: sessionIdleTimeoutMs,
      materialQueryEnabled,
      materialQueryTimeoutMs,
      ttsSpeed,
    };
  };

  const safeStopWakeRecorder = async () => {
    if (!wakeRecorder) return;
    try {
      wakeRecorder.stop();
    } catch {
      // ignore
    }
    await wait(40);
    try {
      wakeRecorder.release();
    } catch {
      // ignore
    }
    wakeRecorder = null;
  };

  const destroyWakeRnnoiseProcessor = () => {
    try {
      if (wakeRnnoiseProcessor && typeof wakeRnnoiseProcessor.destroy === "function") {
        wakeRnnoiseProcessor.destroy();
      }
    } catch {
      // ignore
    }
    wakeRnnoiseProcessor = null;
  };

  const ensureWakeRnnoiseProcessor = async ({
    detectorFrameLength,
    wakeEngineName,
  }) => {
    if (!rnnoiseEnabled) {
      return detectorFrameLength;
    }
    if (!wakeRnnoiseProcessor) {
      try {
        wakeRnnoiseProcessor = await createRnnoiseProcessor();
        const captureFrameLength = leastCommonMultiple(
          detectorFrameLength,
          wakeRnnoiseProcessor.inputFrameSize
        );
        onLog("aiyra wake rnnoise ready", {
          wake_engine: wakeEngineName,
          detector_frame_length: detectorFrameLength,
          capture_frame_length: captureFrameLength,
          input_frame_size: wakeRnnoiseProcessor.inputFrameSize,
        });
        emitMetric("wake_denoise_ready", {
          wake_engine: wakeEngineName,
          detector_frame_length: detectorFrameLength,
          capture_frame_length: captureFrameLength,
          input_frame_size: wakeRnnoiseProcessor.inputFrameSize,
        });
      } catch (rnnoiseErr) {
        const reason =
          rnnoiseErr instanceof Error ? rnnoiseErr.message : String(rnnoiseErr);
        onWarn("aiyra wake rnnoise unavailable, continuing without denoise", reason);
        emitMetric("wake_denoise_unavailable", {
          wake_engine: wakeEngineName,
          detector_frame_length: detectorFrameLength,
          reason,
        });
        destroyWakeRnnoiseProcessor();
        return detectorFrameLength;
      }
    }
    return leastCommonMultiple(detectorFrameLength, wakeRnnoiseProcessor.inputFrameSize);
  };

  const resetWakeInputSilenceState = ({ resetZeroRecoveryCount = false } = {}) => {
    wakeSilentInputAccumulatedMs = 0;
    wakeSilentInputAlerted = false;
    wakeZeroInputAccumulatedMs = 0;
    if (resetZeroRecoveryCount) {
      wakeZeroInputRecoveryCount = 0;
      wakeZeroInputLastRecoveryAtMs = 0;
    }
  };

  const observeWakeInputHealth = ({
    frameLength,
    rawRms,
    denoisedRms,
    wakeEngineName,
  }) => {
    const observedRawRms = Number.isFinite(Number(rawRms)) ? Number(rawRms) : 0;
    const observedDenoisedRms = Number.isFinite(Number(denoisedRms))
      ? Number(denoisedRms)
      : observedRawRms;
    const observedRms = Math.max(observedRawRms, observedDenoisedRms);
    const frameSamples = Math.max(1, Math.trunc(Number(frameLength) || 0));
    const frameDurationMs = Math.max(1, Math.round((frameSamples * 1000) / 16000));
    let shouldRecycleRecorder = false;
    let recycleAttempt = 0;
    const exactZeroInput = observedRawRms <= 0 && observedDenoisedRms <= 0;

    if (exactZeroInput) {
      wakeZeroInputAccumulatedMs += frameDurationMs;
      const nowMs = Date.now();
      const recoveryCooldownElapsed =
        !wakeZeroInputLastRecoveryAtMs ||
        nowMs - wakeZeroInputLastRecoveryAtMs >= wakeZeroInputRecoveryCooldownMs;
      if (
        recoveryCooldownElapsed &&
        wakeZeroInputAccumulatedMs >= wakeZeroInputWindowMs &&
        wakeZeroInputRecoveryCount < wakeZeroInputRecoveryMax
      ) {
        wakeZeroInputAccumulatedMs = 0;
        wakeZeroInputRecoveryCount += 1;
        wakeZeroInputLastRecoveryAtMs = nowMs;
        shouldRecycleRecorder = true;
        recycleAttempt = wakeZeroInputRecoveryCount;
        onWarn("aiyra wake-word recorder returned exact-zero frames; recycling recorder", {
          wake_word: effectiveWakeWord,
          wake_engine: wakeEngineName,
          zero_input_ms: wakeZeroInputWindowMs,
          recovery_attempt: recycleAttempt,
        });
        emitMetric("wake_zero_input_recovering", {
          wake_word: effectiveWakeWord,
          wake_engine: wakeEngineName,
          zero_input_ms: wakeZeroInputWindowMs,
          recovery_attempt: recycleAttempt,
        });
      }
    } else {
      wakeZeroInputAccumulatedMs = 0;
      if (wakeZeroInputRecoveryCount > 0) {
        emitMetric("wake_zero_input_recovered", {
          wake_word: effectiveWakeWord,
          wake_engine: wakeEngineName,
          recovery_attempts: wakeZeroInputRecoveryCount,
          raw_rms: observedRawRms,
          denoised_rms: observedDenoisedRms,
        });
        wakeZeroInputRecoveryCount = 0;
        wakeZeroInputLastRecoveryAtMs = 0;
      }
    }

    if (observedRms <= wakeSilentInputRmsThreshold) {
      wakeSilentInputAccumulatedMs += frameDurationMs;
      if (
        !wakeSilentInputAlerted &&
        wakeSilentInputAccumulatedMs >= wakeSilentInputWindowMs
      ) {
        wakeSilentInputAlerted = true;
        const detail =
          "Wake-word microphone input looks silent. Check macOS microphone permission and the selected input device.";
        onWarn("aiyra wake-word input is silent", {
          wake_word: effectiveWakeWord,
          wake_engine: wakeEngineName,
          silent_input_ms: wakeSilentInputAccumulatedMs,
          rms_threshold: wakeSilentInputRmsThreshold,
          raw_rms: observedRawRms,
          denoised_rms: observedDenoisedRms,
        });
        emitMetric("wake_input_silent", {
          wake_word: effectiveWakeWord,
          wake_engine: wakeEngineName,
          silent_input_ms: wakeSilentInputAccumulatedMs,
          rms_threshold: wakeSilentInputRmsThreshold,
          raw_rms: observedRawRms,
          denoised_rms: observedDenoisedRms,
        });
        emitHealth("degraded", "aiyra_wake_input_silent", detail, {
          wake_word: effectiveWakeWord,
          listening: true,
          active: false,
          muted: false,
          wakeword_source: wakewordSource,
          wake_engine: wakeEngineName,
          wake_silent_input_ms: wakeSilentInputAccumulatedMs,
          wake_silent_rms_threshold: wakeSilentInputRmsThreshold,
          wake_silent_last_raw_rms: observedRawRms,
          wake_silent_last_denoised_rms: observedDenoisedRms,
        });
      }
      return {
        shouldRecycleRecorder,
        recycleAttempt,
      };
    }

    wakeSilentInputAccumulatedMs = 0;
    if (wakeSilentInputAlerted) {
      wakeSilentInputAlerted = false;
      emitMetric("wake_input_recovered", {
        wake_word: effectiveWakeWord,
        wake_engine: wakeEngineName,
        rms_threshold: wakeSilentInputRmsThreshold,
        raw_rms: observedRawRms,
        denoised_rms: observedDenoisedRms,
      });
      emitHealth(
        "healthy",
        "aiyra_wake_input_recovered",
        `Wake-word microphone input recovered for "${effectiveWakeWord}"`,
        {
          wake_word: effectiveWakeWord,
          listening: true,
          active: false,
          muted: false,
          wakeword_source: wakewordSource,
          wake_engine: wakeEngineName,
        }
      );
    }
    return {
      shouldRecycleRecorder,
      recycleAttempt,
    };
  };

  const processWakeFrame = ({ frame, wakeEngineName }) => {
    const rawRms = frameRms(frame);
    let processedFrame = frame;
    let rnnoiseVad = null;
    if (wakeRnnoiseProcessor) {
      try {
        const denoised = wakeRnnoiseProcessor.processFrame(frame);
        processedFrame = denoised.frame;
        const maxVad = Number(denoised.maxVadProbability);
        const avgVad = Number(denoised.vadProbability);
        if (Number.isFinite(maxVad)) {
          rnnoiseVad = maxVad;
        } else if (Number.isFinite(avgVad)) {
          rnnoiseVad = avgVad;
        }
      } catch (rnnoiseErr) {
        const reason =
          rnnoiseErr instanceof Error ? rnnoiseErr.message : String(rnnoiseErr);
        onWarn("aiyra wake rnnoise processing failed, disabling denoise", reason);
        emitMetric("wake_denoise_failed", {
          wake_engine: wakeEngineName,
          reason,
        });
        destroyWakeRnnoiseProcessor();
        processedFrame = frame;
      }
    }
    const denoisedRms =
      processedFrame === frame ? rawRms : frameRms(processedFrame);
    const healthState = observeWakeInputHealth({
      frameLength: processedFrame.length,
      rawRms,
      denoisedRms,
      wakeEngineName,
    });
    return {
      frame: processedFrame,
      rnnoiseVad,
      rawRms,
      denoisedRms,
      shouldRecycleRecorder: healthState?.shouldRecycleRecorder === true,
      recycleAttempt: Number.isFinite(Number(healthState?.recycleAttempt))
        ? Number(healthState.recycleAttempt)
        : 0,
    };
  };

  const recoverWakeRecorder = async ({
    detectorFrameLength,
    wakeEngineName,
    attempt,
    error,
  }) => {
    const message = error instanceof Error ? error.message : String(error);
    onWarn("aiyra wake recorder read failed; attempting recovery", {
      wake_engine: wakeEngineName,
      detector_frame_length: detectorFrameLength,
      attempt,
      error: message,
    });
    emitMetric("wake_recorder_read_failed", {
      wake_engine: wakeEngineName,
      detector_frame_length: detectorFrameLength,
      attempt,
      error: message,
    });
    emitHealth("recovering", "aiyra_wake_recorder_recovering", "Recovering wake-word microphone...", {
      wake_word: effectiveWakeWord,
      listening: false,
      active: false,
      muted: false,
      wakeword_source: wakewordSource,
      wake_engine: wakeEngineName,
    });

    try {
      if (wakeRecorder) wakeRecorder.stop();
    } catch {
      // ignore
    }
    await wait(Math.min(1000, 150 + attempt * 200));
    try {
      if (wakeRecorder) wakeRecorder.release();
    } catch {
      // ignore
    }
    wakeRecorder = null;

    // If the recorder glitched multiple times in a row, recreate RNNoise too.
    if (attempt > 1) {
      destroyWakeRnnoiseProcessor();
    }

    const captureFrameLength = await ensureWakeRnnoiseProcessor({
      detectorFrameLength,
      wakeEngineName,
    });
    const currentDeviceIndex = await getCurrentDeviceIndex();
    wakeRecorder = new PvRecorder(captureFrameLength, currentDeviceIndex);
    wakeRecorder.start();
    emitMetric("wake_recorder_recovered", {
      wake_engine: wakeEngineName,
      detector_frame_length: detectorFrameLength,
      capture_frame_length: captureFrameLength,
      attempt,
      device_index: currentDeviceIndex,
    });
    resetWakeInputSilenceState();
    emitHealth("healthy", "aiyra_wake_listening", `Listening for "${effectiveWakeWord}"`, {
      wake_word: effectiveWakeWord,
      listening: true,
      active: false,
      muted: false,
      wake_sensitivity: wakeSensitivity,
      idle_timeout_ms: idleTimeoutMs,
      hot_mic_window_ms: hotMicWindowMs,
      hot_mic_speech_rms_threshold: hotMicSpeechRmsThreshold,
      wakeword_source: wakewordSource,
      wake_engine: wakeEngineName,
      openwakeword_threshold:
        wakeEngineName === "openwakeword" ? openWakewordThreshold : undefined,
    });
  };

  const runVoiceSession = async (source = "wake_word") => {
    if (activeSession?.running) return false;
    const sessionStartedAtMs = Date.now();
    const forceNewConversation =
      forceNewConversationPerSession &&
      (source === "wake_word" || source === "manual_trigger");
    if (forceNewConversation) {
      preferredConversationId = "";
    }
    let endReason = "completed";
    let sessionConversationId = "";
    let sessionOrchestratorSessionId = "";
    let sessionBindingMode = "";
    let sessionServerGainBias = adaptiveVoiceCaptureGainServerBias;
    const sessionState = { running: true, source, stop: null };
    activeSession = sessionState;
    sessionMicMuted = false;
    onLog("aiyra voice session start", {
      source,
      preferred_conversation_id: preferredConversationId || null,
      force_new_conversation: forceNewConversation,
      rnnoise_enabled: rnnoiseEnabled,
      aec_requested: voiceAecEnabled,
      aec_backend_requested: voiceAecBackend,
      aec_frame_size: voiceAecEnabled ? voiceAecFrameSize : null,
      aec_filter_length: voiceAecEnabled ? voiceAecFilterLength : null,
      playback_hold_ms_requested: voiceAecEnabled
        ? assistantPlaybackHoldWithAecMs
        : assistantPlaybackHoldFallbackMs,
      playback_prime_buffer_ms: playbackPrimeBufferMs,
      playback_prime_max_wait_ms: playbackPrimeMaxWaitMs,
      voice_capture_gain_target_rms: voiceCaptureGainTargetRms,
      voice_capture_gain_max: voiceCaptureGainMax,
      voice_capture_gain_speech_floor_rms: voiceCaptureGainSpeechFloorRms,
      voice_capture_gain_clip_headroom: voiceCaptureGainClipHeadroom,
      voice_capture_gain_onset_attack: voiceCaptureGainOnsetAttack,
      voice_capture_gain_hold_ms: voiceCaptureGainHoldMs,
      voice_capture_gain_hold_release: voiceCaptureGainHoldRelease,
      voice_capture_gain_server_bias: sessionServerGainBias,
      voice_capture_gain_effective_target_rms: Math.round(
        voiceCaptureGainTargetRms * sessionServerGainBias
      ),
      speaker_samples_per_frame: speakerSamplesPerFrame,
      voice_rnnoise_vad_threshold: rnnoiseEnabled
        ? voiceSpeechRnnoiseVadThreshold
        : null,
      voice_denoised_speech_rms_threshold: rnnoiseEnabled
        ? voiceDenoisedSpeechRmsThreshold
        : null,
    });
    emitMetric("voice_session_started", {
      source,
      rnnoise_enabled: rnnoiseEnabled,
      aec_requested: voiceAecEnabled,
      aec_backend_requested: voiceAecBackend,
      aec_frame_size: voiceAecEnabled ? voiceAecFrameSize : undefined,
      aec_filter_length: voiceAecEnabled ? voiceAecFilterLength : undefined,
      playback_hold_ms_requested: voiceAecEnabled
        ? assistantPlaybackHoldWithAecMs
        : assistantPlaybackHoldFallbackMs,
      playback_prime_buffer_ms: playbackPrimeBufferMs,
      playback_prime_max_wait_ms: playbackPrimeMaxWaitMs,
      voice_capture_gain_target_rms: voiceCaptureGainTargetRms,
      voice_capture_gain_max: voiceCaptureGainMax,
      voice_capture_gain_speech_floor_rms: voiceCaptureGainSpeechFloorRms,
      voice_capture_gain_clip_headroom: voiceCaptureGainClipHeadroom,
      voice_capture_gain_onset_attack: voiceCaptureGainOnsetAttack,
      voice_capture_gain_hold_ms: voiceCaptureGainHoldMs,
      voice_capture_gain_hold_release: voiceCaptureGainHoldRelease,
      voice_capture_gain_server_bias: sessionServerGainBias,
      voice_capture_gain_effective_target_rms: Math.round(
        voiceCaptureGainTargetRms * sessionServerGainBias
      ),
      speaker_samples_per_frame: speakerSamplesPerFrame,
      voice_rnnoise_vad_threshold: rnnoiseEnabled
        ? voiceSpeechRnnoiseVadThreshold
        : undefined,
      voice_denoised_speech_rms_threshold: rnnoiseEnabled
        ? voiceDenoisedSpeechRmsThreshold
        : undefined,
    });
    emitHealth("recovering", "aiyra_voice_connecting", "Wake phrase detected. Connecting to Aiyra...", {
      wake_word: effectiveWakeWord,
      listening: false,
      active: true,
      muted: false,
      wakeword_source: wakewordSource,
      wake_engine: wakeDetectorEngine,
      aec_enabled: voiceAecEnabled,
      aec_backend_requested: voiceAecBackend,
      aec_backend: null,
      aec_status: voiceAecEnabled ? "starting" : "disabled",
      aec_last_error: null,
      low_mic_gain_detected: false,
      low_mic_gain_at: null,
      low_mic_gain_message: null,
      low_mic_gain_max_energy_observed: null,
      low_mic_gain_threshold: null,
    });

    let ws = null;
    let micRecorder = null;
    let aecProcessor = null;
    let rnnoiseProcessor = null;
    let voiceMicFrameLength = 512;
    let speaker = null;
    let audioLoopRunning = true;
    let lastUserInteractionAt = Date.now();
    let lastAssistantActivityAt = 0;
    let assistantPlaybackActiveUntilMs = 0;
    let assistantResponseActive = false;
    let assistantResponseHadAudio = false;
    let idleTimer = null;
    let detectedServerAudioRate = VOICE_PLAYBACK_SAMPLE_RATE;
    const seenWsEventTypes = new Set();
    let sawAudioDelta = false;
    let userSpokeInSession = false;
    let sessionLowMicGainDetected = false;
    let lastSpeechActivityMetricAtMs = 0;
    let lastSpeechFilteredMetricAtMs = 0;
    let lastAudioActivityMetricAtMs = 0;
    let lastHalfDuplexMetricAtMs = 0;
    let lastAecUnderrunMetricAtMs = 0;
    let lastAecStatsMetricAtMs = 0;
    let lastAecStarvationBypassMetricAtMs = 0;
    let lastCaptureGainMetricAtMs = 0;
    const activityMetricThrottleMs = 1200;
    let assistantPlaybackHoldMs = assistantPlaybackHoldFallbackMs;
    let sessionIdleTimeoutMs = idleTimeoutMs;
    let sessionMaterialQueryEnabled = false;
    let sessionMaterialQueryTimeoutMs = 0;
    let assistantResponseFreshMs = 30000;
    const playbackBytesPerMs =
      (VOICE_PLAYBACK_SAMPLE_RATE *
        VOICE_PLAYBACK_CHANNELS *
        VOICE_PLAYBACK_BYTES_PER_SAMPLE) /
      1000;
    let playbackPendingBuffers = [];
    let playbackPendingBytes = 0;
    let playbackPrimeStartedAtMs = 0;
    let playbackPrimeTimer = null;
    let playbackPumpScheduled = false;
    let playbackWaitingForDrain = false;
    let playbackPrimed = playbackPrimeBufferMs <= 0;
    let playbackScheduledUntilMs = 0;
    let playbackDrainInProgress = false;
    let activeAssistantResponseId = "";
    let activeAssistantResponseStartedAtMs = 0;
    let assistantAudioChunkCount = 0;
    let assistantAudioBytes = 0;
    let assistantTranscriptChunkCount = 0;
    let assistantTranscriptChars = 0;
    let assistantTranscriptPreview = "";
    let lastAssistantAudioFingerprint = "";
    let lastAssistantAudioFingerprintAtMs = 0;
    let lastPlaybackBackpressureLogAtMs = 0;
    let sessionStopPromise = null;
    let thinkingPulseTimer = null;
    let thinkingPulseStepTimer = null;
    let thinkingPulseInterval = null;
    let thinkingPulsePlaybackRunId = 0;
    let thinkingPulsePlaybackActive = false;
    let voiceCaptureGainState = 1;
    let lastMeaningfulSpeechAtMs = 0;
    let wakeWordAudioDiscardUntilMs = 0;
    let spokenProgressTimer = null;
    let spokenProgressPoll = null;
    let lastSpokenProgressText = "";
    let lastSpokenProgressAtMs = 0;
    let lastMaterialProgressUpdatedAt = "";
    let lastMaterialProgressTerminalAt = "";
    let pendingDeferredTerminalSpeechText = "";
    let syntheticSpokenResponsePendingUntilMs = 0;
    let progressTrackingRunId = 0;
    let callEndedGraceTimer = null;
    let callEndedGracePoll = null;
    let callEndedAwaitingMaterialQueryTerminal = false;
    let stopAfterSyntheticSpokenResponse = false;
    let materialQueryTrackingStartedAtMs = 0;
    let materialQueryObservedNonIdle = false;
    let lastMaterialProgressLogKey = "";
    const voicePipelineDiagnostics = {
      frameCount: 0,
      userSpeechFrameCount: 0,
      filteredSpeechFrameCount: 0,
      aecStarvationBypassCount: 0,
      lastFrame: null,
      lastSpeechFrame: null,
      lastFilteredFrame: null,
      sessionMax: Object.create(null),
      speechMax: Object.create(null),
      lastAecStats: null,
      lastAecUnderrunSamples: 0,
      lastAecUnderrunAtMs: 0,
    };

    const updateVoiceDiagnosticMaxima = (bucket, snapshot) => {
      if (!bucket || !snapshot || typeof snapshot !== "object") return;
      for (const key of [
        "rawRms",
        "rawPeakAbs",
        "aecOutputRms",
        "aecOutputPeakAbs",
        "rnnoiseOutputRms",
        "rnnoiseOutputPeakAbs",
        "sentRms",
        "sentPeakAbs",
        "appliedGain",
      ]) {
        const value = Number(snapshot[key]);
        if (!Number.isFinite(value)) continue;
        bucket[key] = Number.isFinite(bucket[key])
          ? Math.max(bucket[key], value)
          : value;
      }
    };

    const recordVoiceFrameDiagnostics = (snapshot, opts = {}) => {
      if (!snapshot || typeof snapshot !== "object") return;
      voicePipelineDiagnostics.frameCount += 1;
      voicePipelineDiagnostics.lastFrame = snapshot;
      updateVoiceDiagnosticMaxima(voicePipelineDiagnostics.sessionMax, snapshot);
      if (opts.countsAsUserSpeech) {
        voicePipelineDiagnostics.userSpeechFrameCount += 1;
        voicePipelineDiagnostics.lastSpeechFrame = snapshot;
        updateVoiceDiagnosticMaxima(voicePipelineDiagnostics.speechMax, snapshot);
      } else if (opts.rawSpeechCandidate) {
        voicePipelineDiagnostics.filteredSpeechFrameCount += 1;
        voicePipelineDiagnostics.lastFilteredFrame = snapshot;
      }
      if (opts.aecBypassedOnStarvation) {
        voicePipelineDiagnostics.aecStarvationBypassCount += 1;
      }
    };

    const buildVoiceLowMicDiagnosticPayload = ({
      maxEnergyObserved,
      threshold,
      message,
      nowMs,
      serverGainBiasBefore = sessionServerGainBias,
      serverGainBiasAfter = sessionServerGainBias,
    }) => {
      const copySnapshot = (prefix, snapshot) => ({
        [`${prefix}_age_ms`]:
          snapshot && Number.isFinite(snapshot.ts)
            ? Math.max(0, nowMs - snapshot.ts)
            : undefined,
        [`${prefix}_raw_rms`]: snapshot?.rawRms,
        [`${prefix}_raw_peak_abs`]: snapshot?.rawPeakAbs,
        [`${prefix}_aec_output_rms`]: snapshot?.aecOutputRms,
        [`${prefix}_aec_output_peak_abs`]: snapshot?.aecOutputPeakAbs,
        [`${prefix}_rnnoise_output_rms`]: snapshot?.rnnoiseOutputRms,
        [`${prefix}_rnnoise_output_peak_abs`]: snapshot?.rnnoiseOutputPeakAbs,
        [`${prefix}_sent_rms`]: snapshot?.sentRms,
        [`${prefix}_sent_peak_abs`]: snapshot?.sentPeakAbs,
        [`${prefix}_capture_gain`]: snapshot?.appliedGain,
        [`${prefix}_target_gain`]: snapshot?.targetGain,
        [`${prefix}_clipped_samples`]:
          Number.isFinite(snapshot?.clippedSamples) && snapshot.clippedSamples > 0
            ? snapshot.clippedSamples
            : undefined,
        [`${prefix}_rnnoise_vad_probability`]: snapshot?.rnnoiseVad,
        [`${prefix}_aec_suppression_ratio`]: snapshot?.aecSuppressionRatio,
        [`${prefix}_rnnoise_suppression_ratio`]:
          snapshot?.rnnoiseSuppressionRatio,
        [`${prefix}_sent_boost_ratio`]: snapshot?.sentBoostRatio,
        [`${prefix}_server_gain_bias`]: snapshot?.serverGainBias,
        [`${prefix}_effective_target_rms`]: snapshot?.effectiveTargetRms,
        [`${prefix}_raw_speech_candidate`]:
          snapshot?.rawSpeechCandidate === true ? true : undefined,
        [`${prefix}_rnnoise_speech_accepted`]:
          snapshot?.rnnoiseSpeechAccepted === false ? false : undefined,
        [`${prefix}_counts_as_user_speech`]:
          snapshot?.countsAsUserSpeech === true ? true : undefined,
        [`${prefix}_aec_bypassed_on_starvation`]:
          snapshot?.aecBypassedOnStarvation === true ? true : undefined,
      });
      const lastAec = voicePipelineDiagnostics.lastAecStats || {};
      return {
        source,
        message,
        max_energy_observed: Number.isFinite(maxEnergyObserved)
          ? maxEnergyObserved
          : undefined,
        threshold: Number.isFinite(threshold) ? threshold : undefined,
        max_energy_ratio:
          safeRatio(maxEnergyObserved, threshold) ?? undefined,
        session_frame_count: voicePipelineDiagnostics.frameCount || undefined,
        session_user_speech_frame_count:
          voicePipelineDiagnostics.userSpeechFrameCount || undefined,
        session_filtered_speech_frame_count:
          voicePipelineDiagnostics.filteredSpeechFrameCount || undefined,
        session_aec_starvation_bypass_count:
          voicePipelineDiagnostics.aecStarvationBypassCount || undefined,
        session_max_raw_rms: voicePipelineDiagnostics.sessionMax.rawRms,
        session_max_raw_peak_abs: voicePipelineDiagnostics.sessionMax.rawPeakAbs,
        session_max_aec_output_rms:
          voicePipelineDiagnostics.sessionMax.aecOutputRms,
        session_max_aec_output_peak_abs:
          voicePipelineDiagnostics.sessionMax.aecOutputPeakAbs,
        session_max_rnnoise_output_rms:
          voicePipelineDiagnostics.sessionMax.rnnoiseOutputRms,
        session_max_rnnoise_output_peak_abs:
          voicePipelineDiagnostics.sessionMax.rnnoiseOutputPeakAbs,
        session_max_sent_rms: voicePipelineDiagnostics.sessionMax.sentRms,
        session_max_sent_peak_abs:
          voicePipelineDiagnostics.sessionMax.sentPeakAbs,
        speech_max_raw_rms: voicePipelineDiagnostics.speechMax.rawRms,
        speech_max_raw_peak_abs: voicePipelineDiagnostics.speechMax.rawPeakAbs,
        speech_max_aec_output_rms:
          voicePipelineDiagnostics.speechMax.aecOutputRms,
        speech_max_aec_output_peak_abs:
          voicePipelineDiagnostics.speechMax.aecOutputPeakAbs,
        speech_max_rnnoise_output_rms:
          voicePipelineDiagnostics.speechMax.rnnoiseOutputRms,
        speech_max_rnnoise_output_peak_abs:
          voicePipelineDiagnostics.speechMax.rnnoiseOutputPeakAbs,
        speech_max_sent_rms: voicePipelineDiagnostics.speechMax.sentRms,
        speech_max_sent_peak_abs: voicePipelineDiagnostics.speechMax.sentPeakAbs,
        voice_capture_gain_target_rms: voiceCaptureGainTargetRms,
        voice_capture_gain_max: voiceCaptureGainMax,
        voice_capture_gain_effective_target_rms: Math.round(
          voiceCaptureGainTargetRms * serverGainBiasAfter
        ),
        voice_capture_gain_onset_attack: voiceCaptureGainOnsetAttack,
        voice_capture_gain_hold_ms: voiceCaptureGainHoldMs,
        voice_capture_gain_hold_release: voiceCaptureGainHoldRelease,
        voice_capture_gain_server_bias_before: serverGainBiasBefore,
        voice_capture_gain_server_bias_after: serverGainBiasAfter,
        voice_capture_gain_server_bias_margin: voiceCaptureGainServerBiasMargin,
        voice_capture_gain_server_bias_max: voiceCaptureGainServerBiasMax,
        voice_rnnoise_vad_threshold:
          rnnoiseProcessor ? voiceSpeechRnnoiseVadThreshold : undefined,
        voice_denoised_speech_rms_threshold:
          rnnoiseProcessor ? voiceDenoisedSpeechRmsThreshold : undefined,
        last_aec_audio_buffer_delay_ms:
          Number.isFinite(lastAec.audioBufferDelayMs)
            ? lastAec.audioBufferDelayMs
            : undefined,
        last_aec_buffered_render_ms:
          Number.isFinite(lastAec.bufferedRenderMs)
            ? lastAec.bufferedRenderMs
            : undefined,
        last_aec_capture_input_rms:
          Number.isFinite(lastAec.captureInputRms)
            ? lastAec.captureInputRms
            : undefined,
        last_aec_render_input_rms:
          Number.isFinite(lastAec.renderInputRms)
            ? lastAec.renderInputRms
            : undefined,
        last_aec_pre_cancel_rms:
          Number.isFinite(lastAec.preCancelRms)
            ? lastAec.preCancelRms
            : undefined,
        last_aec_output_rms:
          Number.isFinite(lastAec.outputRms) ? lastAec.outputRms : undefined,
        last_aec_reference_state:
          trimmed(lastAec.referenceState) || undefined,
        last_aec_bypassed_on_starvation:
          lastAec.bypassedOnStarvation === true ? true : undefined,
        last_aec_reset_count:
          Number.isFinite(lastAec.resetCount) ? lastAec.resetCount : undefined,
        last_aec_underrun_samples:
          voicePipelineDiagnostics.lastAecUnderrunSamples > 0
            ? voicePipelineDiagnostics.lastAecUnderrunSamples
            : undefined,
        last_aec_underrun_ago_ms:
          voicePipelineDiagnostics.lastAecUnderrunAtMs > 0
            ? Math.max(0, nowMs - voicePipelineDiagnostics.lastAecUnderrunAtMs)
            : undefined,
        ...copySnapshot("last_frame", voicePipelineDiagnostics.lastFrame),
        ...copySnapshot("last_speech", voicePipelineDiagnostics.lastSpeechFrame),
        ...copySnapshot(
          "last_filtered",
          voicePipelineDiagnostics.lastFilteredFrame
        ),
      };
    };

    const emitActiveSessionHealth = (reason = "aiyra_voice_active", detail = "") => {
      emitHealth("healthy", reason, detail || "Connected to Aiyra voice session.", {
        wake_word: effectiveWakeWord,
        listening: false,
        active: true,
        muted: sessionMicMuted,
        wakeword_source: wakewordSource,
        wake_engine: wakeDetectorEngine,
        aec_enabled: voiceAecEnabled,
        aec_backend_requested: voiceAecBackend,
        aec_backend: aecProcessor?.backend || null,
        aec_status: voiceAecEnabled ? (aecProcessor ? "ready" : "unavailable") : "disabled",
        aec_last_error: null,
        idle_timeout_ms: sessionIdleTimeoutMs,
        low_mic_gain_detected: false,
        low_mic_gain_at: null,
        low_mic_gain_message: null,
        low_mic_gain_max_energy_observed: null,
        low_mic_gain_threshold: null,
        conversation_id: sessionConversationId || null,
        orchestrator_session_id: sessionOrchestratorSessionId || null,
      });
    };

    const resolveCallEndedMaterialQueryWaitMs = () => {
      const materialQueryWaitMs =
        sessionMaterialQueryEnabled && sessionMaterialQueryTimeoutMs > 0
          ? sessionMaterialQueryTimeoutMs + 10_000
          : 0;
      return clamp(
        Math.max(callEndedMaterialQueryGraceMs, sessionIdleTimeoutMs, materialQueryWaitMs),
        500,
        300_000
      );
    };

    const resolveCallEndedFinalResponseWaitMs = () =>
      clamp(
        Math.max(callEndedFinalResponseGraceMs, assistantPlaybackHoldMs + 15_000),
        2_000,
        120_000
      );

    const disableAec = (reason, metricEvent = "voice_aec_failed") => {
      if (!aecProcessor) return;
      const normalizedReason = reason instanceof Error ? reason.message : String(reason || "");
      const activeAecBackend = aecProcessor?.backend || voiceAecBackend;
      onWarn("aiyra voice aec disabled", {
        backend: activeAecBackend,
        reason: normalizedReason || "unknown_error",
      });
      emitMetric(metricEvent, {
        source,
        backend: activeAecBackend,
        backend_requested: voiceAecBackend,
        reason: normalizedReason || "unknown_error",
      });
      try {
        aecProcessor.destroy();
      } catch {
        // ignore cleanup failures while disabling
      }
      aecProcessor = null;
      assistantPlaybackHoldMs = assistantPlaybackHoldFallbackMs;
      voicePipelineDiagnostics.lastAecStats = null;
    };

    const clearPlaybackPrimeTimer = () => {
      if (playbackPrimeTimer) {
        clearTimeout(playbackPrimeTimer);
        playbackPrimeTimer = null;
      }
    };

    const estimatePlaybackBufferedMs = (nowMs = Date.now()) => {
      const pendingMs = playbackPendingBytes / Math.max(1, playbackBytesPerMs);
      const scheduledMs = Math.max(0, playbackScheduledUntilMs - nowMs);
      return pendingMs + scheduledMs;
    };

    const refreshAssistantPlaybackWindow = (
      nowMs = Date.now(),
      holdMs = assistantPlaybackHoldMs
    ) => {
      assistantPlaybackActiveUntilMs = Math.max(
        assistantPlaybackActiveUntilMs,
        nowMs +
          estimatePlaybackBufferedMs(nowMs) +
          Math.max(0, toFiniteNumber(holdMs, assistantPlaybackHoldMs))
      );
    };

    const estimateSessionPlaybackRemainingMs = (nowMs = Date.now()) =>
      Math.max(
        estimatePlaybackBufferedMs(nowMs),
        Math.max(0, assistantPlaybackActiveUntilMs - nowMs)
      );

    const maybeResetPlaybackPrimeState = (nowMs = Date.now()) => {
      if (playbackPendingBytes > 0) return;
      if (playbackScheduledUntilMs > nowMs) return;
      playbackPrimed = playbackPrimeBufferMs <= 0;
      playbackPrimeStartedAtMs = 0;
    };

    const dropPendingPlaybackKind = (kind) => {
      if (!kind || playbackPendingBuffers.length === 0) return;
      let droppedBytes = 0;
      playbackPendingBuffers = playbackPendingBuffers.filter((entry) => {
        if (!entry || entry.kind !== kind) return true;
        droppedBytes += Buffer.isBuffer(entry.chunk) ? entry.chunk.length : 0;
        return false;
      });
      if (droppedBytes > 0) {
        playbackPendingBytes = Math.max(0, playbackPendingBytes - droppedBytes);
        maybeResetPlaybackPrimeState();
      }
    };

    const getPendingPlaybackKindStats = (kind) => {
      let buffers = 0;
      let bytes = 0;
      for (const entry of playbackPendingBuffers) {
        if (!entry) continue;
        if (kind && entry.kind !== kind) continue;
        buffers += 1;
        bytes += Buffer.isBuffer(entry.chunk) ? entry.chunk.length : 0;
      }
      return { buffers, bytes };
    };

    const resetAssistantResponseTrace = (responseId = "", nowMs = Date.now()) => {
      activeAssistantResponseId = trimmed(responseId);
      activeAssistantResponseStartedAtMs = nowMs;
      assistantAudioChunkCount = 0;
      assistantAudioBytes = 0;
      assistantTranscriptChunkCount = 0;
      assistantTranscriptChars = 0;
      assistantTranscriptPreview = "";
      lastAssistantAudioFingerprint = "";
      lastAssistantAudioFingerprintAtMs = 0;
    };

    const logAssistantResponseSnapshot = (label, extra = {}) => {
      const pendingAssistant = getPendingPlaybackKindStats("assistant");
      onLog(label, {
        response_id: activeAssistantResponseId || null,
        response_age_ms: activeAssistantResponseStartedAtMs
          ? Math.max(0, Date.now() - activeAssistantResponseStartedAtMs)
          : null,
        audio_chunks: assistantAudioChunkCount,
        audio_bytes: assistantAudioBytes,
        transcript_chunks: assistantTranscriptChunkCount,
        transcript_chars: assistantTranscriptChars,
        transcript_preview: assistantTranscriptPreview || null,
        pending_assistant_buffers: pendingAssistant.buffers,
        pending_assistant_bytes: pendingAssistant.bytes,
        ...extra,
      });
    };

    const clearThinkingPulseTimer = () => {
      if (thinkingPulseTimer) {
        clearTimeout(thinkingPulseTimer);
        thinkingPulseTimer = null;
      }
    };

    const clearThinkingPulseStepTimer = () => {
      if (thinkingPulseStepTimer) {
        clearTimeout(thinkingPulseStepTimer);
        thinkingPulseStepTimer = null;
      }
    };

    const stopThinkingPulse = (reason = "stopped") => {
      clearThinkingPulseTimer();
      clearThinkingPulseStepTimer();
      thinkingPulsePlaybackRunId += 1;
      thinkingPulsePlaybackActive = false;
      if (thinkingPulseInterval) {
        clearInterval(thinkingPulseInterval);
        thinkingPulseInterval = null;
        emitMetric("voice_thinking_pulse_stopped", { source, reason });
      }
      dropPendingPlaybackKind("thinking_pulse");
    };

    const resolveThinkingPulseHoldMs = () =>
      aecProcessor
        ? Math.min(thinkingPulseHoldMs, assistantPlaybackHoldWithAecMs)
        : thinkingPulseHoldMs;

    const queueThinkingPulseStep = (
      runId,
      offsetBytes = 0,
      nowMs = Date.now()
    ) => {
      if (!thinkingPulseBuffer || !speaker) {
        thinkingPulsePlaybackActive = false;
        return;
      }
      if (
        runId !== thinkingPulsePlaybackRunId ||
        !assistantResponseActive ||
        assistantResponseHadAudio
      ) {
        thinkingPulsePlaybackActive = false;
        return;
      }
      const bytesPerFrame =
        VOICE_PLAYBACK_CHANNELS * VOICE_PLAYBACK_BYTES_PER_SAMPLE;
      const framesPerChunk = Math.max(
        1,
        Math.round((VOICE_PLAYBACK_SAMPLE_RATE * thinkingPulseChunkMs) / 1000)
      );
      const bytesPerChunk = Math.max(
        bytesPerFrame,
        framesPerChunk * bytesPerFrame
      );
      const nextOffset = Math.min(
        thinkingPulseBuffer.length,
        offsetBytes + bytesPerChunk
      );
      const chunk =
        nextOffset > offsetBytes
          ? thinkingPulseBuffer.subarray(offsetBytes, nextOffset)
          : null;
      if (!chunk || chunk.length === 0) {
        thinkingPulsePlaybackActive = false;
        return;
      }
      queuePlaybackBuffer(Buffer.from(chunk), nowMs, {
        holdMs: resolveThinkingPulseHoldMs(),
        kind: "thinking_pulse",
        bypassPrime: true,
      });
      if (nextOffset >= thinkingPulseBuffer.length) {
        thinkingPulsePlaybackActive = false;
        return;
      }
      const stepDelayMs = Math.max(
        4,
        Math.min(
          40,
          Math.round(
            pcm16ByteDurationMs(
              chunk.length,
              VOICE_PLAYBACK_SAMPLE_RATE,
              VOICE_PLAYBACK_CHANNELS
            )
          )
        )
      );
      clearThinkingPulseStepTimer();
      thinkingPulseStepTimer = setTimeout(() => {
        thinkingPulseStepTimer = null;
        queueThinkingPulseStep(runId, nextOffset, Date.now());
      }, stepDelayMs);
    };

    const queueThinkingPulse = (nowMs = Date.now()) => {
      if (!thinkingPulseBuffer || !speaker) return;
      if (!assistantResponseActive || assistantResponseHadAudio) return;
      if (thinkingPulsePlaybackActive) return;
      thinkingPulsePlaybackActive = true;
      const runId = ++thinkingPulsePlaybackRunId;
      queueThinkingPulseStep(runId, 0, nowMs);
    };

    const startThinkingPulse = (opts = {}) => {
      const delayMs = clamp(
        toFiniteNumber(opts?.delayMs, thinkingPulseStartDelayMs),
        0,
        10_000
      );
      const reason =
        typeof opts?.reason === "string" && opts.reason.trim()
          ? opts.reason.trim()
          : "response_started";
      if (!thinkingPulseBuffer || !speaker) return;
      stopThinkingPulse("restart");
      if (!assistantResponseActive || assistantResponseHadAudio) return;
      thinkingPulseTimer = setTimeout(() => {
        thinkingPulseTimer = null;
        if (
          !sessionState.running ||
          !assistantResponseActive ||
          assistantResponseHadAudio ||
          !speaker
        ) {
          return;
        }
        queueThinkingPulse(Date.now());
        thinkingPulseInterval = setInterval(() => {
          if (
            !sessionState.running ||
            !assistantResponseActive ||
            assistantResponseHadAudio ||
            !speaker
          ) {
            stopThinkingPulse("inactive");
            return;
          }
          queueThinkingPulse(Date.now());
        }, thinkingPulseIntervalMs);
        emitMetric("voice_thinking_pulse_started", {
          source,
          reason,
          start_delay_ms: delayMs,
          interval_ms: thinkingPulseIntervalMs,
          hold_ms: resolveThinkingPulseHoldMs(),
        });
      }, delayMs);
    };

    const maybeStartThinkingPulseFromSpeech = (nowMs = Date.now()) => {
      if (!sessionState.running || !userSpokeInSession) return;
      if (assistantResponseHadAudio) return;
      if (thinkingPulseTimer || thinkingPulseInterval) return;
      const lastSpeechAt = Math.max(
        0,
        Number.isFinite(lastUserInteractionAt) ? lastUserInteractionAt : 0,
        Number.isFinite(lastMeaningfulSpeechAtMs) ? lastMeaningfulSpeechAtMs : 0
      );
      if (lastSpeechAt <= 0) return;
      if (nowMs - lastSpeechAt < thinkingPulseStartDelayMs) return;
      assistantResponseActive = true;
      // Keep long tool waits from tripping idle timeout before any audio arrives.
      lastAssistantActivityAt = nowMs;
      if (!thinkingPulseBuffer || !speaker) return;
      startThinkingPulse({ delayMs: 0, reason: "post_speech_wait" });
    };

    const clearSpokenProgressTimer = () => {
      if (spokenProgressTimer) {
        clearTimeout(spokenProgressTimer);
        spokenProgressTimer = null;
      }
    };

    const clearSpokenProgressPoll = () => {
      if (spokenProgressPoll) {
        clearInterval(spokenProgressPoll);
        spokenProgressPoll = null;
      }
    };

    const clearCallEndedGraceTimer = () => {
      if (callEndedGraceTimer) {
        clearTimeout(callEndedGraceTimer);
        callEndedGraceTimer = null;
      }
    };

    const clearCallEndedGracePoll = () => {
      if (callEndedGracePoll) {
        clearInterval(callEndedGracePoll);
        callEndedGracePoll = null;
      }
    };

    const finishCallEndedMaterialQueryGrace = (reason = "call_ended") => {
      callEndedAwaitingMaterialQueryTerminal = false;
      stopAfterSyntheticSpokenResponse = false;
      clearCallEndedGraceTimer();
      clearCallEndedGracePoll();
      endReason = reason;
      void stopSession({ drainPlayback: true });
    };

    const stopSpokenProgressTracking = (reason = "inactive") => {
      progressTrackingRunId += 1;
      clearSpokenProgressTimer();
      clearSpokenProgressPoll();
      clearCallEndedGraceTimer();
      clearCallEndedGracePoll();
      lastMaterialProgressUpdatedAt = "";
      lastMaterialProgressTerminalAt = "";
      pendingDeferredTerminalSpeechText = "";
      lastSpokenProgressText = "";
      lastSpokenProgressAtMs = 0;
      syntheticSpokenResponsePendingUntilMs = 0;
      callEndedAwaitingMaterialQueryTerminal = false;
      stopAfterSyntheticSpokenResponse = false;
      materialQueryTrackingStartedAtMs = 0;
      materialQueryObservedNonIdle = false;
      emitMetric("voice_spoken_progress_stopped", { source, reason });
    };

    const normalizeSpeechText = (value) =>
      trimmed(value)
        .replace(/\[(.*?)\]\((.*?)\)/g, "$1")
        .replace(/[*_`>#]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();

    const limitSpeechText = (value, max = 260) => {
      const normalized = normalizeSpeechText(value);
      if (!normalized) return "";
      if (normalized.length <= max) return normalized;
      const sliced = normalized.slice(0, Math.max(0, max - 3)).trimEnd();
      return `${sliced}...`;
    };

    const buildSpokenFinalAnswerText = (value) => {
      const raw = trimmed(value);
      if (!raw) return "";
      const lines = raw
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      const narrativeLines = lines.filter(
        (line) => !line.startsWith("|") && !/^[-:| ]+$/.test(line)
      );
      const narrativeText = limitSpeechText(narrativeLines.join(" "), 240);
      if (narrativeText) return narrativeText;
      const tableRows = lines.filter((line) => line.startsWith("|"));
      const names = [];
      for (const line of tableRows.slice(2)) {
        const cells = line
          .split("|")
          .map((cell) => normalizeSpeechText(cell))
          .filter(Boolean);
        if (cells.length === 0) continue;
        const name =
          cells.length >= 2 && /^\d+$/.test(cells[0]) ? cells[1] : cells[0];
        if (name) names.push(name);
        if (names.length >= 4) break;
      }
      if (names.length > 0) {
        return limitSpeechText(`I found these items: ${names.join(", ")}.`, 220);
      }
      return limitSpeechText(raw, 220);
    };

    const requestAiyraSpokenProgress = (text, kind = "status") => {
      const spokenText = trimmed(text).replace(/\s+/g, " ").trim();
      const isTerminalSpeech =
        kind === "material_query_final" ||
        kind === "material_query_failed";
      const allowSyntheticSpeech =
        spokenProgressAvailable ||
        isTerminalSpeech;
      if (
        !allowSyntheticSpeech ||
        !spokenText ||
        !sessionState.running ||
        !ws ||
        !(
          ws.readyState === ws.OPEN ||
          ws.readyState === 1
        )
      ) {
        return false;
      }
      const nowMs = Date.now();
      if (!isTerminalSpeech) {
        if (
          spokenText === lastSpokenProgressText &&
          nowMs - lastSpokenProgressAtMs < spokenProgressMinIntervalMs
        ) {
          return false;
        }
        if (
          lastSpokenProgressAtMs > 0 &&
          nowMs - lastSpokenProgressAtMs < spokenProgressMinIntervalMs
        ) {
          return false;
        }
      }
      clearSpokenProgressTimer();
      const previousSpokenProgressText = lastSpokenProgressText;
      const previousSpokenProgressAtMs = lastSpokenProgressAtMs;
      const previousAssistantActivityAt = lastAssistantActivityAt;
      const previousAssistantResponseActive = assistantResponseActive;
      const previousSyntheticPendingUntilMs = syntheticSpokenResponsePendingUntilMs;
      lastSpokenProgressText = spokenText;
      lastSpokenProgressAtMs = nowMs;
      lastAssistantActivityAt = nowMs;
      assistantResponseActive = true;
      syntheticSpokenResponsePendingUntilMs = nowMs + 5000;
      try {
        ws.send(
          JSON.stringify({
            type: "response.create",
            response: {
              conversation: "none",
              modalities: ["audio", "text"],
              instructions: `Speak exactly this short update to the user and nothing else: ${spokenText}`,
              max_output_tokens: 120,
            },
          })
        );
        emitMetric("voice_spoken_progress_started", {
          source,
          kind,
          text_preview: spokenText.slice(0, 96),
          transport: "aiyra_ws",
        });
      } catch (error) {
        onWarn(
          "aiyra voice spoken progress request failed",
          error instanceof Error ? error.message : String(error)
        );
        lastSpokenProgressText = previousSpokenProgressText;
        lastSpokenProgressAtMs = previousSpokenProgressAtMs;
        lastAssistantActivityAt = previousAssistantActivityAt;
        assistantResponseActive = previousAssistantResponseActive;
        syntheticSpokenResponsePendingUntilMs = previousSyntheticPendingUntilMs;
        emitMetric("voice_spoken_progress_failed", {
          source,
          kind,
          error: error instanceof Error ? error.message : String(error),
        });
        return false;
      }
      return true;
    };

    const fetchMaterialQueryProgress = async (runId) => {
      if (
        (!spokenProgressAvailable && !callEndedAwaitingMaterialQueryTerminal) ||
        runId !== progressTrackingRunId ||
        !sessionState.running ||
        !sessionConversationId
      ) {
        return;
      }
      const baseUrl = appUrl.replace(/\/+$/, "");
      const endpoint = materialQueryProgressPath.startsWith("/")
        ? materialQueryProgressPath
        : `/${materialQueryProgressPath}`;
      const url = `${baseUrl}${endpoint}?conversationId=${encodeURIComponent(
        sessionConversationId
      )}`;
      const previewMaterialProgressText = (value, max = 180) => {
        const text = trimmed(value).replace(/\s+/g, " ");
        if (!text) return null;
        return text.length > max ? `${text.slice(0, max - 3).trimEnd()}...` : text;
      };
      try {
        const res = await fetch(url, {
          headers: {
            "x-device-token": deviceToken,
          },
        });
        if (!res.ok) {
          const bodyText = trimmed(await res.text().catch(() => ""));
          const failureKey = `http:${res.status}:${bodyText.slice(0, 180)}`;
          if (failureKey !== lastMaterialProgressLogKey) {
            lastMaterialProgressLogKey = failureKey;
            onWarn("aiyra material-query progress fetch failed", {
              conversation_id: sessionConversationId,
              run_id: runId,
              http_status: res.status,
              awaiting_material_query_terminal: callEndedAwaitingMaterialQueryTerminal,
              observed_non_idle: materialQueryObservedNonIdle,
              body_preview: previewMaterialProgressText(bodyText),
            });
          }
          return;
        }
        const json = await res.json().catch(() => ({}));
        const status = trimmed(json?.status).toLowerCase();
        const progressText =
          trimmed(json?.progressText) || trimmed(json?.progress_text);
        const answerText =
          trimmed(json?.answerText) || trimmed(json?.answer_text);
        const errorText =
          trimmed(json?.errorText) || trimmed(json?.error_text);
        const updatedAt =
          trimmed(json?.updatedAt) || trimmed(json?.updated_at);
        const progressPreview = previewMaterialProgressText(progressText);
        const answerPreview = previewMaterialProgressText(answerText);
        const errorPreview = previewMaterialProgressText(errorText);
        const progressLogKey = [
          status || "unknown",
          updatedAt || "",
          progressPreview || "",
          answerPreview || "",
          errorPreview || "",
          callEndedAwaitingMaterialQueryTerminal ? "terminal" : "live",
          materialQueryObservedNonIdle ? "seen_non_idle" : "never_non_idle",
        ].join("|");
        if (progressLogKey !== lastMaterialProgressLogKey) {
          lastMaterialProgressLogKey = progressLogKey;
          onLog("aiyra material-query progress response", {
            conversation_id: sessionConversationId,
            run_id: runId,
            status: status || "unknown",
            updated_at: updatedAt || null,
            awaiting_material_query_terminal: callEndedAwaitingMaterialQueryTerminal,
            observed_non_idle: materialQueryObservedNonIdle,
            progress_preview: progressPreview,
            answer_preview: answerPreview,
            error_preview: errorPreview,
          });
        }
        if (status === "idle") {
          if (!materialQueryObservedNonIdle) {
            onLog("aiyra material-query progress is idle with no active claim", {
              conversation_id: sessionConversationId,
              run_id: runId,
              awaiting_material_query_terminal: callEndedAwaitingMaterialQueryTerminal,
              tracking_started_at:
                materialQueryTrackingStartedAtMs > 0
                  ? new Date(materialQueryTrackingStartedAtMs).toISOString()
                  : null,
            });
          }
          if (callEndedAwaitingMaterialQueryTerminal) {
            finishCallEndedMaterialQueryGrace("call_ended_material_query_idle");
            return;
          }
          if (
            !materialQueryObservedNonIdle &&
            materialQueryTrackingStartedAtMs > 0 &&
            Date.now() - materialQueryTrackingStartedAtMs < materialQueryIdleGraceMs
          ) {
            return;
          }
          stopSpokenProgressTracking("material_query_idle");
          return;
        }
        materialQueryObservedNonIdle = true;
        if (status === "completed") {
          const terminalAt = updatedAt || "completed";
          if (terminalAt === lastMaterialProgressTerminalAt) {
            if (callEndedAwaitingMaterialQueryTerminal || stopAfterSyntheticSpokenResponse) {
              return;
            }
            stopSpokenProgressTracking("material_query_completed_duplicate");
            return;
          }
          lastMaterialProgressTerminalAt = terminalAt;
          progressTrackingRunId += 1;
          clearSpokenProgressTimer();
          clearSpokenProgressPoll();
          clearCallEndedGracePoll();
          const finalSpeech = buildSpokenFinalAnswerText(answerText);
          pendingDeferredTerminalSpeechText = finalSpeech;
          if (finalSpeech) {
            const spoke = requestAiyraSpokenProgress(finalSpeech, "material_query_final");
            if (callEndedAwaitingMaterialQueryTerminal) {
              if (spoke) {
                stopAfterSyntheticSpokenResponse = true;
                const finalResponseWaitMs = resolveCallEndedFinalResponseWaitMs();
                clearCallEndedGraceTimer();
                callEndedGraceTimer = setTimeout(() => {
                  finishCallEndedMaterialQueryGrace("call_ended_final_response_timeout");
                }, finalResponseWaitMs);
              } else {
                finishCallEndedMaterialQueryGrace("call_ended_material_query_final_unsent");
              }
            }
          } else {
            if (callEndedAwaitingMaterialQueryTerminal) {
              finishCallEndedMaterialQueryGrace("call_ended_material_query_completed_empty");
              return;
            }
            stopSpokenProgressTracking("material_query_completed_empty");
          }
          return;
        }
        if (status === "failed") {
          const terminalAt = updatedAt || "failed";
          if (terminalAt === lastMaterialProgressTerminalAt) {
            stopSpokenProgressTracking("material_query_failed_duplicate");
            return;
          }
          lastMaterialProgressTerminalAt = terminalAt;
          progressTrackingRunId += 1;
          clearSpokenProgressTimer();
          clearSpokenProgressPoll();
          clearCallEndedGracePoll();
          const failedSpeech = errorText
            ? `I hit a problem finishing that: ${errorText}`
            : "I hit a problem finishing that request.";
          pendingDeferredTerminalSpeechText = failedSpeech;
          const spoke = requestAiyraSpokenProgress(failedSpeech, "material_query_failed");
          if (callEndedAwaitingMaterialQueryTerminal) {
            if (spoke) {
              stopAfterSyntheticSpokenResponse = true;
              clearCallEndedGraceTimer();
              callEndedGraceTimer = setTimeout(() => {
                finishCallEndedMaterialQueryGrace("call_ended_failed_response_timeout");
              }, Math.max(6000, callEndedMaterialQueryGraceMs));
            } else {
              finishCallEndedMaterialQueryGrace("call_ended_material_query_failed_unsent");
            }
          }
          return;
        }
        if (status !== "running" || !progressText) return;
        if (!spokenProgressAvailable) return;
        const updatedAtMs = updatedAt ? Date.parse(updatedAt) : NaN;
        if (
          !lastSpokenProgressText &&
          Number.isFinite(updatedAtMs) &&
          Date.now() - updatedAtMs < 4000
        ) {
          lastMaterialProgressUpdatedAt = updatedAt || new Date().toISOString();
          return;
        }
        if (updatedAt && updatedAt === lastMaterialProgressUpdatedAt) return;
        if (
          progressText === lastSpokenProgressText &&
          updatedAt === lastMaterialProgressUpdatedAt
        ) {
          return;
        }
        lastMaterialProgressUpdatedAt = updatedAt || new Date().toISOString();
        clearSpokenProgressTimer();
        requestAiyraSpokenProgress(progressText, "material_query_progress");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const failureKey = `fetch_error:${message}`;
        if (failureKey !== lastMaterialProgressLogKey) {
          lastMaterialProgressLogKey = failureKey;
          onWarn("aiyra material-query progress fetch threw", {
            conversation_id: sessionConversationId,
            run_id: runId,
            awaiting_material_query_terminal: callEndedAwaitingMaterialQueryTerminal,
            observed_non_idle: materialQueryObservedNonIdle,
            error: message,
          });
        }
      }
    };

    const startSpokenProgressTracking = (reason = "assistant_started") => {
      if (!spokenProgressAvailable) return;
      progressTrackingRunId += 1;
      const runId = progressTrackingRunId;
      clearSpokenProgressTimer();
      clearSpokenProgressPoll();
      clearCallEndedGraceTimer();
      clearCallEndedGracePoll();
      callEndedAwaitingMaterialQueryTerminal = false;
      stopAfterSyntheticSpokenResponse = false;
      materialQueryTrackingStartedAtMs = Date.now();
      materialQueryObservedNonIdle = false;
      lastMaterialProgressLogKey = "";
      lastMaterialProgressUpdatedAt = "";
      lastMaterialProgressTerminalAt = "";
      lastSpokenProgressText = "";
      lastSpokenProgressAtMs = 0;
      syntheticSpokenResponsePendingUntilMs = 0;
      if (spokenProgressInitialDelayMs >= 0) {
        spokenProgressTimer = setTimeout(() => {
          if (
            runId !== progressTrackingRunId ||
            !sessionState.running
          ) {
            return;
          }
          requestAiyraSpokenProgress("I'm working on that now.", reason);
        }, spokenProgressInitialDelayMs);
      }
      spokenProgressPoll = setInterval(() => {
        void fetchMaterialQueryProgress(runId);
      }, spokenProgressPollMs);
    };

    const startCallEndedMaterialQueryGrace = () => {
      if (
        !sessionConversationId ||
        !sessionState.running ||
        callEndedAwaitingMaterialQueryTerminal
      ) {
        return false;
      }
      callEndedAwaitingMaterialQueryTerminal = true;
      stopAfterSyntheticSpokenResponse = false;
      progressTrackingRunId += 1;
      lastMaterialProgressLogKey = "";
      const runId = progressTrackingRunId;
      const waitMs = resolveCallEndedMaterialQueryWaitMs();
      sessionMicMuted = true;
      assistantResponseActive = false;
      assistantResponseHadAudio = false;
      lastAssistantActivityAt = Date.now();
      clearCallEndedGraceTimer();
      clearCallEndedGracePoll();
      callEndedGraceTimer = setTimeout(() => {
        finishCallEndedMaterialQueryGrace("call_ended_material_query_grace_timeout");
      }, waitMs);
      callEndedGracePoll = setInterval(() => {
        void fetchMaterialQueryProgress(runId);
      }, callEndedMaterialQueryPollMs);
      onLog("aiyra voice delaying session close for material-query final", {
        source,
        conversation_id: sessionConversationId || null,
        grace_ms: waitMs,
        poll_ms: callEndedMaterialQueryPollMs,
        material_query_enabled: sessionMaterialQueryEnabled,
        material_query_timeout_ms: sessionMaterialQueryTimeoutMs || null,
      });
      emitMetric("voice_call_ended_material_query_wait_started", {
        source,
        grace_ms: waitMs,
        poll_ms: callEndedMaterialQueryPollMs,
        material_query_enabled: sessionMaterialQueryEnabled,
        material_query_timeout_ms: sessionMaterialQueryTimeoutMs || undefined,
      });
      void fetchMaterialQueryProgress(runId);
      return true;
    };

    const schedulePlaybackPump = () => {
      if (playbackPumpScheduled || playbackWaitingForDrain) return;
      playbackPumpScheduled = true;
      setImmediate(() => {
        playbackPumpScheduled = false;
        if (!sessionState.running || !speaker) return;
        while (speaker && playbackPendingBuffers.length > 0) {
          const entry = playbackPendingBuffers.shift();
          const chunk = Buffer.isBuffer(entry?.chunk) ? entry.chunk : null;
          const holdMs = Math.max(
            0,
            toFiniteNumber(entry?.holdMs, assistantPlaybackHoldMs)
          );
          if (!chunk) continue;
          playbackPendingBytes = Math.max(0, playbackPendingBytes - chunk.length);
          try {
            if (aecProcessor) {
              aecProcessor.pushPlaybackPcm(chunk, VOICE_PLAYBACK_SAMPLE_RATE);
            }
            const chunkDurationMs = pcm16ByteDurationMs(
              chunk.length,
              VOICE_PLAYBACK_SAMPLE_RATE,
              VOICE_PLAYBACK_CHANNELS
            );
            const writeNowMs = Date.now();
            playbackScheduledUntilMs =
              Math.max(playbackScheduledUntilMs, writeNowMs) + chunkDurationMs;
            refreshAssistantPlaybackWindow(writeNowMs, holdMs);
            const accepted = speaker.write(chunk);
            if (!accepted) {
              if (
                writeNowMs - lastPlaybackBackpressureLogAtMs >=
                activityMetricThrottleMs
              ) {
                lastPlaybackBackpressureLogAtMs = writeNowMs;
                logAssistantResponseSnapshot("aiyra voice playback backpressure", {
                  playback_pending_bytes: playbackPendingBytes,
                  playback_waiting_for_drain: true,
                  playback_scheduled_until_ms: playbackScheduledUntilMs,
                  assistant_response_active: assistantResponseActive,
                });
              }
              playbackWaitingForDrain = true;
              speaker.once("drain", () => {
                playbackWaitingForDrain = false;
                maybeResetPlaybackPrimeState();
                schedulePlaybackPump();
              });
              return;
            }
          } catch (e) {
            onWarn(
              "aiyra voice: speaker write failed",
              e instanceof Error ? e.message : String(e)
            );
            if (aecProcessor) {
              disableAec(e);
            }
            break;
          }
        }
        maybeResetPlaybackPrimeState();
      });
    };

    const queuePlaybackBuffer = (chunk, nowMs, opts = {}) => {
      if (!speaker || !Buffer.isBuffer(chunk) || chunk.length === 0) return;
      const holdMs = Math.max(
        0,
        toFiniteNumber(opts?.holdMs, assistantPlaybackHoldMs)
      );
      const bypassPrime = opts?.bypassPrime === true;
      const kind =
        typeof opts?.kind === "string" && opts.kind.trim()
          ? opts.kind.trim()
          : "assistant";
      playbackPendingBuffers.push({ chunk, holdMs, kind });
      playbackPendingBytes += chunk.length;
      if (!bypassPrime && !playbackPrimed) {
        if (!playbackPrimeStartedAtMs) {
          playbackPrimeStartedAtMs = nowMs;
        }
        const pendingMs = playbackPendingBytes / Math.max(1, playbackBytesPerMs);
        if (
          pendingMs >= playbackPrimeBufferMs ||
          nowMs - playbackPrimeStartedAtMs >= playbackPrimeMaxWaitMs
        ) {
          playbackPrimed = true;
          clearPlaybackPrimeTimer();
          emitMetric("voice_playback_buffer_primed", {
            source,
            buffered_ms: pendingMs,
          });
        } else if (!playbackPrimeTimer) {
          playbackPrimeTimer = setTimeout(() => {
            playbackPrimeTimer = null;
            if (!sessionState.running || !speaker || playbackPendingBytes <= 0) return;
            playbackPrimed = true;
            emitMetric("voice_playback_buffer_primed", {
              source,
              buffered_ms: playbackPendingBytes / Math.max(1, playbackBytesPerMs),
            });
            schedulePlaybackPump();
          }, Math.max(1, playbackPrimeMaxWaitMs - (nowMs - playbackPrimeStartedAtMs)));
        }
      }
      refreshAssistantPlaybackWindow(nowMs, holdMs);
      if (playbackPrimed || bypassPrime) {
        schedulePlaybackPump();
      }
    };

    const stopSession = async (options = {}) => {
      const drainPlayback = options && options.drainPlayback === true;
      if (sessionStopPromise) return await sessionStopPromise;
      if (!sessionState.running) return;
      sessionStopPromise = (async () => {
        logAssistantResponseSnapshot("aiyra assistant session playback summary", {
          end_reason: endReason || null,
          total_audio_chunks_received: assistantAudioChunkCount,
          total_audio_bytes_received: assistantAudioBytes,
          total_audio_duration_ms_at_24khz: Math.round(
            (assistantAudioBytes / (VOICE_PLAYBACK_SAMPLE_RATE * VOICE_PLAYBACK_CHANNELS * VOICE_PLAYBACK_BYTES_PER_SAMPLE)) * 1000
          ),
          pending_assistant_bytes_at_stop: playbackPendingBytes,
          drain_requested: drainPlayback,
        });
        audioLoopRunning = false;
        if (idleTimer) {
          clearInterval(idleTimer);
          idleTimer = null;
        }
        clearCallEndedGraceTimer();
        clearCallEndedGracePoll();
        stopThinkingPulse("session_stopped");
        stopSpokenProgressTracking("session_stopped");
        try {
          if (micRecorder) micRecorder.stop();
        } catch {
          // ignore
        }
        try {
          if (micRecorder) micRecorder.release();
        } catch {
          // ignore
        }
        try {
          if (rnnoiseProcessor && typeof rnnoiseProcessor.destroy === "function") {
            rnnoiseProcessor.destroy();
          }
        } catch {
          // ignore
        }
        rnnoiseProcessor = null;
        try {
          if (aecProcessor && typeof aecProcessor.destroy === "function") {
            aecProcessor.destroy();
          }
        } catch {
          // ignore
        }
        aecProcessor = null;
        clearPlaybackPrimeTimer();
        try {
          if (ws && ws.readyState === ws.OPEN) {
            if (endReason === "completed") endReason = "session_stopped";
            ws.close();
          }
        } catch {
          // ignore
        }

        if (drainPlayback && speaker) {
          playbackDrainInProgress = true;
          const drainStartedAtMs = Date.now();
          emitMetric("voice_playback_drain_started", {
            source,
            estimated_remaining_ms: Math.round(
              estimateSessionPlaybackRemainingMs(drainStartedAtMs)
            ),
          });
          while (!stopRequested) {
            schedulePlaybackPump();
            const remainingMs = estimateSessionPlaybackRemainingMs();
            if (
              remainingMs <= 120 &&
              playbackPendingBytes <= 0 &&
              !playbackWaitingForDrain
            ) {
              break;
            }
            const waitedMs = Date.now() - drainStartedAtMs;
            if (waitedMs >= 30_000) {
              emitMetric("voice_playback_drain_timeout", {
                source,
                waited_ms: waitedMs,
                remaining_ms: Math.round(remainingMs),
              });
              break;
            }
            await wait(Math.max(80, Math.min(1200, remainingMs + 120)));
          }
          emitMetric("voice_playback_drain_finished", {
            source,
            waited_ms: Math.max(0, Date.now() - drainStartedAtMs),
          });
          playbackDrainInProgress = false;
        }

        sessionState.running = false;
        playbackPendingBuffers = [];
        playbackPendingBytes = 0;
        playbackPumpScheduled = false;
        playbackWaitingForDrain = false;
        playbackPrimeStartedAtMs = 0;
        playbackPrimed = playbackPrimeBufferMs <= 0;
        playbackScheduledUntilMs = 0;
        try {
          if (speaker && typeof speaker.end === "function") speaker.end();
        } catch {
          // ignore
        }
        speaker = null;
      })();
      try {
        await sessionStopPromise;
      } finally {
        sessionStopPromise = null;
      }
    };
    sessionState.stop = stopSession;

    try {
      await safeStopWakeRecorder();

      const earlyMicBufferedFrames = [];
      let earlyMicRecorder = null;
      let earlyMicRunning = false;
      const earlyMicFrameLength = 512;
      const earlyMicMaxBufferMs = 12000;
      const earlyMicMaxFrames = Math.ceil(
        (earlyMicMaxBufferMs * 16000) / (earlyMicFrameLength * 1000)
      );
      try {
        const earlyDeviceIndex = await getCurrentDeviceIndex();
        earlyMicRecorder = new PvRecorder(earlyMicFrameLength, earlyDeviceIndex);
        earlyMicRecorder.start();
        earlyMicRunning = true;
        onLog("aiyra voice early mic started", {
          frame_length: earlyMicFrameLength,
          device_index: earlyDeviceIndex,
          max_buffer_ms: earlyMicMaxBufferMs,
        });
        const pumpEarlyMic = async () => {
          while (earlyMicRunning && earlyMicRecorder) {
            try {
              const frame = await earlyMicRecorder.read();
              if (frame && frame.length > 0 && earlyMicRunning) {
                earlyMicBufferedFrames.push(new Int16Array(frame));
                if (earlyMicBufferedFrames.length > earlyMicMaxFrames) {
                  earlyMicBufferedFrames.shift();
                }
              }
            } catch {
              break;
            }
          }
        };
        pumpEarlyMic();
      } catch (earlyMicErr) {
        onWarn("aiyra voice early mic failed, continuing without buffered audio",
          earlyMicErr instanceof Error ? earlyMicErr.message : String(earlyMicErr));
      }

      const {
        wsUrl,
        conversationId,
        orchestratorSessionId,
        bindingMode,
        idleTimeoutMs: bootstrappedIdleTimeoutMs,
        materialQueryEnabled: bootstrappedMaterialQueryEnabled,
        materialQueryTimeoutMs: bootstrappedMaterialQueryTimeoutMs,
        ttsSpeed: bootstrappedTtsSpeed,
      } =
        await bootstrapSession({ forceNewConversation });
      sessionConversationId = conversationId;
      sessionOrchestratorSessionId = orchestratorSessionId || "";
      sessionBindingMode = bindingMode || "";
      const resolvedBootstrappedIdleTimeoutMs = clamp(
        toFiniteNumber(bootstrappedIdleTimeoutMs, idleTimeoutMs),
        2000,
        120000
      );
      const shouldPreferLocalIdleTimeout =
        source === "wake_word" && resolvedBootstrappedIdleTimeoutMs > idleTimeoutMs;
      sessionIdleTimeoutMs = shouldPreferLocalIdleTimeout
        ? idleTimeoutMs
        : resolvedBootstrappedIdleTimeoutMs;
      if (shouldPreferLocalIdleTimeout) {
        onLog("aiyra bootstrap idle timeout override ignored for local mic session", {
          source,
          local_idle_timeout_ms: idleTimeoutMs,
          bootstrapped_idle_timeout_ms: resolvedBootstrappedIdleTimeoutMs,
        });
      }
      sessionMaterialQueryEnabled = bootstrappedMaterialQueryEnabled === true;
      sessionMaterialQueryTimeoutMs = clamp(
        toFiniteNumber(bootstrappedMaterialQueryTimeoutMs, 0),
        0,
        300000
      );
      lastResolvedTtsSpeed = clamp(toFiniteNumber(bootstrappedTtsSpeed, lastResolvedTtsSpeed), 0.5, 2);
      assistantResponseFreshMs = Math.max(assistantResponseFreshMs, sessionIdleTimeoutMs);
      if (conversationId && !forceNewConversation) {
        preferredConversationId = conversationId;
      }
      onLog("aiyra preferred conversation updated", {
        preferred_conversation_id: preferredConversationId || null,
        conversation_id: sessionConversationId || null,
        orchestrator_session_id: sessionOrchestratorSessionId || null,
        binding_mode: sessionBindingMode || null,
        idle_timeout_ms: sessionIdleTimeoutMs,
        material_query_enabled: sessionMaterialQueryEnabled,
        material_query_timeout_ms: sessionMaterialQueryTimeoutMs || null,
        tts_speed: lastResolvedTtsSpeed,
      });
      ws = await openWebSocketWithTimeout(wsUrl, 12_000);
      emitMetric("voice_session_connected", {
        source,
        idle_timeout_ms: sessionIdleTimeoutMs,
        material_query_enabled: sessionMaterialQueryEnabled,
        material_query_timeout_ms: sessionMaterialQueryTimeoutMs || undefined,
        tts_speed: lastResolvedTtsSpeed,
      });
      lastUserInteractionAt = Date.now();
      wakeWordAudioDiscardUntilMs =
        source === "wake_word" ? Date.now() + wakeWordPostConnectDiscardMs : 0;
      if (wakeWordAudioDiscardUntilMs > 0) {
        emitMetric("voice_wake_phrase_discard_started", {
          source,
          discard_ms: wakeWordPostConnectDiscardMs,
        });
      }

      if (rnnoiseEnabled) {
        try {
          rnnoiseProcessor = await createRnnoiseProcessor();
          voiceMicFrameLength = Math.max(
            rnnoiseProcessor.inputFrameSize,
            rnnoiseProcessor.inputFrameSize * 2
          );
          onLog("aiyra voice rnnoise ready", {
            implementation: rnnoiseProcessor.implementation || "native",
            input_frame_size: rnnoiseProcessor.inputFrameSize,
            capture_frame_length: voiceMicFrameLength,
          });
          emitMetric("voice_denoise_ready", {
            source,
            engine: "rnnoise",
            implementation: rnnoiseProcessor.implementation || "native",
            input_frame_size: rnnoiseProcessor.inputFrameSize,
            capture_frame_length: voiceMicFrameLength,
          });
        } catch (rnnoiseErr) {
          onWarn(
            "aiyra voice rnnoise unavailable, continuing without denoise",
            rnnoiseErr instanceof Error ? rnnoiseErr.message : String(rnnoiseErr)
          );
          emitMetric("voice_denoise_unavailable", {
            source,
            engine: "rnnoise",
            reason:
              rnnoiseErr instanceof Error ? rnnoiseErr.message : String(rnnoiseErr),
          });
          rnnoiseProcessor = null;
          voiceMicFrameLength = 512;
        }
      }

      if (SpeakerCtor) {
        try {
          const speakerEndianness =
            typeof os.endianness === "function" && os.endianness() === "BE"
              ? "BE"
              : "LE";
          const speakerHighWaterMarkBytes = Math.max(
            64 * 1024,
            Math.round(playbackBytesPerMs * Math.max(600, playbackPrimeBufferMs * 3))
          );
          speaker = new SpeakerCtor({
            channels: VOICE_PLAYBACK_CHANNELS,
            bitDepth: 16,
            sampleRate: VOICE_PLAYBACK_SAMPLE_RATE,
            signed: true,
            float: false,
            endianness: speakerEndianness,
            samplesPerFrame: speakerSamplesPerFrame,
            highWaterMark: speakerHighWaterMarkBytes,
          });
          emitMetric("voice_playback_ready", {
            source,
            sample_rate: VOICE_PLAYBACK_SAMPLE_RATE,
            endianness: speakerEndianness,
            samples_per_frame: speakerSamplesPerFrame,
            high_water_mark_bytes: speakerHighWaterMarkBytes,
          });
        } catch (speakerErr) {
          onWarn(
            "aiyra voice: failed to initialize speaker, continuing without playback",
            speakerErr instanceof Error ? speakerErr.message : String(speakerErr)
          );
          emitMetric("voice_playback_unavailable", {
            source,
            reason:
              speakerErr instanceof Error ? speakerErr.message : String(speakerErr),
          });
          speaker = null;
        }
      } else {
        onWarn("aiyra voice: speaker module missing, playback disabled");
        emitMetric("voice_playback_unavailable", {
          source,
          reason: "speaker_module_missing",
        });
      }

      if (voiceAecEnabled && speaker) {
        try {
          aecProcessor = await createAecProcessor({
            backend: voiceAecBackend,
            sampleRate: 16000,
            playbackSampleRate: VOICE_PLAYBACK_SAMPLE_RATE,
            frameSize: voiceAecFrameSize,
            filterLength: voiceAecFilterLength,
            renderQueueCapacityMs: voiceAecRenderQueueCapacityMs,
          });
          if (!aecProcessor) {
            throw new Error("voice_aec_backend_off");
          }
          voiceMicFrameLength = aecProcessor.frameSize;
          assistantPlaybackHoldMs = assistantPlaybackHoldWithAecMs;
          onLog("aiyra voice aec ready", {
            backend_requested: voiceAecBackend,
            backend: aecProcessor.backend || voiceAecBackend,
            frame_size: aecProcessor.frameSize,
            filter_length: aecProcessor.filterLength,
            sample_rate: aecProcessor.sampleRate,
            playback_hold_ms: assistantPlaybackHoldMs,
          });
          emitMetric("voice_aec_ready", {
            source,
            backend_requested: voiceAecBackend,
            backend: aecProcessor.backend || voiceAecBackend,
            frame_size: aecProcessor.frameSize,
            filter_length: aecProcessor.filterLength,
            sample_rate: aecProcessor.sampleRate,
            playback_hold_ms: assistantPlaybackHoldMs,
          });
        } catch (aecErr) {
          const reason = aecErr instanceof Error ? aecErr.message : String(aecErr);
          onWarn("aiyra voice aec unavailable, continuing without echo cancellation", reason);
          emitMetric("voice_aec_unavailable", {
            source,
            backend_requested: voiceAecBackend,
            reason,
          });
          aecProcessor = null;
          assistantPlaybackHoldMs = assistantPlaybackHoldFallbackMs;
        }
      }

      earlyMicRunning = false;
      try {
        if (earlyMicRecorder) earlyMicRecorder.stop();
      } catch { /* ignore */ }
      await wait(20);
      try {
        if (earlyMicRecorder) earlyMicRecorder.release();
      } catch { /* ignore */ }
      earlyMicRecorder = null;

      const earlyMicFrameCount = earlyMicBufferedFrames.length;
      const earlyMicBufferedMs = Math.round(
        (earlyMicFrameCount * earlyMicFrameLength * 1000) / 16000
      );
      onLog("aiyra voice early mic stopped", {
        buffered_frames: earlyMicFrameCount,
        buffered_ms: earlyMicBufferedMs,
      });

      const currentDeviceIndex = await getCurrentDeviceIndex();
      micRecorder = new PvRecorder(voiceMicFrameLength, currentDeviceIndex);
      try {
        micRecorder.start();
      } catch (micStartError) {
        throw new Error(
          `aiyra_session_mic_start_failed:${
            micStartError instanceof Error
              ? micStartError.message
              : String(micStartError)
          }`
        );
      }

      if (earlyMicFrameCount > 0 && ws && ws.readyState === ws.OPEN) {
        let replayedFrames = 0;
        let replayedBytes = 0;
        for (const frame of earlyMicBufferedFrames) {
          if (!frame || frame.length === 0) continue;
          try {
            const upsampled = upsamplePcm16(frame, 16000, 24000);
            ws.send(JSON.stringify({
              type: "input_audio_buffer.append",
              audio: pcm16ToBase64(upsampled),
            }));
            replayedFrames += 1;
            replayedBytes += frame.byteLength;
          } catch {
            break;
          }
        }
        earlyMicBufferedFrames.length = 0;
        onLog("aiyra voice early mic replayed", {
          replayed_frames: replayedFrames,
          replayed_bytes: replayedBytes,
          replayed_ms: Math.round((replayedFrames * earlyMicFrameLength * 1000) / 16000),
        });
        emitMetric("voice_early_mic_replayed", {
          source,
          replayed_frames: replayedFrames,
          replayed_bytes: replayedBytes,
          replayed_ms: Math.round((replayedFrames * earlyMicFrameLength * 1000) / 16000),
        });
      }

      ws.on("message", (raw) => {
        let msg = null;
        try {
          msg = JSON.parse(String(raw));
        } catch {
          return;
        }
        if (!msg || typeof msg !== "object") return;
        const nowMs = Date.now();
        const msgType = trimmed(msg.type);
        const responseEventId = readAssistantResponseId(msg);

        if (isAudioDeltaEvent(msg)) {
          const delta = parseAudioDelta(msg);
          const deltaBuffer = delta ? Buffer.from(delta, "base64") : null;
          const responseId = responseEventId || activeAssistantResponseId;
          if (
            responseId &&
            activeAssistantResponseId &&
            responseId !== activeAssistantResponseId
          ) {
            logAssistantResponseSnapshot(
              "aiyra assistant audio switched response ids",
              {
                previous_response_id: activeAssistantResponseId,
                response_id: responseId,
                ws_type: msgType || null,
              }
            );
            dropPendingPlaybackKind("assistant");
            resetAssistantResponseTrace(responseId, nowMs);
          } else if (responseId && !activeAssistantResponseId) {
            resetAssistantResponseTrace(responseId, nowMs);
          }
          lastAssistantActivityAt = nowMs;
          const firstAudioDeltaForResponse = !assistantResponseHadAudio;
          assistantResponseHadAudio = true;
          if (firstAudioDeltaForResponse) {
            stopThinkingPulse("assistant_audio");
          }
          if (sessionLowMicGainDetected) {
            sessionLowMicGainDetected = false;
            emitActiveSessionHealth(
              "aiyra_voice_active",
              "Connected to Aiyra voice session."
            );
          }
          if (!sawAudioDelta) {
            sawAudioDelta = true;
            onLog("aiyra voice: received first audio output delta");
            emitMetric("voice_audio_delta_started", { source });
            lastAudioActivityMetricAtMs = nowMs;
          } else if (nowMs - lastAudioActivityMetricAtMs >= activityMetricThrottleMs) {
            emitMetric("voice_audio_delta_activity", { source });
            lastAudioActivityMetricAtMs = nowMs;
          }
          const previousDeltaFingerprint = lastAssistantAudioFingerprint;
          const previousDeltaFingerprintAtMs = lastAssistantAudioFingerprintAtMs;
          const deltaFingerprint = deltaBuffer
            ? buildAudioDeltaFingerprint(deltaBuffer)
            : "";
          const duplicateDelta =
            !!deltaFingerprint &&
            deltaFingerprint === previousDeltaFingerprint &&
            nowMs - previousDeltaFingerprintAtMs <= 2000;
          if (deltaBuffer) {
            assistantAudioChunkCount += 1;
            assistantAudioBytes += deltaBuffer.length;
          }
          if (deltaFingerprint) {
            lastAssistantAudioFingerprint = deltaFingerprint;
            lastAssistantAudioFingerprintAtMs = nowMs;
          }
          if (firstAudioDeltaForResponse || assistantAudioChunkCount === 1) {
            const pcmAnalysis = deltaBuffer ? analyzeAudioDeltaPcm(deltaBuffer) : null;
            logAssistantResponseSnapshot("aiyra assistant audio delta started", {
              response_id: responseId || null,
              chunk_bytes: deltaBuffer?.length || 0,
              chunk_fingerprint: deltaFingerprint || null,
              ws_type: msgType || null,
              response_active: assistantResponseActive,
              pcm_analysis: pcmAnalysis,
            });
            if (pcmAnalysis) {
              onLog("aiyra assistant audio pcm diagnostic", pcmAnalysis);
            }
          } else if (duplicateDelta) {
            logAssistantResponseSnapshot("aiyra assistant audio delta duplicate", {
              response_id: responseId || null,
              chunk_index: assistantAudioChunkCount,
              chunk_bytes: deltaBuffer?.length || 0,
              chunk_fingerprint: deltaFingerprint,
              duplicate_gap_ms: Math.max(
                0,
                nowMs - previousDeltaFingerprintAtMs
              ),
              ws_type: msgType || null,
            });
          } else if (assistantAudioChunkCount % 40 === 0) {
            const pcmSnap = (assistantAudioChunkCount % 80 === 0 && deltaBuffer)
              ? analyzeAudioDeltaPcm(deltaBuffer)
              : null;
            logAssistantResponseSnapshot("aiyra assistant audio delta progress", {
              response_id: responseId || null,
              chunk_index: assistantAudioChunkCount,
              chunk_bytes: deltaBuffer?.length || 0,
              chunk_fingerprint: deltaFingerprint || null,
              ws_type: msgType || null,
              ...(pcmSnap ? { pcm_analysis: pcmSnap } : {}),
            });
          }
          const explicitServerAudioRate = parseAudioDeltaSampleRate(msg);
          if (
            Number.isFinite(explicitServerAudioRate) &&
            explicitServerAudioRate >= 8000 &&
            explicitServerAudioRate <= 192000 &&
            explicitServerAudioRate !== detectedServerAudioRate
          ) {
            detectedServerAudioRate = explicitServerAudioRate;
            if (explicitServerAudioRate !== VOICE_PLAYBACK_SAMPLE_RATE) {
              onLog("aiyra voice detected server audio rate mismatch", {
                detected_rate: explicitServerAudioRate,
                playback_rate: VOICE_PLAYBACK_SAMPLE_RATE,
                detection: "explicit_message_field",
              });
              emitMetric("voice_server_audio_rate_mismatch", {
                source,
                detected_rate: explicitServerAudioRate,
                playback_rate: VOICE_PLAYBACK_SAMPLE_RATE,
                detection: "explicit_message_field",
              });
            } else {
              onLog("aiyra voice server audio rate matches expected", {
                playback_rate: VOICE_PLAYBACK_SAMPLE_RATE,
                detection: "explicit_message_field",
              });
            }
          }

          let playbackChunk = deltaBuffer;
          if (playbackChunk && detectedServerAudioRate !== VOICE_PLAYBACK_SAMPLE_RATE) {
            playbackChunk = downsamplePlaybackBuffer(
              playbackChunk,
              detectedServerAudioRate,
              VOICE_PLAYBACK_SAMPLE_RATE
            );
          }

          if (playbackChunk && speaker) {
            queuePlaybackBuffer(playbackChunk, nowMs, { kind: "assistant" });
          } else if (!playbackChunk && deltaBuffer && speaker) {
            queuePlaybackBuffer(deltaBuffer, nowMs, { kind: "assistant" });
          } else {
            assistantPlaybackActiveUntilMs = Math.max(
              assistantPlaybackActiveUntilMs,
              nowMs + assistantPlaybackHoldMs
            );
          }
          return;
        }
        if (msgType === "twilio.supervisor.update") {
          const supervisorState = normalizeTwilioSupervisorState(msg);
          const supervisorSummary =
            trimmed(supervisorState?.summary) ||
            trimmed(supervisorState?.rawText) ||
            "Received Twilio supervisor update.";
          onLog("aiyra twilio supervisor update", {
            conversation_id: sessionConversationId || null,
            orchestrator_session_id: sessionOrchestratorSessionId || null,
            child_conversation_id: supervisorState?.childConversationId || null,
            child_kind: supervisorState?.childKind || null,
            status: supervisorState?.status || null,
            stage: supervisorState?.stage || null,
            message_sid: supervisorState?.messageSid || null,
            call_sid: supervisorState?.callSid || null,
            speak_suggested:
              typeof supervisorState?.speakSuggested === "boolean"
                ? supervisorState.speakSuggested
                : null,
          });
          emitMetric("twilio_supervisor_update", {
            source,
            child_kind: supervisorState?.childKind || undefined,
            status: supervisorState?.status || undefined,
            stage: supervisorState?.stage || undefined,
            speak_suggested:
              typeof supervisorState?.speakSuggested === "boolean"
                ? supervisorState.speakSuggested
                : undefined,
          });
          emitHealth("healthy", "twilio_supervisor_update", supervisorSummary, {
            wake_word: effectiveWakeWord,
            listening: false,
            active: true,
            muted: sessionMicMuted,
            wakeword_source: wakewordSource,
            wake_engine: wakeDetectorEngine,
            conversation_id: sessionConversationId || null,
            orchestrator_session_id: sessionOrchestratorSessionId || null,
            twilio_supervisor_state: supervisorState,
          });
          return;
        }
        if (msgType === "audio.low_mic_gain") {
          const maxEnergyObserved = Number(msg.maxEnergyObserved);
          const threshold = Number(msg.threshold);
          const message =
            trimmed(msg.message) ||
            "Microphone gain appears to be too low. Please increase your microphone volume.";
          let nextServerGainBias = sessionServerGainBias;
          if (
            Number.isFinite(maxEnergyObserved) &&
            maxEnergyObserved > 0 &&
            Number.isFinite(threshold) &&
            threshold > 0
          ) {
            nextServerGainBias = clamp(
              (threshold / maxEnergyObserved) * voiceCaptureGainServerBiasMargin,
              1,
              voiceCaptureGainServerBiasMax
            );
          }
          const lowMicDiagnostics = buildVoiceLowMicDiagnosticPayload({
            maxEnergyObserved,
            threshold,
            message,
            nowMs,
            serverGainBiasBefore: sessionServerGainBias,
            serverGainBiasAfter: Math.max(sessionServerGainBias, nextServerGainBias),
          });
          onWarn("aiyra voice low microphone gain", {
            max_energy_observed: Number.isFinite(maxEnergyObserved)
              ? maxEnergyObserved
              : null,
            threshold: Number.isFinite(threshold) ? threshold : null,
            message,
          });
          onLog("aiyra voice low microphone diagnostics", lowMicDiagnostics);
          emitMetric("voice_low_mic_gain", {
            source,
            max_energy_observed: Number.isFinite(maxEnergyObserved)
              ? maxEnergyObserved
              : undefined,
            threshold: Number.isFinite(threshold) ? threshold : undefined,
          });
          emitMetric("voice_low_mic_gain_diagnostics", lowMicDiagnostics);
          if (nextServerGainBias > sessionServerGainBias + 0.01) {
            const previousServerGainBias = sessionServerGainBias;
            sessionServerGainBias = nextServerGainBias;
            adaptiveVoiceCaptureGainServerBias = Math.max(
              adaptiveVoiceCaptureGainServerBias,
              nextServerGainBias
            );
            onLog("aiyra voice capture gain server bias increased", {
              previous_bias: previousServerGainBias,
              next_bias: nextServerGainBias,
              effective_target_rms: Math.round(
                voiceCaptureGainTargetRms * nextServerGainBias
              ),
              max_energy_observed: Number.isFinite(maxEnergyObserved)
                ? maxEnergyObserved
                : null,
              threshold: Number.isFinite(threshold) ? threshold : null,
            });
            emitMetric("voice_capture_gain_server_bias_adjusted", {
              source,
              previous_bias: previousServerGainBias,
              next_bias: nextServerGainBias,
              effective_target_rms: Math.round(
                voiceCaptureGainTargetRms * nextServerGainBias
              ),
              max_energy_observed: Number.isFinite(maxEnergyObserved)
                ? maxEnergyObserved
                : undefined,
              threshold: Number.isFinite(threshold) ? threshold : undefined,
            });
          }
          sessionLowMicGainDetected = true;
          emitHealth("degraded", "aiyra_low_mic_gain", message, {
            wake_word: effectiveWakeWord,
            listening: false,
            active: true,
            muted: sessionMicMuted,
            wakeword_source: wakewordSource,
            wake_engine: wakeDetectorEngine,
            low_mic_gain_detected: true,
            low_mic_gain_at: new Date(nowMs).toISOString(),
            low_mic_gain_message: message,
            low_mic_gain_max_energy_observed: Number.isFinite(maxEnergyObserved)
              ? maxEnergyObserved
              : undefined,
            low_mic_gain_threshold: Number.isFinite(threshold)
              ? threshold
              : undefined,
            conversation_id: sessionConversationId || null,
            orchestrator_session_id: sessionOrchestratorSessionId || null,
          });
        }
        const wsEventType = msgType;
        const ignorePreUtteranceStageRegistered =
          wsEventType === "stage_registered" &&
          source === "wake_word" &&
          !userSpokeInSession &&
          !sawAudioDelta &&
          !assistantResponseHadAudio;
        if (ignorePreUtteranceStageRegistered) {
          onLog("aiyra voice ignoring pre-utterance stage registration", {
            source,
            type: wsEventType,
          });
        } else if (isAssistantResponseStartedEvent(msg)) {
          const previousResponseId = activeAssistantResponseId;
          const responseId = responseEventId || activeAssistantResponseId;
          const responseIdChanged =
            !!responseEventId &&
            !!previousResponseId &&
            responseEventId !== previousResponseId;
          if (responseIdChanged) {
            logAssistantResponseSnapshot(
              "aiyra assistant response boundary switched",
              {
                previous_response_id: previousResponseId,
                response_id: responseEventId,
                ws_type: wsEventType || null,
              }
            );
            dropPendingPlaybackKind("assistant");
          }
          if (
            (!!responseEventId && responseEventId !== previousResponseId) ||
            (!!responseEventId && !previousResponseId)
          ) {
            resetAssistantResponseTrace(responseEventId, nowMs);
          }
          assistantResponseActive = true;
          assistantResponseHadAudio = false;
          lastAssistantActivityAt = nowMs;
          if (wsEventType === "response.created" || responseIdChanged) {
            logAssistantResponseSnapshot("aiyra assistant response started", {
              previous_response_id: previousResponseId || null,
              response_id: responseId || null,
              ws_type: wsEventType || null,
            });
          }
          if (source !== "wake_word") {
            startThinkingPulse();
          }
          if (syntheticSpokenResponsePendingUntilMs > nowMs) {
            syntheticSpokenResponsePendingUntilMs = 0;
          } else {
            startSpokenProgressTracking("assistant_started");
          }
          if (sessionLowMicGainDetected) {
            sessionLowMicGainDetected = false;
            emitActiveSessionHealth(
              "aiyra_voice_active",
              "Connected to Aiyra voice session."
            );
          }
        } else if (isAssistantResponseFinishedEvent(msg)) {
          const responseId = responseEventId || activeAssistantResponseId;
          if (
            responseEventId &&
            activeAssistantResponseId &&
            responseEventId !== activeAssistantResponseId
          ) {
            logAssistantResponseSnapshot(
              "aiyra assistant response finished with mismatched id",
              {
                previous_response_id: activeAssistantResponseId,
                response_id: responseEventId,
                ws_type: wsEventType || null,
              }
            );
          }
          logAssistantResponseSnapshot("aiyra assistant response finished", {
            response_id: responseId || null,
            ws_type: wsEventType || null,
          });
          assistantResponseActive = false;
          assistantResponseHadAudio = false;
          lastAssistantActivityAt = nowMs;
          stopThinkingPulse("response_finished");
          if (sessionLowMicGainDetected) {
            sessionLowMicGainDetected = false;
            emitActiveSessionHealth(
              "aiyra_voice_active",
              "Connected to Aiyra voice session."
            );
          }
          if (stopAfterSyntheticSpokenResponse && callEndedAwaitingMaterialQueryTerminal) {
            finishCallEndedMaterialQueryGrace("call_ended_final_spoken");
            return;
          }
        } else if (isAssistantTranscriptEvent(msg)) {
          const responseId = responseEventId || activeAssistantResponseId;
          const transcriptDelta = parseAssistantTranscriptDelta(msg);
          if (
            responseId &&
            activeAssistantResponseId &&
            responseId !== activeAssistantResponseId
          ) {
            logAssistantResponseSnapshot(
              "aiyra assistant transcript switched response ids",
              {
                previous_response_id: activeAssistantResponseId,
                response_id: responseId,
                ws_type: wsEventType || null,
              }
            );
          } else if (responseId && !activeAssistantResponseId) {
            resetAssistantResponseTrace(responseId, nowMs);
          }
          if (transcriptDelta) {
            assistantTranscriptChunkCount += 1;
            assistantTranscriptChars += transcriptDelta.length;
            assistantTranscriptPreview = appendPreviewText(
              assistantTranscriptPreview,
              transcriptDelta
            );
            if (
              assistantTranscriptChunkCount === 1 ||
              assistantTranscriptChunkCount % 12 === 0
            ) {
              logAssistantResponseSnapshot("aiyra assistant transcript delta", {
                response_id: responseId || null,
                ws_type: wsEventType || null,
              });
            }
          }
          lastAssistantActivityAt = nowMs;
          if (sessionLowMicGainDetected) {
            sessionLowMicGainDetected = false;
            emitActiveSessionHealth(
              "aiyra_voice_active",
              "Connected to Aiyra voice session."
            );
          }
        }
        if (msgType && !seenWsEventTypes.has(msgType)) {
          seenWsEventTypes.add(msgType);
          onLog("aiyra voice ws event", {
            type: msgType,
            response_id: responseEventId || null,
          });
          emitMetric("voice_ws_event", { source, type: msgType });
        }
        if (msgType === "call-ended" || msgType === "session.ended") {
          if (
            startCallEndedMaterialQueryGrace() ||
            stopAfterSyntheticSpokenResponse
          ) {
            return;
          }
          endReason = "call_ended";
          void stopSession({ drainPlayback: true });
        }
      });

      ws.on("close", (code, reasonBuffer) => {
        const closeReason = Buffer.isBuffer(reasonBuffer)
          ? reasonBuffer.toString("utf8")
          : trimmed(reasonBuffer);
        onLog("aiyra voice websocket closed", {
          source,
          code,
          reason: closeReason || null,
          ready_state: typeof ws?.readyState === "number" ? ws.readyState : null,
          awaiting_material_query_terminal: callEndedAwaitingMaterialQueryTerminal,
          assistant_response_active: assistantResponseActive,
          playback_remaining_ms: Math.round(estimateSessionPlaybackRemainingMs()),
        });
        emitMetric("voice_session_ws_closed", {
          source,
          code,
          reason: closeReason || undefined,
          awaiting_material_query_terminal: callEndedAwaitingMaterialQueryTerminal,
          playback_remaining_ms: Math.round(estimateSessionPlaybackRemainingMs()),
        });
        if (sessionState.running && endReason === "completed") {
          endReason = "ws_closed";
        }
        void stopSession();
      });
      ws.on("error", (err) => {
        if (endReason === "completed") endReason = "ws_error";
        onWarn("aiyra voice websocket error", err instanceof Error ? err.message : String(err));
        emitMetric("voice_session_ws_error", {
          error: err instanceof Error ? err.message : String(err),
        });
        void stopSession();
      });

      emitActiveSessionHealth("aiyra_voice_active", "Connected to Aiyra voice session.");

      const audioLoop = (async () => {
        while (!stopRequested && audioLoopRunning && ws && ws.readyState === ws.OPEN) {
          let frame = null;
          try {
            frame = await micRecorder.read();
          } catch (e) {
            if (!sessionState.running || stopRequested || !audioLoopRunning) {
              break;
            }
            onWarn("aiyra voice: mic read failed", e instanceof Error ? e.message : String(e));
            break;
          }
          if (!frame || frame.length === 0) continue;
          const nowMs = Date.now();
          const assistantPlaybackActive = nowMs < assistantPlaybackActiveUntilMs;
          if (sessionMicMuted && !assistantPlaybackActive) {
            if (aecProcessor) {
              try {
                aecProcessor.skipCaptureFrame(frame.length);
              } catch (aecErr) {
                disableAec(aecErr);
              }
            }
            continue;
          }
          const rawRms = frameRms(frame);
          const rawPeakAbs = framePeakAbs(frame);
          let processedFrame = frame;
          let aecOutputFrame = frame;
          let aecOutputRms = rawRms;
          let aecBypassedOnStarvation = false;
          if (aecProcessor) {
            try {
              const aecResult = await aecProcessor.processCaptureFrame(frame);
              aecOutputFrame = aecResult.frame;
              const stats =
                aecResult.stats && typeof aecResult.stats === "object"
                  ? aecResult.stats
                  : {};
              const referenceState =
                trimmed(stats.referenceState) ||
                trimmed(aecResult.referenceState) ||
                null;
              aecOutputRms = Number.isFinite(Number(stats.returnedOutputRms))
                ? Number(stats.returnedOutputRms)
                : aecOutputFrame === frame
                  ? rawRms
                  : frameRms(aecOutputFrame);
              processedFrame = aecOutputFrame;
              aecBypassedOnStarvation =
                aecResult.bypassedOnStarvation === true ||
                stats.bypassedOnStarvation === true ||
                referenceState === "starved";
              voicePipelineDiagnostics.lastAecStats = {
                audioBufferDelayMs: Number.isFinite(Number(stats.audioBufferDelayMs))
                  ? Number(stats.audioBufferDelayMs)
                  : null,
                bufferedRenderMs: Number.isFinite(Number(stats.bufferedRenderMs))
                  ? Number(stats.bufferedRenderMs)
                  : null,
                captureInputRms: Number.isFinite(Number(stats.captureInputRms))
                  ? Number(stats.captureInputRms)
                  : null,
                renderInputRms: Number.isFinite(Number(stats.renderInputRms))
                  ? Number(stats.renderInputRms)
                  : null,
                preCancelRms: Number.isFinite(Number(stats.preCancelRms))
                  ? Number(stats.preCancelRms)
                  : null,
                outputRms: Number.isFinite(Number(stats.outputRms))
                  ? Number(stats.outputRms)
                  : null,
                referenceState,
                bypassedOnStarvation:
                  aecBypassedOnStarvation === true ? true : null,
                resetCount: Number.isFinite(Number(stats.resetCount))
                  ? Number(stats.resetCount)
                  : null,
              };
              const bufferedRenderMs = Number(stats.bufferedRenderMs);
              const renderInputRms = Number(stats.renderInputRms);
              const resetCount = Number(stats.resetCount);
              const underrunSamples = Number(aecResult.underrunSamples);
              if (Number.isFinite(underrunSamples) && underrunSamples > 0) {
                voicePipelineDiagnostics.lastAecUnderrunSamples = underrunSamples;
                voicePipelineDiagnostics.lastAecUnderrunAtMs = nowMs;
              }
              if (aecBypassedOnStarvation && sawAudioDelta) {
                if (
                  nowMs - lastAecStarvationBypassMetricAtMs >=
                  activityMetricThrottleMs
                ) {
                  emitMetric("voice_aec_starvation_bypass", {
                    source,
                    backend: aecProcessor.backend || voiceAecBackend,
                    underrun_samples:
                      Number.isFinite(underrunSamples) && underrunSamples > 0
                        ? underrunSamples
                        : undefined,
                    buffered_render_ms: Number.isFinite(bufferedRenderMs)
                      ? bufferedRenderMs
                      : undefined,
                    render_input_rms: Number.isFinite(renderInputRms)
                      ? renderInputRms
                      : undefined,
                    reset_count: Number.isFinite(resetCount)
                      ? resetCount
                      : undefined,
                    reference_state: referenceState || undefined,
                    raw_rms: rawRms,
                    aec_output_rms: aecOutputRms,
                  });
                  lastAecStarvationBypassMetricAtMs = nowMs;
                }
              }
              if (
                aecProcessor.backend === "webrtc" &&
                nowMs - lastAecStatsMetricAtMs >= activityMetricThrottleMs
              ) {
                emitMetric("voice_webrtc_aec_stats", {
                  source,
                  backend: aecProcessor.backend,
                  audio_buffer_delay_ms: Number.isFinite(Number(stats.audioBufferDelayMs))
                    ? Number(stats.audioBufferDelayMs)
                    : undefined,
                  buffered_render_ms: Number.isFinite(Number(stats.bufferedRenderMs))
                    ? Number(stats.bufferedRenderMs)
                    : undefined,
                  capture_input_rms: Number.isFinite(Number(stats.captureInputRms))
                    ? Number(stats.captureInputRms)
                    : undefined,
                  render_input_rms: Number.isFinite(Number(stats.renderInputRms))
                    ? Number(stats.renderInputRms)
                    : undefined,
                  pre_cancel_rms: Number.isFinite(Number(stats.preCancelRms))
                    ? Number(stats.preCancelRms)
                    : undefined,
                  output_rms: Number.isFinite(Number(stats.outputRms))
                    ? Number(stats.outputRms)
                    : undefined,
                  reference_state: referenceState || undefined,
                  bypassed_on_starvation: aecBypassedOnStarvation
                    ? true
                    : undefined,
                  reset_count: Number.isFinite(Number(stats.resetCount))
                    ? Number(stats.resetCount)
                    : undefined,
                });
                lastAecStatsMetricAtMs = nowMs;
              }
              if (
                Number(aecResult.underrunSamples) > 0 &&
                sawAudioDelta &&
                nowMs - lastAecUnderrunMetricAtMs >= activityMetricThrottleMs
              ) {
                emitMetric("voice_aec_render_underrun", {
                  source,
                  backend: aecProcessor.backend || voiceAecBackend,
                  underrun_samples: Number(aecResult.underrunSamples),
                  frame_size: frame.length,
                });
                lastAecUnderrunMetricAtMs = nowMs;
              }
            } catch (aecErr) {
              disableAec(aecErr);
              processedFrame = frame;
              aecOutputFrame = frame;
              aecOutputRms = rawRms;
            }
          }
          if (assistantPlaybackActive) {
            if (
              assistantPlaybackActive &&
              nowMs - lastHalfDuplexMetricAtMs >= activityMetricThrottleMs
            ) {
              emitMetric("voice_half_duplex_gate", {
                source,
                response_active: assistantResponseActive,
                playback_hold_ms: Math.max(0, assistantPlaybackActiveUntilMs - nowMs),
              });
              lastHalfDuplexMetricAtMs = nowMs;
            }
            continue;
          }
          const aecOutputPeakAbs = framePeakAbs(aecOutputFrame);
          let rnnoiseVad = null;
          let rnnoiseOutputRms = null;
          const rnnoiseInputFrame = processedFrame;
          if (rnnoiseProcessor) {
            try {
              const denoised = rnnoiseProcessor.processFrame(rnnoiseInputFrame);
              processedFrame = denoised.frame;
              rnnoiseOutputRms = frameRms(denoised.frame);
              const maxVad = Number(denoised.maxVadProbability);
              const avgVad = Number(denoised.vadProbability);
              if (Number.isFinite(maxVad)) {
                rnnoiseVad = maxVad;
              } else if (Number.isFinite(avgVad)) {
                rnnoiseVad = avgVad;
              }
            } catch (rnnoiseErr) {
              const reason =
                rnnoiseErr instanceof Error ? rnnoiseErr.message : String(rnnoiseErr);
              onWarn("aiyra voice rnnoise processing failed, disabling denoise", reason);
              emitMetric("voice_denoise_failed", {
                source,
                engine: "rnnoise",
                reason,
              });
              try {
                rnnoiseProcessor.destroy();
              } catch {
                // ignore
              }
              rnnoiseProcessor = null;
              processedFrame = rnnoiseInputFrame;
            }
          }
          const denoisedRms =
            rnnoiseOutputRms !== null ? rnnoiseOutputRms : aecOutputRms;
          const denoisedPeakAbs = framePeakAbs(processedFrame);
          const rawSpeechCandidate = rawRms >= hotMicSpeechRmsThreshold;
          const effectiveProcessedRms = denoisedRms;
          const aecSuppressionRatio = safeRatio(aecOutputRms, rawRms);
          const rnnoiseSuppressionRatio = safeRatio(denoisedRms, aecOutputRms);
          const rnnoiseSpeechAccepted =
            !rnnoiseProcessor || rnnoiseVad === null
              ? true
              : rnnoiseVad >= voiceSpeechRnnoiseVadThreshold ||
                denoisedRms >= voiceDenoisedSpeechRmsThreshold;
          const withinWakeWordDiscardWindow =
            wakeWordAudioDiscardUntilMs > nowMs &&
            source === "wake_word" &&
            wakeWordPostConnectDiscardMs > 0;
          const countsAsUserSpeech =
            !withinWakeWordDiscardWindow &&
            rawSpeechCandidate &&
            rnnoiseSpeechAccepted;
          const speechOnsetCandidate =
            rawSpeechCandidate ||
            effectiveProcessedRms >=
              Math.max(24, Math.round(voiceCaptureGainSpeechFloorRms * 0.7));
          if (
            rawSpeechCandidate &&
            !countsAsUserSpeech &&
            rnnoiseProcessor &&
            nowMs - lastSpeechFilteredMetricAtMs >= activityMetricThrottleMs
          ) {
            emitMetric("voice_user_speech_filtered", {
              source,
              rms_threshold: hotMicSpeechRmsThreshold,
              denoised_rms_threshold: voiceDenoisedSpeechRmsThreshold,
              rnnoise_vad_threshold: voiceSpeechRnnoiseVadThreshold,
              rms: rawRms,
              raw_peak_abs: rawPeakAbs,
              aec_output_rms: aecOutputRms,
              aec_output_peak_abs: aecOutputPeakAbs,
              aec_bypassed_on_starvation: aecBypassedOnStarvation || undefined,
              denoised_rms: rnnoiseOutputRms !== null ? denoisedRms : undefined,
              denoised_peak_abs:
                rnnoiseOutputRms !== null ? denoisedPeakAbs : undefined,
              aec_suppression_ratio:
                aecSuppressionRatio !== null ? aecSuppressionRatio : undefined,
              rnnoise_suppression_ratio:
                rnnoiseSuppressionRatio !== null
                  ? rnnoiseSuppressionRatio
                  : undefined,
              rnnoise_vad_probability:
                rnnoiseVad !== null ? rnnoiseVad : undefined,
            });
            lastSpeechFilteredMetricAtMs = nowMs;
          }
          const wasFirstSpeechInSession = countsAsUserSpeech && !userSpokeInSession;
          if (countsAsUserSpeech) {
            stopThinkingPulse("user_speaking");
            stopSpokenProgressTracking("user_speaking");
            assistantResponseActive = false;
            assistantResponseHadAudio = false;
            lastUserInteractionAt = nowMs;
            if (wasFirstSpeechInSession) {
              userSpokeInSession = true;
            }
          }
          const gainHoldActive =
            voiceCaptureGainHoldMs > 0 &&
            lastMeaningfulSpeechAtMs > 0 &&
            nowMs - lastMeaningfulSpeechAtMs <= voiceCaptureGainHoldMs &&
            effectiveProcessedRms >=
              Math.max(24, Math.round(voiceCaptureGainSpeechFloorRms * 0.3));
          const effectiveTargetRms = clamp(
            Math.round(voiceCaptureGainTargetRms * sessionServerGainBias),
            Math.max(64, voiceDenoisedSpeechRmsThreshold),
            12000
          );
          const effectiveGainAttack =
            speechOnsetCandidate &&
            (wasFirstSpeechInSession || voiceCaptureGainState <= 1.25)
              ? voiceCaptureGainOnsetAttack
              : voiceCaptureGainAttack;
          const effectiveGainRelease =
            gainHoldActive && !speechOnsetCandidate
              ? voiceCaptureGainHoldRelease
              : voiceCaptureGainRelease;
          const gainAdjustedFrame = applyVoiceCaptureGainCompensation({
            frame: processedFrame,
            rawRms,
            processedRms: effectiveProcessedRms,
            currentGain: voiceCaptureGainState,
            speechFloorRms: voiceCaptureGainSpeechFloorRms,
            targetRms: effectiveTargetRms,
            maxGain: voiceCaptureGainMax,
            attack: effectiveGainAttack,
            release: effectiveGainRelease,
            clipHeadroom: voiceCaptureGainClipHeadroom,
          });
          voiceCaptureGainState = gainAdjustedFrame.nextGain;
          if (gainAdjustedFrame.meaningfulSpeech || speechOnsetCandidate) {
            lastMeaningfulSpeechAtMs = nowMs;
          }
          if (
            gainAdjustedFrame.appliedGain > 1.05 &&
            gainAdjustedFrame.meaningfulSpeech &&
            nowMs - lastCaptureGainMetricAtMs >= activityMetricThrottleMs
          ) {
            emitMetric("voice_capture_gain_compensated", {
              source,
              raw_rms: rawRms,
              raw_peak_abs: rawPeakAbs,
              aec_output_rms: aecOutputRms,
              aec_output_peak_abs: aecOutputPeakAbs,
              aec_bypassed_on_starvation: aecBypassedOnStarvation || undefined,
              rnnoise_output_rms:
                rnnoiseOutputRms !== null ? denoisedRms : undefined,
              rnnoise_output_peak_abs:
                rnnoiseOutputRms !== null ? denoisedPeakAbs : undefined,
              processed_rms: effectiveProcessedRms,
              boosted_rms: gainAdjustedFrame.outputRms,
              boosted_peak_abs: gainAdjustedFrame.outputPeakAbs,
              applied_gain: gainAdjustedFrame.appliedGain,
              target_gain: gainAdjustedFrame.targetGain,
              server_gain_bias: sessionServerGainBias,
              effective_target_rms: effectiveTargetRms,
              aec_suppression_ratio:
                aecSuppressionRatio !== null ? aecSuppressionRatio : undefined,
              rnnoise_suppression_ratio:
                rnnoiseSuppressionRatio !== null
                  ? rnnoiseSuppressionRatio
                  : undefined,
              sent_boost_ratio:
                safeRatio(gainAdjustedFrame.outputRms, effectiveProcessedRms) ??
                undefined,
              clipped_samples:
                gainAdjustedFrame.clippedSamples > 0
                  ? gainAdjustedFrame.clippedSamples
                  : undefined,
            });
            lastCaptureGainMetricAtMs = nowMs;
          }
          processedFrame = gainAdjustedFrame.frame;
          const sentRms = gainAdjustedFrame.outputRms;
          const sentPeakAbs = gainAdjustedFrame.outputPeakAbs;
          const sentBoostRatio = safeRatio(sentRms, effectiveProcessedRms);
          const frameDiagnostics = {
            ts: nowMs,
            rawRms,
            rawPeakAbs,
            aecOutputRms,
            aecOutputPeakAbs,
            rnnoiseOutputRms: rnnoiseOutputRms !== null ? denoisedRms : aecOutputRms,
            rnnoiseOutputPeakAbs: denoisedPeakAbs,
            sentRms,
            sentPeakAbs,
            appliedGain: gainAdjustedFrame.appliedGain,
            targetGain: gainAdjustedFrame.targetGain,
            serverGainBias: sessionServerGainBias,
            effectiveTargetRms,
            clippedSamples: gainAdjustedFrame.clippedSamples,
            rnnoiseVad,
            aecSuppressionRatio,
            rnnoiseSuppressionRatio,
            sentBoostRatio,
            rawSpeechCandidate,
            rnnoiseSpeechAccepted,
            countsAsUserSpeech,
            aecBypassedOnStarvation,
          };
          recordVoiceFrameDiagnostics(frameDiagnostics, {
            rawSpeechCandidate,
            countsAsUserSpeech,
            aecBypassedOnStarvation,
          });
          if (countsAsUserSpeech) {
            if (wasFirstSpeechInSession) {
              emitMetric("voice_user_speech_detected", {
                source,
                rms_threshold: hotMicSpeechRmsThreshold,
                rms: rawRms,
                raw_peak_abs: rawPeakAbs,
                aec_output_rms: aecOutputRms,
                aec_output_peak_abs: aecOutputPeakAbs,
                aec_bypassed_on_starvation: aecBypassedOnStarvation || undefined,
                denoised_rms: rnnoiseOutputRms !== null ? denoisedRms : undefined,
                denoised_peak_abs:
                  rnnoiseOutputRms !== null ? denoisedPeakAbs : undefined,
                sent_rms: Number.isFinite(sentRms) ? sentRms : undefined,
                sent_peak_abs: Number.isFinite(sentPeakAbs)
                  ? sentPeakAbs
                  : undefined,
                capture_gain:
                  gainAdjustedFrame.appliedGain > 1.05
                    ? gainAdjustedFrame.appliedGain
                    : undefined,
                server_gain_bias: sessionServerGainBias,
                effective_target_rms: effectiveTargetRms,
                aec_suppression_ratio:
                  aecSuppressionRatio !== null ? aecSuppressionRatio : undefined,
                rnnoise_suppression_ratio:
                  rnnoiseSuppressionRatio !== null
                    ? rnnoiseSuppressionRatio
                    : undefined,
                sent_boost_ratio:
                  sentBoostRatio !== null ? sentBoostRatio : undefined,
                rnnoise_vad_probability:
                  rnnoiseVad !== null ? rnnoiseVad : undefined,
              });
              lastSpeechActivityMetricAtMs = nowMs;
            } else if (nowMs - lastSpeechActivityMetricAtMs >= activityMetricThrottleMs) {
              emitMetric("voice_user_speech_activity", {
                source,
                rms_threshold: hotMicSpeechRmsThreshold,
                rms: rawRms,
                raw_peak_abs: rawPeakAbs,
                aec_output_rms: aecOutputRms,
                aec_output_peak_abs: aecOutputPeakAbs,
                aec_bypassed_on_starvation: aecBypassedOnStarvation || undefined,
                denoised_rms: rnnoiseOutputRms !== null ? denoisedRms : undefined,
                denoised_peak_abs:
                  rnnoiseOutputRms !== null ? denoisedPeakAbs : undefined,
                sent_rms: Number.isFinite(sentRms) ? sentRms : undefined,
                sent_peak_abs: Number.isFinite(sentPeakAbs)
                  ? sentPeakAbs
                  : undefined,
                capture_gain:
                  gainAdjustedFrame.appliedGain > 1.05
                    ? gainAdjustedFrame.appliedGain
                    : undefined,
                server_gain_bias: sessionServerGainBias,
                effective_target_rms: effectiveTargetRms,
                aec_suppression_ratio:
                  aecSuppressionRatio !== null ? aecSuppressionRatio : undefined,
                rnnoise_suppression_ratio:
                  rnnoiseSuppressionRatio !== null
                    ? rnnoiseSuppressionRatio
                    : undefined,
                sent_boost_ratio:
                  sentBoostRatio !== null ? sentBoostRatio : undefined,
                rnnoise_vad_probability:
                  rnnoiseVad !== null ? rnnoiseVad : undefined,
              });
              lastSpeechActivityMetricAtMs = nowMs;
            }
          }
          if (withinWakeWordDiscardWindow) {
            continue;
          }
          const playbackStillActive =
            Date.now() < assistantPlaybackActiveUntilMs ||
            playbackPendingBytes > 0 ||
            playbackWaitingForDrain;
          if (playbackStillActive) {
            continue;
          }
          const upsampled = upsamplePcm16(processedFrame, 16000, 24000);
          const payload = {
            type: "input_audio_buffer.append",
            audio: pcm16ToBase64(upsampled),
          };
          try {
            ws.send(JSON.stringify(payload));
          } catch (e) {
            onWarn(
              "aiyra voice: websocket send failed",
              e instanceof Error ? e.message : String(e)
            );
            break;
          }
        }
      })();

      idleTimer = setInterval(() => {
        if (!sessionState.running) return;
        const now = Date.now();
        const assistantTurnActive =
          (assistantResponseActive &&
            lastAssistantActivityAt > 0 &&
            now - lastAssistantActivityAt < assistantResponseFreshMs) ||
          now < assistantPlaybackActiveUntilMs;
        const lastMeaningfulActivityAt = userSpokeInSession
          ? Math.max(lastUserInteractionAt, lastAssistantActivityAt || 0)
          : lastAssistantActivityAt > 0
            ? lastAssistantActivityAt
            : sessionStartedAtMs;
        const idleFor = now - lastMeaningfulActivityAt;
        const sessionOpenFor = now - sessionStartedAtMs;
        const hotMicEngaged = userSpokeInSession;
        if (!assistantTurnActive) {
          maybeStartThinkingPulseFromSpeech(now);
        }
        if (callEndedAwaitingMaterialQueryTerminal) {
          return;
        }
        if (!hotMicEngaged && !assistantTurnActive && sessionOpenFor >= hotMicWindowMs) {
          onLog("aiyra voice hot-mic timeout", {
            sessionOpenFor,
            hotMicWindowMs,
            userSpokeInSession,
            sawAudioDelta,
            assistantResponseActive,
            lastAssistantActivityAgoMs:
              lastAssistantActivityAt > 0 ? Math.max(0, now - lastAssistantActivityAt) : null,
          });
          endReason = "hot_mic_timeout";
          emitMetric("voice_session_hot_mic_timeout", {
            source,
            session_open_for_ms: sessionOpenFor,
            hot_mic_window_ms: hotMicWindowMs,
            idle_for_ms: idleFor,
          });
          void stopSession();
          return;
        }
        if (!assistantTurnActive && idleFor >= sessionIdleTimeoutMs) {
          onLog("aiyra voice idle timeout", {
            idleFor,
            idleTimeoutMs: sessionIdleTimeoutMs,
          });
          endReason = "idle_timeout";
          emitMetric("voice_session_idle_timeout", {
            idle_for_ms: idleFor,
            idle_timeout_ms: sessionIdleTimeoutMs,
          });
          void stopSession();
        }
      }, 500);

      await audioLoop.catch(() => {});
    } catch (error) {
      endReason = "session_error";
      onWarn(
        "aiyra voice session failed",
        error instanceof Error ? error.message : String(error)
      );
      emitMetric("voice_session_error", {
        source,
        error: error instanceof Error ? error.message : String(error),
      });
      emitHealth("degraded", "aiyra_voice_error", error instanceof Error ? error.message : "voice_session_error", {
        wake_word: effectiveWakeWord,
        listening: false,
        active: false,
        muted: false,
        wakeword_source: wakewordSource,
      });
    } finally {
      const deferredTerminalSpeechText = pendingDeferredTerminalSpeechText;
      const shouldStartDetachedMaterialQueryFollowup =
        !deferredTerminalSpeechText &&
        callEndedAwaitingMaterialQueryTerminal &&
        !!sessionConversationId;
      const deferredConversationId = sessionConversationId;
      const deferredMaterialQueryTimeoutMs = sessionMaterialQueryTimeoutMs;
      if (sessionState.running) {
        await stopSession();
      }
      if (!stopRequested) {
        if (deferredTerminalSpeechText) {
          void speakDeferredFollowupLocally(deferredTerminalSpeechText, {
            reason: "material_query_terminal_after_session_end",
          });
        } else if (shouldStartDetachedMaterialQueryFollowup && deferredConversationId) {
          startDetachedMaterialQueryFollowup({
            conversationId: deferredConversationId,
            materialQueryTimeoutMs: deferredMaterialQueryTimeoutMs,
            reason: "session_ended_while_waiting_for_material_query",
          });
        }
      }
      onLog("aiyra voice session ended", {
        source,
        reason: endReason,
        conversation_id: sessionConversationId || null,
        orchestrator_session_id: sessionOrchestratorSessionId || null,
        binding_mode: sessionBindingMode || null,
        next_preferred_conversation_id: preferredConversationId || null,
        duration_ms: Math.max(0, Date.now() - sessionStartedAtMs),
      });
      emitMetric("voice_session_ended", {
        source,
        reason: endReason,
        duration_ms: Math.max(0, Date.now() - sessionStartedAtMs),
      });
      if (activeSession === sessionState) {
        activeSession = null;
      }
      sessionMicMuted = false;
    }
    return true;
  };

  const startWakeLoop = async () => {
    const openWakewordRequested = wakeEnginePreference !== "porcupine";
    let openWakewordFailureMessage = "";
    if (openWakewordRequested) {
      try {
        const resolvedOpenWakewordModelPath = await resolveOpenWakewordModelPath({
          appUrl,
          deviceToken,
          wakeWord,
          explicitModelPath: openWakewordModelPath,
          onLog,
          onWarn,
        });
        if (resolvedOpenWakewordModelPath) {
          openWakewordModelPath = resolvedOpenWakewordModelPath;
        }
        onLog("starting openwakeword wake detector", {
          wake_word: wakeWord,
          threshold: openWakewordThreshold,
          model_path: openWakewordModelPath || null,
          python_path: openWakewordPython || null,
          script_path: openWakewordScriptPath || null,
          allow_approximate: openWakewordAllowApproximate,
        });
        openWakewordDetector = await startOpenWakewordDetector({
          wakeWord,
          threshold: openWakewordThreshold,
          allowApproximate: openWakewordAllowApproximate,
          modelPath: openWakewordModelPath,
          pythonPath: openWakewordPython,
          scriptPath: openWakewordScriptPath,
          onLog,
          onWarn,
          onMetric: emitMetric,
        });
        wakeDetectorEngine = "openwakeword";
        effectiveWakeWord =
          trimmed(openWakewordDetector.effectiveWakeWord) || wakeWord;
        wakewordSource = "openwakeword";
        const openWakewordCaptureFrameLength = await ensureWakeRnnoiseProcessor({
          detectorFrameLength: OPENWAKEWORD_WAKE_FRAME_LENGTH,
          wakeEngineName: "openwakeword",
        });
        const currentDeviceIndex = await getCurrentDeviceIndex();
        wakeRecorder = new PvRecorder(openWakewordCaptureFrameLength, currentDeviceIndex);
        wakeRecorder.start();

        emitMetric("wake_loop_started", {
          wake_word: effectiveWakeWord,
          wake_sensitivity: wakeSensitivity,
          idle_timeout_ms: idleTimeoutMs,
          speech_rms_threshold: speechRmsThreshold,
          hot_mic_window_ms: hotMicWindowMs,
          hot_mic_speech_rms_threshold: hotMicSpeechRmsThreshold,
          wakeword_source: wakewordSource,
          wake_engine: wakeDetectorEngine,
          openwakeword_threshold: openWakewordThreshold,
          wake_model_label: openWakewordDetector.modelLabel || "",
          openwakeword_model_path: openWakewordDetector.modelPath || "",
          openwakeword_python: openWakewordDetector.pythonBin || "",
          openwakeword_script_path: openWakewordScriptPath,
          openwakeword_allow_approximate: openWakewordAllowApproximate,
          openwakeword_approximate_match: openWakewordDetector.approximateMatch === true,
          wake_detector_frame_length: OPENWAKEWORD_WAKE_FRAME_LENGTH,
          wake_capture_frame_length: openWakewordCaptureFrameLength,
          wake_denoise_enabled: wakeRnnoiseProcessor !== null,
        });

        resetWakeInputSilenceState({ resetZeroRecoveryCount: true });
        emitHealth(
          "healthy",
          "aiyra_wake_listening",
          `Listening for "${effectiveWakeWord}"`,
          {
            wake_word: effectiveWakeWord,
            listening: true,
            active: false,
            muted: false,
            wake_sensitivity: wakeSensitivity,
            idle_timeout_ms: idleTimeoutMs,
            hot_mic_window_ms: hotMicWindowMs,
            hot_mic_speech_rms_threshold: hotMicSpeechRmsThreshold,
            wakeword_source: wakewordSource,
            wake_engine: wakeDetectorEngine,
            openwakeword_threshold: openWakewordThreshold,
          }
        );

        let wakeReadFailureCount = 0;
        let wakeDetectorFailureCount = 0;
        const restartOpenWakewordDetector = async (error) => {
          const message = error instanceof Error ? error.message : String(error);
          emitMetric("openwakeword_detector_restarting", {
            wake_word: effectiveWakeWord,
            wake_engine: "openwakeword",
            error: message,
          });
          emitHealth(
            "recovering",
            "aiyra_openwakeword_restarting",
            "Restarting wake-word detector...",
            {
              wake_word: effectiveWakeWord,
              listening: true,
              active: false,
              muted: false,
              wakeword_source: wakewordSource,
              wake_engine: "openwakeword",
            }
          );
          try {
            if (openWakewordDetector) {
              await openWakewordDetector.stop();
            }
          } catch {
            // ignore
          }
          openWakewordDetector = await startOpenWakewordDetector({
            wakeWord,
            threshold: openWakewordThreshold,
            allowApproximate: openWakewordAllowApproximate,
            modelPath: openWakewordModelPath,
            pythonPath: openWakewordPython,
            scriptPath: openWakewordScriptPath,
            onLog,
            onWarn,
            onMetric: emitMetric,
          });
          effectiveWakeWord =
            trimmed(openWakewordDetector.effectiveWakeWord) || wakeWord;
          wakewordSource = "openwakeword";
          wakeDetectorEngine = "openwakeword";
          resetWakeInputSilenceState({ resetZeroRecoveryCount: true });
          emitMetric("openwakeword_detector_restarted", {
            wake_word: effectiveWakeWord,
            wake_engine: "openwakeword",
            model_label: openWakewordDetector.modelLabel || "",
            threshold: openWakewordDetector.threshold,
            python_bin: openWakewordDetector.pythonBin || "",
          });
          emitHealth(
            "healthy",
            "aiyra_wake_listening",
            `Listening for "${effectiveWakeWord}"`,
            {
              wake_word: effectiveWakeWord,
              listening: true,
              active: false,
              muted: false,
              wake_sensitivity: wakeSensitivity,
              idle_timeout_ms: idleTimeoutMs,
              hot_mic_window_ms: hotMicWindowMs,
              hot_mic_speech_rms_threshold: hotMicSpeechRmsThreshold,
              wakeword_source: wakewordSource,
              wake_engine: "openwakeword",
              openwakeword_threshold: openWakewordThreshold,
            }
          );
        };
        while (!stopRequested) {
          let frame = null;
          try {
            frame = await wakeRecorder.read();
          } catch (e) {
            if (stopRequested) break;
            wakeReadFailureCount += 1;
            if (wakeReadFailureCount > 3) {
              throw e;
            }
            await recoverWakeRecorder({
              detectorFrameLength: OPENWAKEWORD_WAKE_FRAME_LENGTH,
              wakeEngineName: "openwakeword",
              attempt: wakeReadFailureCount,
              error: e,
            });
            continue;
          }
          wakeReadFailureCount = 0;
          if (!frame || frame.length === 0) continue;
          const wakeFrame = processWakeFrame({
            frame,
            wakeEngineName: "openwakeword",
          });
          if (wakeFrame.shouldRecycleRecorder) {
            await recoverWakeRecorder({
              detectorFrameLength: OPENWAKEWORD_WAKE_FRAME_LENGTH,
              wakeEngineName: "openwakeword",
              attempt: Math.max(1, wakeFrame.recycleAttempt || 1),
              error: new Error("aiyra_wake_input_zero_frames"),
            });
            continue;
          }
          let detected = null;
          try {
            await openWakewordDetector.sendFrame(wakeFrame);
            detected = openWakewordDetector.pollDetection();
            wakeDetectorFailureCount = 0;
          } catch (e) {
            if (stopRequested) break;
            const message = e instanceof Error ? e.message : String(e);
            const unrecoverable =
              message.includes("openwakeword_frame_invalid") ||
              message.includes("openwakeword_model_not_found_for_wake_word");
            if (unrecoverable) {
              throw e;
            }
            wakeDetectorFailureCount += 1;
            emitMetric("openwakeword_detector_frame_failed", {
              wake_word: effectiveWakeWord,
              wake_engine: "openwakeword",
              attempt: wakeDetectorFailureCount,
              error: message,
            });
            if (wakeDetectorFailureCount > 3) {
              throw e;
            }
            await restartOpenWakewordDetector(e);
            continue;
          }
          if (!detected) continue;

          const now = Date.now();
          if (now < wakeSuppressedUntilMs) {
            emitMetric("wake_suppressed_detection", {
              reason: "deferred_followup_audio",
              remaining_ms: Math.max(0, wakeSuppressedUntilMs - now),
            });
            continue;
          }
          if (now - lastWakeAt < wakeCooldownMs) {
            const score = Number(detected?.score || 0);
            const modelLabel = trimmed(detected?.model_label);
            emitMetric("wake_cooldown_suppressed", {
              cooldown_ms: wakeCooldownMs,
              since_last_wake_ms: Math.max(0, now - lastWakeAt),
              remaining_cooldown_ms: Math.max(0, wakeCooldownMs - (now - lastWakeAt)),
              score: Number.isFinite(score) ? score : undefined,
              threshold: Number.isFinite(Number(detected?.threshold))
                ? Number(detected.threshold)
                : openWakewordThreshold,
              score_ratio: Number.isFinite(Number(detected?.score_ratio))
                ? Number(detected.score_ratio)
                : undefined,
              rms: Number.isFinite(Number(detected?.rms))
                ? Number(detected.rms)
                : wakeFrame.denoisedRms,
              raw_rms: Number.isFinite(Number(detected?.raw_rms))
                ? Number(detected.raw_rms)
                : wakeFrame.rawRms,
              denoised_rms: Number.isFinite(Number(detected?.denoised_rms))
                ? Number(detected.denoised_rms)
                : Number.isFinite(Number(detected?.rms))
                  ? Number(detected.rms)
                  : wakeFrame.denoisedRms,
              model_label: modelLabel || openWakewordDetector.modelLabel || "",
              rnnoise_vad_probability:
                wakeFrame.rnnoiseVad !== null ? wakeFrame.rnnoiseVad : undefined,
            });
            continue;
          }
          lastWakeAt = now;
          const score = Number(detected?.score || 0);
          const modelLabel = trimmed(detected?.model_label);
          const topLabel = trimmed(detected?.top_label);
          const topScore = Number(detected?.top_score || 0);
          const threshold = Number.isFinite(Number(detected?.threshold))
            ? Number(detected.threshold)
            : openWakewordThreshold;
          const scoreRatio = Number(detected?.score_ratio || 0);
          const rawRms = Number.isFinite(Number(detected?.raw_rms))
            ? Number(detected.raw_rms)
            : wakeFrame.rawRms;
          const denoisedRms = Number.isFinite(Number(detected?.denoised_rms))
            ? Number(detected.denoised_rms)
            : Number.isFinite(Number(detected?.rms))
              ? Number(detected.rms)
              : wakeFrame.denoisedRms;
          const rms = denoisedRms;
          onLog("aiyra wake-word detected", {
            wakeWord: effectiveWakeWord,
            requestedWakeWord: wakeWord,
            wakewordSource,
            wakeDetectorEngine,
            score: Number.isFinite(score) ? score : null,
            threshold: Number.isFinite(threshold) ? threshold : null,
            scoreRatio: Number.isFinite(scoreRatio) ? scoreRatio : null,
            rms: Number.isFinite(rms) ? rms : null,
            rawRms: Number.isFinite(rawRms) ? rawRms : null,
            denoisedRms: Number.isFinite(denoisedRms) ? denoisedRms : null,
            modelLabel: modelLabel || openWakewordDetector.modelLabel || null,
            topLabel: topLabel || null,
            topScore: Number.isFinite(topScore) ? topScore : null,
            rnnoiseVad: wakeFrame.rnnoiseVad,
          });
          emitMetric("wake_detected", {
            keyword_index: 0,
            score: Number.isFinite(score) ? score : undefined,
            threshold: Number.isFinite(threshold) ? threshold : undefined,
            score_ratio: Number.isFinite(scoreRatio) ? scoreRatio : undefined,
            rms: Number.isFinite(rms) ? rms : undefined,
            raw_rms: Number.isFinite(rawRms) ? rawRms : undefined,
            denoised_rms: Number.isFinite(denoisedRms)
              ? denoisedRms
              : undefined,
            model_label: modelLabel || openWakewordDetector.modelLabel || "",
            top_label: topLabel || "",
            top_score: Number.isFinite(topScore) ? topScore : undefined,
            rnnoise_vad_probability:
              wakeFrame.rnnoiseVad !== null ? wakeFrame.rnnoiseVad : undefined,
          });
          await runVoiceSession("wake_word");
          if (stopRequested) break;
          if (!wakeRecorder) {
            const captureFrameLength = await ensureWakeRnnoiseProcessor({
              detectorFrameLength: OPENWAKEWORD_WAKE_FRAME_LENGTH,
              wakeEngineName: "openwakeword",
            });
            const currentDeviceIndex = await getCurrentDeviceIndex();
            wakeRecorder = new PvRecorder(captureFrameLength, currentDeviceIndex);
          }
          try {
            wakeRecorder.start();
          } catch {
            try {
              wakeRecorder.release();
            } catch {
              // ignore
            }
            const captureFrameLength = await ensureWakeRnnoiseProcessor({
              detectorFrameLength: OPENWAKEWORD_WAKE_FRAME_LENGTH,
              wakeEngineName: "openwakeword",
            });
            const currentDeviceIndex = await getCurrentDeviceIndex();
            wakeRecorder = new PvRecorder(captureFrameLength, currentDeviceIndex);
            wakeRecorder.start();
          }
          resetWakeInputSilenceState();
          emitHealth(
            "healthy",
            "aiyra_wake_listening",
            `Listening for "${effectiveWakeWord}"`,
            {
              wake_word: effectiveWakeWord,
              listening: true,
              active: false,
              wakeword_source: wakewordSource,
              wake_engine: wakeDetectorEngine,
            }
          );
        }
        return;
      } catch (error) {
        openWakewordFailureMessage =
          error instanceof Error ? error.message : String(error);
        if (!openWakewordAllowPorcupineFallback) {
          throw new Error(
            `openwakeword_failed_without_porcupine_fallback:${openWakewordFailureMessage}`
          );
        }
        onWarn(
          "openwakeword wake loop start failed; falling back to porcupine",
          openWakewordFailureMessage
        );
        emitMetric("wake_engine_fallback", {
          from: "openwakeword",
          to: "porcupine",
          error: openWakewordFailureMessage,
        });
        try {
          if (wakeRecorder) wakeRecorder.stop();
        } catch {
          // ignore
        }
        await wait(40);
        try {
          if (wakeRecorder) wakeRecorder.release();
        } catch {
          // ignore
        }
        wakeRecorder = null;
        try {
          if (openWakewordDetector) {
            await openWakewordDetector.stop();
          }
        } catch {
          // ignore
        }
        openWakewordDetector = null;
      }
    }

    wakeDetectorEngine = "porcupine";
    try {
      await ensurePorcupineWakewordReady();
    } catch (error) {
      if (openWakewordFailureMessage) {
        const fallbackError = error instanceof Error ? error.message : String(error);
        throw new Error(
          `openwakeword_unavailable:${openWakewordFailureMessage}; porcupine_fallback_failed:${fallbackError}`
        );
      }
      throw error;
    }
    wakeEngine = new Porcupine(
      porcupineAccessKey,
      [keywordPath || builtinWakeword.keywordValue],
      [wakeSensitivity]
    );
    const porcupineCaptureFrameLength = await ensureWakeRnnoiseProcessor({
      detectorFrameLength: wakeEngine.frameLength,
      wakeEngineName: "porcupine",
    });
    {
      const currentDeviceIndex = await getCurrentDeviceIndex();
      wakeRecorder = new PvRecorder(porcupineCaptureFrameLength, currentDeviceIndex);
    }
    wakeRecorder.start();
    emitMetric("wake_loop_started", {
      wake_word: effectiveWakeWord,
      wake_sensitivity: wakeSensitivity,
      idle_timeout_ms: idleTimeoutMs,
      speech_rms_threshold: speechRmsThreshold,
      hot_mic_window_ms: hotMicWindowMs,
      hot_mic_speech_rms_threshold: hotMicSpeechRmsThreshold,
      wakeword_source: wakewordSource,
      wake_engine: wakeDetectorEngine,
      wake_detector_frame_length: wakeEngine.frameLength,
      wake_capture_frame_length: porcupineCaptureFrameLength,
      wake_denoise_enabled: wakeRnnoiseProcessor !== null,
    });

    resetWakeInputSilenceState({ resetZeroRecoveryCount: true });
    emitHealth("healthy", "aiyra_wake_listening", `Listening for "${effectiveWakeWord}"`, {
      wake_word: effectiveWakeWord,
      listening: true,
      active: false,
      muted: false,
      wake_sensitivity: wakeSensitivity,
      idle_timeout_ms: idleTimeoutMs,
      hot_mic_window_ms: hotMicWindowMs,
      hot_mic_speech_rms_threshold: hotMicSpeechRmsThreshold,
      wakeword_source: wakewordSource,
      wake_engine: wakeDetectorEngine,
    });

    let wakeReadFailureCount = 0;
    while (!stopRequested) {
      let frame = null;
      try {
        frame = await wakeRecorder.read();
      } catch (e) {
        if (stopRequested) break;
        wakeReadFailureCount += 1;
        if (wakeReadFailureCount > 3) {
          throw e;
        }
        await recoverWakeRecorder({
          detectorFrameLength: wakeEngine.frameLength,
          wakeEngineName: "porcupine",
          attempt: wakeReadFailureCount,
          error: e,
        });
        continue;
      }
      wakeReadFailureCount = 0;
      if (!frame || frame.length === 0) continue;
      const wakeFrame = processWakeFrame({
        frame,
        wakeEngineName: "porcupine",
      });
      if (wakeFrame.shouldRecycleRecorder) {
        await recoverWakeRecorder({
          detectorFrameLength: wakeEngine.frameLength,
          wakeEngineName: "porcupine",
          attempt: Math.max(1, wakeFrame.recycleAttempt || 1),
          error: new Error("aiyra_wake_input_zero_frames"),
        });
        continue;
      }
      let keywordIndex = -1;
      for (
        let offset = 0;
        offset + wakeEngine.frameLength <= wakeFrame.frame.length;
        offset += wakeEngine.frameLength
      ) {
        keywordIndex = wakeEngine.process(
          wakeFrame.frame.subarray(offset, offset + wakeEngine.frameLength)
        );
        if (keywordIndex >= 0) {
          break;
        }
      }
      if (keywordIndex < 0) continue;

      const now = Date.now();
      if (now < wakeSuppressedUntilMs) {
        emitMetric("wake_suppressed_detection", {
          reason: "deferred_followup_audio",
          remaining_ms: Math.max(0, wakeSuppressedUntilMs - now),
        });
        continue;
      }
      if (now - lastWakeAt < wakeCooldownMs) {
        emitMetric("wake_cooldown_suppressed", {
          cooldown_ms: wakeCooldownMs,
          rms: Number.isFinite(wakeFrame.denoisedRms)
            ? wakeFrame.denoisedRms
            : undefined,
          raw_rms: Number.isFinite(wakeFrame.rawRms) ? wakeFrame.rawRms : undefined,
          denoised_rms: Number.isFinite(wakeFrame.denoisedRms)
            ? wakeFrame.denoisedRms
            : undefined,
          rnnoise_vad_probability:
            wakeFrame.rnnoiseVad !== null ? wakeFrame.rnnoiseVad : undefined,
        });
        continue;
      }
      lastWakeAt = now;
      onLog("aiyra wake-word detected", {
        wakeWord: effectiveWakeWord,
        requestedWakeWord: wakeWord,
        keywordIndex,
        wakewordSource,
        wakeDetectorEngine,
        rms: Number.isFinite(wakeFrame.denoisedRms)
          ? wakeFrame.denoisedRms
          : null,
        rawRms: Number.isFinite(wakeFrame.rawRms) ? wakeFrame.rawRms : null,
        denoisedRms: Number.isFinite(wakeFrame.denoisedRms)
          ? wakeFrame.denoisedRms
          : null,
        rnnoiseVad: wakeFrame.rnnoiseVad,
      });
      emitMetric("wake_detected", {
        keyword_index: keywordIndex,
        rms: Number.isFinite(wakeFrame.denoisedRms)
          ? wakeFrame.denoisedRms
          : undefined,
        raw_rms: Number.isFinite(wakeFrame.rawRms) ? wakeFrame.rawRms : undefined,
        denoised_rms: Number.isFinite(wakeFrame.denoisedRms)
          ? wakeFrame.denoisedRms
          : undefined,
        rnnoise_vad_probability:
          wakeFrame.rnnoiseVad !== null ? wakeFrame.rnnoiseVad : undefined,
      });
      await runVoiceSession("wake_word");
      if (stopRequested) break;
      if (!wakeRecorder) {
        const captureFrameLength = await ensureWakeRnnoiseProcessor({
          detectorFrameLength: wakeEngine.frameLength,
          wakeEngineName: "porcupine",
        });
        const currentDeviceIndex = await getCurrentDeviceIndex();
        wakeRecorder = new PvRecorder(captureFrameLength, currentDeviceIndex);
      }
      try {
        wakeRecorder.start();
      } catch {
        try {
          wakeRecorder.release();
        } catch {
          // ignore
        }
        const captureFrameLength = await ensureWakeRnnoiseProcessor({
          detectorFrameLength: wakeEngine.frameLength,
          wakeEngineName: "porcupine",
        });
        const currentDeviceIndex = await getCurrentDeviceIndex();
        wakeRecorder = new PvRecorder(captureFrameLength, currentDeviceIndex);
        wakeRecorder.start();
      }
      resetWakeInputSilenceState({ resetZeroRecoveryCount: true });
      emitHealth("healthy", "aiyra_wake_listening", `Listening for "${effectiveWakeWord}"`, {
        wake_word: effectiveWakeWord,
        listening: true,
        active: false,
        muted: false,
        wakeword_source: wakewordSource,
        wake_engine: wakeDetectorEngine,
      });
    }
  };

  onLog("aiyra runtime starting wake loop", {
    wake_word: effectiveWakeWord,
    wake_engine_preference: wakeEnginePreference,
  });
  wakeLoopPromise = startWakeLoop().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    destroyWakeRnnoiseProcessor();
    onWarn("aiyra wake loop failed", message);
    emitMetric("wake_loop_failed", { error: message });
    emitHealth("degraded", "aiyra_wakeword_failed", message, {
      wake_word: effectiveWakeWord,
      listening: false,
      active: false,
      muted: false,
      wakeword_source: wakewordSource,
    });
  });
  onLog("aiyra runtime wake loop launched", {
    wake_word: effectiveWakeWord,
  });

  const stop = async () => {
    stopRequested = true;
    emitMetric("runtime_stop_requested");
    try {
      if (activeSession?.stop) {
        await activeSession.stop();
      }
    } catch {
      // ignore
    }
    try {
      if (wakeRecorder) wakeRecorder.stop();
    } catch {
      // ignore
    }
    await wait(40);
    try {
      if (wakeRecorder) wakeRecorder.release();
    } catch {
      // ignore
    }
    wakeRecorder = null;
    destroyWakeRnnoiseProcessor();
    try {
      if (openWakewordDetector) {
        await openWakewordDetector.stop();
      }
    } catch {
      // ignore
    }
    openWakewordDetector = null;
    try {
      if (wakeEngine) wakeEngine.release();
    } catch {
      // ignore
    }
    wakeEngine = null;
    if (wakeLoopPromise) {
      await wakeLoopPromise.catch(() => {});
    }
    emitMetric("runtime_stopped");
    emitHealth("disabled", "aiyra_voice_stopped", "Aiyra voice runtime stopped.", {
      wake_word: effectiveWakeWord,
      listening: false,
      active: false,
      muted: false,
      wakeword_source: wakewordSource,
    });
  };

  const setMuted = async (muted) => {
    if (!activeSession?.running) {
      sessionMicMuted = false;
      return {
        ok: false,
        active: false,
        muted: false,
        error: "no_active_voice_session",
      };
    }

    const nextMuted = muted === true;
    if (sessionMicMuted !== nextMuted) {
      sessionMicMuted = nextMuted;
      const source = activeSession?.source || "voice_session";
      onLog(nextMuted ? "aiyra voice mic muted" : "aiyra voice mic unmuted", {
        source,
      });
      emitMetric(nextMuted ? "voice_mic_muted" : "voice_mic_unmuted", {
        source,
      });
      emitHealth(
        "healthy",
        "aiyra_voice_active",
        nextMuted
          ? "Connected to Aiyra voice session (mic muted)."
          : "Connected to Aiyra voice session.",
        {
          wake_word: effectiveWakeWord,
          listening: false,
          active: true,
          muted: sessionMicMuted,
          wakeword_source: wakewordSource,
          wake_engine: wakeDetectorEngine,
        }
      );
    }

    return {
      ok: true,
      active: true,
      muted: sessionMicMuted,
    };
  };

  return {
    stop,
    setMuted,
    trigger: async () => {
      if (stopRequested) return false;
      await runVoiceSession("manual_trigger");
      return true;
    },
  };
}
