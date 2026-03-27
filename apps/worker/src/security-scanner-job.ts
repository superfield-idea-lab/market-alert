/**
 * @file security-scanner-job.ts
 *
 * Security vulnerability scanner agent job type — "security_scan".
 *
 * ## Job type: security_scan
 *
 * A cron-scheduled agent that reviews the codebase for security vulnerabilities
 * using Claude CLI. Reviews for OWASP top 10, injection, XSS, CSRF gaps, auth
 * bypasses, and insecure defaults. Findings are stored as structured JSON with
 * severity levels, file paths, line ranges, descriptions, and remediation steps.
 *
 * ### Payload shape
 *
 * ```json
 * {
 *   "scan_ref":      "<opaque reference to the scan request>",
 *   "repo_ref":      "<opaque reference to the repository or commit>",
 *   "scope_ref":     "<optional opaque reference to scan scope config>"
 * }
 * ```
 *
 * Payloads must contain only opaque identifiers (TQ-P-002). No raw paths,
 * filenames, or code content may appear in the queue row.
 *
 * ### Result shape
 *
 * ```json
 * {
 *   "findings": [
 *     {
 *       "severity":    "critical" | "high" | "medium" | "low" | "info",
 *       "path":        "apps/server/src/auth/jwt.ts",
 *       "lines":       { "start": 42, "end": 55 },
 *       "category":    "injection",
 *       "description": "SQL injection via unsanitised parameter.",
 *       "remediation": "Use parameterised queries or an ORM."
 *     }
 *   ],
 *   "summary":  "Found 3 critical, 2 high, 1 medium issue(s).",
 *   "status":   "completed",
 *   "scan_ref": "<echoed from payload>"
 * }
 * ```
 *
 * ### Cron trigger
 *
 * The job is enqueued by `apps/server/src/cron/jobs/security-scanner.ts` on a
 * configurable schedule (default: daily at 03:00 UTC).
 *
 * Blueprint reference: WORKER domain — security scanner agent
 */

/** The job_type string identifying a security vulnerability scan task. */
export const SECURITY_SCAN_JOB_TYPE = 'security_scan' as const;

/**
 * Severity levels for a security finding.
 * Ordered from most to least severe.
 */
export type FindingSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';

/**
 * Line range within a source file.
 */
export interface FindingLines {
  /** First line of the vulnerable region (1-indexed). */
  start: number;
  /** Last line of the vulnerable region (1-indexed, inclusive). */
  end: number;
}

/**
 * A single security vulnerability finding.
 */
export interface SecurityFinding {
  /** Severity classification. */
  severity: FindingSeverity;
  /** Relative path to the affected file within the repository. */
  path: string;
  /** Line range of the vulnerable code. */
  lines: FindingLines;
  /** Vulnerability category (e.g., "injection", "xss", "auth"). */
  category: string;
  /** Human-readable description of the vulnerability. */
  description: string;
  /** Concrete remediation advice. */
  remediation: string;
}

/**
 * Payload shape for the `security_scan` job type.
 *
 * Only opaque identifiers are permitted (TQ-P-002). Workers fetch context
 * through the API at execution time; the queue row must never carry raw content.
 */
export interface SecurityScanPayload {
  /** Opaque reference to the scan request. Required. */
  scan_ref: string;
  /** Opaque reference to the repository or commit to scan. Optional. */
  repo_ref?: string;
  /** Opaque reference to an optional scope configuration. */
  scope_ref?: string;
}

/**
 * Expected result shape returned by the Claude CLI for `security_scan` tasks.
 */
export interface SecurityScanResult {
  /** Structured list of vulnerability findings. */
  findings: SecurityFinding[];
  /** Human-readable summary of the scan outcome. */
  summary: string;
  /** Execution status. */
  status: 'completed' | 'failed';
  /** Echoed scan_ref from the payload for correlation. */
  scan_ref: string;
  /** Whether the result was produced by the dev stub (local dev only). */
  stub?: boolean;
  /** Additional vendor-specific fields forwarded as-is. */
  [key: string]: unknown;
}

