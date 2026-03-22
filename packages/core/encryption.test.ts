import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  _resetEncryptionCaches,
  decryptField,
  decryptProperties,
  encryptField,
  encryptProperties,
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
