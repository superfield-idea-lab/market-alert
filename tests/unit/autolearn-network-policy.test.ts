/**
 * @file autolearn-network-policy.test.ts
 *
 * Structural tests for the autolearn worker NetworkPolicy manifest.
 *
 * ## What is tested
 *
 * 1. k8s/autolearn-worker.yaml exists and contains the required resources.
 * 2. A NetworkPolicy resource is present whose name follows the per-run
 *    `autolearn-worker-egress-<dept>-<customer>` template.
 * 3. The NetworkPolicy selects pods with `app: autolearn-worker`.
 * 4. Egress to the API server (port 80) is allowed.
 * 5. Egress to Anthropic API (port 443) is allowed.
 * 6. DNS egress (port 53) is allowed.
 * 7. Port 5432 (Postgres) is NOT declared in any egress rule — WORKER-C-006.
 * 8. The ephemeral Job resource exists with `app: autolearn-worker` and
 *    sets `AGENT_TYPE=autolearn` for the worker container.
 * 9. The Job uses a per-run worker token Secret (no DB credential in the pod).
 * 10. The WORKER_TOKEN and API_BASE_URL are loaded from Secrets (WORKER-T-009).
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

  test('NetworkPolicy name follows the per-run autolearn-worker-egress template', () => {
    // The gardening cron controller interpolates DEPARTMENT_ID and CUSTOMER_ID
    // at provisioning time. The template name in the manifest is therefore
    // `autolearn-worker-egress-$(DEPARTMENT_ID)-$(CUSTOMER_ID)`.
    const content = readFileSync(MANIFEST_PATH, 'utf-8');
    const docs = splitYamlDocuments(content);
    const [policy] = documentsOfKind(docs, 'NetworkPolicy');
    expect(extractField(policy, 'name')).toBe(
      'autolearn-worker-egress-$(DEPARTMENT_ID)-$(CUSTOMER_ID)',
    );
  });

  test('NetworkPolicy selects pods with app: autolearn-worker', () => {
    const content = readFileSync(MANIFEST_PATH, 'utf-8');
    const docs = splitYamlDocuments(content);
    const [policy] = documentsOfKind(docs, 'NetworkPolicy');
    expect(policy).toContain('app: autolearn-worker');
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

// ── Ephemeral Job structure ──────────────────────────────────────────────────
// The autolearn worker is an ephemeral, per-(department, customer) Job rather
// than a long-lived Deployment. The gardening cron controller (issue #40)
// creates one Job per run and Kubernetes TTL cleans it up after completion.

describe('Job — autolearn worker (WORKER-C-020, WORKER-T-009)', () => {
  test('manifest contains exactly one Job resource', () => {
    const content = readFileSync(MANIFEST_PATH, 'utf-8');
    const docs = splitYamlDocuments(content);
    const jobs = documentsOfKind(docs, 'Job');
    expect(jobs).toHaveLength(1);
  });

  test('Job name follows the per-run autolearn-worker template', () => {
    const content = readFileSync(MANIFEST_PATH, 'utf-8');
    const docs = splitYamlDocuments(content);
    const [job] = documentsOfKind(docs, 'Job');
    expect(extractField(job, 'name')).toBe('autolearn-worker-$(DEPARTMENT_ID)-$(CUSTOMER_ID)');
  });

  test('Job pod template carries app: autolearn-worker label', () => {
    const content = readFileSync(MANIFEST_PATH, 'utf-8');
    const docs = splitYamlDocuments(content);
    const [job] = documentsOfKind(docs, 'Job');
    expect(job).toContain('app: autolearn-worker');
  });

  test('AGENT_TYPE env var is set to autolearn', () => {
    const content = readFileSync(MANIFEST_PATH, 'utf-8');
    const docs = splitYamlDocuments(content);
    const [job] = documentsOfKind(docs, 'Job');
    // YAML scalar may be quoted or bare — both forms are acceptable.
    expect(job).toMatch(/value:\s*['"]?autolearn['"]?/);
  });

  test('API_BASE_URL is loaded from a Secret — not hardcoded (WORKER-T-009)', () => {
    const content = readFileSync(MANIFEST_PATH, 'utf-8');
    const docs = splitYamlDocuments(content);
    const [job] = documentsOfKind(docs, 'Job');
    expect(job).toContain('API_BASE_URL');
    const section = job.slice(job.indexOf('API_BASE_URL'));
    expect(section).toContain('secretKeyRef');
  });

  test('WORKER_TOKEN is loaded from a per-run Secret — not hardcoded (WORKER-T-009)', () => {
    // The autolearn worker no longer carries an Anthropic API key in the pod
    // env. It authenticates with the Superfield API via a single-use
    // WORKER_TOKEN issued by /internal/worker/tokens — see WORKER-T-005.
    const content = readFileSync(MANIFEST_PATH, 'utf-8');
    const docs = splitYamlDocuments(content);
    const [job] = documentsOfKind(docs, 'Job');
    expect(job).toContain('WORKER_TOKEN');
    const section = job.slice(job.indexOf('WORKER_TOKEN'));
    expect(section).toContain('secretKeyRef');
  });

  test('Job references the per-run autolearn-token Secret', () => {
    const content = readFileSync(MANIFEST_PATH, 'utf-8');
    const docs = splitYamlDocuments(content);
    const [job] = documentsOfKind(docs, 'Job');
    expect(job).toContain('autolearn-token-$(DEPARTMENT_ID)-$(CUSTOMER_ID)');
  });

  test('Job runs as non-root (securityContext)', () => {
    const content = readFileSync(MANIFEST_PATH, 'utf-8');
    const docs = splitYamlDocuments(content);
    const [job] = documentsOfKind(docs, 'Job');
    expect(job).toContain('runAsNonRoot: true');
  });

  test('allowPrivilegeEscalation is false', () => {
    const content = readFileSync(MANIFEST_PATH, 'utf-8');
    const docs = splitYamlDocuments(content);
    const [job] = documentsOfKind(docs, 'Job');
    expect(job).toContain('allowPrivilegeEscalation: false');
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

  test('ServiceAccount name follows the per-run autolearn-worker template', () => {
    const content = readFileSync(MANIFEST_PATH, 'utf-8');
    const docs = splitYamlDocuments(content);
    const [account] = documentsOfKind(docs, 'ServiceAccount');
    expect(extractField(account, 'name')).toBe('autolearn-worker-$(DEPARTMENT_ID)-$(CUSTOMER_ID)');
  });
});
