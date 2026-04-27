/**
 * @file label-clearance.ts
 *
 * Label-based clearance controls and per-label content-key encryption.
 *
 * ## Layering model
 *
 * The tenant/customer RLS remains the outer boundary. Label grants are an
 * additional inner boundary applied on top of RLS. A user must:
 *   1. Be in the correct tenant (enforced by existing RLS).
 *   2. Hold the required label grant (enforced by this module).
 *
 * ## Per-label content-key encryption
 *
 * Each label has a KMS-wrapped data encryption key (DEK).
 * - `createLabelContentKey`: generates a fresh DEK, wraps it under the KMS
 *   master key and stores the wrapped form in `access_labels.wrapped_content_key`.
 * - `encryptLabeledContent` / `decryptLabeledContent`: encrypt/decrypt using
 *   the label's DEK, unwrapping it from KMS on each call (callers cache if needed).
 *
 * ## Ground-truth storage path
 *
 * `labeled_ground_truth` stores encrypted sensitive content attached to an
 * entity. An entity may carry multiple label records (one per label). Readers
 * must hold the matching label grant AND be in the correct tenant.
 *
 * ## Admin surfaces
 *
 * - `createAccessLabel` / `listAccessLabels` / `getAccessLabel`
 * - `grantUserLabel` / `revokeUserLabel` / `listUserLabels`
 * - `createLabelContentKey`
 * - `writeLabeledGroundTruth` / `readLabeledGroundTruth`
 *
 * Issue #225 — downstream label-based clearance controls and per-label content-key
 * encryption from template.
 */

import type postgres from 'postgres';
import { kmsGenerateDataKey, kmsDecryptDataKey } from '../core/kms';

type SqlClient = postgres.Sql;

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

export interface AccessLabel {
  name: string;
  description: string;
  tenant_id: string | null;
  created_by: string;
  wrapped_content_key: string | null;
  created_at: string;
  updated_at: string;
}

export interface UserLabel {
  id: string;
  user_id: string;
  label_name: string;
  tenant_id: string | null;
  granted_by: string;
  granted_at: string;
}

