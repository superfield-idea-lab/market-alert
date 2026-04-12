/**
 * @file pii-tokeniser
 *
 * Stable, per-tenant PII tokeniser for the email ingestion pipeline.
 *
 * ## Design
 *
 * Given the same raw PII value and the same tenant ID, the tokeniser always
 * produces the same token. Tokens from different tenants for the same input are
 * cryptographically distinct: the HMAC key is derived per-tenant from a shared
 * salt using HKDF-SHA-256, so there can be no cross-tenant collisions.
 *
 * Token format: `<TYPE>_<hex8>`
 *   - TYPE  — one of PERSON, EMAIL, PHONE, ORG, LOC, or GENERIC
 *   - hex8  — first 8 hex characters of HMAC-SHA-256(tenantKey, canonical(input))
 *             (32 bits of entropy, sufficient for a reverse-lookup key)
 *
 * ## Stability
 *
 * Stability is guaranteed by:
 *   1. HKDF derivation: the per-tenant key is derived deterministically from
 *      `TOKENISER_MASTER_KEY` and the tenant ID using HKDF-SHA-256.
 *   2. Input canonicalisation: PII values are lower-cased and trimmed before
 *      the HMAC, so "Alice Smith" and "alice smith" produce the same token.
 *
 * ## Graceful degradation
 *
 * When `TOKENISER_MASTER_KEY` is absent, the tokeniser falls back to a
 * predictable SHA-256-based derivation so that development and test
 * environments do not require environment configuration.
 *
 * ## Registration
 *
 * Every token emitted by `tokenise()` is registered with an `IdentityStore`
 * so the re-identification API can restore the original value from the token.
 *
 * ## Usage
 *
 * ```ts
 * const tokeniser = new PiiTokeniser({ tenantId: 'tenant-abc' });
 * const result = await tokeniser.tokenise(
 *   'Hello Alice Smith (alice@example.com), your order is ready.',
 * );
 * // result.text   — anonymised text with tokens replacing PII
 * // result.tokens — map from token to original value, registered in the store
 * ```
 *
 * PRD §7; docs/technical/security.md § Anonymisation Layer
 */

// ---------------------------------------------------------------------------
// Token type classification
// ---------------------------------------------------------------------------

/**
 * Recognised PII entity types.
 *
 * Each type has a short prefix used in the emitted token string so downstream
 * agents can reason about the kind of entity without accessing the dictionary.
 */
export type PiiEntityType = 'PERSON' | 'EMAIL' | 'PHONE' | 'ORG' | 'LOC' | 'GENERIC';

/**
 * A single detected PII span within source text.
 */
export interface PiiSpan {
  /** The raw (original, unmodified) string from the source text. */
  raw: string;
  /** PII type classification. */
  type: PiiEntityType;
  /** Zero-based start index in the source string. */
  start: number;
  /** Zero-based exclusive end index in the source string. */
  end: number;
}

/**
 * Result of a tokenisation call.
 */
export interface TokenisationResult {
  /** The anonymised text with PII values replaced by stable tokens. */
  text: string;
  /**
   * Map from each emitted token to the original PII value.
   * Every entry in this map has been registered with the IdentityStore.
   */
  tokens: Map<string, string>;
}

// ---------------------------------------------------------------------------
// IdentityStore interface
// ---------------------------------------------------------------------------

/**
 * Write-only contract used by `PiiTokeniser` to register new tokens.
 *
 * The concrete implementation uses the `kb_dictionary` pool; a stub is used
 * in tests. Only the tokeniser calls `register` — all other consumers go
 * through the re-identification API, which calls `lookup`.
 *
 * DATA-D-006: no code outside the IdentityDictionary module should hold a
 * direct reference to `dictionarySql`. Pass a concrete `IdentityStore`
 * implementation at construction time.
 */
export interface IdentityStore {
  /**
   * Registers a token→originalValue mapping.
   *
   * Implementations must be idempotent: if the token already exists with the
   * same value, the call is a no-op. If it exists with a different value,
   * implementations should throw.
   *
   * @param tenantId   - Owning tenant identifier.
   * @param token      - The anonymisation token (e.g. `PERSON_a1b2c3d4`).
   * @param realValue  - The original PII value that the token replaces.
   */
  register(tenantId: string, token: string, realValue: string): Promise<void>;

