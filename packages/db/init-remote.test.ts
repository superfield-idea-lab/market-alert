import { beforeEach, describe, expect, it } from 'vitest';
import {
  agentRoleName,
  agentViewName,
  dbUrl,
  escapeSqlLiteral,
  loadInitRemoteConfig,
  sslOptions,
} from './init-remote';

describe('init-remote helpers', () => {
  beforeEach(() => {
    delete process.env.DB_SSL;
    delete process.env.DB_CA_CERT;
  });

  it('escapes single quotes for DDL literals', () => {
    expect(escapeSqlLiteral("o'hara")).toBe("o''hara");
  });

  it('retargets the admin URL to a specific database', () => {
    expect(
      dbUrl('postgres://admin:secret@example.com:5432/postgres?sslmode=require', 'superfield_app'),
    ).toBe('postgres://admin:secret@example.com:5432/superfield_app?sslmode=require');
  });

  it('derives SSL options from DB_SSL and DB_CA_CERT', () => {
    process.env.DB_SSL = 'verify-full';
    process.env.DB_CA_CERT = '---CERT---';

    expect(sslOptions()).toEqual({
      rejectUnauthorized: true,
      ca: '---CERT---',
    });
  });

  it('validates required init-remote environment variables', () => {
    expect(() => loadInitRemoteConfig({} as NodeJS.ProcessEnv)).toThrow(
      'Missing required environment variables',
    );
  });

  it('requires DICT_RW_PASSWORD', () => {
    expect(() =>
      loadInitRemoteConfig({
        ADMIN_DATABASE_URL: 'postgres://admin:secret@example.com/postgres',
        APP_RW_PASSWORD: 'app_pw',
        AUDIT_W_PASSWORD: 'audit_pw',
        ANALYTICS_W_PASSWORD: 'analytics_pw',
        // Deliberately omit DICT_RW_PASSWORD and agent passwords
      } as NodeJS.ProcessEnv),
    ).toThrow('DICT_RW_PASSWORD');
  });

  it('requires AGENT_EMAIL_INGEST_PASSWORD', () => {
    expect(() =>
      loadInitRemoteConfig({
        ADMIN_DATABASE_URL: 'postgres://admin:secret@example.com/postgres',
        APP_RW_PASSWORD: 'app_pw',
        AUDIT_W_PASSWORD: 'audit_pw',
        ANALYTICS_W_PASSWORD: 'analytics_pw',
        DICT_RW_PASSWORD: 'dict_pw',
        // Deliberately omit agent passwords
      } as NodeJS.ProcessEnv),
    ).toThrow('AGENT_EMAIL_INGEST_PASSWORD');
  });

  it('applies default database names when optional env vars are absent', () => {
    expect(
      loadInitRemoteConfig({
        ADMIN_DATABASE_URL: 'postgres://admin:secret@example.com/postgres',
        APP_RW_PASSWORD: 'app_pw',
        AUDIT_W_PASSWORD: 'audit_pw',
        ANALYTICS_W_PASSWORD: 'analytics_pw',
        DICT_RW_PASSWORD: 'dict_pw',
        AGENT_EMAIL_INGEST_PASSWORD: 'email_ingest_pw',
      } as NodeJS.ProcessEnv),
    ).toEqual({
      adminDatabaseUrl: 'postgres://admin:secret@example.com/postgres',
      passwords: {
        app: 'app_pw',
        audit: 'audit_pw',
        analytics: 'analytics_pw',
        complianceOfficer: 'app_pw',
        dictionary: 'dict_pw',
        agents: {
          email_ingest: 'email_ingest_pw',
        },
      },
      databases: {
        app: 'superfield_app',
        audit: 'superfield_audit',
        analytics: 'superfield_analytics',
        dictionary: 'superfield_dictionary',
      },
    });
  });

  it('derives per-type agent role name from agent type', () => {
    expect(agentRoleName('email_ingest')).toBe('agent_email_ingest');
  });

  it('derives per-type view name from agent type', () => {
    expect(agentViewName('email_ingest')).toBe('task_queue_view_email_ingest');
  });
});
