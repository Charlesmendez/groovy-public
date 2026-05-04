import { createRequire } from "node:module";
import path from "path";
import { fileURLToPath } from "url";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const RNNOISE_INPUT_RATE = 16000;
const RNNOISE_NATIVE_RATE = 48000;

export const RNNOISE_FRAME_SIZE_48K = 480;
export const RNNOISE_INPUT_FRAME_SIZE_16K = RNNOISE_FRAME_SIZE_48K / 3;

let cachedNativeAddon = null;

function clampInt16(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(-32768, Math.min(32767, Math.round(value)));
}

function resamplePcm16(input, inputRate, outputRate) {
  if (!input || input.length === 0) return new Int16Array(0);
  if (inputRate === outputRate) return new Int16Array(input);
  const ratio = outputRate / inputRate;
  const outLength = Math.max(1, Math.floor(input.length * ratio));
  const out = new Int16Array(outLength);
  for (let i = 0; i < outLength; i += 1) {
    const src = i / ratio;
    const i0 = Math.floor(src);
    const i1 = Math.min(i0 + 1, input.length - 1);
    const frac = src - i0;
    const v0 = input[i0] || 0;
    const v1 = input[i1] || 0;
    out[i] = clampInt16(v0 + (v1 - v0) * frac);
  }
  return out;
}

function int16ArrayToBuffer(input) {
  return Buffer.from(input.buffer, input.byteOffset, input.byteLength);
}

function bufferToInt16Array(input) {
  if (!Buffer.isBuffer(input)) {
    throw new Error("rnnoise_native_invalid_output_buffer");
  }
  if (input.byteLength % 2 !== 0) {
    throw new Error("rnnoise_native_output_must_be_pcm16le");
  }
  return new Int16Array(input.buffer, input.byteOffset, input.byteLength / 2);
}

function resolveAddonPath() {
  return path.resolve(
    MODULE_DIR,
    "native",
    "rnnoise-addon",
    "build",
    "Release",
    "rnnoise.node"
  );
}

function loadRnnoiseNativeAddon() {
  if (cachedNativeAddon) {
    return cachedNativeAddon;
  }

  const addonPath = resolveAddonPath();

  let mod;
  try {
    mod = require(addonPath);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `rnnoise_native_addon_unavailable:${reason}; expected=${addonPath}; build_command=npm run build:rnnoise:addon`
    );
  }

  if (
    !mod ||
    typeof mod.createState !== "function" ||
    typeof mod.getFrameSize !== "function" ||
    typeof mod.processPcm16le !== "function"
  ) {
    throw new Error(`rnnoise_native_addon_invalid_exports:${addonPath}`);
  }

  cachedNativeAddon = mod;
  return mod;
}

export async function createRnnoiseProcessor() {
  const nativeAddon = loadRnnoiseNativeAddon();
  const nativeFrameSize = Number(nativeAddon.getFrameSize());

  if (!Number.isInteger(nativeFrameSize) || nativeFrameSize <= 0) {
    throw new Error(`rnnoise_native_invalid_frame_size:${nativeFrameSize}`);
  }
  if (nativeFrameSize % 3 !== 0) {
    throw new Error(`rnnoise_native_unexpected_frame_size:${nativeFrameSize}`);
  }

  const inputFrameSize = nativeFrameSize / 3;
  const state = nativeAddon.createState();
  if (!state) {
    throw new Error("rnnoise_state_create_failed");
  }

  let destroyed = false;

  const destroy = () => {
    if (destroyed) return;
    destroyed = true;
    if (typeof nativeAddon.destroyState === "function") {
      try {
        nativeAddon.destroyState(state);
      } catch {
        // ignore native cleanup failures during shutdown
      }
    }
  };

  return {
    implementation: "native",
    inputFrameSize,
    nativeFrameSize,
    processFrame(frame16k) {
      if (destroyed) {
        throw new Error("rnnoise_processor_destroyed");
      }
      if (!(frame16k instanceof Int16Array)) {
        throw new Error("rnnoise_frame_must_be_int16");
      }
      if (frame16k.length === 0) {
        return {
          frame: new Int16Array(0),
          vadProbability: null,
          maxVadProbability: null,
        };
      }
      if (frame16k.length % inputFrameSize !== 0) {
        throw new Error(
          `rnnoise_frame_length_must_be_multiple_of_${inputFrameSize}`
        );
      }

      const upsampled48k = resamplePcm16(
        frame16k,
        RNNOISE_INPUT_RATE,
        RNNOISE_NATIVE_RATE
      );
      if (upsampled48k.length % nativeFrameSize !== 0) {
        throw new Error(
          `rnnoise_native_upsample_alignment_failed:${upsampled48k.length}`
        );
      }

      let outputBuffer = null;
      let avgVad = null;
      let maxVad = null;

      if (typeof nativeAddon.processPcm16leWithVad === "function") {
        const result = nativeAddon.processPcm16leWithVad(
          state,
          int16ArrayToBuffer(upsampled48k)
        );
        outputBuffer = result?.output ?? null;
        if (Number.isFinite(Number(result?.vadProbability))) {
          avgVad = Number(result.vadProbability);
        }
        if (Number.isFinite(Number(result?.maxVadProbability))) {
          maxVad = Number(result.maxVadProbability);
        }
      } else {
        outputBuffer = nativeAddon.processPcm16le(
          state,
          int16ArrayToBuffer(upsampled48k)
        );
      }

      const denoised48k = bufferToInt16Array(outputBuffer);
      const denoised16k = resamplePcm16(
        denoised48k,
        RNNOISE_NATIVE_RATE,
        RNNOISE_INPUT_RATE
      );

      if (denoised16k.length !== frame16k.length) {
        throw new Error(
          `rnnoise_native_output_length_mismatch:${denoised16k.length}:${frame16k.length}`
        );
      }

      return {
        frame: denoised16k,
        vadProbability: avgVad,
        maxVadProbability: maxVad,
      };
    },
    destroy,
  };
}
