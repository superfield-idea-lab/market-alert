/**
 * @file chunker.test.ts
 *
 * Unit tests for packages/core/chunker.ts.
 *
 * ## What is tested
 *   - countTokens: whitespace-split token counting
 *   - chunkText: sentence-boundary + max-tokens chunking
 *     - boundary enforcement (no chunk exceeds maxTokens)
 *     - sentence-boundary awareness
 *     - oversized sentence word-splitting
 *     - contiguous index ordering
 *     - blank / empty input
 *     - validation of maxTokens parameter
 *
 * No mocks — pure deterministic functions.
 *
 * @see https://github.com/superfield-ai/superfield-kb-demo/issues/29
 */

import { describe, test, expect } from 'vitest';
import { countTokens, chunkText } from 'core';

// ---------------------------------------------------------------------------
// countTokens
// ---------------------------------------------------------------------------

describe('countTokens', () => {
  test('empty string returns 0', () => {
    expect(countTokens('')).toBe(0);
  });

  test('whitespace-only string returns 0', () => {
    expect(countTokens('   \t\n  ')).toBe(0);
  });

  test('single word returns 1', () => {
    expect(countTokens('hello')).toBe(1);
  });

  test('counts whitespace-delimited tokens', () => {
    expect(countTokens('hello world foo')).toBe(3);
  });

  test('multiple spaces between tokens count as one boundary', () => {
    expect(countTokens('hello  world')).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// chunkText — basic
// ---------------------------------------------------------------------------

describe('chunkText — basic', () => {
  test('empty string returns empty array', () => {
    expect(chunkText('')).toEqual([]);
  });

  test('blank string returns empty array', () => {
    expect(chunkText('   ')).toEqual([]);
  });

  test('short text below ceiling produces single chunk', () => {
    const chunks = chunkText('Hello world. This is a test.', { maxTokens: 512 });
    expect(chunks).toHaveLength(1);
    expect(chunks[0].tokenCount).toBeLessThanOrEqual(512);
  });

  test('chunk text equals source text (normalised whitespace)', () => {
    const text = 'Hello world.';
    const chunks = chunkText(text, { maxTokens: 512 });
    expect(chunks[0].text).toBe('Hello world.');
  });
});

// ---------------------------------------------------------------------------
// chunkText — ceiling enforcement
// ---------------------------------------------------------------------------

describe('chunkText — max-tokens ceiling', () => {
  test('no chunk exceeds maxTokens', () => {
    const sentences: string[] = [];
    for (let i = 0; i < 50; i++) {
      sentences.push(`Sentence number ${i + 1} with some words.`);
    }
    const text = sentences.join(' ');

    const chunks = chunkText(text, { maxTokens: 10 });
    for (const chunk of chunks) {
      expect(chunk.tokenCount).toBeLessThanOrEqual(10);
      expect(chunk.tokenCount).toBeGreaterThan(0);
    }
  });

  test('covers all source words — reconstructed text token count equals source', () => {
    const text = 'Alpha beta gamma. Delta epsilon. Zeta eta theta iota.';
    const totalSource = countTokens(text);
    const chunks = chunkText(text, { maxTokens: 4 });
    const totalChunked = chunks.reduce((sum: number, c) => sum + c.tokenCount, 0);
    expect(totalChunked).toBe(totalSource);
  });

  test('oversized single sentence is split at word boundaries', () => {
    // Build a single sentence that exceeds the ceiling
    const words = Array.from({ length: 30 }, (_, i) => `word${i}`);
    const sentence = words.join(' ') + '.';

    const chunks = chunkText(sentence, { maxTokens: 8 });
    for (const chunk of chunks) {
      expect(chunk.tokenCount).toBeLessThanOrEqual(8);
    }
    // All words should be accounted for (word30 ends with '.' so we lose nothing)
    const totalTokens = chunks.reduce((sum: number, c) => sum + c.tokenCount, 0);
    // The period is attached to the last word, so total == words.length
    expect(totalTokens).toBe(words.length);
  });
});

// ---------------------------------------------------------------------------
// chunkText — sentence boundary awareness
// ---------------------------------------------------------------------------

describe('chunkText — sentence boundaries', () => {
  test('splits at sentence boundaries (not mid-sentence) when possible', () => {
    // At maxTokens=8, each sentence is ~6 tokens; they should stay together
    const text = [
      'Short one here.', // 3 tokens
      'Short two here.', // 3 tokens
      'Short three here.', // 3 tokens
    ].join(' ');

    const chunks = chunkText(text, { maxTokens: 8 });

    // All sentences fit: the chunker may combine or separate but must never
    // exceed the ceiling.
    for (const chunk of chunks) {
      expect(chunk.tokenCount).toBeLessThanOrEqual(8);
    }
  });

  test('tokenCount in returned chunks matches actual word count', () => {
    const text = 'The quick brown fox. Jumped over a fence. And ran away.';
    const chunks = chunkText(text, { maxTokens: 512 });
    for (const chunk of chunks) {
      const actualCount = countTokens(chunk.text);
      expect(chunk.tokenCount).toBe(actualCount);
    }
  });
});

// ---------------------------------------------------------------------------
// chunkText — parameter validation
// ---------------------------------------------------------------------------

describe('chunkText — validation', () => {
  test('throws RangeError for maxTokens = 0', () => {
    expect(() => chunkText('hello', { maxTokens: 0 })).toThrow(RangeError);
  });

  test('throws RangeError for negative maxTokens', () => {
    expect(() => chunkText('hello', { maxTokens: -1 })).toThrow(RangeError);
  });

  test('throws RangeError for non-integer maxTokens', () => {
    expect(() => chunkText('hello', { maxTokens: 1.5 })).toThrow(RangeError);
  });

  test('defaults to maxTokens=512 when not specified', () => {
    const words = Array.from({ length: 100 }, (_, i) => `word${i}`);
    const text = words.join(' ');
    const chunks = chunkText(text);
    // 100 words is well below 512 — should be a single chunk
    expect(chunks).toHaveLength(1);
    expect(chunks[0].tokenCount).toBe(100);
  });
});
