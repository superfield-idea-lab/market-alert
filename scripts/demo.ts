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
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  phase: string;
}

const CLUSTER_NAME = 'calypso-demo';
const NAMESPACE = 'default';
const IMAGE_REPO = 'calypso-demo-app';
const DB_HOST = 'calypso-dev-postgres';
const DEFAULT_DB_PORT = Number(process.env.CALYPSO_DEMO_DB_PORT ?? 5432);
const DEFAULT_PORT = Number(process.env.CALYPSO_DEMO_PORT ?? 58080);
const MODULE_DIR =
  typeof import.meta.dir === 'string'
    ? import.meta.dir
    : fileURLToPath(new URL('.', import.meta.url));
const KUBECONFIG_PATH = join(MODULE_DIR, '..', '.k3d-kubeconfig');
const REPO_ROOT = join(MODULE_DIR, '..');

const DEMO_DB_PASSWORDS = {
  agentAnalysis: 'agent-analysis-password',
  agentCodeCleanup: 'agent-code-cleanup-password',
  agentCoding: 'agent-coding-password',
  agentEmailIngest: 'agent-email-ingest-password',
  analytics: 'analytics_w_password',
  app: 'app_rw_password',
  audit: 'audit_w_password',
  dictionary: 'dict_rw_password',
  jwtSecret: 'demo-jwt-secret',
  superuserEmail: 'demo-admin@calypso.local',
  superuserPassword: 'demo-admin-password',
} as const;

function yamlValue(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function nowTag(): string {
  return `demo-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`;
}

export function demoConfig(
  input: Partial<Pick<DemoConfig, 'dbPort' | 'interactive' | 'imageTag' | 'port'>> = {},
): DemoConfig {
  return {
    clusterName: CLUSTER_NAME,
    dbHost: DB_HOST,
    dbPort: input.dbPort ?? DEFAULT_DB_PORT,
    imageRepo: IMAGE_REPO,
    imageTag: input.imageTag ?? nowTag(),
    interactive: input.interactive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY),
    kubeconfigPath: KUBECONFIG_PATH,
    namespace: NAMESPACE,
    port: input.port ?? DEFAULT_PORT,
    repoRoot: REPO_ROOT,
  };
}

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
        'kubectl rollout status statefulset/calypso-dev-postgres --timeout=120s',
        `ADMIN_DATABASE_URL=postgres://calypso:calypso@localhost:${config.dbPort}/postgres bun run packages/db/init-remote.ts`,
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
        'kubectl rollout status deployment/calypso-app --timeout=180s',
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
    ANALYTICS_DATABASE_URL: `postgres://analytics_w:${DEMO_DB_PASSWORDS.analytics}@${DB_HOST}:5432/calypso_analytics`,
    AUDIT_DATABASE_URL: `postgres://audit_w:${DEMO_DB_PASSWORDS.audit}@${DB_HOST}:5432/calypso_audit`,
    DATABASE_URL: `postgres://app_rw:${DEMO_DB_PASSWORDS.app}@${DB_HOST}:5432/calypso_app`,
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
    renderSecretDocument('calypso-secrets', appSecrets),
    renderSecretDocument('calypso-api-secrets', apiSecrets),
  ].join('\n---\n');
}

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
      KUBECONFIG: KUBECONFIG_PATH,
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

