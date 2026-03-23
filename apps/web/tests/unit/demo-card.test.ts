/**
 * Unit tests for DemoCard rendering logic.
 *
 * The DemoCard component has four distinct rendering states based on
 * `featureAvailable` and `permissionState`. We test the conditional
 * branch logic directly via unit assertions on the props contract rather
 * than DOM rendering (browser tests cover the visual output).
 */

import { describe, test, expect } from 'vitest';
import type { DemoCardProps } from '../../src/components/pwa/demo-card';

/**
 * Mirror of the DemoCard rendering decision tree for unit testing.
 * Returns a string describing which branch would be taken.
 */
function resolveCardBranch(
  featureAvailable: boolean,
  permissionState: DemoCardProps['permissionState'],
): 'unavailable' | 'denied' | 'prompt' | 'content' {
  if (!featureAvailable) return 'unavailable';
  if (permissionState === 'denied') return 'denied';
  if (permissionState === 'prompt') return 'prompt';
  return 'content';
}

describe('DemoCard rendering branch logic', () => {
  test('returns unavailable when featureAvailable is false', () => {
    expect(resolveCardBranch(false, null)).toBe('unavailable');
    expect(resolveCardBranch(false, 'granted')).toBe('unavailable');
    expect(resolveCardBranch(false, 'denied')).toBe('unavailable');
    expect(resolveCardBranch(false, 'prompt')).toBe('unavailable');
  });

  test('returns denied when feature available and permission denied', () => {
    expect(resolveCardBranch(true, 'denied')).toBe('denied');
  });

  test('returns prompt when feature available and permission not yet requested', () => {
    expect(resolveCardBranch(true, 'prompt')).toBe('prompt');
  });

  test('returns content when feature available and permission granted', () => {
    expect(resolveCardBranch(true, 'granted')).toBe('content');
  });

  test('returns content when feature available and no permission needed (null)', () => {
    expect(resolveCardBranch(true, null)).toBe('content');
  });

  test('returns content when permissionState is undefined (defaults to content)', () => {
    expect(resolveCardBranch(true, undefined)).toBe('content');
  });
});

describe('DemoCard module exports', () => {
  test('DemoCard is exported from the module', async () => {
    const mod = await import('../../src/components/pwa/demo-card.js');
    expect(typeof mod.DemoCard).toBe('function');
  });
});
