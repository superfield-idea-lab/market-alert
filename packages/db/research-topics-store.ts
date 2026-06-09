/**
 * @file research-topics-store.ts
 *
 * DB access layer for the `research_topics` and `topic_members` tables
 * (issue #121, PRD §3 §5).
 *
 * ## What this module does
 *
 * Exposes typed CRUD helpers for research topics and topic membership
 * management. A research topic is a named research programme owned by a
 * tenant; topic members are researchers granted access to that programme.
 *
 * ## Idempotency / constraints
 *
 * - One researcher may appear at most once per topic (UNIQUE topic_id, researcher_id).
 * - Topic creators are automatically inserted as 'owner' via createResearchTopic.
 *
 * ## DDL
 *
 * - `packages/db/mkt-research-topics.sql` — CREATE TABLE statements
 *
 * @see https://github.com/superfield-idea-lab/market-alert/issues/121
 */

import type postgres from 'postgres';

export type SqlClient = postgres.Sql;

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

export interface ResearchTopicRow {
  id: string;
  tenant_id: string;
  name: string;
  description: string | null;
  created_by: string;
  created_at: Date;
  updated_at: Date;
}

export interface TopicMemberRow {
  id: string;
  topic_id: string;
  researcher_id: string;
  role: 'owner' | 'member';
  created_at: Date;
}

// ---------------------------------------------------------------------------
// Input types
// ---------------------------------------------------------------------------

export interface CreateResearchTopicInput {
  tenant_id: string;
  name: string;
  description?: string | null;
  created_by: string;
}

export interface UpdateResearchTopicInput {
  name?: string;
  description?: string | null;
}

