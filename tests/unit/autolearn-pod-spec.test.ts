/**
 * @file autolearn-pod-spec.test.ts
 *
 * Structural assertions for the distroless ephemeral autolearn worker manifests.
 *
 * ## What is tested
 *
 * ### k8s/autolearn-worker.yaml
 * - Job pod has readOnlyRootFilesystem: true (acceptance criterion 2)
 * - Job pod drops ALL capabilities (acceptance criterion 2)
 * - Job pod has allowPrivilegeEscalation: false
 * - Job pod has runAsNonRoot: true
 * - Job pod has automountServiceAccountToken: false
 * - Service account is present and scoped per (department, customer) template
 * - RBAC Role restricts resourceNames to per-run input ConfigMap only
 * - NetworkPolicy blocks direct DB access (no DB port allowed)
 * - restartPolicy is Never (ephemeral Job semantics)
 * - ttlSecondsAfterFinished is set (pod cleanup after completion)
 * - Image uses non-latest tag placeholder ($(IMAGE_TAG))
 *
 * ### k8s/autolearn-admission-policy.yaml
 * - Kyverno ClusterPolicy is present
 * - validationFailureAction is Enforce
 * - require-read-only-root-fs rule is present
 * - require-drop-all-capabilities rule is present
 * - require-no-privilege-escalation rule is present
 * - require-non-root-user rule is present
 * - require-no-automount-sa-token rule is present
 * - require-image-tag-not-latest rule is present
 *
 * ### Dockerfile — `autolearn-worker` target (unified multi-stage Dockerfile)
 * - Shared install/builder stages use pinned bun image digest (WORKER-C-023)
 * - autolearn-worker stage uses distroless bun image digest (WORKER-C-001)
 * - USER directive sets non-root UID (WORKER-T-007)
 * - ENTRYPOINT does not invoke sh or bash (WORKER-C-001)
 *
 * ## No mocks
 * All assertions use real filesystem reads — no vi.fn, vi.mock, or stubs.
 *
 * Canonical docs:
 *   docs/implementation-plan-v1.md — Phase 3, "Kubernetes ephemeral pod spec"
 *   calypso-blueprint/rules/blueprints/worker.yaml — WORKER-C-001, WORKER-T-007
 *
 * Issue: #35 — feat: distroless ephemeral pod spec for autolearn worker
 */

import { describe, test, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '../..');

const workerManifest = readFileSync(resolve(ROOT, 'k8s/autolearn-worker.yaml'), 'utf-8');
const admissionPolicy = readFileSync(resolve(ROOT, 'k8s/autolearn-admission-policy.yaml'), 'utf-8');
// The legacy Dockerfile.autolearn-worker was consolidated into the unified
// multi-stage Dockerfile with an `autolearn-worker` target. We read the
// unified Dockerfile and isolate the autolearn-worker stage so assertions
// stay scoped to the relevant section.
const dockerfile = readFileSync(resolve(ROOT, 'Dockerfile'), 'utf-8');

const autolearnStageStart = dockerfile.indexOf('AS autolearn-worker');
const autolearnStage = (() => {
  if (autolearnStageStart < 0) return '';
  const after = dockerfile.slice(autolearnStageStart);
  const nextStage = after.indexOf('\nFROM ', 1);
  return nextStage < 0 ? after : after.slice(0, nextStage);
})();

// ── File existence ────────────────────────────────────────────────────────────

describe('autolearn worker files exist', () => {
  test('k8s/autolearn-worker.yaml exists', () => {
    expect(existsSync(resolve(ROOT, 'k8s/autolearn-worker.yaml'))).toBe(true);
  });

  test('k8s/autolearn-admission-policy.yaml exists', () => {
    expect(existsSync(resolve(ROOT, 'k8s/autolearn-admission-policy.yaml'))).toBe(true);
  });

  test('Dockerfile (unified) exists and defines an autolearn-worker stage', () => {
    expect(existsSync(resolve(ROOT, 'Dockerfile'))).toBe(true);
    expect(autolearnStageStart).toBeGreaterThanOrEqual(0);
  });
});

// ── k8s/autolearn-worker.yaml ─────────────────────────────────────────────────

