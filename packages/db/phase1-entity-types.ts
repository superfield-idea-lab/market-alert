/**
 * @file phase1-entity-types
 *
 * Phase 1 — Security foundation: property graph entity type registrations.
 *
 * This module declares every entity type that must be present in the
 * `entity_types` table at the end of Phase 1. Each definition carries:
 *
 *   - `type`       — canonical lowercase identifier
 *   - `schema`     — JSON Schema for `properties` validation (empty = permissive)
 *   - `sensitive`  — `properties` keys that must be field-encrypted before insert
 *   - `kmsKeyId`   — KMS key domain that protects the sensitive fields
 *
 * ## Entity types by domain
 *
 * | Domain           | Types                                                 |
 * |------------------|-------------------------------------------------------|
 * | Auth             | user, passkey_credential, recovery_shard              |
 * | Organisation     | department                                            |
 * | CRM              | customer, crm_update, customer_interest               |
 * | Ground truth     | email                                                 |
 * | Corpus chunks    | corpus_chunk                                          |
 * | Wiki (synthetic) | wiki_page, wiki_page_version, wiki_annotation         |
 * | Campaign / BD    | asset_manager, fund                                   |
 * | Identity tokens  | identity_token                                        |
 *
 * Audio and transcript entity types are Phase 5+ and are intentionally
 * excluded here.
 *
 * ## Pool assignment
 *
 * All Phase 1 entity types live in the `kb_app` pool (`app_rw` role).
 * The `identity_token` type is additionally protected by a separate RLS
 * policy (`app.can_view_dictionary`) and uses its own KMS key domain.
 *
 * ## Canonical docs
 *
 * - `docs/technical/db-architecture.md` §"Entity type registry"
 * - `docs/implementation-plan-v1.md` §Phase 1
 *
 * @see https://github.com/superfield-ai/superfield-kb-demo/issues/21
 */

import type { EntityTypeDefinition } from './entity-type-registry';
import { entityTypeRegistry, EntityTypeRegistry } from './entity-type-registry';
import type postgres from 'postgres';

// ---------------------------------------------------------------------------
// Phase 1 entity type definitions
// ---------------------------------------------------------------------------

/**
 * The canonical list of Phase 1 property graph entity types.
 *
 * Each entry is an `EntityTypeDefinition` ready to pass to
 * `EntityTypeRegistry.register` or `EntityTypeRegistry.registerWithDb`.
 *
 * The set is exported so integration tests can assert completeness without
 * repeating the list.
 */
