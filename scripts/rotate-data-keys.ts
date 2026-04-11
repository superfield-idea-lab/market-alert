#!/usr/bin/env bun
/**
 * Key rotation command — rotates all field-encryption data keys end-to-end.
 *
 * Usage (local dev):
 *   ENCRYPTION_MASTER_KEY=<hex> bun run scripts/rotate-data-keys.ts
 *
 * Usage (staging — AWS KMS):
 *   AWS_KMS_KEY_ID=<arn> bun run scripts/rotate-data-keys.ts
 *
 * Usage (staging — Vault):
 *   VAULT_ADDR=https://vault.internal:8200 VAULT_TOKEN=<token> \
 *     bun run scripts/rotate-data-keys.ts
 *
 * Exit codes:
 *   0 — all domains rotated successfully
 *   1 — one or more domains failed
 *
 * The script configures the active KMS backend based on available environment
 * variables (AWS > Vault > LocalDev) and rotates data keys for all known
 * sensitivity-class / entity-type domains.
 *
 * After rotation the new encrypted data keys should be stored wherever the
 * application retrieves them (e.g. a secrets store or a dedicated DB table).
 * This script logs the rotation results but does NOT automatically re-encrypt
 * existing data — that migration step is application-specific.
 */

import {
  AwsKmsBackend,
  configureKmsBackend,
  LocalDevKmsBackend,
  rotateAllDomains,
  VaultKmsBackend,
} from '../packages/core/kms';

// All field-encryption domains (sensitivityClass/entityType)
const DOMAINS = [
  'HIGH/corpus_chunk',
  'HIGH/email',
  'HIGH/transcript',
  'HIGH/wiki_page',
  'HIGH/wiki_page_version',
  'HIGH/crm_note',
  'CRM/customer',
  'INTEREST/customer_interest',
  'IDENTITY/identity_token',
  'CREDENTIAL/recovery_shard',
  'OPERATIONAL/user',
] as const;

function selectBackend(): void {
  const awsKeyId = process.env.AWS_KMS_KEY_ID;
  const vaultAddr = process.env.VAULT_ADDR;
  const vaultToken = process.env.VAULT_TOKEN;

  if (awsKeyId) {
    console.log(`[rotate-data-keys] Using AWS KMS backend — key: ${awsKeyId}`);
    configureKmsBackend(new AwsKmsBackend({ keyId: awsKeyId }));
    return;
  }

  if (vaultAddr && vaultToken) {
    console.log(`[rotate-data-keys] Using Vault Transit backend — addr: ${vaultAddr}`);
    configureKmsBackend(new VaultKmsBackend({ addr: vaultAddr, token: vaultToken }));
    return;
  }

  const masterKey = process.env.ENCRYPTION_MASTER_KEY;
  if (masterKey) {
    console.log('[rotate-data-keys] Using LocalDev KMS backend (ENCRYPTION_MASTER_KEY)');
    configureKmsBackend(new LocalDevKmsBackend());
    return;
  }

  console.error(
    '[rotate-data-keys] ERROR: No KMS credentials found. Set one of:\n' +
      '  AWS_KMS_KEY_ID (AWS KMS)\n' +
      '  VAULT_ADDR + VAULT_TOKEN (HashiCorp Vault)\n' +
      '  ENCRYPTION_MASTER_KEY (local dev only)',
  );
  process.exit(1);
}

async function main(): Promise<void> {
  selectBackend();

  console.log(`[rotate-data-keys] Rotating ${DOMAINS.length} data-key domains...`);
  const started = Date.now();

  let failed = 0;
  try {
    const results = await rotateAllDomains([...DOMAINS]);

    for (const [domain, result] of Object.entries(results)) {
      const encKeyLen = result.newDataKey.encryptedKey.length;
      console.log(
        `[rotate-data-keys] ✓ ${domain} — rotatedAt: ${result.rotatedAt} — encryptedKeyBytes: ${encKeyLen}`,
      );
    }

    const elapsed = Date.now() - started;
    console.log(`[rotate-data-keys] Rotation complete — ${DOMAINS.length} domains in ${elapsed}ms`);
  } catch (err) {
    console.error('[rotate-data-keys] FATAL:', (err as Error).message);
    failed++;
  }

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('[rotate-data-keys] Unhandled error:', err);
  process.exit(1);
});
