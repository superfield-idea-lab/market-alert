/**
 * Integration tests for the annotation state machine (issue #64, PRD §4.4).
 *
 * All tests run against a real ephemeral Postgres container — no mocks.
 *
 * Test plan coverage:
 *   - Drive an annotation through every legal transition and assert success.
 *   - Attempt illegal transitions and assert rejection with
 *     IllegalAnnotationTransitionError.
 *   - Verify that every transition emits an audit event on the audit database.
 *   - Cover AUTO_RESOLVED, DISMISSED, and REOPENED transitions explicitly.
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import postgres from 'postgres';
import { startPostgres, type PgContainer } from './pg-container';
import { runInitRemote } from './init-remote';
import { migrate } from './index';
import {
  AnnotationState,
  LEGAL_TRANSITIONS,
  TERMINAL_STATES,
  IllegalAnnotationTransitionError,
  initAnnotationState,
  getAnnotationState,
  transitionAnnotation,
  getAnnotationHistory,
  migrateAnnotationSchema,
} from './annotation-state-machine';

// ---------------------------------------------------------------------------
// Container + pool setup
// ---------------------------------------------------------------------------

let pg: PgContainer;
let sql: ReturnType<typeof postgres>;
let auditSql: ReturnType<typeof postgres>;

const GENESIS_HASH = '0000000000000000000000000000000000000000000000000000000000000000';

const TEST_PASSWORDS = {
  app: 'app_test_pw',
  audit: 'audit_test_pw',
  analytics: 'analytics_test_pw',
  dictionary: 'dict_test_pw',
  coding: 'coding_test_pw',
  analysis: 'analysis_test_pw',
  code_cleanup: 'code_cleanup_test_pw',
  email_ingest: 'email_ingest_test_pw',
};

function makeRoleUrl(adminUrl: string, db: string, role: string, password: string): string {
  const u = new URL(adminUrl);
  u.username = role;
  u.password = password;
  u.pathname = `/${db}`;
  return u.toString();
}

beforeAll(async () => {
  pg = await startPostgres();

  await runInitRemote({
    ADMIN_DATABASE_URL: pg.url,
    APP_RW_PASSWORD: TEST_PASSWORDS.app,
    AUDIT_W_PASSWORD: TEST_PASSWORDS.audit,
    ANALYTICS_W_PASSWORD: TEST_PASSWORDS.analytics,
    DICT_RW_PASSWORD: TEST_PASSWORDS.dictionary,
    AGENT_CODING_PASSWORD: TEST_PASSWORDS.coding,
    AGENT_ANALYSIS_PASSWORD: TEST_PASSWORDS.analysis,
    AGENT_CODE_CLEANUP_PASSWORD: TEST_PASSWORDS.code_cleanup,
    AGENT_EMAIL_INGEST_PASSWORD: TEST_PASSWORDS.email_ingest,
  } as NodeJS.ProcessEnv);

  const appUrl = makeRoleUrl(pg.url, 'calypso_app', 'app_rw', TEST_PASSWORDS.app);
  const auditUrl = makeRoleUrl(pg.url, 'calypso_audit', 'audit_w', TEST_PASSWORDS.audit);

  sql = postgres(appUrl, { max: 3 });
  auditSql = postgres(auditUrl, { max: 3 });

  await migrate({ databaseUrl: appUrl });
  await migrateAnnotationSchema(sql);
}, 120_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 });
  await auditSql?.end({ timeout: 5 });
  await pg?.stop();
});

// ---------------------------------------------------------------------------
// Helper — unique annotation IDs per test
// ---------------------------------------------------------------------------

let counter = 0;
function annotationId(): string {
  return `ann-test-${Date.now()}-${++counter}`;
}

const SYSTEM_ACTOR = 'system:agent';
const RM_ACTOR = 'user:rm-001';

// ---------------------------------------------------------------------------
// AnnotationState enum completeness
// ---------------------------------------------------------------------------

describe('AnnotationState enum', () => {
  test('contains all PRD §4.4 states', () => {
    expect(Object.keys(AnnotationState).sort()).toEqual(
      [
        'AGENT_RESPONDING',
        'ANNOTATION_OPEN',
        'AUTO_RESOLVED',
        'CORRECTION_APPLIED',
        'DISCUSSION',
        'DISMISSED',
        'REOPENED',
      ].sort(),
    );
  });
});

// ---------------------------------------------------------------------------
// LEGAL_TRANSITIONS map
// ---------------------------------------------------------------------------

describe('LEGAL_TRANSITIONS', () => {
  test('every state has an entry', () => {
    for (const state of Object.values(AnnotationState)) {
      expect(LEGAL_TRANSITIONS[state]).toBeDefined();
    }
  });

  test('ANNOTATION_OPEN → AGENT_RESPONDING only', () => {
    expect(LEGAL_TRANSITIONS[AnnotationState.ANNOTATION_OPEN]).toEqual([
      AnnotationState.AGENT_RESPONDING,
    ]);
  });

  test('AGENT_RESPONDING can go to DISCUSSION, CORRECTION_APPLIED, or AUTO_RESOLVED', () => {
    const targets = LEGAL_TRANSITIONS[AnnotationState.AGENT_RESPONDING];
    expect(targets).toContain(AnnotationState.DISCUSSION);
    expect(targets).toContain(AnnotationState.CORRECTION_APPLIED);
    expect(targets).toContain(AnnotationState.AUTO_RESOLVED);
  });

  test('DISCUSSION can go to AGENT_RESPONDING, CORRECTION_APPLIED, or DISMISSED', () => {
    const targets = LEGAL_TRANSITIONS[AnnotationState.DISCUSSION];
    expect(targets).toContain(AnnotationState.AGENT_RESPONDING);
    expect(targets).toContain(AnnotationState.CORRECTION_APPLIED);
    expect(targets).toContain(AnnotationState.DISMISSED);
  });

  test('CORRECTION_APPLIED → REOPENED only', () => {
    expect(LEGAL_TRANSITIONS[AnnotationState.CORRECTION_APPLIED]).toEqual([
      AnnotationState.REOPENED,
    ]);
  });

  test('DISMISSED has no outgoing transitions (terminal state)', () => {
    expect(LEGAL_TRANSITIONS[AnnotationState.DISMISSED]).toEqual([]);
  });

  test('AUTO_RESOLVED has no outgoing transitions (terminal state)', () => {
    expect(LEGAL_TRANSITIONS[AnnotationState.AUTO_RESOLVED]).toEqual([]);
  });

  test('REOPENED can go to AGENT_RESPONDING or DISCUSSION', () => {
    const targets = LEGAL_TRANSITIONS[AnnotationState.REOPENED];
    expect(targets).toContain(AnnotationState.AGENT_RESPONDING);
    expect(targets).toContain(AnnotationState.DISCUSSION);
  });
});

// ---------------------------------------------------------------------------
// TERMINAL_STATES set
// ---------------------------------------------------------------------------

describe('TERMINAL_STATES', () => {
  test('DISMISSED and AUTO_RESOLVED are terminal', () => {
    expect(TERMINAL_STATES.has(AnnotationState.DISMISSED)).toBe(true);
    expect(TERMINAL_STATES.has(AnnotationState.AUTO_RESOLVED)).toBe(true);
  });

  test('non-terminal states are not in TERMINAL_STATES', () => {
    expect(TERMINAL_STATES.has(AnnotationState.ANNOTATION_OPEN)).toBe(false);
    expect(TERMINAL_STATES.has(AnnotationState.AGENT_RESPONDING)).toBe(false);
    expect(TERMINAL_STATES.has(AnnotationState.DISCUSSION)).toBe(false);
    expect(TERMINAL_STATES.has(AnnotationState.CORRECTION_APPLIED)).toBe(false);
    expect(TERMINAL_STATES.has(AnnotationState.REOPENED)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// initAnnotationState
// ---------------------------------------------------------------------------

describe('initAnnotationState', () => {
  test('creates state row with ANNOTATION_OPEN', async () => {
    const id = annotationId();
    const result = await initAnnotationState(sql, id, RM_ACTOR);
    expect(result.newState).toBe(AnnotationState.ANNOTATION_OPEN);
    expect(result.transitionRow.annotation_id).toBe(id);
    expect(result.transitionRow.from_state).toBeNull();
    expect(result.transitionRow.to_state).toBe(AnnotationState.ANNOTATION_OPEN);
    expect(result.transitionRow.actor_id).toBe(RM_ACTOR);
    expect(result.transitionRow.transitioned_at).toBeInstanceOf(Date);
  });

  test('records a reason when provided', async () => {
    const id = annotationId();
    const result = await initAnnotationState(sql, id, RM_ACTOR, {
      reason: 'RM opened annotation on paragraph 3',
    });
    expect(result.transitionRow.reason).toBe('RM opened annotation on paragraph 3');
  });

  test('getAnnotationState returns ANNOTATION_OPEN after init', async () => {
    const id = annotationId();
    await initAnnotationState(sql, id, RM_ACTOR);
    const row = await getAnnotationState(sql, id);
    expect(row).not.toBeNull();
    expect(row!.state).toBe(AnnotationState.ANNOTATION_OPEN);
  });

  test('getAnnotationState returns null for unknown annotation', async () => {
    const row = await getAnnotationState(sql, 'nonexistent-annotation-id');
    expect(row).toBeNull();
  });

  test('emits an audit event when auditSql provided', async () => {
    const id = annotationId();
    await initAnnotationState(sql, id, RM_ACTOR, {
      auditSql,
      genesisHash: GENESIS_HASH,
      reason: 'opened by RM',
    });

    const [auditRow] = await auditSql<{ entity_id: string; action: string; after: unknown }[]>`
      SELECT entity_id, action, after
      FROM audit_events
      WHERE entity_type = 'wiki_annotation'
        AND entity_id    = ${id}
      ORDER BY ts DESC
      LIMIT 1
    `;

    expect(auditRow).toBeDefined();
    expect(auditRow.entity_id).toBe(id);
    expect(auditRow.action).toBe('annotation.transition');
    expect((auditRow.after as Record<string, unknown>).state).toBe(AnnotationState.ANNOTATION_OPEN);
  });
});

// ---------------------------------------------------------------------------
// Legal forward path: ANNOTATION_OPEN → AGENT_RESPONDING → CORRECTION_APPLIED
// ---------------------------------------------------------------------------

describe('forward path to CORRECTION_APPLIED', () => {
  test('drives annotation through the primary correction path', async () => {
    const id = annotationId();
    await initAnnotationState(sql, id, RM_ACTOR, { reason: 'passage incorrect' });

    const r1 = await transitionAnnotation(sql, {
      annotationId: id,
      toState: AnnotationState.AGENT_RESPONDING,
      actorId: SYSTEM_ACTOR,
      reason: 'agent picked up thread',
    });
    expect(r1.newState).toBe(AnnotationState.AGENT_RESPONDING);
    expect(r1.transitionRow.from_state).toBe(AnnotationState.ANNOTATION_OPEN);
    expect(r1.transitionRow.actor_id).toBe(SYSTEM_ACTOR);
    expect(r1.transitionRow.transitioned_at).toBeInstanceOf(Date);

    const r2 = await transitionAnnotation(sql, {
      annotationId: id,
      toState: AnnotationState.CORRECTION_APPLIED,
      actorId: SYSTEM_ACTOR,
      reason: 'new WikiPageVersion written',
    });
    expect(r2.newState).toBe(AnnotationState.CORRECTION_APPLIED);
    expect(r2.transitionRow.from_state).toBe(AnnotationState.AGENT_RESPONDING);

    const finalRow = await getAnnotationState(sql, id);
    expect(finalRow!.state).toBe(AnnotationState.CORRECTION_APPLIED);
  });
});

// ---------------------------------------------------------------------------
// AUTO_RESOLVED transition
// ---------------------------------------------------------------------------

describe('AUTO_RESOLVED transition', () => {
  test('AGENT_RESPONDING → AUTO_RESOLVED is legal', async () => {
    const id = annotationId();
    await initAnnotationState(sql, id, RM_ACTOR);

    await transitionAnnotation(sql, {
      annotationId: id,
      toState: AnnotationState.AGENT_RESPONDING,
      actorId: SYSTEM_ACTOR,
    });

    const r = await transitionAnnotation(sql, {
      annotationId: id,
      toState: AnnotationState.AUTO_RESOLVED,
      actorId: SYSTEM_ACTOR,
      reason: 'agent confident — issue already satisfied by latest wiki version',
    });

    expect(r.newState).toBe(AnnotationState.AUTO_RESOLVED);
    expect(r.transitionRow.from_state).toBe(AnnotationState.AGENT_RESPONDING);
    expect(r.transitionRow.reason).toContain('agent confident');
  });

  test('AUTO_RESOLVED is a terminal state — no further transitions', async () => {
    const id = annotationId();
    await initAnnotationState(sql, id, RM_ACTOR);
    await transitionAnnotation(sql, {
      annotationId: id,
      toState: AnnotationState.AGENT_RESPONDING,
      actorId: SYSTEM_ACTOR,
    });
    await transitionAnnotation(sql, {
      annotationId: id,
      toState: AnnotationState.AUTO_RESOLVED,
      actorId: SYSTEM_ACTOR,
    });

    await expect(
      transitionAnnotation(sql, {
        annotationId: id,
        toState: AnnotationState.DISCUSSION,
        actorId: RM_ACTOR,
      }),
    ).rejects.toThrow(IllegalAnnotationTransitionError);
  });
});

// ---------------------------------------------------------------------------
// DISMISSED transition
// ---------------------------------------------------------------------------

describe('DISMISSED transition', () => {
  test('DISCUSSION → DISMISSED is legal', async () => {
    const id = annotationId();
    await initAnnotationState(sql, id, RM_ACTOR);

    await transitionAnnotation(sql, {
      annotationId: id,
      toState: AnnotationState.AGENT_RESPONDING,
      actorId: SYSTEM_ACTOR,
    });
    await transitionAnnotation(sql, {
      annotationId: id,
      toState: AnnotationState.DISCUSSION,
      actorId: RM_ACTOR,
      reason: 'RM replied',
    });

    const r = await transitionAnnotation(sql, {
      annotationId: id,
      toState: AnnotationState.DISMISSED,
      actorId: RM_ACTOR,
      reason: 'RM dismissed — no change needed',
    });

    expect(r.newState).toBe(AnnotationState.DISMISSED);
    expect(r.transitionRow.from_state).toBe(AnnotationState.DISCUSSION);
    expect(r.transitionRow.reason).toContain('dismissed');
  });

  test('DISMISSED is a terminal state — no further transitions', async () => {
    const id = annotationId();
    await initAnnotationState(sql, id, RM_ACTOR);
    await transitionAnnotation(sql, {
      annotationId: id,
      toState: AnnotationState.AGENT_RESPONDING,
      actorId: SYSTEM_ACTOR,
    });
    await transitionAnnotation(sql, {
      annotationId: id,
      toState: AnnotationState.DISCUSSION,
      actorId: RM_ACTOR,
    });
    await transitionAnnotation(sql, {
      annotationId: id,
      toState: AnnotationState.DISMISSED,
      actorId: RM_ACTOR,
    });

    await expect(
      transitionAnnotation(sql, {
        annotationId: id,
        toState: AnnotationState.ANNOTATION_OPEN,
        actorId: RM_ACTOR,
      }),
    ).rejects.toThrow(IllegalAnnotationTransitionError);
  });
});

// ---------------------------------------------------------------------------
// REOPENED transition
// ---------------------------------------------------------------------------

describe('REOPENED transition', () => {
  test('CORRECTION_APPLIED → REOPENED is legal', async () => {
    const id = annotationId();
    await initAnnotationState(sql, id, RM_ACTOR);

    await transitionAnnotation(sql, {
      annotationId: id,
      toState: AnnotationState.AGENT_RESPONDING,
      actorId: SYSTEM_ACTOR,
    });
    await transitionAnnotation(sql, {
      annotationId: id,
      toState: AnnotationState.CORRECTION_APPLIED,
      actorId: SYSTEM_ACTOR,
    });

    const r = await transitionAnnotation(sql, {
      annotationId: id,
      toState: AnnotationState.REOPENED,
      actorId: RM_ACTOR,
      reason: 'correction introduced a new error',
    });

    expect(r.newState).toBe(AnnotationState.REOPENED);
    expect(r.transitionRow.from_state).toBe(AnnotationState.CORRECTION_APPLIED);
  });

  test('REOPENED → AGENT_RESPONDING continues the thread', async () => {
    const id = annotationId();
    await initAnnotationState(sql, id, RM_ACTOR);
    await transitionAnnotation(sql, {
      annotationId: id,
      toState: AnnotationState.AGENT_RESPONDING,
      actorId: SYSTEM_ACTOR,
    });
    await transitionAnnotation(sql, {
      annotationId: id,
      toState: AnnotationState.CORRECTION_APPLIED,
      actorId: SYSTEM_ACTOR,
    });
    await transitionAnnotation(sql, {
      annotationId: id,
      toState: AnnotationState.REOPENED,
      actorId: RM_ACTOR,
    });

    const r = await transitionAnnotation(sql, {
      annotationId: id,
      toState: AnnotationState.AGENT_RESPONDING,
      actorId: SYSTEM_ACTOR,
      reason: 'agent picked up reopened thread',
    });

    expect(r.newState).toBe(AnnotationState.AGENT_RESPONDING);
    expect(r.transitionRow.from_state).toBe(AnnotationState.REOPENED);
  });
});

// ---------------------------------------------------------------------------
// DISCUSSION cycle
// ---------------------------------------------------------------------------

describe('DISCUSSION cycle', () => {
  test('drives annotation through DISCUSSION back-and-forth then CORRECTION_APPLIED', async () => {
    const id = annotationId();
    await initAnnotationState(sql, id, RM_ACTOR, { reason: 'wrong date mentioned' });

    await transitionAnnotation(sql, {
      annotationId: id,
      toState: AnnotationState.AGENT_RESPONDING,
      actorId: SYSTEM_ACTOR,
    });
    await transitionAnnotation(sql, {
      annotationId: id,
      toState: AnnotationState.DISCUSSION,
      actorId: RM_ACTOR,
      reason: 'RM replied with more context',
    });
    await transitionAnnotation(sql, {
      annotationId: id,
      toState: AnnotationState.AGENT_RESPONDING,
      actorId: SYSTEM_ACTOR,
      reason: 'agent responding again',
    });
    await transitionAnnotation(sql, {
      annotationId: id,
      toState: AnnotationState.CORRECTION_APPLIED,
      actorId: SYSTEM_ACTOR,
      reason: 'new version written',
    });

    const row = await getAnnotationState(sql, id);
    expect(row!.state).toBe(AnnotationState.CORRECTION_APPLIED);

    const history = await getAnnotationHistory(sql, id);
    const toStates = history.map((r) => r.to_state);
    expect(toStates).toEqual([
      AnnotationState.ANNOTATION_OPEN,
      AnnotationState.AGENT_RESPONDING,
      AnnotationState.DISCUSSION,
      AnnotationState.AGENT_RESPONDING,
      AnnotationState.CORRECTION_APPLIED,
    ]);
  });
});

// ---------------------------------------------------------------------------
// Audit events per transition
// ---------------------------------------------------------------------------

describe('audit events', () => {
  test('every transition emits an audit event on the audit database', async () => {
    const id = annotationId();

    await initAnnotationState(sql, id, RM_ACTOR, {
      auditSql,
      genesisHash: GENESIS_HASH,
    });
    await transitionAnnotation(
      sql,
      { annotationId: id, toState: AnnotationState.AGENT_RESPONDING, actorId: SYSTEM_ACTOR },
      { auditSql, genesisHash: GENESIS_HASH },
    );
    await transitionAnnotation(
      sql,
      { annotationId: id, toState: AnnotationState.AUTO_RESOLVED, actorId: SYSTEM_ACTOR },
      { auditSql, genesisHash: GENESIS_HASH },
    );

    const rows = await auditSql<{ action: string; before: unknown; after: unknown }[]>`
      SELECT action, before, after
      FROM audit_events
      WHERE entity_type = 'wiki_annotation'
        AND entity_id    = ${id}
      ORDER BY ts ASC
    `;

    expect(rows).toHaveLength(3);
    expect(rows[0].before).toBeNull();
    expect((rows[0].after as Record<string, unknown>).state).toBe(AnnotationState.ANNOTATION_OPEN);
    expect((rows[1].before as Record<string, unknown>).state).toBe(AnnotationState.ANNOTATION_OPEN);
    expect((rows[1].after as Record<string, unknown>).state).toBe(AnnotationState.AGENT_RESPONDING);
    expect((rows[2].before as Record<string, unknown>).state).toBe(
      AnnotationState.AGENT_RESPONDING,
    );
    expect((rows[2].after as Record<string, unknown>).state).toBe(AnnotationState.AUTO_RESOLVED);
  });

  test('audit events form a hash chain', async () => {
    const id = annotationId();

    await initAnnotationState(sql, id, RM_ACTOR, {
      auditSql,
      genesisHash: GENESIS_HASH,
    });
    await transitionAnnotation(
      sql,
      { annotationId: id, toState: AnnotationState.AGENT_RESPONDING, actorId: SYSTEM_ACTOR },
      { auditSql, genesisHash: GENESIS_HASH },
    );

    const rows = await auditSql<{ prev_hash: string; hash: string }[]>`
      SELECT prev_hash, hash
      FROM audit_events
      WHERE entity_type = 'wiki_annotation'
        AND entity_id    = ${id}
      ORDER BY ts ASC
    `;

    expect(rows).toHaveLength(2);
    // Second row's prev_hash must equal first row's hash
    expect(rows[1].prev_hash).toBe(rows[0].hash);
  });
});

// ---------------------------------------------------------------------------
// Illegal transition rejection
// ---------------------------------------------------------------------------

describe('illegal transitions are rejected', () => {
  test('ANNOTATION_OPEN → DISCUSSION is illegal', async () => {
    const id = annotationId();
    await initAnnotationState(sql, id, RM_ACTOR);

    await expect(
      transitionAnnotation(sql, {
        annotationId: id,
        toState: AnnotationState.DISCUSSION,
        actorId: RM_ACTOR,
      }),
    ).rejects.toThrow(IllegalAnnotationTransitionError);
  });

  test('ANNOTATION_OPEN → CORRECTION_APPLIED is illegal', async () => {
    const id = annotationId();
    await initAnnotationState(sql, id, RM_ACTOR);

    await expect(
      transitionAnnotation(sql, {
        annotationId: id,
        toState: AnnotationState.CORRECTION_APPLIED,
        actorId: SYSTEM_ACTOR,
      }),
    ).rejects.toThrow(IllegalAnnotationTransitionError);
  });

  test('ANNOTATION_OPEN → DISMISSED is illegal', async () => {
    const id = annotationId();
    await initAnnotationState(sql, id, RM_ACTOR);

    await expect(
      transitionAnnotation(sql, {
        annotationId: id,
        toState: AnnotationState.DISMISSED,
        actorId: RM_ACTOR,
      }),
    ).rejects.toThrow(IllegalAnnotationTransitionError);
  });

  test('ANNOTATION_OPEN → AUTO_RESOLVED is illegal', async () => {
    const id = annotationId();
    await initAnnotationState(sql, id, RM_ACTOR);

    await expect(
      transitionAnnotation(sql, {
        annotationId: id,
        toState: AnnotationState.AUTO_RESOLVED,
        actorId: SYSTEM_ACTOR,
      }),
    ).rejects.toThrow(IllegalAnnotationTransitionError);
  });

  test('IllegalAnnotationTransitionError carries from/to fields', async () => {
    const id = annotationId();
    await initAnnotationState(sql, id, RM_ACTOR);

    let caught: unknown;
    try {
      await transitionAnnotation(sql, {
        annotationId: id,
        toState: AnnotationState.DISMISSED,
        actorId: RM_ACTOR,
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(IllegalAnnotationTransitionError);
    const err = caught as IllegalAnnotationTransitionError;
    expect(err.from).toBe(AnnotationState.ANNOTATION_OPEN);
    expect(err.to).toBe(AnnotationState.DISMISSED);
    expect(err.message).toContain('ANNOTATION_OPEN');
    expect(err.message).toContain('DISMISSED');
  });

  test('state is unchanged after a rejected transition', async () => {
    const id = annotationId();
    await initAnnotationState(sql, id, RM_ACTOR);

    await expect(
      transitionAnnotation(sql, {
        annotationId: id,
        toState: AnnotationState.DISMISSED,
        actorId: RM_ACTOR,
      }),
    ).rejects.toThrow(IllegalAnnotationTransitionError);

    const row = await getAnnotationState(sql, id);
    expect(row!.state).toBe(AnnotationState.ANNOTATION_OPEN);
  });

  test('transitionAnnotation throws for unknown annotation_id', async () => {
    await expect(
      transitionAnnotation(sql, {
        annotationId: 'does-not-exist',
        toState: AnnotationState.AGENT_RESPONDING,
        actorId: SYSTEM_ACTOR,
      }),
    ).rejects.toThrow(/No annotation state found/);
  });
});

// ---------------------------------------------------------------------------
// getAnnotationHistory
// ---------------------------------------------------------------------------

describe('getAnnotationHistory', () => {
  test('returns ordered transition log matching the path taken', async () => {
    const id = annotationId();
    await initAnnotationState(sql, id, RM_ACTOR);
    await transitionAnnotation(sql, {
      annotationId: id,
      toState: AnnotationState.AGENT_RESPONDING,
      actorId: SYSTEM_ACTOR,
    });
    await transitionAnnotation(sql, {
      annotationId: id,
      toState: AnnotationState.CORRECTION_APPLIED,
      actorId: SYSTEM_ACTOR,
    });

    const history = await getAnnotationHistory(sql, id);
    expect(history).toHaveLength(3);

    const toStates = history.map((r) => r.to_state);
    expect(toStates).toEqual([
      AnnotationState.ANNOTATION_OPEN,
      AnnotationState.AGENT_RESPONDING,
      AnnotationState.CORRECTION_APPLIED,
    ]);
  });

  test('from_state is null only for the init record', async () => {
    const id = annotationId();
    await initAnnotationState(sql, id, RM_ACTOR);
    await transitionAnnotation(sql, {
      annotationId: id,
      toState: AnnotationState.AGENT_RESPONDING,
      actorId: SYSTEM_ACTOR,
    });

    const history = await getAnnotationHistory(sql, id);
    expect(history[0].from_state).toBeNull();
    expect(history[1].from_state).toBe(AnnotationState.ANNOTATION_OPEN);
  });

  test('each row carries a non-null transitioned_at timestamp', async () => {
    const id = annotationId();
    await initAnnotationState(sql, id, RM_ACTOR);
    await transitionAnnotation(sql, {
      annotationId: id,
      toState: AnnotationState.AGENT_RESPONDING,
      actorId: SYSTEM_ACTOR,
    });

    const history = await getAnnotationHistory(sql, id);
    for (const row of history) {
      expect(row.transitioned_at).toBeInstanceOf(Date);
      expect(Number.isFinite(row.transitioned_at.getTime())).toBe(true);
    }
  });
});
