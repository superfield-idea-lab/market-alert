/**
 * @file autolearn-cli.ts
 *
 * Autolearn Claude CLI wrapper with hard timeout and diff capture.
 *
 * This module is the single invocation point for every autolearn run.
 * It writes the current wiki markdown to a temp file, invokes the
 * Claude CLI as a subprocess (no shell), enforces a hard timeout,
 * captures stdout and stderr, and returns a structured result that
 * includes the unified diff between the input wiki and the output wiki
 * produced by the CLI.
 *
 * ## Subprocess contract
 *
 * The CLI is invoked via array-form spawn (never shell-string interpolation
 * — `WORKER-C-007`, `WORKER-X-006`):
 *
 * ```
 * <cliPath> --input-file <tmpInputPath> --output-file <tmpOutputPath>
 * ```
 *
 * The CLI reads the wiki markdown from `--input-file`, processes it, and
 * writes the updated wiki markdown to `--output-file`. Exit code 0 indicates
 * success. Any non-zero exit code is treated as a failure.
 *
 * stdout and stderr produced by the CLI are captured in the result object.
 * They are not parsed — callers may log or store them for debugging.
 *
 * ## Timeout enforcement
 *
 * When `timeoutMs` elapses without the process exiting, the wrapper sends
 * SIGTERM. If the process has not exited after `sigtermGraceMs` it is sent
 * SIGKILL. The returned promise rejects with `AutolearnCliTimeoutError`.
 *
 * ## Diff computation
 *
 * After a successful run the wrapper reads the output file and computes a
 * line-level unified diff between the input wiki and the output wiki. The
 * diff is included in the result as a string in unified-diff format. An
 * empty diff means the CLI did not change the wiki.
 *
 * ## Error handling
 *
 * | Scenario                        | Outcome                                             |
 * |---------------------------------|-----------------------------------------------------|
 * | CLI exits non-zero              | Rejects with `AutolearnCliError`                    |
 * | CLI exceeds `timeoutMs`         | SIGKILL after grace period; rejects with timeout err|
 * | Output file not written         | Rejects with `AutolearnCliOutputError`              |
 *
 * Blueprint references:
 * - WORKER-C-007 / WORKER-X-006: array-form spawn, no shell
 * - WORKER-C-018 / WORKER-X-008: store hashes, not plaintext
 */

import { spawn } from 'child_process';
import { writeFile, readFile, unlink } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { createHash } from 'crypto';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Default hard timeout for an autolearn CLI run: 10 minutes.
 *
 * Production callers should resolve the timeout from the `timeout` module
 * and pass it explicitly.
 */
export const AUTOLEARN_CLI_DEFAULT_TIMEOUT_MS = 600_000;

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

/** The autolearn CLI exited with a non-zero exit code. */
export class AutolearnCliError extends Error {
  constructor(
    public readonly exitCode: number | null,
    public readonly stdout: string,
    public readonly stderr: string,
  ) {
    super(`Autolearn CLI exited ${exitCode}: ${stderr.slice(0, 500)}`);
    this.name = 'AutolearnCliError';
  }
}

/** The autolearn CLI did not produce an output wiki file. */
export class AutolearnCliOutputError extends Error {
  constructor(public readonly reason: string) {
    super(`Autolearn CLI did not produce output wiki: ${reason}`);
    this.name = 'AutolearnCliOutputError';
  }
}

/** The autolearn CLI exceeded the configured timeout. */
export class AutolearnCliTimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`Autolearn CLI exceeded timeout of ${timeoutMs}ms`);
    this.name = 'AutolearnCliTimeoutError';
  }
}

// ---------------------------------------------------------------------------
// Diff utilities
// ---------------------------------------------------------------------------

/**
 * Compute a unified diff between two strings at line granularity.
 *
 * Returns a string in unified-diff format. The output is empty when
 * `before` and `after` are identical.
 *
 * This is a pure-TypeScript implementation that avoids shelling out to
 * `diff(1)` so it works reliably inside worker containers where the diff
 * binary may not be present.
 *
 * @param before  - The original text (input wiki markdown).
 * @param after   - The modified text (output wiki markdown).
 * @param context - Number of unchanged lines to include around each hunk (default: 3).
 * @returns Unified-diff string, or empty string if no changes.
 */
