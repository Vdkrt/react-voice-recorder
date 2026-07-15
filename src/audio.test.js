import { describe, expect, it } from 'vitest';
import { Application, Signal } from 'libopus-wasm';
import { buildOpusBlob, buildOpusEncoderOptions, processAudioSamples, resampleAudio } from './audio';

describe('resampleAudio', () => {
  it('resamples a simple signal to the requested rate', () => {
    const input = new Float32Array([0, 0.5, 1, 0.5]);
    const output = resampleAudio(input, 4, 8);

    expect(output.length).toBeGreaterThan(input.length);
    expect(output[0]).toBe(0);
    expect(output[output.length - 1]).toBeLessThanOrEqual(1);
  });
});

describe('buildOpusEncoderOptions', () => {
  it('maps UI settings into libopus encoder options', () => {
    const options = buildOpusEncoderOptions({
      opusBitrate: 48000,
      opusApplication: 'Voip',
      opusSignal: 'Voice',
      opusComplexity: 6,
      opusPacketLossPercent: 15,
      opusVbr: false,
      opusVbrConstraint: true,
    });

    expect(options).toMatchObject({
      sampleRate: 48000,
      channels: 1,
      bitrate: 48000,
      application: Application.Voip,
      signal: Signal.Voice,
      complexity: 6,
      packetLossPercent: 15,
      vbr: false,
      vbrConstraint: true,
    });
  });
});

describe('processAudioSamples', () => {
  it('attenuates low-energy noise more aggressively in fallback denoise mode', async () => {
    const input = new Float32Array([0.04, 0.04, 0.04, 0.04, 0.04, 0.04, 0.04, 0.04]);
    const output = await processAudioSamples(input, 0.7, 8, 'denoise', { inputSampleRate: 44100 });

    expect(output.samples[2]).toBeLessThan(input[2]);
  });

  it('uses a local denoise fallback when RNNoise processing is ineffective', async () => {
    const input = new Float32Array([0.01, 0.015, 0.012, 0.011, 0.03, 0.02, 0.01, 0.013]);
    const output = await processAudioSamples(input, 0.8, 8, 'denoise', { inputSampleRate: 44100 });

    expect(output.samples.some((value, index) => Math.abs(value - input[index]) > 1e-6)).toBe(true);
  });

  it('preserves loudness for speech-like audio while denoising', async () => {
    const input = new Float32Array([0.2, 0.3, 0.2, 0.4, 0.5, 0.4, 0.35, 0.25]);
    const output = await processAudioSamples(input, 0.7, 8, 'denoise', { inputSampleRate: 44100 });
    const inputRms = Math.sqrt(input.reduce((sum, sample) => sum + sample * sample, 0) / input.length);
    const outputRms = Math.sqrt(output.samples.reduce((sum, sample) => sum + sample * sample, 0) / output.samples.length);

    expect(outputRms).toBeGreaterThanOrEqual(inputRms * 0.8);
  });

  it('keeps compressed output aligned with the original sample rate', async () => {
    const input = new Float32Array([0, 0.1, -0.1, 0.2]);
    const output = await processAudioSamples(input, 0.5, 960, 'compress', { inputSampleRate: 22050 });

    expect(output.samples).toBeInstanceOf(Float32Array);
    expect(output.sampleRate).toBe(22050);
  });

  it('creates an Opus blob that is smaller than an equivalent WAV blob', async () => {
    const input = new Float32Array(Array.from({ length: 48000 }, (_, index) => Math.sin(index / 200) * 0.4));
    const opusBlob = await buildOpusBlob(input, 48000, { opusBitrate: 16000, opusApplication: 'Voip', opusSignal: 'Voice' });
    const wavBlob = new Blob([new Uint8Array(44 + input.length * 2)], { type: 'audio/wav' });

    expect(opusBlob.type).toContain('opus');
    expect(opusBlob.size).toBeLessThan(wavBlob.size);
  });
});
