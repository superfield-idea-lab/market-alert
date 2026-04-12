/**
 * Integration tests for the AssemblyAI legacy transcription gate (issue #60).
 *
 * Covers acceptance criteria:
 *   - assemblyai_legacy_enabled defaults off for all tenants
 *   - Regulated tenants cannot enable the flag (RegulatedTenantError)
 *   - Non-regulated tenants can enable the flag
 *   - Setting regulated=true auto-disables assemblyai_legacy_enabled
 *   - isAssemblyAiLegacyEnabled returns true only when explicitly enabled
 *   - isTenantRegulated returns false by default
 *   - getTenantConfig returns a correct snapshot
 *
 * All tests run against a real ephemeral Postgres container — no mocks.
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import postgres from 'postgres';
import { startPostgres, type PgContainer } from './pg-container';
import { migrate } from './index';
import {
  isTenantRegulated,
  isAssemblyAiLegacyEnabled,
  setTenantRegulated,
  setAssemblyAiLegacyEnabled,
  getTenantConfig,
  RegulatedTenantError,
} from './tenant-config';

let pg: PgContainer;
let sql: ReturnType<typeof postgres>;

beforeAll(async () => {
  pg = await startPostgres();
  sql = postgres(pg.url, { max: 5 });
  await migrate({ databaseUrl: pg.url });
}, 60_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 });
  await pg?.stop();
});

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

describe('defaults', () => {
  test('isTenantRegulated returns false for a new tenant', async () => {
    const tenantId = `tenant-reg-default-${Date.now()}`;
    const result = await isTenantRegulated(tenantId, sql);
    expect(result).toBe(false);
  });

  test('isAssemblyAiLegacyEnabled returns false for a new tenant', async () => {
    const tenantId = `tenant-aai-default-${Date.now()}`;
    const result = await isAssemblyAiLegacyEnabled(tenantId, sql);
    expect(result).toBe(false);
  });

  test('getTenantConfig returns all-false snapshot for a new tenant', async () => {
    const tenantId = `tenant-cfg-default-${Date.now()}`;
    const config = await getTenantConfig(tenantId, sql);
    expect(config.tenantId).toBe(tenantId);
    expect(config.regulated).toBe(false);
    expect(config.assemblyai_legacy_enabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Regulated tenant gate
// ---------------------------------------------------------------------------

describe('regulated tenant gate', () => {
  test('setTenantRegulated marks a tenant as regulated', async () => {
    const tenantId = `tenant-mark-regulated-${Date.now()}`;
    await setTenantRegulated(tenantId, true, sql);
    const result = await isTenantRegulated(tenantId, sql);
    expect(result).toBe(true);
  });

  test('setTenantRegulated can un-regulate a tenant', async () => {
    const tenantId = `tenant-unregulate-${Date.now()}`;
    await setTenantRegulated(tenantId, true, sql);
    await setTenantRegulated(tenantId, false, sql);
    const result = await isTenantRegulated(tenantId, sql);
    expect(result).toBe(false);
  });

  test('setAssemblyAiLegacyEnabled throws RegulatedTenantError for regulated tenant', async () => {
    const tenantId = `tenant-regulated-block-${Date.now()}`;
    await setTenantRegulated(tenantId, true, sql);

    await expect(setAssemblyAiLegacyEnabled(tenantId, true, sql)).rejects.toThrow(
      RegulatedTenantError,
    );
  });

  test('RegulatedTenantError message contains the tenant id', async () => {
    const tenantId = `tenant-regulated-msg-${Date.now()}`;
    await setTenantRegulated(tenantId, true, sql);

    await expect(setAssemblyAiLegacyEnabled(tenantId, true, sql)).rejects.toThrow(tenantId);
  });

  test('assemblyai_legacy_enabled remains false after rejected enable attempt on regulated tenant', async () => {
    const tenantId = `tenant-no-leak-${Date.now()}`;
    await setTenantRegulated(tenantId, true, sql);

    try {
      await setAssemblyAiLegacyEnabled(tenantId, true, sql);
    } catch {
      // expected
    }

    const enabled = await isAssemblyAiLegacyEnabled(tenantId, sql);
    expect(enabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Non-regulated tenant — enable / disable
// ---------------------------------------------------------------------------

describe('non-regulated tenant', () => {
  test('setAssemblyAiLegacyEnabled enables the flag for a non-regulated tenant', async () => {
    const tenantId = `tenant-enable-${Date.now()}`;
    await setAssemblyAiLegacyEnabled(tenantId, true, sql);
    const result = await isAssemblyAiLegacyEnabled(tenantId, sql);
    expect(result).toBe(true);
  });

  test('setAssemblyAiLegacyEnabled disables the flag when called with false', async () => {
    const tenantId = `tenant-disable-${Date.now()}`;
    await setAssemblyAiLegacyEnabled(tenantId, true, sql);
    await setAssemblyAiLegacyEnabled(tenantId, false, sql);
    const result = await isAssemblyAiLegacyEnabled(tenantId, sql);
    expect(result).toBe(false);
  });

  test('getTenantConfig reflects enabled flag', async () => {
    const tenantId = `tenant-cfg-enabled-${Date.now()}`;
    await setAssemblyAiLegacyEnabled(tenantId, true, sql);
    const config = await getTenantConfig(tenantId, sql);
    expect(config.assemblyai_legacy_enabled).toBe(true);
    expect(config.regulated).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Setting regulated=true auto-disables assemblyai_legacy_enabled
// ---------------------------------------------------------------------------

describe('auto-disable on regulate', () => {
  test('marking a tenant regulated auto-disables assemblyai_legacy_enabled', async () => {
    const tenantId = `tenant-autooff-${Date.now()}`;

    // Enable AssemblyAI first.
    await setAssemblyAiLegacyEnabled(tenantId, true, sql);
    expect(await isAssemblyAiLegacyEnabled(tenantId, sql)).toBe(true);

    // Mark as regulated — must auto-disable AssemblyAI.
    await setTenantRegulated(tenantId, true, sql);

    const config = await getTenantConfig(tenantId, sql);
    expect(config.regulated).toBe(true);
    expect(config.assemblyai_legacy_enabled).toBe(false);
  });

  test('marking a tenant un-regulated does NOT re-enable assemblyai_legacy_enabled', async () => {
    const tenantId = `tenant-unreg-norestore-${Date.now()}`;

    await setAssemblyAiLegacyEnabled(tenantId, true, sql);
    await setTenantRegulated(tenantId, true, sql); // disables it
    await setTenantRegulated(tenantId, false, sql); // un-regulate

    // Flag should still be false — un-regulating does not restore it.
    const enabled = await isAssemblyAiLegacyEnabled(tenantId, sql);
    expect(enabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

describe('idempotency', () => {
  test('setTenantRegulated is idempotent', async () => {
    const tenantId = `tenant-idem-reg-${Date.now()}`;
    await setTenantRegulated(tenantId, true, sql);
    await setTenantRegulated(tenantId, true, sql); // second call — no error
    const result = await isTenantRegulated(tenantId, sql);
    expect(result).toBe(true);
  });

  test('setAssemblyAiLegacyEnabled is idempotent', async () => {
    const tenantId = `tenant-idem-aai-${Date.now()}`;
    await setAssemblyAiLegacyEnabled(tenantId, true, sql);
    await setAssemblyAiLegacyEnabled(tenantId, true, sql); // second call — no error
    const result = await isAssemblyAiLegacyEnabled(tenantId, sql);
    expect(result).toBe(true);
  });
});
