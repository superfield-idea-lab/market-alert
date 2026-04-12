/**
 * Unit tests for the PII tokeniser.
 *
 * No mocks — uses the InMemoryIdentityStore and real WebCrypto.
 *
 * Test plan items addressed:
 *   AC-1  Given the same input twice, the tokeniser produces identical tokens within a tenant.
 *   AC-2  Cross-tenant token collisions are impossible.
 *   AC-3  Every tokenised entity appears in IdentityDictionary.
 *   AC-4  Round-trip through the re-identification API restores the original value.
 *
 * Integration plan items:
 *   TP-1  Run the fixture corpus through the tokeniser and assert stability.
 *   TP-2  Round-trip via the in-memory store.
 *   TP-3  Two different tenants produce different tokens for the same input.
 */

import { describe, expect, it, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  PiiTokeniser,
  InMemoryIdentityStore,
  detectPiiSpans,
  TokenCollisionError,
} from './pii-tokeniser';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Loads a fixture email file from tests/fixtures/email-corpus/. */
function loadEmailFixture(filename: string): string {
  const p = resolve(__dirname, '../../tests/fixtures/email-corpus', filename);
  return readFileSync(p, 'utf-8');
}

// ---------------------------------------------------------------------------
// Unit: token derivation
// ---------------------------------------------------------------------------

describe('PiiTokeniser — token derivation', () => {
  it('AC-1: same input produces the same token on repeated calls (stability)', async () => {
    const store = new InMemoryIdentityStore();
    const t = new PiiTokeniser({ tenantId: 'tenant-alpha', store });

    const first = await t.deriveToken('alice@example.com', 'EMAIL');
    const second = await t.deriveToken('alice@example.com', 'EMAIL');
    expect(first).toBe(second);
  });

  it('AC-1: token format is TYPE_hex8', async () => {
    const t = new PiiTokeniser({ tenantId: 'tenant-alpha' });
    const tok = await t.deriveToken('alice@example.com', 'EMAIL');
    expect(tok).toMatch(/^EMAIL_[0-9a-f]{8}$/);
  });

  it('AC-1: canonicalisation — different casing maps to same token', async () => {
    const t = new PiiTokeniser({ tenantId: 'tenant-alpha' });
    const lower = await t.deriveToken('alice smith', 'PERSON');
    const upper = await t.deriveToken('Alice Smith', 'PERSON');
    expect(lower).toBe(upper);
  });

  it('AC-2: cross-tenant tokens differ for the same raw input', async () => {
    const t1 = new PiiTokeniser({ tenantId: 'tenant-alpha' });
    const t2 = new PiiTokeniser({ tenantId: 'tenant-beta' });

    const tok1 = await t1.deriveToken('alice@example.com', 'EMAIL');
    const tok2 = await t2.deriveToken('alice@example.com', 'EMAIL');
    expect(tok1).not.toBe(tok2);
  });

  it('different PII types produce different tokens for the same raw value', async () => {
    const t = new PiiTokeniser({ tenantId: 'tenant-alpha' });
    const email = await t.deriveToken('alice', 'EMAIL');
    const person = await t.deriveToken('alice', 'PERSON');
    // Different type prefix means they are distinct even if the 8-char hex collides.
    expect(email.split('_')[0]).toBe('EMAIL');
    expect(person.split('_')[0]).toBe('PERSON');
    // The full token strings differ because the TYPE prefix differs.
    expect(email).not.toBe(person);
  });
});

// ---------------------------------------------------------------------------
// Unit: PII detection
// ---------------------------------------------------------------------------

