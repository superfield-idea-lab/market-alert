/**
 * AES-256-GCM field-level encryption for PII at rest.
 *
 * Keys are HKDF-derived from a single ENCRYPTION_MASTER_KEY env var. Each
 * sensitivity class uses a disjoint key domain: the HKDF `info` parameter is
 * set to `<sensitivity-class>/<entity-type>` so keys for identity-dictionary
 * entries are cryptographically independent from operational corpus keys.
 *
 * Encrypted value format: `enc:v1:<base64-iv>:<base64-ciphertext+auth-tag>`
 *
 * Graceful degradation: ENCRYPTION_MASTER_KEY not set or ENCRYPTION_DISABLED=true
 * causes all functions to pass data through unchanged. Local development and
 * tests require no configuration.
 *
 * PRD §7 sensitive columns covered:
 *   HIGH       — corpus_chunk.body, email.body/subject, transcript.body,
 *                wiki_page.content, wiki_page_version.content, crm_note.body
 *   CRM        — customer.name
 *   INTEREST   — customer_interest.tags
 *   IDENTITY   — identity_token.real_name/real_email/real_org (disjoint key domain)
 *   CREDENTIAL — recovery_shard.shard_data (disjoint key domain; auth material)
 *   OPERATIONAL — user.display_name/email (existing)
 */

import type { EntityType } from './types';
import { kmsGenerateDataKey, _resetKmsBackend } from './kms';

// ---------------------------------------------------------------------------
// Sensitivity class — determines HKDF key domain
// ---------------------------------------------------------------------------

/**
 * Sensitivity class for PRD §7 column-level encryption.
 *
 *   HIGH        — corpus bodies, transcript text, wiki content, CRM notes
 *   CRM         — customer names and direct CRM entity fields
 *   INTEREST    — derived interest/topic tags
 *   IDENTITY    — identity-dictionary fields (disjoint key domain from ALL other classes)
 *   CREDENTIAL  — recovery shards and other auth-critical material
 *   OPERATIONAL — user-identity fields (display names, emails) in the operational DB
 */
export type SensitivityClass =
  | 'HIGH'
  | 'CRM'
  | 'INTEREST'
  | 'IDENTITY'
  | 'CREDENTIAL'
  | 'OPERATIONAL';

/**
 * Maps each entity type to its sensitivity class.
 * Entity types absent from this map have no sensitivity class (not encrypted).
 */
export const ENTITY_SENSITIVITY_CLASS: Partial<Record<EntityType, SensitivityClass>> = {
  // PRD §7 HIGH sensitivity — corpus, communication, synthesis
  corpus_chunk: 'HIGH',
  email: 'HIGH',
  transcript: 'HIGH',
  wiki_page: 'HIGH',
  wiki_page_version: 'HIGH',
  crm_note: 'HIGH',
  // CRM — customer name
  customer: 'CRM',
  // Interest tags extracted by agents
  customer_interest: 'INTEREST',
  // Identity dictionary — MUST use a key domain disjoint from all operational keys
  identity_token: 'IDENTITY',
  // Recovery shards — auth-critical, separate key domain
  recovery_shard: 'CREDENTIAL',
  // Operational — user-facing profile fields
  user: 'OPERATIONAL',
};

/** Sensitive fields registry: maps entity type to the list of properties to encrypt. */
export const SENSITIVE_FIELDS: Partial<Record<EntityType, string[]>> = {
  // PRD §7 HIGH — corpus bodies
  corpus_chunk: ['body'],
  // PRD §7 HIGH — email headers and body
  email: ['subject', 'body'],
  // PRD §7 HIGH — transcript text
  transcript: ['body'],
  // PRD §7 HIGH — wiki content (current version and historic snapshots)
  wiki_page: ['content'],
  wiki_page_version: ['content'],
  // PRD §7 HIGH — CRM notes
  crm_note: ['body'],
  // PRD §7 CRM — customer names
  customer: ['name'],
  // PRD §7 INTEREST — interest/topic tags
  customer_interest: ['tags'],
  // PRD §7 IDENTITY — all identity-dictionary fields (disjoint key domain)
  identity_token: ['real_name', 'real_email', 'real_org'],
  // PRD §7 CREDENTIAL — recovery shard payload
  recovery_shard: ['shard_data'],
  // Existing OPERATIONAL fields
  user: ['display_name', 'email'],
};

