/**
 * KMS abstraction — Phase 1 security foundation.
 *
 * Field-encryption helpers (encryptField / decryptField in encryption.ts) only
 * ever see data keys through this abstraction. The underlying key-management
 * backend is swappable at startup without changing any call site.
 *
 * ## Envelope encryption model
 *
 * 1. A data key (DEK) is generated or fetched from the KMS for each sensitivity
 *    class / entity-type domain.
 * 2. The DEK is used locally for AES-256-GCM field encryption.
 * 3. The DEK is stored encrypted-under-the-KMS-master-key (the "encrypted DEK").
 * 4. On decrypt, the encrypted DEK is sent to KMS to recover the plaintext DEK.
 *
 * Key material NEVER leaves the KMS boundary in plaintext for the AWS and Vault
 * backends. The local-dev backend derives keys from an env-var master key and is
 * suitable for development and CI only.
 *
 * ## Backend implementations
 *
 * | Backend          | Use case                          |
 * | ---------------- | --------------------------------- |
 * | LocalDevKmsBackend | Local dev / CI (env-var master) |
 * | AwsKmsBackend    | Staging / production (AWS KMS)    |
 * | VaultKmsBackend  | On-prem / Vault Transit fallback  |
 *
 * ## Usage
 *
 * ```ts
 * import { configureKmsBackend, AwsKmsBackend } from 'core/kms';
 * configureKmsBackend(new AwsKmsBackend({ keyId: process.env.AWS_KMS_KEY_ID! }));
 * ```
 *
 * Canonical doc: docs/implementation-plan-v1.md Phase 1 — Security foundation
 */

// ---------------------------------------------------------------------------
// Core types
// ---------------------------------------------------------------------------

/**
 * A data key (DEK) ready for local AES-256-GCM use.
 *
 * `plaintextKey` is a 32-byte Uint8Array for use with the WebCrypto API.
 * `encryptedKey` is the KMS-ciphertext blob that can be stored alongside
 * the encrypted data and passed back to `decryptDataKey` to recover the DEK.
 */
export interface DataKey {
  /** 32-byte plaintext data key — use for AES-256-GCM, then discard. */
  plaintextKey: Uint8Array;
  /**
   * KMS-encrypted form of the data key.
   *
   * Store this alongside the encrypted data. Pass it to `decryptDataKey` to
   * recover the plaintext DEK on a subsequent read.
   */
  encryptedKey: Uint8Array;
}

/**
 * Result of a key rotation operation.
 */
export interface RotationResult {
  /**
   * The new data key that was generated.
   * Use the `plaintextKey` to re-encrypt the data, then store `encryptedKey`.
   */
  newDataKey: DataKey;
  /**
   * Timestamp (ISO-8601) at which the rotation was performed.
   */
  rotatedAt: string;
}

// ---------------------------------------------------------------------------
// KmsBackend interface
// ---------------------------------------------------------------------------

/**
 * KMS backend contract.
 *
 * All three operations communicate with a key-management service that holds the
 * root key material. The `encryptionContext` map is included in AWS KMS / Vault
 * policy evaluations and cryptographic integrity checks — always pass the same
 * context for a given domain.
 */
export interface KmsBackend {
  /**
   * Generates a new AES-256 data key protected by the KMS master key.
   *
   * The returned `plaintextKey` should be used for exactly one encryption
   * operation and then discarded. The `encryptedKey` is stored with the data.
   *
   * @param encryptionContext - Arbitrary key/value metadata that is bound to
   *   this data key (e.g. `{ domain: 'HIGH/corpus_chunk', purpose: 'field-enc' }`).
   *   Must be identical when calling `decryptDataKey`.
   */
  generateDataKey(encryptionContext: Record<string, string>): Promise<DataKey>;

  /**
   * Decrypts an encrypted data key previously returned by `generateDataKey`.
   *
   * @param encryptedKey  - The `encryptedKey` blob from `DataKey`.
   * @param encryptionContext - Must match the context used during generation.
   * @returns The 32-byte plaintext data key.
   */
  decryptDataKey(
    encryptedKey: Uint8Array,
    encryptionContext: Record<string, string>,
  ): Promise<Uint8Array>;

