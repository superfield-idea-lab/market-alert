/**
 * @file cost-telemetry-store.ts
 *
 * DB access layer for cost telemetry and per-researcher budget enforcement
 * (issue #89, Phase 10 — Admin, cost envelope, and replay).
 *
 * ## What this module does
 *
 * Exposes typed helpers for:
 *   - `setResearcherBudget`       — Admin sets a monthly cost limit
 *   - `getResearcherBudget`       — Fetch the active budget for a researcher/period
 *   - `recordCost`                — Append-only cost metering entry
 *   - `getPeriodSpend`            — Sum spend for a researcher in a period
 *   - `getBudgetStatus`           — Spend vs. limit summary (for researcher + admin views)
 *   - `isOverBudget`              — Boolean check used by cadence-tuning logic
 *
 * ## Cost model
 *
 * `cost_usd` is an abstract cost unit consistent with `monthly_limit_usd` on
 * `researcher_budgets`. The system does not require a real USD billing feed —
 * the caller supplies an estimate (e.g. token count × per-token rate).
 *
 * ## Canonical docs
 *
 * - `docs/prd.md` §2, §7 — per-researcher cost envelope, cadence tuning
 * - `docs/architecture.md` §"Admin, cost envelope, and replay"
 * - `packages/db/mkt-schema.sql` — `researcher_budgets` and `cost_ledger` DDL
 * - `apps/server/src/api/cost-telemetry-api.ts` — HTTP API layer
 *
 * @see https://github.com/superfield-idea-lab/market-alert/issues/89
 */

import type postgres from 'postgres';

export type SqlClient = postgres.Sql;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CostOperationType =
  | 'source_scrape'
  | 'wiki_rebuild'
  | 'standing_prompt_distill'
  | 'event_evaluate';

export interface ResearcherBudgetRow {
  id: string;
  tenant_id: string;
  researcher_id: string;
  /** ISO date string: 'YYYY-MM-DD' */
  period_start: string;
  monthly_limit_usd: string; // postgres NUMERIC returns as string
  created_at: Date;
  updated_at: Date;
}

export interface CostLedgerRow {
  id: string;
  tenant_id: string;
  researcher_id: string;
  period_start: string;
  operation_type: CostOperationType;
  task_id: string | null;
  cost_usd: string; // postgres NUMERIC returns as string
  metadata: Record<string, unknown> | null;
  created_at: Date;
}

export interface BudgetStatus {
  tenant_id: string;
  researcher_id: string;
  period_start: string;
  monthly_limit_usd: number;
  period_spend_usd: number;
  remaining_usd: number;
  /** True when period_spend_usd >= monthly_limit_usd. */
  over_budget: boolean;
  /** Fraction consumed: period_spend_usd / monthly_limit_usd, capped at 1.0. */
  utilisation_fraction: number;
}

// ---------------------------------------------------------------------------
// Budget management (Admin writes)
// ---------------------------------------------------------------------------

/**
 * Set (upsert) the monthly cost limit for a researcher in a given period.
 *
 * Uses INSERT … ON CONFLICT (tenant_id, researcher_id, period_start) DO UPDATE
 * so that re-calling with the same period is idempotent.
 *
 * ## Integration point
 *
 * Called by the Admin via PATCH /api/admin/cost-budget.
 */
export async function setResearcherBudget(
  sql: SqlClient,
  input: {
    tenant_id: string;
    researcher_id: string;
    period_start: string; // 'YYYY-MM-DD'
    monthly_limit_usd: number;
  },
): Promise<ResearcherBudgetRow> {
  const rows = await sql<ResearcherBudgetRow[]>`
    INSERT INTO researcher_budgets
      (tenant_id, researcher_id, period_start, monthly_limit_usd)
    VALUES (
      ${input.tenant_id},
      ${input.researcher_id},
      ${input.period_start},
      ${input.monthly_limit_usd}
    )
    ON CONFLICT (tenant_id, researcher_id, period_start) DO UPDATE
      SET monthly_limit_usd = EXCLUDED.monthly_limit_usd,
          updated_at        = CURRENT_TIMESTAMP
    RETURNING id, tenant_id, researcher_id, period_start::TEXT, monthly_limit_usd::TEXT,
              created_at, updated_at
  `;
  return rows[0]!;
}

/**
 * Fetch the active budget row for a researcher in the given period.
 *
 * Returns null when no budget has been set for this period.
 */
