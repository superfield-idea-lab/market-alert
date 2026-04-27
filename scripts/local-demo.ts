#!/usr/bin/env bun
/**
 * local-demo.ts — Local Kubernetes demo runtime using k3d.
 *
 * Run via: bun run demo
 *
 * Lifecycle:
 *   1) Verify docker/k3d/kubectl/bun are installed and docker daemon is up
 *   2) Create/reuse a k3d cluster with host ingress + postgres port mappings
 *   3) Apply dev Postgres manifests and wait for readiness
 *   4) Run schema migration against the cluster Postgres
 *   5) Build latest app image (Dockerfile.release) and import into k3d
 *   6) Apply demo app Service + Deployment + Ingress
 *   7) Wait for rollout and ingress health, then enter interactive watch mode
 */

import { execSync, spawn } from 'node:child_process';
import { existsSync, watch } from 'node:fs';
import { createInterface, type Interface as ReadlineInterface } from 'node:readline';
import { join } from 'node:path';
import { networkInterfaces } from 'node:os';
import { createConnection } from 'node:net';

const REPO_ROOT = join(import.meta.dir, '..');
const CLUSTER_NAME = 'superfield-demo';
const KUBECONFIG_PATH = process.env.KUBECONFIG ?? join(REPO_ROOT, '.k3d-kubeconfig-demo');
const NAMESPACE = 'default';

const INGRESS_HOST_PORT = Number(process.env.SUPERFIELD_DEMO_PORT ?? 58080);
const DB_HOST_PORT = Number(process.env.SUPERFIELD_DEMO_DB_PORT ?? 55432);
const PUBLIC_URL = `http://localhost:${INGRESS_HOST_PORT}`;

const APP_IMAGE = 'superfield-demo-app:dev';
const APP_NAME = 'superfield-demo-app';
const APP_SERVICE = 'superfield-demo-app';
const APP_SECRET = 'superfield-demo-app-secrets';
const APP_DB_URL = 'postgres://superfield:superfield@superfield-dev-postgres:5432/superfield';
const HOST_DB_URL = `postgres://superfield:superfield@localhost:${DB_HOST_PORT}/superfield`;

const WATCH_DIRS = ['apps/web', 'apps/server', 'packages'];

process.env.KUBECONFIG = KUBECONFIG_PATH;

function run(cmd: string, options?: { cwd?: string; stdio?: 'inherit' | 'pipe' }): string {
  try {
    const out = execSync(cmd, {
      cwd: options?.cwd ?? REPO_ROOT,
      stdio: options?.stdio === 'inherit' ? 'inherit' : 'pipe',
      encoding: 'utf-8',
      env: { ...process.env },
    });
    return typeof out === 'string' ? out.trim() : '';
  } catch (err) {
    const execErr = err as { stderr?: string | Buffer };
    const stderr =
      execErr.stderr instanceof Buffer ? execErr.stderr.toString('utf-8') : (execErr.stderr ?? '');
    throw new Error(`Command failed: ${cmd}\n${stderr}`, { cause: err });
  }
}

function commandExists(cmd: string): boolean {
  try {
    execSync(`command -v ${cmd}`, { stdio: 'pipe', env: { ...process.env } });
    return true;
  } catch {
    return false;
  }
}

function checkPrerequisites(): void {
  console.log('\nChecking prerequisites...');
  const missing: string[] = [];

  if (!commandExists('docker')) missing.push('docker');
  if (!commandExists('k3d')) missing.push('k3d');
  if (!commandExists('kubectl')) missing.push('kubectl');
  if (!commandExists('bun')) missing.push('bun');

  if (missing.length > 0) {
    console.error(`Missing prerequisites: ${missing.join(', ')}`);
    process.exit(1);
  }

  try {
    run('docker info');
  } catch {
    console.error('Docker daemon is not running. Start Docker and retry.');
    process.exit(1);
  }

  console.log('  All prerequisites found.');
}

function clusterExists(): boolean {
  try {
    const output = run('k3d cluster list -o json');
    const list = JSON.parse(output) as Array<{ name: string }>;
    return list.some((cluster) => cluster.name === CLUSTER_NAME);
  } catch {
    return false;
  }
}

