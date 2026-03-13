import { afterEach, expect, test } from 'vitest';
import { existsSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';

const REPO_ROOT = new URL('../../../../', import.meta.url).pathname;
const CLONE_ROOT = join('/tmp', `calypso-studio-test-${Date.now()}`);

function resolveStudioMainHash(cwd: string): string {
  for (const ref of ['origin/main', 'origin/master', 'main', 'master']) {
    const result = Bun.spawnSync(['git', 'rev-parse', '--short', ref], {
      cwd,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    if (result.exitCode === 0) {
      return (result.stdout ?? new Uint8Array()).toString().trim();
    }
  }

  throw new Error('Could not resolve a main branch ref for the Studio test clone.');
}

function cloneRepoRootWithWorkspaceChanges(): void {
  const clone = Bun.spawnSync(['git', 'clone', REPO_ROOT, CLONE_ROOT], {
    cwd: REPO_ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  expect(clone.exitCode).toBe(0);

  const diff = Bun.spawnSync(['git', 'diff', '--binary', 'HEAD'], {
    cwd: REPO_ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  expect(diff.exitCode).toBe(0);
  const patch = (diff.stdout ?? new Uint8Array()).toString();
  if (!patch.trim()) {
    return;
  }

  const apply = Bun.spawnSync(['git', 'apply', '--index'], {
    cwd: CLONE_ROOT,
    stdin: diff.stdout,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  expect(apply.exitCode).toBe(0);
}

afterEach(() => {
  rmSync(CLONE_ROOT, { recursive: true, force: true });
});

test('bun run studio bootstraps an existing studio branch checkout and exits after bootstrap in test mode', async () => {
  cloneRepoRootWithWorkspaceChanges();

  Bun.spawnSync(['git', 'config', 'user.name', 'Studio Start Test'], {
    cwd: CLONE_ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  Bun.spawnSync(['git', 'config', 'user.email', 'studio-start-test@example.com'], {
    cwd: CLONE_ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  Bun.spawnSync(['git', 'branch', '-f', 'main', 'HEAD'], {
    cwd: CLONE_ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  Bun.spawnSync(['git', 'checkout', 'main'], {
    cwd: CLONE_ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const mainHash = resolveStudioMainHash(CLONE_ROOT);
  const branchName = `studio/session-${mainHash}-a1b2`;
  Bun.spawnSync(['git', 'checkout', '-b', branchName], {
    cwd: CLONE_ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const studio = Bun.spawnSync(['bun', 'run', 'studio'], {
    cwd: CLONE_ROOT,
    env: {
      ...process.env,
      STUDIO_EXIT_AFTER_BOOTSTRAP: '1',
      STUDIO_SKIP_PUSH: '1',
      STUDIO_PORT: '5179',
      STUDIO_API_PORT: '31419',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });

  expect(studio.exitCode).toBe(0);

  const branch = Bun.spawnSync(['git', 'branch', '--show-current'], {
    cwd: CLONE_ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const checkedOutBranchName = (branch.stdout ?? new Uint8Array()).toString().trim();

  expect(checkedOutBranchName).toBe(branchName);

  const studioFilePath = join(CLONE_ROOT, '.studio');
  expect(existsSync(studioFilePath)).toBe(true);

  const studioInfo = JSON.parse(readFileSync(studioFilePath, 'utf8')) as {
    sessionId: string;
    branch: string;
    databaseUrl: string;
    containerId: string;
  };
  expect(studioInfo.branch).toBe(branchName);
  expect(studioInfo.sessionId).toBe('a1b2');
  expect(studioInfo.databaseUrl).toContain('postgres://');
  expect(studioInfo.containerId).toBeTruthy();

  const changesPath = join(CLONE_ROOT, 'docs', 'studio-sessions', branchName, 'changes.md');
  expect(existsSync(changesPath)).toBe(true);
  expect(readFileSync(changesPath, 'utf8')).toContain(`# Studio Session — ${branchName}`);

  const headCommit = Bun.spawnSync(['git', 'log', '-1', '--pretty=%s'], {
    cwd: CLONE_ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  expect((headCommit.stdout ?? new Uint8Array()).toString().trim()).toBe(
    `studio: start session ${studioInfo.sessionId}`,
  );

  const deadline = Date.now() + 5_000;
  let containerInspect: ReturnType<typeof Bun.spawnSync>;
  do {
    containerInspect = Bun.spawnSync(['docker', 'inspect', studioInfo.containerId], {
      cwd: CLONE_ROOT,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    if (containerInspect.exitCode !== 0) break;
    await Bun.sleep(200);
  } while (Date.now() < deadline);
  expect(containerInspect.exitCode).not.toBe(0);
}, 90_000);

test('bun run studio fails on a non-studio branch', () => {
  cloneRepoRootWithWorkspaceChanges();

  Bun.spawnSync(['git', 'config', 'user.name', 'Studio Start Test'], {
    cwd: CLONE_ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  Bun.spawnSync(['git', 'config', 'user.email', 'studio-start-test@example.com'], {
    cwd: CLONE_ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  Bun.spawnSync(['git', 'branch', '-f', 'main', 'HEAD'], {
    cwd: CLONE_ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  Bun.spawnSync(['git', 'checkout', 'main'], {
    cwd: CLONE_ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const studio = Bun.spawnSync(['bun', 'run', 'studio'], {
    cwd: CLONE_ROOT,
    env: {
      ...process.env,
      STUDIO_EXIT_AFTER_BOOTSTRAP: '1',
      STUDIO_SKIP_PUSH: '1',
      STUDIO_PORT: '5179',
      STUDIO_API_PORT: '31419',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });

  expect(studio.exitCode).toBe(1);
  expect((studio.stderr ?? new Uint8Array()).toString()).toContain(
    'Studio requires a branch named studio/session-',
  );
  expect(existsSync(join(CLONE_ROOT, '.studio'))).toBe(false);
});
