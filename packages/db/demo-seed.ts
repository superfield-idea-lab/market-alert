/**
 * @file demo-seed.ts
 *
 * Canonical demo fixture data and the idempotent seed function that installs it.
 *
 * ## Why this file exists
 *
 * The demo and e2e tests must start from identical named fixture data so that
 * passing tests prove the demo flows work and vice versa. This module is the
 * single source of truth for all fixture IDs, usernames, and content.
 *
 * ## Usage
 *
 * - **Demo startup**: `apps/server/src/seed/demo-users.ts` calls
 *   `seedDemoFixtures(sql)` when `DEMO_MODE=true` so the live demo always has
 *   this fixture state.
 *
 * - **E2E tests**: `tests/e2e/environment.ts` sets `DEMO_MODE=true` so the
 *   server seeds fixtures automatically on startup. Tests import `DEMO_FIXTURES`
 *   to reference known IDs without hardcoding strings.
 *
 * ## Idempotency
 *
 * All inserts use `ON CONFLICT … DO NOTHING` with deterministic primary keys so
 * repeated calls are safe. The wiki_page `currently_published_version_id` update
 * only fires when the column is NULL.
 *
 * ## Tenant ID convention
 *
 * - `tenant_id = 'demo'` for records scoped to the demo org (golden docs, budget,
 *   canonical source). The golden-documents and cost APIs derive tenant from the
 *   entities table.
 * - `tenant_id = RESEARCHER_ID` for records queried by user.id in the web app
 *   (wiki pages, signals). The wiki-nav and signal-feed APIs default tenant_id
 *   to the authenticated user's entity ID when no tenant_id query param is sent.
 *
 * @see apps/server/src/seed/demo-users.ts
 * @see tests/e2e/fixtures.ts
 */

import type postgres from 'postgres';

type Sql = postgres.Sql;

// Stable IDs — never change these once they are in production seed data.
const RESEARCHER_ID = 'f47ac10b-58cc-4372-a567-0e02b2c3d001';
const DEMO_TENANT = 'demo';

// ---------------------------------------------------------------------------
// DEMO_FIXTURES — deterministic IDs and metadata for every fixture row.
// These values are stable across runs and referenced directly in tests.
// ---------------------------------------------------------------------------

