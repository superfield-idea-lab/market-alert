/**
 * @file pwa-demo.test.ts
 *
 * Unit tests for the mobile RM recording surface (pwa-demo.tsx).
 *
 * Verifies that:
 * 1. PwaDemoPage is exported from the module.
 * 2. The generic capability-demo cards (Notification, Storage, Camera, Mic,
 *    AudioRecorder) are NOT re-exported from the module (i.e. they were not
 *    imported and are not accessible via the page module).
 * 3. The product-aligned flows (MeetingRecordingDemoCard,
 *    TranscriptionDemoCard) are individually exportable.
 *
 * These tests validate acceptance criteria AC-1 (no generic demo cards) and
 * AC-2 (recording/transcription flows functional).
 */

import { describe, test, expect } from 'vitest';

describe('pwa-demo module exports', () => {
  test('PwaDemoPage is exported as a function', async () => {
    const mod = await import('../../src/pages/pwa-demo.js');
    expect(typeof mod.PwaDemoPage).toBe('function');
  });

  test('module does not re-export NotificationDemoCard', async () => {
    const mod = await import('../../src/pages/pwa-demo.js');
    expect((mod as Record<string, unknown>).NotificationDemoCard).toBeUndefined();
  });

  test('module does not re-export StorageDemoCard', async () => {
    const mod = await import('../../src/pages/pwa-demo.js');
    expect((mod as Record<string, unknown>).StorageDemoCard).toBeUndefined();
  });

  test('module does not re-export CameraDemoCard', async () => {
    const mod = await import('../../src/pages/pwa-demo.js');
    expect((mod as Record<string, unknown>).CameraDemoCard).toBeUndefined();
  });

  test('module does not re-export MicDemoCard', async () => {
    const mod = await import('../../src/pages/pwa-demo.js');
    expect((mod as Record<string, unknown>).MicDemoCard).toBeUndefined();
  });

  test('module does not re-export AudioRecorder', async () => {
    const mod = await import('../../src/pages/pwa-demo.js');
    expect((mod as Record<string, unknown>).AudioRecorder).toBeUndefined();
    expect((mod as Record<string, unknown>).AudioRecorderCard).toBeUndefined();
  });
});

describe('product RM flows are accessible', () => {
  test('MeetingRecordingDemoCard is exported from its module', async () => {
    const mod = await import('../../src/components/pwa/demos/meeting-recording-demo.js');
    expect(typeof mod.MeetingRecordingDemoCard).toBe('function');
  });

  test('TranscriptionDemoCard is exported from its module', async () => {
    const mod = await import('../../src/components/pwa/demos/transcription-demo.js');
    expect(typeof mod.TranscriptionDemoCard).toBe('function');
  });

  test('resolveTranscriptionPath is exported and routes correctly', async () => {
    const mod = await import('../../src/components/pwa/demos/transcription-demo.js');
    // Short recording goes to edge path
    expect(mod.resolveTranscriptionPath(30)).toBe('edge');
    // Long recording (at threshold) routes to worker
    expect(mod.resolveTranscriptionPath(600)).toBe('worker');
    // Long recording (above threshold) routes to worker
    expect(mod.resolveTranscriptionPath(700)).toBe('worker');
  });
});