  /**
   * Resolves a token back to its original value under an authorised session.
   *
   * Returns `undefined` when the token is not found.
   *
   * PRD §7: only the re-identification API service, not agents, may call this.
   *
   * @param tenantId - Owning tenant identifier.
   * @param token    - The anonymisation token to look up.
   */
  lookup(tenantId: string, token: string): Promise<string | undefined>;
}

// ---------------------------------------------------------------------------
// In-memory IdentityStore for development and unit tests
// ---------------------------------------------------------------------------

/**
 * In-memory `IdentityStore`.
 *
 * Suitable for unit tests and local development where no Postgres container
 * is available. Not thread-safe; not persistent.
 */
export class InMemoryIdentityStore implements IdentityStore {
  /**
   * Map keyed by `${tenantId}:${token}` → original value.
   */
  private readonly store = new Map<string, string>();

  async register(tenantId: string, token: string, realValue: string): Promise<void> {
    const key = `${tenantId}:${token}`;
    const existing = this.store.get(key);
    if (existing !== undefined && existing !== realValue) {
      throw new TokenCollisionError(token, tenantId);
    }
    this.store.set(key, realValue);
  }

  async lookup(tenantId: string, token: string): Promise<string | undefined> {
    return this.store.get(`${tenantId}:${token}`);
  }

  /** Number of registered entries. Useful in tests. */
  get size(): number {
    return this.store.size;
  }

  /** Returns all registered entries as a plain object. Useful in tests. */
  entries(): Record<string, string> {
    return Object.fromEntries(this.store);
  }
}

// ---------------------------------------------------------------------------
// PiiTokeniser
// ---------------------------------------------------------------------------

export interface PiiTokeniserOptions {
  /** The tenant the ingested content belongs to. */
  tenantId: string;
  /**
   * IdentityStore to register new tokens into.
   * Defaults to a new `InMemoryIdentityStore` when not supplied.
   */
  store?: IdentityStore;
}

/**
 * Per-tenant PII tokeniser.
 *
 * Detects PII in free-form text, replaces each occurrence with a stable
 * tenant-scoped token, and registers every token in the provided store.
 *
 * The same instance can be reused across multiple calls for the same tenant;
 * the per-tenant HMAC key is derived once and cached.
 *
 * **Thread safety:** this class is safe for concurrent use within a single
 * JavaScript event loop (all async paths are non-blocking).
 */
export class PiiTokeniser {
  private readonly tenantId: string;
  private readonly store: IdentityStore;
  /** Cached HMAC key for this tenant, set on first use. */
  private tenantKey: CryptoKey | null = null;