function teardownCluster(): void {
  console.log('\nTearing down demo cluster...');
  if (!clusterExists()) {
    console.log(`  k3d cluster ${CLUSTER_NAME} is not present.`);
    return;
  }

  try {
    run(`k3d cluster delete ${CLUSTER_NAME}`, { stdio: 'inherit' });
  } catch (err) {
    console.error(
      `  Failed to delete cluster: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function ensureCluster(): void {
  if (!clusterExists()) {
    console.log(`\nCreating k3d cluster ${CLUSTER_NAME}...`);
    run(
      `k3d cluster create ${CLUSTER_NAME} --port 0.0.0.0:${INGRESS_HOST_PORT}:80@loadbalancer --wait`,
      { stdio: 'inherit' },
    );
  } else {
    console.log(`\nk3d cluster ${CLUSTER_NAME} already exists. Reusing.`);
  }

  console.log('Writing kubeconfig...');
  run(`k3d kubeconfig write ${CLUSTER_NAME} --output ${KUBECONFIG_PATH}`, { stdio: 'inherit' });
}

function applyPostgres(): void {
  console.log('\nApplying Postgres manifests...');
  run('kubectl apply -f k8s/dev/dev-secrets.yaml', { stdio: 'inherit' });
  run('kubectl apply -f k8s/dev/postgres.yaml', { stdio: 'inherit' });

  console.log('Waiting for Postgres rollout...');
  run(`kubectl rollout status statefulset/superfield-dev-postgres -n ${NAMESPACE} --timeout=180s`, {
    stdio: 'inherit',
  });
}

function waitForPort(host: string, port: number, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  return new Promise((resolve, reject) => {
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
        setTimeout(attempt, 250);
      });
    };

    attempt();
  });
}

async function runMigrations(): Promise<void> {
  console.log('\nRunning database migration against demo Postgres...');
  console.log(
    `Starting temporary port-forward: svc/superfield-dev-postgres ${DB_HOST_PORT}:5432 (namespace ${NAMESPACE})`,
  );

  const portForward = spawn(
    'kubectl',
    ['port-forward', 'svc/superfield-dev-postgres', `${DB_HOST_PORT}:5432`, '-n', NAMESPACE],
    {
      cwd: REPO_ROOT,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  portForward.stdout.on('data', (chunk) => {
    process.stdout.write(String(chunk));
  });
  portForward.stderr.on('data', (chunk) => {
    process.stderr.write(String(chunk));
  });

  try {
    await waitForPort('127.0.0.1', DB_HOST_PORT);
    run(`DATABASE_URL=${HOST_DB_URL} bun run packages/db/migrate.ts`, { stdio: 'inherit' });
  } finally {
    if (!portForward.killed) {
      portForward.kill('SIGTERM');
    }
  }
}

function buildAndImportImage(): void {
  console.log('\nBuilding app image from latest local code...');
  run(`docker build -f Dockerfile.release -t ${APP_IMAGE} .`, { stdio: 'inherit' });

  console.log(`Importing ${APP_IMAGE} into k3d cluster...`);
  run(`k3d image import ${APP_IMAGE} -c ${CLUSTER_NAME}`, { stdio: 'inherit' });
}

function applyDemoApp(): void {
  console.log('\nApplying demo app resources...');

  run(
    [
      `kubectl create secret generic ${APP_SECRET}`,
      `--from-literal=DATABASE_URL=${APP_DB_URL}`,
      `--from-literal=AUDIT_DATABASE_URL=${APP_DB_URL}`,
      `--from-literal=ANALYTICS_DATABASE_URL=${APP_DB_URL}`,
      '--from-literal=JWT_SECRET=demo-dev-secret',
      '--dry-run=client -o yaml | kubectl apply -f -',
    ].join(' '),
    { stdio: 'inherit' },
  );

  const manifest = `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${APP_NAME}
  labels:
    app: ${APP_NAME}
spec:
  replicas: 1
  selector:
    matchLabels:
      app: ${APP_NAME}
  template:
    metadata:
      labels:
        app: ${APP_NAME}
    spec:
      containers:
        - name: app
          image: ${APP_IMAGE}
          imagePullPolicy: IfNotPresent
          ports:
            - containerPort: 31415
          env:
            - name: PORT
              value: "31415"
            - name: DEMO_MODE
              value: "true"
            - name: DATABASE_URL
              valueFrom:
                secretKeyRef:
                  name: ${APP_SECRET}
                  key: DATABASE_URL
            - name: AUDIT_DATABASE_URL
              valueFrom:
                secretKeyRef:
                  name: ${APP_SECRET}
                  key: AUDIT_DATABASE_URL
            - name: ANALYTICS_DATABASE_URL
              valueFrom:
                secretKeyRef:
                  name: ${APP_SECRET}
                  key: ANALYTICS_DATABASE_URL
            - name: JWT_SECRET
              valueFrom:
                secretKeyRef:
                  name: ${APP_SECRET}
                  key: JWT_SECRET
          livenessProbe:
            httpGet:
              path: /health/live
              port: 31415
            initialDelaySeconds: 60
            periodSeconds: 20
            timeoutSeconds: 5
          readinessProbe:
            httpGet:
              path: /health/ready
              port: 31415
            initialDelaySeconds: 60
            periodSeconds: 10
            timeoutSeconds: 5
---
apiVersion: v1
kind: Service
metadata:
  name: ${APP_SERVICE}
  labels:
    app: ${APP_NAME}
spec:
  selector:
    app: ${APP_NAME}
  ports:
    - name: http
      protocol: TCP
      port: 80
      targetPort: 31415
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: ${APP_NAME}
  annotations:
    kubernetes.io/ingress.class: traefik
spec:
  rules:
    - http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: ${APP_SERVICE}
                port:
                  number: 80
`;

  run(`kubectl apply -f - <<'YAML'\n${manifest}\nYAML`, { stdio: 'inherit' });
}

function waitForAppReady(): void {
  console.log('\nWaiting for app rollout...');
  try {
    run(`kubectl rollout status deployment/${APP_NAME} -n ${NAMESPACE} --timeout=180s`, {
      stdio: 'inherit',
    });
  } catch (err) {
    // Capture pod events and logs before tearing down so the error is diagnosable.
    console.error('\nRollout timed out. Collecting diagnostics...\n');
    try {
      const podStatus = run(`kubectl get pods -n ${NAMESPACE} -l app=${APP_NAME} -o wide`);
      console.error('--- Pod status ---\n' + podStatus);
    } catch {
      /* ignore */
    }
    try {
      const podEvents = run(
        `kubectl get events -n ${NAMESPACE} --field-selector involvedObject.name=$(kubectl get pod -n ${NAMESPACE} -l app=${APP_NAME} -o jsonpath='{.items[0].metadata.name}' 2>/dev/null) --sort-by='.lastTimestamp' 2>/dev/null`,
      );
      console.error('--- Pod events ---\n' + podEvents);
    } catch {
      /* ignore */
    }
    try {
      const podLogs = run(`kubectl logs -n ${NAMESPACE} -l app=${APP_NAME} --tail=50 2>/dev/null`);
      if (podLogs) console.error('--- Pod logs (last 50 lines) ---\n' + podLogs);
    } catch {
      /* ignore */
    }
    try {
      const prevLogs = run(
        `kubectl logs -n ${NAMESPACE} -l app=${APP_NAME} --previous --tail=50 2>/dev/null`,
      );
      if (prevLogs) console.error('--- Previous pod logs (last 50 lines) ---\n' + prevLogs);
    } catch {
      /* ignore */
    }
    throw err;
  }
}

function waitForIngress(): void {
  console.log('\nWaiting for ingress route...');
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    try {
      run(`curl -sSf -o /dev/null ${PUBLIC_URL}/health/live`);
      console.log(`  Demo URL reachable: ${PUBLIC_URL}`);
      return;
    } catch {
      try {
        execSync('sleep 1');
      } catch {
        // ignore
      }
    }
  }

  console.warn(`  Ingress did not respond within timeout: ${PUBLIC_URL}`);
}

function rolloutApp(): void {
  buildAndImportImage();
  run(`kubectl rollout restart deployment/${APP_NAME}`, { stdio: 'inherit' });
  waitForAppReady();
}

function cleanRoomRestart(): void {
  console.log('\nClean-room restart of demo app resources...');
  run(
    `kubectl delete ingress/${APP_NAME} service/${APP_SERVICE} deployment/${APP_NAME} --ignore-not-found`,
    {
      stdio: 'inherit',
    },
  );
  applyDemoApp();
  waitForAppReady();
  waitForIngress();
}

type RolloutAction = 'rollout' | 'all' | 'clean' | 'skip';

function promptRolloutAction(rl: ReadlineInterface): Promise<RolloutAction> {
  return new Promise((resolve) => {
    console.log('\nFile change detected.');
    console.log('  1) Rollout app (rebuild/import/restart)');
    console.log('  2) Rebuild + re-apply app manifests');
    console.log('  3) Clean-room app restart (delete/recreate app resources)');
    console.log('  4) Skip');
    rl.question('Choose [1-4]: ', (answer) => {
      const choice = answer.trim();
      if (choice === '1') resolve('rollout');
      else if (choice === '2') resolve('all');
      else if (choice === '3') resolve('clean');
      else resolve('skip');
    });
  });
}

async function handleRolloutAction(action: RolloutAction): Promise<void> {
  if (action === 'rollout') {
    rolloutApp();
    return;
  }

  if (action === 'all') {
    buildAndImportImage();
    applyDemoApp();
    waitForAppReady();
    waitForIngress();
    return;
  }

  if (action === 'clean') {
    cleanRoomRestart();
    return;
  }

  console.log('Skipped.');
}

function startWatcher(rl: ReadlineInterface): void {
  console.log('\nWatching for file changes...');
  console.log('Press Ctrl+C to stop (cluster will be torn down on exit).\n');

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let inPrompt = false;
  let pending = false;

  const schedulePrompt = () => {
    if (inPrompt) {
      pending = true;
      return;
    }

    inPrompt = true;
    void (async () => {
      const action = await promptRolloutAction(rl);
      await handleRolloutAction(action);
      inPrompt = false;
      if (pending) {
        pending = false;
        schedulePrompt();
      }
    })();
  };

  for (const dir of WATCH_DIRS) {
    const fullPath = join(REPO_ROOT, dir);
    if (!existsSync(fullPath)) continue;

    watch(fullPath, { recursive: true }, (_event, filename) => {
      if (!filename) return;
      if (filename.includes('node_modules') || filename.includes('dist')) return;

      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        schedulePrompt();
      }, 500);
    });
  }
}

async function main(): Promise<void> {
  console.log('\n=== Superfield Local Demo ===\n');

  const args = process.argv.slice(2);
  if (args.includes('--status')) {
    console.log(`k3d cluster '${CLUSTER_NAME}': ${clusterExists() ? 'running' : 'not found'}`);
    return;
  }

  if (args.includes('--delete')) {
    console.error(
      'The --delete option is no longer supported. Stop the demo with Ctrl+C to tear down.',
    );
    process.exit(1);
  }

  checkPrerequisites();

  let teardownRan = false;
  const runTeardownOnce = () => {
    if (teardownRan) return;
    teardownRan = true;
    teardownCluster();
  };

  const onSignal = (signal: 'SIGINT' | 'SIGTERM') => {
    console.log(`\nReceived ${signal}. Cleaning up...`);
    runTeardownOnce();
    process.exit(signal === 'SIGINT' ? 130 : 143);
  };

  process.on('SIGINT', () => onSignal('SIGINT'));
  process.on('SIGTERM', () => onSignal('SIGTERM'));
  process.on('exit', () => runTeardownOnce());

  ensureCluster();
  applyPostgres();
  await runMigrations();
  buildAndImportImage();
  applyDemoApp();
  waitForAppReady();
  waitForIngress();

  const externalIps = Object.values(networkInterfaces())
    .flat()
    .filter((iface) => iface && iface.family === 'IPv4' && !iface.internal)
    .map((iface) => iface!.address);

  console.log('\n=== Demo Environment Ready ===');
  console.log(`  Local:   ${PUBLIC_URL}`);
  for (const ip of externalIps) {
    console.log(`  Network: http://${ip}:${INGRESS_HOST_PORT}`);
  }
  console.log(`  KUBECONFIG: ${KUBECONFIG_PATH}`);
  console.log(`  DB (host): ${HOST_DB_URL.replace(/:[^:@]+@/, ':***@')}`);

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  process.on('exit', () => {
    try {
      rl.close();
    } catch {
      // ignore
    }
  });

  startWatcher(rl);
}

const meta = import.meta as unknown as { main?: boolean };
const isMainModule =
  typeof meta.main === 'boolean'
    ? meta.main
    : (process.argv[1]?.endsWith('local-demo.ts') ?? false);

if (isMainModule) {
  main().catch((err) => {
    console.error('\nDemo startup failed:');
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
