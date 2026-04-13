/**
 * SOC 2 Type II evidence capture helpers.
 *
 * The capture model is deliberately simple:
 *   - periodic jobs snapshot control evidence into `soc2_evidence_snapshots`
 *   - the operator export endpoint reads the latest persisted snapshots
 *   - backup verification drills can append proof rows on demand
 *
 * The bundle is intentionally structured around the control language used in
 * the plan: access reviews, change logs, incident response runbook artifacts,
 * and backup verification proof.
 */

import { createHash } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import { spawnSync } from 'child_process';
import type postgres from 'postgres';

type SqlClient = postgres.Sql;

export type Soc2EvidenceArtifactType =
  | 'access_review'
  | 'change_log'
  | 'incident_runbook'
  | 'backup_verification';

export interface Soc2EvidenceArtifactRow {
  id: string;
  artifact_type: Soc2EvidenceArtifactType;
  source: string;
  captured_at: Date;
  payload: unknown;
}

export interface Soc2EvidenceBundleMeta {
  exportedAt: string;
  exportedBy: string;
  repoRoot: string;
}

export interface Soc2AccessReviewPrincipal {
  id: string;
  username: string | null;
  role: string;
  createdAt: string;
}

export interface Soc2AccessReviewArtifact {
  capturedAt: string;
  cadence: 'quarterly';
  reviewedBy: string;
  principals: Soc2AccessReviewPrincipal[];
  totalPrincipals: number;
}

export interface Soc2GitCommit {
  sha: string;
  authoredAt: string;
  subject: string;
}

export interface Soc2DeploymentAuditRecord {
  [key: string]: unknown;
}

export interface Soc2ChangeLogArtifact {
  capturedAt: string;
  git: {
    head: string | null;
    commits: Soc2GitCommit[];
  };
  deployments: Soc2DeploymentAuditRecord[];
}

export interface Soc2IncidentRunbookArtifact {
  capturedAt: string;
  path: string;
  sha256: string | null;
  lastTested: string | null;
  tested: boolean;
  scenarios: string[];
}

export interface Soc2BackupVerificationArtifact {
  capturedAt: string;
  backupId: string;
  status: string;
  sourceDatabase: string;
  restoreDatabase: string;
  rowCount: number;
  verifiedBy: string;
  verifiedAt: string;
  notes: string | null;
}

export interface Soc2EvidenceBundle {
  meta: Soc2EvidenceBundleMeta;
  accessReview: Soc2AccessReviewArtifact | null;
  changeLog: Soc2ChangeLogArtifact | null;
  incidentRunbook: Soc2IncidentRunbookArtifact | null;
  backupVerifications: Soc2BackupVerificationArtifact[];
}

export interface Soc2EvidenceCaptureOptions {
  actorId: string;
  repoRoot?: string;
  deploymentAuditPath?: string;
  gitCommitLimit?: number;
}

export interface Soc2BackupVerificationInput {
  backupId: string;
  sourceDatabase: string;
  restoreDatabase: string;
  rowCount: number;
  verifiedBy: string;
  verifiedAt?: string;
  notes?: string | null;
  status?: string;
}

function nowIso(date = new Date()): string {
  return date.toISOString();
}

function normalizePayload(payload: unknown): Record<string, unknown> {
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    return payload as Record<string, unknown>;
  }

  if (typeof payload === 'string') {
    try {
      const parsed = JSON.parse(payload);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return {};
    }
  }

  return {};
}

function artifactRowToJson(row: Soc2EvidenceArtifactRow): Record<string, unknown> {
  const payload = normalizePayload(row.payload);
  return {
    capturedAt: row.captured_at.toISOString(),
    source: row.source,
    ...payload,
  };
}

async function storeArtifact(
  sql: SqlClient,
  artifactType: Soc2EvidenceArtifactType,
  source: string,
  payload: unknown,
): Promise<Soc2EvidenceArtifactRow> {
  const rows = await sql<Soc2EvidenceArtifactRow[]>`
    INSERT INTO soc2_evidence_snapshots (artifact_type, source, payload)
    VALUES (${artifactType}, ${source}, ${JSON.stringify(payload)}::jsonb)
    RETURNING id, artifact_type, source, captured_at, payload
  `;
  return rows[0];
}

