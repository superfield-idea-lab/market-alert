/**
 * @file event-eval-api.ts
 *
 * Internal API handlers for the event-evaluation pipeline — Phase 6 dev-scout (issue #82).
 *
 * ## Routes
 *
 *   GET  /internal/event-evaluation/market-event?market_event_id=<id>
 *     Returns: { market_event: MarketEventRow | null }
 *     Fetches a market_event by its primary key. Used by the EVENT_EVALUATE worker.
 *
 *   GET  /internal/event-evaluation/active-prompt?tenant_id=&researcher_id=&subject_type=&subject_id=
 *     Returns: { version: StandingPromptVersionRow | null }
 *     Returns the currently active standing_prompt_version for the subject.
 *     Delegates to `getActiveStandingPromptVersion` from standing-prompt-store.ts.
 *
 *   GET  /internal/event-evaluation/signal/check?idempotency_key=<key>
 *     Returns: { signal_id: string | null }
 *     Checks whether a signal with the given idempotency key already exists.
 *     Used by the worker to implement the idempotency gate.
 *
 *   POST /internal/event-evaluation/signal
 *     Body: { tenant_id, researcher_id, market_event_id, standing_prompt_version_id,
 *             rationale?, source_trust?, extraction_certainty? }
 *     Returns: { signal_id, created: true } on new insertion,
 *              { signal_id, created: false } on idempotency conflict.
 *     Creates one signal row in `signals`. Uses ON CONFLICT (idempotency_key) DO NOTHING.
 *
 *   POST /internal/event-evaluation/signal/:id/cite
 *     Body: { target_type: 'wiki_page_version' | 'standing_prompt_version', target_id }
 *     Returns: { signal_cite_id, created: boolean }
 *     Attaches one cites edge from a signal to an immutable snapshot target.
 *     Uses ON CONFLICT (signal_id, target_type, target_id) DO NOTHING (idempotent).
 *
 * ## Security
 *
 * Bearer token is validated against EVENT_EVAL_TEST_TOKEN in TEST_MODE.
 * Production will require a signed worker JWT scoped to event_evaluator operations.
 *
 * ## Canonical docs
 *
 * - docs/prd.md §5, §9 — event evaluation, confidence, auditability
 * - docs/architecture.md §"Signal routing"
 * - docs/architecture.md §"Citations: first-class relation edges"
 * - packages/db/signal-store.ts — DB store (signals, signal_cites)
 * - packages/db/mkt-market-event-store.ts — market_events store
 * - packages/db/standing-prompt-store.ts — standing_prompt_versions store
 * - apps/worker/src/event-eval-job.ts — worker handler
 * - tests/integration/event-evaluation.spec.ts — integration tests (this scout)
 *
 * @see https://github.com/superfield-idea-lab/market-alert/issues/82
 */

import type { AppState } from '../index';
import { makeJson } from '../lib/response';
import { getMarketEventById } from '../../../../packages/db/mkt-market-event-store';
import {
  getActiveStandingPromptVersion,
  type StandingPromptSubjectType,
} from '../../../../packages/db/standing-prompt-store';
import {
  insertSignal,
  insertSignalCite,
  getSignalByIdempotencyKey,
} from '../../../../packages/db/signal-store';

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

/** Test-mode bearer token for the event-evaluation API (issue #82). */
export const EVENT_EVAL_TEST_TOKEN = 'event-eval-test-secret-82';

function checkBearer(req: Request): string | null {
  const auth = req.headers.get('authorization') ?? '';
  const match = auth.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : null;
}

function isAuthorized(token: string | null): boolean {
  // TEST_MODE: accept the hard-coded test token.
  if (process.env.TEST_MODE === 'true' && token === EVENT_EVAL_TEST_TOKEN) {
    return true;
  }
  // Production: validate signed JWT (not yet implemented; wired in follow-on issue).
  return false;
}

// ---------------------------------------------------------------------------
// Subject type validation
// ---------------------------------------------------------------------------

const VALID_SUBJECT_TYPES = new Set<string>(['entity', 'thesis', 'portfolio']);

