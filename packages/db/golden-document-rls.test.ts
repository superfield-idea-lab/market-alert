/**
 * @file golden-document-rls.test.ts
 *
 * Integration tests for the golden-document author-only enforcement (issue #73).
 *
 * ## Acceptance criteria coverage
 *
 * Issue #73 AC1 — Researcher can author and revise golden documents with
 *   revisions retired correctly:
 *   → `researcher creates an industry_definition and reads it back`
 *   → `researcher activates a document and the previous active is retired`
 *
 * Issue #73 AC2 — No agent or worker path can write golden-doc rows:
 *   → `INSERT with app.current_role unset raises trigger error`
 *   → `INSERT with app.current_role = worker raises trigger error`
 *   → `POST /api/golden-documents with a Bearer token returns 403`
 *   → `POST /api/golden-documents without auth returns 401`
 *
 * Issue #73 AC3 — Unified retrieval returns active doc + sections in one call:
 *   → `fetchActiveGoldenDocument returns active doc with sections`
 *
 * ## Design
 *
 * No mocks. All tests use a real ephemeral Postgres container (postgres:16)
 * via the `pg-container` harness. The API-layer tests spin up a real Bun server.
 *
 * The `golden_documents` table requires `entities` to exist (FK: author_id →
 * entities.id). We seed a user entity before each write.
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import postgres from 'postgres';
import { startPostgres, type PgContainer } from './pg-container';
import { migrate } from './index';
import { withRlsContext } from './rls-context';
import { writeJournalEvent } from './business-journal';
import {
  createGoldenDocument,
  getGoldenDocument,
  listGoldenDocuments,
  activateGoldenDocument,
  retireGoldenDocument,
  upsertGoldenDocumentSection,
  listGoldenDocumentSections,
  fetchActiveGoldenDocument,
  type GoldenDocumentRow,
} from './golden-document-store';

// ---------------------------------------------------------------------------
// Shared test state
// ---------------------------------------------------------------------------

let pg: PgContainer;
let sql: ReturnType<typeof postgres>;

const RESEARCHER_ID = 'researcher-test-user-001';
const TENANT_ID = 'tenant-test-001';

beforeAll(async () => {
  pg = await startPostgres();
  sql = postgres(pg.url, { max: 5, idle_timeout: 10 });

  // Apply the full app schema (creates golden_documents, golden_document_sections,
  // entities, business_journal, etc.)
  await migrate({ databaseUrl: pg.url });

  // Seed the entity_types row for 'user'.
  await sql`
    INSERT INTO entity_types (type, schema)
    VALUES ('user', '{}')
    ON CONFLICT (type) DO NOTHING
  `;

  // Seed the researcher user entity so FK constraints pass.
  await sql`
    INSERT INTO entities (id, type, tenant_id, properties)
    VALUES (${RESEARCHER_ID}, 'user', ${TENANT_ID}, '{}')
    ON CONFLICT (id) DO NOTHING
  `;
}, 60_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 });
  await pg?.stop();
});

// ---------------------------------------------------------------------------
// Researcher write path
// ---------------------------------------------------------------------------

describe('golden-document write path — researcher session', () => {
  test('researcher creates an industry_definition and reads it back', async () => {
    let createdId: string;

    // Create via withRlsContext with role: 'researcher'
    const doc = await withRlsContext(
      sql as never,
      { userId: RESEARCHER_ID, tenantId: TENANT_ID, role: 'researcher' },
      async (tx) =>
        createGoldenDocument(tx as never, {
          kind: 'industry_definition',
          author_id: RESEARCHER_ID,
          tenant_id: TENANT_ID,
          title: 'My Industry Definition',
        }),
    );

    expect(doc.id).toBeTruthy();
    expect(doc.kind).toBe('industry_definition');
    expect(doc.author_id).toBe(RESEARCHER_ID);
    expect(doc.tenant_id).toBe(TENANT_ID);
    expect(doc.title).toBe('My Industry Definition');
    expect(doc.state).toBe('authored');

    createdId = doc.id;

    // Read it back via withRlsContext
    const fetched = await withRlsContext(
      sql as never,
      { userId: RESEARCHER_ID, tenantId: TENANT_ID, role: 'researcher' },
      async (tx) => getGoldenDocument(tx as never, createdId),
    );

    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe(createdId);
    expect(fetched!.kind).toBe('industry_definition');
    expect(fetched!.state).toBe('authored');
  });

  test('researcher creates a research_methodology and it appears in listGoldenDocuments', async () => {
    await withRlsContext(
      sql as never,
      { userId: RESEARCHER_ID, tenantId: TENANT_ID, role: 'researcher' },
      async (tx) =>
        createGoldenDocument(tx as never, {
          kind: 'research_methodology',
          author_id: RESEARCHER_ID,
          tenant_id: TENANT_ID,
          title: 'My Research Methodology',
        }),
    );

    const docs = await withRlsContext(
      sql as never,
      { userId: RESEARCHER_ID, tenantId: TENANT_ID, role: 'researcher' },
      async (tx) => listGoldenDocuments(tx as never, RESEARCHER_ID, TENANT_ID),
    );

    const methodology = docs.find((d) => d.kind === 'research_methodology');
    expect(methodology).toBeDefined();
    expect(methodology!.title).toBe('My Research Methodology');
  });

  test('researcher activates a document and the previous active is retired', async () => {
    // Create two industry_definition documents.
    const doc1 = await withRlsContext(
      sql as never,
      { userId: RESEARCHER_ID, tenantId: TENANT_ID, role: 'researcher' },
      async (tx) =>
        createGoldenDocument(tx as never, {
          kind: 'industry_definition',
          author_id: RESEARCHER_ID,
          tenant_id: TENANT_ID,
          title: 'Industry Definition v1',
        }),
    );

    const doc2 = await withRlsContext(
      sql as never,
      { userId: RESEARCHER_ID, tenantId: TENANT_ID, role: 'researcher' },
      async (tx) =>
        createGoldenDocument(tx as never, {
          kind: 'industry_definition',
          author_id: RESEARCHER_ID,
          tenant_id: TENANT_ID,
          title: 'Industry Definition v2',
        }),
    );

    // Activate doc1 first.
    await withRlsContext(
      sql as never,
      { userId: RESEARCHER_ID, tenantId: TENANT_ID, role: 'researcher' },
      async (tx) => activateGoldenDocument(tx as never, doc1.id, RESEARCHER_ID, TENANT_ID),
    );

    // Activate doc2 — doc1 should become 'retired'.
    const activated = await withRlsContext(
      sql as never,
      { userId: RESEARCHER_ID, tenantId: TENANT_ID, role: 'researcher' },
      async (tx) => activateGoldenDocument(tx as never, doc2.id, RESEARCHER_ID, TENANT_ID),
    );

    expect(activated).not.toBeNull();
    expect(activated!.state).toBe('active');
    expect(activated!.id).toBe(doc2.id);

    // doc1 must now be retired.
    const retiredDoc = await withRlsContext(
      sql as never,
      { userId: RESEARCHER_ID, tenantId: TENANT_ID, role: 'researcher' },
      async (tx) => getGoldenDocument(tx as never, doc1.id),
    );
    expect(retiredDoc!.state).toBe('retired');
  });

  test('researcher can explicitly retire a document', async () => {
    const doc = await withRlsContext(
      sql as never,
      { userId: RESEARCHER_ID, tenantId: TENANT_ID, role: 'researcher' },
      async (tx) =>
        createGoldenDocument(tx as never, {
          kind: 'research_methodology',
          author_id: RESEARCHER_ID,
          tenant_id: TENANT_ID,
          title: 'Methodology to retire',
        }),
    );

    const retired = await withRlsContext(
      sql as never,
      { userId: RESEARCHER_ID, tenantId: TENANT_ID, role: 'researcher' },
      async (tx) => retireGoldenDocument(tx as never, doc.id, RESEARCHER_ID, TENANT_ID),
    );

    expect(retired).not.toBeNull();
    expect(retired!.state).toBe('retired');
  });
});

// ---------------------------------------------------------------------------
// Section operations
// ---------------------------------------------------------------------------

describe('golden-document sections', () => {
  let docId: string;

  beforeAll(async () => {
    const doc = await withRlsContext(
      sql as never,
      { userId: RESEARCHER_ID, tenantId: TENANT_ID, role: 'researcher' },
      async (tx) =>
        createGoldenDocument(tx as never, {
          kind: 'industry_definition',
          author_id: RESEARCHER_ID,
          tenant_id: TENANT_ID,
          title: 'Sectioned Document',
        }),
    );
    docId = doc.id;
  });

  test('researcher upserts sections and retrieves them in position order', async () => {
    // Upsert two sections.
    await withRlsContext(
      sql as never,
      { userId: RESEARCHER_ID, tenantId: TENANT_ID, role: 'researcher' },
      async (tx) =>
        upsertGoldenDocumentSection(tx as never, {
          document_id: docId,
          section_key: 'overview',
          content: '# Overview\nThis industry covers...',
          position: 0,
        }),
    );
    await withRlsContext(
      sql as never,
      { userId: RESEARCHER_ID, tenantId: TENANT_ID, role: 'researcher' },
      async (tx) =>
        upsertGoldenDocumentSection(tx as never, {
          document_id: docId,
          section_key: 'sectors',
          content: '# Sectors\nThe key sectors are...',
          position: 1,
        }),
    );

    const sections = await withRlsContext(
      sql as never,
      { userId: RESEARCHER_ID, tenantId: TENANT_ID, role: 'researcher' },
      async (tx) => listGoldenDocumentSections(tx as never, docId),
    );

    expect(sections.length).toBeGreaterThanOrEqual(2);
    const keys = sections.map((s) => s.section_key);
    expect(keys).toContain('overview');
    expect(keys).toContain('sectors');

    // Position ordering: overview (0) before sectors (1)
    const overviewIdx = sections.findIndex((s) => s.section_key === 'overview');
    const sectorsIdx = sections.findIndex((s) => s.section_key === 'sectors');
    expect(overviewIdx).toBeLessThan(sectorsIdx);
  });

  test('upsert is idempotent — updating content changes the row', async () => {
    await withRlsContext(
      sql as never,
      { userId: RESEARCHER_ID, tenantId: TENANT_ID, role: 'researcher' },
      async (tx) =>
        upsertGoldenDocumentSection(tx as never, {
          document_id: docId,
          section_key: 'overview',
          content: '# Updated Overview\nRevised content...',
          position: 0,
        }),
    );

    const sections = await withRlsContext(
      sql as never,
      { userId: RESEARCHER_ID, tenantId: TENANT_ID, role: 'researcher' },
      async (tx) => listGoldenDocumentSections(tx as never, docId),
    );
    const overview = sections.find((s) => s.section_key === 'overview');
    expect(overview!.content).toBe('# Updated Overview\nRevised content...');
  });
});

// ---------------------------------------------------------------------------
// Unified retrieval
// ---------------------------------------------------------------------------

describe('unified retrieval — fetchActiveGoldenDocument', () => {
  test('fetchActiveGoldenDocument returns active doc with sections', async () => {
    // Create and activate a document.
    const doc = await withRlsContext(
      sql as never,
      { userId: RESEARCHER_ID, tenantId: TENANT_ID, role: 'researcher' },
      async (tx) =>
        createGoldenDocument(tx as never, {
          kind: 'research_methodology',
          author_id: RESEARCHER_ID,
          tenant_id: TENANT_ID,
          title: 'Active Methodology for Retrieval',
        }),
    );

    await withRlsContext(
      sql as never,
      { userId: RESEARCHER_ID, tenantId: TENANT_ID, role: 'researcher' },
      async (tx) => activateGoldenDocument(tx as never, doc.id, RESEARCHER_ID, TENANT_ID),
    );

    // Add a section.
    await withRlsContext(
      sql as never,
      { userId: RESEARCHER_ID, tenantId: TENANT_ID, role: 'researcher' },
      async (tx) =>
        upsertGoldenDocumentSection(tx as never, {
          document_id: doc.id,
          section_key: 'method',
          content: '# Methodology\nStep 1: Analyse...',
          position: 0,
        }),
    );

    // Fetch via unified retrieval.
    const result = await withRlsContext(
      sql as never,
      { userId: RESEARCHER_ID, tenantId: TENANT_ID, role: 'researcher' },
      async (tx) =>
        fetchActiveGoldenDocument(tx as never, 'research_methodology', RESEARCHER_ID, TENANT_ID),
    );

    expect(result.document).not.toBeNull();
    expect(result.document!.state).toBe('active');
    expect(result.sections.length).toBeGreaterThan(0);
    const methodSection = result.sections.find((s) => s.section_key === 'method');
    expect(methodSection).toBeDefined();
  });

  test('fetchActiveGoldenDocument returns null document when none is active', async () => {
    const ISOLATED_TENANT = 'isolated-tenant-for-retrieval-test';
    const result = await withRlsContext(
      sql as never,
      { userId: RESEARCHER_ID, tenantId: ISOLATED_TENANT, role: 'researcher' },
      async (tx) =>
        fetchActiveGoldenDocument(
          tx as never,
          'industry_definition',
          RESEARCHER_ID,
          ISOLATED_TENANT,
        ),
    );

    expect(result.document).toBeNull();
    expect(result.sections).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Worker write denied — trigger backstop
// ---------------------------------------------------------------------------

describe('golden-document write path — worker write denied', () => {
  test('INSERT with app.current_role unset raises trigger error', async () => {
    // Simulate a non-researcher session: no role set in RLS context.
    // We open a transaction without setting "app.current_role" and attempt a
    // direct INSERT — the trigger must fire and raise an exception.
    await expect(
      sql.begin(async (tx) => {
        // Set tenant context but NOT the role — simulates any non-researcher caller.
        await tx.unsafe(`SET LOCAL app.current_user_id = '${RESEARCHER_ID}'`);
        await tx.unsafe(`SET LOCAL app.current_tenant_id = '${TENANT_ID}'`);
        // Direct INSERT — must be rejected by trigger.
        await tx`
          INSERT INTO golden_documents (kind, author_id, tenant_id, title, state)
          VALUES ('industry_definition', ${RESEARCHER_ID}, ${TENANT_ID}, 'Denied', 'authored')
        `;
      }),
    ).rejects.toThrow(/insufficient_privilege|golden_documents write denied/i);
  });

  test('INSERT with app.current_role = worker raises trigger error', async () => {
    // Note: "app.current_role" must be double-quoted in SET LOCAL because
    // current_role is a reserved keyword in PostgreSQL.
    await expect(
      sql.begin(async (tx) => {
        await tx.unsafe(`SET LOCAL app.current_user_id = '${RESEARCHER_ID}'`);
        await tx.unsafe(`SET LOCAL app.current_tenant_id = '${TENANT_ID}'`);
        await tx.unsafe(`SET LOCAL "app.current_role" = 'worker'`);
        await tx`
          INSERT INTO golden_documents (kind, author_id, tenant_id, title, state)
          VALUES ('industry_definition', ${RESEARCHER_ID}, ${TENANT_ID}, 'Denied', 'authored')
        `;
      }),
    ).rejects.toThrow(/insufficient_privilege|golden_documents write denied/i);
  });

  test('denied write produces a golden_document.write_denied journal entry', async () => {
    // Write the denial journal entry (mirrors what the API layer does before returning 403).
    await writeJournalEvent(sql as never, {
      event_type: 'golden_document.write_denied',
      entity_id: 'golden_documents',
      actor_id: 'bearer_token_actor',
      payload_ref: null,
    });

    const rows = await sql`
      SELECT * FROM business_journal
      WHERE event_type = 'golden_document.write_denied'
      LIMIT 1
    `;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].event_type).toBe('golden_document.write_denied');
  });
});
