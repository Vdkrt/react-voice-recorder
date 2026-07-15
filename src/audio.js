import { Application, Signal, createEncoder, loadLibopus } from 'libopus-wasm';
import NoiseSuppressorWorklet from '@timephy/rnnoise-wasm/NoiseSuppressorWorklet?worker&url';
import { NoiseSuppressorWorklet_Name } from '@timephy/rnnoise-wasm';

function clampInt(value, min, max) {
  const numericValue = Number.isFinite(value) ? Math.round(value) : min;
  return Math.min(max, Math.max(min, numericValue));
}

function mapOpusApplication(application) {
  switch (application) {
    case 'Voip':
      return Application.Voip;
    case 'RestrictedLowDelay':
      return Application.RestrictedLowDelay;
    default:
      return Application.Audio;
  }
}

function mapOpusSignal(signal) {
  switch (signal) {
    case 'Voice':
      return Signal.Voice;
    case 'Auto':
      return Signal.Auto;
    default:
      return Signal.Music;
  }
}

export function buildOpusEncoderOptions(settings = {}) {
  const bitrate = Number(settings.opusBitrate ?? 32000);
  const complexity = Number(settings.opusComplexity ?? 10);
  const packetLossPercent = Number(settings.opusPacketLossPercent ?? 0);

  return {
    sampleRate: 48000,
    channels: 1,
    bitrate: Number.isFinite(bitrate) ? Math.max(16000, Math.round(bitrate)) : 32000,
    application: mapOpusApplication(settings.opusApplication),
    signal: mapOpusSignal(settings.opusSignal),
    complexity: clampInt(complexity, 0, 10),
    packetLossPercent: clampInt(packetLossPercent, 0, 100),
    vbr: Boolean(settings.opusVbr),
    vbrConstraint: Boolean(settings.opusVbrConstraint),
  };
}

function getPreferredOpusMimeType() {
  if (typeof window === 'undefined' || typeof MediaRecorder === 'undefined') {
    return '';
  }

  if (MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) {
    return 'audio/webm;codecs=opus';
  }

  if (MediaRecorder.isTypeSupported('audio/ogg;codecs=opus')) {
    return 'audio/ogg;codecs=opus';
  }

  return '';
}

export async function buildOpusBlob(samples, sampleRate, settings = {}) {
  const mimeType = getPreferredOpusMimeType();

  if (typeof window !== 'undefined' && typeof AudioContext !== 'undefined' && mimeType) {
    try {
      const audioContext = new AudioContext({ sampleRate });
      await audioContext.resume();

      const audioBuffer = audioContext.createBuffer(1, samples.length, sampleRate);
      const channelData = audioBuffer.getChannelData(0);
      for (let i = 0; i < samples.length; i += 1) {
        channelData[i] = Math.max(-1, Math.min(1, samples[i]));
      }

      const sourceNode = audioContext.createBufferSource();
      sourceNode.buffer = audioBuffer;
      const destinationNode = audioContext.createMediaStreamDestination();
      sourceNode.connect(destinationNode);

      const chunks = [];
      const recorder = new MediaRecorder(destinationNode.stream, { mimeType });
      recorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) {
          chunks.push(event.data);
        }
      };

      await new Promise((resolve, reject) => {
        recorder.onerror = reject;
        recorder.onstop = resolve;
        recorder.start();
        sourceNode.start(0);
        sourceNode.onended = () => {
          if (recorder.state !== 'inactive') {
            recorder.stop();
          }
        };
      });

      await audioContext.close();
      return new Blob(chunks, { type: mimeType });
    } catch (error) {
      console.warn('Browser Opus recording failed, falling back to a compact placeholder.', error);
    }
  }

  return new Blob([new Uint8Array([0x4f, 0x67, 0x67, 0x53])], { type: 'audio/ogg;codecs=opus' });
}

export function buildWavBlob(samples, sampleRate) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);

  const writeString = (offset, text) => {
    for (let i = 0; i < text.length; i += 1) {
      view.setUint8(offset + i, text.charCodeAt(i));
    }
  };

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(36, 'data');
  view.setUint32(40, samples.length * 2, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i += 1) {
    const sample = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
    offset += 2;
  }

  return new Blob([buffer], { type: 'audio/wav' });
}

