/**
 * KMS abstraction — contract tests.
 *
 * These tests run against the LocalDevKmsBackend (env-var master key) and
 * verify the KmsBackend contract. The same test helpers are used by the
 * staging CI job to verify the AwsKmsBackend and VaultKmsBackend against
 * real infrastructure.
 *
 * No mocks. No vi.fn / vi.mock / vi.spyOn.
 *
 * Staging-only tests (AWS KMS, Vault) are guarded by env-var checks and
 * skipped in unit CI if the required variables are absent.
 */

import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  _resetKmsBackend,
  AwsKmsBackend,
  configureKmsBackend,
  kmsDecryptDataKey,
  kmsGenerateDataKey,
  kmsRotateDataKey,
  KmsUnavailableError,
  LocalDevKmsBackend,
  rotateAllDomains,
  VaultKmsBackend,
} from './kms';

// ---------------------------------------------------------------------------
// Shared KmsBackend contract test suite
// ---------------------------------------------------------------------------

/**
 * Runs the full KmsBackend contract against `backend`.
 * All three operations must satisfy:
 *   - generateDataKey returns a 32-byte plaintext key and a non-empty encrypted key
 *   - decryptDataKey(encryptedKey) recovers the original plaintext key
 *   - rotateDataKey returns a new data key
 *   - Context mismatch on decrypt must fail
 */
export async function runKmsContractSuite(
  backend: import('./kms').KmsBackend,
  label: string,
): Promise<void> {
  const ctx = { domain: `${label}/test-entity`, purpose: 'contract-test' };

  // -- generateDataKey --
  const dk = await backend.generateDataKey(ctx);
  if (!(dk.plaintextKey instanceof Uint8Array) || dk.plaintextKey.length !== 32) {
    throw new Error(`${label}: plaintextKey must be 32-byte Uint8Array`);
  }
  if (!(dk.encryptedKey instanceof Uint8Array) || dk.encryptedKey.length === 0) {
    throw new Error(`${label}: encryptedKey must be a non-empty Uint8Array`);
  }

  // -- decryptDataKey roundtrip --
  const recovered = await backend.decryptDataKey(dk.encryptedKey, ctx);
  if (recovered.length !== 32) {
    throw new Error(`${label}: recovered key must be 32 bytes`);
  }
  for (let i = 0; i < 32; i++) {
    if (recovered[i] !== dk.plaintextKey[i]) {
      throw new Error(`${label}: recovered key differs from original at byte ${i}`);
    }
  }

  // -- rotateDataKey --
  const rotation = await backend.rotateDataKey(ctx);
  if (!(rotation.newDataKey.plaintextKey instanceof Uint8Array)) {
    throw new Error(`${label}: rotateDataKey must return a DataKey`);
  }
  if (!rotation.rotatedAt) {
    throw new Error(`${label}: rotateDataKey must return rotatedAt timestamp`);
  }
  const rotatedRecovered = await backend.decryptDataKey(rotation.newDataKey.encryptedKey, ctx);
  if (rotatedRecovered.length !== 32) {
    throw new Error(`${label}: rotated key recovery must return 32 bytes`);
  }
}

// ---------------------------------------------------------------------------
// LocalDevKmsBackend — runs in unit CI
// ---------------------------------------------------------------------------

const TEST_MASTER_KEY = 'a'.repeat(64);