  /**
   * Performs a KMS-level key rotation and returns a new data key.
   *
   * For AWS KMS this may trigger `GenerateDataKey` on the new key version.
   * For Vault Transit this calls the `rotate` endpoint before generating.
   * For the local dev backend this generates a fresh key from the current master.
   *
   * @param encryptionContext - Context for the new data key.
   */
  rotateDataKey(encryptionContext: Record<string, string>): Promise<RotationResult>;
}

// ---------------------------------------------------------------------------
// LocalDevKmsBackend — derives keys from ENCRYPTION_MASTER_KEY env var
// ---------------------------------------------------------------------------

/**
 * Local-dev and CI KMS backend.
 *
 * Derives AES-256 data keys from a master key in `process.env.ENCRYPTION_MASTER_KEY`
 * using HKDF-SHA-256. The "encrypted key" format is a no-op round-trip: the
 * encrypted key bytes ARE the context-deterministic derived key (re-derivation
 * on decrypt). This means no actual wrapping occurs — suitable ONLY for
 * development and tests.
 *
 * When `ENCRYPTION_MASTER_KEY` is absent, `generateDataKey` throws a
 * `KmsUnavailableError` so misconfiguration is visible at startup.
 */
export class LocalDevKmsBackend implements KmsBackend {
  private masterKey: CryptoKey | null = null;

  private async getMasterKey(): Promise<CryptoKey> {
    if (this.masterKey) return this.masterKey;

    const hex = process.env.ENCRYPTION_MASTER_KEY;
    if (!hex) {
      throw new KmsUnavailableError('LocalDevKmsBackend requires ENCRYPTION_MASTER_KEY to be set');
    }

    let rawBytes: Uint8Array<ArrayBuffer>;
    if (/^[0-9a-fA-F]{64}$/.test(hex)) {
      const pairs = hex.match(/.{2}/g)!;
      const buf = new ArrayBuffer(pairs.length);
      rawBytes = new Uint8Array(buf);
      for (let i = 0; i < pairs.length; i++) {
        rawBytes[i] = parseInt(pairs[i], 16);
      }
    } else {
      // treat as base64
      const binaryString = atob(hex);
      const buf = new ArrayBuffer(binaryString.length);
      rawBytes = new Uint8Array(buf);
      for (let i = 0; i < binaryString.length; i++) {
        rawBytes[i] = binaryString.charCodeAt(i);
      }
    }

    this.masterKey = await crypto.subtle.importKey('raw', rawBytes, { name: 'HKDF' }, false, [
      'deriveKey',
      'deriveBits',
    ]);
    return this.masterKey;
  }

  private async deriveKeyBytes(encryptionContext: Record<string, string>): Promise<Uint8Array> {
    const master = await this.getMasterKey();
    const encoder = new TextEncoder();
    // Build a canonical info string from sorted context entries
    const infoStr = Object.entries(encryptionContext)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join(';');
    const info = encoder.encode(infoStr);

    const bits = await crypto.subtle.deriveBits(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: new Uint8Array(new ArrayBuffer(32)),
        info,
      },
      master,
      256,
    );
    return new Uint8Array(bits as ArrayBuffer);
  }

  async generateDataKey(encryptionContext: Record<string, string>): Promise<DataKey> {
    // For local dev: use HKDF to derive a deterministic plaintext key from the context.
    // The "encrypted key" is the context string (UTF-8 bytes) — decryptDataKey re-derives
    // the same HKDF key from the stored context, so no actual wrapping is needed.
    // This is NOT production-secure — it is a local-dev convenience that maintains
    // backward compatibility with the enc:v1: ciphertext format.
    const plaintextKey = await this.deriveKeyBytes(encryptionContext);

    // Store the canonical context string as the "encrypted key" so decryptDataKey
    // can re-derive the same key without network calls.
    const encoder = new TextEncoder();
    const infoStr = Object.entries(encryptionContext)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join(';');
    const encryptedKey = encoder.encode(infoStr);

    return { plaintextKey, encryptedKey };
  }

  async decryptDataKey(
    encryptedKey: Uint8Array,
    encryptionContext: Record<string, string>,
  ): Promise<Uint8Array> {
    // Re-derive the same HKDF key from the encryption context.
    // The encryptedKey bytes are not used — the key is deterministically derived.
    // This is intentionally context-only derivation for local dev / CI.
    return this.deriveKeyBytes(encryptionContext);
  }

  async rotateDataKey(encryptionContext: Record<string, string>): Promise<RotationResult> {
    // Invalidate cached master key so a fresh ENCRYPTION_MASTER_KEY would be picked up
    this.masterKey = null;
    const newDataKey = await this.generateDataKey(encryptionContext);
    return { newDataKey, rotatedAt: new Date().toISOString() };
  }
}

