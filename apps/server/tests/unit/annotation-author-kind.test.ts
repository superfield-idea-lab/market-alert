/**
 * @file annotation-author-kind.test.ts
 *
 * Unit tests for the author_kind enforcement helpers added in issue #68.
 *
 * Covers:
 *   - assertAuthorKind: throws MissingAuthorKindError when author_kind is absent
 *     or has an unexpected value on an agent or human message.
 *   - assertAuthorKind: passes when every message has a valid author_kind.
 *   - backfillAuthorKind: derives author_kind from role for legacy records.
 *   - backfillAuthorKind: does not overwrite an already-valid author_kind.
 *
 * No mocks — these are pure functions.
 */

import { test, expect, describe } from 'vitest';
import {
  assertAuthorKind,
  backfillAuthorKind,
  MissingAuthorKindError,
  type AnnotationMessage,
} from '../../src/api/annotations';

// ---------------------------------------------------------------------------
// assertAuthorKind
// ---------------------------------------------------------------------------

describe('assertAuthorKind()', () => {
  test('passes when all messages have valid author_kind', () => {
    const messages: AnnotationMessage[] = [
      { role: 'rm', author_kind: 'human', content: 'Hello', created_at: '2026-01-01T00:00:00Z' },
      {
        role: 'agent',
        author_kind: 'agent',
        content: 'Reply',
        created_at: '2026-01-01T00:01:00Z',
      },
    ];
    expect(() => assertAuthorKind(messages)).not.toThrow();
  });

  test('passes for an empty message array', () => {
    expect(() => assertAuthorKind([])).not.toThrow();
  });

  test('throws MissingAuthorKindError when author_kind is missing on an agent message', () => {
    const messages = [
      {
        role: 'agent' as const,
        // author_kind is absent — simulates a legacy or malformed record
        author_kind: undefined as unknown as 'agent',
        content: 'Reply',
        created_at: '2026-01-01T00:01:00Z',
      },
    ];
    expect(() => assertAuthorKind(messages)).toThrow(MissingAuthorKindError);
  });

  test('throws MissingAuthorKindError when author_kind has an unexpected value', () => {
    const messages = [
      {
        role: 'rm' as const,
        author_kind: 'unknown' as unknown as 'human',
        content: 'Hello',
        created_at: '2026-01-01T00:00:00Z',
      },
    ];
    expect(() => assertAuthorKind(messages)).toThrow(MissingAuthorKindError);
  });

  test('throws MissingAuthorKindError for the first invalid message in a mixed array', () => {
    const messages: AnnotationMessage[] = [
      {
        role: 'rm',
        author_kind: 'human',
        content: 'Hello',
        created_at: '2026-01-01T00:00:00Z',
      },
      {
        role: 'agent',
        author_kind: undefined as unknown as 'agent',
        content: 'Reply',
        created_at: '2026-01-01T00:01:00Z',
      },
    ];
    expect(() => assertAuthorKind(messages)).toThrow(MissingAuthorKindError);
  });
});

// ---------------------------------------------------------------------------
// backfillAuthorKind
// ---------------------------------------------------------------------------

describe('backfillAuthorKind()', () => {
  test('derives author_kind=human for role=rm messages without author_kind', () => {
    const messages = [
      {
        role: 'rm' as const,
        author_kind: undefined as unknown as 'human',
        content: 'Hello',
        created_at: '2026-01-01T00:00:00Z',
      },
    ];
    const result = backfillAuthorKind(messages);
    expect(result[0].author_kind).toBe('human');
  });

  test('derives author_kind=agent for role=agent messages without author_kind', () => {
    const messages = [
      {
        role: 'agent' as const,
        author_kind: undefined as unknown as 'agent',
        content: 'Reply',
        created_at: '2026-01-01T00:01:00Z',
      },
    ];
    const result = backfillAuthorKind(messages);
    expect(result[0].author_kind).toBe('agent');
  });

  test('does not overwrite an already-valid author_kind=human', () => {
    const messages: AnnotationMessage[] = [
      { role: 'rm', author_kind: 'human', content: 'Hello', created_at: '2026-01-01T00:00:00Z' },
    ];
    const result = backfillAuthorKind(messages);
    expect(result[0].author_kind).toBe('human');
  });

  test('does not overwrite an already-valid author_kind=agent', () => {
    const messages: AnnotationMessage[] = [
      {
        role: 'agent',
        author_kind: 'agent',
        content: 'Reply',
        created_at: '2026-01-01T00:01:00Z',
      },
    ];
    const result = backfillAuthorKind(messages);
    expect(result[0].author_kind).toBe('agent');
  });

  test('returns an empty array unchanged', () => {
    expect(backfillAuthorKind([])).toEqual([]);
  });

  test('backfills a mixed legacy thread correctly', () => {
    const messages = [
      {
        role: 'rm' as const,
        author_kind: undefined as unknown as 'human',
        content: 'Hello',
        created_at: '2026-01-01T00:00:00Z',
      },
      {
        role: 'agent' as const,
        author_kind: undefined as unknown as 'agent',
        content: 'Reply',
        created_at: '2026-01-01T00:01:00Z',
      },
    ];
    const result = backfillAuthorKind(messages);
    expect(result[0].author_kind).toBe('human');
    expect(result[1].author_kind).toBe('agent');
  });
});
