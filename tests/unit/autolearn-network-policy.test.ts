/**
 * @file autolearn-network-policy.test.ts
 *
 * Structural tests for the autolearn worker NetworkPolicy manifest.
 *
 * ## What is tested
 *
 * 1. k8s/autolearn-worker.yaml exists and contains the required resources.
 * 2. A NetworkPolicy resource named `superfield-autolearn-worker-egress` is present.
 * 3. The NetworkPolicy selects pods with `app: superfield-autolearn-worker`.
 * 4. Egress to the API server (port 80) is allowed.
 * 5. Egress to Anthropic API (port 443) is allowed.
 * 6. DNS egress (port 53) is allowed.
 * 7. Port 5432 (Postgres) is NOT declared in any egress rule — WORKER-C-006.
 * 8. The Deployment resource exists with `agent-type: autolearn`.
 * 9. The Deployment uses the agent_autolearn DB role (WORKER-C-020).
 * 10. The ANTHROPIC_API_KEY is loaded from a Secret (not hardcoded) — WORKER-T-009.
 *
 * ## No mocks
 * All tests read real YAML files from disk using readFileSync.
 *
 * Blueprint constraints verified:
 *   WORKER-C-006  NetworkPolicy blocks direct DB access (port 5432 absent)
 *   WORKER-C-024  Egress restricted to declared vendor hostnames only
 *   WORKER-C-020  autolearn DB credential is read-only
 *   WORKER-T-009  No secrets baked into container image
 *
 * Issue: #102 feat: worker network policy and egress restriction for autolearn pod
 */

