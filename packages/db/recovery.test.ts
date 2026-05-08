/**
 * Integration tests for the key-recovery passphrase module (AUTH-C-016/017).
 *
 * Covers issue #12 test plan item:
 *   TP-4: Integration test — key recovery completes successfully with valid
 *         passphrase + existing passkey credential revocation.
 *
 * This test exercises the database layer of the recovery flow:
 *   1. hashPassphrase / verifyPassphrase — pure PBKDF2 derivation (no DB)
 *   2. setRecoveryPassphrase / checkRecoveryPassphrase — DB round-trip
 *   3. revokeOldPasskeys — old credentials removed, new one preserved
 *   4. notifyDevicesOfRecovery — notification emitted (best-effort log)
 *
 * The WebAuthn assertion step (second factor) is tested via the HTTP API in
 * apps/server/tests/integration/auth-security.spec.ts (recovery/begin returns
 * a challenge; recovery/complete is validated end-to-end there for the
 * passphrase leg). The full ceremony with a signed assertion is excluded from
 * this test file because it requires real authenticator hardware; the test
 * instead verifies all DB-side mechanics that surround the assertion check.
 *
 * No mocks. Real Postgres container.
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import postgres from 'postgres';
import { startPostgres, type PgContainer } from './pg-container';
import { migrate } from './index';
import {
  hashPassphrase,
  verifyPassphrase,
  setRecoveryPassphrase,
  checkRecoveryPassphrase,
  revokeOldPasskeys,
  notifyDevicesOfRecovery,
} from './recovery';

// ---------------------------------------------------------------------------
// Test infrastructure
// ---------------------------------------------------------------------------

let pg: PgContainer;
let db: ReturnType<typeof postgres>;

beforeAll(async () => {
  pg = await startPostgres();
  db = postgres(pg.url, { max: 5 });
  await migrate({ databaseUrl: pg.url });
}, 60_000);

afterAll(async () => {
  await db?.end({ timeout: 5 });
  await pg?.stop();
});

// ---------------------------------------------------------------------------
// Helper: seed an entity (user) row
// ---------------------------------------------------------------------------

async function seedUser(username: string): Promise<string> {
  const userId = crypto.randomUUID();
  await db`
    INSERT INTO entities (id, type, properties, tenant_id)
    VALUES (${userId}, 'user', ${db.json({ username }) as never}, null)
    ON CONFLICT DO NOTHING
  `;
  return userId;
}

// ---------------------------------------------------------------------------
// hashPassphrase / verifyPassphrase — pure PBKDF2 logic
// ---------------------------------------------------------------------------

describe('hashPassphrase and verifyPassphrase (pure functions)', () => {
  test('hashPassphrase returns a non-empty string', async () => {
    const hash = await hashPassphrase('correct-horse-battery-staple');
    expect(typeof hash).toBe('string');
    expect(hash.length).toBeGreaterThan(0);
  });

  test('hash format is pbkdf2-sha256$<iterations>$<salt>$<key>', async () => {
    const hash = await hashPassphrase('test-passphrase-for-format');
    const parts = hash.split('$');
    expect(parts[0]).toBe('pbkdf2-sha256');
    expect(parseInt(parts[1], 10)).toBe(210_000);
    expect(parts[2].length).toBeGreaterThan(0);
    expect(parts[3].length).toBeGreaterThan(0);
  });

  test('two calls with the same passphrase produce different hashes (random salt)', async () => {
    const hash1 = await hashPassphrase('same-passphrase');
    const hash2 = await hashPassphrase('same-passphrase');
    expect(hash1).not.toBe(hash2);
  });

  test('verifyPassphrase returns true for the correct passphrase', async () => {
    const passphrase = 'correct-horse-battery-staple-2026';
    const hash = await hashPassphrase(passphrase);
    expect(await verifyPassphrase(passphrase, hash)).toBe(true);
  });

  test('verifyPassphrase returns false for a wrong passphrase', async () => {
    const hash = await hashPassphrase('original-passphrase');
    expect(await verifyPassphrase('wrong-passphrase', hash)).toBe(false);
  });

  test('verifyPassphrase returns false for a malformed hash', async () => {
    expect(await verifyPassphrase('passphrase', 'not-a-valid-hash')).toBe(false);
    expect(await verifyPassphrase('passphrase', '')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// setRecoveryPassphrase / checkRecoveryPassphrase — DB round-trip
// ---------------------------------------------------------------------------

describe('setRecoveryPassphrase and checkRecoveryPassphrase (DB)', () => {
  test('setRecoveryPassphrase stores a passphrase and checkRecoveryPassphrase verifies it', async () => {
    const userId = await seedUser(`recovery-set-${Date.now()}`);
    const passphrase = 'my-super-long-recovery-passphrase-2026';

    await setRecoveryPassphrase(userId, passphrase, db);

    const valid = await checkRecoveryPassphrase(userId, passphrase, db);
    expect(valid).toBe(true);
  });

  test('checkRecoveryPassphrase returns false for wrong passphrase', async () => {
    const userId = await seedUser(`recovery-wrong-${Date.now()}`);
    await setRecoveryPassphrase(userId, 'correct-passphrase-for-user', db);

    const valid = await checkRecoveryPassphrase(userId, 'wrong-passphrase', db);
    expect(valid).toBe(false);
  });

  test('checkRecoveryPassphrase returns false when no passphrase is stored', async () => {
    const userId = await seedUser(`recovery-none-${Date.now()}`);
    const valid = await checkRecoveryPassphrase(userId, 'any-passphrase', db);
    expect(valid).toBe(false);
  });

  test('setRecoveryPassphrase replaces any prior passphrase (only one active at a time)', async () => {
    const userId = await seedUser(`recovery-replace-${Date.now()}`);

    await setRecoveryPassphrase(userId, 'old-passphrase', db);
    await setRecoveryPassphrase(userId, 'new-passphrase', db);

    // Old passphrase must no longer work
    expect(await checkRecoveryPassphrase(userId, 'old-passphrase', db)).toBe(false);
    // New passphrase must work
    expect(await checkRecoveryPassphrase(userId, 'new-passphrase', db)).toBe(true);

    // Only one row should exist
    const rows = await db<{ count: string }[]>`
      SELECT COUNT(*) AS count FROM recovery_passphrases WHERE user_id = ${userId}
    `;
    expect(parseInt(rows[0].count, 10)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// revokeOldPasskeys — credential revocation on re-enrollment
// ---------------------------------------------------------------------------

describe('revokeOldPasskeys (DB)', () => {
  async function seedCredential(userId: string, credentialId: string): Promise<void> {
    const fakePublicKey = Buffer.from([0x04, ...new Array(64).fill(0)]);
    await db`
      INSERT INTO passkey_credentials (user_id, credential_id, public_key, counter, aaguid, transports)
      VALUES (${userId}, ${credentialId}, ${fakePublicKey}, 0, '', '{}')
      ON CONFLICT DO NOTHING
    `;
  }

  test('revokeOldPasskeys removes all credentials except the new one', async () => {
    const userId = await seedUser(`revoke-creds-${Date.now()}`);
    const oldCred1 = `old-cred-1-${Date.now()}`;
    const oldCred2 = `old-cred-2-${Date.now()}`;
    const newCred = `new-cred-${Date.now()}`;

    await seedCredential(userId, oldCred1);
    await seedCredential(userId, oldCred2);
    await seedCredential(userId, newCred);

    // After recovery, old credentials should be revoked
    await revokeOldPasskeys(userId, newCred, db);

    const remaining = await db<{ credential_id: string }[]>`
      SELECT credential_id FROM passkey_credentials WHERE user_id = ${userId}
    `;
    const credIds = remaining.map((r) => r.credential_id);
    expect(credIds).toContain(newCred);
    expect(credIds).not.toContain(oldCred1);
    expect(credIds).not.toContain(oldCred2);
  });

  test('revokeOldPasskeys with null keepCredentialId removes all credentials', async () => {
    const userId = await seedUser(`revoke-all-${Date.now()}`);
    const cred1 = `cred-1-${Date.now()}`;
    const cred2 = `cred-2-${Date.now()}`;

    await seedCredential(userId, cred1);
    await seedCredential(userId, cred2);

    await revokeOldPasskeys(userId, null, db);

    const remaining = await db<{ credential_id: string }[]>`
      SELECT credential_id FROM passkey_credentials WHERE user_id = ${userId}
    `;
    expect(remaining.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// notifyDevicesOfRecovery — notification emission
// ---------------------------------------------------------------------------

describe('notifyDevicesOfRecovery', () => {
  test('notifyDevicesOfRecovery resolves without error', async () => {
    // The function logs to console (best-effort, no real push notifications in Phase 1)
    await expect(notifyDevicesOfRecovery('user-notify-test')).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// End-to-end recovery DB flow (TP-4)
// ---------------------------------------------------------------------------

describe('key recovery DB flow end-to-end (TP-4)', () => {
  test('full recovery sequence: set passphrase → verify → revoke old → notify', async () => {
    const userId = await seedUser(`recovery-e2e-${Date.now()}`);
    const oldCred = `old-cred-e2e-${Date.now()}`;
    const newCred = `new-cred-e2e-${Date.now()}`;
    const passphrase = 'valid-recovery-passphrase-long-enough';

    // 1. User previously set up a recovery passphrase
    await setRecoveryPassphrase(userId, passphrase, db);

    // 2. User has an existing passkey credential
    const fakePublicKey = Buffer.from([0x04, ...new Array(64).fill(0)]);
    await db`
      INSERT INTO passkey_credentials (user_id, credential_id, public_key, counter, aaguid, transports)
      VALUES (${userId}, ${oldCred}, ${fakePublicKey}, 0, '', '{}')
    `;

    // 3. Recovery begins: user provides the correct passphrase
    //    (In the real flow: also submits a WebAuthn assertion as second factor)
    const passphraseOk = await checkRecoveryPassphrase(userId, passphrase, db);
    expect(passphraseOk).toBe(true);

    // 4. Recovery completes: new passkey enrolled, old ones revoked
    //    (In the real flow: WebAuthn registration of the new credential)
    const fakeNewPublicKey = Buffer.from([0x04, ...new Array(64).fill(1)]);
    await db`
      INSERT INTO passkey_credentials (user_id, credential_id, public_key, counter, aaguid, transports)
      VALUES (${userId}, ${newCred}, ${fakeNewPublicKey}, 0, '', '{}')
    `;
    await revokeOldPasskeys(userId, newCred, db);
    await notifyDevicesOfRecovery(userId);

    // Verify: new credential persists, old credential is gone
    const creds = await db<{ credential_id: string }[]>`
      SELECT credential_id FROM passkey_credentials WHERE user_id = ${userId}
    `;
    expect(creds.map((c) => c.credential_id)).toContain(newCred);
    expect(creds.map((c) => c.credential_id)).not.toContain(oldCred);
  });
});
