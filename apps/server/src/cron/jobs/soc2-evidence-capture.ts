/**
 * SOC 2 evidence capture cron job.
 *
 * Snapshots the current compliance evidence bundle into the app database so
 * the operator export endpoint can surface an audit-friendly history without
 * depending on live filesystem reads at request time.
 */

import type { CronScheduler } from '../scheduler';
import { sql } from 'db';
import { captureSoc2EvidenceSnapshot } from 'db/soc2-evidence';

export const SOC2_EVIDENCE_CAPTURE_CRON_EXPRESSION = '0 2 * * *';

export function registerSoc2EvidenceCaptureJob(
  scheduler: CronScheduler,
  expression = SOC2_EVIDENCE_CAPTURE_CRON_EXPRESSION,
): void {
  scheduler.register('soc2-evidence-capture', expression, async () => {
    const snapshot = await captureSoc2EvidenceSnapshot(sql, {
      actorId: 'scheduler',
      repoRoot: process.cwd(),
      deploymentAuditPath: process.env.SOC2_DEPLOYMENT_AUDIT_PATH,
    });

    console.log(
      `[cron] soc2-evidence-capture: captured access=${snapshot.accessReview?.totalPrincipals ?? 0} commits=${snapshot.changeLog?.git.commits.length ?? 0} backups=${snapshot.backupVerifications.length}`,
    );
  });
}
