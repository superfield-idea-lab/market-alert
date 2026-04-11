# Phase 8 — Compliance Officer View Service Flow

## Overview

This document describes the service flow for the Compliance Officer view
shipped in Phase 8. The compliance view provides designated compliance
personnel with audit trails, data residency controls, retention policy
management, and PII exposure reports.

## State machine

```
[Authenticated as Compliance Officer] ──navigate──> [Compliance Dashboard]
        │
        ├── [Audit Log Panel]
        │       │
        │       ├── filter by date / actor / action ──> [Filtered Audit Log]
        │       │       │
        │       │       └── select event ──> [Audit Event Detail]
        │       │               │
        │       │               └── export event ──> [Export Download]
        │       │
        │       └── bulk export ──> [Export Job] ──> [Download Ready]
        │
        ├── [Retention Policy Panel]
        │       │
        │       ├── view active policies ──> [Policy List]
        │       │       │
        │       │       └── select policy ──> [Policy Detail]
        │       │               │
        │       │               ├── edit ──> [Policy Edit Form] ──> [Policy Detail]
        │       │               └── deactivate ──> [Confirm Deactivate] ──> [Policy List]
        │       │
        │       └── create policy ──> [New Policy Form] ──> [Policy Detail]
        │
        ├── [PII Exposure Report Panel]
        │       │
        │       ├── generate report ──> [Report In Progress] ──> [Report View]
        │       │       │
        │       │       └── remediate finding ──> [Remediation Workflow]
        │       │
        │       └── view historical reports ──> [Report Archive]
        │
        └── [Data Residency Panel]
                │
                ├── view region assignments ──> [Region Map]
                └── reassign tenant ──> [Reassign Form] ──> [Confirm] ──> [Region Map]
```

## Actors

| Actor              | Role                                                         |
| ------------------ | ------------------------------------------------------------ |
| Compliance Officer | Full access to audit logs, retention, PII reports, residency |
| Legal Counsel      | Read-only access to audit logs and PII reports               |
| Admin              | Can assign compliance role; cannot modify retention policies |

## Entry points

- `/compliance` — compliance dashboard
- `/compliance/audit` — audit log
- `/compliance/retention` — retention policy management
- `/compliance/pii` — PII exposure reports
- `/compliance/residency` — data residency controls

## Key interactions

### Audit log

1. Dashboard loads `GET /api/compliance/audit?from=&to=&actor=&action=`.
2. Events streamed via cursor pagination for large date ranges.
3. Export triggers `POST /api/compliance/audit/export { filters }`.
4. Signed S3/GCS URL returned; download starts automatically.

### Retention policy management

1. Policy list loaded from `GET /api/compliance/retention/policies`.
2. Edit form submits `PATCH /api/compliance/retention/policies/:id`.
3. Deactivation requires confirmation modal (irreversible within 24 h).
4. Active policy changes are audit-logged automatically.

### PII exposure report

1. Report generation requests `POST /api/compliance/pii/reports`.
2. Long-running job; progress polled via `GET /api/compliance/pii/reports/:jobId`.
3. Completed report shows findings by data category and affected records.
4. Remediation actions trigger `POST /api/compliance/pii/remediate { findingId, action }`.

### Data residency

1. Current tenant-region assignments loaded from `GET /api/compliance/residency`.
2. Reassignment form validates target region before submission.
3. `POST /api/compliance/residency/reassign { tenantId, targetRegion }` queues migration.
4. Migration status polled; compliance officer notified on completion.

## Error states

| State              | Trigger                                    | Recovery                                                             |
| ------------------ | ------------------------------------------ | -------------------------------------------------------------------- |
| Unauthorised       | Non-compliance user accesses `/compliance` | Redirect to home with "Access denied" toast                          |
| Export timeout     | Audit export job exceeds 5 min             | Notify via email; provide download link asynchronously               |
| PII scan error     | PII service unavailable                    | Show "Service temporarily unavailable"; last report still accessible |
| Residency conflict | Region migration in progress               | Block reassignment; show migration status                            |
