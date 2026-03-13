import { afterEach, expect, test } from 'vitest';
import { existsSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';

const REPO_ROOT = new URL('../../../../', import.meta.url).pathname;
const CLONE_ROOT = join('/tmp', `calypso-studio-test-${Date.now()}`);

afterEach(() => {
  rmSync(CLONE_ROOT, { recursive: true, force: true });
});

test('bun run studio bootstraps an enforced-branch checkout and exits after bootstrap in test mode', async () => {
  const clone = Bun.spawnSync(['git', 'clone', REPO_ROOT, CLONE_ROOT], {
    cwd: REPO_ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  expect(clone.exitCode).toBe(0);

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
      STUDIO_ENFORCE_BRANCH: '1',
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
  const branchName = (branch.stdout ?? new Uint8Array()).toString().trim();

  expect(branchName).toMatch(/^studio\/session-[a-f0-9]+-[a-z0-9]{4}$/);

  const studioFilePath = join(CLONE_ROOT, '.studio');
  expect(existsSync(studioFilePath)).toBe(true);

  const studioInfo = JSON.parse(readFileSync(studioFilePath, 'utf8')) as {
    sessionId: string;
    branch: string;
    databaseUrl: string;
    containerId: string;
  };
  expect(studioInfo.branch).toBe(branchName);
  expect(studioInfo.sessionId).toMatch(/^[a-z0-9]{4}$/);
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