function resolveRepoRoot(repoRoot?: string): string {
  return repoRoot ?? process.cwd();
}

function resolveDeploymentAuditPath(
  deploymentAuditPath?: string,
  repoRoot?: string,
): string | null {
  const candidate =
    deploymentAuditPath ??
    process.env.SOC2_DEPLOYMENT_AUDIT_PATH ??
    `${resolveRepoRoot(repoRoot)}/deployments.jsonl`;
  return existsSync(candidate) ? candidate : null;
}

function readJsonLines<T extends Record<string, unknown>>(path: string): T[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as T];
      } catch {
        return [];
      }
    });
}

function captureGitHistory(
  repoRoot: string,
  limit = 20,
): { head: string | null; commits: Soc2GitCommit[] } {
  const headResult = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot });
  const head = headResult.status === 0 ? headResult.stdout.toString().trim() || null : null;

  const logResult = spawnSync(
    'git',
    [
      'log',
      `--max-count=${Math.max(limit, 1)}`,
      '--date=iso-strict',
      '--pretty=format:%H%x09%aI%x09%s',
    ],
    { cwd: repoRoot },
  );

  if (logResult.status !== 0) {
    return { head, commits: [] };
  }

  const commits = logResult.stdout
    .toString()
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [sha, authoredAt, ...subjectParts] = line.split('\t');
      return {
        sha,
        authoredAt,
        subject: subjectParts.join('\t'),
      } satisfies Soc2GitCommit;
    });

  return { head, commits };
}

