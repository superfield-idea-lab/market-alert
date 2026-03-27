/**
 * @file claude-credentials.ts
 *
 * Claude CLI credential restoration for ephemeral worker containers.
 *
 * On startup, the worker fetches the encrypted auth bundle from the database,
 * decrypts it using the runtime-injected ENCRYPTION_MASTER_KEY, and writes
 * the restored session material to the Claude CLI auth file path so the Claude
 * CLI binary can authenticate when invoked.
 *
 * The Claude CLI reads credentials from `~/.config/anthropic/credentials.json`
 * (or the path overridden by CLAUDE_AUTH_FILE).  The worker writes to that path
 * during startup before any task execution begins.
 *
 * Fail-closed contract
 * ----------------------
 * The worker MUST NOT start if:
 * - No active credential bundle exists for the agent type
 * - The credential bundle has expired or been revoked
 * - Decryption fails (wrong key, corrupted data)
 * - The restored session material cannot be written to disk
 *
 * Security notes
 * ---------------
 * - The encrypted bundle is fetched from the DB at startup only; it is not
 *   cached in memory longer than needed for decryption.
 * - The restored session file is written to a tmpfs path when possible.
 * - ENCRYPTION_MASTER_KEY is never logged or stored.
 * - The auth file is written with mode 0o600 (owner read/write only).
 *
 * Blueprint reference: WORKER domain — WORKER-T-009 (vendor API key leak prevention)
 */

import { mkdir, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import { homedir } from 'os';
import { fetchActiveWorkerCredential } from 'db/worker-credentials';
import { decryptField } from 'core';

/**
 * Default path for the restored Claude CLI auth file.
 *
 * Matches the path the Claude CLI binary reads on startup.
 * Override via CLAUDE_AUTH_FILE env var to redirect to a tmpfs mount.
 */
const CLAUDE_AUTH_FILE =
  process.env.CLAUDE_AUTH_FILE ?? join(homedir(), '.config', 'anthropic', 'credentials.json');

/** Entity type key used for HKDF derivation — scoped to worker credentials. */
const CREDENTIAL_ENTITY_TYPE = 'worker_credential';

export interface ClaudeAuthBundle {
  /** Claude API key (sk-ant-...) */
  api_key: string;
  /** ISO-8601 expiry timestamp (optional) */
  expires_at?: string;
  /** Additional vendor-specific auth fields */
  [key: string]: unknown;
}

/**
 * Restore the Claude CLI session from the encrypted credential bundle stored
 * in the database.
 *
 * Fetches the active bundle for the agent type, decrypts it, validates the
 * structure, and writes the auth file to disk.  Throws on any failure so the
 * worker startup code can call `process.exit(1)`.
 *
 * @param agentType - The agent type name (e.g. "coding"). Used to look up the
 *   credential bundle and included in error messages for diagnostics.
 */
export async function restoreClaudeCredentials(agentType: string): Promise<void> {
  // Fetch the active encrypted bundle
  const credential = await fetchActiveWorkerCredential(agentType);

  if (!credential) {
    throw new Error(
      `No active Claude credential found for agent_type="${agentType}". ` +
        'Store credentials via the admin API before starting workers.',
    );
  }

  // Decrypt the auth bundle
  let plaintext: string;
  try {
    plaintext = await decryptField(CREDENTIAL_ENTITY_TYPE, credential.auth_bundle);
  } catch (err) {
    throw new Error(
      `Failed to decrypt Claude credential bundle for agent_type="${agentType}": ` +
        (err instanceof Error ? err.message : String(err)),
      { cause: err },
    );
  }

  // Parse and validate
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

  // Check token expiry if present
  if (authBundle.expires_at) {
    const expiry = new Date(authBundle.expires_at);
    if (!isNaN(expiry.getTime()) && expiry <= new Date()) {
      throw new Error(
        `Claude credential bundle for agent_type="${agentType}" has expired (expires_at=${authBundle.expires_at}).`,
      );
    }
  }

  // Ensure the target directory exists (e.g. ~/.config/anthropic/)
  const authDir = dirname(CLAUDE_AUTH_FILE);
  try {
    await mkdir(authDir, { recursive: true, mode: 0o700 });
  } catch (err) {
    throw new Error(
      `Failed to create Claude auth directory "${authDir}": ` +
        (err instanceof Error ? err.message : String(err)),
      { cause: err },
    );
  }

  // Write the auth file to the expected location
  try {
    await writeFile(CLAUDE_AUTH_FILE, JSON.stringify(authBundle), { mode: 0o600 });
  } catch (err) {
    throw new Error(
      `Failed to write Claude auth file to "${CLAUDE_AUTH_FILE}": ` +
        (err instanceof Error ? err.message : String(err)),
      { cause: err },
    );
  }

  console.log(
    `[credentials] Claude CLI auth restored for agent_type="${agentType}" → ${CLAUDE_AUTH_FILE}`,
  );
}
