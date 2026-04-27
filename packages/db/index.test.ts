import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { pathToFileURL } from 'url';
import { describe, expect, it } from 'vitest';
import { resolveDatabaseUrls, resolveSchemaSqlPath, splitSqlStatements } from './index';

describe('resolveDatabaseUrls', () => {
  it('uses localhost defaults when only DATABASE_URL is unset', () => {
    expect(resolveDatabaseUrls({} as NodeJS.ProcessEnv)).toEqual({
      app: 'postgres://app_rw:app_rw_password@localhost:5432/superfield_app',
      audit: 'postgres://audit_w:audit_w_password@localhost:5432/superfield_audit',
      analytics: 'postgres://analytics_w:analytics_w_password@localhost:5432/superfield_analytics',
      dictionary: 'postgres://dict_rw:dict_rw_password@localhost:5432/superfield_dictionary',
    });
  });

  it('respects explicit pool environment overrides', () => {
    expect(
      resolveDatabaseUrls({
        DATABASE_URL: 'postgres://app@example/superfield_app',
        AUDIT_DATABASE_URL: 'postgres://audit@example/superfield_audit',
        ANALYTICS_DATABASE_URL: 'postgres://analytics@example/superfield_analytics',
        DICTIONARY_DATABASE_URL: 'postgres://dict@example/superfield_dictionary',
      } as NodeJS.ProcessEnv),
    ).toEqual({
      app: 'postgres://app@example/superfield_app',
      audit: 'postgres://audit@example/superfield_audit',
      analytics: 'postgres://analytics@example/superfield_analytics',
      dictionary: 'postgres://dict@example/superfield_dictionary',
    });
  });

  it('falls back independently when audit, analytics or dictionary URLs are missing', () => {
    expect(
      resolveDatabaseUrls({
        DATABASE_URL: 'postgres://app@example/superfield_app',
        AUDIT_DATABASE_URL: 'postgres://audit@example/superfield_audit',
      } as NodeJS.ProcessEnv),
    ).toEqual({
      app: 'postgres://app@example/superfield_app',
      audit: 'postgres://audit@example/superfield_audit',
      analytics: 'postgres://analytics_w:analytics_w_password@localhost:5432/superfield_analytics',
      dictionary: 'postgres://dict_rw:dict_rw_password@localhost:5432/superfield_dictionary',
    });
  });
});

describe('splitSqlStatements', () => {
  it('splits simple statements on semicolons', () => {
    expect(splitSqlStatements('SELECT 1; SELECT 2')).toEqual(['SELECT 1', 'SELECT 2']);
  });

  it('does not split inside dollar-quoted blocks', () => {
    const sql = `
CREATE OR REPLACE FUNCTION foo()
  RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('chan', NEW.id::TEXT);
  RETURN NEW;
END
$$;
SELECT 1
`.trim();
    const parts = splitSqlStatements(sql);
    expect(parts).toHaveLength(2);
    expect(parts[0]).toContain('PERFORM pg_notify');
    expect(parts[1]).toBe('SELECT 1');
  });

  it('returns an empty array for blank input', () => {
    expect(splitSqlStatements('   ')).toEqual([]);
  });

  it('handles trailing content without a final semicolon', () => {
    expect(splitSqlStatements('SELECT 1; SELECT 2')).toContain('SELECT 2');
  });
});

describe('resolveSchemaSqlPath', () => {
  it('prefers schema.sql adjacent to the module', () => {
    expect(resolveSchemaSqlPath(import.meta.url)).toMatch(/packages\/db\/schema\.sql$/);
  });

  it('falls back to packaged schema.sql when running from a bundled dist directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'superfield-schema-path-'));
    const distDir = join(root, 'dist');
    const packagedDir = join(root, 'packages', 'db');
    mkdirSync(distDir, { recursive: true });
    mkdirSync(packagedDir, { recursive: true });
    writeFileSync(join(packagedDir, 'schema.sql'), '-- test schema');

    try {
      expect(resolveSchemaSqlPath(pathToFileURL(join(distDir, 'server.js')).href, root)).toBe(
        join(packagedDir, 'schema.sql'),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