// ---------------------------------------------------------------------------
// AwsKmsBackend — AWS KMS GenerateDataKey / Decrypt
// ---------------------------------------------------------------------------

export interface AwsKmsBackendOptions {
  /**
   * The full ARN or alias of the AWS KMS customer-managed key.
   * Example: `arn:aws:kms:us-east-1:123456789012:key/mrk-abc123`
   */
  keyId: string;
  /** AWS region. Defaults to `AWS_REGION` env var or `us-east-1`. */
  region?: string;
  /**
   * AWS credentials. When omitted the backend resolves them from the standard
   * credential chain: env vars → EC2/ECS/EKS instance metadata.
   */
  credentials?: {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken?: string;
  };
}

/**
 * AWS KMS backend for staging and production environments.
 *
 * Uses the AWS KMS `GenerateDataKey` and `Decrypt` APIs via HTTPS (no SDK
 * dependency — authentication uses AWS Signature Version 4 over native fetch).
 *
 * Key rotation delegates to `GenerateDataKey` on the current KMS key version;
 * AWS KMS automatic key rotation (annual, managed by AWS) handles the actual
 * cryptographic rotation. For immediate rotation, use the AWS Console or CLI
 * to manually rotate the key, then call `rotateDataKey` to generate a new DEK
 * under the new key material.
 */
export class AwsKmsBackend implements KmsBackend {
  private readonly keyId: string;
  private readonly region: string;
  private credentials: AwsKmsBackendOptions['credentials'] | null;

  constructor(opts: AwsKmsBackendOptions) {
    this.keyId = opts.keyId;
    this.region = opts.region ?? process.env.AWS_REGION ?? 'us-east-1';
    this.credentials = opts.credentials ?? null;
  }

  // ---------------------------------------------------------------------------
  // Credential resolution
  // ---------------------------------------------------------------------------

  private async resolveCredentials(): Promise<{
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken?: string;
  }> {
    if (this.credentials) return this.credentials;

    // Try environment variables first
    const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
    const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
    if (accessKeyId && secretAccessKey) {
      return {
        accessKeyId,
        secretAccessKey,
        sessionToken: process.env.AWS_SESSION_TOKEN,
      };
    }

    // Fall back to EC2/ECS/EKS instance metadata (IMDS v2)
    try {
      // Step 1: get IMDSv2 token
      const tokenRes = await fetch('http://169.254.169.254/latest/api/token', {
        method: 'PUT',
        headers: { 'X-aws-ec2-metadata-token-ttl-seconds': '60' },
      });
      if (!tokenRes.ok) throw new Error('IMDS token request failed');
      const imdsToken = await tokenRes.text();

      // Step 2: get security credentials
      const roleRes = await fetch(
        'http://169.254.169.254/latest/meta-data/iam/security-credentials/',
        { headers: { 'X-aws-ec2-metadata-token': imdsToken } },
      );
      if (!roleRes.ok) throw new Error('IMDS role list failed');
      const roleName = (await roleRes.text()).trim().split('\n')[0];

      const credRes = await fetch(
        `http://169.254.169.254/latest/meta-data/iam/security-credentials/${roleName}`,
        { headers: { 'X-aws-ec2-metadata-token': imdsToken } },
      );
      if (!credRes.ok) throw new Error('IMDS credentials fetch failed');
      const creds = (await credRes.json()) as {
        AccessKeyId: string;
        SecretAccessKey: string;
        Token: string;
      };
      return {
        accessKeyId: creds.AccessKeyId,
        secretAccessKey: creds.SecretAccessKey,
        sessionToken: creds.Token,
      };
    } catch (err) {
      throw new KmsUnavailableError(
        `AwsKmsBackend: could not resolve AWS credentials from env or IMDS: ${(err as Error).message}`,
      );
    }
  }

  // ---------------------------------------------------------------------------
  // AWS Signature Version 4 helpers
  // ---------------------------------------------------------------------------

