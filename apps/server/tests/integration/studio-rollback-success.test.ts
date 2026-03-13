import { afterEach, beforeEach, expect, test } from 'vitest';
import type { Subprocess } from 'bun';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { startPostgres, type PgContainer } from '../helpers/pg-container';

const REPO_ROOT = new URL('../../../../', import.meta.url).pathname;
const CLONE_ROOT = join('/tmp', `calypso-studio-rollback-${Date.now()}`);
const PORT = 31418;
const BASE = `http://localhost:${PORT}`;
const SERVER_READY_TIMEOUT_MS = 20_000;
const SERVER_ENTRY = join(REPO_ROOT, 'apps/server/src/index.ts');
const BRANCH = 'studio/session-test-rollback-a1b2';
const SESSION_ID = 'a1b2';

let pg: PgContainer;
let server: Subprocess | null = null;

beforeEach(async () => {
  const clone = Bun.spawnSync(['git', 'clone', REPO_ROOT, CLONE_ROOT], {
    cwd: REPO_ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  expect(clone.exitCode).toBe(0);

  Bun.spawnSync(['git', 'config', 'user.name', 'Studio Test'], {
    cwd: CLONE_ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  Bun.spawnSync(['git', 'config', 'user.email', 'studio-test@example.com'], {
    cwd: CLONE_ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  Bun.spawnSync(['git', 'branch', '-f', 'main', 'HEAD'], {
    cwd: CLONE_ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  Bun.spawnSync(['git', 'checkout', '-b', BRANCH], {
    cwd: CLONE_ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const sessionDir = join(CLONE_ROOT, 'docs', 'studio-sessions', BRANCH);
  mkdirSync(sessionDir, { recursive: true });
  const changesPath = join(sessionDir, 'changes.md');
  writeFileSync(
    changesPath,
    `# Studio Session — ${BRANCH}
**Started:** ${new Date().toISOString()}

## Changes

### Turn 1 — Bootstrap
Initial studio session.
`,
  );

  writeFileSync(
    join(CLONE_ROOT, '.studio'),
    JSON.stringify(
      {
        sessionId: SESSION_ID,
        branch: BRANCH,
        startedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );

  Bun.spawnSync(['git', 'add', '.studio', join('docs', 'studio-sessions', BRANCH, 'changes.md')], {
    cwd: CLONE_ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  Bun.spawnSync(['git', 'commit', '--no-verify', '-m', `studio: start session ${SESSION_ID}`], {
    cwd: CLONE_ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  writeFileSync(
    changesPath,
    `${readFileSync(changesPath, 'utf8')}
### Turn 2 — Change
Added a rollback target change.
`,
  );
  Bun.spawnSync(['git', 'add', join('docs', 'studio-sessions', BRANCH, 'changes.md')], {
    cwd: CLONE_ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  Bun.spawnSync(['git', 'commit', '--no-verify', '-m', 'studio: apply rollback target change'], {
    cwd: CLONE_ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  pg = await startPostgres();
  server = Bun.spawn(['bun', 'run', SERVER_ENTRY], {
    cwd: CLONE_ROOT,
    env: {
      ...process.env,
      DATABASE_URL: pg.url,
      PORT: String(PORT),
    },
    stdout: 'ignore',
    stderr: 'ignore',
  });

  await waitForServer();
}, 90_000);

afterEach(async () => {
  server?.kill();
  server = null;
  await pg?.stop();
  rmSync(CLONE_ROOT, { recursive: true, force: true });
});

test('POST /studio/rollback resets the isolated branch to the requested commit and refreshes commits', async () => {
  const statusRes = await fetch(`${BASE}/studio/status`);
  const statusBody = await statusRes.json();
  expect(statusRes.status).toBe(200);
  expect(statusBody.active).toBe(true);
  expect(statusBody.commits).toHaveLength(2);

  const bootstrapCommit = statusBody.commits.find((commit: { message: string }) =>
    commit.message.includes(`studio: start session ${SESSION_ID}`),
  );
  expect(bootstrapCommit).toBeTruthy();

  const rollbackRes = await fetch(`${BASE}/studio/rollback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hash: bootstrapCommit.hash }),
  });
  const rollbackBody = await rollbackRes.json();

  expect(rollbackRes.status).toBe(200);
  expect(rollbackBody.ok).toBe(true);
  expect(rollbackBody.commits).toHaveLength(1);
  expect(rollbackBody.commits[0].message).toContain(`studio: start session ${SESSION_ID}`);

  const headCommit = Bun.spawnSync(['git', 'log', '-1', '--pretty=%s'], {
    cwd: CLONE_ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  expect((headCommit.stdout ?? new Uint8Array()).toString().trim()).toBe(
    `studio: start session ${SESSION_ID}`,
  );

  const changesContent = readFileSync(
    join(CLONE_ROOT, 'docs', 'studio-sessions', BRANCH, 'changes.md'),
    'utf8',
  );
  expect(changesContent).not.toContain('Added a rollback target change.');
  expect(changesContent).toContain('Initial studio session.');
}, 90_000);

async function waitForServer() {
  const deadline = Date.now() + SERVER_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      await fetch(`${BASE}/api/tasks`);
      return;
    } catch {
      await Bun.sleep(300);
    }
  }
  throw new Error(`Server at ${BASE} did not become ready within ${SERVER_READY_TIMEOUT_MS}ms`);
}
