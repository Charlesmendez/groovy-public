import {
  clamp,
  clampInt16,
  normalizeFrameLength,
  normalizeInt16Input,
  normalizeMultiple,
  normalizePositiveInt,
  resamplePcm16,
  toFiniteNumber,
} from "./shared.mjs";

function createSampleQueue(capacitySamples) {
  const maxSamples = Math.max(1, Math.trunc(capacitySamples));
  const chunks = [];
  let queuedSamples = 0;

  const discard = (sampleCount) => {
    let remaining = Math.max(0, Math.trunc(sampleCount));
    while (remaining > 0 && chunks.length > 0) {
      const head = chunks[0];
      if (remaining >= head.length) {
        remaining -= head.length;
        queuedSamples -= head.length;
        chunks.shift();
        continue;
      }
      chunks[0] = head.subarray(remaining);
      queuedSamples -= remaining;
      remaining = 0;
    }
  };

  return {
    push(chunk) {
      if (!(chunk instanceof Int16Array) || chunk.length === 0) return;
      let nextChunk = chunk;
      if (nextChunk.length >= maxSamples) {
        nextChunk = nextChunk.subarray(nextChunk.length - maxSamples);
        chunks.length = 0;
        queuedSamples = 0;
      }
      const overflow = queuedSamples + nextChunk.length - maxSamples;
      if (overflow > 0) {
        discard(overflow);
      }
      chunks.push(new Int16Array(nextChunk));
      queuedSamples += nextChunk.length;
    },
    pull(sampleCount) {
      const needed = Math.max(0, Math.trunc(sampleCount));
      const out = new Int16Array(needed);
      let written = 0;
      while (written < needed && chunks.length > 0) {
        const head = chunks[0];
        const copyCount = Math.min(head.length, needed - written);
        out.set(head.subarray(0, copyCount), written);
        written += copyCount;
        queuedSamples -= copyCount;
        if (copyCount === head.length) {
          chunks.shift();
        } else {
          chunks[0] = head.subarray(copyCount);
        }
      }
      return {
        frame: out,
        underrunSamples: Math.max(0, needed - written),
      };
    },
    discard,
    clear() {
      chunks.length = 0;
      queuedSamples = 0;
    },
  };
}

function appendToHistory(history, chunk) {
  if (!(chunk instanceof Int16Array) || chunk.length === 0) return;
  const len = history.length;
  if (chunk.length >= len) {
    const start = chunk.length - len;
    for (let i = 0; i < len; i += 1) {
      history[i] = chunk[start + i];
    }
    return;
  }
  history.copyWithin(0, chunk.length);
  const offset = len - chunk.length;
  for (let i = 0; i < chunk.length; i += 1) {
    history[offset + i] = chunk[i];
  }
}

function computeFrameEnergy(frame) {
  let energy = 0;
  for (let i = 0; i < frame.length; i += 1) {
    const value = frame[i];
    energy += value * value;
  }
  return energy;
}

function computeWindowCorrelation(history, historyStart, micFrame, micEnergy, frameSize, epsilon) {
  let dot = 0;
  let refEnergy = 0;
  for (let i = 0; i < frameSize; i += 1) {
    const ref = history[historyStart + i];
    const mic = micFrame[i];
    dot += mic * ref;
    refEnergy += ref * ref;
  }
  if (refEnergy <= epsilon || micEnergy <= epsilon) {
    return { score: 0, refEnergy: 0, dot: 0 };
  }
  return {
    score: Math.abs(dot) / Math.sqrt((refEnergy + epsilon) * (micEnergy + epsilon)),
    refEnergy,
    dot,
  };
}