  private async sign(
    method: string,
    path: string,
    body: string,
    amzTarget: string,
  ): Promise<{ url: string; headers: Record<string, string> }> {
    const creds = await this.resolveCredentials();
    const service = 'kms';
    const host = `kms.${this.region}.amazonaws.com`;
    const url = `https://${host}${path}`;

    const now = new Date();
    const amzDate = now.toISOString().replace(/[-:.]/g, '').slice(0, 15) + 'Z';
    const dateStamp = amzDate.slice(0, 8);

    const encoder = new TextEncoder();
    const bodyBytes = encoder.encode(body);

    // Payload hash
    const payloadHashBuf = await crypto.subtle.digest('SHA-256', bodyBytes);
    const payloadHash = Array.from(new Uint8Array(payloadHashBuf))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');

    const headers: Record<string, string> = {
      host,
      'x-amz-date': amzDate,
      'x-amz-target': amzTarget,
      'content-type': 'application/x-amz-json-1.1',
      'content-length': String(bodyBytes.length),
      'x-amz-content-sha256': payloadHash,
    };
    if (creds.sessionToken) {
      headers['x-amz-security-token'] = creds.sessionToken;
    }

    const signedHeaders = Object.keys(headers).sort().join(';');
    const canonicalHeaders = Object.keys(headers)
      .sort()
      .map((k) => `${k}:${headers[k]}\n`)
      .join('');

    const canonicalRequest = [
      method,
      path,
      '', // query string
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join('\n');

    const credentialScope = `${dateStamp}/${this.region}/${service}/aws4_request`;
    const canonicalRequestHash = Array.from(
      new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(canonicalRequest))),
    )
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');

    const stringToSign = ['AWS4-HMAC-SHA256', amzDate, credentialScope, canonicalRequestHash].join(
      '\n',
    );

    // Derive signing key
    const hmac = async (key: ArrayBuffer | Uint8Array, data: string) => {
      const cryptoKey = await crypto.subtle.importKey(
        'raw',
        key instanceof Uint8Array ? (key.buffer as ArrayBuffer) : key,
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign'],
      );
      return crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(data));
    };

    const kDate = await hmac(encoder.encode(`AWS4${creds.secretAccessKey}`), dateStamp);
    const kRegion = await hmac(kDate, this.region);
    const kService = await hmac(kRegion, service);
    const kSigning = await hmac(kService, 'aws4_request');
    const signature = Array.from(new Uint8Array(await hmac(kSigning, stringToSign)))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');

    const authHeader =
      `AWS4-HMAC-SHA256 Credential=${creds.accessKeyId}/${credentialScope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`;

    const outHeaders: Record<string, string> = {
      ...headers,
      Authorization: authHeader,
    };
    delete outHeaders.host; // fetch adds Host automatically

    return { url, headers: outHeaders };
  }

  // ---------------------------------------------------------------------------
  // KmsBackend implementation
  // ---------------------------------------------------------------------------

  async generateDataKey(encryptionContext: Record<string, string>): Promise<DataKey> {
    const body = JSON.stringify({
      KeyId: this.keyId,
      KeySpec: 'AES_256',
      EncryptionContext: encryptionContext,
    });

    const { url, headers } = await this.sign('POST', '/', body, 'TrentService.GenerateDataKey');

    const res = await fetch(url, { method: 'POST', headers, body });
    if (!res.ok) {
      const text = await res.text();
      throw new KmsOperationError(`GenerateDataKey failed (HTTP ${res.status}): ${text}`);
    }

    const json = (await res.json()) as { Plaintext: string; CiphertextBlob: string };
    return {
      plaintextKey: base64ToUint8Array(json.Plaintext),
      encryptedKey: base64ToUint8Array(json.CiphertextBlob),
    };
  }

  async decryptDataKey(
    encryptedKey: Uint8Array,
    encryptionContext: Record<string, string>,
  ): Promise<Uint8Array> {
    const body = JSON.stringify({
      CiphertextBlob: uint8ArrayToBase64(encryptedKey),
      EncryptionContext: encryptionContext,
      KeyId: this.keyId,
    });

    const { url, headers } = await this.sign('POST', '/', body, 'TrentService.Decrypt');

    const res = await fetch(url, { method: 'POST', headers, body });
    if (!res.ok) {
      const text = await res.text();
      throw new KmsOperationError(`Decrypt failed (HTTP ${res.status}): ${text}`);
    }

    const json = (await res.json()) as { Plaintext: string };
    return base64ToUint8Array(json.Plaintext);
  }

  async rotateDataKey(encryptionContext: Record<string, string>): Promise<RotationResult> {
    // Generate a new data key under the current (or newly rotated) KMS key version
    const newDataKey = await this.generateDataKey(encryptionContext);
    return { newDataKey, rotatedAt: new Date().toISOString() };
  }
}

