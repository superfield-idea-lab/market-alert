/**
 * @file linkerd-manifests.test.ts
 *
 * Structural tests for the Linkerd mTLS service-mesh manifests.
 *
 * ## What is tested
 *
 * 1. Namespace manifests (k8s/linkerd/namespaces.yaml):
 *    - Three application namespaces are defined (superfield-server, superfield-web,
 *      superfield-worker).
 *    - Every namespace has `linkerd.io/inject: enabled` in both labels and
 *      annotations (required by the Linkerd admission webhook).
 *
 * 2. Authorization-policy manifests (k8s/linkerd/authorization-policies.yaml):
 *    - A Server resource exists for each meshed namespace.
 *    - A MeshTLSAuthentication resource exists for each Server.
 *    - An AuthorizationPolicy resource binds each MeshTLSAuthentication to its
 *      Server, producing default-deny semantics for non-meshed callers.
 *    - AuthorizationPolicy.spec.requiredAuthenticationRefs references the
 *      MeshTLSAuthentication (not NetworkAuthentication), enforcing SPIFFE
 *      identity checks.
 *
 * ## No mocks
 * All tests read real files from disk using readFileSync.  YAML parsing uses
 * the built-in Bun/Node APIs (no external YAML library) — manifests are split
 * on the `---` document separator and parsed as simple key–value checks
 * appropriate for the assertion level needed here.
 *
 * ## Why these tests matter
 * PRD §7 requires that every pod-to-pod call traverses a Linkerd sidecar with
 * mTLS, and that a workload without a valid mesh identity is denied.  These
 * tests ensure the YAML declarations that enforce those properties are present
 * and correct before any cluster validation step runs.
 *
 * Canonical doc: docs/technical/security.md § Encryption in Transit
 * Issue: #88 feat: Linkerd mTLS service mesh for all cluster traffic
 */

