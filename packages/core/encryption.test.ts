import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  _resetEncryptionCaches,
  assertEncryptedBeforeWrite,
  decryptField,
  decryptProperties,
  ENTITY_SENSITIVITY_CLASS,
  encryptField,
  encryptProperties,
  PlaintextWriteError,
  SENSITIVE_FIELDS,
} from './encryption';

// A deterministic 32-byte key expressed as 64 hex characters.
const TEST_MASTER_KEY = 'a'.repeat(64);

function setEncryptionEnabled() {
  process.env.ENCRYPTION_MASTER_KEY = TEST_MASTER_KEY;
  delete process.env.ENCRYPTION_DISABLED;
  _resetEncryptionCaches();
}

function setEncryptionDisabled() {
  delete process.env.ENCRYPTION_MASTER_KEY;
  _resetEncryptionCaches();
}

afterEach(() => {
  delete process.env.ENCRYPTION_MASTER_KEY;
  delete process.env.ENCRYPTION_DISABLED;
  _resetEncryptionCaches();
});

describe('SENSITIVE_FIELDS registry', () => {
  test('user entity lists display_name and email', () => {
    expect(SENSITIVE_FIELDS.user).toContain('display_name');
    expect(SENSITIVE_FIELDS.user).toContain('email');
  });

  // PRD §7 — HIGH sensitivity class
  test('corpus_chunk entity lists body', () => {
    expect(SENSITIVE_FIELDS.corpus_chunk).toContain('body');
  });

  test('email entity lists subject and body', () => {
    expect(SENSITIVE_FIELDS.email).toContain('subject');
    expect(SENSITIVE_FIELDS.email).toContain('body');
  });

  test('transcript entity lists body', () => {
    expect(SENSITIVE_FIELDS.transcript).toContain('body');
  });

  test('wiki_page entity lists content', () => {
    expect(SENSITIVE_FIELDS.wiki_page).toContain('content');
  });

  test('wiki_page_version entity lists content', () => {
    expect(SENSITIVE_FIELDS.wiki_page_version).toContain('content');
  });

  test('crm_note entity lists body', () => {
    expect(SENSITIVE_FIELDS.crm_note).toContain('body');
  });

  // PRD §7 — CRM sensitivity class
  test('customer entity lists name', () => {
    expect(SENSITIVE_FIELDS.customer).toContain('name');
  });

  // PRD §7 — INTEREST sensitivity class
  test('customer_interest entity lists tags', () => {
    expect(SENSITIVE_FIELDS.customer_interest).toContain('tags');
  });

  // PRD §7 — IDENTITY sensitivity class (disjoint key domain)
  test('identity_token entity lists real_name, real_email, real_org', () => {
    expect(SENSITIVE_FIELDS.identity_token).toContain('real_name');
    expect(SENSITIVE_FIELDS.identity_token).toContain('real_email');
    expect(SENSITIVE_FIELDS.identity_token).toContain('real_org');
  });

  // PRD §7 — CREDENTIAL sensitivity class
  test('recovery_shard entity lists shard_data', () => {
    expect(SENSITIVE_FIELDS.recovery_shard).toContain('shard_data');
  });
});

describe('ENTITY_SENSITIVITY_CLASS registry', () => {
  test('identity_token maps to IDENTITY class', () => {
    expect(ENTITY_SENSITIVITY_CLASS.identity_token).toBe('IDENTITY');
  });

  test('recovery_shard maps to CREDENTIAL class', () => {
    expect(ENTITY_SENSITIVITY_CLASS.recovery_shard).toBe('CREDENTIAL');
  });

  test('corpus_chunk, transcript, wiki_page, crm_note map to HIGH', () => {
    expect(ENTITY_SENSITIVITY_CLASS.corpus_chunk).toBe('HIGH');
    expect(ENTITY_SENSITIVITY_CLASS.transcript).toBe('HIGH');
    expect(ENTITY_SENSITIVITY_CLASS.wiki_page).toBe('HIGH');
    expect(ENTITY_SENSITIVITY_CLASS.crm_note).toBe('HIGH');
  });

  test('customer maps to CRM', () => {
    expect(ENTITY_SENSITIVITY_CLASS.customer).toBe('CRM');
  });

  test('user maps to OPERATIONAL', () => {
    expect(ENTITY_SENSITIVITY_CLASS.user).toBe('OPERATIONAL');
  });
});

