#!/usr/bin/env bun
/**
 * demo — cluster-backed local demo runtime that builds the app from the
 * current workspace, deploys it into k3d, and offers an interactive refresh
 * loop for subsequent source changes.
 *
 * Usage:
 *   bun run demo
 *   bun run demo --status
 *   bun run demo --delete
 *
 * Each `bun run demo` invocation creates a uniquely-named k3d cluster with
 * randomised host ports so multiple demos can run concurrently on one host
 * without port collisions.  Set SUPERFIELD_DEMO_CLUSTER to reuse a specific
 * existing cluster by name.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';

export interface DemoConfig {
  clusterName: string;
  dbHost: string;
  dbPort: number;
  imageRepo: string;
  imageTag: string;
  interactive: boolean;
  kubeconfigPath: string;
  namespace: string;
  port: number;
  repoRoot: string;
}

export interface DemoPlanStep {
  commands: string[];
  name: string;
}

interface RunOptions {
  cwd?: string;
  env?: Record<string, string>;
  kubeconfigPath: string;
  phase: string;
}

const CLUSTER_PREFIX = 'superfield-demo';
const NAMESPACE = 'default';
const IMAGE_REPO = 'superfield-demo-app';
const DB_HOST = 'superfield-dev-postgres';
const MODULE_DIR =
  typeof import.meta.dir === 'string'
    ? import.meta.dir
    : fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = join(MODULE_DIR, '..');

const DEMO_DB_PASSWORDS = {
  agentEmailIngest: 'agent-email-ingest-password',
  analytics: 'analytics_w_password',
  app: 'app_rw_password',
  audit: 'audit_w_password',
  dictionary: 'dict_rw_password',
  jwtSecret: 'demo-jwt-secret',
  superuserEmail: 'demo-admin@superfield.local',
  superuserPassword: 'demo-admin-password',
} as const;

// ---------------------------------------------------------------------------
// Port / name helpers
// ---------------------------------------------------------------------------

/** Pick a random port in the IANA ephemeral range (49152–65535). */
function randomPort(): number {
  return Math.floor(Math.random() * (65535 - 49152 + 1)) + 49152;
}

/** Generate a unique cluster name with a short random suffix. */
function randomClusterName(): string {
  return `${CLUSTER_PREFIX}-${Math.random().toString(36).slice(2, 8)}`;
}

