import { describe, expect, it } from 'vitest';
import { parseDockerPortOutput } from './pg-container';

describe('parseDockerPortOutput', () => {
  it('parses a single-line docker port output', () => {
    expect(parseDockerPortOutput('0.0.0.0:54321')).toBe(54321);
  });

  it('parses the first line when multiple bindings exist', () => {
    expect(parseDockerPortOutput('0.0.0.0:54321\n[::]:54321')).toBe(54321);
  });

  it('throws when output is empty', () => {
    expect(() => parseDockerPortOutput('')).toThrow(/docker port output/i);
  });

  it('throws when the port cannot be parsed', () => {
    expect(() => parseDockerPortOutput('0.0.0.0:abc')).toThrow(/docker port output/i);
  });
});
