import { describe, expect, it } from 'vitest';
import { resampleAudio } from './audio';

describe('resampleAudio', () => {
  it('resamples a simple signal to the requested rate', () => {
    const input = new Float32Array([0, 0.5, 1, 0.5]);
    const output = resampleAudio(input, 4, 8);

    expect(output.length).toBeGreaterThan(input.length);
    expect(output[0]).toBe(0);
    expect(output[output.length - 1]).toBeLessThanOrEqual(1);
  });
});
