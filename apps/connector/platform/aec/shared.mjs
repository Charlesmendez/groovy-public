export function clampInt16(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(-32768, Math.min(32767, Math.round(value)));
}

export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function toFiniteNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function normalizePositiveInt(value, fallback, min = 1) {
  const n = Math.trunc(toFiniteNumber(value, fallback));
  return Math.max(min, n);
}

export function normalizeMultiple(value, step, fallback, min = step) {
  const n = Math.round(toFiniteNumber(value, fallback) / step) * step;
  return Math.max(min, n);
}

export function estimateResampledLength(sampleCount, inputRate, outputRate) {
  const normalizedCount = Math.max(0, Math.trunc(sampleCount));
  const inRate = normalizePositiveInt(inputRate, 1, 1);
  const outRate = normalizePositiveInt(outputRate, 1, 1);
  if (!normalizedCount) return 0;
  if (inRate === outRate) return normalizedCount;
  return Math.max(1, Math.round((normalizedCount * outRate) / inRate));
}

export function resamplePcm16(input, inputRate, outputRate) {
  if (!(input instanceof Int16Array)) {
    throw new Error("aec_resample_input_must_be_int16");
  }
  if (!input.length) return new Int16Array(0);
  if (inputRate === outputRate) return new Int16Array(input);
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
    out[i] = clampInt16(v0 + (v1 - v0) * frac);
  }
  return out;
}

export function bufferToInt16Le(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    return new Int16Array(0);
  }
  const evenLength = buffer.length - (buffer.length % 2);
  const out = new Int16Array(evenLength / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = buffer.readInt16LE(i * 2);
  }
  return out;
}

export function normalizeInt16Input(input) {
  if (input instanceof Int16Array) {
    return input;
  }
  if (Buffer.isBuffer(input)) {
    return bufferToInt16Le(input);
  }
  throw new Error("aec_frame_must_be_int16_or_buffer");
}

export function normalizeFrameLength(frame, expectedLength) {
  if (frame.length === expectedLength) {
    return frame;
  }
  const out = new Int16Array(expectedLength);
  out.set(frame.subarray(0, expectedLength));
  return out;
}

export function int16ToFloat32Mono(input) {
  const frame = normalizeInt16Input(input);
  const out = new Float32Array(frame.length);
  for (let i = 0; i < frame.length; i += 1) {
    out[i] = frame[i] / 32768;
  }
  return out;
}

export function float32ToInt16Mono(input) {
  if (!(input instanceof Float32Array)) {
    throw new Error("aec_frame_must_be_float32");
  }
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i += 1) {
    out[i] = clampInt16(input[i] * 32768);
  }
  return out;
}