export const PHASE_1_ENTITY_TYPES: EntityTypeDefinition[] = [
  // ---------------------------------------------------------------------------
  // Auth
  // ---------------------------------------------------------------------------

  /** Application user (passkey-only; no password column). */
  { type: 'user', schema: {}, sensitive: [], kmsKeyId: undefined },

  /**
   * WebAuthn passkey credential.
   * Stored outside the graph as a dedicated `passkey_credentials` table, but
   * registered here so the registry is the authoritative list of all entity
   * types — including those with dedicated tables.
   */
  { type: 'passkey_credential', schema: {}, sensitive: [], kmsKeyId: undefined },

  /**
   * M-of-N key recovery shard.
   * `shard_ciphertext` is AES-256-GCM encrypted before insert.
   */
  { type: 'recovery_shard', schema: {}, sensitive: ['shard_ciphertext'], kmsKeyId: 'auth-key' },

  // ---------------------------------------------------------------------------
  // Organisation
  // ---------------------------------------------------------------------------

  /** Business unit / department — the RLS scope anchor for all entities. */
  { type: 'department', schema: {}, sensitive: [], kmsKeyId: undefined },

  // ---------------------------------------------------------------------------
  // CRM
  // ---------------------------------------------------------------------------

  /**
   * Customer record.
   * `name` and `notes` are encrypted; they may contain real person names or
   * free-text PII from the relationship manager.
   */
  { type: 'customer', schema: {}, sensitive: ['name', 'notes'], kmsKeyId: 'crm-key' },

  /**
   * A CRM update (note, status change, interest update) against a customer.
   * `body` is encrypted because it contains free-text written by the RM.
   */
  { type: 'crm_update', schema: {}, sensitive: ['body'], kmsKeyId: 'crm-key' },

  /**
   * A customer interest entry derived from ground truth.
   * `topic` is encrypted — it is synthesised from anonymised source material
   * but may still reproduce PII-adjacent phrasing.
   */
  { type: 'customer_interest', schema: {}, sensitive: ['topic'], kmsKeyId: 'crm-key' },

  // ---------------------------------------------------------------------------
  // Ground truth (immutable source-of-record; anonymised before insert)
  // ---------------------------------------------------------------------------

  /**
   * Ingested email.
   * `subject`, `body`, and `headers` are encrypted even after anonymisation —
   * anonymisation is not a substitute for encryption (see security.md).
   */
  {
    type: 'email',
    schema: {},
    sensitive: ['subject', 'body', 'headers'],
    kmsKeyId: 'corpus-key',
  },

  // ---------------------------------------------------------------------------
  // Corpus chunks (embedded; content anonymised but still encrypted at rest)
  // ---------------------------------------------------------------------------

  /**
   * A chunk of text extracted from ground-truth source material.
   * `content` is encrypted. The `embedding` column is independent of the
   * ciphertext — HNSW search operates on raw floats, not the encrypted body.
   */
  { type: 'corpus_chunk', schema: {}, sensitive: ['content'], kmsKeyId: 'corpus-key' },

  // ---------------------------------------------------------------------------
  // Wiki (synthetic; agent-maintained)
  // ---------------------------------------------------------------------------

  /**
   * A wiki page (the stable handle; points to the current version).
   * No sensitive fields — the page itself holds no content.
   */
  { type: 'wiki_page', schema: {}, sensitive: [], kmsKeyId: undefined },

  /**
   * A versioned snapshot of a wiki page.
   * `content` (markdown) is encrypted because it is synthesised from sensitive
   * ground truth and may reproduce PII-adjacent phrasing.
   */
  {
    type: 'wiki_page_version',
    schema: {},
    sensitive: ['content'],
    kmsKeyId: 'corpus-key',
  },

  /**
   * An annotation thread on a specific wiki page version.
   * `thread` (JSONB array) is encrypted for the same reason as `wiki_page_version.content`.
   */
  { type: 'wiki_annotation', schema: {}, sensitive: ['thread'], kmsKeyId: 'corpus-key' },

  // ---------------------------------------------------------------------------
  // Campaign / business development
  // ---------------------------------------------------------------------------

  /** An asset management firm. No sensitive fields at this stage. */
  { type: 'asset_manager', schema: {}, sensitive: [], kmsKeyId: undefined },

  /** An investment fund managed by an `asset_manager`. No sensitive fields. */
  { type: 'fund', schema: {}, sensitive: [], kmsKeyId: undefined },

  // ---------------------------------------------------------------------------
  // Identity dictionary (access-controlled separately)
  // ---------------------------------------------------------------------------

  /**
   * A re-identification token that maps an anonymisation key back to a real
   * person. Holds the most sensitive data in the system.
   *
   * `real_name`, `real_email`, and `real_org` are encrypted with the
   * `identity-key` domain, which is disjoint from all other key domains.
   * RLS restricts access to roles with `app.can_view_dictionary = 'true'`.
   */
  {
    type: 'identity_token',
    schema: {},
    sensitive: ['real_name', 'real_email', 'real_org'],
    kmsKeyId: 'identity-key',
  },
];

// ---------------------------------------------------------------------------
// Public registration helpers
// ---------------------------------------------------------------------------

/**
 * Registers all Phase 1 entity types in the provided `EntityTypeRegistry`
 * in-memory only (no database connection required).
 *
 * Idempotent: safe to call multiple times or against a registry that already
 * contains some Phase 1 types.
 *
 * @param registry — defaults to the module-level singleton
 */
export function registerPhase1EntityTypes(registry: EntityTypeRegistry = entityTypeRegistry): void {
  for (const definition of PHASE_1_ENTITY_TYPES) {
    registry.register(definition);
  }
}

/**
 * Registers all Phase 1 entity types in the provided `EntityTypeRegistry`
 * **and** persists each type to the `entity_types` table via an idempotent
 * `INSERT … ON CONFLICT DO NOTHING`.
 *
 * This is the function called at server boot. It is safe to call against a
 * database that already contains the rows seeded by `schema.sql`.
 *
 * @param sql      — live postgres.Sql client (from `packages/db/index.ts`)
 * @param registry — defaults to the module-level singleton
 */
export async function registerPhase1EntityTypesWithDb(
  sql: postgres.Sql,
  registry: EntityTypeRegistry = entityTypeRegistry,
): Promise<void> {
  for (const definition of PHASE_1_ENTITY_TYPES) {
    await registry.registerWithDb(sql, definition);
  }
}