// ---------------------------------------------------------------------------
// VaultKmsBackend — HashiCorp Vault Transit secrets engine
// ---------------------------------------------------------------------------

export interface VaultKmsBackendOptions {
  /** Vault address, e.g. https://vault.internal:8200 */
  addr: string;
  /** Vault token for authentication */
  token: string;
  /**
   * Name of the Transit encryption key in Vault.
   * Defaults to `superfield-field-enc`.
   */
  keyName?: string;
  /** Transit secrets engine mount path. Defaults to `transit`. */
  mount?: string;
}

/**
 * HashiCorp Vault Transit backend.
 *
 * Uses the Vault Transit `encrypt` and `decrypt` endpoints to wrap/unwrap data
 * keys. The data key is generated locally using WebCrypto and then wrapped
 * (encrypted) using Vault Transit — Vault never sees plaintext data.
 *
 * Key rotation calls Vault's `rotate` endpoint to create a new key version in
 * Vault, then wraps a fresh data key under the new version.
 */
export class VaultKmsBackend implements KmsBackend {
  private readonly addr: string;
  private readonly token: string;
  private readonly keyName: string;
  private readonly mount: string;

  constructor(opts: VaultKmsBackendOptions) {
    this.addr = opts.addr.replace(/\/$/, '');
    this.token = opts.token;
    this.keyName = opts.keyName ?? 'superfield-field-enc';
    this.mount = opts.mount ?? 'transit';
  }

  private baseUrl(): string {
    return `${this.addr}/v1/${this.mount}`;
  }

  private authHeaders(): Record<string, string> {
    return {
      'X-Vault-Token': this.token,
      'Content-Type': 'application/json',
    };
  }