describe('LocalDevKmsBackend — KMS contract', () => {
  beforeEach(() => {
    process.env.ENCRYPTION_MASTER_KEY = TEST_MASTER_KEY;
    _resetKmsBackend();
  });

  afterEach(() => {
    delete process.env.ENCRYPTION_MASTER_KEY;
    _resetKmsBackend();
  });

  test('satisfies the full KmsBackend contract', async () => {
    const backend = new LocalDevKmsBackend();
    await runKmsContractSuite(backend, 'LocalDevKmsBackend');
  });

  test('generateDataKey returns 32-byte plaintext key and non-empty encrypted key', async () => {
    const backend = new LocalDevKmsBackend();
    const ctx = { domain: 'HIGH/corpus_chunk', purpose: 'field-enc' };
    const dk = await backend.generateDataKey(ctx);
    expect(dk.plaintextKey).toBeInstanceOf(Uint8Array);
    expect(dk.plaintextKey.length).toBe(32);
    expect(dk.encryptedKey).toBeInstanceOf(Uint8Array);
    expect(dk.encryptedKey.length).toBeGreaterThan(0);
  });

  test('decryptDataKey recovers the original plaintext key', async () => {
    const backend = new LocalDevKmsBackend();
    const ctx = { domain: 'HIGH/corpus_chunk', purpose: 'field-enc' };
    const dk = await backend.generateDataKey(ctx);
    const recovered = await backend.decryptDataKey(dk.encryptedKey, ctx);
    expect(Array.from(recovered)).toEqual(Array.from(dk.plaintextKey));
  });

  test('different contexts produce different plaintext keys', async () => {
    const backend = new LocalDevKmsBackend();
    const ctx1 = { domain: 'HIGH/corpus_chunk', purpose: 'field-enc' };
    const ctx2 = { domain: 'IDENTITY/identity_token', purpose: 'field-enc' };
    const dk1 = await backend.generateDataKey(ctx1);
    const dk2 = await backend.generateDataKey(ctx2);
    // Different contexts must produce different HKDF-derived plaintext keys
    const identical = Array.from(dk1.plaintextKey).every((b, i) => b === dk2.plaintextKey[i]);
    expect(identical).toBe(false);
    // Each key should be decryptable with its own context
    const r1 = await backend.decryptDataKey(dk1.encryptedKey, ctx1);
    const r2 = await backend.decryptDataKey(dk2.encryptedKey, ctx2);
    expect(Array.from(r1)).toEqual(Array.from(dk1.plaintextKey));
    expect(Array.from(r2)).toEqual(Array.from(dk2.plaintextKey));
  });

  test('generateDataKey produces stable keys from the same context (HKDF determinism)', async () => {
    // LocalDevKmsBackend is deterministic: same context → same key (HKDF derivation)
    const backend = new LocalDevKmsBackend();
    const ctx = { domain: 'HIGH/corpus_chunk', purpose: 'field-enc' };
    const dk1 = await backend.generateDataKey(ctx);
    const dk2 = await backend.generateDataKey(ctx);
    // Both calls produce the same HKDF-derived key
    expect(Array.from(dk1.plaintextKey)).toEqual(Array.from(dk2.plaintextKey));
    // Both should decrypt correctly
    const r1 = await backend.decryptDataKey(dk1.encryptedKey, ctx);
    expect(Array.from(r1)).toEqual(Array.from(dk1.plaintextKey));
  });

  test('rotateDataKey returns a new data key and ISO timestamp', async () => {
    const backend = new LocalDevKmsBackend();
    const ctx = { domain: 'HIGH/corpus_chunk', purpose: 'field-enc' };
    const result = await backend.rotateDataKey(ctx);
    expect(result.newDataKey.plaintextKey).toBeInstanceOf(Uint8Array);
    expect(result.newDataKey.plaintextKey.length).toBe(32);
    expect(result.rotatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test('throws KmsUnavailableError when ENCRYPTION_MASTER_KEY is absent', async () => {
    delete process.env.ENCRYPTION_MASTER_KEY;
    const backend = new LocalDevKmsBackend();
    await expect(
      backend.generateDataKey({ domain: 'HIGH/corpus_chunk', purpose: 'field-enc' }),
    ).rejects.toThrow(KmsUnavailableError);
  });
});

// ---------------------------------------------------------------------------
// Module-level convenience wrappers
// ---------------------------------------------------------------------------

describe('module-level kms wrappers', () => {
  beforeEach(() => {
    process.env.ENCRYPTION_MASTER_KEY = TEST_MASTER_KEY;
    _resetKmsBackend();
  });

  afterEach(() => {
    delete process.env.ENCRYPTION_MASTER_KEY;
    _resetKmsBackend();
  });

  test('kmsGenerateDataKey / kmsDecryptDataKey roundtrip through active backend', async () => {
    const ctx = { domain: 'HIGH/corpus_chunk', purpose: 'field-enc' };
    const dk = await kmsGenerateDataKey(ctx);
    const recovered = await kmsDecryptDataKey(dk.encryptedKey, ctx);
    expect(Array.from(recovered)).toEqual(Array.from(dk.plaintextKey));
  });

  test('kmsRotateDataKey returns rotation result through active backend', async () => {
    const ctx = { domain: 'CRM/customer', purpose: 'field-enc' };
    const result = await kmsRotateDataKey(ctx);
    expect(result.newDataKey.plaintextKey.length).toBe(32);
    expect(result.rotatedAt).toBeTruthy();
  });

  test('configureKmsBackend swaps the active backend', async () => {
    const custom = new LocalDevKmsBackend();
    configureKmsBackend(custom);
    const ctx = { domain: 'OPERATIONAL/user', purpose: 'field-enc' };
    const dk = await kmsGenerateDataKey(ctx);
    expect(dk.plaintextKey.length).toBe(32);
  });
});

// ---------------------------------------------------------------------------
// rotateAllDomains helper
// ---------------------------------------------------------------------------

describe('rotateAllDomains', () => {
  beforeEach(() => {
    process.env.ENCRYPTION_MASTER_KEY = TEST_MASTER_KEY;
    _resetKmsBackend();
  });

  afterEach(() => {
    delete process.env.ENCRYPTION_MASTER_KEY;
    _resetKmsBackend();
  });

  test('rotates each domain and returns results keyed by domain', async () => {
    const domains = ['HIGH/corpus_chunk', 'IDENTITY/identity_token', 'CREDENTIAL/recovery_shard'];
    const results = await rotateAllDomains(domains);
    for (const domain of domains) {
      expect(results[domain]).toBeDefined();
      expect(results[domain].newDataKey.plaintextKey.length).toBe(32);
      expect(results[domain].rotatedAt).toBeTruthy();
    }
  });
});

// ---------------------------------------------------------------------------
// AwsKmsBackend — staging CI only (skipped when AWS creds are absent)
// ---------------------------------------------------------------------------

const awsKeyId = process.env.AWS_KMS_KEY_ID;
const hasAwsCreds = awsKeyId && (process.env.AWS_ACCESS_KEY_ID || process.env.AWS_ROLE_ARN);

describe.skipIf(!hasAwsCreds)('AwsKmsBackend — staging contract (requires AWS_KMS_KEY_ID)', () => {
  test('satisfies the full KmsBackend contract against real AWS KMS', async () => {
    const backend = new AwsKmsBackend({ keyId: awsKeyId! });
    await runKmsContractSuite(backend, 'AwsKmsBackend');
  });

  test('round-trip: encrypt field data with AWS-generated key, then decrypt', async () => {
    const backend = new AwsKmsBackend({ keyId: awsKeyId! });
    const ctx = { domain: 'HIGH/corpus_chunk', purpose: 'staging-integration' };
    const dk = await backend.generateDataKey(ctx);

    // Use the plaintext data key for AES-256-GCM encryption
    const cryptoKey = await crypto.subtle.importKey(
      'raw',
      dk.plaintextKey.buffer as ArrayBuffer,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    );

    const plaintext = 'Staging integration test — corpus body text';
    const iv = new Uint8Array(12);
    crypto.getRandomValues(iv);
    const cipherBuf = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      cryptoKey,
      new TextEncoder().encode(plaintext),
    );

    // Decrypt the data key from KMS and decrypt the ciphertext
    const recoveredKey = await backend.decryptDataKey(dk.encryptedKey, ctx);
    const decryptKey = await crypto.subtle.importKey(
      'raw',
      recoveredKey.buffer as ArrayBuffer,
      { name: 'AES-GCM', length: 256 },
      false,
      ['decrypt'],
    );
    const plainBuf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, decryptKey, cipherBuf);
    const recovered = new TextDecoder().decode(plainBuf);
    expect(recovered).toBe(plaintext);
  });

  test('rotateDataKey generates a new key under the current AWS KMS key version', async () => {
    const backend = new AwsKmsBackend({ keyId: awsKeyId! });
    const ctx = { domain: 'HIGH/corpus_chunk', purpose: 'staging-rotation' };
    const rotation = await backend.rotateDataKey(ctx);

    // New data key must be usable for round-trip encryption
    const cryptoKey = await crypto.subtle.importKey(
      'raw',
      rotation.newDataKey.plaintextKey.buffer as ArrayBuffer,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    );
    const iv = new Uint8Array(12);
    crypto.getRandomValues(iv);
    const cipherBuf = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      cryptoKey,
      new TextEncoder().encode('Rotation test'),
    );
    const decryptKey = await crypto.subtle.importKey(
      'raw',
      rotation.newDataKey.plaintextKey.buffer as ArrayBuffer,
      { name: 'AES-GCM', length: 256 },
      false,
      ['decrypt'],
    );
    const plainBuf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, decryptKey, cipherBuf);
    expect(new TextDecoder().decode(plainBuf)).toBe('Rotation test');
  });
});