function yamlValue(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function nowTag(): string {
  return `demo-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`;
}

function clusterKubeconfigPath(clusterName: string): string {
  return join(REPO_ROOT, `.k3d-kubeconfig-${clusterName}`);
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export function demoConfig(
  input: Partial<Pick<DemoConfig, 'dbPort' | 'interactive' | 'imageTag' | 'port'>> & {
    clusterName?: string;
  } = {},
): DemoConfig {
  const clusterName =
    input.clusterName ?? process.env.SUPERFIELD_DEMO_CLUSTER ?? randomClusterName();

  // dbPort is randomised so concurrent demos don't collide on the k3d
  // loadbalancer host binding.  port (the kubectl port-forward endpoint) is
  // kept at a stable default so reverse-tunnel setups can target a known port;
  // override via SUPERFIELD_DEMO_PORT when needed.
  const dbPort =
    input.dbPort ??
    (process.env.SUPERFIELD_DEMO_DB_PORT
      ? Number(process.env.SUPERFIELD_DEMO_DB_PORT)
      : randomPort());
  const port = input.port ?? Number(process.env.SUPERFIELD_DEMO_PORT ?? 58080);

  return {
    clusterName,
    dbHost: DB_HOST,
    dbPort,
    imageRepo: IMAGE_REPO,
    imageTag: input.imageTag ?? nowTag(),
    interactive: input.interactive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY),
    kubeconfigPath: clusterKubeconfigPath(clusterName),
    namespace: NAMESPACE,
    port,
    repoRoot: REPO_ROOT,
  };
}

// ---------------------------------------------------------------------------
// Plan / secrets
// ---------------------------------------------------------------------------

export function buildDemoPlan(config: DemoConfig): DemoPlanStep[] {
  const imageRef = `${config.imageRepo}:${config.imageTag}`;
  return [
    {
      name: 'cluster bootstrap',
      commands: [
        `k3d cluster create ${config.clusterName} --port ${config.dbPort}:5432@loadbalancer --wait`,
        `k3d kubeconfig write ${config.clusterName} --output ${config.kubeconfigPath}`,
      ],
    },
    {
      name: 'database bootstrap',
      commands: [
        'kubectl apply -f k8s/dev/dev-secrets.yaml',
        'kubectl apply -f k8s/dev/postgres.yaml',
        'kubectl rollout status statefulset/superfield-dev-postgres --timeout=120s',
        `ADMIN_DATABASE_URL=postgres://superfield:superfield@localhost:${config.dbPort}/postgres bun run packages/db/init-remote.ts`,
      ],
    },
    {
      name: 'image build',
      commands: [`docker build -f Dockerfile.release -t ${imageRef} .`],
    },
    {
      name: 'image import',
      commands: [`k3d image import -c ${config.clusterName} ${imageRef}`],
    },
    {
      name: 'manifest apply',
      commands: ['kubectl apply -f k8s/app.yaml', 'kubectl apply -f <rendered demo secrets>'],
    },
    {
      name: 'rollout',
      commands: [
        'kubectl rollout status deployment/superfield-app --timeout=180s',
        `curl -sf http://127.0.0.1:${config.port}/health/live`,
      ],
    },
    {
      name: 'watch prompt loop',
      commands: [
        'Press Enter to rebuild and redeploy the latest local code.',
        'Type q then Enter to quit the interactive loop.',
      ],
    },
  ];
}

function renderSecretDocument(name: string, data: Record<string, string>): string {
  const lines = [
    'apiVersion: v1',
    'kind: Secret',
    'metadata:',
    `  name: ${name}`,
    'type: Opaque',
    'stringData:',
  ];

  for (const [key, value] of Object.entries(data)) {
    lines.push(`  ${key}: ${yamlValue(value)}`);
  }

  return lines.join('\n');
}

export function buildDemoSecretManifests(_config: DemoConfig): string {
  const dbUrls = {
    ANALYTICS_DATABASE_URL: `postgres://analytics_w:${DEMO_DB_PASSWORDS.analytics}@${DB_HOST}:5432/superfield_analytics`,
    AUDIT_DATABASE_URL: `postgres://audit_w:${DEMO_DB_PASSWORDS.audit}@${DB_HOST}:5432/superfield_audit`,
    DATABASE_URL: `postgres://app_rw:${DEMO_DB_PASSWORDS.app}@${DB_HOST}:5432/superfield_app`,
    DICTIONARY_DATABASE_URL: `postgres://dict_rw:${DEMO_DB_PASSWORDS.dictionary}@${DB_HOST}:5432/superfield_dictionary`,
  };

  const appSecrets = {
    ...dbUrls,
    BLOOMBERG_API_KEY: '',
    JWT_SECRET: DEMO_DB_PASSWORDS.jwtSecret,
    SUBSTACK_API_KEY: '',
    SUPERUSER_EMAIL: DEMO_DB_PASSWORDS.superuserEmail,
    SUPERUSER_PASSWORD: DEMO_DB_PASSWORDS.superuserPassword,
    YAHOO_API_KEY: '',
  };

  const apiSecrets = {
    ...dbUrls,
    BLOOMBERG_API_KEY: '',
    JWT_SECRET: DEMO_DB_PASSWORDS.jwtSecret,
    SUBSTACK_API_KEY: '',
    SUPERUSER_EMAIL: DEMO_DB_PASSWORDS.superuserEmail,
    SUPERUSER_PASSWORD: DEMO_DB_PASSWORDS.superuserPassword,
    YAHOO_API_KEY: '',
  };

  return [
    renderSecretDocument('superfield-secrets', appSecrets),
    renderSecretDocument('superfield-api-secrets', apiSecrets),
  ].join('\n---\n');
}

// ---------------------------------------------------------------------------
// Error helpers
// ---------------------------------------------------------------------------

function summarizeFailure(stderr: string): string {
  return stderr
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-2)
    .join(' ');
}

function conflictedPort(stderr: string): string | null {
  const match = stderr.match(/bind host port .*:(\d+)\/tcp/i);
  return match?.[1] ?? null;
}

export function describeCommandFailure(phase: string, command: string[], stderr = ''): string {
  const commandText = command.join(' ');
  const compactStderr = summarizeFailure(stderr);
  const port = conflictedPort(stderr);

  if (phase === 'cluster bootstrap' && /address already in use/i.test(stderr) && port) {
    return `${phase} failed: Host port ${port} is already in use. Stop the conflicting process or free the port, then rerun \`${commandText}\`.`;
  }

  if (compactStderr) {
    return `${phase} failed while running \`${commandText}\`: ${compactStderr}`;
  }

  return `${phase} failed while running \`${commandText}\`.`;
}