  async generateDataKey(encryptionContext: Record<string, string>): Promise<DataKey> {
    // Generate a random 256-bit data key locally
    const plaintextKey = new Uint8Array(32);
    crypto.getRandomValues(plaintextKey);

    // Wrap the data key using Vault Transit encrypt
    const plaintext = uint8ArrayToBase64(plaintextKey);
    const contextStr = uint8ArrayToBase64(
      new TextEncoder().encode(JSON.stringify(encryptionContext)),
    );

    const res = await fetch(`${this.baseUrl()}/encrypt/${this.keyName}`, {
      method: 'POST',
      headers: this.authHeaders(),
      body: JSON.stringify({ plaintext, context: contextStr }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new KmsOperationError(`Vault encrypt failed (HTTP ${res.status}): ${text}`);
    }

    const json = (await res.json()) as { data?: { ciphertext?: string } };
    const ciphertext = json.data?.ciphertext;
    if (!ciphertext) {
      throw new KmsOperationError('Vault encrypt response missing data.ciphertext');
    }

    // Store the Vault ciphertext string as UTF-8 bytes in encryptedKey
    const encryptedKey = new TextEncoder().encode(ciphertext);
    return { plaintextKey, encryptedKey };
  }

  async decryptDataKey(
    encryptedKey: Uint8Array,
    encryptionContext: Record<string, string>,
  ): Promise<Uint8Array> {
    const ciphertext = new TextDecoder().decode(encryptedKey);
    const contextStr = uint8ArrayToBase64(
      new TextEncoder().encode(JSON.stringify(encryptionContext)),
    );

    const res = await fetch(`${this.baseUrl()}/decrypt/${this.keyName}`, {
      method: 'POST',
      headers: this.authHeaders(),
      body: JSON.stringify({ ciphertext, context: contextStr }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new KmsOperationError(`Vault decrypt failed (HTTP ${res.status}): ${text}`);
    }

    const json = (await res.json()) as { data?: { plaintext?: string } };
    const plaintext = json.data?.plaintext;
    if (!plaintext) {
      throw new KmsOperationError('Vault decrypt response missing data.plaintext');
    }

    return base64ToUint8Array(plaintext);
  }

  async rotateDataKey(encryptionContext: Record<string, string>): Promise<RotationResult> {
    // Rotate the Vault Transit key (creates a new key version; old versions remain for decryption)
    const rotateRes = await fetch(`${this.baseUrl()}/keys/${this.keyName}/rotate`, {
      method: 'POST',
      headers: this.authHeaders(),
    });

    if (!rotateRes.ok) {
      const text = await rotateRes.text();
      throw new KmsOperationError(`Vault rotate failed (HTTP ${rotateRes.status}): ${text}`);
    }

    // Generate a new data key under the new key version
    const newDataKey = await this.generateDataKey(encryptionContext);
    return { newDataKey, rotatedAt: new Date().toISOString() };
  }
}

// ---------------------------------------------------------------------------
// Module-level backend registry
// ---------------------------------------------------------------------------

/** Active KMS backend. Defaults to LocalDevKmsBackend at module load. */
let _kmsBackend: KmsBackend = new LocalDevKmsBackend();

/**
 * Replaces the active KMS backend.
 *
 * Call this once at server startup to wire in a production backend:
 *
 * ```ts
 * import { configureKmsBackend, AwsKmsBackend } from 'core/kms';
 * configureKmsBackend(new AwsKmsBackend({ keyId: process.env.AWS_KMS_KEY_ID! }));
 * ```
 */
export function configureKmsBackend(backend: KmsBackend): void {
  _kmsBackend = backend;
}

/**
 * Returns the currently active KMS backend.
 * Intended for tests that need to inspect or reset the backend.
 */
export function getKmsBackend(): KmsBackend {
  return _kmsBackend;
}

/**
 * Resets the KMS backend to the default LocalDevKmsBackend.
 * Intended for test isolation between suites.
 */
export function _resetKmsBackend(): void {
  _kmsBackend = new LocalDevKmsBackend();
}

// ---------------------------------------------------------------------------
// Convenience wrappers — call through the active backend
// ---------------------------------------------------------------------------

/**
 * Generates a new data key through the active KMS backend.
 * The `encryptionContext` must match the context used in `kmsDecryptDataKey`.
 */
export async function kmsGenerateDataKey(
  encryptionContext: Record<string, string>,
): Promise<DataKey> {
  return _kmsBackend.generateDataKey(encryptionContext);
}

/**
 * Decrypts a data key through the active KMS backend.
 */
export async function kmsDecryptDataKey(
  encryptedKey: Uint8Array,
  encryptionContext: Record<string, string>,
): Promise<Uint8Array> {
  return _kmsBackend.decryptDataKey(encryptedKey, encryptionContext);
}

/**
 * Rotates a data key through the active KMS backend.
 */
export async function kmsRotateDataKey(
  encryptionContext: Record<string, string>,
): Promise<RotationResult> {
  return _kmsBackend.rotateDataKey(encryptionContext);
}

// ---------------------------------------------------------------------------
// Key rotation command helper
// ---------------------------------------------------------------------------

/**
 * Runs an end-to-end key rotation for all sensitivity-class domains.
 *
 * For each domain in `domains`:
 * 1. Calls `kmsRotateDataKey` to generate a new data key via the active backend.
 * 2. Returns the rotation results keyed by domain name.
 *
 * The caller is responsible for re-encrypting existing data with the new data
 * key if the backend does not support in-place rotation (LocalDev does not;
 * AWS KMS and Vault Transit do via their key versioning mechanisms).
 *
 * @example
 * ```ts
 * const results = await rotateAllDomains([
 *   'HIGH/corpus_chunk',
 *   'IDENTITY/identity_token',
 * ]);
 * ```
 */
export async function rotateAllDomains(domains: string[]): Promise<Record<string, RotationResult>> {
  const results: Record<string, RotationResult> = {};
  for (const domain of domains) {
    const [sensitivityClass, entityType] = domain.split('/');
    results[domain] = await kmsRotateDataKey({
      domain,
      sensitivityClass: sensitivityClass ?? domain,
      entityType: entityType ?? domain,
      purpose: 'field-enc',
    });
  }
  return results;
}

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

/**
 * Thrown when the KMS backend cannot be reached or is misconfigured.
 */
export class KmsUnavailableError extends Error {
  constructor(message: string) {
    super(`[kms] ${message}`);
    this.name = 'KmsUnavailableError';
  }
}

/**
 * Thrown when a KMS operation (generate, decrypt, rotate) fails.
 */
export class KmsOperationError extends Error {
  constructor(message: string) {
    super(`[kms] ${message}`);
    this.name = 'KmsOperationError';
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function base64ToUint8Array(b64: string): Uint8Array {
  const binaryString = atob(b64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

function uint8ArrayToBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}
