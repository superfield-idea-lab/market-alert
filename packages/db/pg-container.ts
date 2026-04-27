/**
 * DIY Testcontainers — spins up an isolated postgres:16 Docker container
 * and tears it down on request. Used by the test suite.
 *
 * Usage:
 *   const pg = await startPostgres();
 *   // pg.url — DATABASE_URL for this container
 *   // pg.containerId — for reference
 *   // pg.stop() — removes the container
 */

import postgres from 'postgres';
import { cleanupStaleContainers, addProcess, removeProcess } from './cleanup';

const PG_USER = 'superfield';
const PG_PASSWORD = 'superfield';
const PG_DB = 'superfield';
const PG_IMAGE = 'postgres:16';
const PG_VECTOR_IMAGE = 'pgvector/pgvector:pg16';
const READY_TIMEOUT_MS = 30_000;
const PORT_POLL_INTERVAL_MS = 250;

export interface PgContainer {
  url: string;
  containerId: string;
  stop: () => Promise<void>;
}

export async function startPostgres(): Promise<PgContainer> {
  return startPostgresWithImage(PG_IMAGE, 'postgres');
}

/**
 * Start an ephemeral pgvector/pgvector:pg16 container.
 * Use this when the test requires the vector extension and HNSW index.
 */
export async function startPgvectorPostgres(): Promise<PgContainer> {
  return startPostgresWithImage(PG_VECTOR_IMAGE, 'pgvector');
}

async function startPostgresWithImage(image: string, label: string): Promise<PgContainer> {
  cleanupStaleContainers();
  const runResult = Bun.spawnSync([
    'docker',
    'run',
    '-d',
    '--rm',
    '-e',
    `POSTGRES_USER=${PG_USER}`,
    '-e',
    `POSTGRES_PASSWORD=${PG_PASSWORD}`,
    '-e',
    `POSTGRES_DB=${PG_DB}`,
    '-p',
    '0:5432',
    image,
  ]);

  if (runResult.exitCode !== 0) {
    throw new Error(
      `Failed to start postgres container: ${new TextDecoder().decode(runResult.stderr)}`,
    );
  }

  const containerId = new TextDecoder().decode(runResult.stdout).trim();
  addProcess(containerId, label);

  let port: number;
  try {
    port = await getContainerPortWithRetry(containerId);
    await waitForPostgres(port);
  } catch (err) {
    removeProcess(containerId);
    Bun.spawnSync(['docker', 'stop', containerId]);
    throw err;
  }

  const url = `postgres://${PG_USER}:${PG_PASSWORD}@localhost:${port}/${PG_DB}`;

  return {
    url,
    containerId,
    stop: async () => {
      removeProcess(containerId);
      Bun.spawnSync(['docker', 'stop', containerId]);
    },
  };
}

async function getContainerPortWithRetry(containerId: string): Promise<number> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const result = Bun.spawnSync(['docker', 'port', containerId, '5432']);
    const output = new TextDecoder().decode(result.stdout).trim();
    try {
      return parseDockerPortOutput(output);
    } catch {
      await Bun.sleep(PORT_POLL_INTERVAL_MS);
    }
  }
  throw new Error(`Timed out waiting for docker to publish port for container ${containerId}`);
}

async function waitForPostgres(port: number): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  const url = `postgres://${PG_USER}:${PG_PASSWORD}@localhost:${port}/${PG_DB}`;

  while (Date.now() < deadline) {
    try {
      const testSql = postgres(url, { connect_timeout: 2 });
      await testSql`SELECT 1`;
      await testSql.end();
      return;
    } catch {
      await Bun.sleep(300);
    }
  }
  throw new Error(`Postgres container did not become ready within ${READY_TIMEOUT_MS}ms`);
}

export function parseDockerPortOutput(output: string): number {
  if (!output.trim()) {
    throw new Error('Could not parse port from docker port output: ""');
  }
  const firstLine = output.split('\n')[0].trim();
  const port = parseInt(firstLine.split(':').at(-1) ?? '', 10);
  if (!Number.isFinite(port)) {
    throw new Error(`Could not parse port from docker port output: "${output}"`);
  }
  return port;
}
