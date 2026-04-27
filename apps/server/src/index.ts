/**
 * @file overview
 * This is the main entrypoint for the Superfield Bun server.
 * It is responsible for handling all incoming HTTP requests, routing them
 * to the appropriate integration or business logic modules, and serving
 * the compiled frontend React application from `apps/web/dist`.
 */

import {
  analyticsSql,
  auditSql,
  dictionarySql,
  migrate,
  migrateAudit,
  migrateDictionary,
  sql,
} from 'db';
import { registerPhase1EntityTypesWithDb } from 'db/phase1-entity-types';
import { cleanupExpiredRevocations, startRevocationCleanup } from 'db/revocation';
import { scrubPii } from 'core';
import { handleAuthRequest, getAuthenticatedUser } from './api/auth';
import { handlePasskeyRequest } from './api/passkey';
import { handleTaskQueueResultRequest, handleTasksQueueRequest } from './api/task-queue';
import { handleAuditRequest } from './api/audit';
import { extractTraceId, traceLog, log } from 'core';
import { startCronScheduler } from './cron/boot';
import { websocketHandler, type WsClientData } from './websocket';
import { handleAdminRequest } from './api/admin';
import { handleApprovalsRequest } from './api/approvals';
import { isSuperuser } from './lib/response';
import { handleUsersRequest } from './api/users';
import { seedSuperuser } from './seed/superuser';
import { startTaskQueueListener } from './task-queue-listener';
import { getJwks } from './auth/jwt';
import { handleHealthRequest } from './api/health';
import {
  handleTestSessionRequest,
  handleTestIngestionTokenRequest,
  isTestMode,
} from './api/test-session';
import { handleReidentificationRequest } from './api/reidentification';
import { handleIngestionRequest } from './api/ingestion';
import { handleCorpusChunksRequest, registerCorpusChunkEntityType } from './api/corpus-chunks';
import { handleCampaignAnalysisRequest } from './api/campaign-analysis';
import { handleWorkerTokensRequest } from './api/worker-tokens';
import { handleInternalWikiVersionsRequest } from './api/internal-wiki-versions';
import { handleInternalRelationsRequest } from './api/internal-relations';
import { handleDeepcleanRequest } from './api/deepclean';
import { handleWikiRequest } from './api/wiki';
import { handleWikiPageViewRequest } from './api/wiki-page-view';
import { handleWikiPendingDraftsRequest } from './api/wiki-pending-drafts';
import {
  handleTranscriptIngestionRequest,
  registerTranscriptEntityType,
} from './api/transcript-ingestion';
import { handleTranscriptionRequest } from './api/transcription';
import { handleAnnotationsRequest } from './api/annotations';
import { handleAnnotationThreadsRequest } from './api/annotation-threads';
import { handleWikiDraftReviewRequest } from './api/wiki-draft-review';
import { handleBdmCampaignRequest } from './api/bdm-campaign';
import { handleCampaignSummaryRequest } from './api/campaign-summary';
import { handleComplianceRequest } from './api/compliance';
import { handleLegalHoldRequest } from './api/legal-hold';
import { handleLabelClearanceRequest } from './api/label-clearance';

// Starter behavior:
// the server boot path auto-runs a local schema initializer for convenience.
// The target enterprise posture keeps this repo on PostgreSQL, but production
// deployments should promote controlled migrations, journal checkpoint setup,
// and recovery validation ahead of serving traffic.
await migrate();
try {
  await migrateAudit();
} catch (err) {
  console.warn('[db] Audit schema migration skipped — audit database unavailable:', err);
}
try {
  await migrateDictionary();
} catch (err) {
  console.warn('[db] Dictionary schema migration skipped — dictionary database unavailable:', err);
}

// Register all Phase 1 property graph entity types in the in-memory registry
// and persist each to entity_types via an idempotent INSERT … ON CONFLICT DO NOTHING.
// Must run after migrate() so the entity_types table exists.
await registerPhase1EntityTypesWithDb(sql);

// Register the CorpusChunk entity type for Phase 2 chunking.
await registerCorpusChunkEntityType().catch((err) =>
  console.error('[corpus-chunk] Entity type registration failed:', err),
);

// Register Phase 5 entity types: audio_recording and transcript (issues #53, #58).
// audio_recording is metadata-only — no raw audio column.
// transcript.text is encrypted at rest.
await registerTranscriptEntityType().catch((err) =>
  console.error('[phase5-entity-types] Registration failed:', err),
);

