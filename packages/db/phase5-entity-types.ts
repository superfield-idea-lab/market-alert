/**
 * @file phase5-entity-types
 *
 * Phase 5 — PWA & meeting transcription: property graph entity type registrations.
 *
 * This module declares the two entity types introduced in Phase 5:
 *
 *   - `audio_recording` — metadata-only record for a meeting recording.
 *     Stores timestamps, customer linkage, edge/worker path, and duration.
 *     MUST NOT include a raw audio column — raw audio never leaves the device.
 *
 *   - `transcript` — the text transcript produced from an audio recording.
 *     The `text` field is AES-256-GCM encrypted before insert.
 *
 * ## Design invariants
 *
 * 1. AudioRecording stores only metadata — no raw audio bytes, no binary column.
 *    Enforcement: `audio_recording` schema has no `audio` or `raw_audio` property.
 *
 * 2. Transcript text is encrypted at rest using the `transcript` KMS key domain.
 *
 * 3. Writes to both types go through the API-mediated ingestion endpoint
 *    (POST /internal/ingestion/transcript). Workers have no direct INSERT
 *    privilege on the `entities` table.
 *
 * ## Canonical docs
 *
 * - `docs/implementation-plan-v1.md` §Phase 5
 * - `calypso-blueprint/PHASE-5-SCOUT`
 *
 * @see https://github.com/superfield-ai/superfield-kb-demo/issues/58
 */

import type { EntityTypeDefinition } from './entity-type-registry';
import { entityTypeRegistry, EntityTypeRegistry } from './entity-type-registry';
import type postgres from 'postgres';

// ---------------------------------------------------------------------------
// Phase 5 entity type definitions
// ---------------------------------------------------------------------------

/**
 * The canonical list of Phase 5 property graph entity types.
 *
 * Each entry is an `EntityTypeDefinition` ready to pass to
 * `EntityTypeRegistry.register` or `EntityTypeRegistry.registerWithDb`.
 *
 * The set is exported so integration tests can assert completeness without
 * repeating the list.
 */
export const PHASE_5_ENTITY_TYPES: EntityTypeDefinition[] = [
  // ---------------------------------------------------------------------------
  // AudioRecording
  // ---------------------------------------------------------------------------

  /**
   * Metadata-only record for a meeting recording.
   *
   * Invariant: MUST NOT include a raw audio column. Raw audio never leaves
   * the device (PWA on-device transcription; see calypso-blueprint PHASE-5-SCOUT).
   *
   * Properties shape:
   *   - `customer_id`  {string}  — owning customer entity id
   *   - `duration_s`   {number}  — recording duration in seconds (optional)
   *   - `source`       {string}  — "edge_device" or "worker_path"
   *   - `recorded_at`  {string}  — ISO-8601 timestamp when recording started
   *   - `transcript_id`{string}  — linked Transcript entity id (optional, set after ingestion)
   *
   * Columns NOT present (by design):
   *   - audio, raw_audio, audio_bytes, audio_data, blob — any raw audio column
   */
  {
    type: 'audio_recording',
    schema: {
      type: 'object',
      required: ['customer_id', 'source', 'recorded_at'],
      properties: {
        customer_id: { type: 'string' },
        duration_s: { type: 'number', minimum: 0 },
        source: { type: 'string', enum: ['edge_device', 'worker_path'] },
        recorded_at: { type: 'string' },
        transcript_id: { type: 'string' },
      },
      additionalProperties: false,
    },
    sensitive: [],
    kmsKeyId: undefined,
  },

  // ---------------------------------------------------------------------------
  // Transcript
  // ---------------------------------------------------------------------------

  /**
   * A meeting transcript produced by on-device transcription.
   *
   * `text` is AES-256-GCM encrypted before insert — it is produced from a
   * real meeting and may contain PII, customer names, and commercially
   * sensitive information.
   *
   * Properties shape:
   *   - `text`         {string}  — transcript body (sensitive, encrypted at rest)
   *   - `customer_id`  {string}  — owning customer entity id
   *   - `duration_s`   {number}  — recording duration in seconds (optional)
   *   - `source`       {string}  — always "edge_device" for the API path
   *   - `recorded_at`  {string}  — ISO-8601 timestamp when recording started
   */
  {
    type: 'transcript',
    schema: {
      type: 'object',
      required: ['text', 'customer_id', 'source', 'recorded_at'],
      properties: {
        text: { type: 'string' },
        customer_id: { type: 'string' },
        duration_s: { type: 'number', minimum: 0 },
        source: { type: 'string', enum: ['edge_device', 'worker_path'] },
        recorded_at: { type: 'string' },
      },
    },
    sensitive: ['text'],
    kmsKeyId: 'transcript',
  },
];

// ---------------------------------------------------------------------------
// Public registration helpers
// ---------------------------------------------------------------------------

/**
 * Registers all Phase 5 entity types in the provided `EntityTypeRegistry`
 * in-memory only (no database connection required).
 *
 * Idempotent: safe to call multiple times or against a registry that already
 * contains some Phase 5 types.
 *
 * @param registry — defaults to the module-level singleton
 */
export function registerPhase5EntityTypes(registry: EntityTypeRegistry = entityTypeRegistry): void {
  for (const definition of PHASE_5_ENTITY_TYPES) {
    registry.register(definition);
  }
}

/**
 * Registers all Phase 5 entity types in the provided `EntityTypeRegistry`
 * **and** persists each type to the `entity_types` table via an idempotent
 * `INSERT … ON CONFLICT DO NOTHING`.
 *
 * This is the function called at server boot. It is safe to call against a
 * database that already contains the rows (e.g. when the `transcript` type
 * was seeded by an earlier server run).
 *
 * @param sql      — live postgres.Sql client (from `packages/db/index.ts`)
 * @param registry — defaults to the module-level singleton
 */
export async function registerPhase5EntityTypesWithDb(
  sql: postgres.Sql,
  registry: EntityTypeRegistry = entityTypeRegistry,
): Promise<void> {
  for (const definition of PHASE_5_ENTITY_TYPES) {
    await registry.registerWithDb(sql, definition);
  }
}
