/**
 * @file soc-compliance-agent-job.ts
 *
 * SOC compliance review agent job type — "soc_compliance_review" — performing
 * periodic SOC 2 Trust Service Criteria codebase analysis via the Claude CLI.
 *
 * ## Job type: soc_compliance_review
 *
 * A cron-scheduled agent reviews the codebase for SOC 2 Trust Service Criteria
 * violations (security, availability, processing integrity, confidentiality,
 * privacy). Findings are stored as structured JSON with compliance category,
 * severity, file path, description, and remediation guidance.
 *
 * ### Payload shape
 *
 * ```json
 * {
 *   "scan_ref":    "<opaque reference to the codebase snapshot>",
 *   "schedule_ref": "<opaque reference to the cron schedule entry>"
 * }
 * ```
 *
 * Payloads must contain only opaque identifiers — no raw text, PII, or
 * secrets (TQ-P-002). The Claude CLI binary fetches the codebase content at
 * execution time via the authenticated API using the delegated token.
 *
 * ### Result shape
 *
 * ```json
 * {
 *   "result": "<human-readable summary of SOC review>",
 *   "status": "completed",
 *   "findings": [
 *     {
 *       "category": "security",
 *       "severity": "high",
 *       "path": "apps/server/src/api/auth.ts",
 *       "description": "Missing rate limiting on authentication endpoint",
 *       "remediation": "Add rate limiting middleware to POST /auth/login"
 *     }
 *   ],
 *   "scanned_at": "<ISO 8601 timestamp>",
 *   "finding_count": 1
 * }
 * ```
 *
 * ### Enqueue example (via cron scheduler)
 *
 * ```http
 * POST /api/tasks-queue
 * Content-Type: application/json
 *
 * {
 *   "idempotency_key": "cron:soc-compliance-review:2024-01-01T00:00:00.000Z",
 *   "agent_type": "soc_compliance",
 *   "job_type": "soc_compliance_review",
 *   "payload": {
 *     "scan_ref": "scan_abc123"
 *   }
 * }
 * ```
 *
 * Blueprint reference: WORKER domain — cron-scheduled compliance agent
 */

/** The agent_type string for SOC compliance review workers. */
export const SOC_COMPLIANCE_AGENT_TYPE = 'soc_compliance' as const;

/** The job_type string identifying a SOC compliance review task. */
export const SOC_COMPLIANCE_JOB_TYPE = 'soc_compliance_review' as const;

/** Hard timeout for SOC compliance review jobs: 5 minutes. */
export const SOC_COMPLIANCE_TIMEOUT_MS = 5 * 60 * 1_000;

/**
 * SOC 2 Trust Service Criteria compliance categories.
 */
export type SocCategory =
  | 'security'
  | 'availability'
  | 'processing_integrity'
  | 'confidentiality'
  | 'privacy';

/**
 * Severity levels for compliance findings.
 */
export type FindingSeverity = 'critical' | 'high' | 'medium' | 'low' | 'informational';

/**
 * A single SOC 2 compliance finding.
 */
export interface SocComplianceFinding {
  /** SOC 2 Trust Service Criteria category. */
  category: SocCategory;
  /** Severity of the finding. */
  severity: FindingSeverity;
  /** File path where the finding was identified. */
  path: string;
  /** Human-readable description of the compliance issue. */
  description: string;
  /** Suggested remediation steps. */
  remediation: string;
}

/**
 * Payload shape for the `soc_compliance_review` job type.
 *
 * Only opaque identifiers are permitted (TQ-P-002). Workers fetch data
 * through the API at execution time; the queue row must never carry raw content.
 */
export interface SocComplianceAgentPayload {
  /** Opaque reference to the codebase snapshot for review. Optional. */
  scan_ref?: string;
  /** Opaque reference to the cron schedule entry that triggered this job. Optional. */
  schedule_ref?: string;
  /** Opaque correlation tag for tracing. */
  correlation_ref?: string;
}

/**
 * Expected result shape returned by the Claude CLI for `soc_compliance_review` tasks.
 */
export interface SocComplianceAgentResult {
  /** Human-readable summary of the SOC 2 compliance review. */
  result: string;
  /** Execution status. */
  status?: 'completed' | 'failed';
  /** Structured SOC 2 compliance findings. */
  findings: SocComplianceFinding[];
  /** ISO 8601 timestamp when the scan completed. */
  scanned_at: string;
  /** Total number of findings. */
  finding_count: number;
  /** Whether the result was produced by the dev stub (local dev only). */
  stub?: boolean;
  /** Additional vendor-specific fields forwarded as-is. */
  [key: string]: unknown;
}

/**
 * The Claude CLI prompt instructing the agent to perform SOC 2 compliance review.
 *
 * This prompt is embedded in the CLI payload so the agent knows the full
 * scope of the review required.
 */
export const SOC_COMPLIANCE_PROMPT = `You are a SOC 2 compliance expert. Review the provided codebase for SOC 2 Trust Service Criteria violations.

Evaluate the following criteria:
1. **Security (CC)**: Access controls, authentication, authorisation, input validation, encryption at rest and in transit, error handling that does not leak sensitive information.
2. **Availability (A)**: Service uptime controls, error handling, graceful degradation, rate limiting.
3. **Processing Integrity (PI)**: Data validation, transaction completeness, error detection and correction.
4. **Confidentiality (C)**: Data classification, encryption, secrets management, logging controls.
5. **Privacy (P)**: PII handling, data minimisation, retention controls.

For each finding, provide:
- category: one of [security, availability, processing_integrity, confidentiality, privacy]
- severity: one of [critical, high, medium, low, informational]
- path: the file path where the issue was found
- description: clear description of the compliance gap
- remediation: specific, actionable remediation steps

Return a JSON object with:
{
  "result": "<summary of review>",
  "status": "completed",
  "findings": [...],
  "scanned_at": "<ISO 8601 timestamp>",
  "finding_count": <number>
}`;

/**
 * Build the stdin payload sent to the Claude CLI for a `soc_compliance_review` task.
 *
 * The task's `id`, `job_type`, `agent_type`, `payload`, and the compliance
 * prompt are merged into a single object so the CLI binary has all context.
 */
export function buildSocComplianceCliPayload(
  taskId: string,
  agentType: string,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  return {
    id: taskId,
    job_type: SOC_COMPLIANCE_JOB_TYPE,
    agent_type: agentType,
    prompt: SOC_COMPLIANCE_PROMPT,
    ...payload,
  };
}

/**
 * Validate that a raw CLI result object conforms to the expected SOC compliance shape.
 *
 * Throws if the result is missing required fields.
 */
export function validateSocComplianceResult(
  raw: Record<string, unknown>,
): SocComplianceAgentResult {
  if (typeof raw['result'] !== 'string') {
    throw new Error(
      `SOC compliance CLI result is missing required "result" string field. Got: ${JSON.stringify(raw).slice(0, 200)}`,
    );
  }

  if (!Array.isArray(raw['findings'])) {
    throw new Error(
      `SOC compliance CLI result is missing required "findings" array field. Got: ${JSON.stringify(raw).slice(0, 200)}`,
    );
  }

  if (typeof raw['scanned_at'] !== 'string') {
    throw new Error(
      `SOC compliance CLI result is missing required "scanned_at" string field. Got: ${JSON.stringify(raw).slice(0, 200)}`,
    );
  }

  if (typeof raw['finding_count'] !== 'number') {
    throw new Error(
      `SOC compliance CLI result is missing required "finding_count" number field. Got: ${JSON.stringify(raw).slice(0, 200)}`,
    );
  }

  return raw as SocComplianceAgentResult;
}
