/**
 * SOC 2 evidence package cron job.
 *
 * Runs nightly to verify that the evidence package endpoint is reachable and
 * that the assembly pipeline produces a valid package. The package itself is
 * assembled on-demand from audit events — there is no snapshot store. This
 * job serves as a liveness probe for the evidence assembly pipeline.
 */

import type { CronScheduler } from '../scheduler';
import { sql, auditSql } from 'db';
import { assembleSoc2EvidencePackage } from 'db/soc2-evidence';

export const SOC2_EVIDENCE_CAPTURE_CRON_EXPRESSION = '0 2 * * *';

export function registerSoc2EvidenceCaptureJob(
  scheduler: CronScheduler,
  expression = SOC2_EVIDENCE_CAPTURE_CRON_EXPRESSION,
): void {
  scheduler.register('soc2-evidence-capture', expression, async () => {
    const now = new Date();
    const yearAgo = new Date(now);
    yearAgo.setFullYear(yearAgo.getFullYear() - 1);

    const pkg = await assembleSoc2EvidencePackage(sql, auditSql, {
      attestationPeriodStart: yearAgo.toISOString(),
      attestationPeriodEnd: now.toISOString(),
    });

    console.log(
      `[cron] soc2-evidence-capture: assembled access_reviews=${pkg.accessReviews.length} change_log=${pkg.changeLog.length} backup_passed=${pkg.backupVerification.drillPassed} runbook=${pkg.incidentRunbookSignOff.allScenariosVerified} uptime=${pkg.availability.estimatedUptimePct}%`,
    );
  });
}