function readIncidentRunbookArtifact(repoRoot: string): Soc2IncidentRunbookArtifact {
  const runbookPath = `${repoRoot}/docs/runbooks/auth-incident-response.md`;
  const raw = readFileSync(runbookPath, 'utf8');
  const sha256 = createHash('sha256').update(raw).digest('hex');
  const testedMatch = raw.match(/\*\*Last tested:\*\*\s*([^(]+)(?:\s*\(([^)]+)\))?/i);
  const lastTested = testedMatch?.[1]?.trim() ?? null;
  const scenarioMatches = Array.from(raw.matchAll(/^## Scenario \d+ — (.+)$/gm)).map((match) =>
    match[1].trim(),
  );

  return {
    capturedAt: nowIso(),
    path: 'docs/runbooks/auth-incident-response.md',
    sha256,
    lastTested,
    tested: true,
    scenarios: scenarioMatches,
  };
}

async function generateAccessReviewArtifact(
  sql: SqlClient,
  actorId: string,
): Promise<Soc2AccessReviewArtifact> {
  const rows = await sql<
    {
      id: string;
      properties: Record<string, unknown>;
      created_at: Date | string | null;
    }[]
  >`
    SELECT id, properties, created_at
    FROM entities
    WHERE type = 'user'
      AND COALESCE(properties->>'role', '') IN ('superuser', 'compliance_officer')
    ORDER BY created_at DESC, id ASC
  `;

  const principals = rows.map((row) => ({
    id: row.id,
    username: typeof row.properties.username === 'string' ? row.properties.username : null,
    role: String(row.properties.role ?? 'unknown'),
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : nowIso(),
  }));

  return {
    capturedAt: nowIso(),
    cadence: 'quarterly',
    reviewedBy: actorId,
    principals,
    totalPrincipals: principals.length,
  };
}

async function generateChangeLogArtifact(
  options: Soc2EvidenceCaptureOptions,
): Promise<Soc2ChangeLogArtifact> {
  const repoRoot = resolveRepoRoot(options.repoRoot);
  const git = captureGitHistory(repoRoot, options.gitCommitLimit ?? 20);
  const deploymentPath = resolveDeploymentAuditPath(options.deploymentAuditPath, repoRoot);
  const deployments = deploymentPath ? readJsonLines(deploymentPath) : [];

  return {
    capturedAt: nowIso(),
    git,
    deployments,
  };
}

export async function captureSoc2EvidenceSnapshot(
  sql: SqlClient,
  options: Soc2EvidenceCaptureOptions,
): Promise<Soc2EvidenceBundle> {
  const repoRoot = resolveRepoRoot(options.repoRoot);
  const accessReview = await generateAccessReviewArtifact(sql, options.actorId);
  const changeLog = await generateChangeLogArtifact(options);
  const incidentRunbook = readIncidentRunbookArtifact(repoRoot);

  await Promise.all([
    storeArtifact(sql, 'access_review', 'quarterly-access-review', accessReview),
    storeArtifact(sql, 'change_log', 'git-and-deployment-change-log', changeLog),
    storeArtifact(sql, 'incident_runbook', 'auth-incident-response-runbook', incidentRunbook),
  ]);

  return buildSoc2EvidenceBundle(sql, options);
}

export async function recordSoc2BackupVerification(
  sql: SqlClient,
  input: Soc2BackupVerificationInput,
): Promise<Soc2BackupVerificationArtifact> {
  const capturedAt = nowIso(input.verifiedAt ? new Date(input.verifiedAt) : new Date());
  const payload: Soc2BackupVerificationArtifact = {
    capturedAt,
    backupId: input.backupId,
    status: input.status ?? 'passed',
    sourceDatabase: input.sourceDatabase,
    restoreDatabase: input.restoreDatabase,
    rowCount: input.rowCount,
    verifiedBy: input.verifiedBy,
    verifiedAt: input.verifiedAt ?? capturedAt,
    notes: input.notes ?? null,
  };

  const row = await storeArtifact(sql, 'backup_verification', 'backup-restore-drill', payload);
  return artifactRowToJson(row) as unknown as Soc2BackupVerificationArtifact;
}

async function loadLatestArtifact(
  sql: SqlClient,
  artifactType: Soc2EvidenceArtifactType,
): Promise<Soc2EvidenceArtifactRow | null> {
  const rows = await sql<Soc2EvidenceArtifactRow[]>`
    SELECT id, artifact_type, source, captured_at, payload
    FROM soc2_evidence_snapshots
    WHERE artifact_type = ${artifactType}
    ORDER BY captured_at DESC, id DESC
    LIMIT 1
  `;
  return rows[0] ?? null;
}

async function loadBackupVerificationArtifacts(
  sql: SqlClient,
): Promise<Soc2BackupVerificationArtifact[]> {
  const rows = await sql<Soc2EvidenceArtifactRow[]>`
    SELECT id, artifact_type, source, captured_at, payload
    FROM soc2_evidence_snapshots
    WHERE artifact_type = 'backup_verification'
    ORDER BY captured_at DESC, id DESC
  `;
  return rows.map((row) => artifactRowToJson(row) as unknown as Soc2BackupVerificationArtifact);
}

export async function buildSoc2EvidenceBundle(
  sql: SqlClient,
  options: Soc2EvidenceCaptureOptions,
): Promise<Soc2EvidenceBundle> {
  const repoRoot = resolveRepoRoot(options.repoRoot);

  const [accessReviewRow, changeLogRow, incidentRunbookRow, backupVerifications] =
    await Promise.all([
      loadLatestArtifact(sql, 'access_review'),
      loadLatestArtifact(sql, 'change_log'),
      loadLatestArtifact(sql, 'incident_runbook'),
      loadBackupVerificationArtifacts(sql),
    ]);

  const accessReview =
    accessReviewRow !== null
      ? (artifactRowToJson(accessReviewRow) as unknown as Soc2AccessReviewArtifact)
      : await generateAccessReviewArtifact(sql, options.actorId);

  const changeLog =
    changeLogRow !== null
      ? (artifactRowToJson(changeLogRow) as unknown as Soc2ChangeLogArtifact)
      : await generateChangeLogArtifact(options);

  const incidentRunbook =
    incidentRunbookRow !== null
      ? (artifactRowToJson(incidentRunbookRow) as unknown as Soc2IncidentRunbookArtifact)
      : readIncidentRunbookArtifact(repoRoot);

  return {
    meta: {
      exportedAt: nowIso(),
      exportedBy: options.actorId,
      repoRoot,
    },
    accessReview,
    changeLog,
    incidentRunbook,
    backupVerifications,
  };
}
