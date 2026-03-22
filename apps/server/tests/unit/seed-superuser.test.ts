import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { _resetSecretsForTest, _seedSecretForTest } from '../../src/secrets/index';
import { seedSuperuser } from '../../src/seed/superuser';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal fake postgres.js SQL tagged-template object. */
function makeSql(overrides: Partial<ReturnType<typeof makeSql>> = {}) {
  const insertedRows: unknown[] = [];

  // The sql() call must be usable as a tagged template (sql`...`) which in
  // postgres.js returns a promise-like query object. We simulate that here.
  const sql = vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
    const raw = strings.join('?');

    // Distinguish between SELECT and INSERT by inspecting the query text.
    if (raw.trim().toUpperCase().startsWith('SELECT')) {
      return Promise.resolve(overrides.selectResult ?? []);
    }

    // INSERT
    insertedRows.push(values);
    return Promise.resolve([]);
  }) as unknown as {
    (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]>;
    json: (v: unknown) => unknown;
    insertedRows: unknown[];
  };

  (sql as unknown as Record<string, unknown>).json = (v: unknown) => v;
  (sql as unknown as Record<string, unknown>).insertedRows = insertedRows;

  return sql;
}

// ---------------------------------------------------------------------------

describe('seedSuperuser()', () => {
  beforeEach(() => {
    _resetSecretsForTest();
  });

  afterEach(() => {
    _resetSecretsForTest();
    vi.restoreAllMocks();
  });

  test('skips seeding when a superuser already exists', async () => {
    const sql = makeSql({ selectResult: [{ id: 'existing-id' }] });
    _seedSecretForTest('SUPERUSER_EMAIL', 'admin@example.com');
    _seedSecretForTest('SUPERUSER_PASSWORD', 'securepassword');

    await seedSuperuser({ sql: sql as unknown as import('postgres').Sql });

    // No INSERT should have been attempted
    const calls = vi.mocked(sql as unknown as ReturnType<typeof vi.fn>).mock.calls;
    const insertCall = calls.find((c) => {
      const strings = c[0] as TemplateStringsArray;
      return strings?.join?.('').toUpperCase().includes('INSERT');
    });
    expect(insertCall).toBeUndefined();
  });

  test('skips seeding when SUPERUSER_EMAIL is not set', async () => {
    const sql = makeSql({ selectResult: [] });

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await seedSuperuser({ sql: sql as unknown as import('postgres').Sql });

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('SUPERUSER_EMAIL is not set'));
  });

  test('skips seeding when neither password nor mnemonic is set', async () => {
    const sql = makeSql({ selectResult: [] });
    _seedSecretForTest('SUPERUSER_EMAIL', 'admin@example.com');

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await seedSuperuser({ sql: sql as unknown as import('postgres').Sql });

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Neither SUPERUSER_PASSWORD nor SUPERUSER_MNEMONIC'),
    );
  });

  test('creates superuser using SUPERUSER_PASSWORD when set', async () => {
    const insertedRows: unknown[] = [];
    const sql = vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
      const raw = strings.join('');
      if (raw.trim().toUpperCase().startsWith('SELECT')) {
        return Promise.resolve([]);
      }
      insertedRows.push(values);
      return Promise.resolve([]);
    }) as unknown as import('postgres').Sql;
    (sql as unknown as Record<string, unknown>).json = (v: unknown) => v;

    _seedSecretForTest('SUPERUSER_EMAIL', 'admin@example.com');
    _seedSecretForTest('SUPERUSER_PASSWORD', 'securepassword');

    await seedSuperuser({ sql });

    expect(insertedRows.length).toBe(1);
  });

  test('creates superuser using SUPERUSER_MNEMONIC when no password is set', async () => {
    const insertedRows: unknown[] = [];
    const sql = vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
      const raw = strings.join('');
      if (raw.trim().toUpperCase().startsWith('SELECT')) {
        return Promise.resolve([]);
      }
      insertedRows.push(values);
      return Promise.resolve([]);
    }) as unknown as import('postgres').Sql;
    (sql as unknown as Record<string, unknown>).json = (v: unknown) => v;

    _seedSecretForTest('SUPERUSER_EMAIL', 'admin@example.com');
    _seedSecretForTest(
      'SUPERUSER_MNEMONIC',
      'word1 word2 word3 word4 word5 word6 word7 word8 word9 word10 word11 word12',
    );

    await seedSuperuser({ sql });

    expect(insertedRows.length).toBe(1);
  });

  test('SUPERUSER_PASSWORD takes precedence over SUPERUSER_MNEMONIC', async () => {
    const hashSpy = vi.spyOn(Bun.password, 'hash');

    const sql = vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
      void values;
      const raw = strings.join('');
      if (raw.trim().toUpperCase().startsWith('SELECT')) {
        return Promise.resolve([]);
      }
      return Promise.resolve([]);
    }) as unknown as import('postgres').Sql;
    (sql as unknown as Record<string, unknown>).json = (v: unknown) => v;

    _seedSecretForTest('SUPERUSER_EMAIL', 'admin@example.com');
    _seedSecretForTest('SUPERUSER_PASSWORD', 'explicit-password');
    _seedSecretForTest('SUPERUSER_MNEMONIC', 'word1 word2 word3');

    await seedSuperuser({ sql });

    // hash() should have been called with the password, not the mnemonic
    expect(hashSpy).toHaveBeenCalledWith('explicit-password');
    expect(hashSpy).not.toHaveBeenCalledWith('word1 word2 word3');
  });
});
