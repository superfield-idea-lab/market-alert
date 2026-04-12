/**
 * In-process sliding-window rate limiter.
 *
 * Uses a Map<key, number[]> of request timestamps per client key.
 * A shared periodic cleanup timer (every 5 minutes) evicts expired
 * entries from all registered instances. The timer calls .unref() so
 * it does not prevent process exit.
 *
 * RATE_LIMIT_DISABLED=true bypasses all limits.
 */

const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

/** Registry of all live RateLimiter instances so the shared timer can clean them all. */
const registry = new Set<RateLimiter>();

let cleanupTimer: ReturnType<typeof setInterval> | null = null;

function ensureCleanupTimer(): void {
  if (cleanupTimer !== null) return;
  cleanupTimer = setInterval(() => {
    for (const limiter of registry) {
      limiter.cleanup();
    }
  }, CLEANUP_INTERVAL_MS);
  // Do not prevent process exit
  if (typeof cleanupTimer === 'object' && cleanupTimer !== null && 'unref' in cleanupTimer) {
    (cleanupTimer as NodeJS.Timeout).unref();
  }
}

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAt: number; // Unix timestamp (seconds) when the window resets
}

export class RateLimiter {
  private readonly windowMs: number;
  private readonly maxRequests: number;
  private readonly store = new Map<string, number[]>();

  /**
   * @param windowMs   Length of the sliding window in milliseconds
   * @param maxRequests  Maximum requests allowed within the window
   */
  constructor(windowMs: number, maxRequests: number) {
    this.windowMs = windowMs;
    this.maxRequests = maxRequests;
    registry.add(this);
    ensureCleanupTimer();
  }

  /**
   * Check whether a request from `key` would be allowed right now.
   * Does NOT record the request — call consume() after a successful check.
   */
  check(key: string): RateLimitResult {
    if (process.env.RATE_LIMIT_DISABLED === 'true') {
      return { allowed: true, limit: this.maxRequests, remaining: this.maxRequests, resetAt: 0 };
    }

    const now = Date.now();
    const windowStart = now - this.windowMs;
    const timestamps = (this.store.get(key) ?? []).filter((ts) => ts > windowStart);

    const count = timestamps.length;
    const allowed = count < this.maxRequests;
    const remaining = Math.max(0, this.maxRequests - count - (allowed ? 1 : 0));
    // resetAt: when the oldest timestamp in the window expires
    const oldest = timestamps[0] ?? now;
    const resetAt = Math.ceil((oldest + this.windowMs) / 1000);

    return { allowed, limit: this.maxRequests, remaining, resetAt };
  }

  /**
   * Record a request from `key`. Should only be called after check() returns allowed=true.
   */
  consume(key: string): void {
    if (process.env.RATE_LIMIT_DISABLED === 'true') return;

    const now = Date.now();
    const windowStart = now - this.windowMs;
    const timestamps = (this.store.get(key) ?? []).filter((ts) => ts > windowStart);
    timestamps.push(now);
    this.store.set(key, timestamps);
  }

  /**
   * Evict entries whose most-recent timestamp is older than the window.
   * Called periodically by the shared cleanup timer.
   */
  cleanup(): void {
    const now = Date.now();
    const windowStart = now - this.windowMs;
    for (const [key, timestamps] of this.store) {
      const active = timestamps.filter((ts) => ts > windowStart);
      if (active.length === 0) {
        this.store.delete(key);
      } else {
        this.store.set(key, active);
      }
    }
  }

  /** For testing: reset all internal state. */
  reset(): void {
    this.store.clear();
  }
}

// ---------------------------------------------------------------------------
// Tenant rate policy
// ---------------------------------------------------------------------------

/**
 * Per-tenant configurable rate-limit policy.
 *
 * All fields are optional. Missing fields fall back to the safe defaults
 * defined in DEFAULT_TENANT_POLICY.
 *
 * Canonical docs: docs/PRD.md §7 (embedding column compensating controls)
 */