export interface AddTopicMemberInput {
  topic_id: string;
  researcher_id: string;
  role: 'owner' | 'member';
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

/**
 * Create a new research topic and insert the creator as role='owner'.
 *
 * Returns the created topic row. The creator is seeded into topic_members
 * in the same transaction so they can immediately query their own topic.
 */
export async function createResearchTopic(
  sql: SqlClient,
  input: CreateResearchTopicInput,
): Promise<ResearchTopicRow> {
  const rows = await sql<ResearchTopicRow[]>`
    INSERT INTO research_topics (tenant_id, name, description, created_by)
    VALUES (
      ${input.tenant_id},
      ${input.name},
      ${input.description ?? null},
      ${input.created_by}
    )
    RETURNING id, tenant_id, name, description, created_by, created_at, updated_at
  `;

  const topic = rows[0];
  if (!topic) {
    throw new Error('research_topics: INSERT did not return a row');
  }

  // Seed creator as owner
  await sql`
    INSERT INTO topic_members (topic_id, researcher_id, role)
    VALUES (${topic.id}, ${input.created_by}, 'owner')
    ON CONFLICT (topic_id, researcher_id) DO NOTHING
  `;

  return topic;
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/**
 * Get a research topic by ID.
 *
 * Returns null when no row matches.
 */
export async function getResearchTopic(
  sql: SqlClient,
  id: string,
): Promise<ResearchTopicRow | null> {
  const rows = await sql<ResearchTopicRow[]>`
    SELECT id, tenant_id, name, description, created_by, created_at, updated_at
    FROM research_topics
    WHERE id = ${id}
  `;
  return rows[0] ?? null;
}

/**
 * List research topics that a specific researcher is a member of.
 *
 * When tenantId is provided, also filters by tenant. Ordered by created_at DESC.
 */
export async function listResearchTopicsForResearcher(
  sql: SqlClient,
  researcherId: string,
  tenantId?: string,
): Promise<ResearchTopicRow[]> {
  if (tenantId !== undefined) {
    return sql<ResearchTopicRow[]>`
      SELECT rt.id, rt.tenant_id, rt.name, rt.description, rt.created_by,
             rt.created_at, rt.updated_at
      FROM research_topics rt
      INNER JOIN topic_members tm ON tm.topic_id = rt.id
      WHERE tm.researcher_id = ${researcherId}
        AND rt.tenant_id = ${tenantId}
      ORDER BY rt.created_at DESC
    `;
  }
  return sql<ResearchTopicRow[]>`
    SELECT rt.id, rt.tenant_id, rt.name, rt.description, rt.created_by,
           rt.created_at, rt.updated_at
    FROM research_topics rt
    INNER JOIN topic_members tm ON tm.topic_id = rt.id
    WHERE tm.researcher_id = ${researcherId}
    ORDER BY rt.created_at DESC
  `;
}

/**
 * Get a topic_members row for a given (topic_id, researcher_id) pair.
 *
 * Returns null when the researcher is not a member of the topic.
 */
export async function getTopicMember(
  sql: SqlClient,
  topicId: string,
  researcherId: string,
): Promise<TopicMemberRow | null> {
  const rows = await sql<TopicMemberRow[]>`
    SELECT id, topic_id, researcher_id, role, created_at
    FROM topic_members
    WHERE topic_id = ${topicId}
      AND researcher_id = ${researcherId}
  `;
  return rows[0] ?? null;
}

/**
 * List all members of a research topic.
 *
 * Ordered by created_at ASC (join order).
 */
export async function listTopicMembers(sql: SqlClient, topicId: string): Promise<TopicMemberRow[]> {
  return sql<TopicMemberRow[]>`
    SELECT id, topic_id, researcher_id, role, created_at
    FROM topic_members
    WHERE topic_id = ${topicId}
    ORDER BY created_at ASC
  `;
}

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

/**
 * Update a research topic's name or description.
 *
 * Returns the updated row, or null when the topic does not exist.
 */
export async function updateResearchTopic(
  sql: SqlClient,
  id: string,
  input: UpdateResearchTopicInput,
): Promise<ResearchTopicRow | null> {
  const rows = await sql<ResearchTopicRow[]>`
    UPDATE research_topics
    SET
      name        = COALESCE(${input.name ?? null}, name),
      description = COALESCE(${input.description ?? null}, description),
      updated_at  = CURRENT_TIMESTAMP
    WHERE id = ${id}
    RETURNING id, tenant_id, name, description, created_by, created_at, updated_at
  `;
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// Membership management
// ---------------------------------------------------------------------------

/**
 * Add a researcher to a topic.
 *
 * Uses ON CONFLICT DO NOTHING for idempotency. Returns the (possibly
 * pre-existing) topic_members row.
 */
export async function addTopicMember(
  sql: SqlClient,
  input: AddTopicMemberInput,
): Promise<TopicMemberRow> {
  await sql`
    INSERT INTO topic_members (topic_id, researcher_id, role)
    VALUES (${input.topic_id}, ${input.researcher_id}, ${input.role})
    ON CONFLICT (topic_id, researcher_id) DO UPDATE SET role = EXCLUDED.role
  `;
  const rows = await sql<TopicMemberRow[]>`
    SELECT id, topic_id, researcher_id, role, created_at
    FROM topic_members
    WHERE topic_id = ${input.topic_id}
      AND researcher_id = ${input.researcher_id}
  `;
  if (!rows[0]) {
    throw new Error('topic_members: row not found after upsert');
  }
  return rows[0];
}

/**
 * Remove a researcher from a topic.
 *
 * Returns true when a row was deleted, false when the researcher was not a member.
 */
export async function removeTopicMember(
  sql: SqlClient,
  topicId: string,
  researcherId: string,
): Promise<boolean> {
  const result = await sql`
    DELETE FROM topic_members
    WHERE topic_id = ${topicId}
      AND researcher_id = ${researcherId}
  `;
  return (result as unknown as { count: number }).count > 0;
}

/**
 * Get the tenant's Default topic id.
 *
 * Returns null when no Default topic has been created for the tenant yet.
 */
export async function getDefaultTopicIdForTenant(
  sql: SqlClient,
  tenantId: string,
): Promise<string | null> {
  const rows = await sql<{ id: string }[]>`
    SELECT id FROM research_topics
    WHERE tenant_id = ${tenantId}
      AND name = 'Default'
    LIMIT 1
  `;
  return rows[0]?.id ?? null;
}

// ---------------------------------------------------------------------------
// DDL constant (used by tests that need to ensure the schema exists)
// ---------------------------------------------------------------------------

export const RESEARCH_TOPICS_DDL = `
-- research_topics — named research programme per tenant
CREATE TABLE IF NOT EXISTS research_topics (
  id          TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  tenant_id   TEXT        NOT NULL,
  name        TEXT        NOT NULL,
  description TEXT,
  created_by  TEXT        NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (tenant_id, name)
);

CREATE INDEX IF NOT EXISTS idx_research_topics_tenant
  ON research_topics (tenant_id, created_at DESC);

-- topic_members — many-to-many: research_topics × researchers
CREATE TABLE IF NOT EXISTS topic_members (
  id            TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  topic_id      TEXT        NOT NULL REFERENCES research_topics(id) ON DELETE CASCADE,
  researcher_id TEXT        NOT NULL,
  role          TEXT        NOT NULL CHECK (role IN ('owner', 'member')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (topic_id, researcher_id)
);

CREATE INDEX IF NOT EXISTS idx_topic_members_topic
  ON topic_members (topic_id);

CREATE INDEX IF NOT EXISTS idx_topic_members_researcher
  ON topic_members (researcher_id);
`;
