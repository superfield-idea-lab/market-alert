import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  seedDemoPersonas,
  DEMO_PERSONAS,
  type SeedDemoPersonasOptions,
} from '../../src/seed/demo-personas';

type MockSql = SeedDemoPersonasOptions['sql'];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal fake SQL tagged-template that records inserts and can simulate existing rows. */
function makeSql(existingEmails: string[] = []) {
  const insertedRows: unknown[] = [];

  const fn = vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
    const raw = strings.join('');

    if (raw.trim().toUpperCase().startsWith('SELECT')) {
      // Check if the queried email is in the existing set.
      // The email value is the last positional param in the tagged template.
      const queriedEmail = values.find((v) => typeof v === 'string' && v.includes('@'));
      if (queriedEmail && existingEmails.includes(queriedEmail as string)) {
        return Promise.resolve([{ id: 'existing-id' }]);
      }
      return Promise.resolve([]);
    }

    // INSERT / other
    insertedRows.push(values);
    return Promise.resolve([]);
  });

  (fn as unknown as Record<string, unknown>).json = (v: unknown) => v;
  (fn as unknown as Record<string, unknown>).insertedRows = insertedRows;

  return fn as unknown as MockSql & { insertedRows: unknown[] };
}

// ---------------------------------------------------------------------------

describe('seedDemoPersonas()', () => {
  const originalDemoMode = process.env.DEMO_MODE;

  beforeEach(() => {
    delete process.env.DEMO_MODE;
  });

  afterEach(() => {
    if (originalDemoMode !== undefined) {
      process.env.DEMO_MODE = originalDemoMode;
    } else {
      delete process.env.DEMO_MODE;
    }
    vi.restoreAllMocks();
  });

  test('does nothing when DEMO_MODE is not set', async () => {
    const sql = makeSql();
    await seedDemoPersonas({ sql });

    // No SQL calls should have been made at all
    expect(vi.mocked(sql as unknown as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  test('does nothing when DEMO_MODE is "false"', async () => {
    process.env.DEMO_MODE = 'false';
    const sql = makeSql();
    await seedDemoPersonas({ sql });

    expect(vi.mocked(sql as unknown as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  test('seeds both demo personas when DEMO_MODE=true and none exist', async () => {
    process.env.DEMO_MODE = 'true';
    const sql = makeSql();

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await seedDemoPersonas({ sql });

    // Two personas should have been inserted
    expect(sql.insertedRows.length).toBe(2);

    // Credentials should be logged
    const logCalls = logSpy.mock.calls.map((c) => c[0]);
    const credentialLogs = logCalls.filter(
      (msg) => typeof msg === 'string' && msg.includes('password='),
    );
    expect(credentialLogs.length).toBe(DEMO_PERSONAS.length);
  });

  test('skips existing persona and seeds missing one', async () => {
    process.env.DEMO_MODE = 'true';
    // Simulate the admin already existing
    const sql = makeSql(['demo-admin@calypso.local']);

    vi.spyOn(console, 'log').mockImplementation(() => {});
    await seedDemoPersonas({ sql });

    // Only the regular user should have been inserted
    expect(sql.insertedRows.length).toBe(1);
  });

  test('is idempotent — skips all when both personas already exist', async () => {
    process.env.DEMO_MODE = 'true';
    const sql = makeSql(['demo-admin@calypso.local', 'demo-user@calypso.local']);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await seedDemoPersonas({ sql });

    // No inserts
    expect(sql.insertedRows.length).toBe(0);

    // Should log that each was skipped
    const logCalls = logSpy.mock.calls.map((c) => c[0]);
    const skipLogs = logCalls.filter(
      (msg) => typeof msg === 'string' && msg.includes('already exists'),
    );
    expect(skipLogs.length).toBe(2);
  });

  test('demo personas include a superuser and a regular user', () => {
    const roles = DEMO_PERSONAS.map((p) => p.role);
    expect(roles).toContain('superuser');
    expect(roles).toContain('user');
  });

  test('logs credentials to console on successful seed', async () => {
    process.env.DEMO_MODE = 'true';
    const sql = makeSql();

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await seedDemoPersonas({ sql });

    const logCalls = logSpy.mock.calls.map((c) => c[0]);

    // Should log credential header
    expect(logCalls).toContain('[demo] Demo credentials:');

    // Should log each persona's email and password
    for (const persona of DEMO_PERSONAS) {
      const found = logCalls.some(
        (msg) =>
          typeof msg === 'string' && msg.includes(persona.email) && msg.includes(persona.password),
      );
      expect(found).toBe(true);
    }
  });
});
