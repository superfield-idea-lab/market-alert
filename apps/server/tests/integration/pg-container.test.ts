import { test, expect, beforeAll, afterAll } from 'vitest';
import { startPostgres, type PgContainer } from '../helpers/pg-container';

let pg: PgContainer;

beforeAll(async () => {
  pg = await startPostgres();
}, 60_000);

afterAll(async () => {
  await pg.stop();
});

test('container starts and returns a valid DATABASE_URL', () => {
  expect(pg.url).toMatch(/^postgres:\/\/calypso:calypso@localhost:\d+\/calypso$/);
});

test('container is reachable and accepts queries', async () => {
  const proc = Bun.spawnSync([
    'docker',
    'exec',
    pg.containerId,
    'psql',
    '-U',
    'calypso',
    '-d',
    'calypso',
    '-c',
    'SELECT 1 AS ok',
  ]);
  expect(proc.exitCode).toBe(0);
  expect(new TextDecoder().decode(proc.stdout)).toContain('ok');
});

test('stop() removes the container', async () => {
  await pg.stop();
  const deadline = Date.now() + 5_000;
  let proc: ReturnType<typeof Bun.spawnSync>;
  do {
    proc = Bun.spawnSync(['docker', 'inspect', pg.containerId]);
    if (proc.exitCode !== 0) break;
    await Bun.sleep(200);
  } while (Date.now() < deadline);
  expect(proc.exitCode).not.toBe(0);
  // Prevent afterAll from calling stop() again on an already-stopped container
  pg.stop = async () => {};
});
