/**
 * @file deployment-audit.test.ts
 *
 * Unit tests for the deployments.jsonl write function.
 *
 * Test plan ref: Issue #9 — "Unit test: deployments.jsonl write function
 * produces the correct JSONL schema".
 *
 * No mocks. Real filesystem writes to a tmp directory.
 */

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  writeDeploymentAudit,
  buildDeploymentRecord,
  type DeploymentRecord,
  type DeployOutcome,
} from './deployment-audit';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'deploy-audit-test-'));
}

function readJsonlLines(filePath: string): Record<string, unknown>[] {
  if (!existsSync(filePath)) return [];
  return readFileSync(filePath, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

// ---------------------------------------------------------------------------
// buildDeploymentRecord
// ---------------------------------------------------------------------------

describe('buildDeploymentRecord', () => {
  test('fills ts with current ISO timestamp when not provided', () => {
    const before = new Date().toISOString();
    const record = buildDeploymentRecord({
      operator: 'ci-bot',
      release_tag: 'v1.0.0',
      environment: 'staging',
      outcome: 'success',
      image_digest: 'sha256:abc123',
    });
    const after = new Date().toISOString();
    expect(record.ts >= before).toBe(true);
    expect(record.ts <= after).toBe(true);
  });

  test('uses provided ts when supplied', () => {
    const ts = '2026-01-15T12:00:00.000Z';
    const record = buildDeploymentRecord({
      ts,
      operator: 'alice',
      release_tag: 'sha-abc1234',
      environment: 'production',
      outcome: 'success',
      image_digest: 'sha256:def456',
    });
    expect(record.ts).toBe(ts);
  });

  test('preserves all required fields', () => {
    const record = buildDeploymentRecord({
      operator: 'bob',
      release_tag: 'v2.3.1',
      environment: 'production',
      outcome: 'failure',
      image_digest: 'sha256:000111',
    });
    expect(record.operator).toBe('bob');
    expect(record.release_tag).toBe('v2.3.1');
    expect(record.environment).toBe('production');
    expect(record.outcome).toBe('failure');
    expect(record.image_digest).toBe('sha256:000111');
  });
});

// ---------------------------------------------------------------------------
// writeDeploymentAudit — JSONL schema
// ---------------------------------------------------------------------------

describe('writeDeploymentAudit', () => {
  let dir: string;
  let auditFile: string;

  beforeEach(() => {
    dir = makeTmpDir();
    auditFile = join(dir, 'deployments.jsonl');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('creates the file and writes a single valid JSONL record', () => {
    const record: DeploymentRecord = {
      ts: '2026-03-01T10:00:00.000Z',
      operator: 'deploy-bot',
      release_tag: 'v0.1.0',
      environment: 'staging',
      outcome: 'success',
      image_digest: 'sha256:aabbcc',
    };

    writeDeploymentAudit(record, auditFile);

    expect(existsSync(auditFile)).toBe(true);
    const lines = readJsonlLines(auditFile);
    expect(lines).toHaveLength(1);

    const written = lines[0] as unknown as DeploymentRecord;
    expect(written.ts).toBe(record.ts);
    expect(written.operator).toBe(record.operator);
    expect(written.release_tag).toBe(record.release_tag);
    expect(written.environment).toBe(record.environment);
    expect(written.outcome).toBe(record.outcome);
    expect(written.image_digest).toBe(record.image_digest);
  });

  test('appends multiple records — each on its own line', () => {
    const outcomes: DeployOutcome[] = ['success', 'failure', 'rollback'];

    for (const outcome of outcomes) {
      writeDeploymentAudit(
        {
          ts: new Date().toISOString(),
          operator: 'ci',
          release_tag: 'sha-test',
          environment: 'staging',
          outcome,
          image_digest: 'sha256:test',
        },
        auditFile,
      );
    }

    const lines = readJsonlLines(auditFile);
    expect(lines).toHaveLength(3);
    expect(lines[0].outcome).toBe('success');
    expect(lines[1].outcome).toBe('failure');
    expect(lines[2].outcome).toBe('rollback');
  });

  test('creates parent directory if it does not exist', () => {
    const nested = join(dir, 'sub', 'deploy', 'deployments.jsonl');
    writeDeploymentAudit(
      {
        ts: new Date().toISOString(),
        operator: 'bot',
        release_tag: 'v1',
        environment: 'prod',
        outcome: 'success',
        image_digest: 'sha256:111',
      },
      nested,
    );
    expect(existsSync(nested)).toBe(true);
  });

  test('returns the file path that was written to', () => {
    const returned = writeDeploymentAudit(
      {
        ts: new Date().toISOString(),
        operator: 'op',
        release_tag: 'v0',
        environment: 'staging',
        outcome: 'success',
        image_digest: 'sha256:000',
      },
      auditFile,
    );
    expect(returned).toBe(auditFile);
  });

  test('record is valid JSON (each line parseable independently)', () => {
    writeDeploymentAudit(
      {
        ts: '2026-04-01T08:00:00.000Z',
        operator: 'ci-pipeline',
        release_tag: 'sha-deadbeef',
        environment: 'production',
        outcome: 'success',
        image_digest: 'sha256:cafebabe',
      },
      auditFile,
    );

    const raw = readFileSync(auditFile, 'utf8').trim();
    // Each non-empty line should be valid JSON
    for (const line of raw.split('\n')) {
      if (line.trim()) {
        expect(() => JSON.parse(line)).not.toThrow();
      }
    }
  });

  test('schema fields are all present and of the expected types', () => {
    writeDeploymentAudit(
      {
        ts: '2026-05-01T00:00:00.000Z',
        operator: 'human',
        release_tag: 'v3.0.0',
        environment: 'production',
        outcome: 'success',
        image_digest: 'sha256:abc',
      },
      auditFile,
    );

    const [record] = readJsonlLines(auditFile);
    expect(typeof record.ts).toBe('string');
    expect(typeof record.operator).toBe('string');
    expect(typeof record.release_tag).toBe('string');
    expect(typeof record.environment).toBe('string');
    expect(typeof record.outcome).toBe('string');
    expect(typeof record.image_digest).toBe('string');
  });
});