export function describeProbeFailure(phase: string, url: string, error: unknown): string {
  return `${phase} failed while probing \`${url}\`: ${error instanceof Error ? error.message : String(error)}`;
}

// ---------------------------------------------------------------------------
// Process helpers
// ---------------------------------------------------------------------------

async function streamAndCapture(
  stream: ReadableStream<Uint8Array> | null | undefined,
  writer: NodeJS.WriteStream,
): Promise<string> {
  if (!stream) return '';

  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let output = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      output += chunk;
      writer.write(chunk);
    }
    const trailing = decoder.decode();
    if (trailing) {
      output += trailing;
      writer.write(trailing);
    }
  } finally {
    reader.releaseLock();
  }

  return output.trim();
}

async function run(command: string[], opts: RunOptions): Promise<void> {
  const child = Bun.spawn(command, {
    cwd: opts.cwd ?? REPO_ROOT,
    env: {
      ...process.env,
      ...opts.env,
      KUBECONFIG: opts.kubeconfigPath,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const [, stderr, exitCode] = await Promise.all([
    streamAndCapture(child.stdout, process.stdout),
    streamAndCapture(child.stderr, process.stderr),
    child.exited,
  ]);

  if (exitCode !== 0) {
    throw new Error(describeCommandFailure(opts.phase, command, stderr));
  }
}

// ---------------------------------------------------------------------------
// Cluster helpers
// ---------------------------------------------------------------------------

/** Return the names of all running k3d clusters that start with CLUSTER_PREFIX. */
function listDemoClusters(): string[] {
  try {
    const result = Bun.spawnSync(['k3d', 'cluster', 'list', '-o', 'json'], {
      cwd: REPO_ROOT,
      env: process.env,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const clusters = JSON.parse(new TextDecoder().decode(result.stdout)) as Array<{
      name?: string;
    }>;
    return clusters.map((c) => c.name ?? '').filter((name) => name.startsWith(CLUSTER_PREFIX));
  } catch {
    return [];
  }
}

function clusterExists(config: DemoConfig): boolean {
  return listDemoClusters().includes(config.clusterName);
}

// ---------------------------------------------------------------------------
// Demo steps
// ---------------------------------------------------------------------------

async function applyTempManifest(
  filename: string,
  contents: string,
  kubeconfigPath: string,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'superfield-demo-'));
  const filePath = join(dir, filename);
  try {
    writeFileSync(filePath, contents, 'utf-8');
    await run(['kubectl', 'apply', '-f', filePath], {
      cwd: REPO_ROOT,
      kubeconfigPath,
      phase: 'deploy',
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function renderDemoAppManifest(imageRef: string): string {
  const appYaml = readFileSync(join(REPO_ROOT, 'k8s', 'app.yaml'), 'utf-8');
  return appYaml.replace('ghcr.io/<owner>/superfield-starter-ts:latest', imageRef);
}

async function bootstrapDatabase(config: DemoConfig): Promise<void> {
  const env = {
    ADMIN_DATABASE_URL: `postgres://superfield:superfield@localhost:${config.dbPort}/postgres`,
    AGENT_EMAIL_INGEST_PASSWORD: DEMO_DB_PASSWORDS.agentEmailIngest,
    ANALYTICS_W_PASSWORD: DEMO_DB_PASSWORDS.analytics,
    APP_RW_PASSWORD: DEMO_DB_PASSWORDS.app,
    AUDIT_W_PASSWORD: DEMO_DB_PASSWORDS.audit,
    DICT_RW_PASSWORD: DEMO_DB_PASSWORDS.dictionary,
  };

  // The postgres service is ClusterIP — it is not reachable via the k3d
  // loadbalancer port mapping.  Use kubectl port-forward to expose it locally
  // for the duration of the bootstrap run.
  console.log(
    `[demo] Starting port-forward: svc/superfield-dev-postgres → localhost:${config.dbPort}`,
  );
  const portForward = Bun.spawn(
    ['kubectl', 'port-forward', 'svc/superfield-dev-postgres', `${config.dbPort}:5432`],
    {
      cwd: REPO_ROOT,
      env: { ...process.env, KUBECONFIG: config.kubeconfigPath },
      stdout: 'pipe',
      stderr: 'inherit',
    },
  );
  try {
    console.log(`[demo] Waiting for postgres to accept connections on localhost:${config.dbPort}…`);
    await waitForTcpPort('127.0.0.1', config.dbPort);
    console.log(`[demo] Postgres port-forward ready. Running init-remote.`);
    await run(['bun', 'run', 'packages/db/init-remote.ts'], {
      cwd: REPO_ROOT,
      env,
      kubeconfigPath: config.kubeconfigPath,
      phase: 'database bootstrap',
    });
  } finally {
    console.log(`[demo] Stopping port-forward for svc/superfield-dev-postgres.`);
    try {
      portForward.kill();
    } catch {
      // best effort
    }
  }
}

async function buildDemoImage(config: DemoConfig): Promise<string> {
  const imageRef = `${config.imageRepo}:${config.imageTag}`;
  await run(['docker', 'build', '-f', 'Dockerfile.release', '-t', imageRef, '.'], {
    cwd: REPO_ROOT,
    kubeconfigPath: config.kubeconfigPath,
    phase: 'image build',
  });
  await run(['k3d', 'image', 'import', '-c', config.clusterName, imageRef], {
    cwd: REPO_ROOT,
    kubeconfigPath: config.kubeconfigPath,
    phase: 'image import',
  });
  return imageRef;
}

async function deployDemoImage(config: DemoConfig, imageRef: string): Promise<void> {
  await applyTempManifest(
    'demo-runtime.yaml',
    [buildDemoSecretManifests(config), renderDemoAppManifest(imageRef)].join('\n---\n'),
    config.kubeconfigPath,
  );
  await run(['kubectl', 'rollout', 'status', 'deployment/superfield-app', '--timeout=180s'], {
    cwd: REPO_ROOT,
    kubeconfigPath: config.kubeconfigPath,
    phase: 'deploy',
  });
}

function waitForTcpPort(host: string, port: number, timeoutMs = 30_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const attempt = () => {
      const socket = createConnection({ host, port });
      socket.once('connect', () => {
        socket.destroy();
        resolve();
      });
      socket.once('error', () => {
        socket.destroy();
        if (Date.now() >= deadline) {
          reject(new Error(`Timed out waiting for ${host}:${port}`));
          return;
        }
        setTimeout(attempt, 500);
      });
    };
    attempt();
  });
}

async function waitForHealth(url: string, timeoutMs = 120_000): Promise<void> {
  const started = Date.now();
  let lastError: string | null = null;

  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
      lastError = `HTTP ${res.status}`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }

  throw new Error(
    `Timed out waiting for ${url} to become healthy${lastError ? ` (${lastError})` : ''}.`,
  );
}

function startPortForward(config: DemoConfig) {
  const child = Bun.spawn(
    [
      'kubectl',
      'port-forward',
      '--address',
      '0.0.0.0',
      'deployment/superfield-app',
      `${config.port}:31415`,
    ],
    {
      cwd: REPO_ROOT,
      env: { ...process.env, KUBECONFIG: config.kubeconfigPath },
      stdout: 'inherit',
      stderr: 'inherit',
    },
  );
  return child;
}

async function refreshOnce(config: DemoConfig): Promise<string> {
  config.imageTag = nowTag();
  const imageRef = await buildDemoImage(config);
  await deployDemoImage(config, imageRef);
  try {
    await waitForHealth(`http://127.0.0.1:${config.port}/health/live`);
  } catch (error) {
    throw new Error(
      describeProbeFailure(
        'deploy readiness',
        `http://127.0.0.1:${config.port}/health/live`,
        error,
      ),
      { cause: error },
    );
  }
  return imageRef;
}

async function runInteractiveLoop(config: DemoConfig): Promise<void> {
  if (!config.interactive) {
    console.log(`  Local URL: http://127.0.0.1:${config.port}/health/live`);
    return;
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    while (true) {
      const answer = (
        await rl.question('\n[demo] Press Enter to rebuild and redeploy, or q to quit: ')
      )
        .trim()
        .toLowerCase();
      if (answer === 'q' || answer === 'quit') {
        return;
      }
      const imageRef = await refreshOnce(config);
      console.log(`[demo] Deployed ${imageRef}`);
    }
  } finally {
    rl.close();
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const statusOnly = args.includes('--status');
  const shouldDelete = args.includes('--delete');

  if (statusOnly) {
    const clusters = listDemoClusters();
    if (clusters.length === 0) {
      console.log('No running demo clusters found.');
    } else {
      console.log('Running demo clusters:');
      for (const name of clusters) {
        console.log(`  ${name}`);
      }
    }
    return;
  }

  if (shouldDelete) {
    // If SUPERFIELD_DEMO_CLUSTER is set, delete only that cluster; otherwise
    // delete every superfield-demo-* cluster found on this host.
    const targeted = process.env.SUPERFIELD_DEMO_CLUSTER;
    const toDelete = targeted ? [targeted] : listDemoClusters();

    if (toDelete.length === 0) {
      console.log('No demo clusters found — nothing to delete.');
      return;
    }

    for (const name of toDelete) {
      console.log(`[k3d] Deleting cluster '${name}'.`);
      await run(['k3d', 'cluster', 'delete', name], {
        cwd: REPO_ROOT,
        kubeconfigPath: clusterKubeconfigPath(name),
        phase: 'cluster teardown',
      });
    }
    return;
  }

  const config = demoConfig();

  // Track the port-forward child process so teardown can kill it.
  let portForward: ReturnType<typeof startPortForward> | null = null;
  let cleanupDone = false;

  async function teardown(reason?: string) {
    if (cleanupDone) return;
    cleanupDone = true;
    if (reason) console.log(`\n[demo] ${reason}`);
    try {
      portForward?.kill();
    } catch {
      // best effort
    }
    console.log(`[demo] Deleting cluster '${config.clusterName}'...`);
    try {
      await run(['k3d', 'cluster', 'delete', config.clusterName], {
        cwd: REPO_ROOT,
        kubeconfigPath: config.kubeconfigPath,
        phase: 'cluster teardown',
      });
      console.log(`[demo] Cluster '${config.clusterName}' deleted.`);
    } catch (err) {
      console.error(
        `[demo] Failed to delete cluster: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Register signal handlers immediately so Ctrl-C during a slow build step
  // (image build, rollout wait) still triggers cluster teardown.
  process.on('SIGINT', async () => {
    await teardown('Interrupted (SIGINT). Tearing down...');
    process.exit(130);
  });
  process.on('SIGTERM', async () => {
    await teardown('Terminated (SIGTERM). Tearing down...');
    process.exit(143);
  });

  try {
    if (clusterExists(config)) {
      console.log(`\n[k3d] Reusing cluster '${config.clusterName}'.`);
    } else {
      console.log(
        `\n[k3d] Creating cluster '${config.clusterName}' (db-port=${config.dbPort}, app-port=${config.port}).`,
      );
      await run(['k3d', 'cluster', 'create', config.clusterName, '--wait'], {
        cwd: REPO_ROOT,
        kubeconfigPath: config.kubeconfigPath,
        phase: 'cluster bootstrap',
      });
    }

    await run(
      ['k3d', 'kubeconfig', 'write', config.clusterName, '--output', config.kubeconfigPath],
      {
        cwd: REPO_ROOT,
        kubeconfigPath: config.kubeconfigPath,
        phase: 'cluster bootstrap',
      },
    );

    console.log('[demo] Applying dev Postgres manifests.');
    await run(['kubectl', 'apply', '-f', join(REPO_ROOT, 'k8s', 'dev', 'dev-secrets.yaml')], {
      cwd: REPO_ROOT,
      kubeconfigPath: config.kubeconfigPath,
      phase: 'database bootstrap',
    });
    await run(['kubectl', 'apply', '-f', join(REPO_ROOT, 'k8s', 'dev', 'postgres.yaml')], {
      cwd: REPO_ROOT,
      kubeconfigPath: config.kubeconfigPath,
      phase: 'database bootstrap',
    });
    await run(
      ['kubectl', 'rollout', 'status', 'statefulset/superfield-dev-postgres', '--timeout=120s'],
      {
        cwd: REPO_ROOT,
        kubeconfigPath: config.kubeconfigPath,
        phase: 'database bootstrap',
      },
    );

    console.log('[demo] Bootstrapping databases and roles.');
    await bootstrapDatabase(config);

    console.log('[demo] Building and importing the local release image.');
    const imageRef = await buildDemoImage(config);

    console.log('[demo] Applying the app runtime manifest.');
    await deployDemoImage(config, imageRef);

    console.log(`[demo] Cluster: ${config.clusterName}`);
    console.log(
      `[demo] To delete: SUPERFIELD_DEMO_CLUSTER=${config.clusterName} bun run demo --delete`,
    );

    portForward = startPortForward(config);
    try {
      await waitForHealth(`http://127.0.0.1:${config.port}/health/live`);
    } catch (error) {
      throw new Error(
        describeProbeFailure(
          'deploy readiness',
          `http://127.0.0.1:${config.port}/health/live`,
          error,
        ),
        { cause: error },
      );
    }
    console.log(`[demo] Demo URL: http://127.0.0.1:${config.port}/health/live`);
    await runInteractiveLoop(config);
  } finally {
    await teardown();
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(`[demo] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