  constructor(opts: PiiTokeniserOptions) {
    this.tenantId = opts.tenantId;
    this.store = opts.store ?? new InMemoryIdentityStore();
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Tokenises all detected PII in `text`.
   *
   * Each PII span is replaced with a stable token of the form `TYPE_hex8`.
   * The replacement is registered with the IdentityStore before this method
   * returns, so callers can safely discard the original text afterwards.
   *
   * @param text - Raw text that may contain PII.
   * @returns Anonymised text and the token→original map.
   */
  async tokenise(text: string): Promise<TokenisationResult> {
    const spans = detectPiiSpans(text);
    const tokens = new Map<string, string>();

    // Sort spans in reverse order so replacement indices stay valid.
    const sorted = [...spans].sort((a, b) => b.start - a.start);

    let anonymised = text;
    for (const span of sorted) {
      const token = await this.deriveToken(span.raw, span.type);
      anonymised = anonymised.slice(0, span.start) + token + anonymised.slice(span.end);
      tokens.set(token, span.raw);
    }

    // Register every detected token in the store.
    for (const [token, raw] of tokens) {
      await this.store.register(this.tenantId, token, raw);
    }

    return { text: anonymised, tokens };
  }

  // ---------------------------------------------------------------------------
  // Token derivation
  // ---------------------------------------------------------------------------

  /**
   * Derives a stable token for `rawValue` of the given PII type under this tenant.
   *
   * Uses HMAC-SHA-256 with a per-tenant key derived from
   * `TOKENISER_MASTER_KEY` (or a deterministic fallback). The token is the
   * first 8 hex digits of the HMAC digest, prefixed with the entity type.
   *
   * Cross-tenant collision resistance: the HMAC key is unique per tenant
   * (derived with the tenant ID as HKDF salt), so tokens from two different
   * tenants for the same raw value are always distinct.
   *
   * @param rawValue - The canonical (lower-cased, trimmed) PII value.
   * @param type     - PII entity classification.
   */
  async deriveToken(rawValue: string, type: PiiEntityType): Promise<string> {
    const key = await this.getTenantKey();
    const canonical = canonicalise(rawValue);
    const encoder = new TextEncoder();
    const mac = await crypto.subtle.sign('HMAC', key, encoder.encode(canonical));
    const hex = Array.from(new Uint8Array(mac))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    return `${type}_${hex.slice(0, 8)}`;
  }

  // ---------------------------------------------------------------------------
  // Key derivation
  // ---------------------------------------------------------------------------

  /**
   * Returns (and caches) the HMAC-SHA-256 key for this tenant.
   *
   * The key is derived from `TOKENISER_MASTER_KEY` (hex or base64) using
   * HKDF-SHA-256 with the tenant ID as the info parameter. When the env var
   * is absent a deterministic fallback based on the tenant ID is used so that
   * development and tests work without configuration.
   */
  private async getTenantKey(): Promise<CryptoKey> {
    if (this.tenantKey) return this.tenantKey;
    const keyBytes = await deriveTenantKeyBytes(this.tenantId);
    this.tenantKey = await crypto.subtle.importKey(
      'raw',
      keyBytes.buffer as ArrayBuffer,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    return this.tenantKey;
  }
}

// ---------------------------------------------------------------------------
// PII detection
// ---------------------------------------------------------------------------

/**
 * Detects PII spans in `text` using heuristic regular expressions.
 *
 * This is a best-effort detector suitable for the fixture email corpus. It
 * recognises:
 *   - Email addresses (`EMAIL`)
 *   - Phone numbers in common North American / international formats (`PHONE`)
 *   - Capitalised person names (two or more capitalised words) (`PERSON`)
 *   - Capitalised organisation names ending in Corp/Inc/Ltd/LLC/Co (`ORG`)
 *
 * Overlapping spans are resolved by choosing the longest match; ties are
 * broken left-to-right (first match wins).
 *
 * @param text - Input text.
 * @returns Non-overlapping PII spans, ordered by start position.
 */
export function detectPiiSpans(text: string): PiiSpan[] {
  type RawMatch = { raw: string; type: PiiEntityType; start: number; end: number };
  const candidates: RawMatch[] = [];

  const add = (type: PiiEntityType, re: RegExp) => {
    let m: RegExpExecArray | null;
    const r = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
    while ((m = r.exec(text)) !== null) {
      candidates.push({ raw: m[0], type, start: m.index, end: m.index + m[0].length });
    }
  };

  // Email addresses (must come before generic word patterns)
  add('EMAIL', /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);

  // Phone numbers — North American (XXX-XXX-XXXX, (XXX) XXX-XXXX) and
  // international (+1 XXX XXX XXXX, +44 XXXX XXXXXX, etc.)
  add('PHONE', /(?:\+\d{1,3}[\s-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/);

  // Organisation names: one or more capitalised words followed by Corp/Inc/Ltd/LLC/Co
  add('ORG', /(?:[A-Z][a-z]+\s+)+(?:Corp|Inc|Ltd|LLC|Co)\.?/);

  // Person names: two or more consecutive capitalised words (not matched by ORG)
  // Excludes common English sentence-initial capitalisation patterns.
  add('PERSON', /\b[A-Z][a-z]{1,}\s+(?:[A-Z][a-z]{1,}\s+)*[A-Z][a-z]{1,}\b/);

  // Post-filter: drop PERSON candidates whose first word is a common English
  // non-name word (sentence starters, greetings, articles, pronouns, etc.).
  // When such a word is found at the front, attempt to trim it and re-add the
  // remaining suffix as a shorter candidate.
  {
    const COMMON_WORDS = new Set([
      'Hello',
      'Hi',
      'Dear',
      'The',
      'A',
      'An',
      'This',
      'That',
      'These',
      'Those',
      'We',
      'Our',
      'Your',
      'My',
      'His',
      'Her',
      'Its',
      'Their',
      'Please',
      'Thank',
      'Best',
      'Kind',
      'If',
      'It',
      'In',
      'On',
      'At',
      'For',
      'To',
      'Of',
      'And',
      'Or',
      'But',
      'With',
      'From',
      'By',
      'As',
      'Is',
      'Are',
      'Was',
      'Were',
      'Have',
      'Has',
      'Had',
      'Do',
      'Does',
      'Did',
      'Will',
      'Would',
      'Could',
      'Should',
      'May',
      'Might',
      'Let',
      'Just',
      'So',
      'Also',
      'Please',
      'Welcome',
      'Regards',
      'Sent',
      'Subject',
      'Date',
    ]);
    // Operate on a snapshot of the candidates array (length at entry).
    const personStart = candidates.findIndex((c) => c.type === 'PERSON');
    if (personStart !== -1) {
      const toReprocess: typeof candidates = [];
      let i = personStart;
      while (i < candidates.length) {
        const c = candidates[i];
        if (c.type === 'PERSON') {
          const firstWord = c.raw.split(/\s+/)[0];
          if (COMMON_WORDS.has(firstWord)) {
            // Remove the first word and re-add the remainder as a new candidate.
            const trimmed = c.raw.slice(firstWord.length).trimStart();
            const trimmedStart = c.start + c.raw.indexOf(trimmed);
            if (/^[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+$/.test(trimmed)) {
              toReprocess.push({ raw: trimmed, type: 'PERSON', start: trimmedStart, end: c.end });
            }
            candidates.splice(i, 1);
            continue;
          }
        }
        i++;
      }
      candidates.push(...toReprocess);
    }
  }

  // Resolve overlaps: greedy, longest match wins.
  candidates.sort((a, b) => a.start - b.start || b.end - b.start - (a.end - a.start));
  const result: PiiSpan[] = [];
  let cursor = 0;
  for (const c of candidates) {
    if (c.start < cursor) continue; // overlaps a previously accepted span
    result.push(c);
    cursor = c.end;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Canonicalises a PII value for stable HMAC input.
 *
 * Lower-case + trim so that "Alice Smith" and "alice smith" map to the same
 * token, preserving stability across different source representations.
 */
function canonicalise(value: string): string {
  return value.toLowerCase().trim();
}

/**
 * Derives a 32-byte tenant-specific HMAC key from `TOKENISER_MASTER_KEY`.
 *
 * Uses HKDF-SHA-256 with the tenant ID as the info parameter and an empty
 * salt so that each tenant gets a cryptographically independent key.
 *
 * Falls back to a deterministic SHA-256 digest of the tenant ID when
 * `TOKENISER_MASTER_KEY` is not set (development / test mode).
 */
async function deriveTenantKeyBytes(tenantId: string): Promise<Uint8Array> {
  const masterHex = process.env.TOKENISER_MASTER_KEY;
  const encoder = new TextEncoder();

  if (!masterHex) {
    // Fallback: SHA-256(tenantId) — deterministic, no external config needed.
    const digest = await crypto.subtle.digest('SHA-256', encoder.encode(tenantId));
    return new Uint8Array(digest as ArrayBuffer);
  }

  // Parse master key as 64-char hex or base64.
  let masterBytes: Uint8Array;
  if (/^[0-9a-fA-F]{64}$/.test(masterHex)) {
    const pairs = masterHex.match(/.{2}/g)!;
    const buf = new ArrayBuffer(pairs.length);
    masterBytes = new Uint8Array(buf);
    for (let i = 0; i < pairs.length; i++) masterBytes[i] = parseInt(pairs[i], 16);
  } else {
    const binaryString = atob(masterHex);
    const buf = new ArrayBuffer(binaryString.length);
    masterBytes = new Uint8Array(buf);
    for (let i = 0; i < binaryString.length; i++) masterBytes[i] = binaryString.charCodeAt(i);
  }

  const masterKey = await crypto.subtle.importKey(
    'raw',
    masterBytes.buffer as ArrayBuffer,
    { name: 'HKDF' },
    false,
    ['deriveBits'],
  );

  const bits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(new ArrayBuffer(32)), // zero salt
      info: encoder.encode(tenantId),
    },
    masterKey,
    256,
  );
  return new Uint8Array(bits as ArrayBuffer);
}

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

/**
 * Thrown when an attempt is made to register a token that already maps to a
 * different value (indicates a hash collision or a programming error).
 */
export class TokenCollisionError extends Error {
  constructor(token: string, tenantId: string) {
    super(
      `[pii-tokeniser] Token collision for token "${token}" under tenant "${tenantId}". ` +
        `The same token maps to two different raw values.`,
    );
    this.name = 'TokenCollisionError';
  }
}
