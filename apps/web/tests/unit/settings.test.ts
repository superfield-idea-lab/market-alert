/**
 * Unit tests for the settings page module.
 *
 * Verifies that:
 * - SettingsPage is exported from the module
 * - The module compiles without error
 *
 * The integration behaviour (Install row absent in standalone, present
 * otherwise) is verified via the integration test plan item which requires a
 * full browser environment.
 */

import { describe, test, expect } from 'vitest';

describe('SettingsPage module exports', () => {
  test('SettingsPage is exported from the module', async () => {
    const mod = await import('../../src/pages/settings.js');
    expect(typeof mod.SettingsPage).toBe('function');
  });
});
