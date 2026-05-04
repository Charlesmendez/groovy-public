import { createRequire } from "node:module";
import {
  clamp,
  estimateResampledLength,
  float32ToInt16Mono,
  int16ToFloat32Mono,
  normalizeFrameLength,
  normalizeInt16Input,
  normalizeMultiple,
  normalizePositiveInt,
  toFiniteNumber,
} from "./shared.mjs";

const require = createRequire(import.meta.url);
const WEBRTC_AEC_INTERNAL_SAMPLE_RATE = 48000;

let webRtcAecModulePromise = null;

function computeInt16Rms(frame) {
  if (!(frame instanceof Int16Array) || frame.length === 0) return 0;
  let energy = 0;
  for (let i = 0; i < frame.length; i += 1) {
    const value = frame[i];
    energy += value * value;
  }
  return Math.sqrt(energy / Math.max(1, frame.length));
}

function computeFloat32Rms(frame) {
  if (!(frame instanceof Float32Array) || frame.length === 0) return 0;
  let energy = 0;
  for (let i = 0; i < frame.length; i += 1) {
    const value = frame[i] * 32768;
    energy += value * value;
  }
  return Math.sqrt(energy / Math.max(1, frame.length));
}

function samplesToMs(sampleCount, sampleRate) {
  const normalizedCount = Math.max(0, Math.trunc(sampleCount));
  const normalizedRate = normalizePositiveInt(sampleRate, 1, 1);
  if (!normalizedCount) return 0;
  return (normalizedCount * 1000) / normalizedRate;
}

async function loadWebRtcAecModule() {
  if (webRtcAecModulePromise) return webRtcAecModulePromise;
  webRtcAecModulePromise = Promise.resolve()
    .then(() => require("@ennuicastr/webrtcaec3.js"))
    .then((init) => {
      if (typeof init !== "function") {
        throw new Error("webrtc_aec_module_invalid");
      }
      return init();
    })
    .catch((error) => {
      webRtcAecModulePromise = null;
      throw new Error(
        `webrtc_aec_module_load_failed:${error instanceof Error ? error.message : String(error)}`
      );
    });
  return webRtcAecModulePromise;
}