describe('autolearn-worker.yaml — pod security posture (acceptance criterion 2)', () => {
  test('readOnlyRootFilesystem: true is present', () => {
    // Acceptance criterion: root filesystem is mounted read-only.
    expect(workerManifest).toContain('readOnlyRootFilesystem: true');
  });

  test('capabilities drop: ALL is present', () => {
    // WORKER-T-007: drop ALL Linux capabilities.
    expect(workerManifest).toContain('- ALL');
    expect(workerManifest).toContain('drop:');
  });

  test('allowPrivilegeEscalation: false is present', () => {
    expect(workerManifest).toContain('allowPrivilegeEscalation: false');
  });

  test('runAsNonRoot: true is present', () => {
    // WORKER-T-007: container must not run as root.
    expect(workerManifest).toContain('runAsNonRoot: true');
  });

  test('automountServiceAccountToken: false is present', () => {
    // Worker authenticates via WORKER_TOKEN env var; SA token must not be mounted.
    expect(workerManifest).toContain('automountServiceAccountToken: false');
  });
});

describe('autolearn-worker.yaml — ephemeral Job semantics', () => {
  test('kind is Job', () => {
    expect(workerManifest).toContain('kind: Job');
  });

  test('restartPolicy is Never', () => {
    // Ephemeral jobs must not restart on their own; Job retry policy governs re-runs.
    expect(workerManifest).toContain('restartPolicy: Never');
  });

  test('ttlSecondsAfterFinished is set', () => {
    // Pods and Jobs must be cleaned up after completion.
    expect(workerManifest).toContain('ttlSecondsAfterFinished:');
  });

  test('image tag uses $(IMAGE_TAG) placeholder, not literal "latest"', () => {
    // Manifests are templates; CI substitutes $(IMAGE_TAG).
    // WORKER-C-023: vendor CLI version is pinned; the image tag is also pinned per run.
    expect(workerManifest).toContain('$(IMAGE_TAG)');
    // The image line must not end with :latest
    const imageLines = workerManifest
      .split('\n')
      .filter((line) => line.includes('image:') && line.includes('autolearn-worker'));
    expect(imageLines.length).toBeGreaterThan(0);
    for (const line of imageLines) {
      expect(line).not.toMatch(/:latest\s*$/);
    }
  });
});

describe('autolearn-worker.yaml — RBAC is scoped to (dept, customer) (acceptance criterion 3)', () => {
  test('ServiceAccount resource is defined', () => {
    expect(workerManifest).toContain('kind: ServiceAccount');
  });

  test('Role resource is defined', () => {
    expect(workerManifest).toContain('kind: Role');
  });

  test('RoleBinding resource is defined', () => {
    expect(workerManifest).toContain('kind: RoleBinding');
  });

  test('Role uses resourceNames to restrict access to per-run ConfigMap', () => {
    // WORKER-P-001: agent reads only its own scoped data.
    // The resourceNames field pins the Role to the per-run input ConfigMap.
    expect(workerManifest).toContain('resourceNames:');
    expect(workerManifest).toContain('autolearn-input-');
  });

  test('labels encode department and customer', () => {
    // Each K8s resource is labelled with (department, customer) for isolation.
    expect(workerManifest).toContain('superfield.io/department:');
    expect(workerManifest).toContain('superfield.io/customer:');
  });
});

describe('autolearn-worker.yaml — network policy (WORKER-C-006, WORKER-C-024)', () => {
  test('NetworkPolicy is defined', () => {
    expect(workerManifest).toContain('kind: NetworkPolicy');
  });

  test('NetworkPolicy restricts to Egress only', () => {
    // No Ingress policy: autolearn workers accept no inbound connections.
    expect(workerManifest).toContain('- Egress');
    expect(workerManifest).not.toContain('- Ingress');
  });

  test('HTTPS port 443 is allowed for Claude CLI', () => {
    // WORKER-C-024: egress restricted to declared vendor hosts (Anthropic API).
    expect(workerManifest).toContain('port: 443');
  });

  test('DNS port 53 is allowed', () => {
    expect(workerManifest).toContain('port: 53');
  });

  test('Database port 5432 is NOT allowed', () => {
    // WORKER-C-006: direct DB access is structurally blocked at the network layer.
    expect(workerManifest).not.toContain('port: 5432');
  });
});

