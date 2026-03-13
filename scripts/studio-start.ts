#!/usr/bin/env bun
/**
 * studio — Starts a disposable Postgres container, writes the .studio
 * sentinel file, and launches the dev server with the correct DATABASE_URL.
 * Set STUDIO_ENFORCE_BRANCH=1 to enforce studio branch naming + clean worktree.
 *
 * Run from the repo root: bun run studio
 */

import { join } from 'path';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { startPostgres } from '../packages/db/pg-container';
import { migrate } from '../packages/db/index';
import {
  buildStudioBranchName,
  generateSessionId,
  resolveStudioSession,
} from '../packages/core/studio-session';

const REPO_ROOT = join(import.meta.dir, '..');
const STUDIO_API_PORT = Number(process.env.STUDIO_API_PORT ?? 31415);
const STUDIO_PORT = Number(process.env.STUDIO_PORT ?? 5174);
const ENFORCE_STUDIO_BRANCH = process.env.STUDIO_ENFORCE_BRANCH === '1';
const EXIT_AFTER_BOOTSTRAP = process.env.STUDIO_EXIT_AFTER_BOOTSTRAP === '1';
const SKIP_PUSH = process.env.STUDIO_SKIP_PUSH === '1';

function run(cmd: string[], opts: { allowFailure?: boolean } = {}) {
  const proc = Bun.spawnSync(cmd, { cwd: REPO_ROOT, stdout: 'pipe', stderr: 'pipe' });
  if (proc.exitCode !== 0 && !opts.allowFailure) {
    const err = new TextDecoder().decode(proc.stderr);
    const out = new TextDecoder().decode(proc.stdout);
    console.error(`\nError running: ${cmd.join(' ')}\n${err}${out ? `\n${out}` : ''}`);
    process.exit(1);
  }
  return new TextDecoder().decode(proc.stdout).trim();
}

function tryRun(cmd: string[]): string | null {
  const proc = Bun.spawnSync(cmd, { cwd: REPO_ROOT, stdout: 'pipe', stderr: 'pipe' });
  if (proc.exitCode !== 0) return null;
  return new TextDecoder().decode(proc.stdout).trim();
}

