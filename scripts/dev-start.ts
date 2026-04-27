#!/usr/bin/env bun
/**
 * dev-start — Starts the API server subprocess and Vite in middleware mode as
 * the single HTTP entry point. Proxies /api through to the API server.
 *
 * ENV-D-002: Postgres is provided by the k3d dev cluster (not an ephemeral
 * Docker container). Run `pnpm dev:cluster` to create the cluster and
 * `pnpm db:migrate` to apply the baseline migration before running this script.
 * The `pnpm dev` shortcut runs all three steps in sequence.
 *
 * Integration tests (ENV-X-009) still use ephemeral Docker containers via
 * packages/db/pg-container.ts — they never run against the cluster database.
 *
 * Run via: pnpm dev  (preferred — runs cluster setup + migrate + this script)
 *          bun run scripts/dev-start.ts  (if cluster is already running)
 */

import { join } from 'path';
import { createServer as createHttpServer } from 'node:http';
import { createConnection } from 'node:net';
import { networkInterfaces } from 'node:os';
import { createServer as createViteServer } from 'vite';
import { createProxy } from '../apps/web/vite.config';

// Dev cluster Postgres URL (k3d loadbalancer exposes port 5432 on localhost)
const DEV_DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://superfield:superfield@localhost:5432/superfield';

const REPO_ROOT = join(import.meta.dir, '..');
const WEB_PORT_BASE = Number(process.env.PORT ?? 5174);
const MAX_PORT_SEARCH = 20;

/**
 * Returns true if the given TCP port is already in use on 127.0.0.1.
 */
function isPortOccupied(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port }, () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('error', () => {
      socket.destroy();
      resolve(false);
    });
  });
}

/**
 * Finds the first free TCP port starting from `base`, incrementing by 1
 * up to MAX_PORT_SEARCH times. Logs a message if the base port was occupied.
 */
async function findFreePort(base: number): Promise<number> {
  for (let offset = 0; offset < MAX_PORT_SEARCH; offset++) {
    const candidate = base + offset;
    const occupied = await isPortOccupied(candidate);
    if (!occupied) {
      if (offset > 0) {
        console.log(`  Port ${base} is in use. Using port ${candidate} instead.`);
      }
      return candidate;
    }
  }
  throw new Error(
    `No free port found in range ${base}–${base + MAX_PORT_SEARCH - 1}. ` +
      `Free a port and retry.`,
  );
}

// Cleanup state — tracks resources that need to be torn down.
let cleanupCalled = false;
let apiServerHandle: { kill: () => void } | null = null;
let viteHandle: { close: () => Promise<void> } | null = null;
let httpServerHandle: ReturnType<typeof createHttpServer> | null = null;

async function cleanup() {
  if (cleanupCalled) return;
  cleanupCalled = true;

  console.log('\n⬡ Shutting down');
  try {
    apiServerHandle?.kill();
  } catch {
    // best-effort
  }
  try {
    await viteHandle?.close();
  } catch {
    // best-effort
  }
  try {
    httpServerHandle?.close();
  } catch {
    // best-effort
  }
  // Note: the k3d cluster continues running after dev-start exits.
  // Use `pnpm dev:cluster:delete` to tear it down explicitly.
  console.log('  Done.');
}

// Synchronous exit — ensures containers stop even on process.exit() calls.
process.on('exit', () => {
  // Synchronous best-effort: kill child process.  pg.stop() is async so we
  // can only trigger it if cleanup() was already called and awaited before exit.
  try {
    apiServerHandle?.kill();
  } catch {
    // ignore
  }
});

process.on('SIGINT', async () => {
  await cleanup();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  await cleanup();
  process.exit(0);
});

process.on('uncaughtException', async (err) => {
  console.error('\n❌ Uncaught exception:', err instanceof Error ? err.message : String(err));
  await cleanup();
  process.exit(1);
});

async function main() {
  console.log('\n⬡ Starting dev environment');
  console.log(`  Database: ${DEV_DATABASE_URL.replace(/:[^:@]+@/, ':***@')}`);

  // Set database env vars from the k3d cluster URL (ENV-D-002).
  // pnpm dev:cluster and pnpm db:migrate already ran; Postgres is up and migrated.
  process.env.DATABASE_URL = DEV_DATABASE_URL;
  process.env.AUDIT_DATABASE_URL = process.env.AUDIT_DATABASE_URL ?? DEV_DATABASE_URL;
  process.env.ANALYTICS_DATABASE_URL = process.env.ANALYTICS_DATABASE_URL ?? DEV_DATABASE_URL;

  // 0. Probe WEB_PORT; increment if occupied
  const WEB_PORT = await findFreePort(WEB_PORT_BASE);
  const API_PORT = WEB_PORT + 1;

  // 1. Spawn API server subprocess with all DB URLs set
  const apiServer = Bun.spawn(['bun', 'run', '--hot', 'src/index.ts'], {
    cwd: join(REPO_ROOT, 'apps', 'server'),
    env: {
      ...process.env,
      DATABASE_URL: DEV_DATABASE_URL,
      AUDIT_DATABASE_URL: process.env.AUDIT_DATABASE_URL,
      ANALYTICS_DATABASE_URL: process.env.ANALYTICS_DATABASE_URL,
      PORT: String(API_PORT),
      // Bind the API server to loopback in dev — it is accessed via the Vite
      // proxy and should never be directly reachable on external interfaces.
      SERVER_HOSTNAME: '127.0.0.1',
    },
    stdout: 'inherit',
    stderr: 'inherit',
  });
  apiServerHandle = apiServer;

  // 2. Create the HTTP server first so Vite can attach its HMR WebSocket
  //    upgrade handler to it instead of spawning a separate listener on 24678.
  const httpServer = createHttpServer();
  httpServerHandle = httpServer;

  // 3. Start Vite in middleware mode — pass the HTTP server so HMR WebSocket
  //    upgrades are handled on the same port as the dev server.
  const vite = await createViteServer({
    configFile: join(REPO_ROOT, 'apps', 'web', 'vite.config.ts'),
    root: join(REPO_ROOT, 'apps', 'web'),
    server: {
      middlewareMode: true,
      hmr: { server: httpServer },
      proxy: createProxy({ ...process.env, PORT: String(API_PORT) }),
    },
    appType: 'spa',
  });
  viteHandle = vite;

  // Attach Vite middleware after the server is created so the HMR server
  // reference is already set before any upgrade events can arrive.
  httpServer.on('request', vite.middlewares);

  httpServer.on('error', async (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(
        `\n❌ Port ${WEB_PORT} is already in use. ` + `Stop the process using that port and retry.`,
      );
    } else {
      console.error(`\n❌ HTTP server error on port ${WEB_PORT}: ${err.message}`);
    }
    await cleanup();
    process.exit(1);
  });

  httpServer.listen(WEB_PORT, '0.0.0.0', () => {
    const nets = networkInterfaces();
    const networkIp =
      Object.values(nets)
        .flat()
        .find((n) => n && n.family === 'IPv4' && !n.internal)?.address ?? 'localhost';

    console.log(`\n⬡ Dev server ready`);
    console.log(`  Network: http://${networkIp}:${WEB_PORT}`);
    console.log(`  Local:   http://localhost:${WEB_PORT}`);
    console.log('  Press Ctrl+C to stop\n');
  });
}

main().catch(async (err) => {
  console.error('\n❌ Dev startup failed.');
  console.error(err instanceof Error ? err.message : String(err));
  await cleanup();
  process.exit(1);
});