export const DEMO_FIXTURES = {
  users: {
    /** Researcher (account_manager) — the primary demo persona: Alice, life sciences investor. */
    researcher: {
      id: RESEARCHER_ID,
      username: 'demo-researcher',
      role: 'account_manager',
      /** Display label used by /api/demo/users sort and Sign-in button. */
      displayRole: 'Account Manager',
    },
    /** Admin — for cost telemetry, source-scope, and pipeline-health API tests. */
    admin: {
      id: 'f47ac10b-58cc-4372-a567-0e02b2c3d002',
      username: 'demo-admin',
      role: 'admin',
      displayRole: 'Admin',
    },
    /** Supervisor — for supervisor-role flows. */
    supervisor: {
      id: 'f47ac10b-58cc-4372-a567-0e02b2c3d003',
      username: 'demo-supervisor',
      role: 'supervisor',
      displayRole: 'Supervisor',
    },
  },

  /** Active canonical source pre-registered for the demo tenant. */
  source: {
    id: 'f47ac10b-58cc-4372-a567-0e02b2c3d010',
    methodologyId: 'demo-methodology',
    tenantId: DEMO_TENANT,
    name: 'SEC EDGAR Full-Text Search',
    url: 'https://efts.sec.gov/LATEST/search-index',
    accessMode: 'public' as const,
    status: 'active' as const,
  },

  /**
   * Wiki page for ACME Therapeutics with a published (indexed) version.
   *
   * tenant_id = RESEARCHER_ID because wiki-nav API defaults tenant_id to
   * the authenticated user's entity ID (user.id) when no query param is sent.
   */
  wikiPage: {
    id: 'f47ac10b-58cc-4372-a567-0e02b2c3d020',
    tenantId: RESEARCHER_ID,
    subjectType: 'company',
    subjectId: 'acme-therapeutics',
    /** The one indexed version, pointed to by wiki_pages.currently_published_version_id. */
    versionId: 'f47ac10b-58cc-4372-a567-0e02b2c3d021',
  },

  /** Golden documents authored by the demo researcher. */
  goldenDocs: {
    industryDefinition: {
      id: 'f47ac10b-58cc-4372-a567-0e02b2c3d040',
      tenantId: DEMO_TENANT,
      kind: 'industry_definition' as const,
      title: 'Small-Cap Clinical-Stage Biotech — Oncology & CNS',
    },
    researchMethodology: {
      id: 'f47ac10b-58cc-4372-a567-0e02b2c3d041',
      tenantId: DEMO_TENANT,
      kind: 'research_methodology' as const,
      title: "Alice's Research Methodology — Life Sciences Investor",
    },
  },

  /**
   * Market events for the demo tenant's watchlist company.
   *
   * These represent real catalyst classes the demo persona cares about
   * (clinical readout, regulatory action, financing event).
   */
  marketEvents: {
    phase3Readout: {
      id: 'f47ac10b-58cc-4372-a567-0e02b2c3d060',
      eventType: 'clinical_readout',
      subjectEntityId: 'acme-therapeutics',
      description:
        'ACME Therapeutics SUMMIT-3 Phase 3 trial in recurrent GBM: primary endpoint met (mOS 14.2 vs 9.8 months, HR 0.67, p=0.003)',
      eventDate: '2026-05-14T14:30:00Z',
      status: 'Evaluated' as const,
    },
    btdDesignation: {
      id: 'f47ac10b-58cc-4372-a567-0e02b2c3d061',
      eventType: 'regulatory_action',
      subjectEntityId: 'acme-therapeutics',
      description:
        'FDA grants Breakthrough Therapy Designation to ACME-101 for relapsed glioblastoma multiforme',
      eventDate: '2026-04-22T18:00:00Z',
      status: 'Evaluated' as const,
    },
    pipeFinancing: {
      id: 'f47ac10b-58cc-4372-a567-0e02b2c3d062',
      eventType: 'financing_event',
      subjectEntityId: 'acme-therapeutics',
      description:
        'ACME Therapeutics prices $45M PIPE at $3.20/share (18% discount, 22% dilution) to fund BLA preparation and commercial readiness',
      eventDate: '2026-05-28T09:00:00Z',
      status: 'Enriched' as const,
    },
  },

  /**
   * Signals produced by evaluating the market events against the standing prompt.
   *
   * tenant_id = RESEARCHER_ID because signal-feed API defaults tenant_id to
   * the authenticated user's entity ID (user.id) when no query param is sent.
   */
  signals: {
    readoutSignal: {
      id: 'f47ac10b-58cc-4372-a567-0e02b2c3d070',
      tenantId: RESEARCHER_ID,
      marketEventId: 'f47ac10b-58cc-4372-a567-0e02b2c3d060',
      standingPromptVersionId: 'f47ac10b-58cc-4372-a567-0e02b2c3d051',
      idempotencyKey: 'event_eval:0e02b2c3d060:0e02b2c3d051',
      status: 'Delivered' as const,
      sourceTrust: 0.95,
      extractionCertainty: 0.92,
      rationale:
        "**Direction: Positive — High Conviction.**\n\nACME's SUMMIT-3 Phase 3 trial met its pre-specified primary endpoint with a clinically meaningful OS benefit (HR 0.67). Per the methodology, Phase 3 efficacy data from a Tier A source (SEC 8-K) is the highest-confidence catalyst class. The p-value (0.003) is well below the pre-specified alpha boundary. Wiki notes ACME's cash runway is 18 months post-financing, sufficient through BLA filing. No safety signals flagged in the 8-K. This is the event type the standing prompt was distilled to evaluate.\n\n**Confidence: 0.87** (source_trust: 0.95 × extraction_certainty: 0.92).",
    },
    btdSignal: {
      id: 'f47ac10b-58cc-4372-a567-0e02b2c3d071',
      tenantId: RESEARCHER_ID,
      marketEventId: 'f47ac10b-58cc-4372-a567-0e02b2c3d061',
      standingPromptVersionId: 'f47ac10b-58cc-4372-a567-0e02b2c3d051',
      idempotencyKey: 'event_eval:0e02b2c3d061:0e02b2c3d051',
      status: 'Delivered' as const,
      sourceTrust: 0.98,
      extractionCertainty: 0.93,
      rationale:
        "**Direction: Positive — Moderate Conviction.**\n\nFDA Breakthrough Therapy Designation for ACME-101 in relapsed GBM. Per the methodology, BTD from a Tier A source (FDA press release) is a positive directional signal: it accelerates review and increases approval probability, but does not guarantee approval. The wiki's current thesis for ACME already anticipates a BLA submission in H2 2026; BTD strengthens that timeline. No change to the primary thesis is warranted — this is a confirmation, not a revision.\n\n**Confidence: 0.91** (source_trust: 0.98 × extraction_certainty: 0.93).",
    },
    pipeSignal: {
      id: 'f47ac10b-58cc-4372-a567-0e02b2c3d072',
      tenantId: RESEARCHER_ID,
      marketEventId: 'f47ac10b-58cc-4372-a567-0e02b2c3d062',
      standingPromptVersionId: 'f47ac10b-58cc-4372-a567-0e02b2c3d051',
      idempotencyKey: 'event_eval:0e02b2c3d062:0e02b2c3d051',
      status: 'Queued' as const,
      sourceTrust: 0.9,
      extractionCertainty: 0.64,
      rationale:
        "**Direction: Neutral — Requires Review.**\n\nACME prices a $45M PIPE at 22% dilution. The methodology flags PIPE financings above 15% dilution for reviewer evaluation against use-of-proceeds. The 8-K states proceeds fund BLA preparation and commercial readiness — a strategic use consistent with the positive Phase 3 outcome. However, extraction certainty is reduced because the dilution level crosses the methodology's review threshold. Routing to Reviewer queue per confidence threshold.\n\n**Confidence: 0.58** (source_trust: 0.90 × extraction_certainty: 0.64).",
    },
  },

  /** Monthly budget record for the demo researcher, period June 2026. */
  budget: {
    id: 'f47ac10b-58cc-4372-a567-0e02b2c3d030',
    tenantId: DEMO_TENANT,
    periodStart: '2026-06-01',
    monthlyLimitUsd: '500.0000',
  },
} as const;

