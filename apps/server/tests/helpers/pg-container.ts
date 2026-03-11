/**
 * DIY Testcontainers — spins up an isolated postgres:16 Docker container
 * for a test suite and tears it down afterwards.
 *
 * Pattern:
 *   const pg = await startPostgres();
 *   // pg.url — DATABASE_URL for this container
 *   // pg.stop() — call in afterAll to remove the container
 */

const PG_USER = 'test';
const PG_PASSWORD = 'test';
const PG_DB = 'test';
const PG_IMAGE = 'postgres:16';
const READY_TIMEOUT_MS = 30_000;

export interface PgContainer {
  url: string;
  stop: () => Promise<void>;
}

export async function startPostgres(): Promise<PgContainer> {
  // Start container with a random host port (0 → OS picks one)
  const runResult = Bun.spawnSync([
    'docker', 'run', '-d', '--rm',
    '-e', `POSTGRES_USER=${PG_USER}`,
    '-e', `POSTGRES_PASSWORD=${PG_PASSWORD}`,
    '-e', `POSTGRES_DB=${PG_DB}`,
    '-p', '0:5432',
    PG_IMAGE,
  ]);

  if (runResult.exitCode !== 0) {
    const stderr = new TextDecoder().decode(runResult.stderr);
    throw new Error(`Failed to start postgres container: ${stderr}`);
  }

  const containerId = new TextDecoder().decode(runResult.stdout).trim();

  // Resolve the ephemeral host port Docker assigned
  const port = getContainerPort(containerId);
  const url = `postgres://${PG_USER}:${PG_PASSWORD}@localhost:${port}/${PG_DB}`;

  // Block until postgres inside the container accepts connections
  await waitForPostgres(containerId);

  return {
    url,
    stop: async () => {
      Bun.spawnSync(['docker', 'stop', containerId]);
    },
  };
}

/** Read the host-side port Docker mapped to container port 5432. */
function getContainerPort(containerId: string): number {
  const result = Bun.spawnSync(['docker', 'port', containerId, '5432']);
  const output = new TextDecoder().decode(result.stdout).trim();
  // Output is one or more lines like "0.0.0.0:54321" or ":::54321"
  // Use the last colon-delimited segment of the first line.
  const firstLine = output.split('\n')[0];
  const port = parseInt(firstLine.split(':').at(-1)!, 10);
  if (!Number.isFinite(port)) {
    throw new Error(`Could not parse port from docker port output: "${output}"`);
  }
  return port;
}

/**
 * Poll until postgres inside the container both reports ready via pg_isready
 * AND can execute a real query (guards against the "system is starting up"
 * transient state where pg_isready exits 0 but connections are still refused).
 */
async function waitForPostgres(containerId: string): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const ready = Bun.spawnSync([
      'docker', 'exec', containerId,
      'pg_isready', '-U', PG_USER,
    ]);
    if (ready.exitCode === 0) {
      // Verify with a real query to avoid the "system is starting up" race.
      const query = Bun.spawnSync([
        'docker', 'exec', containerId,
        'psql', '-U', PG_USER, '-d', PG_DB, '-c', 'SELECT 1',
      ]);
      if (query.exitCode === 0) return;
    }
    await Bun.sleep(300);
  }
  throw new Error(`Postgres container did not become ready within ${READY_TIMEOUT_MS}ms`);
}
