/**
 * @file audio-recording-transcript.spec.ts
 *
 * Phase 5 integration tests — AudioRecording and Transcript entity types
 * with API-mediated writes (issue #58).
 *
 * ## Test plan coverage
 *
 * 1. POST /internal/ingestion/transcript — assert the transcript row is
 *    persisted with the correct entity type and encrypted text.
 *
 * 2. Direct DB INSERT attempt from a read-only worker role — asserts denial.
 *    A minimal Postgres role with no INSERT privilege on the entities table
 *    is created per-test; any INSERT attempt raises a permission error.
 *
 * 3. AudioRecording schema never contains a raw audio column — asserts:
 *    a. The `audio_recording` entity type exists in the registry after boot.
 *    b. Its JSON Schema has no `audio`, `raw_audio`, `audio_bytes`,
 *       `audio_data`, or `blob` properties.
 *    c. The entity type is registered in the database entity_types table.
 *
 * ## No mocks
 *
 * All tests run against a real ephemeral Postgres (pg-container) and a real
 * Bun server started in TEST_MODE. No vi.fn / vi.mock / vi.spyOn.
 *
 * Blueprint refs: Phase 5, issue #58.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { startE2EServer, stopE2EServer, type E2EEnvironment } from '../e2e/environment';

let env: E2EEnvironment;

beforeAll(async () => {
  env = await startE2EServer();
}, 60_000);

afterAll(async () => {
  await stopE2EServer(env);
});

// ---------------------------------------------------------------------------
// Helper: get a test session cookie
// ---------------------------------------------------------------------------

async function getTestSession(base: string, username?: string): Promise<string> {
  const body = username ? { username } : {};
  const res = await fetch(`${base}/api/test/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`test-session failed: ${res.status} ${await res.text()}`);
  const setCookie = res.headers.get('set-cookie') ?? '';
  const match = /calypso_auth=([^;]+)/.exec(setCookie);
  return match ? `calypso_auth=${match[1]}` : '';
}

// ---------------------------------------------------------------------------
// Helper: connect to the test database as a superuser
// ---------------------------------------------------------------------------

function adminSql(): ReturnType<typeof postgres> {
  return postgres(env.pg.url, {
    max: 3,
    idle_timeout: 5,
    connect_timeout: 10,
  });
}

// ---------------------------------------------------------------------------
// 1. API-mediated transcript write — persistence assertion
// ---------------------------------------------------------------------------

describe('POST /internal/ingestion/transcript — persistence', () => {
  it('creates a transcript entity row with the correct type', async () => {
    const cookie = await getTestSession(env.baseUrl, `rm_58_persist_${Date.now()}`);
    const customerId = `cust_58_${Date.now()}`;
    const transcriptText = 'Discussed Q3 fund mandate renewal and three new investor leads.';

    const res = await fetch(`${env.baseUrl}/internal/ingestion/transcript`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({
        text: transcriptText,
        customer_id: customerId,
        duration_s: 90,
        recorded_at: new Date().toISOString(),
      }),
    });

    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    expect(id).toMatch(/^[0-9a-f-]{36}$/);

    // Verify the entity row exists in the database with type 'transcript'.
    const sql = adminSql();
    try {
      const rows = await sql<{ type: string; properties: Record<string, unknown> }[]>`
        SELECT type, properties
        FROM entities
        WHERE id = ${id}
      `;
      expect(rows).toHaveLength(1);
      expect(rows[0].type).toBe('transcript');

      // The transcript text must be present in the stored properties.
      const storedText = rows[0].properties.text as string | undefined;
      expect(storedText).toBeDefined();

      // When ENCRYPTION_MASTER_KEY is set (production), the stored value starts
      // with 'enc:v1:'. In the test environment where encryption is disabled,
      // the plaintext is stored directly. Either form is valid for persistence.
      const encryptionEnabled = Boolean(process.env.ENCRYPTION_MASTER_KEY);
      if (encryptionEnabled) {
        expect(storedText).toMatch(/^enc:v1:/);
        expect(storedText).not.toBe(transcriptText);
      } else {
        // Encryption disabled in test environment — plaintext stored directly.
        expect(storedText).toBe(transcriptText);
      }

      // The customer_id must always be stored in plaintext.
      expect(rows[0].properties.customer_id).toBe(customerId);
    } finally {
      await sql.end({ timeout: 5 });
    }
  });

  it('creates both audio_recording and transcript entity types in the registry', async () => {
    // Verify via the entity_types table that both types exist after server boot.
    const sql = adminSql();
    try {
      const rows = await sql<{ type: string }[]>`
        SELECT type FROM entity_types WHERE type IN ('audio_recording', 'transcript')
        ORDER BY type
      `;
      const types = rows.map((r) => r.type);
      expect(types).toContain('audio_recording');
      expect(types).toContain('transcript');
    } finally {
      await sql.end({ timeout: 5 });
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Direct DB INSERT from worker role — assert denial
// ---------------------------------------------------------------------------

describe('Worker-role direct INSERT — denied at DB layer', () => {
  it('a role with no INSERT on entities cannot write a transcript row directly', async () => {
    // Create a minimal no-insert role in the test database. This simulates
    // the email_ingest / autolearn worker roles which are provisioned by
    // init-remote.ts with SELECT-only access on filtered views and no INSERT
    // on the entities table.
    const sql = adminSql();
    const roleName = `test_no_insert_${Date.now()}`;
    const rolePassword = 'test_only_pw';

    try {
      // Ensure the audio_recording entity type exists (it was registered at boot).
      await sql`
        INSERT INTO entity_types (type, schema, sensitive)
        VALUES ('audio_recording_test_role', '{}', '{}')
        ON CONFLICT (type) DO NOTHING
      `;

      // Create a no-login role with SELECT on entities but no INSERT.
      await sql.unsafe(`
        DO $$
        BEGIN
          IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${roleName}') THEN
            CREATE ROLE "${roleName}" WITH LOGIN PASSWORD '${rolePassword}';
          END IF;
        END
        $$
      `);

      // Grant CONNECT on the current database and SELECT on entities, but NOT INSERT.
      const dbName = new URL(env.pg.url).pathname.slice(1);
      await sql.unsafe(`GRANT CONNECT ON DATABASE "${dbName}" TO "${roleName}"`);
      await sql.unsafe(`GRANT USAGE ON SCHEMA public TO "${roleName}"`);
      await sql.unsafe(`GRANT SELECT ON entities TO "${roleName}"`);
      // Deliberately do NOT grant INSERT on entities.

      // Build a connection as the restricted role.
      const baseUrl = new URL(env.pg.url);
      baseUrl.username = roleName;
      baseUrl.password = rolePassword;
      const restrictedSql = postgres(baseUrl.toString(), {
        max: 1,
        idle_timeout: 5,
        connect_timeout: 10,
      });

      try {
        // Attempt a direct INSERT as the restricted role — must be denied.
        await expect(
          restrictedSql`
            INSERT INTO entities (id, type, properties, tenant_id)
            VALUES (
              ${crypto.randomUUID()},
              'transcript',
              ${JSON.stringify({ text: 'direct write attempt', customer_id: 'cust_test', source: 'edge_device', recorded_at: new Date().toISOString() })},
              'tenant_test'
            )
          `,
        ).rejects.toThrow();
      } finally {
        await restrictedSql.end({ timeout: 5 });
      }
    } finally {
      // Clean up the test role.
      await sql.unsafe(`DROP ROLE IF EXISTS "${roleName}"`).catch(() => {
        // Ignore cleanup errors — the ephemeral container will be destroyed anyway.
      });
      await sql.end({ timeout: 5 });
    }
  });
});

// ---------------------------------------------------------------------------
// 3. AudioRecording schema — no raw audio column
// ---------------------------------------------------------------------------

describe('audio_recording entity type — no raw audio column', () => {
  it('audio_recording schema has no raw audio property', async () => {
    // Prohibited property names — any of these indicate raw audio storage.
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

    const sql = adminSql();
    try {
      const rows = await sql<{ schema: Record<string, unknown> }[]>`
        SELECT schema FROM entity_types WHERE type = 'audio_recording'
      `;
      expect(rows).toHaveLength(1);

      const schema = rows[0].schema as {
        properties?: Record<string, unknown>;
        additionalProperties?: unknown;
      };

      // If schema has a properties object, check none of the prohibited keys appear.
      if (schema.properties) {
        for (const prohibited of PROHIBITED_AUDIO_PROPERTIES) {
          expect(
            prohibited in schema.properties,
            `audio_recording schema must not include property "${prohibited}" (raw audio is forbidden)`,
          ).toBe(false);
        }
      }

      // The schema must have additionalProperties: false to enforce the no-audio invariant.
      expect(schema.additionalProperties).toBe(false);
    } finally {
      await sql.end({ timeout: 5 });
    }
  });

  it('audio_recording has no sensitive fields — raw audio is never stored', async () => {
    const sql = adminSql();
    try {
      const rows = await sql<{ sensitive: string[] }[]>`
        SELECT sensitive FROM entity_types WHERE type = 'audio_recording'
      `;
      expect(rows).toHaveLength(1);

      // The sensitive array must be empty — there are no fields to encrypt because
      // no PII or confidential data (including audio) is stored in this entity type.
      expect(rows[0].sensitive).toEqual([]);
    } finally {
      await sql.end({ timeout: 5 });
    }
  });

  it('a POST to the transcript endpoint does not create an entity row with audio properties', async () => {
    const cookie = await getTestSession(env.baseUrl, `rm_58_noaudio_${Date.now()}`);

    const res = await fetch(`${env.baseUrl}/internal/ingestion/transcript`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({
        text: 'Portfolio review — no audio bytes here.',
        customer_id: `cust_noaudio_${Date.now()}`,
        recorded_at: new Date().toISOString(),
      }),
    });

    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };

    const sql = adminSql();
    try {
      const rows = await sql<{ properties: Record<string, unknown> }[]>`
        SELECT properties FROM entities WHERE id = ${id}
      `;
      expect(rows).toHaveLength(1);

      const props = rows[0].properties;
      const prohibitedKeys = ['audio', 'raw_audio', 'audio_bytes', 'audio_data', 'blob'];
      for (const key of prohibitedKeys) {
        expect(
          key in props,
          `Entity properties must not contain "${key}" (raw audio is forbidden)`,
        ).toBe(false);
      }
    } finally {
      await sql.end({ timeout: 5 });
    }
  });
});
