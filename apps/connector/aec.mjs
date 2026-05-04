import { createLegacyAecProcessor } from "./platform/aec/legacy.mjs";
import { createWebRtcAecProcessor } from "./platform/aec/webrtc.mjs";

export function normalizeAecBackend(value, fallback = "webrtc") {
  const backend = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (backend === "legacy" || backend === "webrtc" || backend === "off") {
    return backend;
  }
  return fallback;
}

export async function createAecProcessor(opts = {}) {
  const backend = normalizeAecBackend(
    opts.backend ?? process.env.AIYRA_AEC_BACKEND,
    "webrtc"
  );

  if (backend === "off") {
    return null;
  }
  if (backend === "legacy") {
    return createLegacyAecProcessor(opts);
  }
  return createWebRtcAecProcessor(opts);
}