export interface TenantRatePolicy {
  /** Max passkey login attempts per actor IP per window. Default: 10 / 15 min */
  authMaxAttempts?: number;
  /** Window length in milliseconds for auth limiting. Default: 15 min */
  authWindowMs?: number;
  /** Max embedding-column reads per tenant actor per window. Default: 50 / 60 s */
  embeddingMaxReads?: number;
  /** Window length in milliseconds for embedding-read limiting. Default: 60 s */
  embeddingWindowMs?: number;
}

const DEFAULT_TENANT_POLICY: Required<TenantRatePolicy> = {
  authMaxAttempts: 10,
  authWindowMs: 15 * 60 * 1000,
  embeddingMaxReads: 50,
  embeddingWindowMs: 60 * 1000,
};

/**
 * In-memory store for per-tenant rate policy overrides.
 *
 * Runtime overrides take effect immediately without restart. The store is
 * intentionally in-memory for Phase 1. A persistent tenant-config table will
 * replace this in Phase 2 once the tenant management API lands.
 *
 * Key: tenant_id  Value: partial policy override
 */
const tenantPolicyStore = new Map<string, TenantRatePolicy>();

/**
 * Override the rate policy for a tenant at runtime.
 * Call with `null` to remove the override and revert to safe defaults.
 */
export function setTenantRatePolicy(tenantId: string, policy: TenantRatePolicy | null): void {
  if (policy === null) {
    tenantPolicyStore.delete(tenantId);
  } else {
    tenantPolicyStore.set(tenantId, policy);
  }
}

/**
 * Returns the effective rate policy for a tenant, merging stored overrides
 * with the safe defaults.
 */
export function getTenantRatePolicy(tenantId: string): Required<TenantRatePolicy> {
  const stored = tenantPolicyStore.get(tenantId) ?? {};
  return { ...DEFAULT_TENANT_POLICY, ...stored };
}

// ---------------------------------------------------------------------------
// Tenant-aware rate limiter
// ---------------------------------------------------------------------------

/**
 * Per-tenant rate limiter that reads limits from the tenant policy store on
 * every check. This means a runtime policy change takes effect on the next
 * check without requiring a new limiter instance.
 *
 * Keys are namespaced as `<tenantId>:<actorKey>` so tenant and global
 * limiters are fully isolated.
 */
export class TenantRateLimiter {
  private readonly store = new Map<string, number[]>();
  private readonly dimension: 'auth' | 'embedding';

  constructor(dimension: 'auth' | 'embedding') {
    this.dimension = dimension;
    registry.add(this as unknown as RateLimiter);
    ensureCleanupTimer();
  }

  private getPolicy(tenantId: string): { windowMs: number; maxRequests: number } {
    const policy = getTenantRatePolicy(tenantId);
    if (this.dimension === 'auth') {
      return { windowMs: policy.authWindowMs, maxRequests: policy.authMaxAttempts };
    }
    return { windowMs: policy.embeddingWindowMs, maxRequests: policy.embeddingMaxReads };
  }

  check(tenantId: string, actorKey: string): RateLimitResult {
    if (process.env.RATE_LIMIT_DISABLED === 'true') {
      const policy = this.getPolicy(tenantId);
      return {
        allowed: true,
        limit: policy.maxRequests,
        remaining: policy.maxRequests,
        resetAt: 0,
      };
    }

    const { windowMs, maxRequests } = this.getPolicy(tenantId);
    const key = `${tenantId}:${actorKey}`;
    const now = Date.now();
    const windowStart = now - windowMs;
    const timestamps = (this.store.get(key) ?? []).filter((ts) => ts > windowStart);

    const count = timestamps.length;
    const allowed = count < maxRequests;
    const remaining = Math.max(0, maxRequests - count - (allowed ? 1 : 0));
    const oldest = timestamps[0] ?? now;
    const resetAt = Math.ceil((oldest + windowMs) / 1000);

    return { allowed, limit: maxRequests, remaining, resetAt };
  }

