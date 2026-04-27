# Backup and Restore Runbook

**Blueprint reference:** DATA blueprint, PRD §7  
**Phase:** 2 — Ingestion pipeline  
**Issue:** #91 — encrypted Postgres backup and tested restore runbook  
**SOC 2 control:** CC9.1 (risk mitigation — backup and recovery)

---

## Purpose

This runbook defines the procedure for performing, verifying, and restoring
encrypted Postgres backups for the Superfield KB system. It is the **backup
verification proof** artifact referenced in the SOC 2 evidence package (issue
#92).

All backups use AES-256-GCM envelope encryption. The data key is generated
per-backup and stored in a KMS-encrypted JSON sidecar alongside the dump file.
No unencrypted backup artifact is written to disk in production.

---

## Backup procedure

### Automated backup (production)

Backups are executed by a scheduled Kubernetes Job that runs
`scripts/backup-postgres.sh` on the configured cadence (default: nightly).
The job writes two artifact files per database per run:

| File                    | Description                                       |
| ----------------------- | ------------------------------------------------- |
| `<backup-id>.dump.enc`  | AES-256-GCM encrypted pg_dump (custom format)     |
| `<backup-id>.meta.json` | JSON sidecar: timestamp, databases, encrypted DEK |

The sidecar `meta.json` structure:

```json
{
  "backupId": "<YYYY-MM-DDTHH-MM-SSZ>",
  "createdAt": "<ISO-8601 timestamp>",
  "databases": ["superfield_app", "superfield_audit"],
  "encryptedDek": "<base64-encoded KMS-encrypted data key>",
  "iv": "<base64-encoded AES-GCM IV>"
}
```

### Manual backup

```bash
# From a node with DATABASE_URL and AUDIT_DATABASE_URL set
./scripts/backup-postgres.sh --store-dir /var/backups/superfield
```

---

## Restore procedure

### Prerequisites

- `ENCRYPTION_MASTER_KEY` set (or KMS access configured)
- `pg_restore` version matching the backup server's Postgres major version
- Access to the `.dump.enc` and `.meta.json` artifact files

### Restore command

```bash
./scripts/restore-postgres.sh \
  --enc-file  /var/backups/superfield/<backup-id>.dump.enc \
  --meta-file /var/backups/superfield/<backup-id>.meta.json \
  --target-url postgres://admin:password@<host>:5432/<restore-db>
```

The restore is idempotent: `pg_restore --clean --if-exists` drops and
recreates objects before restoring, so re-running against the same target
is safe.

---

## Quarterly restore drill

SOC 2 CC9.1 requires that backup recovery is tested, not merely automated.
A restore drill must be run quarterly and the result recorded as a
`backup.restore_drill` audit event in the audit database.

### Drill steps

1. **Select the most recent backup artifact** from the backup store.

2. **Create a temporary restore target** database (or use the dedicated
   `superfield_restore` database in staging).

3. **Run the restore** and capture the row count:

   ```bash
   ./scripts/restore-postgres.sh \
     --enc-file  <path>.dump.enc \
     --meta-file <path>.meta.json \
     --target-url postgres://admin:password@staging:5432/superfield_restore
   ```

4. **Verify row counts** match the source database:

   ```bash
   psql "$DATABASE_URL"    -c "SELECT COUNT(*) FROM entities"
   psql "$RESTORE_DB_URL"  -c "SELECT COUNT(*) FROM entities"
   # Counts must be equal
   ```

5. **Verify RLS still blocks cross-tenant reads** on the restored database:

   ```sql
   -- Connect as app_rw to the restore target
   SET app.current_tenant_id = 'tenant-a';
   SELECT COUNT(*) FROM entities WHERE tenant_id = 'tenant-b';
   -- Expected: 0 (RLS enforced)
   ```

6. **Record the result** in the audit log (run from the application or directly):

   ```sql
   INSERT INTO audit_events
     (actor_id, action, entity_type, entity_id, before, after,
      ts, prev_hash, hash)
   VALUES (
     'system',
     'backup.restore_drill',
     'backup',
     '<backup-id>',
     NULL,
     '{"backup_id":"<backup-id>","restored_row_count":<N>,"passed":true}'::jsonb,
     NOW(),
     -- prev_hash and hash computed by the application audit writer
     '<prev_hash>',
     '<hash>'
   );
   ```

   In practice, use the application's `AuditService.emit()` function so the
   hash chain is maintained correctly.

### Sign-off checklist

After each quarterly drill, the on-call engineer signs off by completing:

- [ ] Restore completed without errors
- [ ] Row counts in restored DB match source DB
- [ ] RLS policies block cross-tenant reads post-restore
- [ ] `backup.restore_drill` audit event written with `"passed": true`
- [ ] Date of drill: \***\*\*\*\*\***\_\_\***\*\*\*\*\***
- [ ] Engineer name: \***\*\*\*\*\***\_\_\***\*\*\*\*\***
- [ ] Environment: staging / production (circle one)

---

## Integration with SOC 2 evidence package

The SOC 2 evidence endpoint at `GET /api/compliance/soc2-evidence` automatically
retrieves the most recent `backup.restore_drill` audit event and includes it as
the `backupVerification` section of the evidence package. The Compliance Officer
does not need to manually locate backup artifacts — the audit event is the
authoritative proof.

If `backupVerification.drillPassed` is `false` or `drilledAt` is `null`, it
means no drill has been recorded and one must be run before the evidence package
can be submitted to the auditor.

---

## Related documents

- `scripts/backup-postgres.sh` — automated backup script
- `scripts/restore-postgres.sh` — restore script
- `packages/db/backup.ts` — TypeScript backup/restore library
- `packages/db/backup.test.ts` — backup/restore integration tests
- `docs/runbooks/auth-incident-response.md` — auth incident runbook
- Issue #91 — encrypted Postgres backup and tested restore runbook
- Issue #92 — SOC 2 evidence packaging (wraps this runbook)