describe('autolearn-worker.yaml — writable volumes use explicit mounts', () => {
  test('emptyDir volumes are defined for writable paths', () => {
    // Root FS is read-only; /tmp and /input must use explicit volumes.
    expect(workerManifest).toContain('emptyDir:');
  });

  test('tmpfs volume (medium: Memory) is used for /tmp', () => {
    // Blueprint: WORKER-T-009 — no secrets on disk; tmpfs is cleared on pod death.
    expect(workerManifest).toContain('medium: Memory');
  });

  test('input volume is mounted readOnly', () => {
    // The worker must not modify its input data.
    expect(workerManifest).toContain('readOnly: true');
  });
});

// ── k8s/autolearn-admission-policy.yaml ──────────────────────────────────────

describe('autolearn-admission-policy.yaml — Kyverno ClusterPolicy (acceptance criterion 4)', () => {
  test('kind is ClusterPolicy', () => {
    expect(admissionPolicy).toContain('kind: ClusterPolicy');
  });

  test('validationFailureAction is Enforce', () => {
    // Admission must reject deviations, not just audit them.
    expect(admissionPolicy).toContain('validationFailureAction: Enforce');
  });

  test('require-read-only-root-fs rule is present', () => {
    expect(admissionPolicy).toContain('require-read-only-root-fs');
  });

  test('require-drop-all-capabilities rule is present', () => {
    expect(admissionPolicy).toContain('require-drop-all-capabilities');
  });

  test('require-no-privilege-escalation rule is present', () => {
    expect(admissionPolicy).toContain('require-no-privilege-escalation');
  });

  test('require-non-root-user rule is present', () => {
    expect(admissionPolicy).toContain('require-non-root-user');
  });

  test('require-no-automount-sa-token rule is present', () => {
    expect(admissionPolicy).toContain('require-no-automount-sa-token');
  });

  test('require-image-tag-not-latest rule is present', () => {
    expect(admissionPolicy).toContain('require-image-tag-not-latest');
  });

  test('policy matches pods labelled app=autolearn-worker', () => {
    expect(admissionPolicy).toContain('app: autolearn-worker');
  });
});

// ── Dockerfile — `autolearn-worker` target ───────────────────────────────────

describe('Dockerfile autolearn-worker stage — distroless image (WORKER-C-001)', () => {
  test('shared builder uses pinned bun image with SHA digest', () => {
    // WORKER-C-023: base image is pinned to a digest, not a floating tag.
    // The unified Dockerfile centralizes the builder under the shared `install`
    // stage which all worker targets build from.
    expect(dockerfile).toMatch(/FROM oven\/bun:\S+@\$\{BUN_BUILDER_DIGEST\} AS install/);
  });

  test('autolearn-worker stage uses distroless bun image with pinned digest', () => {
    // WORKER-C-001: no shell in production container.
    expect(dockerfile).toMatch(
      /FROM oven\/bun:\S+-distroless@\$\{BUN_DISTROLESS_DIGEST\} AS autolearn-worker/,
    );
  });

  test('autolearn-worker stage sets non-root UID via USER directive', () => {
    // WORKER-T-007: worker must not run as root.
    expect(autolearnStage).toMatch(/^USER 1000:1000/m);
  });

  test('autolearn-worker ENTRYPOINT uses array form (no shell invocation)', () => {
    // WORKER-C-007: vendor CLI invoked without shell; entrypoint must be array form.
    expect(autolearnStage).toMatch(/^ENTRYPOINT \["/m);
    expect(autolearnStage).not.toMatch(/ENTRYPOINT.*sh -c/);
    expect(autolearnStage).not.toMatch(/ENTRYPOINT.*\/bin\/sh/);
  });

  test('Claude CLI binary is COPY-ed from build context, not downloaded at runtime', () => {
    // WORKER-C-023: binary copied at build time; no wget/curl at runtime.
    expect(autolearnStage).toContain('COPY');
    expect(autolearnStage).toContain('/usr/local/bin/claude');
    expect(autolearnStage).not.toMatch(/RUN.*wget.*claude/);
    expect(autolearnStage).not.toMatch(/RUN.*curl.*claude/);
  });
});