function isValidSubjectType(v: unknown): v is StandingPromptSubjectType {
  return typeof v === 'string' && VALID_SUBJECT_TYPES.has(v);
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

/**
 * Handle all requests under /internal/event-evaluation (for use in a composite
 * request router).
 *
 * Returns a Response on match, or null if the path does not match.
 */
export async function handleEventEvalApiRequest(
  req: Request,
  url: URL,
  appState: AppState,
): Promise<Response | null> {
  if (!url.pathname.startsWith('/internal/event-evaluation')) return null;

  const json = makeJson({});
  const token = checkBearer(req);
  if (!isAuthorized(token)) {
    return json({ error: 'Unauthorized' }, 401);
  }

  const path = url.pathname;
  const method = req.method.toUpperCase();

  const { sql } = appState;

  // GET /internal/event-evaluation/market-event — fetch a market_event by ID
  if (method === 'GET' && path === '/internal/event-evaluation/market-event') {
    const market_event_id = url.searchParams.get('market_event_id');
    if (!market_event_id) {
      return json({ error: 'market_event_id is required' }, 400);
    }
    const market_event = await getMarketEventById(market_event_id, sql);
    return json({ market_event: market_event ?? null });
  }

  // GET /internal/event-evaluation/active-prompt — fetch the active standing prompt version
  if (method === 'GET' && path === '/internal/event-evaluation/active-prompt') {
    const tenant_id = url.searchParams.get('tenant_id');
    const researcher_id = url.searchParams.get('researcher_id');
    const subject_type_raw = url.searchParams.get('subject_type');
    const subject_id = url.searchParams.get('subject_id');

    if (!tenant_id || !researcher_id || !subject_id) {
      return json({ error: 'tenant_id, researcher_id, and subject_id are required' }, 400);
    }

    const subject_type: StandingPromptSubjectType = isValidSubjectType(subject_type_raw)
      ? subject_type_raw
      : 'entity';

    const version = await getActiveStandingPromptVersion(
      sql,
      tenant_id,
      researcher_id,
      subject_type,
      subject_id,
    );
    return json({ version: version ?? null });
  }

  // GET /internal/event-evaluation/signal/check — idempotency check
  if (method === 'GET' && path === '/internal/event-evaluation/signal/check') {
    const idempotency_key = url.searchParams.get('idempotency_key');
    if (!idempotency_key) {
      return json({ error: 'idempotency_key is required' }, 400);
    }
    const existing = await getSignalByIdempotencyKey(idempotency_key, sql);
    return json({ signal_id: existing?.id ?? null });
  }

  // POST /internal/event-evaluation/signal — create a signal row
  if (method === 'POST' && path === '/internal/event-evaluation/signal') {
    const body = (await req.json()) as {
      tenant_id?: string;
      researcher_id?: string;
      market_event_id?: string;
      standing_prompt_version_id?: string;
      rationale?: string | null;
      source_trust?: number;
      extraction_certainty?: number;
    };

    if (
      !body.tenant_id ||
      !body.researcher_id ||
      !body.market_event_id ||
      !body.standing_prompt_version_id
    ) {
      return json(
        {
          error:
            'tenant_id, researcher_id, market_event_id, and standing_prompt_version_id are required',
        },
        400,
      );
    }

    const row = await insertSignal({
      tenant_id: body.tenant_id,
      researcher_id: body.researcher_id,
      market_event_id: body.market_event_id,
      standing_prompt_version_id: body.standing_prompt_version_id,
      rationale: body.rationale ?? null,
      source_trust: body.source_trust ?? 1.0,
      extraction_certainty: body.extraction_certainty ?? 1.0,
      sql,
    });

    if (!row) {
      // ON CONFLICT — row already exists. Fetch and return it.
      const idempotency_key = `event_eval:${body.market_event_id}:${body.standing_prompt_version_id}`;
      const existing = await getSignalByIdempotencyKey(idempotency_key, sql);
      return json({ signal_id: existing!.id, created: false });
    }

    return json({ signal_id: row.id, created: true });
  }

  // POST /internal/event-evaluation/signal/:id/cite — attach a cites edge
  const citeMatch = path.match(/^\/internal\/event-evaluation\/signal\/([^/]+)\/cite$/);
  if (method === 'POST' && citeMatch) {
    const signal_id = citeMatch[1];
    const body = (await req.json()) as {
      target_type?: string;
      target_id?: string;
    };

    if (!body.target_type || !body.target_id) {
      return json({ error: 'target_type and target_id are required' }, 400);
    }

    if (
      body.target_type !== 'wiki_page_version' &&
      body.target_type !== 'standing_prompt_version'
    ) {
      return json(
        {
          error: 'target_type must be one of: wiki_page_version, standing_prompt_version',
        },
        400,
      );
    }

    const citeRow = await insertSignalCite({
      signal_id,
      target_type: body.target_type,
      target_id: body.target_id,
      sql,
    });

    if (!citeRow) {
      // ON CONFLICT — edge already exists.
      return json({ signal_cite_id: null, created: false });
    }

    return json({ signal_cite_id: citeRow.id, created: true });
  }

  return null;
}
