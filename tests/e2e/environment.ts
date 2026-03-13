import type { Subprocess } from 'bun';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join, delimiter } from 'path';
import { startPostgres, type PgContainer } from '../../packages/db/pg-container';

const REPO_ROOT = new URL('../..', import.meta.url).pathname;
const SERVER_ENTRY = 'apps/server/src/index.ts';
const SERVER_ENTRY_ABS = join(REPO_ROOT, SERVER_ENTRY);
const SERVER_BASE_PORT = Number(process.env.PORT ?? 31415);
const WORKER_ID = Number(process.env.VITEST_WORKER_ID ?? process.env.VITEST_WORKER ?? 0);
const SERVER_PORT = SERVER_BASE_PORT + WORKER_ID;
const ISOLATED_SERVER_PORT = SERVER_BASE_PORT + WORKER_ID + 100;
const SERVER_READY_TIMEOUT_MS = 20_000;
const BUN_BIN =
  process.env.BUN_BIN ?? (existsSync('/usr/local/bin/bun') ? '/usr/local/bin/bun' : 'bun');
const CLAUDE_LOG_PATH = join(REPO_ROOT, 'tests', 'fixtures', 'claude-e2e.log');
const CLAUDE_STUB_DIR = join(REPO_ROOT, 'tests', 'fixtures');
const STUDIO_BRANCH = 'studio-session-e2e';
const STUDIO_SESSION_ID = 'e2e';

export type StudioSession = {
  branch: string;
  sessionId: string;
  sessionDir: string;
  changesPath: string;
};

export type E2EEnvironment = {
  pg: PgContainer;
  server: Subprocess;
  baseUrl: string;
  claudeLogPath: string;
  studioSession: StudioSession;
};

export type IsolatedRollbackEnvironment = E2EEnvironment & {
  cloneRoot: string;
};

export async function startE2EServer(): Promise<E2EEnvironment> {
  await runBuild();
  const pg = await startPostgres();
  const studioSession = setupStudioSession(pg);
  rmSync(CLAUDE_LOG_PATH, { force: true });

  const envPath = `${CLAUDE_STUB_DIR}${delimiter}${process.env.PATH ?? ''}`;
  const server = Bun.spawn([BUN_BIN, 'run', SERVER_ENTRY], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      DATABASE_URL: pg.url,
      PORT: String(SERVER_PORT),
      PATH: envPath,
      CLAUDE_E2E_LOG_PATH: CLAUDE_LOG_PATH,
    },
    stdout: 'inherit',
    stderr: 'inherit',
  });

  await waitForServer();

  return {
    pg,
    server,
    baseUrl: `http://localhost:${SERVER_PORT}`,
    claudeLogPath: CLAUDE_LOG_PATH,
    studioSession,
  };
}

export async function stopE2EServer(context: E2EEnvironment): Promise<void> {
  context.server.kill();
  await context.pg.stop();
  cleanupStudioSession(context.studioSession);
  rmSync(context.claudeLogPath, { force: true });
}