  consume(tenantId: string, actorKey: string): void {
    if (process.env.RATE_LIMIT_DISABLED === 'true') return;

    const { windowMs } = this.getPolicy(tenantId);
    const key = `${tenantId}:${actorKey}`;
    const now = Date.now();
    const windowStart = now - windowMs;
    const timestamps = (this.store.get(key) ?? []).filter((ts) => ts > windowStart);
    timestamps.push(now);
    this.store.set(key, timestamps);
  }

  cleanup(): void {
    // Use the maximum possible window for cleanup so entries are not evicted
    // while still potentially active under a longer tenant policy.
    const maxWindowMs = Math.max(
      DEFAULT_TENANT_POLICY.authWindowMs,
      DEFAULT_TENANT_POLICY.embeddingWindowMs,
    );
    const windowStart = Date.now() - maxWindowMs;
    for (const [key, timestamps] of this.store) {
      const active = timestamps.filter((ts) => ts > windowStart);
      if (active.length === 0) {
        this.store.delete(key);
      } else {
        this.store.set(key, active);
      }
    }
  }

  /** For testing: reset all internal state. */
  reset(): void {
    this.store.clear();
  }
}

// ---------------------------------------------------------------------------
// Singleton instances
// ---------------------------------------------------------------------------

/** Global limiter applied to every request: 100 req / 60 s per IP */
export const globalLimiter = new RateLimiter(60 * 1000, 100);

/** POST /api/auth/login — 10 attempts per IP per 15 min */
export const loginIpLimiter = new RateLimiter(15 * 60 * 1000, 10);

/** POST /api/auth/login — 10 attempts per username per 15 min */
export const loginUserLimiter = new RateLimiter(15 * 60 * 1000, 10);

/** POST /api/auth/register — 5 attempts per IP per 60 min */
export const registerIpLimiter = new RateLimiter(60 * 60 * 1000, 5);

/** POST /api/auth/forgot-password — 3 attempts per IP per 15 min */
export const forgotPasswordIpLimiter = new RateLimiter(15 * 60 * 1000, 3);

/** POST /api/auth/forgot-password — 3 attempts per email per 60 min */
export const forgotPasswordEmailLimiter = new RateLimiter(60 * 60 * 1000, 3);

/** POST /api/auth/reset-password — 5 attempts per IP per 15 min */
export const resetPasswordIpLimiter = new RateLimiter(15 * 60 * 1000, 5);

/**
 * Tenant-aware auth limiter applied to passkey login endpoints.
 * Per-tenant, per-actor-IP: limits burst login attempts per-tenant policy.
 * Default: 10 attempts / 15 min per IP within a tenant.
 *
 * Used by: POST /api/auth/passkey/login/begin and /complete
 */
export const tenantAuthLimiter = new TenantRateLimiter('auth');

/**
 * Tenant-aware embedding-read limiter.
 * Per-tenant, per-actor: limits bulk embedding-column reads per-tenant policy.
 * Default: 50 reads / 60 s per actor within a tenant.
 *
 * Used by: any future API endpoint that reads the embedding column directly.
 * The gate must be checked before any read query that selects the vector column.
 */
export const tenantEmbeddingLimiter = new TenantRateLimiter('embedding');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract the client IP from a Request.
 * Reads `x-forwarded-for` first (first entry), falls back to `127.0.0.1`.
 */
export function getClientIp(req: Request): string {
  const forwarded = req.headers.get('x-forwarded-for');
  if (forwarded) {
    const first = forwarded.split(',')[0].trim();
    if (first) return first;
  }
  return '127.0.0.1';
}

/**
 * Build a 429 Too Many Requests response with standard rate-limit headers.
 */
export function tooManyRequests(
  result: RateLimitResult,
  corsHeaders: Record<string, string> = {},
): Response {
  const retryAfter = Math.max(0, result.resetAt - Math.floor(Date.now() / 1000));
  return new Response(JSON.stringify({ error: 'Too Many Requests' }), {
    status: 429,
    headers: {
      ...corsHeaders,
      'Content-Type': 'application/json',
      'Retry-After': String(retryAfter),
      'X-RateLimit-Limit': String(result.limit),
      'X-RateLimit-Remaining': '0',
      'X-RateLimit-Reset': String(result.resetAt),
    },
  });
}