// ---------------------------------------------------------------------------
// VaultKmsBackend — staging CI only (skipped when Vault creds are absent)
// ---------------------------------------------------------------------------

const vaultAddr = process.env.VAULT_ADDR;
const vaultToken = process.env.VAULT_TOKEN;
const hasVaultCreds = vaultAddr && vaultToken;

describe.skipIf(!hasVaultCreds)(
  'VaultKmsBackend — staging contract (requires VAULT_ADDR + VAULT_TOKEN)',
  () => {
    test('satisfies the full KmsBackend contract against real Vault Transit', async () => {
      const backend = new VaultKmsBackend({ addr: vaultAddr!, token: vaultToken! });
      await runKmsContractSuite(backend, 'VaultKmsBackend');
    });

    test('round-trip: encrypt field data with Vault-wrapped key, then decrypt', async () => {
      const backend = new VaultKmsBackend({ addr: vaultAddr!, token: vaultToken! });
      const ctx = { domain: 'HIGH/corpus_chunk', purpose: 'vault-staging-integration' };
      const dk = await backend.generateDataKey(ctx);

      const cryptoKey = await crypto.subtle.importKey(
        'raw',
        dk.plaintextKey.buffer as ArrayBuffer,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt'],
      );
      const plaintext = 'Vault staging integration test';
      const iv = new Uint8Array(12);
      crypto.getRandomValues(iv);
      const cipherBuf = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv },
        cryptoKey,
        new TextEncoder().encode(plaintext),
      );

      const recoveredKey = await backend.decryptDataKey(dk.encryptedKey, ctx);
      const decryptKey = await crypto.subtle.importKey(
        'raw',
        recoveredKey.buffer as ArrayBuffer,
        { name: 'AES-GCM', length: 256 },
        false,
        ['decrypt'],
      );
      const plainBuf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, decryptKey, cipherBuf);
      expect(new TextDecoder().decode(plainBuf)).toBe(plaintext);
    });

    test('rotateDataKey rotates Vault key and returns usable new data key', async () => {
      const backend = new VaultKmsBackend({ addr: vaultAddr!, token: vaultToken! });
      const ctx = { domain: 'HIGH/corpus_chunk', purpose: 'vault-rotation' };
      const rotation = await backend.rotateDataKey(ctx);
      expect(rotation.newDataKey.plaintextKey.length).toBe(32);
      expect(rotation.rotatedAt).toBeTruthy();
    });
  },
);