export async function startIsolatedRollbackServer(): Promise<IsolatedRollbackEnvironment> {
  await runBuild();
  const cloneRoot = join('/tmp', `calypso-e2e-rollback-${Date.now()}`);
  const clone = Bun.spawnSync(['git', 'clone', REPO_ROOT, cloneRoot], {
    cwd: REPO_ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (clone.exitCode !== 0) {
    throw new Error(
      `Failed to clone repo for isolated rollback test: ${(clone.stderr ?? new Uint8Array()).toString()}`,
    );
  }

  Bun.spawnSync(['git', 'config', 'user.name', 'Studio E2E Test'], {
    cwd: cloneRoot,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  Bun.spawnSync(['git', 'config', 'user.email', 'studio-e2e@example.com'], {
    cwd: cloneRoot,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  Bun.spawnSync(['git', 'branch', '-f', 'main', 'HEAD'], {
    cwd: cloneRoot,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const branch = 'studio/session-e2e-rollback-a1b2';
  const sessionId = 'a1b2';
  Bun.spawnSync(['git', 'checkout', '-b', branch], {
    cwd: cloneRoot,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const sessionDir = join(cloneRoot, 'docs', 'studio-sessions', branch);
  mkdirSync(sessionDir, { recursive: true });
  const changesPath = join(sessionDir, 'changes.md');
  writeFileSync(
    changesPath,
    `# Studio Session — ${branch}
**Started:** ${new Date().toISOString()}

## Changes

### Turn 1 — Bootstrap
Initial studio session.
`,
  );
  writeFileSync(
    join(cloneRoot, '.studio'),
    JSON.stringify(
      {
        sessionId,
        branch,
        startedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
  Bun.spawnSync(['git', 'add', '.studio', join('docs', 'studio-sessions', branch, 'changes.md')], {
    cwd: cloneRoot,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  Bun.spawnSync(['git', 'commit', '--no-verify', '-m', `studio: start session ${sessionId}`], {
    cwd: cloneRoot,
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
  Bun.spawnSync(['git', 'add', join('docs', 'studio-sessions', branch, 'changes.md')], {
    cwd: cloneRoot,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  Bun.spawnSync(['git', 'commit', '--no-verify', '-m', 'studio: apply rollback target change'], {
    cwd: cloneRoot,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const pg = await startPostgres();
  const envPath = `${CLAUDE_STUB_DIR}${delimiter}${process.env.PATH ?? ''}`;
  const server = Bun.spawn([BUN_BIN, 'run', SERVER_ENTRY_ABS], {
    cwd: cloneRoot,
    env: {
      ...process.env,
      DATABASE_URL: pg.url,
      PORT: String(ISOLATED_SERVER_PORT),
      PATH: envPath,
      CLAUDE_E2E_LOG_PATH: CLAUDE_LOG_PATH,
    },
    stdout: 'inherit',
    stderr: 'inherit',
  });

  await waitForServer(ISOLATED_SERVER_PORT);

  return {
    pg,
    server,
    baseUrl: `http://localhost:${ISOLATED_SERVER_PORT}`,
    claudeLogPath: CLAUDE_LOG_PATH,
    studioSession: {
      branch,
      sessionId,
      sessionDir,
      changesPath,
    },
    cloneRoot,
  };
}

export async function stopIsolatedRollbackServer(
  context: IsolatedRollbackEnvironment,
): Promise<void> {
  context.server.kill();
  await context.pg.stop();
  rmSync(context.cloneRoot, { recursive: true, force: true });
}

async function runBuild(): Promise<void> {
  const build = Bun.spawnSync([BUN_BIN, 'run', '--filter', 'web', 'build'], {
    cwd: REPO_ROOT,
    stdout: 'inherit',
    stderr: 'inherit',
  });
  if (build.exitCode !== 0) {
    throw new Error('Failed to build the web assets.');
  }
}

async function waitForServer(port = SERVER_PORT): Promise<void> {
  const deadline = Date.now() + SERVER_READY_TIMEOUT_MS;
  const base = `http://localhost:${port}`;
  while (Date.now() < deadline) {
    try {
      await fetch(`${base}/api/tasks`);
      return;
    } catch {
      await Bun.sleep(300);
    }
  }
  throw new Error(`Server at ${base} did not become ready within ${SERVER_READY_TIMEOUT_MS}ms`);
}

function setupStudioSession(pg: PgContainer): StudioSession {
  const sessionDir = join(REPO_ROOT, 'docs', 'studio-sessions', STUDIO_BRANCH);
  mkdirSync(sessionDir, { recursive: true });
  const changesPath = join(sessionDir, 'changes.md');
  if (!existsSync(changesPath)) {
    writeFileSync(
      changesPath,
      `# Studio Session — ${STUDIO_BRANCH}
**Started:** ${new Date().toISOString()}

## Changes

`,
    );
  }

  const studioInfo = {
    sessionId: STUDIO_SESSION_ID,
    branch: STUDIO_BRANCH,
    startedAt: new Date().toISOString(),
    databaseUrl: pg.url,
    containerId: pg.containerId,
  };
  writeFileSync(join(REPO_ROOT, '.studio'), JSON.stringify(studioInfo, null, 2));

  return {
    branch: STUDIO_BRANCH,
    sessionId: STUDIO_SESSION_ID,
    sessionDir,
    changesPath,
  };
}

function cleanupStudioSession(session: StudioSession): void {
  rmSync(join(REPO_ROOT, '.studio'), { force: true });
  rmSync(session.sessionDir, { recursive: true, force: true });
}
