import { describe, expect, it } from 'vitest';
import {
  buildStudioBranchName,
  isValidSessionId,
  parseStudioBranchName,
  resolveStudioSession,
} from './studio-session';

describe('studio session branching', () => {
  it('builds the studio branch name with main hash and session id', () => {
    expect(buildStudioBranchName('abc123', 'a1b2')).toBe('studio/session-abc123-a1b2');
  });

  it('parses a valid studio branch name', () => {
    expect(parseStudioBranchName('studio/session-abc123-a1b2', 'abc123')).toEqual({
      sessionId: 'a1b2',
    });
  });

  it('rejects a branch with the wrong main hash', () => {
    expect(parseStudioBranchName('studio/session-deadbeef-a1b2', 'abc123')).toBeNull();
  });

  it('rejects invalid session ids', () => {
    expect(parseStudioBranchName('studio/session-abc123-a1b', 'abc123')).toBeNull();
    expect(parseStudioBranchName('studio/session-abc123-A1B2', 'abc123')).toBeNull();
  });

  it('validates session id format', () => {
    expect(isValidSessionId('a1b2')).toBe(true);
    expect(isValidSessionId('a1b')).toBe(false);
    expect(isValidSessionId('a1b2c')).toBe(false);
    expect(isValidSessionId('A1B2')).toBe(false);
  });

  it('keeps the current studio branch when enforcement is enabled', () => {
    const resolution = resolveStudioSession({
      currentBranch: 'studio/session-abc123-a1b2',
      mainHash: 'abc123',
    });

    expect(resolution).toEqual({
      branch: 'studio/session-abc123-a1b2',
      sessionId: 'a1b2',
    });
  });

  it('rejects a non-session branch', () => {
    expect(() =>
      resolveStudioSession({
        currentBranch: 'feature/landing',
        mainHash: 'abc123',
      }),
    ).toThrowError('Studio requires a branch named studio/session-abc123-<session-id>.');
  });
});
