/**
 * Unit tests for phase1-entity-types.
 *
 * These tests cover the in-memory registration path only — no database required.
 * Integration tests (real Postgres + real server boot) live in
 * apps/server/tests/integration/phase1-entity-types.test.ts.
 *
 * No mocks.
 */

import { describe, expect, test } from 'vitest';
import { PHASE_1_ENTITY_TYPES, registerPhase1EntityTypes } from './phase1-entity-types';
import { EntityTypeRegistry } from './entity-type-registry';

// ---------------------------------------------------------------------------
// Canonical type list
// ---------------------------------------------------------------------------

const REQUIRED_TYPES = [
  // Auth
  'user',
  'passkey_credential',
  'recovery_shard',
  // Organisation
  'department',
  // CRM
  'customer',
  'crm_update',
  'customer_interest',
  // Ground truth (Phase 1 only — audio/transcript are Phase 5+)
  'email',
  // Corpus chunks
  'corpus_chunk',
  // Wiki
  'wiki_page',
  'wiki_page_version',
  'wiki_annotation',
  // Campaign / BD
  'asset_manager',
  'fund',
  // Identity dictionary
  'identity_token',
] as const;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PHASE_1_ENTITY_TYPES constant', () => {
  test('contains all required Phase 1 types', () => {
    const declaredTypes = new Set(PHASE_1_ENTITY_TYPES.map((d) => d.type));

    for (const required of REQUIRED_TYPES) {
      expect(
        declaredTypes.has(required),
        `PHASE_1_ENTITY_TYPES is missing required type "${required}"`,
      ).toBe(true);
    }
  });

  test('does not include Phase 5+ types (audio_recording, transcript)', () => {
    const declaredTypes = new Set(PHASE_1_ENTITY_TYPES.map((d) => d.type));
    expect(declaredTypes.has('audio_recording')).toBe(false);
    expect(declaredTypes.has('transcript')).toBe(false);
  });

  test('every type matches the registry naming convention /^[a-z][a-z0-9_]*$/', () => {
    for (const definition of PHASE_1_ENTITY_TYPES) {
      expect(
        /^[a-z][a-z0-9_]*$/.test(definition.type),
        `Type "${definition.type}" violates naming convention /^[a-z][a-z0-9_]*$/`,
      ).toBe(true);
    }
  });

  test('types with sensitive fields all declare a kmsKeyId', () => {
    for (const definition of PHASE_1_ENTITY_TYPES) {
      if (definition.sensitive && definition.sensitive.length > 0) {
        expect(
          definition.kmsKeyId,
          `Type "${definition.type}" has sensitive fields but no kmsKeyId`,
        ).toBeTruthy();
      }
    }
  });

  test('types without sensitive fields have no kmsKeyId', () => {
    for (const definition of PHASE_1_ENTITY_TYPES) {
      if (!definition.sensitive || definition.sensitive.length === 0) {
        // kmsKeyId may be undefined (not set) for non-sensitive types
        expect(
          definition.kmsKeyId ?? null,
          `Type "${definition.type}" has no sensitive fields but sets a kmsKeyId`,
        ).toBeNull();
      }
    }
  });

  test('no duplicate type names', () => {
    const types = PHASE_1_ENTITY_TYPES.map((d) => d.type);
    const unique = new Set(types);
    expect(unique.size).toBe(types.length);
  });
});

describe('registerPhase1EntityTypes — in-memory', () => {
  test('registers all required types into an isolated registry', () => {
    const registry = new EntityTypeRegistry();
    registerPhase1EntityTypes(registry);

    for (const required of REQUIRED_TYPES) {
      expect(registry.has(required), `Expected type "${required}" to be registered`).toBe(true);
    }
  });

  test('registration is idempotent — calling twice does not throw or duplicate', () => {
    const registry = new EntityTypeRegistry();
    registerPhase1EntityTypes(registry);
    const sizeAfterFirst = registry.size;

    registerPhase1EntityTypes(registry);
    expect(registry.size).toBe(sizeAfterFirst);
  });

  test('each registered type has normalised sensitive array', () => {
    const registry = new EntityTypeRegistry();
    registerPhase1EntityTypes(registry);

    for (const entry of registry.list()) {
      expect(Array.isArray(entry.sensitive)).toBe(true);
    }
  });

  test('sensitive types have non-null kmsKeyId in the registry', () => {
    const registry = new EntityTypeRegistry();
    registerPhase1EntityTypes(registry);

    for (const entry of registry.list()) {
      if (entry.sensitive.length > 0) {
        expect(
          entry.kmsKeyId,
          `Registered type "${entry.type}" has sensitive fields but null kmsKeyId`,
        ).not.toBeNull();
      }
    }
  });

  test('registry size equals PHASE_1_ENTITY_TYPES length', () => {
    const registry = new EntityTypeRegistry();
    registerPhase1EntityTypes(registry);
    expect(registry.size).toBe(PHASE_1_ENTITY_TYPES.length);
  });
});
