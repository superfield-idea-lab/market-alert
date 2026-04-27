/**
 * @file claude-cli.ts
 *
 * Claude CLI invocation for the worker container.
 *
 * This module provides the integration layer between the Superfield task queue
 * and the Claude CLI binary. The worker passes each task payload as JSON on
 * stdin and reads a structured JSON result from stdout.
 *
 * ## Environment variables
 *
 * - `CLAUDE_CLI_PATH` — absolute path to the Claude CLI binary.
 *   When unset, the worker falls back to the dev stub (see `DEV_STUB_FALLBACK`).
 *   When set, the path is validated at module load time (accessible, executable).
 *
 * ## Stdin / stdout JSON contract
 *
 * **stdin**: The full task payload object serialised as a single-line JSON string,
 * terminated by EOF. The Claude CLI binary must read from stdin and exit 0 after
 * emitting the result.
 *
 * **stdout**: A single JSON object. The worker requires at minimum:
 *   - `result` (string) — human-readable summary of what was done.
 *   - `status` (string, optional) — "completed" | "failed".
 *   Additional fields are forwarded as-is to the result store.
 *
 * **stderr**: Forwarded to the worker log at DEBUG level. Not parsed.
 *
 * ## Error handling
 *
 * | Scenario                        | Behaviour                                            |
 * |---------------------------------|------------------------------------------------------|
 * | CLI exits non-zero              | Throws `ClaudeCliError` with exit code + stderr tail |
 * | stdout is not valid JSON        | Throws `ClaudeCliOutputError`                        |
 * | CLI exceeds `timeoutMs`         | SIGKILL the child, throws `ClaudeCliTimeoutError`    |
 * | `CLAUDE_CLI_PATH` binary absent | `validateClaudeCliPath` throws at startup            |
 * | `CLAUDE_CLI_PATH` unset         | `invokeCli` uses the dev stub; see `DEV_STUB_FALLBACK`|
 *
 * ## Dev stub fallback
 *
 * When `CLAUDE_CLI_PATH` is unset the worker uses the embedded JS stub so the
 * full queue-claim → execution → result-submit cycle is exercisable in local
 * dev without installing the real CLI. The stub echoes the task payload and
 * returns a mock `result` string.
 *
 * Blueprint reference: WORKER domain — WORKER-C-002 (no-shell subprocess)
 */

import { spawn } from 'child_process';
import { access, constants } from 'fs/promises';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Default CLI invocation timeout in milliseconds (10 minutes).
 *
 * This fallback applies only when `invokeCli` is called without an explicit
 * `timeoutMs` and no agent-type timeout has been configured via environment
 * variables. Production callers should always pass the timeout resolved by
 * `resolveAgentTimeoutMs` from the `timeout` module.
 */
export const DEFAULT_CLI_TIMEOUT_MS = 600_000;

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

/** The Claude CLI exited with a non-zero exit code. */
export class ClaudeCliError extends Error {
  constructor(
    public readonly exitCode: number | null,
    public readonly stderrTail: string,
  ) {
    super(`Claude CLI exited ${exitCode}: ${stderrTail.slice(0, 500)}`);
    this.name = 'ClaudeCliError';
  }
}

/** The Claude CLI stdout could not be parsed as JSON. */
export class ClaudeCliOutputError extends Error {
  constructor(public readonly rawOutput: string) {
    super(`Claude CLI output is not valid JSON: ${rawOutput.slice(0, 500)}`);
    this.name = 'ClaudeCliOutputError';
  }
}

/** The Claude CLI exceeded the configured timeout. */
export class ClaudeCliTimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`Claude CLI exceeded timeout of ${timeoutMs}ms`);
    this.name = 'ClaudeCliTimeoutError';
  }
}

// ---------------------------------------------------------------------------
// Path validation
// ---------------------------------------------------------------------------

/**
 * Validate that the Claude CLI binary at `cliPath` exists and is executable.
 *
 * Called once at worker startup when `CLAUDE_CLI_PATH` is set. Throws a
 * descriptive Error so the process can exit(1) with a clear message rather
 * than failing silently on the first task.
 *
 * @param cliPath - Absolute path to the Claude CLI binary.
 * @throws {Error} If the binary does not exist or is not executable.
 */
export async function validateClaudeCliPath(cliPath: string): Promise<void> {
  try {
    await access(cliPath, constants.F_OK | constants.X_OK);
  } catch {
    throw new Error(
      `CLAUDE_CLI_PATH="${cliPath}" is not accessible or not executable. ` +
        'Ensure the Claude CLI binary is installed at the configured path.',
    );
  }
}

