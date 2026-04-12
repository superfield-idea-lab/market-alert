/**
 * Unit tests for phase5-entity-types (issue #58).
 *
 * Covers:
 *   1. PHASE_5_ENTITY_TYPES contains both `audio_recording` and `transcript`.
 *   2. audio_recording schema has no raw audio property.
 *   3. audio_recording has no sensitive fields (metadata-only, no PII stored).
 *   4. transcript.sensitive includes `text` and declares a kmsKeyId.
 *   5. registerPhase5EntityTypes populates an isolated registry correctly.
 *
 * No mocks. No database required — in-memory registry only.
 */

import { describe, expect, test } from 'vitest';
import { PHASE_5_ENTITY_TYPES, registerPhase5EntityTypes } from './phase5-entity-types';
import { EntityTypeRegistry } from './entity-type-registry';

// ---------------------------------------------------------------------------
// Canonical type list
// ---------------------------------------------------------------------------

const REQUIRED_TYPES = ['audio_recording', 'transcript'] as const;

// Properties that must never appear in the audio_recording schema —
// any of these indicate raw audio storage, which is strictly forbidden.
const PROHIBITED_AUDIO_PROPERTIES = [
  'audio',
  'raw_audio',
  'audio_bytes',
  'audio_data',
  'blob',
  'audio_content',
  'audio_file',
  'audio_buffer',
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PHASE_5_ENTITY_TYPES constant', () => {
  test('contains all required Phase 5 types', () => {
    const declaredTypes = new Set(PHASE_5_ENTITY_TYPES.map((d) => d.type));

    for (const required of REQUIRED_TYPES) {
      expect(
        declaredTypes.has(required),
        `PHASE_5_ENTITY_TYPES is missing required type "${required}"`,
      ).toBe(true);
    }
  });

  test('every type matches the registry naming convention /^[a-z][a-z0-9_]*$/', () => {
    for (const definition of PHASE_5_ENTITY_TYPES) {
      expect(
        /^[a-z][a-z0-9_]*$/.test(definition.type),
        `Type "${definition.type}" violates naming convention`,
      ).toBe(true);
    }
  });

  test('no duplicate type names', () => {
    const types = PHASE_5_ENTITY_TYPES.map((d) => d.type);
    const unique = new Set(types);
    expect(unique.size).toBe(types.length);
  });

  test('types with sensitive fields all declare a kmsKeyId', () => {
    for (const definition of PHASE_5_ENTITY_TYPES) {
      if (definition.sensitive && definition.sensitive.length > 0) {
        expect(
          definition.kmsKeyId,
          `Type "${definition.type}" has sensitive fields but no kmsKeyId`,
        ).toBeTruthy();
      }
    }
  });
});

// ---------------------------------------------------------------------------
// AudioRecording — no raw audio invariant
// ---------------------------------------------------------------------------

describe('audio_recording entity type definition', () => {
  const audioRecording = PHASE_5_ENTITY_TYPES.find((d) => d.type === 'audio_recording');

  test('audio_recording definition exists', () => {
    expect(audioRecording).toBeDefined();
  });

  test('audio_recording schema does not include raw audio properties', () => {
    const schema = audioRecording!.schema as {
      properties?: Record<string, unknown>;
      additionalProperties?: unknown;
    };

    if (schema.properties) {
      for (const prohibited of PROHIBITED_AUDIO_PROPERTIES) {
        expect(
          prohibited in schema.properties,
          `audio_recording schema must not include property "${prohibited}" (raw audio is forbidden)`,
        ).toBe(false);
      }
    }
  });

  test('audio_recording has no sensitive fields ��� raw audio is never stored', () => {
    // sensitive array must be empty or undefined: there is nothing PII-sensitive
    // to encrypt because the entity stores metadata only.
    const sensitive = audioRecording!.sensitive ?? [];
    expect(sensitive).toEqual([]);
  });

  test('audio_recording has no kmsKeyId — no sensitive data to encrypt', () => {
    expect(audioRecording!.kmsKeyId ?? null).toBeNull();
  });

  test('audio_recording schema has additionalProperties: false', () => {
    const schema = audioRecording!.schema as { additionalProperties?: unknown };
    expect(schema.additionalProperties).toBe(false);
  });

  test('audio_recording schema requires customer_id, source, and recorded_at', () => {
    const schema = audioRecording!.schema as { required?: string[] };
    expect(schema.required).toBeDefined();
    expect(schema.required).toContain('customer_id');
    expect(schema.required).toContain('source');
    expect(schema.required).toContain('recorded_at');
  });
});

// ---------------------------------------------------------------------------
// Transcript — encryption invariant
// ---------------------------------------------------------------------------

describe('transcript entity type definition', () => {
  const transcript = PHASE_5_ENTITY_TYPES.find((d) => d.type === 'transcript');

  test('transcript definition exists', () => {
    expect(transcript).toBeDefined();
  });

  test('transcript.sensitive includes "text"', () => {
    expect(transcript!.sensitive).toContain('text');
  });

  test('transcript declares a kmsKeyId for encrypting text', () => {
    expect(transcript!.kmsKeyId).toBeTruthy();
  });

  test('transcript schema requires text, customer_id, source, recorded_at', () => {
    const schema = transcript!.schema as { required?: string[] };
    expect(schema.required).toContain('text');
    expect(schema.required).toContain('customer_id');
    expect(schema.required).toContain('source');
    expect(schema.required).toContain('recorded_at');
  });
});

// ---------------------------------------------------------------------------
// registerPhase5EntityTypes — in-memory registration
// ---------------------------------------------------------------------------

describe('registerPhase5EntityTypes — in-memory', () => {
  test('registers all required Phase 5 types into an isolated registry', () => {
    const registry = new EntityTypeRegistry();
    registerPhase5EntityTypes(registry);

    for (const required of REQUIRED_TYPES) {
      expect(registry.has(required), `Expected type "${required}" to be registered`).toBe(true);
    }
  });

  test('registration is idempotent — calling twice does not throw or duplicate', () => {
    const registry = new EntityTypeRegistry();
    registerPhase5EntityTypes(registry);
    const sizeAfterFirst = registry.size;

    registerPhase5EntityTypes(registry);
    expect(registry.size).toBe(sizeAfterFirst);
  });

  test('audio_recording in registry has no sensitive fields', () => {
    const registry = new EntityTypeRegistry();
    registerPhase5EntityTypes(registry);

    const entry = registry.get('audio_recording');
    expect(entry).toBeDefined();
    expect(entry!.sensitive).toEqual([]);
  });

  test('transcript in registry has sensitive "text" and non-null kmsKeyId', () => {
    const registry = new EntityTypeRegistry();
    registerPhase5EntityTypes(registry);

    const entry = registry.get('transcript');
    expect(entry).toBeDefined();
    expect(entry!.sensitive).toContain('text');
    expect(entry!.kmsKeyId).not.toBeNull();
  });

  test('registry size equals PHASE_5_ENTITY_TYPES length', () => {
    const registry = new EntityTypeRegistry();
    registerPhase5EntityTypes(registry);
    expect(registry.size).toBe(PHASE_5_ENTITY_TYPES.length);
  });
});