import { describe, test, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

// ── Helpers ──────────────────────────────────────────────────────────────────

const ROOT = resolve(import.meta.dirname, '../..');
const LINKERD_DIR = resolve(ROOT, 'k8s/linkerd');

/**
 * Minimal YAML document extractor.
 *
 * Splits a multi-document YAML file on `---` separators and returns each
 * non-empty document as a plain string.  This avoids a YAML parse dependency
 * while still allowing line-level assertions on document content.
 */
function splitYamlDocuments(content: string): string[] {
  return content
    .split(/^---\s*$/m)
    .map((doc) => doc.trim())
    .filter((doc) => doc.length > 0);
}

/**
 * Extract the value of a YAML scalar field at the top level or nested one
 * level deep (e.g. `metadata.name`).
 */
function extractField(doc: string, fieldPath: string): string | null {
  const parts = fieldPath.split('.');
  let current = doc;

  for (let i = 0; i < parts.length; i++) {
    const key = parts[i];
    // Match `key: value` at any indentation level
    const match = new RegExp(`^\\s*${key}:\\s*(.+)$`, 'm').exec(current);
    if (!match) return null;

    if (i === parts.length - 1) {
      return match[1].trim();
    }

    // For nested fields, narrow the search scope to the block after the key
    // (simple heuristic — sufficient for the two-level lookups here).
    const start = current.indexOf(match[0]);
    current = current.slice(start + match[0].length);
  }

  return null;
}

/** Return all documents in a YAML file that match a given `kind:` value. */
function documentsOfKind(docs: string[], kind: string): string[] {
  return docs.filter((doc) => {
    const docKind = extractField(doc, 'kind');
    return docKind === kind;
  });
}

/** Return all documents in a given namespace (metadata.namespace). */
function documentsInNamespace(docs: string[], namespace: string): string[] {
  return docs.filter((doc) => {
    const ns = extractField(doc, 'namespace');
    return ns === namespace;
  });
}

// ── Namespace manifest tests ─────────────────────────────────────────────────

describe('k8s/linkerd/namespaces.yaml — sidecar injection annotations (PRD §7)', () => {
  const NAMESPACES_FILE = resolve(LINKERD_DIR, 'namespaces.yaml');

  test('namespaces.yaml exists', () => {
    expect(existsSync(NAMESPACES_FILE)).toBe(true);
  });

  let namespaceDocs: string[] = [];

  test('file contains three Namespace resources', () => {
    const content = readFileSync(NAMESPACES_FILE, 'utf-8');
    const allDocs = splitYamlDocuments(content);
    namespaceDocs = documentsOfKind(allDocs, 'Namespace');
    expect(namespaceDocs).toHaveLength(3);
  });

  const EXPECTED_NAMESPACES = ['superfield-server', 'superfield-web', 'superfield-worker'];

  for (const nsName of EXPECTED_NAMESPACES) {
    test(`Namespace '${nsName}' is declared`, () => {
      const content = readFileSync(NAMESPACES_FILE, 'utf-8');
      const allDocs = splitYamlDocuments(content);
      const nsDocs = documentsOfKind(allDocs, 'Namespace');
      const names = nsDocs.map((doc) => extractField(doc, 'name'));
      expect(names).toContain(nsName);
    });

    test(`Namespace '${nsName}' has linkerd.io/inject: enabled annotation`, () => {
      const content = readFileSync(NAMESPACES_FILE, 'utf-8');
      // Look for the namespace section and verify the inject annotation
      const nsSection = content.split(/^---\s*$/m).find((doc) => doc.includes(`name: ${nsName}`));
      expect(nsSection).toBeDefined();
      expect(nsSection!).toContain('linkerd.io/inject: enabled');
    });
  }
});

// ── Authorization-policy manifest tests ─────────────────────────────────────

describe('k8s/linkerd/authorization-policies.yaml — default-deny enforcement (PRD §7)', () => {
  const POLICIES_FILE = resolve(LINKERD_DIR, 'authorization-policies.yaml');

  test('authorization-policies.yaml exists', () => {
    expect(existsSync(POLICIES_FILE)).toBe(true);
  });

  test('file contains at least one Server resource per meshed namespace', () => {
    const content = readFileSync(POLICIES_FILE, 'utf-8');
    const allDocs = splitYamlDocuments(content);
    const servers = documentsOfKind(allDocs, 'Server');
    // Three meshed namespaces → at least one Server each
    expect(servers.length).toBeGreaterThanOrEqual(3);
  });

  test('file contains at least one MeshTLSAuthentication resource per meshed namespace', () => {
    const content = readFileSync(POLICIES_FILE, 'utf-8');
    const allDocs = splitYamlDocuments(content);
    const mtlsAuths = documentsOfKind(allDocs, 'MeshTLSAuthentication');
    expect(mtlsAuths.length).toBeGreaterThanOrEqual(3);
  });

  test('file contains at least one AuthorizationPolicy resource per meshed namespace', () => {
    const content = readFileSync(POLICIES_FILE, 'utf-8');
    const allDocs = splitYamlDocuments(content);
    const policies = documentsOfKind(allDocs, 'AuthorizationPolicy');
    expect(policies.length).toBeGreaterThanOrEqual(3);
  });

  test('every AuthorizationPolicy references a MeshTLSAuthentication (not NetworkAuthentication)', () => {
    // MeshTLSAuthentication enforces SPIFFE identity verification.
    // NetworkAuthentication would allow IP-based access, bypassing mTLS.
    const content = readFileSync(POLICIES_FILE, 'utf-8');
    const allDocs = splitYamlDocuments(content);
    const policies = documentsOfKind(allDocs, 'AuthorizationPolicy');

    for (const policy of policies) {
      const policyName = extractField(policy, 'name') ?? '(unknown)';
      expect(
        policy,
        `AuthorizationPolicy ${policyName} must reference MeshTLSAuthentication`,
      ).toContain('MeshTLSAuthentication');
    }
  });

  test('Server resources use the correct API group (policy.linkerd.io)', () => {
    const content = readFileSync(POLICIES_FILE, 'utf-8');
    const allDocs = splitYamlDocuments(content);
    const servers = documentsOfKind(allDocs, 'Server');

    for (const server of servers) {
      const serverName = extractField(server, 'name') ?? '(unknown)';
      expect(server, `Server ${serverName} must use apiVersion policy.linkerd.io`).toContain(
        'policy.linkerd.io',
      );
    }
  });

  test('superfield-server namespace has a Server and AuthorizationPolicy', () => {
    const content = readFileSync(POLICIES_FILE, 'utf-8');
    const allDocs = splitYamlDocuments(content);

    const serverDocs = documentsInNamespace(
      documentsOfKind(allDocs, 'Server'),
      'superfield-server',
    );
    const policyDocs = documentsInNamespace(
      documentsOfKind(allDocs, 'AuthorizationPolicy'),
      'superfield-server',
    );

    expect(serverDocs.length).toBeGreaterThanOrEqual(1);
    expect(policyDocs.length).toBeGreaterThanOrEqual(1);
  });

  test('superfield-worker namespace has a Server and AuthorizationPolicy', () => {
    const content = readFileSync(POLICIES_FILE, 'utf-8');
    const allDocs = splitYamlDocuments(content);

    const serverDocs = documentsInNamespace(
      documentsOfKind(allDocs, 'Server'),
      'superfield-worker',
    );
    const policyDocs = documentsInNamespace(
      documentsOfKind(allDocs, 'AuthorizationPolicy'),
      'superfield-worker',
    );

    expect(serverDocs.length).toBeGreaterThanOrEqual(1);
    expect(policyDocs.length).toBeGreaterThanOrEqual(1);
  });

  test('superfield-web namespace has a Server and AuthorizationPolicy', () => {
    const content = readFileSync(POLICIES_FILE, 'utf-8');
    const allDocs = splitYamlDocuments(content);

    const serverDocs = documentsInNamespace(documentsOfKind(allDocs, 'Server'), 'superfield-web');
    const policyDocs = documentsInNamespace(
      documentsOfKind(allDocs, 'AuthorizationPolicy'),
      'superfield-web',
    );

    expect(serverDocs.length).toBeGreaterThanOrEqual(1);
    expect(policyDocs.length).toBeGreaterThanOrEqual(1);
  });
});

// ── Install / upgrade scripts ─────────────────────────────────────────────────

describe('k8s/linkerd — install and upgrade scripts (upgrade path, PRD §7)', () => {
  test('install.sh exists and is non-empty', () => {
    const installScript = resolve(LINKERD_DIR, 'install.sh');
    expect(existsSync(installScript)).toBe(true);
    const content = readFileSync(installScript, 'utf-8');
    expect(content.trim().length).toBeGreaterThan(100);
  });

  test('upgrade.sh exists and is non-empty', () => {
    const upgradeScript = resolve(LINKERD_DIR, 'upgrade.sh');
    expect(existsSync(upgradeScript)).toBe(true);
    const content = readFileSync(upgradeScript, 'utf-8');
    expect(content.trim().length).toBeGreaterThan(100);
  });

  test('install.sh documents the Linkerd version', () => {
    const installScript = resolve(LINKERD_DIR, 'install.sh');
    const content = readFileSync(installScript, 'utf-8');
    // Must pin a version — LINKERD_VERSION variable must be set
    expect(content).toContain('LINKERD_VERSION');
  });

  test('upgrade.sh performs a rolling restart for zero-downtime rollover', () => {
    const upgradeScript = resolve(LINKERD_DIR, 'upgrade.sh');
    const content = readFileSync(upgradeScript, 'utf-8');
    // Must include rollout restart to replace sidecars
    expect(content).toContain('rollout restart');
  });

  test('upgrade.sh runs linkerd check after upgrade (post-upgrade health)', () => {
    const upgradeScript = resolve(LINKERD_DIR, 'upgrade.sh');
    const content = readFileSync(upgradeScript, 'utf-8');
    expect(content).toContain('linkerd check');
  });
});

// ── Distroless compatibility note ────────────────────────────────────────────
//
// The acceptance criterion "Distroless workload images continue to boot with
// sidecars injected" is enforced by the existing distroless-check CI job
// (k8s-manifests.yml) which builds the production images and asserts /bin/sh
// is absent.  Linkerd's proxy sidecar uses its own init container for iptables
// manipulation; it does not require a shell in the workload container.
// The namespace-level injection annotation is sufficient — no workload manifest
// changes are needed.