function capture(command: string[]): string {
  const result = Bun.spawnSync(command, {
    cwd: REPO_ROOT,
    env: { ...process.env, KUBECONFIG: KUBECONFIG_PATH },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return new TextDecoder().decode(result.stdout).trim();
}

function clusterExists(config: DemoConfig): boolean {
  try {
    const payload = capture(['k3d', 'cluster', 'list', '-o', 'json']);
    const clusters = JSON.parse(payload) as Array<{ name?: string }>;
    return clusters.some((cluster) => cluster.name === config.clusterName);
  } catch {
    return false;
  }
}

async function applyTempManifest(filename: string, contents: string): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'calypso-demo-'));
  const filePath = join(dir, filename);
  try {
    writeFileSync(filePath, contents, 'utf-8');
    await run(['kubectl', 'apply', '-f', filePath], { cwd: REPO_ROOT, phase: 'deploy' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function renderDemoAppManifest(imageRef: string): string {
  const appYaml = readFileSync(join(REPO_ROOT, 'k8s', 'app.yaml'), 'utf-8');
  return appYaml.replace('ghcr.io/<owner>/calypso-starter-ts:latest', imageRef);
}

async function bootstrapDatabase(config: DemoConfig): Promise<void> {
  const env = {
    ADMIN_DATABASE_URL: `postgres://calypso:calypso@localhost:${config.dbPort}/postgres`,
    AGENT_ANALYSIS_PASSWORD: DEMO_DB_PASSWORDS.agentAnalysis,
    AGENT_CODE_CLEANUP_PASSWORD: DEMO_DB_PASSWORDS.agentCodeCleanup,
    AGENT_CODING_PASSWORD: DEMO_DB_PASSWORDS.agentCoding,
    AGENT_EMAIL_INGEST_PASSWORD: DEMO_DB_PASSWORDS.agentEmailIngest,
    ANALYTICS_W_PASSWORD: DEMO_DB_PASSWORDS.analytics,
    APP_RW_PASSWORD: DEMO_DB_PASSWORDS.app,
    AUDIT_W_PASSWORD: DEMO_DB_PASSWORDS.audit,
    DICT_RW_PASSWORD: DEMO_DB_PASSWORDS.dictionary,
  };
  await run(['bun', 'run', 'packages/db/init-remote.ts'], {
    cwd: REPO_ROOT,
    env,
    phase: 'database bootstrap',
  });
}

async function buildDemoImage(config: DemoConfig): Promise<string> {
  const imageRef = `${config.imageRepo}:${config.imageTag}`;
  await run(['docker', 'build', '-f', 'Dockerfile.release', '-t', imageRef, '.'], {
    cwd: REPO_ROOT,
    phase: 'image build',
  });
  await run(['k3d', 'image', 'import', '-c', config.clusterName, imageRef], {
    cwd: REPO_ROOT,
    phase: 'image import',
  });
  return imageRef;
}

async function deployDemoImage(config: DemoConfig, imageRef: string): Promise<void> {
  await applyTempManifest(
    'demo-runtime.yaml',
    [buildDemoSecretManifests(config), renderDemoAppManifest(imageRef)].join('\n---\n'),
  );
  await run(['kubectl', 'rollout', 'status', 'deployment/calypso-app', '--timeout=180s'], {
    cwd: REPO_ROOT,
    phase: 'deploy',
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
    ['kubectl', 'port-forward', 'deployment/calypso-app', `${config.port}:31415`],
    {
      cwd: REPO_ROOT,
      env: { ...process.env, KUBECONFIG: KUBECONFIG_PATH },
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

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const statusOnly = args.includes('--status');
  const shouldDelete = args.includes('--delete');
  const config = demoConfig();

  if (statusOnly) {
    console.log(
      `k3d cluster '${config.clusterName}': ${clusterExists(config) ? 'running' : 'not found'}`,
    );
    return;
  }

  if (shouldDelete) {
    if (!clusterExists(config)) {
      console.log(`k3d cluster '${config.clusterName}' does not exist — nothing to delete.`);
      return;
    }
    await run(['k3d', 'cluster', 'delete', config.clusterName], {
      cwd: REPO_ROOT,
      phase: 'cluster teardown',
    });
    return;
  }

  if (clusterExists(config)) {
    console.log(`\n[k3d] Reusing cluster '${config.clusterName}'.`);
  } else {
    console.log(`\n[k3d] Creating cluster '${config.clusterName}'.`);
    await run(
      [
        'k3d',
        'cluster',
        'create',
        config.clusterName,
        '--port',
        `${config.dbPort}:5432@loadbalancer`,
        '--wait',
      ],
      { cwd: REPO_ROOT, phase: 'cluster bootstrap' },
    );
  }

  await run(['k3d', 'kubeconfig', 'write', config.clusterName, '--output', config.kubeconfigPath], {
    cwd: REPO_ROOT,
    phase: 'cluster bootstrap',
  });

  console.log('[demo] Applying dev Postgres manifests.');
  await run(['kubectl', 'apply', '-f', join(REPO_ROOT, 'k8s', 'dev', 'dev-secrets.yaml')], {
    cwd: REPO_ROOT,
    phase: 'database bootstrap',
  });
  await run(['kubectl', 'apply', '-f', join(REPO_ROOT, 'k8s', 'dev', 'postgres.yaml')], {
    cwd: REPO_ROOT,
    phase: 'database bootstrap',
  });
  await run(
    ['kubectl', 'rollout', 'status', 'statefulset/calypso-dev-postgres', '--timeout=120s'],
    {
      cwd: REPO_ROOT,
      phase: 'database bootstrap',
    },
  );

  console.log('[demo] Bootstrapping databases and roles.');
  await bootstrapDatabase(config);

  console.log('[demo] Building and importing the local release image.');
  const imageRef = await buildDemoImage(config);

  console.log('[demo] Applying the app runtime manifest.');
  await deployDemoImage(config, imageRef);

  const portForward = startPortForward(config);
  try {
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
    try {
      portForward.kill();
    } catch {
      // best effort
    }
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(`[demo] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