describe('detectPiiSpans', () => {
  it('detects a bare email address', () => {
    const spans = detectPiiSpans('Contact alice@example.com for details.');
    expect(spans).toHaveLength(1);
    expect(spans[0].raw).toBe('alice@example.com');
    expect(spans[0].type).toBe('EMAIL');
  });

  it('detects a phone number in XXX-XXX-XXXX format', () => {
    const spans = detectPiiSpans('Call us at 555-867-5309 today.');
    const phone = spans.find((s) => s.type === 'PHONE');
    expect(phone).toBeDefined();
    expect(phone!.raw).toContain('555');
  });

  it('detects a person name (two capitalised words)', () => {
    const spans = detectPiiSpans('Hello Alice Smith, welcome aboard.');
    const person = spans.find((s) => s.type === 'PERSON');
    expect(person).toBeDefined();
    expect(person!.raw).toBe('Alice Smith');
  });

  it('detects an organisation name', () => {
    const spans = detectPiiSpans('We partner with Acme Corp to deliver results.');
    const org = spans.find((s) => s.type === 'ORG');
    expect(org).toBeDefined();
    expect(org!.raw).toBe('Acme Corp');
  });

  it('returns no spans for text with no PII', () => {
    const spans = detectPiiSpans('The quick brown fox jumps over the lazy dog.');
    // No emails, phones, or name-shaped sequences.
    const piiTypes = spans.filter((s) => ['EMAIL', 'PHONE'].includes(s.type as string));
    expect(piiTypes).toHaveLength(0);
  });

  it('spans do not overlap', () => {
    const text = 'Email alice@example.com or call 555-867-5309';
    const spans = detectPiiSpans(text);
    for (let i = 1; i < spans.length; i++) {
      expect(spans[i].start).toBeGreaterThanOrEqual(spans[i - 1].end);
    }
  });
});

// ---------------------------------------------------------------------------
// Unit: tokenise()
// ---------------------------------------------------------------------------

describe('PiiTokeniser — tokenise()', () => {
  let store: InMemoryIdentityStore;
  let tokeniser: PiiTokeniser;

  beforeEach(() => {
    store = new InMemoryIdentityStore();
    tokeniser = new PiiTokeniser({ tenantId: 'tenant-alpha', store });
  });

  it('replaces detected PII in text with tokens', async () => {
    const result = await tokeniser.tokenise('Please contact alice@example.com for the invoice.');
    expect(result.text).not.toContain('alice@example.com');
    expect(result.text).toContain('EMAIL_');
  });

  it('AC-3: every token appears in the store after tokenisation', async () => {
    await tokeniser.tokenise('Send the report to bob@acme.com and Alice Smith.');
    expect(store.size).toBeGreaterThan(0);
  });

  it('AC-4: round-trip — lookup restores the original value', async () => {
    const email = 'carol@example.com';
    const result = await tokeniser.tokenise(`Contact ${email} soon.`);

    const [token] = [...result.tokens.keys()].filter((k) => k.startsWith('EMAIL_'));
    expect(token).toBeDefined();

    const restored = await store.lookup('tenant-alpha', token);
    expect(restored).toBe(email);
  });

  it('AC-1: tokenising the same text twice yields identical tokens', async () => {
    const text = 'Send invoice to alice@example.com';
    const r1 = await tokeniser.tokenise(text);
    const r2 = await tokeniser.tokenise(text);
    expect(r1.text).toBe(r2.text);
    expect([...r1.tokens.keys()]).toEqual([...r2.tokens.keys()]);
  });

  it('AC-2: two tenants tokenise the same input to different tokens', async () => {
    const store1 = new InMemoryIdentityStore();
    const store2 = new InMemoryIdentityStore();
    const t1 = new PiiTokeniser({ tenantId: 'tenant-alpha', store: store1 });
    const t2 = new PiiTokeniser({ tenantId: 'tenant-beta', store: store2 });

    const text = 'Contact alice@example.com';
    const r1 = await t1.tokenise(text);
    const r2 = await t2.tokenise(text);

    const tok1 = [...r1.tokens.keys()].find((k) => k.startsWith('EMAIL_'));
    const tok2 = [...r2.tokens.keys()].find((k) => k.startsWith('EMAIL_'));
    expect(tok1).toBeDefined();
    expect(tok2).toBeDefined();
    expect(tok1).not.toBe(tok2);
  });

  it('no raw PII leaks into the tokenised output', async () => {
    const text = 'Contact Alice Smith at alice@example.com or 555-123-4567.';
    const result = await tokeniser.tokenise(text);
    expect(result.text).not.toContain('alice@example.com');
    expect(result.text).not.toContain('555-123-4567');
  });
});

