/**
 * AES-256-GCM field-level encryption for PII at rest.
 *
 * Keys are HKDF-derived from a single ENCRYPTION_MASTER_KEY env var, one
 * derived key per entity type (using the entity type name as HKDF `info`).
 * Derived keys are cached after first derivation.
 *
 * Encrypted value format: `enc:v1:<base64-iv>:<base64-ciphertext+auth-tag>`
 *
 * Graceful degradation: ENCRYPTION_MASTER_KEY not set or ENCRYPTION_DISABLED=true
 * causes all functions to pass data through unchanged. Local development and
 * tests require no configuration.
 */

import type { EntityType } from './types';

/** Sensitive fields registry: maps entity type to the list of properties to encrypt. */
export const SENSITIVE_FIELDS: Partial<Record<EntityType, string[]>> = {
  user: ['display_name', 'email'],
};

const ENC_PREFIX = 'enc:v1:';

/** Cache of derived CryptoKey objects, keyed by entity type. */
const derivedKeyCache = new Map<string, CryptoKey>();

/** Cached imported master key (raw bytes). */
let cachedMasterKeyMaterial: CryptoKey | null = null;

/**
 * Returns true when encryption is active.
 * Encryption is disabled if ENCRYPTION_MASTER_KEY is absent or ENCRYPTION_DISABLED=true.
 */
function isEncryptionEnabled(): boolean {
  if (process.env.ENCRYPTION_DISABLED === 'true') return false;
  if (!process.env.ENCRYPTION_MASTER_KEY) return false;
  return true;
}

/**
 * Imports the raw master key bytes as a CryptoKey suitable for HKDF derivation.
 */
async function getMasterKeyMaterial(): Promise<CryptoKey> {
  if (cachedMasterKeyMaterial) return cachedMasterKeyMaterial;

  const masterKeyHex = process.env.ENCRYPTION_MASTER_KEY!;
  // Accept hex or base64; detect by trying hex first (must be 64 hex chars = 32 bytes)
  let rawBytes: Uint8Array<ArrayBuffer>;
  if (/^[0-9a-fA-F]{64}$/.test(masterKeyHex)) {
    const pairs = masterKeyHex.match(/.{2}/g)!;
    const buf = new ArrayBuffer(pairs.length);
    rawBytes = new Uint8Array(buf);
    for (let i = 0; i < pairs.length; i++) {
      rawBytes[i] = parseInt(pairs[i], 16);
    }
  } else {
    // treat as base64
    const binaryString = atob(masterKeyHex);
    const buf = new ArrayBuffer(binaryString.length);
    rawBytes = new Uint8Array(buf);
    for (let i = 0; i < binaryString.length; i++) {
      rawBytes[i] = binaryString.charCodeAt(i);
    }
  }

  cachedMasterKeyMaterial = await crypto.subtle.importKey(
    'raw',
    rawBytes,
    { name: 'HKDF' },
    false,
    ['deriveKey'],
  );
  return cachedMasterKeyMaterial;
}

/**
 * Derives an AES-256-GCM key for the given entity type, with caching.
 */
async function getDerivedKey(entityType: string): Promise<CryptoKey> {
  const cached = derivedKeyCache.get(entityType);
  if (cached) return cached;

  const masterKey = await getMasterKeyMaterial();
  const encoder = new TextEncoder();
  const info = encoder.encode(entityType);

  const derived = await crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(32), // fixed zero salt — the info provides domain separation
      info,
    },
    masterKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );

  derivedKeyCache.set(entityType, derived);
  return derived;
}

/**
 * Encrypts a plaintext string for the given entity type.
 * Returns a ciphertext string in `enc:v1:<base64-iv>:<base64-ciphertext>` format.
 *
 * When encryption is disabled, returns plaintext unchanged.
 */
export async function encryptField(entityType: string, plaintext: string): Promise<string> {
  if (!isEncryptionEnabled()) return plaintext;

  const key = await getDerivedKey(entityType);
  // Allocate a fixed ArrayBuffer so TypeScript knows it is not a SharedArrayBuffer.
  const ivBuf = new ArrayBuffer(12);
  const iv = new Uint8Array(ivBuf);
  crypto.getRandomValues(iv); // 96-bit IV for AES-GCM
  const encoder = new TextEncoder();
  const cipherBuf = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    encoder.encode(plaintext),
  );

  const ivB64 = btoa(String.fromCharCode(...iv));
  const cipherB64 = btoa(String.fromCharCode(...new Uint8Array(cipherBuf)));
  return `${ENC_PREFIX}${ivB64}:${cipherB64}`;
}

/**
 * Decrypts a ciphertext string produced by `encryptField`.
 * Passes the value through unchanged if it does not start with `enc:v1:`.
 *
 * When encryption is disabled, returns value unchanged.
 */
export async function decryptField(entityType: string, value: string): Promise<string> {
  if (!isEncryptionEnabled()) return value;
  if (!value.startsWith(ENC_PREFIX)) return value;

  const rest = value.slice(ENC_PREFIX.length);
  const colonIdx = rest.indexOf(':');
  if (colonIdx === -1) return value; // malformed — pass through

  const ivB64 = rest.slice(0, colonIdx);
  const cipherB64 = rest.slice(colonIdx + 1);

  const iv = new Uint8Array(
    atob(ivB64)
      .split('')
      .map((c) => c.charCodeAt(0)),
  );
  const cipherBuf = new Uint8Array(
    atob(cipherB64)
      .split('')
      .map((c) => c.charCodeAt(0)),
  );

  const key = await getDerivedKey(entityType);
  const plainBuf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, cipherBuf);
  return new TextDecoder().decode(plainBuf);
}

/**
 * Encrypts all sensitive fields within a record for the given entity type.
 * Non-sensitive fields are left unchanged. Only string values are encrypted.
 *
 * When encryption is disabled, returns the record unchanged.
 */
export async function encryptProperties(
  entityType: string,
  record: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (!isEncryptionEnabled()) return record;

  const sensitiveKeys = SENSITIVE_FIELDS[entityType as EntityType] ?? [];
  if (sensitiveKeys.length === 0) return record;

  const result: Record<string, unknown> = { ...record };
  for (const key of sensitiveKeys) {
    if (key in result && typeof result[key] === 'string') {
      result[key] = await encryptField(entityType, result[key] as string);
    }
  }
  return result;
}

/**
 * Decrypts all sensitive fields within a record for the given entity type.
 * Non-sensitive fields are left unchanged. Values not matching the enc:v1:
 * prefix are passed through unchanged.
 *
 * When encryption is disabled, returns the record unchanged.
 */
export async function decryptProperties(
  entityType: string,
  record: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (!isEncryptionEnabled()) return record;

  const sensitiveKeys = SENSITIVE_FIELDS[entityType as EntityType] ?? [];
  if (sensitiveKeys.length === 0) return record;

  const result: Record<string, unknown> = { ...record };
  for (const key of sensitiveKeys) {
    if (key in result && typeof result[key] === 'string') {
      result[key] = await decryptField(entityType, result[key] as string);
    }
  }
  return result;
}

/**
 * Resets all internal key caches. Only intended for use in tests.
 */
export function _resetEncryptionCaches(): void {
  derivedKeyCache.clear();
  cachedMasterKeyMaterial = null;
}
