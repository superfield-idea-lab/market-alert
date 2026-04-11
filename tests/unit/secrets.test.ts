/**
 * @file secrets.test.ts
 *
 * Unit tests for the secrets abstraction layer (packages/core/secrets.ts).
 *
 * ## What is tested
 *
 * 1. Dev env shim resolves secrets from a real process.env (or an injected env
 *    record) without direct access in callers.
 * 2. A fake backend can replace the dev shim without any caller changes —
 *    demonstrating the backend-swap invariant that makes Phase 1 KMS
 *    integration possible.
 * 3. `getSecret` throws on absent secrets; `getSecretOrNull` returns null.
 * 4. `configureSecretsBackend` replaces the active backend; `_resetSecretsBackend`
 *    restores the default shim.
 *
 * ## No mocks
 *
 * All tests use real in-process state: the `EnvSecretsShim` constructor
 * accepts an injected env record so tests never reach `process.env` directly.
 * The "fake backend" is a real implementation of `SecretsBackend` — not a
 * spy or stub.
 *
 * Canonical doc: docs/implementation-plan-v1.md Phase 0
 * Blueprint ref: calypso-blueprint/rules/blueprints/test.yaml
 */

import { afterEach, beforeEach, describe, test, expect } from 'vitest';
import {
  EnvSecretsShim,
  configureSecretsBackend,
  getSecret,
  getSecretOrNull,
  _resetSecretsBackend,
  type SecretName,
  type SecretsBackend,
} from '../../packages/core/secrets';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * A minimal in-memory backend — a real `SecretsBackend` implementation, not a
 * mock. Used to verify that swapping the backend requires no caller changes.
 */
class MapSecretsBackend implements SecretsBackend {
  private readonly store: Map<string, string>;

  constructor(entries: Record<string, string> = {}) {
    this.store = new Map(Object.entries(entries));
  }

  async resolve(name: SecretName): Promise<string> {
    const value = this.store.get(name);
    if (value === undefined) {
      throw new Error(`MapSecretsBackend: secret "${name}" not found`);
    }
    return value;
  }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

afterEach(() => {
  // Restore the default dev shim between tests so state does not bleed.
  _resetSecretsBackend();
});

// ---------------------------------------------------------------------------
// EnvSecretsShim — direct tests
// ---------------------------------------------------------------------------

describe('EnvSecretsShim', () => {
  test('resolves a secret from an injected env record', async () => {
    const shim = new EnvSecretsShim({ ENCRYPTION_MASTER_KEY: 'a'.repeat(64) });
    const value = await shim.resolve('ENCRYPTION_MASTER_KEY');
    expect(value).toBe('a'.repeat(64));
  });

  test('throws when the secret is absent', async () => {
    const shim = new EnvSecretsShim({});
    await expect(shim.resolve('ENCRYPTION_MASTER_KEY')).rejects.toThrow(/ENCRYPTION_MASTER_KEY/);
  });

  test('throws when the secret is an empty string', async () => {
    const shim = new EnvSecretsShim({ SUBSTACK_API_KEY: '' });
    await expect(shim.resolve('SUBSTACK_API_KEY')).rejects.toThrow(/SUBSTACK_API_KEY/);
  });

  test('resolves a secret from the real process.env (via default constructor)', async () => {
    const original = process.env.SUBSTACK_API_KEY;
    process.env.SUBSTACK_API_KEY = 'test-key-from-process-env';
    try {
      // Default constructor reads process.env — this is the shim's intended use.
      const shim = new EnvSecretsShim();
      const value = await shim.resolve('SUBSTACK_API_KEY');
      expect(value).toBe('test-key-from-process-env');
    } finally {
      if (original === undefined) {
        delete process.env.SUBSTACK_API_KEY;
      } else {
        process.env.SUBSTACK_API_KEY = original;
      }
    }
  });
});

// ---------------------------------------------------------------------------
// getSecret — module-level API backed by the default dev shim
// ---------------------------------------------------------------------------

describe('getSecret (dev shim)', () => {
  beforeEach(() => {
    // Wire a shim with a controlled env record so the test is hermetic.
    configureSecretsBackend(new EnvSecretsShim({ JWT_EC_PRIVATE_KEY: 'fake-ec-key' }));
  });

  test('resolves a known secret', async () => {
    const value = await getSecret('JWT_EC_PRIVATE_KEY');
    expect(value).toBe('fake-ec-key');
  });

  test('throws on absent secret', async () => {
    // No BLOOMBERG_API_KEY in the injected env.
    await expect(getSecret('BLOOMBERG_API_KEY')).rejects.toThrow(/BLOOMBERG_API_KEY/);
  });
});

// ---------------------------------------------------------------------------
// getSecretOrNull — returns null on absence
// ---------------------------------------------------------------------------

describe('getSecretOrNull (dev shim)', () => {
  beforeEach(() => {
    configureSecretsBackend(new EnvSecretsShim({ YAHOO_API_KEY: 'yahoo-123' }));
  });

  test('returns the value when present', async () => {
    const value = await getSecretOrNull('YAHOO_API_KEY');
    expect(value).toBe('yahoo-123');
  });

  test('returns null when absent', async () => {
    const value = await getSecretOrNull('SUBSTACK_API_KEY');
    expect(value).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Backend swap — callers unchanged when backend is replaced
// ---------------------------------------------------------------------------

describe('backend swap (SecretsBackend invariant)', () => {
  test('replacing the backend with MapSecretsBackend requires no caller changes', async () => {
    // Install a fake backend — a real SecretsBackend implementation.
    const fakeBackend = new MapSecretsBackend({
      ENCRYPTION_MASTER_KEY: 'kms-backed-key',
      JWT_EC_PRIVATE_KEY: 'kms-backed-ec-key',
    });
    configureSecretsBackend(fakeBackend);

    // Callers use the same getSecret / getSecretOrNull API — no changes needed.
    expect(await getSecret('ENCRYPTION_MASTER_KEY')).toBe('kms-backed-key');
    expect(await getSecret('JWT_EC_PRIVATE_KEY')).toBe('kms-backed-ec-key');
    expect(await getSecretOrNull('SUBSTACK_API_KEY')).toBeNull();
  });

  test('_resetSecretsBackend restores the default env shim', async () => {
    configureSecretsBackend(new MapSecretsBackend({ SUBSTACK_API_KEY: 'map-value' }));
    // Confirm the fake backend is active.
    expect(await getSecret('SUBSTACK_API_KEY')).toBe('map-value');

    // Reset to the dev shim.
    _resetSecretsBackend();

    // The dev shim now reads from process.env. Since SUBSTACK_API_KEY is not
    // set in the test environment, it should throw.
    const original = process.env.SUBSTACK_API_KEY;
    delete process.env.SUBSTACK_API_KEY;
    try {
      await expect(getSecret('SUBSTACK_API_KEY')).rejects.toThrow(/SUBSTACK_API_KEY/);
    } finally {
      if (original !== undefined) process.env.SUBSTACK_API_KEY = original;
    }
  });
});