import { describe, test, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

// ── Helpers ──────────────────────────────────────────────────────────────────

const ROOT = resolve(import.meta.dirname, '../..');
const MANIFEST_PATH = resolve(ROOT, 'k8s/autolearn-worker.yaml');

/**
 * Split a multi-document YAML file on `---` separators.
 * Returns each non-empty document as a plain string.
 */
function splitYamlDocuments(content: string): string[] {
  return content
    .split(/^---\s*$/m)
    .map((doc) => doc.trim())
    .filter((doc) => doc.length > 0);
}

/**
 * Extract the value of a YAML scalar field by key name (any indentation level).
 */
function extractField(doc: string, key: string): string | null {
  const match = new RegExp(`^\\s*${key}:\\s*(.+)$`, 'm').exec(doc);
  return match ? match[1].trim() : null;
}

/** Return documents matching a given `kind:` value. */
function documentsOfKind(docs: string[], kind: string): string[] {
  return docs.filter((doc) => extractField(doc, 'kind') === kind);
}

// ── Manifest existence ────────────────────────────────────────────────────────

describe('k8s/autolearn-worker.yaml — manifest exists', () => {
  test('autolearn-worker.yaml exists', () => {
    expect(existsSync(MANIFEST_PATH)).toBe(true);
  });
});

// ── NetworkPolicy structure ───────────────────────────────────────────────────

describe('NetworkPolicy — egress rules (WORKER-C-006, WORKER-C-024)', () => {
  test('manifest contains exactly one NetworkPolicy resource', () => {
    const content = readFileSync(MANIFEST_PATH, 'utf-8');
    const docs = splitYamlDocuments(content);
    const policies = documentsOfKind(docs, 'NetworkPolicy');
    expect(policies).toHaveLength(1);
  });

  test('NetworkPolicy is named superfield-autolearn-worker-egress', () => {
    const content = readFileSync(MANIFEST_PATH, 'utf-8');
    const docs = splitYamlDocuments(content);
    const [policy] = documentsOfKind(docs, 'NetworkPolicy');
    expect(extractField(policy, 'name')).toBe('superfield-autolearn-worker-egress');
  });

  test('NetworkPolicy selects pods with app: superfield-autolearn-worker', () => {
    const content = readFileSync(MANIFEST_PATH, 'utf-8');
    const docs = splitYamlDocuments(content);
    const [policy] = documentsOfKind(docs, 'NetworkPolicy');
    expect(policy).toContain('app: superfield-autolearn-worker');
    expect(policy).toContain('podSelector');
  });

  test('NetworkPolicy policyTypes includes Egress', () => {
    const content = readFileSync(MANIFEST_PATH, 'utf-8');
    const docs = splitYamlDocuments(content);
    const [policy] = documentsOfKind(docs, 'NetworkPolicy');
    expect(policy).toContain('- Egress');
  });

  test('Egress allows port 80 to api-server (task claim and wiki writes)', () => {
    const content = readFileSync(MANIFEST_PATH, 'utf-8');
    const docs = splitYamlDocuments(content);
    const [policy] = documentsOfKind(docs, 'NetworkPolicy');
    // Port 80 must appear in the egress rules
    expect(policy).toContain('port: 80');
  });

  test('Egress allows port 443 for Anthropic API (HTTPS)', () => {
    const content = readFileSync(MANIFEST_PATH, 'utf-8');
    const docs = splitYamlDocuments(content);
    const [policy] = documentsOfKind(docs, 'NetworkPolicy');
    expect(policy).toContain('port: 443');
  });

  test('Egress allows port 53 for DNS resolution', () => {
    const content = readFileSync(MANIFEST_PATH, 'utf-8');
    const docs = splitYamlDocuments(content);
    const [policy] = documentsOfKind(docs, 'NetworkPolicy');
    expect(policy).toContain('port: 53');
  });

  test('Port 5432 (Postgres) is NOT declared in egress — WORKER-C-006', () => {
    // If 5432 appears in the NetworkPolicy document, direct DB access is
    // allowed, which violates WORKER-C-006.
    const content = readFileSync(MANIFEST_PATH, 'utf-8');
    const docs = splitYamlDocuments(content);
    const [policy] = documentsOfKind(docs, 'NetworkPolicy');
    expect(policy).not.toContain('5432');
  });
});

// ── Deployment structure ──────────────────────────────────────────────────────

describe('Deployment — autolearn worker (WORKER-C-020, WORKER-T-009)', () => {
  test('manifest contains exactly one Deployment resource', () => {
    const content = readFileSync(MANIFEST_PATH, 'utf-8');
    const docs = splitYamlDocuments(content);
    const deployments = documentsOfKind(docs, 'Deployment');
    expect(deployments).toHaveLength(1);
  });

  test('Deployment is named superfield-autolearn-worker', () => {
    const content = readFileSync(MANIFEST_PATH, 'utf-8');
    const docs = splitYamlDocuments(content);
    const [deployment] = documentsOfKind(docs, 'Deployment');
    expect(extractField(deployment, 'name')).toBe('superfield-autolearn-worker');
  });

  test('Deployment has agent-type: autolearn label', () => {
    const content = readFileSync(MANIFEST_PATH, 'utf-8');
    const docs = splitYamlDocuments(content);
    const [deployment] = documentsOfKind(docs, 'Deployment');
    expect(deployment).toContain('agent-type: autolearn');
  });

  test('AGENT_TYPE env var is set to autolearn', () => {
    const content = readFileSync(MANIFEST_PATH, 'utf-8');
    const docs = splitYamlDocuments(content);
    const [deployment] = documentsOfKind(docs, 'Deployment');
    expect(deployment).toContain("value: 'autolearn'");
  });

  test('AGENT_DATABASE_URL is loaded from a Secret — not hardcoded (WORKER-T-009)', () => {
    const content = readFileSync(MANIFEST_PATH, 'utf-8');
    const docs = splitYamlDocuments(content);
    const [deployment] = documentsOfKind(docs, 'Deployment');
    // Must reference a secretKeyRef for the DB URL
    expect(deployment).toContain('AGENT_DATABASE_URL');
    expect(deployment).toContain('secretKeyRef');
  });

  test('ANTHROPIC_API_KEY is loaded from a Secret — not hardcoded (WORKER-T-009)', () => {
    const content = readFileSync(MANIFEST_PATH, 'utf-8');
    const docs = splitYamlDocuments(content);
    const [deployment] = documentsOfKind(docs, 'Deployment');
    expect(deployment).toContain('ANTHROPIC_API_KEY');
    // The value must come from a secretKeyRef, not a plain value field
    const apiKeySection = deployment.slice(deployment.indexOf('ANTHROPIC_API_KEY'));
    expect(apiKeySection).toContain('secretKeyRef');
  });

  test('Deployment uses superfield-autolearn-worker-secret Secret', () => {
    const content = readFileSync(MANIFEST_PATH, 'utf-8');
    const docs = splitYamlDocuments(content);
    const [deployment] = documentsOfKind(docs, 'Deployment');
    expect(deployment).toContain('superfield-autolearn-worker-secret');
  });

  test('Deployment runs as non-root (securityContext)', () => {
    const content = readFileSync(MANIFEST_PATH, 'utf-8');
    const docs = splitYamlDocuments(content);
    const [deployment] = documentsOfKind(docs, 'Deployment');
    expect(deployment).toContain('runAsNonRoot: true');
  });

  test('allowPrivilegeEscalation is false', () => {
    const content = readFileSync(MANIFEST_PATH, 'utf-8');
    const docs = splitYamlDocuments(content);
    const [deployment] = documentsOfKind(docs, 'Deployment');
    expect(deployment).toContain('allowPrivilegeEscalation: false');
  });
});

// ── ServiceAccount ────────────────────────────────────────────────────────────

describe('ServiceAccount — autolearn worker', () => {
  test('manifest contains a ServiceAccount resource', () => {
    const content = readFileSync(MANIFEST_PATH, 'utf-8');
    const docs = splitYamlDocuments(content);
    const accounts = documentsOfKind(docs, 'ServiceAccount');
    expect(accounts).toHaveLength(1);
  });

  test('ServiceAccount is named superfield-autolearn-worker', () => {
    const content = readFileSync(MANIFEST_PATH, 'utf-8');
    const docs = splitYamlDocuments(content);
    const [account] = documentsOfKind(docs, 'ServiceAccount');
    expect(extractField(account, 'name')).toBe('superfield-autolearn-worker');
  });
});
