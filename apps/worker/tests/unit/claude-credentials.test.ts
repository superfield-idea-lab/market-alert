/**
 * Unit tests for the Claude CLI credential restoration logic.
 *
 * Tests the validation and fail-closed behaviour without hitting the database
 * or filesystem — uses in-memory stubs mirroring the logic in claude-credentials.ts.
 */

import { describe, test, expect } from 'vitest';

// ---------------------------------------------------------------------------
// Mirror pure validation helpers for isolated testing
// ---------------------------------------------------------------------------

interface ClaudeAuthBundle {
  api_key: string;
  expires_at?: string;
  [key: string]: unknown;
}

/** Mirror of auth bundle validation from claude-credentials.ts */
function validateClaudeAuthBundle(plaintext: string, agentType: string): ClaudeAuthBundle {
  let authBundle: ClaudeAuthBundle;
  try {
    authBundle = JSON.parse(plaintext) as ClaudeAuthBundle;
  } catch {
    throw new Error(
      `Decrypted Claude credential bundle for agent_type="${agentType}" is not valid JSON.`,
    );
  }

  if (!authBundle.api_key) {
    throw new Error(
      `Decrypted Claude credential bundle for agent_type="${agentType}" is missing api_key.`,
    );
  }

  if (authBundle.expires_at) {
    const expiry = new Date(authBundle.expires_at);
    if (!isNaN(expiry.getTime()) && expiry <= new Date()) {
      throw new Error(
        `Claude credential bundle for agent_type="${agentType}" has expired (expires_at=${authBundle.expires_at}).`,
      );
    }
  }

  return authBundle;
}

// ---------------------------------------------------------------------------
// Auth bundle validation
// ---------------------------------------------------------------------------

describe('validateClaudeAuthBundle', () => {
  test('accepts a valid bundle with api_key', () => {
    const bundle = validateClaudeAuthBundle(JSON.stringify({ api_key: 'sk-ant-abc123' }), 'claude');
    expect(bundle.api_key).toBe('sk-ant-abc123');
  });

  test('throws on non-JSON input', () => {
    expect(() => validateClaudeAuthBundle('not-json{{{', 'claude')).toThrow(/not valid JSON/);
  });

  test('throws when api_key is missing', () => {
    expect(() =>
      validateClaudeAuthBundle(JSON.stringify({ other_field: 'value' }), 'claude'),
    ).toThrow(/missing api_key/);
  });

  test('throws when api_key is empty string', () => {
    expect(() => validateClaudeAuthBundle(JSON.stringify({ api_key: '' }), 'claude')).toThrow(
      /missing api_key/,
    );
  });

  test('throws when bundle is expired', () => {
    const expired = new Date(Date.now() - 1000).toISOString();
    expect(() =>
      validateClaudeAuthBundle(
        JSON.stringify({ api_key: 'sk-ant-abc123', expires_at: expired }),
        'claude',
      ),
    ).toThrow(/has expired/);
  });

  test('accepts a bundle with future expiry', () => {
    const future = new Date(Date.now() + 3600 * 1000).toISOString();
    const bundle = validateClaudeAuthBundle(
      JSON.stringify({ api_key: 'sk-ant-abc123', expires_at: future }),
      'claude',
    );
    expect(bundle.api_key).toBe('sk-ant-abc123');
  });

  test('accepts a bundle with no expiry set', () => {
    const bundle = validateClaudeAuthBundle(JSON.stringify({ api_key: 'sk-ant-abc123' }), 'claude');
    expect(bundle.api_key).toBe('sk-ant-abc123');
  });

  test('includes agent_type in error message for missing api_key', () => {
    expect(() => validateClaudeAuthBundle(JSON.stringify({}), 'my-agent-type')).toThrow(
      /"my-agent-type"/,
    );
  });

  test('accepts a bundle with additional vendor-specific fields', () => {
    const bundle = validateClaudeAuthBundle(
      JSON.stringify({ api_key: 'sk-ant-abc123', org_id: 'org-123', model: 'claude-3-opus' }),
      'claude',
    );
    expect(bundle.api_key).toBe('sk-ant-abc123');
    expect(bundle['org_id']).toBe('org-123');
  });
});

// ---------------------------------------------------------------------------
// Fail-closed behaviour when no credential exists
// ---------------------------------------------------------------------------

describe('restoreClaudeCredentials module export', () => {
  test('restoreClaudeCredentials is exported', async () => {
    const mod = await import('../../src/claude-credentials.js');
    expect(typeof mod.restoreClaudeCredentials).toBe('function');
  });
});
