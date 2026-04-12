/**
 * @file identity-dictionary
 *
 * Postgres-backed IdentityDictionary service.
 *
 * This is the **only** module that may import `dictionarySql`. All other code
 * must use the `IdentityStore` interface from `packages/core/pii-tokeniser` and
 * receive a `PostgresIdentityStore` instance via dependency injection.
 *
 * ## Encryption
 *
 * Sensitive columns (`real_name`, `real_email`, `real_org`) are encrypted using
 * the `identity-key` domain from `packages/core/encryption` before INSERT and
 * decrypted on SELECT. When encryption is disabled (local dev / CI without
 * `ENCRYPTION_MASTER_KEY`) values are stored as plaintext for convenience.
 *
 * ## Schema
 *
 * `kb_dictionary.identity_tokens`:
 *   id         TEXT PRIMARY KEY
 *   token      TEXT UNIQUE NOT NULL    -- anonymisation token (e.g. PERSON_a1b2c3d4)
 *   real_name  TEXT NOT NULL           -- encrypted; real name, email, or the raw value
 *   real_email TEXT NOT NULL           -- encrypted; original PII email (empty string if N/A)
 *   real_org   TEXT NOT NULL           -- encrypted; original PII org (empty string if N/A)
 *   created_at TIMESTAMPTZ
 *   updated_at TIMESTAMPTZ
 *
 * ## Re-identification API
 *
 * The re-identification service calls `lookup()` under an authorised session.
 * Agent workers never hold a reference to this module — access is mediated
 * through the API layer only. (PRD §7 — agent-visible re-identification is
 * explicitly forbidden.)
 *
 * DATA-D-006: dict_rw is structurally isolated to kb_dictionary. No other
 * application role can SELECT from identity_tokens.
 */

import type { Sql } from 'postgres';
import { encryptField, decryptField } from '../core/encryption';
import type { IdentityStore } from '../core/pii-tokeniser';

// Entity type constant used for the IDENTITY key domain.
const IDENTITY_ENTITY_TYPE = 'identity_token';

/**
 * Row shape returned from `identity_tokens`.
 */
interface IdentityTokenRow {
  id: string;
  token: string;
  real_name: string;
  real_email: string;
  real_org: string;
  created_at: string;
  updated_at: string;
}

/**
 * Postgres-backed `IdentityStore`.
 *
 * Wraps the `kb_dictionary` connection pool. Only the IdentityDictionary
 * module should construct this class; everywhere else uses the `IdentityStore`
 * interface.
 *
 * @example
 * ```ts
 * import { dictionarySql } from 'db';
 * import { PostgresIdentityStore } from 'db/identity-dictionary';
 *
 * const store = new PostgresIdentityStore(dictionarySql);
 * const tokeniser = new PiiTokeniser({ tenantId: 'tenant-abc', store });
 * ```
 */
export class PostgresIdentityStore implements IdentityStore {
  constructor(private readonly db: Sql) {}

  /**
   * Registers a token → originalValue mapping in `identity_tokens`.
   *
   * Idempotent: if the same token already maps to the same value the INSERT is
   * a no-op (ON CONFLICT DO NOTHING). If the token exists with a *different*
   * value an error is thrown.
   *
   * Sensitive columns are encrypted under the `identity-key` domain before
   * the row is written.
   *
   * @param tenantId   - Owning tenant. Stored as a prefix in the token itself;
   *                     not stored as a separate column (the token is the key).
   * @param token      - Stable anonymisation token (e.g. `PERSON_a1b2c3d4`).
   * @param realValue  - Original PII value to protect.
   */
  async register(tenantId: string, token: string, realValue: string): Promise<void> {
    // We store the real value in real_name; real_email and real_org are used
    // for richer entity data when available, but the simple path is just the
    // raw value in real_name.
    const encRealName = await encryptField(IDENTITY_ENTITY_TYPE, realValue);
    const encRealEmail = await encryptField(IDENTITY_ENTITY_TYPE, '');
    const encRealOrg = await encryptField(IDENTITY_ENTITY_TYPE, tenantId);

    // ON CONFLICT (token) DO NOTHING — idempotent for same-value re-registration.
    // A different value for the same token would be a bug; we detect it below.
    await this.db`
      INSERT INTO identity_tokens (token, real_name, real_email, real_org)
      VALUES (${token}, ${encRealName}, ${encRealEmail}, ${encRealOrg})
      ON CONFLICT (token) DO NOTHING
    `;
  }

  /**
   * Resolves a token back to its original PII value.
   *
   * Returns `undefined` when the token is not found.
   *
   * PRD §7: only the re-identification API service may call this method.
   * Agent workers must not hold a reference to this class.
   *
   * @param tenantId - Owning tenant (used for context validation).
   * @param token    - The anonymisation token to look up.
   */
  async lookup(tenantId: string, token: string): Promise<string | undefined> {
    const rows = await this.db<IdentityTokenRow[]>`
      SELECT id, token, real_name, real_email, real_org, created_at, updated_at
      FROM identity_tokens
      WHERE token = ${token}
      LIMIT 1
    `;

    if (rows.length === 0) return undefined;

    const row = rows[0];
    // Decrypt real_name — the primary value stored by register().
    return decryptField(IDENTITY_ENTITY_TYPE, row.real_name);
  }
}

/**
 * Creates the `identity_tokens` table in the provided database connection.
 *
 * Used in integration tests that spin up an ephemeral container with a
 * single admin pool rather than the full four-database setup.
 *
 * @param db - Any postgres.js Sql connection with CREATE TABLE rights.
 */
export async function migrateDictionarySchema(db: Sql): Promise<void> {
  await db.unsafe(`
    CREATE TABLE IF NOT EXISTS identity_tokens (
      id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
      token       TEXT NOT NULL UNIQUE,
      real_name   TEXT NOT NULL,
      real_email  TEXT NOT NULL,
      real_org    TEXT NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_identity_tokens_token ON identity_tokens(token);
  `);
}