// ---------------------------------------------------------------------------
// Dev stub
// ---------------------------------------------------------------------------

/**
 * In-process dev stub used when `CLAUDE_CLI_PATH` is unset.
 *
 * Returns a mock result that exercises the full stdin/stdout JSON contract
 * without spawning a real binary. Safe for local development; must never be
 * used in production (guarded by the env var check in `invokeCli`).
 */
export function devStubInvoke(taskPayload: unknown): Record<string, unknown> {
  const payload = taskPayload as Record<string, unknown>;
  const taskId = typeof payload['id'] === 'string' ? payload['id'] : 'unknown';
  console.error(`[claude-cli-stub] Received task payload for task_id=${taskId}`);
  console.error('[claude-cli-stub] Returning mock result (dev stub — no real CLI)');
  return {
    result: `[dev] Claude CLI stub executed successfully for task ${taskId}`,
    status: 'completed',
    stub: true,
  };
}

// ---------------------------------------------------------------------------
// CLI invocation
// ---------------------------------------------------------------------------

export interface InvokeCliOptions {
  /** Absolute path to the Claude CLI binary. When empty/undefined, dev stub is used. */
  cliPath?: string;
  /** Task payload passed as JSON on stdin. */
  taskPayload: unknown;
  /** Maximum ms to wait for the CLI to exit. Default: DEFAULT_CLI_TIMEOUT_MS. */
  timeoutMs?: number;
  /**
   * Grace period in milliseconds between SIGTERM and SIGKILL.
   * When the timeout fires, SIGTERM is sent first. If the process has not
   * exited after this duration, SIGKILL is sent.
   * Default: 5 000 ms.
   */
  sigtermGraceMs?: number;
}

/**
 * Invoke the Claude CLI as a subprocess (no shell) and return the parsed
 * JSON result from stdout.
 *
 * When `cliPath` is falsy the in-process dev stub is used instead, allowing
 * the full enqueue → claim → execute → submit cycle to work in local dev.
 *
 * @throws {ClaudeCliError}        CLI exited non-zero.
 * @throws {ClaudeCliOutputError}  CLI stdout was not valid JSON.
 * @throws {ClaudeCliTimeoutError} CLI exceeded `timeoutMs`.
 */
export async function invokeCli(options: InvokeCliOptions): Promise<Record<string, unknown>> {
  const {
    cliPath,
    taskPayload,
    timeoutMs = DEFAULT_CLI_TIMEOUT_MS,
    sigtermGraceMs = 5_000,
  } = options;

  // Fall back to dev stub when no CLI path is configured.
  if (!cliPath) {
    return devStubInvoke(taskPayload);
  }

  return new Promise((resolve, reject) => {
    const child = spawn(cliPath, ['--json-result'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let killTimer: ReturnType<typeof setTimeout> | null = null;

    // Timeout guard — SIGTERM first, then SIGKILL after grace period.
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      // Send SIGKILL after the grace period if the process hasn't exited yet.
      killTimer = setTimeout(() => {
        child.kill('SIGKILL');
      }, sigtermGraceMs);
      reject(new ClaudeCliTimeoutError(timeoutMs));
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
      // Forward stderr to worker logs so operators can diagnose issues.
      process.stderr.write(`[claude-cli] ${chunk.toString()}`);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (killTimer !== null) clearTimeout(killTimer);
      if (timedOut) return; // Already rejected via timeout path.

      if (code !== 0) {
        reject(new ClaudeCliError(code, stderr));
        return;
      }

      try {
        resolve(JSON.parse(stdout) as Record<string, unknown>);
      } catch {
        reject(new ClaudeCliOutputError(stdout));
      }
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      if (killTimer !== null) clearTimeout(killTimer);
      if (!timedOut) reject(err);
    });

    // Write task payload to stdin and close to signal EOF.
    // Suppress EPIPE errors here — if the child exits before reading stdin,
    // the 'close' handler will fire and reject with the appropriate error.
    child.stdin.on('error', () => {
      // Intentionally ignored: EPIPE and similar write errors on stdin are
      // expected when the subprocess exits early. The 'close' handler covers
      // the failure path.
    });
    const stdinPayload = JSON.stringify(taskPayload);
    child.stdin.write(stdinPayload, () => {
      child.stdin.end();
    });
  });
}