export type DemoFixtures = typeof DEMO_FIXTURES;

// ---------------------------------------------------------------------------
// seedDemoFixtures — inserts all fixture rows idempotently.
// ---------------------------------------------------------------------------

/**
 * Seed the canonical demo fixtures into the database.
 *
 * Inserts fixture users, canonical source, wiki page + version, golden docs,
 * market events, signals, cost ledger entries, and researcher budget.
 * All operations are idempotent — safe to call on every server startup.
 *
 * @param sql — a connected postgres.js pool targeting the app database.
 */
export async function seedDemoFixtures(sql: Sql): Promise<void> {
  const f = DEMO_FIXTURES;

  // ── Users ──────────────────────────────────────────────────────────────────
  await sql`
    INSERT INTO entities (id, type, properties, tenant_id)
    VALUES (
      ${f.users.researcher.id},
      'user',
      ${sql.json({ username: f.users.researcher.username, role: f.users.researcher.role }) as never},
      null
    )
    ON CONFLICT (id) DO NOTHING
  `;
  for (const user of [f.users.admin, f.users.supervisor]) {
    await sql`
      INSERT INTO entities (id, type, properties, tenant_id)
      VALUES (
        ${user.id},
        'user',
        ${sql.json({ username: user.username, role: user.role }) as never},
        null
      )
      ON CONFLICT (id) DO NOTHING
    `;
  }

  // ── Canonical source ───────────────────────────────────────────────────────
  await sql`
    INSERT INTO canonical_sources
      (id, methodology_id, author_id, tenant_id, name, url, access_mode, status)
    VALUES (
      ${f.source.id},
      ${f.source.methodologyId},
      ${f.users.admin.id},
      ${f.source.tenantId},
      ${f.source.name},
      ${f.source.url},
      ${f.source.accessMode},
      ${f.source.status}
    )
    ON CONFLICT (id) DO NOTHING
  `;

  // ── Wiki page (tenant_id = researcher.id — matched by wiki-nav API default) ─
  await sql`
    INSERT INTO wiki_pages (id, tenant_id, subject_type, subject_id)
    VALUES (
      ${f.wikiPage.id},
      ${f.wikiPage.tenantId},
      ${f.wikiPage.subjectType},
      ${f.wikiPage.subjectId}
    )
    ON CONFLICT (id) DO NOTHING
  `;

  const wikiContent = `# ACME Therapeutics (ACME)

**Entity type**: Company / Ticker
**Sub-industry**: Clinical-stage oncology & CNS biotech (small-cap)
**Watch status**: Active — Phase 3 BLA track

## Pipeline Summary

| Asset | Indication | Stage | Catalyst |
|---|---|---|---|
| ACME-101 | Recurrent GBM | Phase 3 complete — BLA preparation | FDA action date TBD |
| ACME-202 | Glioma prevention | Phase 2 | Interim readout Q4 2026 |

## Thesis

ACME-101 has met its primary endpoint in SUMMIT-3 (HR 0.67, p=0.003). The FDA Breakthrough Therapy Designation shortens the review timeline. BLA preparation is funded through the June 2026 PIPE ($45M). The key remaining risk is the FDA review outcome; no CMC or safety issues flagged.

## Recent Signals

- **2026-05-14**: Phase 3 SUMMIT-3 primary endpoint met. High conviction positive.
- **2026-04-22**: FDA grants Breakthrough Therapy Designation. Positive confirmation.
- **2026-05-28**: $45M PIPE at 22% dilution. Neutral — strategic financing post-readout. Pending reviewer.

## Source Trust

Primary evidence: SEC 8-K filings (Tier A). FDA press releases (Tier A). ClinicalTrials.gov (Tier A).
`;

  await sql`
    INSERT INTO wiki_page_versions_mkt
      (id, wiki_page_id, tenant_id, subject_type, subject_id, body_ciphertext, status)
    VALUES (
      ${f.wikiPage.versionId},
      ${f.wikiPage.id},
      ${f.wikiPage.tenantId},
      ${f.wikiPage.subjectType},
      ${f.wikiPage.subjectId},
      ${wikiContent},
      'indexed'
    )
    ON CONFLICT (id) DO NOTHING
  `;

  await sql`
    UPDATE wiki_pages
    SET currently_published_version_id = ${f.wikiPage.versionId}
    WHERE id = ${f.wikiPage.id}
      AND currently_published_version_id IS NULL
  `;

  // ── Golden documents ───────────────────────────────────────────────────────
  // The golden_documents table has a trigger (guard_golden_document_writer) that
  // rejects writes unless app.current_role = 'researcher'. SET LOCAL inside a
  // transaction so the trigger passes for this seed call.
  // postgres.TransactionSql extends Sql at runtime; the cast is the same pattern
  // used throughout the codebase (see wiki-rebuild-store.ts, standing-prompt-store.ts).
  await sql.begin(async (txRaw) => {
    const tx = txRaw as unknown as Sql;
    await tx.unsafe(`SET LOCAL "app.current_role" = 'researcher'`);
    await tx.unsafe(`SET LOCAL "app.current_tenant_id" = '${DEMO_TENANT}'`);

    await tx`
      INSERT INTO golden_documents (id, kind, author_id, tenant_id, title, state)
      VALUES (
        ${f.goldenDocs.industryDefinition.id},
        ${f.goldenDocs.industryDefinition.kind},
        ${f.users.researcher.id},
        ${f.goldenDocs.industryDefinition.tenantId},
        ${f.goldenDocs.industryDefinition.title},
        'active'
      )
      ON CONFLICT (id) DO NOTHING
    `;

    await tx`
      INSERT INTO golden_document_sections (id, document_id, section_key, content, position)
      VALUES
        ('f47ac10b-58cc-4372-a567-0e02b2c3d042', ${f.goldenDocs.industryDefinition.id}, 'niche',
         ${'Clinical-stage biotechs with market caps under $500M developing oncology and CNS therapeutics. Focus on companies with at least one Phase 2 or Phase 3 asset, strong cash runway (>12 months), and a defined near-term catalyst window within the next 12 months.'},
         0),
        ('f47ac10b-58cc-4372-a567-0e02b2c3d043', ${f.goldenDocs.industryDefinition.id}, 'watchlist',
         ${'ACME Therapeutics (ACME) — Phase 3 GBM BLA track, FDA BTD granted\nNova Biosciences (NVBS) — FDA approval decision expected Q4 2026\nCrescent Pharma (CRSP) — Clinical hold resolution expected H2 2026'},
         1),
        ('f47ac10b-58cc-4372-a567-0e02b2c3d044', ${f.goldenDocs.industryDefinition.id}, 'catalyst_classes',
         ${'Clinical readouts (Phase 2 interim, Phase 3 primary endpoint), FDA approval decisions (standard and accelerated review), Complete Response Letters, AdCom outcomes, clinical holds and resolutions, Breakthrough Therapy and Fast Track designations, financing events (PIPE, ATM, public offering), M&A and partnership announcements.'},
         2)
      ON CONFLICT (document_id, section_key) DO NOTHING
    `;

    await tx`
      INSERT INTO golden_documents (id, kind, author_id, tenant_id, title, state)
      VALUES (
        ${f.goldenDocs.researchMethodology.id},
        ${f.goldenDocs.researchMethodology.kind},
        ${f.users.researcher.id},
        ${f.goldenDocs.researchMethodology.tenantId},
        ${f.goldenDocs.researchMethodology.title},
        'active'
      )
      ON CONFLICT (id) DO NOTHING
    `;

    await tx`
      INSERT INTO golden_document_sections (id, document_id, section_key, content, position)
      VALUES
        ('f47ac10b-58cc-4372-a567-0e02b2c3d045', ${f.goldenDocs.researchMethodology.id}, 'trusted_sources',
         ${'Tier A (most trusted): SEC EDGAR full-text search (8-K, S-1, prospectus), FDA press releases and approval database, ClinicalTrials.gov registry updates.\nTier B: Company press releases on PR Newswire and GlobeNewswire, company IR websites.\nTier C: Industry news aggregators (FierceBiotech, STAT News, BioPharma Dive). Tier C sources require Tier A or B corroboration before influencing the standing prompt.'},
         0),
        ('f47ac10b-58cc-4372-a567-0e02b2c3d046', ${f.goldenDocs.researchMethodology.id}, 'evaluation_heuristics',
         ${'1. Source trust dominates: a Tier A source outweighs three Tier C sources. 2. Clinical readouts: evaluate against pre-specified primary endpoints only; secondary endpoints are hypothesis-generating. 3. Regulatory: FDA language matters — "approval" vs "tentative approval" vs "complete response letter" each have distinct implications. 4. Financing: ATMs and PIPEs below 15% dilution are neutral; 15–25% require reviewer evaluation against use-of-proceeds; above 25% are negative signals absent a clear strategic rationale.'},
         1),
        ('f47ac10b-58cc-4372-a567-0e02b2c3d047', ${f.goldenDocs.researchMethodology.id}, 'source_ranking',
         ${'1. SEC filings (8-K, 20-F, S-1) 2. FDA official communications and CDER database 3. ClinicalTrials.gov registry updates 4. Company press releases (official IR site) 5. Newswire (PR Newswire / GlobeNewswire) 6. Industry trade press (FierceBiotech, STAT News) — corroboration only'},
         2)
      ON CONFLICT (document_id, section_key) DO NOTHING
    `;
  });

  // ── Market events ──────────────────────────────────────────────────────────
  for (const [key, ev] of Object.entries(f.marketEvents) as [
    string,
    (typeof f.marketEvents)[keyof typeof f.marketEvents],
  ][]) {
    void key;
    await sql`
      INSERT INTO market_events
        (id, source, event_type, subject_entity_id, subject_entity_type,
         event_date, description, status)
      VALUES (
        ${ev.id},
        'demo',
        ${ev.eventType},
        ${ev.subjectEntityId},
        'company',
        ${ev.eventDate}::TIMESTAMPTZ,
        ${ev.description},
        ${ev.status}
      )
      ON CONFLICT (id) DO NOTHING
    `;
  }

  // ── Signals (tenant_id = researcher.id — matched by signal-feed API default) ─
  for (const [key, sig] of Object.entries(f.signals) as [
    string,
    (typeof f.signals)[keyof typeof f.signals],
  ][]) {
    void key;
    await sql`
      INSERT INTO signals
        (id, tenant_id, researcher_id, market_event_id, standing_prompt_version_id,
         idempotency_key, rationale, source_trust, extraction_certainty, status)
      VALUES (
        ${sig.id},
        ${sig.tenantId},
        ${f.users.researcher.id},
        ${sig.marketEventId},
        ${sig.standingPromptVersionId},
        ${sig.idempotencyKey},
        ${sig.rationale},
        ${sig.sourceTrust},
        ${sig.extractionCertainty},
        ${sig.status}
      )
      ON CONFLICT (idempotency_key) DO NOTHING
    `;
  }

  // ── Researcher budget ──────────────────────────────────────────────────────
  await sql`
    INSERT INTO researcher_budgets
      (id, tenant_id, researcher_id, period_start, monthly_limit_usd)
    VALUES (
      ${f.budget.id},
      ${f.budget.tenantId},
      ${f.users.researcher.id},
      ${f.budget.periodStart},
      ${f.budget.monthlyLimitUsd}
    )
    ON CONFLICT (tenant_id, researcher_id, period_start) DO NOTHING
  `;

  // ── Cost ledger entries ────────────────────────────────────────────────────
  // Seed representative spend so the budget gauge shows meaningful data.
  // Total seeded: ~$127.40 against the $500 monthly limit.
  const costEntries = [
    {
      id: 'f47ac10b-58cc-4372-a567-0e02b2c3d080',
      operation_type: 'source_scrape',
      cost_usd: '12.400000',
      metadata: { source: 'SEC EDGAR', pages_scraped: 248 },
    },
    {
      id: 'f47ac10b-58cc-4372-a567-0e02b2c3d081',
      operation_type: 'source_scrape',
      cost_usd: '8.750000',
      metadata: { source: 'ClinicalTrials.gov', pages_scraped: 175 },
    },
    {
      id: 'f47ac10b-58cc-4372-a567-0e02b2c3d082',
      operation_type: 'wiki_rebuild',
      cost_usd: '34.200000',
      metadata: { pages_rebuilt: 3, model: 'claude-sonnet-4-6' },
    },
    {
      id: 'f47ac10b-58cc-4372-a567-0e02b2c3d083',
      operation_type: 'wiki_rebuild',
      cost_usd: '28.900000',
      metadata: { pages_rebuilt: 2, model: 'claude-sonnet-4-6' },
    },
    {
      id: 'f47ac10b-58cc-4372-a567-0e02b2c3d084',
      operation_type: 'standing_prompt_distill',
      cost_usd: '18.600000',
      metadata: { prompts_distilled: 3, model: 'claude-sonnet-4-6' },
    },
    {
      id: 'f47ac10b-58cc-4372-a567-0e02b2c3d085',
      operation_type: 'event_evaluate',
      cost_usd: '24.550000',
      metadata: { events_evaluated: 3, model: 'claude-sonnet-4-6' },
    },
  ] as const;

  for (const entry of costEntries) {
    await sql`
      INSERT INTO cost_ledger
        (id, tenant_id, researcher_id, period_start, operation_type, cost_usd, metadata)
      VALUES (
        ${entry.id},
        ${f.budget.tenantId},
        ${f.users.researcher.id},
        ${f.budget.periodStart},
        ${entry.operation_type},
        ${entry.cost_usd},
        ${sql.json(entry.metadata) as never}
      )
      ON CONFLICT (id) DO NOTHING
    `;
  }
}