// Purge any already-expired revocation rows left from a previous run, then
// schedule the recurring 24-hour cleanup. The timer is unref'd so it does not
// block process exit.
await cleanupExpiredRevocations().catch((err) =>
  console.error('[revocation] startup cleanup failed:', err),
);
startRevocationCleanup();

// Start the cron scheduler which manages all recurring jobs including
// stale-claim recovery (TQ-D-003).
startCronScheduler();

// Seed the initial superuser if none exists yet.
await seedSuperuser({ sql }).catch((err) => console.error('[seed] Superuser seeding failed:', err));

// Start the task-queue LISTEN/NOTIFY → WebSocket bridge so the admin monitor
// receives real-time task status changes without polling.
startTaskQueueListener().catch((err) =>
  console.error('[task-queue-listener] Failed to start:', err),
);

export interface AppState {
  sql: typeof sql;
  auditSql: typeof auditSql;
  analyticsSql: typeof analyticsSql;
  /** IdentityDictionary pool — dict_rw role, kb_dictionary only. */
  dictionarySql: typeof dictionarySql;
}

export const appState: AppState = {
  sql,
  auditSql,
  analyticsSql,
  dictionarySql,
};

export default {
  port: Number(process.env.PORT) || 31415,
  // SERVER_HOSTNAME controls the bind address. HOSTNAME is reserved by
  // Kubernetes (set to the pod name) and must not be used as a bind address.
  hostname: process.env.SERVER_HOSTNAME ?? '0.0.0.0',

  websocket: websocketHandler,

  /**
   * The core fetch handler for the Bun native HTTP server.
   * Every request gets a trace ID from the `X-Trace-Id` header (or a generated
   * UUID when the header is absent). The ID is included in all log entries for
   * the request lifecycle and echoed back in the response header so the browser
   * can correlate server logs with client-side context.
   * The `server` parameter is the Bun Server instance, needed to upgrade
   * WebSocket connections via `server.upgrade(req)`.
   *
   * @returns {Response} A unified response object containing the HTML document or API payload.
   */
  async fetch(req: Request, server: import('bun').Server<WsClientData>) {
    const url = new URL(req.url);
    const traceId = extractTraceId(req);
    const reqStart = Date.now();

    // Helper: wrap a Response with the trace header.
    function withTrace(res: Response): Response {
      const duration = Date.now() - reqStart;
      const entry = traceLog('info', traceId, {
        method: req.method,
        path: url.pathname,
        status: res.status,
        duration_ms: duration,
      });
      // Write to both console and the dual log files.
      console.log(JSON.stringify(entry));
      log('info', `${req.method} ${url.pathname} ${res.status}`, {
        trace_id: traceId,
        method: req.method,
        path: url.pathname,
        status: res.status,
        duration_ms: duration,
      });
      res.headers.set('X-Trace-Id', traceId);
      return res;
    }

    // Health check endpoints — liveness, readiness, deep (DEPLOY-C-030/031/032)
    // Routes: /health/live, /health/ready, /health/deep
    // Legacy aliases: /health, /healthz -> liveness
    // See apps/server/src/api/health.ts for three-tier probe design.
    if (url.pathname.startsWith('/health') || url.pathname === '/healthz') {
      const healthRes = await handleHealthRequest(url.pathname, appState);
      if (healthRes !== null) return withTrace(healthRes);
    }

    // JWKS endpoint — exposes the current EC P-256 public key(s) for token verification.
    // Downstream services can use this to verify ES256-signed JWTs without the private key.
    if (url.pathname === '/.well-known/jwks.json') {
      const jwks = await getJwks();
      return withTrace(
        new Response(JSON.stringify(jwks), {
          headers: {
            'Content-Type': 'application/json',
            'Cache-Control': 'public, max-age=3600',
          },
        }),
      );
    }

    // WebSocket upgrade endpoint — requires a valid JWT before upgrading
    if (url.pathname === '/ws') {
      const user = await getAuthenticatedUser(req);
      if (!user) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      const clientData: WsClientData = { isSuperadmin: isSuperuser(user.id) };
      const upgraded = server.upgrade(req, { data: clientData });
      if (!upgraded) {
        return new Response('WebSocket upgrade failed', { status: 400 });
      }
      // Return undefined so Bun completes the upgrade handshake
      return undefined as unknown as Response;
    }

    // Handle CORS for local dev
    if (req.method === 'OPTIONS') {
      const res = new Response('Departed', {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Trace-Id',
        },
      });
      return withTrace(res);
    }

    if (url.pathname.startsWith('/api/auth/passkey')) {
      const passkeyRes = await handlePasskeyRequest(req, url, appState);
      if (passkeyRes) return passkeyRes;
    }

    if (url.pathname.startsWith('/api/auth')) {
      const authRes = await handleAuthRequest(req, url, appState);
      if (authRes) return withTrace(authRes);
    }

    // Test-only session backdoor and rate-limit probe — available only when TEST_MODE=true.
    // Used by integration tests to obtain a session cookie without going through
    // the passkey ceremony. Also handles POST /api/test/worker-token (issue #39
    // integration tests). Never enabled in production.
    if (isTestMode() && url.pathname.startsWith('/api/test/')) {
      const testRes = await handleTestSessionRequest(req, url, appState);
      if (testRes) return testRes;
    }

    // Test-only ingestion token mint — available only when TEST_MODE=true.
    // Allows integration tests to obtain a scoped ingestion token signed by the
    // server's ephemeral key pair. Never enabled in production.
    if (isTestMode() && url.pathname === '/api/test/ingestion-token') {
      const testTokenRes = await handleTestIngestionTokenRequest(req, url, appState);
      if (testTokenRes) return testTokenRes;
    }

    if (url.pathname.startsWith('/api/tasks')) {
      // Delegated-token result submission route — workers submit results here.
      // The generic task CRUD handler (handleTasksRequest) was removed in issue #210.
      const resultRes = await handleTaskQueueResultRequest(req, url, appState);
      if (resultRes) return withTrace(resultRes);
    }

    if (url.pathname.startsWith('/api/tasks-queue')) {
      const tasksQueueRes = await handleTasksQueueRequest(req, url, appState);
      if (tasksQueueRes) return tasksQueueRes;
    }

    if (url.pathname.startsWith('/api/audit')) {
      const auditRes = await handleAuditRequest(req, url, appState);
      if (auditRes) return withTrace(auditRes);
    }

    if (url.pathname.startsWith('/api/admin')) {
      const adminRes = await handleAdminRequest(req, url, appState);
      if (adminRes) return adminRes;
    }

    if (url.pathname.startsWith('/api/approvals')) {
      const approvalsRes = await handleApprovalsRequest(req, url, appState);
      if (approvalsRes) return withTrace(approvalsRes);
    }

    if (url.pathname.startsWith('/api/users')) {
      const usersRes = await handleUsersRequest(req, url, appState);
      if (usersRes) return withTrace(usersRes);
    }

    // Deepclean on-demand autolearn endpoint (issue #41).
    // POST /api/deepclean — operator-only trigger for a full-ground-truth wiki rebuild.
    if (url.pathname.startsWith('/api/deepclean')) {
      const deepcleanRes = await handleDeepcleanRequest(req, url, appState);
      if (deepcleanRes) return withTrace(deepcleanRes);
    }

    // Draft review + publication gate (issue #66).
    // GET  /api/wiki/drafts/:id           — fetch draft with diff and materiality
    // POST /api/wiki/drafts/:id/approve   — publish the draft (approver only)
    // POST /api/wiki/drafts/:id/reject    — close the draft  (approver only)
    // Must be checked before the generic /api/wiki handler.
    if (url.pathname.startsWith('/api/wiki/drafts')) {
      const draftReviewRes = await handleWikiDraftReviewRequest(req, url, appState);
      if (draftReviewRes) return withTrace(draftReviewRes);
    }

    // Pending-drafts badge count for approvers (issue #48).
    // GET /api/wiki/pending-drafts?customer_id=<id>
    // Must be checked before the generic /api/wiki handler to avoid prefix collision.
    if (url.pathname === '/api/wiki/pending-drafts') {
      const pendingRes = await handleWikiPendingDraftsRequest(req, url, appState);
      if (pendingRes) return withTrace(pendingRes);
    }

    // Wiki draft management + claim-citation coverage check (issue #43).
    // POST   /api/wiki/versions           — create draft, run coverage check
    // GET    /api/wiki/versions/:id       — fetch draft by ID
    // POST   /api/wiki/versions/:id/publish — publish (blocked for P1 drafts)
    if (url.pathname.startsWith('/api/wiki')) {
      const wikiRes = await handleWikiRequest(req, url, appState);
      if (wikiRes) return withTrace(wikiRes);
    }

    // Annotation threads — inline anchored comment threads on wiki page versions (issue #63).
    // GET    /api/wiki/pages/:cId/versions/:vId/annotations            — list threads
    // POST   /api/wiki/pages/:cId/versions/:vId/annotations            — create thread
    // POST   /api/wiki/pages/:cId/versions/:vId/annotations/:tId/replies — post reply
    // PATCH  /api/wiki/pages/:cId/versions/:vId/annotations/:tId      — resolve/unresolve
    // Must be checked BEFORE the generic /api/wiki/pages handler.
    if (url.pathname.includes('/annotations')) {
      const annotationRes = await handleAnnotationThreadsRequest(req, url, appState);
      if (annotationRes) return withTrace(annotationRes);
    }

    // Read-only wiki page view + version picker + citation hover (issue #45).
    // GET  /api/wiki/pages/:customerId                                  — list versions
    // GET  /api/wiki/pages/:customerId/versions/:versionId             — fetch single version
    // GET  /api/wiki/pages/:customerId/versions/:versionId/citations/:t — resolve citation
    // Scout stub: all routes return 501 Not Implemented (Phase 4 follow-on).
    if (url.pathname.startsWith('/api/wiki/pages')) {
      const wikiPageRes = await handleWikiPageViewRequest(req, url, appState);
      if (wikiPageRes) return withTrace(wikiPageRes);
    }

    // Annotation thread API — Phase 6 scout stub (issue #62).
    // POST   /api/annotations                   — open a new annotation thread
    // GET    /api/annotations/:id               — fetch an annotation thread
    // POST   /api/annotations/:id/accept        — accept agent reply, publish new WikiPageVersion
    // POST   /api/annotations/:id/reject        — reject agent reply, no version change
    // Scout stub: all routes return 501 Not Implemented (Phase 6 follow-on).
    if (url.pathname.startsWith('/api/annotations')) {
      const annotationsRes = await handleAnnotationsRequest(req, url, appState);
      if (annotationsRes) return withTrace(annotationsRes);
    }

    if (url.pathname.startsWith('/api/reidentification')) {
      const reidentRes = await handleReidentificationRequest(req, url, appState);
      if (reidentRes) return withTrace(reidentRes);
    }

    // Cluster-internal transcription worker path (issue #57).
    // POST /api/transcriptions — submit a transcript (delegated-token or session-cookie auth)
    // GET  /api/transcriptions — list transcripts
    // GET  /api/transcriptions/:id — fetch a single transcript
    if (url.pathname.startsWith('/api/transcriptions')) {
      const transcriptionRes = await handleTranscriptionRequest(req, url, appState);
      if (transcriptionRes) return withTrace(transcriptionRes);
    }

    // Phase 5 edge-path transcript ingestion (POST /internal/ingestion/transcript).
    // Edge-path invariant: only transcript JSON is accepted — raw audio never
    // crosses the trust boundary. Checked before the generic /internal/ingestion
    // prefix to avoid the email handler swallowing the path. Issue #53.
    if (url.pathname === '/internal/ingestion/transcript') {
      const transcriptRes = await handleTranscriptIngestionRequest(req, url, appState);
      if (transcriptRes) return withTrace(transcriptRes);
    }

    // API-mediated email ingestion (POST /internal/ingestion/email)
    // Worker DB role has no INSERT on entities — writes must go through this endpoint.
    // Blueprint: WORKER-P-001, API-W-001. Issue #28.
    if (url.pathname.startsWith('/internal/ingestion')) {
      const ingestionRes = await handleIngestionRequest(req, url, appState);
      if (ingestionRes) return withTrace(ingestionRes);
    }

    if (url.pathname.startsWith('/api/corpus-chunks')) {
      const corpusRes = await handleCorpusChunksRequest(req, url, appState);
      if (corpusRes) return withTrace(corpusRes);
    }

    // Phase 7: BDM campaign query endpoint (issue #103).
    // GET /api/bdm/campaign — reads from kb_analytics only (DATA-C-031).
    if (url.pathname.startsWith('/api/bdm/')) {
      const bdmRes = await handleBdmCampaignRequest(req, url, appState);
      if (bdmRes) return withTrace(bdmRes);
    }

    // Campaign analysis — BDM picker + anonymised chunk query (issue #74).
    // GET /api/campaign/entities?type=asset_manager|fund
    // GET /api/campaign/chunks?entity_id=<id>
    if (url.pathname.startsWith('/api/campaign')) {
      const campaignRes = await handleCampaignAnalysisRequest(req, url, appState);
      if (campaignRes) return withTrace(campaignRes);
    }

    // Internal worker token mint + pod-terminate invalidation (issue #36).
    // POST /internal/worker/tokens — mint a scoped single-use token.
    // DELETE /internal/worker/tokens/:podId — invalidate on pod terminate.
    if (url.pathname.startsWith('/internal/worker/tokens')) {
      const workerTokenRes = await handleWorkerTokensRequest(req, url, appState);
      if (workerTokenRes) return withTrace(workerTokenRes);
    }

    // Internal worker wiki write endpoint — Bearer wiki-write token auth (issue #39).
    // POST /internal/wiki/versions — autolearn worker writes draft WikiPageVersion.
    if (url.pathname.startsWith('/internal/wiki/')) {
      const internalWikiRes = await handleInternalWikiVersionsRequest(req, url, appState);
      if (internalWikiRes) return withTrace(internalWikiRes);
    }

    // Internal worker relation write endpoint — Bearer wiki-write token auth (issue #72).
    // POST /internal/relations — autolearn worker writes discussed_in relations.
    if (url.pathname === '/internal/relations') {
      const internalRelRes = await handleInternalRelationsRequest(req, url, appState);
      if (internalRelRes) return withTrace(internalRelRes);
    }

    // Campaign summary endpoint — Phase 7 BDM campaign analysis (issue #75).
    // POST /api/campaign/summarise — summarise anonymised chunks via Claude API.
    if (url.pathname.startsWith('/api/campaign/')) {
      const summaryRes = await handleCampaignSummaryRequest(req, url, appState);
      if (summaryRes) return withTrace(summaryRes);
    }

    // Phase 8 compliance officer endpoints (issue #79).
    // GET  /api/compliance/retention-policies — list policy library
    // POST /api/compliance/tenants/:id/retention-policy — assign a policy (compliance_officer only)
    if (url.pathname.startsWith('/api/compliance')) {
      const complianceRes = await handleComplianceRequest(req, url, appState);
      if (complianceRes) return withTrace(complianceRes);
    }

    // Label-based clearance controls and per-label content-key encryption (issue #225).
    // POST   /api/labels — create clearance label (superuser only)
    // GET    /api/labels — list labels (superuser only)
    // POST   /api/labels/:name/content-key — create/rotate per-label KMS key (superuser only)
    // POST   /api/labels/:name/grants — grant label to user (superuser only)
    // DELETE /api/labels/:name/grants/:userId — revoke label grant (superuser only)
    // GET    /api/labels/:name/grants — list label grant holders (superuser only)
    // GET    /api/users/:userId/labels — list user's label grants
    // POST   /api/labels/:name/ground-truth — write labeled encrypted record (superuser only)
    // GET    /api/labels/:name/ground-truth/:entityId — read + decrypt (label holder or superuser)
    if (
      url.pathname.startsWith('/api/labels') ||
      url.pathname.match(/^\/api\/users\/[^/]+\/labels/)
    ) {
      const labelRes = await handleLabelClearanceRequest(req, url, appState);
      if (labelRes) return withTrace(labelRes);
    }

    // Phase 8 legal hold endpoints (issue #82).
    // POST /api/legal-holds — place a hold (compliance_officer only)
    // GET  /api/legal-holds — list holds
    // GET  /api/legal-holds/:holdId — fetch a single hold
    // POST /api/legal-holds/:holdId/removal-request — initiate four-eyes removal
    // POST /api/legal-holds/removal-requests/:requestId/approve — co-approve removal
    // POST /api/legal-holds/removal-requests/:requestId/reject — reject removal
    // GET  /api/legal-holds/pending-removals — approval queue
    if (url.pathname.startsWith('/api/legal-holds')) {
      const legalHoldRes = await handleLegalHoldRequest(req, url, appState);
      if (legalHoldRes) return withTrace(legalHoldRes);
    }

    // Serve static assets. import.meta.dir is the compiled bundle dir (/app/dist)
    // at runtime, so we derive the path from process.cwd() instead — which is
    // the repo root in dev and /app in the release container (WORKDIR /app).
    const webDist = `${process.cwd()}/apps/web/dist`;
    const staticFilePath = `${webDist}${url.pathname === '/' ? '/index.html' : url.pathname}`;
    const file = Bun.file(staticFilePath);
    if (await file.exists()) {
      return withTrace(new Response(file));
    }

    // Fallback to index.html for client-side React Router
    return withTrace(new Response(Bun.file(`${webDist}/index.html`)));
  },

  /**
   * Top-level error handler for the Bun HTTP server.
   * All logged objects are passed through `scrubPii` to prevent PII leaking
   * into server logs.
   */
  error(err: Error) {
    console.error('[server error]', scrubPii({ message: err.message, stack: err.stack }));
    return new Response(JSON.stringify({ error: 'Internal Server Error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  },
};

console.log(`Listening on http://localhost:${Number(process.env.PORT) || 31415}`);
