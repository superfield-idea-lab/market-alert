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
      enforceStudioBranch: true,
      generateSessionIdFn: () => 'zzzz',
    });

    expect(resolution).toEqual({
      branch: 'studio/session-abc123-a1b2',
      sessionId: 'a1b2',
      needsNewBranch: false,
    });
  });

  it('creates a new studio branch when enforcement is enabled and branch is not a session', () => {
    const resolution = resolveStudioSession({
      currentBranch: 'feature/landing',
      mainHash: 'abc123',
      enforceStudioBranch: true,
      generateSessionIdFn: () => 'wxyz',
    });

    expect(resolution).toEqual({
      branch: 'studio/session-abc123-wxyz',
      sessionId: 'wxyz',
      needsNewBranch: true,
    });
  });

  it('uses the current branch when enforcement is disabled', () => {
    const resolution = resolveStudioSession({
      currentBranch: 'feature/landing',
      mainHash: 'abc123',
      enforceStudioBranch: false,
      generateSessionIdFn: () => 'lmno',
    });

    expect(resolution).toEqual({
      branch: 'feature/landing',
      sessionId: 'lmno',
      needsNewBranch: false,
    });
  });
});