export async function getResearcherBudget(
  sql: SqlClient,
  tenantId: string,
  researcherId: string,
  periodStart: string,
): Promise<ResearcherBudgetRow | null> {
  const rows = await sql<ResearcherBudgetRow[]>`
    SELECT id, tenant_id, researcher_id, period_start::TEXT, monthly_limit_usd::TEXT,
           created_at, updated_at
    FROM researcher_budgets
    WHERE tenant_id    = ${tenantId}
      AND researcher_id = ${researcherId}
      AND period_start  = ${periodStart}
  `;
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// Cost recording (worker writes via API)
// ---------------------------------------------------------------------------

/**
 * Record one cost metering entry.
 *
 * Append-only: cost_ledger rows are never updated or deleted.
 *
 * ## Integration point
 *
 * Called by workers via POST /internal/cost-record. Workers POST the estimate
 * for each billable step (scrape, wiki-rebuild, distill, event-evaluate).
 */
export async function recordCost(
  sql: SqlClient,
  input: {
    tenant_id: string;
    researcher_id: string;
    period_start: string;
    operation_type: CostOperationType;
    task_id?: string | null;
    cost_usd: number;
    metadata?: Record<string, unknown> | null;
  },
): Promise<CostLedgerRow> {
  const rows = await sql<CostLedgerRow[]>`
    INSERT INTO cost_ledger
      (tenant_id, researcher_id, period_start, operation_type, task_id, cost_usd, metadata)
    VALUES (
      ${input.tenant_id},
      ${input.researcher_id},
      ${input.period_start},
      ${input.operation_type},
      ${input.task_id ?? null},
      ${input.cost_usd},
      ${input.metadata ? JSON.stringify(input.metadata) : null}
    )
    RETURNING id, tenant_id, researcher_id, period_start::TEXT, operation_type,
              task_id, cost_usd::TEXT, metadata, created_at
  `;
  return rows[0]!;
}

// ---------------------------------------------------------------------------
// Spend queries
// ---------------------------------------------------------------------------

/**
 * Sum the recorded cost for a researcher in a period, optionally by operation type.
 *
 * Returns 0 when no entries exist.
 */
export async function getPeriodSpend(
  sql: SqlClient,
  tenantId: string,
  researcherId: string,
  periodStart: string,
  operationType?: CostOperationType,
): Promise<number> {
  let rows: { total: string }[];
  if (operationType !== undefined) {
    rows = await sql<{ total: string }[]>`
      SELECT COALESCE(SUM(cost_usd), 0)::TEXT AS total
      FROM cost_ledger
      WHERE tenant_id      = ${tenantId}
        AND researcher_id  = ${researcherId}
        AND period_start   = ${periodStart}
        AND operation_type = ${operationType}
    `;
  } else {
    rows = await sql<{ total: string }[]>`
      SELECT COALESCE(SUM(cost_usd), 0)::TEXT AS total
      FROM cost_ledger
      WHERE tenant_id     = ${tenantId}
        AND researcher_id = ${researcherId}
        AND period_start  = ${periodStart}
    `;
  }
  return parseFloat(rows[0]?.total ?? '0');
}

/**
 * Return a spend-vs-budget summary for a researcher in a period.
 *
 * When no budget row exists, monthly_limit_usd defaults to 0 (which means
 * the researcher is over-budget as soon as any cost is recorded).
 *
 * ## Integration point
 *
 * Called by GET /api/cost/status (researcher and Admin visibility).
 */
export async function getBudgetStatus(
  sql: SqlClient,
  tenantId: string,
  researcherId: string,
  periodStart: string,
): Promise<BudgetStatus> {
  const [budget, spend] = await Promise.all([
    getResearcherBudget(sql, tenantId, researcherId, periodStart),
    getPeriodSpend(sql, tenantId, researcherId, periodStart),
  ]);

  const limit = budget ? parseFloat(budget.monthly_limit_usd) : 0;
  const remaining = Math.max(0, limit - spend);
  const over = spend >= limit && limit > 0;
  const fraction = limit > 0 ? Math.min(1, spend / limit) : spend > 0 ? 1 : 0;

  return {
    tenant_id: tenantId,
    researcher_id: researcherId,
    period_start: periodStart,
    monthly_limit_usd: limit,
    period_spend_usd: spend,
    remaining_usd: remaining,
    over_budget: over,
    utilisation_fraction: fraction,
  };
}

/**
 * Boolean over-budget check used by cadence-tuning logic.
 *
 * Returns true when the researcher has consumed >= their monthly_limit_usd
 * for the given period. When no budget is set (limit = 0) this returns false
 * so the system does not block work for researchers without a configured limit.
 */
export async function isOverBudget(
  sql: SqlClient,
  tenantId: string,
  researcherId: string,
  periodStart: string,
): Promise<boolean> {
  const status = await getBudgetStatus(sql, tenantId, researcherId, periodStart);
  // No budget set → treat as unconstrained.
  if (status.monthly_limit_usd === 0) return false;
  return status.over_budget;
}

/**
 * List per-operation cost breakdown for a researcher in a period.
 *
 * Returns one row per operation_type, ordered by total_usd descending.
 */
export async function getOperationBreakdown(
  sql: SqlClient,
  tenantId: string,
  researcherId: string,
  periodStart: string,
): Promise<{ operation_type: CostOperationType; total_usd: number; entry_count: number }[]> {
  const rows = await sql<
    {
      operation_type: CostOperationType;
      total_usd: string;
      entry_count: string;
    }[]
  >`
    SELECT operation_type,
           COALESCE(SUM(cost_usd), 0)::TEXT   AS total_usd,
           COUNT(*)::TEXT                      AS entry_count
    FROM cost_ledger
    WHERE tenant_id     = ${tenantId}
      AND researcher_id = ${researcherId}
      AND period_start  = ${periodStart}
    GROUP BY operation_type
    ORDER BY SUM(cost_usd) DESC
  `;
  return rows.map(
    (r: { operation_type: CostOperationType; total_usd: string; entry_count: string }) => ({
      operation_type: r.operation_type,
      total_usd: parseFloat(r.total_usd),
      entry_count: parseInt(r.entry_count, 10),
    }),
  );
}