export function computeUnifiedDiff(before: string, after: string, context = 3): string {
  if (before === after) return '';

  const beforeLines = before.split('\n');
  const afterLines = after.split('\n');

  // Compute edit distance table (LCS-based diff).
  const m = beforeLines.length;
  const n = afterLines.length;

  // dp[i][j] = length of LCS of beforeLines[0..i) and afterLines[0..j)
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (beforeLines[i - 1] === afterLines[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // Backtrack to build the edit operations.
  type OpType = 'equal' | 'delete' | 'insert';
  interface EditOp {
    type: OpType;
    line: string;
    /** 0-indexed position in the before array (for equal/delete). -1 for insert. */
    beforeIdx: number;
    /** 0-indexed position in the after array (for equal/insert). -1 for delete. */
    afterIdx: number;
  }
  const ops: EditOp[] = [];
  let bi = m;
  let ai = n;
  while (bi > 0 || ai > 0) {
    if (bi > 0 && ai > 0 && beforeLines[bi - 1] === afterLines[ai - 1]) {
      ops.push({ type: 'equal', line: beforeLines[bi - 1], beforeIdx: bi - 1, afterIdx: ai - 1 });
      bi--;
      ai--;
    } else if (ai > 0 && (bi === 0 || dp[bi][ai - 1] >= dp[bi - 1][ai])) {
      ops.push({ type: 'insert', line: afterLines[ai - 1], beforeIdx: -1, afterIdx: ai - 1 });
      ai--;
    } else {
      ops.push({ type: 'delete', line: beforeLines[bi - 1], beforeIdx: bi - 1, afterIdx: -1 });
      bi--;
    }
  }
  ops.reverse();

  // Build hunks with context.
  // Strategy: collect ranges of changed operations, then expand each range by
  // `context` equal lines on each side. Merge overlapping ranges.
  interface Range {
    start: number; // inclusive index into ops
    end: number; // exclusive index into ops
  }

  // Find all non-equal op indices.
  const changedIndices: number[] = [];
  for (let k = 0; k < ops.length; k++) {
    if (ops[k].type !== 'equal') changedIndices.push(k);
  }

  if (changedIndices.length === 0) return '';

  // Expand each changed op into a range [start, end) covering context equal ops on each side.
  // Then merge overlapping ranges.
  const ranges: Range[] = [];
  for (const idx of changedIndices) {
    // Find the bounds of the context window inside the ops array.
    let rangeStart = idx;
    let rangeEnd = idx + 1;
    // Expand backwards through at most `context` equal ops.
    let equalCount = 0;
    for (let k = idx - 1; k >= 0 && equalCount < context; k--) {
      if (ops[k].type === 'equal') {
        rangeStart = k;
        equalCount++;
      } else {
        break;
      }
    }
    // Expand forwards through at most `context` equal ops.
    equalCount = 0;
    for (let k = idx + 1; k < ops.length && equalCount < context; k++) {
      if (ops[k].type === 'equal') {
        rangeEnd = k + 1;
        equalCount++;
      } else {
        break;
      }
    }
    if (ranges.length > 0 && rangeStart <= ranges[ranges.length - 1].end) {
      // Merge with last range.
      ranges[ranges.length - 1].end = Math.max(ranges[ranges.length - 1].end, rangeEnd);
    } else {
      ranges.push({ start: rangeStart, end: rangeEnd });
    }
  }

  // Render hunks.
  interface Hunk {
    beforeStart: number;
    beforeCount: number;
    afterStart: number;
    afterCount: number;
    lines: string[];
  }

  const hunks: Hunk[] = [];
  for (const range of ranges) {
    const hunk: Hunk = {
      beforeStart: 0,
      beforeCount: 0,
      afterStart: 0,
      afterCount: 0,
      lines: [],
    };
    let firstBefore = -1;
    let firstAfter = -1;
    for (let k = range.start; k < range.end; k++) {
      const op = ops[k];
      if (op.type === 'equal') {
        if (firstBefore === -1) firstBefore = op.beforeIdx;
        if (firstAfter === -1) firstAfter = op.afterIdx;
        hunk.lines.push(` ${op.line}`);
        hunk.beforeCount++;
        hunk.afterCount++;
      } else if (op.type === 'delete') {
        if (firstBefore === -1) firstBefore = op.beforeIdx;
        hunk.lines.push(`-${op.line}`);
        hunk.beforeCount++;
      } else {
        if (firstAfter === -1) firstAfter = op.afterIdx;
        hunk.lines.push(`+${op.line}`);
        hunk.afterCount++;
      }
    }
    hunk.beforeStart = firstBefore + 1; // convert to 1-indexed
    hunk.afterStart = firstAfter + 1;
    hunks.push(hunk);
  }

  if (hunks.length === 0) return '';

  const diffLines: string[] = ['--- a/wiki', '+++ b/wiki'];
  for (const hunk of hunks) {
    diffLines.push(
      `@@ -${hunk.beforeStart},${hunk.beforeCount} +${hunk.afterStart},${hunk.afterCount} @@`,
    );
    diffLines.push(...hunk.lines);
  }
  return diffLines.join('\n');
}

// ---------------------------------------------------------------------------
// SHA-256 hash helper
// ---------------------------------------------------------------------------

/** Compute the SHA-256 hex digest of a string. */
export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// Wrapper options and result
// ---------------------------------------------------------------------------

export interface AutolearnCliOptions {
  /**
   * Absolute path to the Claude CLI binary. Required — there is no dev-stub
   * fallback for the autolearn wrapper because the diff contract requires a
   * real output file.
   */
  cliPath: string;

  /**
   * Current wiki markdown (before the CLI run). Written to a temp input file
   * passed to the CLI via `--input-file`.
   */
  inputWikiMarkdown: string;

  /**
   * Additional opaque context passed to the CLI as JSON on stdin.
   * Must not contain raw content — only opaque identifiers (TQ-P-002).
   */
  taskPayload: Record<string, unknown>;

  /** Maximum ms to wait for the CLI to exit. Default: AUTOLEARN_CLI_DEFAULT_TIMEOUT_MS. */
  timeoutMs?: number;

  /**
   * Grace period in ms between SIGTERM and SIGKILL.
   * Default: 5 000 ms.
   */
  sigtermGraceMs?: number;
}

export interface AutolearnCliResult {
  /** CLI process exit code (0 = success). */
  exitCode: number;

  /** Raw stdout captured from the CLI process. */
  stdout: string;

  /** Raw stderr captured from the CLI process. */
  stderr: string;

  /** Updated wiki markdown written to the output file by the CLI. */
  outputWikiMarkdown: string;

  /**
   * Unified diff between `inputWikiMarkdown` and `outputWikiMarkdown`.
   * Empty string means the CLI did not modify the wiki.
   */
  diff: string;

  /**
   * SHA-256 digest of the input wiki markdown.
   * Stored in audit events instead of plaintext (`WORKER-C-018`).
   */
  inputHash: string;

  /**
   * SHA-256 digest of the output wiki markdown.
   * Stored in audit events instead of plaintext (`WORKER-C-018`).
   */
  outputHash: string;
}

// ---------------------------------------------------------------------------
// Main wrapper function
// ---------------------------------------------------------------------------

/**
 * Invoke the Claude CLI for an autolearn run.
 *
 * Writes `inputWikiMarkdown` to a temporary file, invokes the CLI with
 * `--input-file <in> --output-file <out>`, enforces a hard timeout, and
 * returns a structured result including stdout, stderr, the output wiki
 * markdown, and the unified diff.
 *
 * Temp files are deleted before the function returns regardless of outcome.
 *
 * @throws {AutolearnCliError}        CLI exited non-zero.
 * @throws {AutolearnCliOutputError}  CLI did not produce a readable output file.
 * @throws {AutolearnCliTimeoutError} CLI exceeded `timeoutMs`.
 */
export async function invokeAutolearnCli(
  options: AutolearnCliOptions,
): Promise<AutolearnCliResult> {
  const {
    cliPath,
    inputWikiMarkdown,
    taskPayload,
    timeoutMs = AUTOLEARN_CLI_DEFAULT_TIMEOUT_MS,
    sigtermGraceMs = 5_000,
  } = options;

  const runId = `autolearn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const inputFile = join(tmpdir(), `${runId}-input.md`);
  const outputFile = join(tmpdir(), `${runId}-output.md`);

  // Write input wiki to temp file.
  await writeFile(inputFile, inputWikiMarkdown, 'utf8');

  const cleanup = async () => {
    await unlink(inputFile).catch(() => {});
    await unlink(outputFile).catch(() => {});
  };

  try {
    const { exitCode, stdout, stderr } = await spawnCli(
      cliPath,
      ['--input-file', inputFile, '--output-file', outputFile],
      JSON.stringify(taskPayload),
      timeoutMs,
      sigtermGraceMs,
    );

    if (exitCode !== 0) {
      throw new AutolearnCliError(exitCode, stdout, stderr);
    }

    // Read output wiki produced by the CLI.
    let outputWikiMarkdown: string;
    try {
      outputWikiMarkdown = await readFile(outputFile, 'utf8');
    } catch (err) {
      throw new AutolearnCliOutputError(
        `output file "${outputFile}" could not be read: ${String(err)}`,
      );
    }

    const diff = computeUnifiedDiff(inputWikiMarkdown, outputWikiMarkdown);
    const inputHash = sha256(inputWikiMarkdown);
    const outputHash = sha256(outputWikiMarkdown);

    return { exitCode, stdout, stderr, outputWikiMarkdown, diff, inputHash, outputHash };
  } finally {
    await cleanup();
  }
}

// ---------------------------------------------------------------------------
// Internal: spawn helper
// ---------------------------------------------------------------------------

interface SpawnResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

function spawnCli(
  cliPath: string,
  args: string[],
  stdinPayload: string,
  timeoutMs: number,
  sigtermGraceMs: number,
): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cliPath, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let killTimer: ReturnType<typeof setTimeout> | null = null;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => {
        child.kill('SIGKILL');
      }, sigtermGraceMs);
      reject(new AutolearnCliTimeoutError(timeoutMs));
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
      process.stderr.write(`[autolearn-cli] ${chunk.toString()}`);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (killTimer !== null) clearTimeout(killTimer);
      if (timedOut) return;
      resolve({ exitCode: code, stdout, stderr });
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      if (killTimer !== null) clearTimeout(killTimer);
      if (!timedOut) reject(err);
    });

    child.stdin.on('error', () => {
      // Intentionally ignored: EPIPE on stdin when the child exits early.
      // The 'close' handler covers the failure path.
    });

    child.stdin.write(stdinPayload, () => {
      child.stdin.end();
    });
  });
}