export function formatBytes(bytes) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`;
}

export function formatDuration(seconds) {
  const safeSeconds = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  const mins = Math.floor(safeSeconds / 60);
  const secs = Math.floor(safeSeconds % 60);
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

export async function processAudioSamples(samples, strength, frameSize, mode, settings = {}) {
  const inputSampleRate = Number(settings.inputSampleRate ?? 44100);

  if (mode === 'denoise') {
    return {
      samples: await applyRhythmicNoiseReduction(samples, strength, frameSize, settings),
      sampleRate: inputSampleRate,
    };
  }

  return applyOpusCompression(samples, strength, frameSize, settings);
}

export async function createNoiseSuppressorNode(audioContext) {
  if (typeof AudioWorkletNode === 'undefined' || typeof window === 'undefined') {
    return null;
  }

  try {
    await audioContext.audioWorklet.addModule(NoiseSuppressorWorklet);
    return new AudioWorkletNode(audioContext, NoiseSuppressorWorklet_Name);
  } catch (error) {
    console.warn('RNNoise worklet could not be loaded:', error);
    return null;
  }
}

export function resampleAudio(samples, fromRate, toRate) {
  if (fromRate === toRate || samples.length === 0) {
    return samples;
  }

  const outputLength = Math.max(1, Math.round(samples.length * toRate / fromRate));
  const output = new Float32Array(outputLength);
  if (outputLength === 1) {
    output[0] = samples[0] ?? 0;
    return output;
  }

  for (let i = 0; i < output.length; i += 1) {
    const sourceIndex = (i / (output.length - 1)) * (samples.length - 1);
    const left = Math.floor(sourceIndex);
    const right = Math.min(left + 1, samples.length - 1);
    const weight = sourceIndex - left;
    output[i] = samples[left] * (1 - weight) + samples[right] * weight;
  }
  return output;
}

async function applyRhythmicNoiseReduction(samples, strength, frameSize, settings = {}) {
  if (settings.rnnoiseEnabled === false) {
    return new Float32Array(samples);
  }

  const inputSamples = new Float32Array(samples);

  if (typeof window === 'undefined' || typeof OfflineAudioContext === 'undefined' || typeof AudioWorkletNode === 'undefined') {
    const fallbackResult = applyFallbackGain(inputSamples, strength, frameSize, true);
    return preserveAmplitude(fallbackResult, inputSamples);
  }

  try {
    const sampleRate = Number(settings.inputSampleRate ?? 44100);
    const workletSampleRate = 44100;
    const resampledForDenoise = resampleAudio(inputSamples, sampleRate, workletSampleRate);
    const length = resampledForDenoise.length;
    const offlineCtx = new OfflineAudioContext(1, length, workletSampleRate);

    // addModule expects a URL/string as used in createNoiseSuppressorNode
    await offlineCtx.audioWorklet.addModule(NoiseSuppressorWorklet);

    const node = new AudioWorkletNode(offlineCtx, NoiseSuppressorWorklet_Name);
    // send optional parameters to the processor if supported
    if (node.port && typeof node.port.postMessage === 'function') {
      node.port.postMessage({ strength: Number(strength) || 0 });
    }

    const buffer = offlineCtx.createBuffer(1, length, workletSampleRate);
    // copy samples into buffer (ensure Float32Array)
    const channel = buffer.getChannelData(0);
    channel.set(resampledForDenoise);

    const src = offlineCtx.createBufferSource();
    src.buffer = buffer;
    src.connect(node).connect(offlineCtx.destination);
    src.start(0);

    const rendered = await offlineCtx.startRendering();
    const out = rendered.getChannelData(0);
    const resampledBack = resampleAudio(new Float32Array(out), workletSampleRate, sampleRate);

    let maxDiff = 0;
    const comparisonLength = Math.min(resampledBack.length, inputSamples.length);
    for (let i = 0; i < comparisonLength; i += 1) {
      const d = Math.abs(resampledBack[i] - inputSamples[i]);
      if (d > maxDiff) maxDiff = d;
    }

    const outputLooksUnchanged = maxDiff < 1e-4 || !resampledBack.some((value) => Number.isFinite(value));
    if (outputLooksUnchanged) {
      console.warn('RNNoise worklet produced no meaningful change — using local denoise fallback.');

      const fallbackResult = applyFallbackGain(inputSamples, strength, frameSize, true);
      return preserveAmplitude(fallbackResult, inputSamples);
    }

    return preserveAmplitude(resampledBack, inputSamples);
  } catch (err) {
    console.warn('RNNoise offline processing failed, returning local fallback denoise.', err);

    const fallbackResult = applyFallbackGain(inputSamples, strength, frameSize, true);
    return preserveAmplitude(fallbackResult, inputSamples);
  }
}

async function applyOpusCompression(samples, strength, frameSize, settings = {}) {
  const inputSampleRate = Number(settings.inputSampleRate ?? 44100);

  try {
    await loadLibopus();
    const encoder = await createEncoder(buildOpusEncoderOptions(settings));

    const resampledTo48k = resampleAudio(samples, inputSampleRate, 48000);
    const chunkSize = Math.max(480, Math.round(settings.opusFrameSize ?? encoder.frameSize ?? 960));
    const frame = new Float32Array(chunkSize);
    const decodedFrames = [];

    for (let i = 0; i < resampledTo48k.length; i += chunkSize) {
      const slice = resampledTo48k.subarray(i, i + chunkSize);
      frame.fill(0);
      frame.set(slice, 0);
      const packet = encoder.encodeFloat(frame);
      const decoded = packet;
      decodedFrames.push(decoded);
    }

    encoder.free();

    return {
      samples: concatenateFloat32Arrays(decodedFrames.map((packet) => new Float32Array(packet))),
      sampleRate: inputSampleRate,
    };
  } catch (error) {
    return {
      samples: new Float32Array(samples),
      sampleRate: inputSampleRate,
    };
  }
}

function concatenateFloat32Arrays(chunks) {
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const output = new Float32Array(totalLength);
  let cursor = 0;

  chunks.forEach((chunk) => {
    output.set(chunk, cursor);
    cursor += chunk.length;
  });

  return output;
}

function preserveAmplitude(output, reference) {
  const referencePeak = reference.reduce((max, value) => Math.max(max, Math.abs(value)), 0);
  const outputPeak = output.reduce((max, value) => Math.max(max, Math.abs(value)), 0);

  if (!Number.isFinite(referencePeak) || referencePeak < 1e-6 || !Number.isFinite(outputPeak) || outputPeak < 1e-6) {
    return output;
  }

  const scale = Math.min(1, referencePeak / outputPeak);
  const adjusted = new Float32Array(output.length);

  for (let i = 0; i < output.length; i += 1) {
    adjusted[i] = output[i] * scale;
  }

  return adjusted;
}

function applyFallbackGain(samples, strength, frameSize, denoise) {
  console.log('USE FALLBACK GAIN');
  const length = samples.length;
  const output = new Float32Array(length);
  const weightSum = new Float32Array(length);
  const window = Math.max(8, frameSize);
  const normalizedStrength = Math.max(0, Math.min(1, Number(strength) || 0));
  const hop = Math.max(1, Math.floor(window / 2));

  const winFunc = new Float32Array(window);
  for (let n = 0; n < window; n += 1) {
    winFunc[n] = 1;
  }

  for (let i = 0; i < length; i += hop) {
    const frameEnd = Math.min(i + window, length);
    const frame = samples.subarray(i, frameEnd);

    let energy = 0;
    let peak = 0;
    for (let j = 0; j < frame.length; j += 1) {
      const sample = frame[j];
      const magnitude = Math.abs(sample);
      energy += sample * sample;
      peak = Math.max(peak, magnitude);
    }

    const rms = Math.sqrt(energy / Math.max(1, frame.length));
    const isNoiseLike = peak < 0.08 + (1 - normalizedStrength) * 0.08 && rms < 0.05 + (1 - normalizedStrength) * 0.03;

    const attenuation = denoise && isNoiseLike ? 0.15 + normalizedStrength * 0.25 : 1;

    for (let j = 0; j < frame.length; j += 1) {
      const w = winFunc[j];
      const idx = i + j;
      output[idx] += frame[j] * attenuation * w;
      weightSum[idx] += w;
    }
  }

  for (let i = 0; i < length; i += 1) {
    const w = weightSum[i];
    if (w > 1e-8) {
      output[i] = output[i] / w;
    } else {
      output[i] = samples[i];
    }
  }

  return output;
}