const ENC_PREFIX = 'enc:v1:';

/**
 * Cache of AES-256-GCM CryptoKey objects, keyed by entity type.
 *
 * Keys are sourced from the active KMS backend (via kmsGenerateDataKey). In
 * local dev and CI the LocalDevKmsBackend derives keys deterministically from
 * ENCRYPTION_MASTER_KEY using HKDF, which is equivalent to the previous
 * direct-HKDF approach and maintains backward compatibility with existing
 * enc:v1: ciphertext blobs.
 *
 * In staging/production the active backend (AwsKmsBackend, VaultKmsBackend)
 * generates real KMS-protected data keys.
 */
const derivedKeyCache = new Map<string, CryptoKey>();

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
 * Returns an AES-256-GCM CryptoKey for the given entity type.
 *
 * Key material is resolved through the active KMS backend so that field
 * encryption helpers only ever see key bytes via the KMS abstraction.
 *
 * The encryption context passed to the KMS backend encodes the sensitivity
 * class and entity type, enforcing key-domain separation at the KMS layer.
 *
 * Keys are cached in memory for the lifetime of the process to avoid repeated
 * KMS round-trips for the same entity type.
 */
async function getDerivedKey(entityType: string): Promise<CryptoKey> {
  const cached = derivedKeyCache.get(entityType);
  if (cached) return cached;

  const sensitivityClass = ENTITY_SENSITIVITY_CLASS[entityType as EntityType];
  const domain = sensitivityClass ? `${sensitivityClass}/${entityType}` : entityType;

  // Resolve the data key through the KMS abstraction.
  // LocalDevKmsBackend: deterministic HKDF derivation from ENCRYPTION_MASTER_KEY
  // AwsKmsBackend / VaultKmsBackend: real KMS-generated data key
  const dataKey = await kmsGenerateDataKey({ domain, purpose: 'field-enc' });

  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    dataKey.plaintextKey.buffer as ArrayBuffer,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );

  derivedKeyCache.set(entityType, cryptoKey);
  return cryptoKey;
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
 * Repository-layer guard: throws if any sensitive field in `record` for the
 * given entity type contains a plaintext value (i.e. a string that does not
 * carry the `enc:v1:` prefix) when encryption is enabled.
 *
 * Call this immediately before inserting or updating a row so that a coding
 * mistake that bypasses `encryptProperties` is caught at the write boundary
 * rather than silently storing plaintext.
 *
 * When encryption is disabled (development / test without ENCRYPTION_MASTER_KEY)
 * the guard is a no-op so that local development is not blocked.
 *
 * @throws {PlaintextWriteError} when a sensitive field carries a plaintext value.
 */
export function assertEncryptedBeforeWrite(
  entityType: string,
  record: Record<string, unknown>,
): void {
  if (!isEncryptionEnabled()) return;

  const sensitiveKeys = SENSITIVE_FIELDS[entityType as EntityType] ?? [];
  for (const key of sensitiveKeys) {
    const value = record[key];
    if (typeof value === 'string' && !value.startsWith(ENC_PREFIX)) {
      throw new PlaintextWriteError(entityType, key);
    }
  }
}

/**
 * Error thrown by `assertEncryptedBeforeWrite` when a plaintext value is
 * detected in a sensitive column at the write boundary.
 */
export class PlaintextWriteError extends Error {
  constructor(entityType: string, fieldName: string) {
    super(
      `[encryption] Refusing to write plaintext to sensitive field ` +
        `"${entityType}.${fieldName}". ` +
        `Call encryptProperties() before inserting or updating this entity.`,
    );
    this.name = 'PlaintextWriteError';
  }
}

/**
 * Resets all internal key caches. Only intended for use in tests.
 *
 * Also resets the active KMS backend to LocalDevKmsBackend so that a change
 * to ENCRYPTION_MASTER_KEY between tests is picked up correctly.
 */
export function _resetEncryptionCaches(): void {
  derivedKeyCache.clear();
  _resetKmsBackend();
}