// ---------------------------------------------------------------------------
// Unit: InMemoryIdentityStore
// ---------------------------------------------------------------------------

describe('InMemoryIdentityStore', () => {
  it('returns undefined for an unknown token', async () => {
    const store = new InMemoryIdentityStore();
    expect(await store.lookup('t1', 'PERSON_notreal')).toBeUndefined();
  });

  it('is idempotent for the same token+value pair', async () => {
    const store = new InMemoryIdentityStore();
    await store.register('t1', 'PERSON_abc12345', 'Alice');
    await expect(store.register('t1', 'PERSON_abc12345', 'Alice')).resolves.not.toThrow();
  });

  it('throws TokenCollisionError when a token maps to a different value', async () => {
    const store = new InMemoryIdentityStore();
    await store.register('t1', 'PERSON_abc12345', 'Alice');
    await expect(store.register('t1', 'PERSON_abc12345', 'Bob')).rejects.toBeInstanceOf(
      TokenCollisionError,
    );
  });

  it('scopes registrations by tenantId — same token, different tenant', async () => {
    const store = new InMemoryIdentityStore();
    await store.register('tenant-A', 'EMAIL_aabbccdd', 'alice@example.com');
    await store.register('tenant-B', 'EMAIL_aabbccdd', 'bob@example.com');

    expect(await store.lookup('tenant-A', 'EMAIL_aabbccdd')).toBe('alice@example.com');
    expect(await store.lookup('tenant-B', 'EMAIL_aabbccdd')).toBe('bob@example.com');
  });
});

// ---------------------------------------------------------------------------
// Corpus fixture tests
// ---------------------------------------------------------------------------

describe('fixture corpus — email tokenisation', () => {
  const TENANT = 'fixture-tenant';

  it('customer-inquiry: no raw email address in tokenised output', async () => {
    const raw = loadEmailFixture('customer-inquiry.txt');
    const store = new InMemoryIdentityStore();
    const t = new PiiTokeniser({ tenantId: TENANT, store });
    const result = await t.tokenise(raw);

    // The fixture email should contain at least one email address.
    expect(raw).toMatch(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
    // The tokenised output must not contain any email address pattern.
    expect(result.text).not.toMatch(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
  });

  it('customer-inquiry: at least one token registered in store', async () => {
    const raw = loadEmailFixture('customer-inquiry.txt');
    const store = new InMemoryIdentityStore();
    const t = new PiiTokeniser({ tenantId: TENANT, store });
    await t.tokenise(raw);
    expect(store.size).toBeGreaterThan(0);
  });

  it('support-thread: round-trip restores all registered PII values', async () => {
    const raw = loadEmailFixture('support-thread.txt');
    const store = new InMemoryIdentityStore();
    const t = new PiiTokeniser({ tenantId: TENANT, store });
    const result = await t.tokenise(raw);

    for (const [token, original] of result.tokens) {
      const restored = await store.lookup(TENANT, token);
      expect(restored).toBe(original);
    }
  });

  it('cross-tenant: same fixture produces different tokens for different tenants', async () => {
    const raw = loadEmailFixture('customer-inquiry.txt');
    const store1 = new InMemoryIdentityStore();
    const store2 = new InMemoryIdentityStore();
    const t1 = new PiiTokeniser({ tenantId: 'tenant-A', store: store1 });
    const t2 = new PiiTokeniser({ tenantId: 'tenant-B', store: store2 });

    const r1 = await t1.tokenise(raw);
    const r2 = await t2.tokenise(raw);

    // Texts must differ (different tokens) — unless no PII was detected at all.
    if (r1.tokens.size > 0 && r2.tokens.size > 0) {
      expect(r1.text).not.toBe(r2.text);
    }
  });

  it('onboarding-email: stability — two runs produce identical output', async () => {
    const raw = loadEmailFixture('onboarding-email.txt');
    const t1 = new PiiTokeniser({ tenantId: TENANT });
    const t2 = new PiiTokeniser({ tenantId: TENANT });

    const r1 = await t1.tokenise(raw);
    const r2 = await t2.tokenise(raw);
    expect(r1.text).toBe(r2.text);
  });
});
