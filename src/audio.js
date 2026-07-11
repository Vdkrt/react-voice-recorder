import { Application, Signal, createEncoder, loadLibopus } from 'libopus-wasm';
import NoiseSuppressorWorklet from '@timephy/rnnoise-wasm/NoiseSuppressorWorklet?worker&url';
import { NoiseSuppressorWorklet_Name } from '@timephy/rnnoise-wasm';

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

export async function processAudioSamples(samples, strength, frameSize, mode) {
  if (mode === 'denoise') {
    return applyRhythmicNoiseReduction(samples, strength, frameSize);
  }

  return applyOpusCompression(samples, strength, frameSize);
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

  const ratio = fromRate / toRate;
  const output = new Float32Array(Math.max(1, Math.floor(samples.length / ratio)));
  for (let i = 0; i < output.length; i += 1) {
    const sourceIndex = i * ratio;
    const left = Math.floor(sourceIndex);
    const right = Math.min(left + 1, samples.length - 1);
    const weight = sourceIndex - left;
    output[i] = samples[left] * (1 - weight) + samples[right] * weight;
  }
  return output;
}

async function applyRhythmicNoiseReduction(samples, strength, frameSize) {
  return applyFallbackGain(samples, strength, frameSize, true);
}

async function applyOpusCompression(samples, strength, frameSize) {
  try {
    await loadLibopus();
    const encoder = await createEncoder({
      sampleRate: 48000,
      channels: 1,
      bitrate: Math.round(16000 + strength * 32000),
      application: Application.Audio,
      signal: Signal.Music,
      vbr: true,
    });

    const resampled = resampleAudio(samples, 44100, 48000);
    const frameSize = 960;
    const frame = new Float32Array(frameSize);
    const output = [];

    for (let i = 0; i < resampled.length; i += frameSize) {
      const slice = resampled.subarray(i, i + frameSize);
      frame.set(slice, 0);
      const packet = encoder.encodeFloat(frame);
      output.push(packet);
    }

    encoder.free();
    return resampled;
  } catch (error) {
    return applyFallbackGain(samples, strength, frameSize, false);
  }
}

function applyFallbackGain(samples, strength, frameSize, denoise) {
  const output = new Float32Array(samples.length);
  const window = Math.max(8, frameSize);

  for (let i = 0; i < samples.length; i += window) {
    const frameEnd = Math.min(i + window, samples.length);
    const frame = samples.subarray(i, frameEnd);
    let energy = 0;
    for (let j = 0; j < frame.length; j += 1) {
      energy += frame[j] * frame[j];
    }
    const isSilence = energy < 0.0001;
    const gain = denoise ? 1 - strength * 0.35 : 0.8 + strength * 0.2;
    for (let j = 0; j < frame.length; j += 1) {
      const sample = frame[j];
      const adjusted = isSilence ? sample * 0.2 : sample * gain;
      output[i + j] = adjusted;
    }
  }

  return output;
}