export async function createLegacyAecProcessor(opts = {}) {
  const sampleRate = normalizePositiveInt(opts.sampleRate, 16000, 8000);
  const playbackSampleRate = normalizePositiveInt(opts.playbackSampleRate, 24000, 8000);
  const frameSize = normalizeMultiple(opts.frameSize, 80, 320, 80);
  const filterLength = normalizePositiveInt(opts.filterLength, 3200, frameSize);
  const searchStep = normalizeMultiple(opts.searchStep, 40, 40, 40);
  const renderQueueCapacityMs = normalizePositiveInt(
    opts.renderQueueCapacityMs,
    2000,
    250
  );
  const renderQueueCapacitySamples = Math.max(
    frameSize * 8,
    Math.round((sampleRate * renderQueueCapacityMs) / 1000)
  );
  const historyLength = frameSize + filterLength + searchStep * 2;
  const epsilon = 1e-6;
  const minRenderRms = Math.max(80, toFiniteNumber(opts.minRenderRms, 140));
  const gainSmoothing = clamp(toFiniteNumber(opts.gainSmoothing, 0.2), 0.02, 0.7);
  const doubleTalkGainScale = clamp(toFiniteNumber(opts.doubleTalkGainScale, 0.25), 0, 1);
  const gainClamp = clamp(toFiniteNumber(opts.gainClamp, 2.5), 0.5, 6);
  const correlationSearchFloor = clamp(
    toFiniteNumber(opts.correlationSearchFloor, 0.08),
    0,
    1
  );
  const residualSuppressStart = clamp(
    toFiniteNumber(opts.residualSuppressStart, 0.35),
    0,
    1
  );
  const residualSuppressStrong = clamp(
    toFiniteNumber(opts.residualSuppressStrong, 0.65),
    residualSuppressStart,
    1
  );
  const nearEndProtectionRatio = Math.max(
    1,
    toFiniteNumber(opts.nearEndProtectionRatio, 1.35)
  );

  const renderQueue = createSampleQueue(renderQueueCapacitySamples);
  const renderHistory = new Float32Array(historyLength);
  const candidateResidual = new Float32Array(frameSize);
  const workingResidual = new Float32Array(frameSize);
  let estimatedDelaySamples = 0;
  let estimatedDelaySamplesRaw = 0;
  let estimatedEchoGain = 0;
  let destroyed = false;

  const ensureLive = () => {
    if (destroyed) {
      throw new Error("aec_processor_destroyed");
    }
  };

  return {
    backend: "legacy",
    frameSize,
    filterLength,
    sampleRate,
    playbackSampleRate,
    pushPlaybackPcm(frameInput, inputSampleRate = playbackSampleRate) {
      ensureLive();
      const frame = normalizeInt16Input(frameInput);
      if (!frame.length) return 0;
      const resampled =
        inputSampleRate === sampleRate
          ? new Int16Array(frame)
          : resamplePcm16(frame, inputSampleRate, sampleRate);
      renderQueue.push(resampled);
      return resampled.length;
    },
    async processCaptureFrame(frameInput) {
      ensureLive();
      const micFrame = normalizeFrameLength(normalizeInt16Input(frameInput), frameSize);
      const { frame: renderFrame, underrunSamples } = renderQueue.pull(frameSize);
      appendToHistory(renderHistory, renderFrame);

      const micEnergy = computeFrameEnergy(micFrame);
      const maxSearchDelay = Math.max(0, Math.min(filterLength, historyLength - frameSize));
      let bestDelay = estimatedDelaySamples;
      let bestScore = 0;
      let bestRefEnergy = 0;
      let bestDot = 0;

      for (let delay = 0; delay <= maxSearchDelay; delay += searchStep) {
        const start = historyLength - frameSize - delay;
        if (start < 0) break;
        const { score, refEnergy, dot } = computeWindowCorrelation(
          renderHistory,
          start,
          micFrame,
          micEnergy,
          frameSize,
          epsilon
        );
        if (score > bestScore) {
          bestScore = score;
          bestDelay = delay;
          bestRefEnergy = refEnergy;
          bestDot = dot;
        }
      }

      if (bestScore >= correlationSearchFloor) {
        estimatedDelaySamplesRaw = estimatedDelaySamplesRaw * 0.65 + bestDelay * 0.35;
      } else {
        estimatedDelaySamplesRaw *= 0.85;
      }
      estimatedDelaySamples = normalizeMultiple(
        estimatedDelaySamplesRaw,
        searchStep,
        estimatedDelaySamplesRaw,
        0
      );

      const playbackRms = Math.sqrt(bestRefEnergy / Math.max(1, frameSize));
      const micRms = Math.sqrt(micEnergy / Math.max(1, frameSize));
      const playbackActive = playbackRms >= minRenderRms;
      const nearEndRatio = micRms / Math.max(playbackRms, 1);
      const bestStart = Math.max(0, historyLength - frameSize - estimatedDelaySamples);
      for (let i = 0; i < frameSize; i += 1) {
        workingResidual[i] = micFrame[i];
      }

      const targetGain =
        playbackActive && bestScore >= correlationSearchFloor
          ? clamp(bestDot / Math.max(bestRefEnergy, epsilon), 0, gainClamp)
          : 0;
      estimatedEchoGain =
        estimatedEchoGain * (1 - gainSmoothing) + targetGain * gainSmoothing;

      const predictedMicRms = playbackRms * Math.abs(estimatedEchoGain);
      const doubleTalkLikely =
        playbackActive &&
        nearEndRatio >= nearEndProtectionRatio &&
        micRms > predictedMicRms * 1.1;

      if (playbackActive && bestScore >= correlationSearchFloor && estimatedEchoGain > 0) {
        const appliedGain = doubleTalkLikely
          ? estimatedEchoGain * doubleTalkGainScale
          : estimatedEchoGain;
        let candidateEnergy = 0;
        for (let i = 0; i < frameSize; i += 1) {
          const value = micFrame[i] - appliedGain * renderHistory[bestStart + i];
          candidateResidual[i] = value;
          candidateEnergy += value * value;
        }
        if (candidateEnergy <= micEnergy * 0.995) {
          for (let i = 0; i < frameSize; i += 1) {
            workingResidual[i] = candidateResidual[i];
          }
        } else {
          estimatedEchoGain *= 0.9;
        }
      } else {
        estimatedEchoGain *= 0.94;
      }

      let residualEnergy = 0;
      for (let i = 0; i < frameSize; i += 1) {
        const value = workingResidual[i];
        residualEnergy += value * value;
      }
      const residualRms = Math.sqrt(residualEnergy / Math.max(1, frameSize));

      let residualGain = 1;
      if (playbackActive && !doubleTalkLikely) {
        if (bestScore >= residualSuppressStrong && nearEndRatio < 1) {
          residualGain = 0.4;
        } else if (bestScore >= residualSuppressStart && nearEndRatio < 1.2) {
          residualGain = 0.7;
        }
      }

      const out = new Int16Array(frameSize);
      for (let i = 0; i < frameSize; i += 1) {
        out[i] = clampInt16(workingResidual[i] * residualGain);
      }

      return {
        frame: out,
        underrunSamples,
        estimatedDelaySamples,
        correlation: bestScore,
        playbackRms,
        residualRms,
      };
    },
    skipCaptureFrame(sampleCount = frameSize) {
      ensureLive();
      renderQueue.discard(sampleCount);
    },
    reset() {
      ensureLive();
      renderQueue.clear();
      renderHistory.fill(0);
      estimatedEchoGain = 0;
      estimatedDelaySamplesRaw = 0;
      estimatedDelaySamples = 0;
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      renderQueue.clear();
      renderHistory.fill(0);
      estimatedEchoGain = 0;
      estimatedDelaySamplesRaw = 0;
      estimatedDelaySamples = 0;
    },
  };
}
