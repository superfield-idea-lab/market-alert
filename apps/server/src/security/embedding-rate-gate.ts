/**
 * Embedding column read rate gate.
 *
 * PRD §7 compensating controls: bulk reads of the embedding column are
 * audited and rate-limited to bound semantic-inversion attack surface.
 *
 * This module provides `checkEmbeddingReadRate`, which must be called
 * before any query that selects the vector/embedding column. If the
 * per-tenant rate is exceeded:
 *   1. An audit event is written BEFORE the deny (audit-before-deny).
 *   2. A 429 Too Many Requests response is returned.
 *   3. No embedding data is returned.
 *
 * Canonical docs:
 *   - docs/PRD.md §7 (embedding column threat model, compensating control 4)
 *   - docs/implementation-plan-v1.md (Phase 1 rate limiting, issue #89)
 */

import { tenantEmbeddingLimiter, tooManyRequests } from './rate-limiter';
import { emitAuditEvent } from '../policies/audit-service';

export interface EmbeddingRateCheckResult {
  /** `null` means the check passed; otherwise return this response immediately. */
  denyResponse: Response | null;
}

/**
 * Check whether an actor may perform an embedding-column read for the given
 * tenant. Must be called before any query that selects the embedding column.
 *
 * @param tenantId   The tenant owning the data (from the authenticated user's tenant_id).
 * @param actorId    The authenticated user or service account ID.
 * @param actorIp    The client IP address (for the audit record).
 * @param corsHeaders  CORS headers to forward on a 429 response.
 */
export async function checkEmbeddingReadRate(
  tenantId: string,
  actorId: string,
  actorIp: string,
  corsHeaders: Record<string, string> = {},
): Promise<EmbeddingRateCheckResult> {
  const result = tenantEmbeddingLimiter.check(tenantId, actorId);

  if (!result.allowed) {
    // Audit-before-deny: write the throttle event before returning 429
    await emitAuditEvent({
      actor_id: actorId,
      action: 'embedding.rate_limit.throttled',
      entity_type: 'embedding',
      entity_id: tenantId,
      before: null,
      after: {
        tenant: tenantId,
        actor_id: actorId,
        actor_ip: actorIp,
        limit: result.limit,
        reset_at: result.resetAt,
      },
      ip: actorIp,
      ts: new Date().toISOString(),
    }).catch((err) => {
      // Audit failure must not suppress the rate-limit response
      console.error('[embedding-rate-gate] audit emit failed:', err);
    });

    return { denyResponse: tooManyRequests(result, corsHeaders) };
  }

  // Consume a slot now that the check passed
  tenantEmbeddingLimiter.consume(tenantId, actorId);
  return { denyResponse: null };
}