describe('encryptField / decryptField', () => {
  beforeEach(setEncryptionEnabled);

  test('produces enc:v1: prefixed ciphertext', async () => {
    const cipher = await encryptField('user', 'alice@example.com');
    expect(cipher).toMatch(/^enc:v1:/);
  });

  test('roundtrip: decrypt(encrypt(plain)) === plain', async () => {
    const plain = 'hello world';
    const cipher = await encryptField('user', plain);
    const recovered = await decryptField('user', cipher);
    expect(recovered).toBe(plain);
  });

  test('produces different ciphertext each call (random IV)', async () => {
    const plain = 'same plaintext';
    const c1 = await encryptField('user', plain);
    const c2 = await encryptField('user', plain);
    expect(c1).not.toBe(c2);
    // Both must decrypt to the same plaintext
    expect(await decryptField('user', c1)).toBe(plain);
    expect(await decryptField('user', c2)).toBe(plain);
  });

  test('decryptField passes through values that do not start with enc:v1:', async () => {
    const plain = 'not encrypted';
    const result = await decryptField('user', plain);
    expect(result).toBe(plain);
  });

  test('different entity types yield different ciphertexts for same plaintext', async () => {
    const plain = 'sensitive';
    const c1 = await encryptField('user', plain);
    const c2 = await encryptField('task', plain);
    // Decrypt with the correct entity type must succeed
    expect(await decryptField('user', c1)).toBe(plain);
    expect(await decryptField('task', c2)).toBe(plain);
    // Cross-type decryption must fail or produce garbage (not the original plain)
    await expect(decryptField('task', c1)).rejects.toThrow();
  });
});

describe('graceful degradation — encryption disabled', () => {
  beforeEach(setEncryptionDisabled);

  test('encryptField returns plaintext when ENCRYPTION_MASTER_KEY absent', async () => {
    const plain = 'alice@example.com';
    expect(await encryptField('user', plain)).toBe(plain);
  });

  test('decryptField returns value unchanged when ENCRYPTION_MASTER_KEY absent', async () => {
    const value = 'enc:v1:somebase64:morebytes';
    expect(await decryptField('user', value)).toBe(value);
  });

  test('ENCRYPTION_DISABLED=true disables encryption even with master key set', async () => {
    process.env.ENCRYPTION_MASTER_KEY = TEST_MASTER_KEY;
    process.env.ENCRYPTION_DISABLED = 'true';
    _resetEncryptionCaches();
    const plain = 'secret';
    expect(await encryptField('user', plain)).toBe(plain);
  });
});

describe('encryptProperties / decryptProperties', () => {
  beforeEach(setEncryptionEnabled);

  test('encrypts only sensitive fields for user entity', async () => {
    const record = { display_name: 'Alice', email: 'alice@example.com', username: 'alice' };
    const encrypted = await encryptProperties('user', record);
    expect(encrypted.username).toBe('alice');
    expect(typeof encrypted.display_name).toBe('string');
    expect((encrypted.display_name as string).startsWith('enc:v1:')).toBe(true);
    expect(typeof encrypted.email).toBe('string');
    expect((encrypted.email as string).startsWith('enc:v1:')).toBe(true);
  });

  test('roundtrip: decryptProperties(encryptProperties(record)) deep equals original', async () => {
    const record = { display_name: 'Bob', email: 'bob@example.com', username: 'bob' };
    const encrypted = await encryptProperties('user', record);
    const decrypted = await decryptProperties('user', encrypted);
    expect(decrypted).toEqual(record);
  });

  test('non-sensitive entity type passes record through unchanged', async () => {
    const record = { name: 'My Task', status: 'todo' };
    const encrypted = await encryptProperties('task', record);
    expect(encrypted).toEqual(record);
  });

  test('passes record through unchanged when encryption disabled', async () => {
    setEncryptionDisabled();
    const record = { display_name: 'Carol', email: 'carol@example.com' };
    const encrypted = await encryptProperties('user', record);
    expect(encrypted).toEqual(record);
  });

  test('does not mutate the original record', async () => {
    const record = { display_name: 'Dave', email: 'dave@example.com' };
    const original = { ...record };
    await encryptProperties('user', record);
    expect(record).toEqual(original);
  });
});

// ---------------------------------------------------------------------------
// PRD §7 — round-trip tests for each sensitive column class
// ---------------------------------------------------------------------------