function hasGitRef(ref: string): boolean {
  const proc = Bun.spawnSync(['git', 'show-ref', '--verify', '--quiet', ref], {
    cwd: REPO_ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return proc.exitCode === 0;
}

function getCurrentBranch(): string {
  return run(['git', 'branch', '--show-current']);
}

function getMainRefAndHash(): { ref: string; hash: string } {
  const candidates = ['origin/main', 'origin/master', 'main', 'master'];
  for (const ref of candidates) {
    const hash = tryRun(['git', 'rev-parse', '--short', ref]);
    if (hash) return { ref, hash };
  }
  console.error('\n❌ Error: Could not resolve main branch.');
  console.error('  Expected one of: origin/main, origin/master, main, master');
  console.error('  Run `git fetch --all` or create a local main branch before retrying.');
  process.exit(1);
}

function ensureGitIdentity(): void {
  const name = run(['git', 'config', 'user.name'], { allowFailure: true });
  const email = run(['git', 'config', 'user.email'], { allowFailure: true });
  if (!name || !email) {
    console.error(
      '\n❌ Error: git user.name and user.email must be configured for studio commits.',
    );
    console.error('  Configure with:');
    console.error('    git config user.name "Your Name"');
    console.error('    git config user.email "you@example.com"');
    process.exit(1);
  }
}

function ensureCleanWorktree(): void {
  const status = run(['git', 'status', '--porcelain']);
  if (status) {
    console.error('\n❌ Error: Working tree is not clean.');
    console.error('  Studio sessions must start from a clean, dedicated worktree.');
    console.error('  Create one with:');
    console.error('    git worktree add ../calypso-studio origin/main');
    process.exit(1);
  }
}

function ensureStudioBranch(): { branch: string; sessionId: string; mainHash: string } {
  const currentBranch = getCurrentBranch();
  if (!currentBranch) {
    console.error('\n❌ Error: Detached HEAD. Checkout a branch before starting studio mode.');
    process.exit(1);
  }

  const { ref, hash: mainHash } = getMainRefAndHash();
  const resolution = resolveStudioSession({
    currentBranch,
    mainHash,
    enforceStudioBranch: ENFORCE_STUDIO_BRANCH,
  });

  if (!resolution.needsNewBranch) {
    return { branch: resolution.branch, sessionId: resolution.sessionId, mainHash };
  }

  if (ENFORCE_STUDIO_BRANCH) {
    ensureCleanWorktree();
  }

  let { sessionId, branch } = resolution;
  let attempts = 0;
  while (hasGitRef(`refs/heads/${branch}`) && attempts < 5) {
    sessionId = generateSessionId();
    branch = buildStudioBranchName(mainHash, sessionId);
    attempts += 1;
  }
  if (hasGitRef(`refs/heads/${branch}`)) {
    console.error('\n❌ Error: Could not generate a unique studio branch name.');
    process.exit(1);
  }
  console.log(`  Creating studio branch: ${branch}`);
  run(['git', 'checkout', '-b', branch, ref]);
  return { branch, sessionId, mainHash };
}

async function runStudio() {
  // ── 1. Validate current branch ─────────────────────────────────────────────────
  ensureGitIdentity();

  console.log(`\n⬡ Studio Mode`);
  const { branch, sessionId, mainHash } = ensureStudioBranch();
  console.log(`  Current branch: ${branch}`);
  console.log(`  Main hash: ${mainHash}`);
  console.log(`  Session: ${sessionId}`);

  // ── 2. Spin up disposable Postgres on a random port ────────────────────────────
  console.log(`  Starting Postgres container...`);
  let pg = null as Awaited<ReturnType<typeof startPostgres>> | null;
  try {
    pg = await startPostgres();
    console.log(`  Postgres ready at: ${pg.url}`);

    // ── 3. Run migrations against the fresh DB ─────────────────────────────────────
    process.env.DATABASE_URL = pg.url;
    try {
      await migrate({ databaseUrl: pg.url });
      console.log(`  Schema migrated.`);
    } catch (err) {
      console.log(`  Schema migration failed: ${err}`);
      console.log(`  Proceeding anyway - dev server will start.`);
    }

    // ── 4. Write session artifact directory and changes.md ─────────────────────────
    const sessionDir = join(REPO_ROOT, 'docs', 'studio-sessions', branch);
    const changesRelativePath = join('docs', 'studio-sessions', branch, 'changes.md');
    mkdirSync(sessionDir, { recursive: true });
    const changesPath = join(REPO_ROOT, changesRelativePath);
    if (!existsSync(changesPath)) {
      writeFileSync(
        changesPath,
        `# Studio Session — ${branch}\n**Started:** ${new Date().toISOString()}\n\n## Changes\n\n`,
      );
    }

    // ── 5. Write .studio sentinel ───────────────────────────────────────────────────
    const studioInfo = {
      sessionId,
      branch,
      startedAt: new Date().toISOString(),
      databaseUrl: pg.url,
      containerId: pg.containerId,
    };
    writeFileSync(join(REPO_ROOT, '.studio'), JSON.stringify(studioInfo, null, 2));

    // ── 6. Commit bootstrap state ──────────────────────────────────────────────────
    run(['git', 'add', '-f', '.studio', changesRelativePath]);
    run(['git', 'commit', '--no-verify', '-m', `studio: start session ${sessionId}`]);

    // ── 7. Push to remote (non-fatal — local session works without it) ─────────────
    if (!SKIP_PUSH) {
      run(['git', 'push', '-u', 'origin', branch], { allowFailure: true });
    }

    if (EXIT_AFTER_BOOTSTRAP) {
      console.log(`  Bootstrap complete. Exiting before launching dev server.`);
      await pg.stop();
      return;
    }

    // ── 8. Start dev servers with studio DATABASE_URL ──────────────────────────────
    console.log(`\n⬡ Launching dev servers`);
    console.log(`  DATABASE_URL=${pg.url}`);
    console.log(`  Web: bun --bun vite dev --host --port ${STUDIO_PORT} (apps/web)`);
    console.log(`  API: expected at http://localhost:${STUDIO_API_PORT}`);
    console.log(`  Press Ctrl+C to stop (Postgres container will be removed)\n`);

    const webDevServer = Bun.spawn(
      ['bun', '--bun', 'vite', 'dev', '--host', '--port', String(STUDIO_PORT), '--strictPort'],
      {
        cwd: join(REPO_ROOT, 'apps', 'web'),
        env: { ...process.env, STUDIO_API_PORT: String(STUDIO_API_PORT) },
        stdout: 'inherit',
        stderr: 'inherit',
      },
    );

    // ── 9. Tear down Postgres when the dev server exits ────────────────────────────
    const cleanup = async () => {
      console.log(`\n⬡ Stopping studio session ${sessionId}`);
      webDevServer.kill();
      await pg?.stop();
      console.log(`  Postgres container stopped.`);
    };

    process.on('SIGINT', async () => {
      await cleanup();
      process.exit(0);
    });

    process.on('SIGTERM', async () => {
      await cleanup();
      process.exit(0);
    });

    await webDevServer.exited;
    await cleanup();
  } catch (err) {
    if (pg) {
      await pg.stop();
    }
    throw err;
  }
}

runStudio().catch((err) => {
  console.error('\n❌ Studio startup failed.');
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