/**
 * The Claude CLI prompt used for security vulnerability scanning.
 *
 * Instructs Claude to review the codebase for OWASP top 10 and related
 * security concerns, returning structured JSON output.
 */
export const SECURITY_SCAN_PROMPT = `You are a security code reviewer. Analyse the repository for security vulnerabilities.

Focus on:
- OWASP Top 10 (injection, broken auth, XSS, IDOR, security misconfiguration, etc.)
- SQL/NoSQL/command injection
- Cross-site scripting (XSS) and cross-site request forgery (CSRF) gaps
- Authentication and authorisation bypasses
- Insecure defaults and hardcoded secrets
- Unsafe deserialization and prototype pollution
- Missing input validation and output encoding
- Dependency vulnerabilities
- Exposed sensitive data in logs or responses

For each finding output a JSON object with:
  - severity: "critical" | "high" | "medium" | "low" | "info"
  - path: relative file path
  - lines: { start: number, end: number }
  - category: short category label (e.g. "injection", "xss", "auth")
  - description: what the vulnerability is
  - remediation: how to fix it

Return a JSON object with:
  {
    "findings": [...],
    "summary": "Found N critical, N high, ... issue(s).",
    "status": "completed",
    "scan_ref": "<echoed from input>"
  }

Perform read-only analysis only. Do not modify any files.`;

/**
 * Build the stdin payload sent to the Claude CLI for a `security_scan` task.
 *
 * Merges task metadata with the job payload and embeds the security scan
 * prompt so the CLI has all context it needs.
 */
export function buildSecurityScanCliPayload(
  taskId: string,
  agentType: string,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  return {
    id: taskId,
    job_type: SECURITY_SCAN_JOB_TYPE,
    agent_type: agentType,
    prompt: SECURITY_SCAN_PROMPT,
    ...payload,
  };
}

/**
 * Validate that a raw CLI result object conforms to the SecurityScanResult shape.
 *
 * Throws if the result is missing required fields or if findings are malformed.
 */
export function validateSecurityScanResult(raw: Record<string, unknown>): SecurityScanResult {
  if (!Array.isArray(raw['findings'])) {
    throw new Error(
      `Security scan result is missing required "findings" array. Got: ${JSON.stringify(raw).slice(0, 200)}`,
    );
  }

  if (typeof raw['summary'] !== 'string') {
    throw new Error(
      `Security scan result is missing required "summary" string. Got: ${JSON.stringify(raw).slice(0, 200)}`,
    );
  }

  if (typeof raw['scan_ref'] !== 'string') {
    throw new Error(
      `Security scan result is missing required "scan_ref" string. Got: ${JSON.stringify(raw).slice(0, 200)}`,
    );
  }

  // Validate individual findings have required fields.
  const findings = raw['findings'] as unknown[];
  for (let i = 0; i < findings.length; i++) {
    const f = findings[i] as Record<string, unknown>;
    const missing: string[] = [];

    if (typeof f['severity'] !== 'string') missing.push('severity');
    if (typeof f['path'] !== 'string') missing.push('path');
    if (typeof f['lines'] !== 'object' || f['lines'] === null) missing.push('lines');
    if (typeof f['description'] !== 'string') missing.push('description');
    if (typeof f['remediation'] !== 'string') missing.push('remediation');

    if (missing.length > 0) {
      throw new Error(
        `Security scan finding[${i}] is missing required fields: ${missing.join(', ')}`,
      );
    }
  }

  return raw as SecurityScanResult;
}

/**
 * The default timeout for a security scan in milliseconds (10 minutes).
 *
 * Security scans may need to review a large codebase; the hard timeout
 * ensures the worker cannot be held indefinitely.
 */
export const SECURITY_SCAN_TIMEOUT_MS = 10 * 60 * 1_000;