export async function createWebRtcAecProcessor(opts = {}) {
  const sampleRate = normalizePositiveInt(opts.sampleRate, 16000, 8000);
  const playbackSampleRate = normalizePositiveInt(opts.playbackSampleRate, 24000, 8000);
  const frameSize = normalizeMultiple(opts.frameSize, 80, 320, 80);
  const filterLength = normalizePositiveInt(opts.filterLength, 3200, frameSize);
  const renderQueueCapacityMs = clamp(
    toFiniteNumber(opts.renderQueueCapacityMs, 2000),
    250,
    5000
  );
  const maxDelayMs = clamp(
    toFiniteNumber(opts.maxDelayMs, renderQueueCapacityMs),
    0,
    renderQueueCapacityMs
  );
  const configuredAudioBufferDelayMs = clamp(
    toFiniteNumber(opts.audioBufferDelayMs, 50),
    0,
    renderQueueCapacityMs
  );
  const maxBufferedRenderSamples = Math.max(
    estimateResampledLength(frameSize, sampleRate, WEBRTC_AEC_INTERNAL_SAMPLE_RATE) * 4,
    Math.round((WEBRTC_AEC_INTERNAL_SAMPLE_RATE * maxDelayMs) / 1000)
  );

  const aecModule = await loadWebRtcAecModule();
  if (!aecModule || typeof aecModule.AEC3 !== "function") {
    throw new Error("webrtc_aec_constructor_missing");
  }

  let aec = null;
  let destroyed = false;
  let bufferedRenderSamples = 0;
  let lastRenderRms = 0;
  let lastCaptureRms = 0;
  let lastOutputRms = 0;
  let lastPreRms = 0;
  let lastBufferedRenderMs = 0;
  let lastEffectiveAudioBufferDelayMs = configuredAudioBufferDelayMs;
  let renderChunksSeen = 0;
  let renderReferenceEverSeen = false;
  let starvationActive = false;
  let lastReferenceState = "idle";
  let resetCount = 0;

  const ensureLive = () => {
    if (destroyed) {
      throw new Error("aec_processor_destroyed");
    }
  };

  const freeAec = () => {
    if (aec && typeof aec.free === "function") {
      aec.free();
    }
    aec = null;
  };

  const allocateAec = () => {
    const instance = new aecModule.AEC3(WEBRTC_AEC_INTERNAL_SAMPLE_RATE, 1, 1);
    instance.setAudioBufferDelay(configuredAudioBufferDelayMs);
    return instance;
  };

  const recreateAecState = ({ preserveCaptureRms = false } = {}) => {
    freeAec();
    aec = allocateAec();
    bufferedRenderSamples = 0;
    lastRenderRms = 0;
    if (!preserveCaptureRms) {
      lastCaptureRms = 0;
    }
    lastOutputRms = 0;
    lastPreRms = 0;
    lastBufferedRenderMs = 0;
    lastEffectiveAudioBufferDelayMs = configuredAudioBufferDelayMs;
    renderChunksSeen = 0;
    lastReferenceState = renderReferenceEverSeen ? "missing" : "idle";
    resetCount += 1;
  };

  aec = allocateAec();

  const reduceBufferedRenderSamples = (captureSampleCount) => {
    bufferedRenderSamples = Math.max(
      0,
      bufferedRenderSamples -
        estimateResampledLength(
          captureSampleCount,
          sampleRate,
          WEBRTC_AEC_INTERNAL_SAMPLE_RATE
        )
    );
  };

  const processCaptureChunk = (captureFrameInput) => {
    ensureLive();
    const captureFrame = normalizeInt16Input(captureFrameInput);
    lastCaptureRms = computeInt16Rms(captureFrame);
    const requiredRenderSamples = estimateResampledLength(
      captureFrame.length,
      sampleRate,
      WEBRTC_AEC_INTERNAL_SAMPLE_RATE
    );
    const availableRenderSamples = bufferedRenderSamples;
    const bufferedRenderMs = samplesToMs(
      availableRenderSamples,
      WEBRTC_AEC_INTERNAL_SAMPLE_RATE
    );
    const underrunRenderSamples =
      renderChunksSeen > 0
        ? Math.max(0, requiredRenderSamples - availableRenderSamples)
        : 0;
    const effectiveAudioBufferDelayMs = clamp(
      configuredAudioBufferDelayMs + bufferedRenderMs,
      0,
      renderQueueCapacityMs
    );
    if (underrunRenderSamples > 0) {
      // When the render reference starves, stale far-end history can suppress
      // the near-end mic as if old playback were still active.
      starvationActive = true;
      recreateAecState({ preserveCaptureRms: true });
    }
    const referenceState =
      underrunRenderSamples > 0
        ? "starved"
        : availableRenderSamples > 0
        ? "valid"
        : starvationActive
          ? "starved"
          : renderReferenceEverSeen
            ? "missing"
            : "idle";
    lastReferenceState = referenceState;
    if (referenceState !== "valid") {
      lastBufferedRenderMs = 0;
      lastEffectiveAudioBufferDelayMs = configuredAudioBufferDelayMs;
      lastPreRms = 0;
      lastOutputRms = lastCaptureRms;
      return {
        captureFrame,
        processedFrameRaw: captureFrame,
        requiredRenderSamples,
        availableRenderSamples: 0,
        underrunRenderSamples,
        referenceState,
        bypassedOnStarvation: referenceState === "starved",
      };
    }

    aec.setAudioBufferDelay(Math.round(effectiveAudioBufferDelayMs));
    lastBufferedRenderMs = bufferedRenderMs;
    lastEffectiveAudioBufferDelayMs = effectiveAudioBufferDelayMs;

    const capture = int16ToFloat32Mono(captureFrame);
    const processOpts = {
      sampleRateIn: sampleRate,
      sampleRateOut: sampleRate,
    };
    const outputLength = Math.max(1, aec.processSize([capture], processOpts));
    const preBuffer = [new Float32Array(outputLength)];
    const outBuffer = [new Float32Array(outputLength)];
    aec.process(outBuffer, [capture], {
      ...processOpts,
      pre: preBuffer,
    });

    reduceBufferedRenderSamples(captureFrame.length);

    const processedFrameRaw = float32ToInt16Mono(outBuffer[0]);
    lastOutputRms = computeInt16Rms(processedFrameRaw);
    lastPreRms = computeFloat32Rms(preBuffer[0]);

    return {
      captureFrame,
      processedFrameRaw,
      requiredRenderSamples,
      availableRenderSamples,
      underrunRenderSamples,
      referenceState,
      bypassedOnStarvation: false,
    };
  };

  return {
    backend: "webrtc",
    frameSize,
    filterLength,
    sampleRate,
    playbackSampleRate,
    pushPlaybackPcm(frameInput, inputSampleRate = playbackSampleRate) {
      ensureLive();
      const frame = normalizeInt16Input(frameInput);
      if (!frame.length) return 0;
      const render = int16ToFloat32Mono(frame);
      aec.analyze([render], { sampleRateIn: inputSampleRate });
      lastRenderRms = computeInt16Rms(frame);
      renderReferenceEverSeen = true;
      starvationActive = false;
      bufferedRenderSamples = Math.min(
        maxBufferedRenderSamples,
        bufferedRenderSamples +
          estimateResampledLength(
            frame.length,
            inputSampleRate,
            WEBRTC_AEC_INTERNAL_SAMPLE_RATE
          )
      );
      lastBufferedRenderMs = samplesToMs(
        bufferedRenderSamples,
        WEBRTC_AEC_INTERNAL_SAMPLE_RATE
      );
      lastEffectiveAudioBufferDelayMs = clamp(
        configuredAudioBufferDelayMs + lastBufferedRenderMs,
        0,
        renderQueueCapacityMs
      );
      renderChunksSeen += 1;
      return frame.length;
    },
    async processCaptureFrame(frameInput) {
      const captureFrame = normalizeFrameLength(normalizeInt16Input(frameInput), frameSize);
      const {
        processedFrameRaw,
        requiredRenderSamples,
        availableRenderSamples,
        underrunRenderSamples,
        referenceState,
        bypassedOnStarvation,
      } =
        processCaptureChunk(captureFrame);
      const processedFrame = normalizeFrameLength(
        processedFrameRaw,
        frameSize
      );

      return {
        frame: processedFrame,
        underrunSamples:
          underrunRenderSamples > 0
            ? Math.max(
                0,
                estimateResampledLength(
                  underrunRenderSamples,
                  WEBRTC_AEC_INTERNAL_SAMPLE_RATE,
                  sampleRate
                )
              )
            : 0,
        playbackRms: referenceState === "valid" ? lastRenderRms : 0,
        residualRms: lastOutputRms,
        referenceState,
        bypassedOnStarvation,
        stats: {
          audioBufferDelayMs: lastEffectiveAudioBufferDelayMs,
          captureInputRms: lastCaptureRms,
          renderInputRms: referenceState === "valid" ? lastRenderRms : 0,
          preCancelRms: lastPreRms,
          outputRms: lastOutputRms,
          bufferedRenderMs: lastBufferedRenderMs,
          referenceState: lastReferenceState,
          returnedOutputRms: lastOutputRms,
          bypassedOnStarvation,
          resetCount,
        },
      };
    },
    skipCaptureFrame(sampleCount = frameSize) {
      ensureLive();
      let remaining = Math.max(0, Math.trunc(sampleCount));
      while (remaining > 0) {
        const chunkSize = Math.min(frameSize, remaining);
        processCaptureChunk(new Int16Array(chunkSize));
        remaining -= chunkSize;
      }
    },
    reset() {
      ensureLive();
      starvationActive = false;
      recreateAecState();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      bufferedRenderSamples = 0;
      lastRenderRms = 0;
      lastCaptureRms = 0;
      lastOutputRms = 0;
      lastPreRms = 0;
      lastBufferedRenderMs = 0;
      lastEffectiveAudioBufferDelayMs = configuredAudioBufferDelayMs;
      renderChunksSeen = 0;
      renderReferenceEverSeen = false;
      starvationActive = false;
      lastReferenceState = "idle";
      freeAec();
    },
  };
}