export interface LabeledGroundTruth {
  id: string;
  entity_id: string;
  label_name: string;
  tenant_id: string | null;
  encrypted_content: string;
  created_by: string;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

export class LabelNotFoundError extends Error {
  constructor(labelName: string, tenantId: string | null) {
    super(`Access label not found: "${labelName}" (tenant=${tenantId ?? 'global'})`);
    this.name = 'LabelNotFoundError';
  }
}

export class LabelContentKeyMissingError extends Error {
  constructor(labelName: string) {
    super(`Label "${labelName}" has no content key. Call createLabelContentKey first.`);
    this.name = 'LabelContentKeyMissingError';
  }
}

export class LabelClearanceDeniedError extends Error {
  constructor(userId: string, labelName: string) {
    super(`User "${userId}" does not hold clearance label "${labelName}".`);
    this.name = 'LabelClearanceDeniedError';
  }
}

export class LabelGrantNotFoundError extends Error {
  constructor(userId: string, labelName: string) {
    super(`No label grant found for user "${userId}" on label "${labelName}".`);
    this.name = 'LabelGrantNotFoundError';
  }
}

export class LabeledGroundTruthNotFoundError extends Error {
  constructor(entityId: string, labelName: string) {
    super(`No labeled ground truth found for entity "${entityId}" with label "${labelName}".`);
    this.name = 'LabeledGroundTruthNotFoundError';
  }
}

// ---------------------------------------------------------------------------
// KMS encryption context for a label
// ---------------------------------------------------------------------------

function labelEncryptionContext(
  labelName: string,
  tenantId: string | null,
): Record<string, string> {
  return {
    domain: `LABEL/${labelName}`,
    purpose: 'label-content-key',
    ...(tenantId ? { tenant_id: tenantId } : {}),
  };
}

// ---------------------------------------------------------------------------
// createAccessLabel
// ---------------------------------------------------------------------------

export interface CreateAccessLabelInput {
  name: string;
  description?: string;
  tenantId?: string | null;
  createdBy: string;
}

/**
 * Creates a new clearance label in the access_labels catalogue.
 *
 * Label names must be unique within a tenant (NULL = global).
 *
 * @throws if a label with the same name already exists in the tenant scope.
 */
export async function createAccessLabel(
  sql: SqlClient,
  input: CreateAccessLabelInput,
): Promise<AccessLabel> {
  const { name, description = '', tenantId = null, createdBy } = input;

  const [label] = await sql<AccessLabel[]>`
    INSERT INTO access_labels (name, description, tenant_id, created_by)
    VALUES (${name}, ${description}, ${tenantId}, ${createdBy})
    RETURNING name, description, tenant_id, created_by, wrapped_content_key, created_at, updated_at
  `;

  return label;
}

// ---------------------------------------------------------------------------
// getAccessLabel
// ---------------------------------------------------------------------------

/**
 * Fetches a single access label by name + tenant scope.
 *
 * @returns null when not found.
 */
export async function getAccessLabel(
  sql: SqlClient,
  labelName: string,
  tenantId: string | null = null,
): Promise<AccessLabel | null> {
  let rows: AccessLabel[];

  if (tenantId === null) {
    rows = await sql<AccessLabel[]>`
      SELECT name, description, tenant_id, created_by, wrapped_content_key, created_at, updated_at
      FROM access_labels
      WHERE name = ${labelName} AND tenant_id IS NULL
      LIMIT 1
    `;
  } else {
    rows = await sql<AccessLabel[]>`
      SELECT name, description, tenant_id, created_by, wrapped_content_key, created_at, updated_at
      FROM access_labels
      WHERE name = ${labelName} AND tenant_id = ${tenantId}
      LIMIT 1
    `;
  }

  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// listAccessLabels
// ---------------------------------------------------------------------------

export interface ListAccessLabelsOptions {
  tenantId?: string | null;
  limit?: number;
  offset?: number;
}

/**
 * Lists access labels. When tenantId is provided, returns only labels scoped to
 * that tenant. When tenantId is null, returns only global labels. When tenantId
 * is undefined, returns all labels.
 */
export async function listAccessLabels(
  sql: SqlClient,
  options: ListAccessLabelsOptions = {},
): Promise<AccessLabel[]> {
  const limit = Math.min(options.limit ?? 100, 500);
  const offset = options.offset ?? 0;

  if (options.tenantId === undefined) {
    return sql<AccessLabel[]>`
      SELECT name, description, tenant_id, created_by, wrapped_content_key, created_at, updated_at
      FROM access_labels
      ORDER BY created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `;
  }

  if (options.tenantId === null) {
    return sql<AccessLabel[]>`
      SELECT name, description, tenant_id, created_by, wrapped_content_key, created_at, updated_at
      FROM access_labels
      WHERE tenant_id IS NULL
      ORDER BY created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `;
  }

  return sql<AccessLabel[]>`
    SELECT name, description, tenant_id, created_by, wrapped_content_key, created_at, updated_at
    FROM access_labels
    WHERE tenant_id = ${options.tenantId}
    ORDER BY created_at DESC
    LIMIT ${limit} OFFSET ${offset}
  `;
}

// ---------------------------------------------------------------------------
// createLabelContentKey
// ---------------------------------------------------------------------------

/**
 * Generates a fresh AES-256 DEK for the given label, wraps it under the active
 * KMS backend, and stores the wrapped key in `access_labels.wrapped_content_key`.
 *
 * Idempotent in a weak sense: calling again will overwrite the existing wrapped
 * key (key rotation). Callers wanting a hard rotation should re-encrypt all
 * labeled_ground_truth records after calling this.
 *
 * @throws {LabelNotFoundError} when the label does not exist in the given scope.
 */
export async function createLabelContentKey(
  sql: SqlClient,
  labelName: string,
  tenantId: string | null = null,
): Promise<AccessLabel> {
  const existing = await getAccessLabel(sql, labelName, tenantId);
  if (!existing) {
    throw new LabelNotFoundError(labelName, tenantId);
  }

  const ctx = labelEncryptionContext(labelName, tenantId);
  const dataKey = await kmsGenerateDataKey(ctx);

  // Store the wrapped key as base64 text.
  const wrappedB64 = btoa(String.fromCharCode(...dataKey.encryptedKey));

  let label: AccessLabel;

  if (tenantId === null) {
    const [row] = await sql<AccessLabel[]>`
      UPDATE access_labels
         SET wrapped_content_key = ${wrappedB64},
             updated_at = NOW()
       WHERE name = ${labelName} AND tenant_id IS NULL
       RETURNING name, description, tenant_id, created_by, wrapped_content_key, created_at, updated_at
    `;
    label = row;
  } else {
    const [row] = await sql<AccessLabel[]>`
      UPDATE access_labels
         SET wrapped_content_key = ${wrappedB64},
             updated_at = NOW()
       WHERE name = ${labelName} AND tenant_id = ${tenantId}
       RETURNING name, description, tenant_id, created_by, wrapped_content_key, created_at, updated_at
    `;
    label = row;
  }

  return label;
}

// ---------------------------------------------------------------------------
// Internal: unwrap label DEK
// ---------------------------------------------------------------------------

/**
 * Unwraps the label's wrapped_content_key via KMS and returns a WebCrypto
 * CryptoKey ready for AES-256-GCM use.
 *
 * @throws {LabelContentKeyMissingError} when the label has no wrapped key yet.
 */
async function unwrapLabelDek(label: AccessLabel): Promise<CryptoKey> {
  if (!label.wrapped_content_key) {
    throw new LabelContentKeyMissingError(label.name);
  }

  const ctx = labelEncryptionContext(label.name, label.tenant_id);

  // Decode base64 wrapped key
  const b64 = label.wrapped_content_key;
  const binaryStr = atob(b64);
  const encryptedKey = new Uint8Array(binaryStr.length);
  for (let i = 0; i < binaryStr.length; i++) {
    encryptedKey[i] = binaryStr.charCodeAt(i);
  }

  const plaintextKey = await kmsDecryptDataKey(encryptedKey, ctx);

  return crypto.subtle.importKey(
    'raw',
    plaintextKey.buffer as ArrayBuffer,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

// ---------------------------------------------------------------------------
// encryptLabeledContent
// ---------------------------------------------------------------------------

const ENC_PREFIX = 'enc:v1:';

/**
 * Encrypts `plaintext` using the label's per-label DEK.
 *
 * Output format: `enc:v1:<base64-iv>:<base64-ciphertext+auth-tag>`
 *
 * @throws {LabelContentKeyMissingError} when the label has no content key.
 */
export async function encryptLabeledContent(
  label: AccessLabel,
  plaintext: string,
): Promise<string> {
  const key = await unwrapLabelDek(label);

  const ivBuf = new ArrayBuffer(12);
  const iv = new Uint8Array(ivBuf);
  crypto.getRandomValues(iv);

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

// ---------------------------------------------------------------------------
// decryptLabeledContent
// ---------------------------------------------------------------------------

/**
 * Decrypts a ciphertext string produced by `encryptLabeledContent`.
 * Passes the value through unchanged if it does not carry the `enc:v1:` prefix.
 *
 * @throws {LabelContentKeyMissingError} when the label has no content key.
 */
export async function decryptLabeledContent(
  label: AccessLabel,
  ciphertext: string,
): Promise<string> {
  if (!ciphertext.startsWith(ENC_PREFIX)) return ciphertext;

  const key = await unwrapLabelDek(label);

  const rest = ciphertext.slice(ENC_PREFIX.length);
  const colonIdx = rest.indexOf(':');
  if (colonIdx === -1) return ciphertext; // malformed — pass through

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

  const plainBuf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, cipherBuf);
  return new TextDecoder().decode(plainBuf);
}

// ---------------------------------------------------------------------------
// grantUserLabel
// ---------------------------------------------------------------------------

export interface GrantUserLabelInput {
  userId: string;
  labelName: string;
  tenantId?: string | null;
  grantedBy: string;
}

/**
 * Grants the given label to a user.
 *
 * The label must already exist in the given tenant scope.
 *
 * @throws {LabelNotFoundError} when the label does not exist.
 */
export async function grantUserLabel(
  sql: SqlClient,
  input: GrantUserLabelInput,
): Promise<UserLabel> {
  const { userId, labelName, tenantId = null, grantedBy } = input;

  // Verify the label exists in the given scope.
  const label = await getAccessLabel(sql, labelName, tenantId);
  if (!label) {
    throw new LabelNotFoundError(labelName, tenantId);
  }

  const [grant] = await sql<UserLabel[]>`
    INSERT INTO user_labels (user_id, label_name, tenant_id, granted_by)
    VALUES (${userId}, ${labelName}, ${tenantId}, ${grantedBy})
    ON CONFLICT ON CONSTRAINT user_labels_user_label_tenant_uniq
    DO UPDATE SET granted_by = ${grantedBy}, granted_at = NOW()
    RETURNING id, user_id, label_name, tenant_id, granted_by, granted_at
  `;

  return grant;
}

// ---------------------------------------------------------------------------
// revokeUserLabel
// ---------------------------------------------------------------------------

/**
 * Revokes the label grant for a user.
 *
 * @throws {LabelGrantNotFoundError} when no grant exists.
 */
export async function revokeUserLabel(
  sql: SqlClient,
  userId: string,
  labelName: string,
  tenantId: string | null = null,
): Promise<void> {
  let deleted: { id: string }[];

  if (tenantId === null) {
    deleted = await sql<{ id: string }[]>`
      DELETE FROM user_labels
       WHERE user_id = ${userId}
         AND label_name = ${labelName}
         AND tenant_id IS NULL
       RETURNING id
    `;
  } else {
    deleted = await sql<{ id: string }[]>`
      DELETE FROM user_labels
       WHERE user_id = ${userId}
         AND label_name = ${labelName}
         AND tenant_id = ${tenantId}
       RETURNING id
    `;
  }

  if (deleted.length === 0) {
    throw new LabelGrantNotFoundError(userId, labelName);
  }
}

// ---------------------------------------------------------------------------
// listUserLabels
// ---------------------------------------------------------------------------

/**
 * Lists all label grants for a user, optionally filtered by tenant.
 */
export async function listUserLabels(
  sql: SqlClient,
  userId: string,
  tenantId?: string | null,
): Promise<UserLabel[]> {
  if (tenantId === undefined) {
    return sql<UserLabel[]>`
      SELECT id, user_id, label_name, tenant_id, granted_by, granted_at
      FROM user_labels
      WHERE user_id = ${userId}
      ORDER BY granted_at DESC
    `;
  }

  if (tenantId === null) {
    return sql<UserLabel[]>`
      SELECT id, user_id, label_name, tenant_id, granted_by, granted_at
      FROM user_labels
      WHERE user_id = ${userId} AND tenant_id IS NULL
      ORDER BY granted_at DESC
    `;
  }

  return sql<UserLabel[]>`
    SELECT id, user_id, label_name, tenant_id, granted_by, granted_at
    FROM user_labels
    WHERE user_id = ${userId} AND tenant_id = ${tenantId}
    ORDER BY granted_at DESC
  `;
}

// ---------------------------------------------------------------------------
// userHasLabel
// ---------------------------------------------------------------------------

/**
 * Returns true when the user currently holds the given label grant.
 *
 * This is the primary authorization check gate:
 *   outer boundary: caller must ensure tenant_id scoping is already applied.
 *   inner boundary: label grant membership.
 */
export async function userHasLabel(
  sql: SqlClient,
  userId: string,
  labelName: string,
  tenantId: string | null = null,
): Promise<boolean> {
  let rows: { count: string }[];

  if (tenantId === null) {
    rows = await sql<{ count: string }[]>`
      SELECT COUNT(*) AS count
      FROM user_labels
      WHERE user_id = ${userId}
        AND label_name = ${labelName}
        AND tenant_id IS NULL
    `;
  } else {
    rows = await sql<{ count: string }[]>`
      SELECT COUNT(*) AS count
      FROM user_labels
      WHERE user_id = ${userId}
        AND label_name = ${labelName}
        AND tenant_id = ${tenantId}
    `;
  }

  return parseInt(rows[0]?.count ?? '0', 10) > 0;
}

// ---------------------------------------------------------------------------
// writeLabeledGroundTruth
// ---------------------------------------------------------------------------

export interface WriteLabeledGroundTruthInput {
  entityId: string;
  labelName: string;
  tenantId?: string | null;
  plaintext: string;
  createdBy: string;
}

/**
 * Encrypts `plaintext` using the label's per-label DEK and stores the result in
 * `labeled_ground_truth`.
 *
 * The outer RLS boundary (tenant_id on entities) must already be satisfied.
 * This function enforces the inner label boundary by refusing to write unless
 * the label exists and has a content key.
 *
 * ON CONFLICT: a second write to the same (entity_id, label_name) pair replaces
 * the encrypted content (i.e., update-in-place for the label record).
 *
 * @throws {LabelNotFoundError} when the label does not exist.
 * @throws {LabelContentKeyMissingError} when the label has no content key.
 */
export async function writeLabeledGroundTruth(
  sql: SqlClient,
  input: WriteLabeledGroundTruthInput,
): Promise<LabeledGroundTruth> {
  const { entityId, labelName, tenantId = null, plaintext, createdBy } = input;

  const label = await getAccessLabel(sql, labelName, tenantId);
  if (!label) {
    throw new LabelNotFoundError(labelName, tenantId);
  }

  const encryptedContent = await encryptLabeledContent(label, plaintext);

  const [row] = await sql<LabeledGroundTruth[]>`
    INSERT INTO labeled_ground_truth (entity_id, label_name, tenant_id, encrypted_content, created_by)
    VALUES (${entityId}, ${labelName}, ${tenantId}, ${encryptedContent}, ${createdBy})
    ON CONFLICT (entity_id, label_name)
    DO UPDATE SET encrypted_content = ${encryptedContent}, created_by = ${createdBy}
    RETURNING id, entity_id, label_name, tenant_id, encrypted_content, created_by, created_at
  `;

  return row;
}

// ---------------------------------------------------------------------------
// readLabeledGroundTruth
// ---------------------------------------------------------------------------

export interface ReadLabeledGroundTruthInput {
  entityId: string;
  labelName: string;
  tenantId?: string | null;
  /** User ID of the requesting actor — checked against user_labels. */
  requestingUserId: string;
}

/**
 * Reads and decrypts a labeled ground truth record for the given entity + label.
 *
 * Authorization:
 *   1. Outer boundary — caller must pass a tenantId that matches the record.
 *   2. Inner boundary — `requestingUserId` must hold the label grant via `userHasLabel`.
 *
 * @throws {LabelClearanceDeniedError} when the user does not hold the label.
 * @throws {LabeledGroundTruthNotFoundError} when no record exists.
 * @throws {LabelContentKeyMissingError} when the label has no content key.
 */
export async function readLabeledGroundTruth(
  sql: SqlClient,
  input: ReadLabeledGroundTruthInput,
): Promise<{ record: LabeledGroundTruth; plaintext: string }> {
  const { entityId, labelName, tenantId = null, requestingUserId } = input;

  // Inner boundary: label clearance check.
  const hasLabel = await userHasLabel(sql, requestingUserId, labelName, tenantId);
  if (!hasLabel) {
    throw new LabelClearanceDeniedError(requestingUserId, labelName);
  }

  // Fetch the record.
  let rows: LabeledGroundTruth[];

  if (tenantId === null) {
    rows = await sql<LabeledGroundTruth[]>`
      SELECT id, entity_id, label_name, tenant_id, encrypted_content, created_by, created_at
      FROM labeled_ground_truth
      WHERE entity_id = ${entityId}
        AND label_name = ${labelName}
        AND tenant_id IS NULL
      LIMIT 1
    `;
  } else {
    rows = await sql<LabeledGroundTruth[]>`
      SELECT id, entity_id, label_name, tenant_id, encrypted_content, created_by, created_at
      FROM labeled_ground_truth
      WHERE entity_id = ${entityId}
        AND label_name = ${labelName}
        AND tenant_id = ${tenantId}
      LIMIT 1
    `;
  }

  if (rows.length === 0) {
    throw new LabeledGroundTruthNotFoundError(entityId, labelName);
  }

  const record = rows[0];

  // Resolve the label for decryption key context.
  const label = await getAccessLabel(sql, labelName, tenantId);
  if (!label) {
    throw new LabelNotFoundError(labelName, tenantId);
  }

  const plaintext = await decryptLabeledContent(label, record.encrypted_content);

  return { record, plaintext };
}

// ---------------------------------------------------------------------------
// listLabeledGroundTruth
// ---------------------------------------------------------------------------

/**
 * Lists labeled ground truth record metadata for an entity.
 * Returns encrypted records — callers must call `readLabeledGroundTruth` to
 * decrypt and authorize individual records.
 */
export async function listLabeledGroundTruth(
  sql: SqlClient,
  entityId: string,
  tenantId?: string | null,
): Promise<Omit<LabeledGroundTruth, 'encrypted_content'>[]> {
  if (tenantId === undefined) {
    return sql<Omit<LabeledGroundTruth, 'encrypted_content'>[]>`
      SELECT id, entity_id, label_name, tenant_id, created_by, created_at
      FROM labeled_ground_truth
      WHERE entity_id = ${entityId}
      ORDER BY created_at DESC
    `;
  }

  if (tenantId === null) {
    return sql<Omit<LabeledGroundTruth, 'encrypted_content'>[]>`
      SELECT id, entity_id, label_name, tenant_id, created_by, created_at
      FROM labeled_ground_truth
      WHERE entity_id = ${entityId} AND tenant_id IS NULL
      ORDER BY created_at DESC
    `;
  }

  return sql<Omit<LabeledGroundTruth, 'encrypted_content'>[]>`
    SELECT id, entity_id, label_name, tenant_id, created_by, created_at
    FROM labeled_ground_truth
    WHERE entity_id = ${entityId} AND tenant_id = ${tenantId}
    ORDER BY created_at DESC
  `;
}
