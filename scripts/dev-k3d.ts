#!/usr/bin/env bun
/**
 * dev-k3d — Creates (or reuses) a local k3d cluster, applies the k8s/dev
 * manifests, and waits for Postgres to be healthy.
 *
 * ENV-D-002: dev/CI/prod use the same container topology (k3d, not Docker Compose).
 * ENV-C-016: pnpm db:migrate is run as a separate step after the cluster is up,
 *            identically in dev and CI.
 *
 * Based on superfield-distribution/scripts/local-demo.ts topology.
 *
 * Usage:
 *   bun run scripts/dev-k3d.ts            # start or reuse cluster
 *   bun run scripts/dev-k3d.ts --delete   # tear down the cluster
 *   bun run scripts/dev-k3d.ts --status   # print cluster state and exit
 */

import { join } from 'path';

const CLUSTER_NAME = 'superfield-dev';
const NAMESPACE = 'default';
const KUBECONFIG_PATH = join(import.meta.dir, '..', '.k3d-kubeconfig');
const REPO_ROOT = join(import.meta.dir, '..');
const K8S_DEV_DIR = join(REPO_ROOT, 'k8s', 'dev');

// ─── CLI flags ────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const shouldDelete = args.includes('--delete');
const statusOnly = args.includes('--status');

// ─── helpers ─────────────────────────────────────────────────────────────────

function run(cmd: string[], opts: { cwd?: string; env?: Record<string, string> } = {}): boolean {
  const env = opts.env
    ? { ...process.env, ...opts.env, KUBECONFIG: KUBECONFIG_PATH }
    : { ...process.env, KUBECONFIG: KUBECONFIG_PATH };

  const result = Bun.spawnSync(cmd, {
    cwd: opts.cwd ?? REPO_ROOT,
    env,
    stdout: 'inherit',
    stderr: 'inherit',
  });
  return result.exitCode === 0;
}

function capture(cmd: string[], env?: Record<string, string>): string {
  const mergedEnv = env
    ? { ...process.env, ...env, KUBECONFIG: KUBECONFIG_PATH }
    : { ...process.env, KUBECONFIG: KUBECONFIG_PATH };

  const result = Bun.spawnSync(cmd, {
    cwd: REPO_ROOT,
    env: mergedEnv,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return new TextDecoder().decode(result.stdout).trim();
}

function clusterExists(): boolean {
  const clusters = capture(['k3d', 'cluster', 'list', '-o', 'json']);
  try {
    const list = JSON.parse(clusters) as Array<{ name: string }>;
    return list.some((c) => c.name === CLUSTER_NAME);
  } catch {
    return false;
  }
}

function postgresReady(): boolean {
  const result = Bun.spawnSync(
    [
      'kubectl',
      'rollout',
      'status',
      'statefulset/superfield-dev-postgres',
      '-n',
      NAMESPACE,
      '--timeout=120s',
    ],
    {
      cwd: REPO_ROOT,
      env: { ...process.env, KUBECONFIG: KUBECONFIG_PATH },
      stdout: 'inherit',
      stderr: 'inherit',
    },
  );
  return result.exitCode === 0;
}

// ─── main ────────────────────────────────────────────────────────────────────

async function main() {
  // ── status ──
  if (statusOnly) {
    const exists = clusterExists();
    console.log(`k3d cluster '${CLUSTER_NAME}': ${exists ? 'running' : 'not found'}`);
    process.exit(0);
  }

  // ── delete ──
  if (shouldDelete) {
    if (!clusterExists()) {
      console.log(`k3d cluster '${CLUSTER_NAME}' does not exist — nothing to delete.`);
      process.exit(0);
    }
    console.log(`\nDeleting k3d cluster '${CLUSTER_NAME}'...`);
    const ok = run(['k3d', 'cluster', 'delete', CLUSTER_NAME]);
    process.exit(ok ? 0 : 1);
  }

  // ── create or reuse ──
  if (clusterExists()) {
    console.log(`\nk3d cluster '${CLUSTER_NAME}' already exists — reusing (idempotent).`);
  } else {
    console.log(`\nCreating k3d cluster '${CLUSTER_NAME}'...`);
    const ok = run([
      'k3d',
      'cluster',
      'create',
      CLUSTER_NAME,
      '--port',
      '8080:80@loadbalancer',
      '--port',
      '5432:5432@loadbalancer',
      '--wait',
    ]);
    if (!ok) {
      console.error('Failed to create k3d cluster.');
      process.exit(1);
    }
  }

  // Write kubeconfig so kubectl commands below use the correct cluster.
  console.log('  Writing kubeconfig...');
  run(['k3d', 'kubeconfig', 'write', CLUSTER_NAME, '--output', KUBECONFIG_PATH]);

  // ── apply dev manifests ──
  console.log('  Applying k8s/dev manifests...');
  const manifests = [join(K8S_DEV_DIR, 'dev-secrets.yaml'), join(K8S_DEV_DIR, 'postgres.yaml')];

  for (const manifest of manifests) {
    if (!run(['kubectl', 'apply', '-f', manifest])) {
      console.error(`Failed to apply manifest: ${manifest}`);
      process.exit(1);
    }
  }

  // ── wait for Postgres ──
  console.log('  Waiting for Postgres to be ready...');
  if (!postgresReady()) {
    console.error('Postgres did not become ready in time.');
    process.exit(1);
  }

  console.log(`\nk3d cluster '${CLUSTER_NAME}' is ready.`);
  console.log(`  KUBECONFIG: ${KUBECONFIG_PATH}`);
  console.log(
    '  Postgres Service: superfield-dev-postgres:5432 (accessible via localhost:5432 through loadbalancer)',
  );
  console.log('\n  Run pnpm db:migrate to apply the baseline migration.');
}

main().catch((err) => {
  console.error('\ndev-k3d failed:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