describe('PRD §7 — round-trip for each sensitive column class', () => {
  beforeEach(setEncryptionEnabled);

  const cases: Array<{ entityType: string; field: string; sample: string }> = [
    // HIGH
    { entityType: 'corpus_chunk', field: 'body', sample: 'Anonymised corpus body text.' },
    { entityType: 'email', field: 'subject', sample: 'Re: Q3 portfolio review' },
    { entityType: 'email', field: 'body', sample: 'Please see the attached report.' },
    {
      entityType: 'transcript',
      field: 'body',
      sample: '[CUST_7f3a]: We want to increase exposure.',
    },
    {
      entityType: 'wiki_page',
      field: 'content',
      sample: '# Customer overview\n\nInterested in bonds.',
    },
    { entityType: 'wiki_page_version', field: 'content', sample: 'Historical snapshot v3.' },
    { entityType: 'crm_note', field: 'body', sample: 'Client asked about rebalancing.' },
    // CRM
    { entityType: 'customer', field: 'name', sample: 'CUST_7f3a' },
    // INTEREST
    { entityType: 'customer_interest', field: 'tags', sample: 'fixed-income,bond-ladder' },
    // IDENTITY (disjoint key domain)
    { entityType: 'identity_token', field: 'real_name', sample: 'Jane Smith' },
    { entityType: 'identity_token', field: 'real_email', sample: 'jane.smith@bigfund.com' },
    { entityType: 'identity_token', field: 'real_org', sample: 'BigFund Asset Management' },
    // CREDENTIAL
    { entityType: 'recovery_shard', field: 'shard_data', sample: 'aabbccddeeff00112233' },
    // OPERATIONAL
    { entityType: 'user', field: 'display_name', sample: 'Alice RM' },
    { entityType: 'user', field: 'email', sample: 'alice@firm.com' },
  ];

  for (const { entityType, field, sample } of cases) {
    test(`${entityType}.${field}: ciphertext at rest, plaintext on read`, async () => {
      const record: Record<string, unknown> = { [field]: sample, other: 'unchanged' };
      const encrypted = await encryptProperties(entityType, record);

      // ciphertext at rest
      expect(typeof encrypted[field]).toBe('string');
      expect((encrypted[field] as string).startsWith('enc:v1:')).toBe(true);

      // non-sensitive fields untouched
      expect(encrypted.other).toBe('unchanged');

      // plaintext on read
      const decrypted = await decryptProperties(entityType, encrypted);
      expect(decrypted[field]).toBe(sample);
    });
  }
});

// ---------------------------------------------------------------------------
// Key-domain isolation — IDENTITY keys must be disjoint from HIGH keys
// ---------------------------------------------------------------------------

describe('key-domain isolation', () => {
  beforeEach(setEncryptionEnabled);

  test('corpus_chunk and identity_token use different keys (cross-decrypt fails)', async () => {
    const plain = 'sensitive value';
    const corpusCipher = await encryptField('corpus_chunk', plain);
    // Attempting to decrypt corpus_chunk ciphertext with identity_token key must fail
    await expect(decryptField('identity_token', corpusCipher)).rejects.toThrow();
  });

  test('recovery_shard key is disjoint from HIGH key domain', async () => {
    const plain = 'shard payload';
    const shardCipher = await encryptField('recovery_shard', plain);
    await expect(decryptField('corpus_chunk', shardCipher)).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// assertEncryptedBeforeWrite — plaintext write guard
// ---------------------------------------------------------------------------

describe('assertEncryptedBeforeWrite', () => {
  beforeEach(setEncryptionEnabled);

  test('throws PlaintextWriteError when a sensitive field contains plaintext', () => {
    const record = { body: 'plaintext corpus content', other: 'safe' };
    expect(() => assertEncryptedBeforeWrite('corpus_chunk', record)).toThrow(PlaintextWriteError);
  });

  test('throws PlaintextWriteError for identity_token plaintext fields', () => {
    const record = { real_name: 'Jane Smith' };
    expect(() => assertEncryptedBeforeWrite('identity_token', record)).toThrow(PlaintextWriteError);
  });

  test('does not throw when sensitive fields carry enc:v1: prefix', async () => {
    const record = { body: await encryptField('corpus_chunk', 'secret text') };
    expect(() => assertEncryptedBeforeWrite('corpus_chunk', record)).not.toThrow();
  });

  test('does not throw when record has no sensitive fields', () => {
    const record = { status: 'pending', priority: 3 };
    expect(() => assertEncryptedBeforeWrite('corpus_chunk', record)).not.toThrow();
  });

  test('is a no-op when encryption is disabled', () => {
    setEncryptionDisabled();
    const record = { body: 'unencrypted plaintext' };
    expect(() => assertEncryptedBeforeWrite('corpus_chunk', record)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Log scrubbing — sensitive field values must be redacted in logs
// ---------------------------------------------------------------------------

describe('log scrubbing — PRD §7 sensitive fields are redacted', () => {
  test('scrubPii redacts body, subject, content, tags, shard_data and identity fields', async () => {
    const { scrubPii } = await import('./scrub-pii');
    const record = {
      body: 'corpus text',
      subject: 'email subject',
      content: 'wiki content',
      tags: 'interest-tag',
      shard_data: 'shard bytes',
      real_name: 'Jane Smith',
      real_email: 'jane@example.com',
      real_org: 'Org Ltd',
      safe_field: 'not redacted',
    };
    const scrubbed = scrubPii(record) as Record<string, unknown>;
    expect(scrubbed.body).toBe('[REDACTED]');
    expect(scrubbed.subject).toBe('[REDACTED]');
    expect(scrubbed.content).toBe('[REDACTED]');
    expect(scrubbed.tags).toBe('[REDACTED]');
    expect(scrubbed.shard_data).toBe('[REDACTED]');
    expect(scrubbed.real_name).toBe('[REDACTED]');
    expect(scrubbed.real_email).toBe('[REDACTED]');
    expect(scrubbed.real_org).toBe('[REDACTED]');
    expect(scrubbed.safe_field).toBe('not redacted');
  });
});
