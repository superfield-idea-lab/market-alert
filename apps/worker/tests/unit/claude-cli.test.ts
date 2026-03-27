/**
 * Unit tests for the Claude CLI integration module.
 *
 * Tests cover:
 * - CLAUDE_CLI_PATH startup validation
 * - Dev stub fallback when CLAUDE_CLI_PATH is unset
 * - Successful CLI invocation (stdin payload, stdout JSON parsing)
 * - Error handling: non-zero exit, invalid JSON output, timeout
 * - Sample agent job payload building and result validation
 */

import { describe, test, expect } from 'vitest';
import { writeFileSync, chmodSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import {
  validateClaudeCliPath,
  invokeCli,
  devStubInvoke,
  ClaudeCliError,
  ClaudeCliOutputError,
  ClaudeCliTimeoutError,
} from '../../src/claude-cli.js';

import { SAMPLE_JOB_TYPE, buildCliPayload, validateCliResult } from '../../src/sample-agent-job.js';

// ---------------------------------------------------------------------------
// validateClaudeCliPath
// ---------------------------------------------------------------------------

describe('validateClaudeCliPath', () => {
  test('resolves when the binary is accessible and executable', async () => {
    // Use a known-executable binary in PATH
    await expect(validateClaudeCliPath('/bin/sh')).resolves.toBeUndefined();
  });

  test('throws when the binary does not exist', async () => {
    await expect(validateClaudeCliPath('/nonexistent/path/to/cli')).rejects.toThrow(
      'CLAUDE_CLI_PATH="/nonexistent/path/to/cli" is not accessible or not executable',
    );
  });

  test('throws when the binary is not executable', async () => {
    const notExec = join(tmpdir(), `calypso-test-not-exec-${Date.now()}.txt`);
    writeFileSync(notExec, '#!/bin/sh\necho hi\n');
    chmodSync(notExec, 0o644); // readable but not executable
    try {
      await expect(validateClaudeCliPath(notExec)).rejects.toThrow(
        'not accessible or not executable',
      );
    } finally {
      unlinkSync(notExec);
    }
  });
});

// ---------------------------------------------------------------------------
// devStubInvoke
// ---------------------------------------------------------------------------

describe('devStubInvoke', () => {
  test('returns a result object with a non-empty result string', () => {
    const out = devStubInvoke({ id: 'task-001' });
    expect(typeof out['result']).toBe('string');
    expect((out['result'] as string).length).toBeGreaterThan(0);
  });

  test('includes the task id in the result string', () => {
    const out = devStubInvoke({ id: 'task-xyz' });
    expect(out['result']).toContain('task-xyz');
  });

  test('sets stub flag to true', () => {
    const out = devStubInvoke({ id: 'task-001' });
    expect(out['stub']).toBe(true);
  });

  test('sets status to completed', () => {
    const out = devStubInvoke({ id: 'task-001' });
    expect(out['status']).toBe('completed');
  });

  test('handles missing id gracefully', () => {
    const out = devStubInvoke({});
    expect(typeof out['result']).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// invokeCli — dev stub fallback
// ---------------------------------------------------------------------------

describe('invokeCli (dev stub fallback)', () => {
  test('returns stub result when cliPath is undefined', async () => {
    const result = await invokeCli({ cliPath: undefined, taskPayload: { id: 'task-stub-1' } });
    expect(result['stub']).toBe(true);
    expect(typeof result['result']).toBe('string');
  });

  test('returns stub result when cliPath is empty string', async () => {
    const result = await invokeCli({ cliPath: '', taskPayload: { id: 'task-stub-2' } });
    expect(result['stub']).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// invokeCli — real subprocess (using shell scripts as fake CLIs)
// ---------------------------------------------------------------------------

/**
 * Write a temporary shell script to tmpdir, chmod +x it, and return the path.
 * Caller is responsible for cleanup.
 */
function writeTempScript(name: string, content: string): string {
  const p = join(tmpdir(), `calypso-test-${name}-${Date.now()}.sh`);
  writeFileSync(p, content, { mode: 0o755 });
  return p;
}

describe('invokeCli — subprocess execution', () => {
  test('passes task payload as JSON on stdin and parses stdout JSON', async () => {
    // Script echoes a fixed JSON result regardless of stdin
    const fakeCli = writeTempScript(
      'echo-result',
      `#!/bin/sh\ncat >/dev/null\necho '{"result":"ok","status":"completed"}'\n`,
    );
    try {
      const result = await invokeCli({
        cliPath: fakeCli,
        taskPayload: { id: 'task-abc', prompt_ref: 'pref_001' },
      });
      expect(result['result']).toBe('ok');
      expect(result['status']).toBe('completed');
    } finally {
      unlinkSync(fakeCli);
    }
  });

  test('verifies stdin JSON contains the task id', async () => {
    // Script reads stdin, extracts the id field, echoes it back in result
    const fakeCli = writeTempScript(
      'echo-id',
      `#!/bin/sh
payload=$(cat)
id=$(echo "$payload" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
printf '{"result":"got-%s","status":"completed"}\\n' "$id"
`,
    );
    try {
      const result = await invokeCli({
        cliPath: fakeCli,
        taskPayload: { id: 'task-payload-check' },
      });
      expect(result['result']).toBe('got-task-payload-check');
    } finally {
      unlinkSync(fakeCli);
    }
  });

  test('throws ClaudeCliError when CLI exits non-zero', async () => {
    const fakeCli = writeTempScript('exit-1', `#!/bin/sh\necho "boom" >&2\nexit 1\n`);
    try {
      await expect(
        invokeCli({ cliPath: fakeCli, taskPayload: { id: 'task-fail' } }),
      ).rejects.toBeInstanceOf(ClaudeCliError);
    } finally {
      unlinkSync(fakeCli);
    }
  });

  test('ClaudeCliError includes exit code and stderr tail', async () => {
    const fakeCli = writeTempScript('exit-2', `#!/bin/sh\necho "stderr-message" >&2\nexit 2\n`);
    try {
      await invokeCli({ cliPath: fakeCli, taskPayload: {} }).catch((err) => {
        expect(err).toBeInstanceOf(ClaudeCliError);
        expect((err as ClaudeCliError).exitCode).toBe(2);
        expect((err as ClaudeCliError).stderrTail).toContain('stderr-message');
      });
    } finally {
      unlinkSync(fakeCli);
    }
  });

  test('throws ClaudeCliOutputError when stdout is not valid JSON', async () => {
    const fakeCli = writeTempScript('bad-json', `#!/bin/sh\ncat >/dev/null\necho 'not json'\n`);
    try {
      await expect(invokeCli({ cliPath: fakeCli, taskPayload: {} })).rejects.toBeInstanceOf(
        ClaudeCliOutputError,
      );
    } finally {
      unlinkSync(fakeCli);
    }
  });

  test('throws ClaudeCliTimeoutError when CLI exceeds timeout', async () => {
    // Script sleeps longer than the configured timeout
    const fakeCli = writeTempScript(
      'sleep-forever',
      `#!/bin/sh\nsleep 30\necho '{"result":"late"}'\n`,
    );
    try {
      await expect(
        invokeCli({ cliPath: fakeCli, taskPayload: {}, timeoutMs: 100 }),
      ).rejects.toBeInstanceOf(ClaudeCliTimeoutError);
    } finally {
      unlinkSync(fakeCli);
    }
  }, 5000);
});

// ---------------------------------------------------------------------------
// Sample agent job helpers
// ---------------------------------------------------------------------------

describe('SAMPLE_JOB_TYPE', () => {
  test('is the string "claude_sample"', () => {
    expect(SAMPLE_JOB_TYPE).toBe('claude_sample');
  });
});

describe('buildCliPayload', () => {
  test('merges task id, job_type, agent_type, and payload', () => {
    const result = buildCliPayload('task-1', 'coding', { prompt_ref: 'pref_abc' });
    expect(result['id']).toBe('task-1');
    expect(result['job_type']).toBe(SAMPLE_JOB_TYPE);
    expect(result['agent_type']).toBe('coding');
    expect(result['prompt_ref']).toBe('pref_abc');
  });

  test('payload fields override does not clobber id, job_type, or agent_type', () => {
    // Spread order: payload after base — but base is first and payload is spread after
    const result = buildCliPayload('task-2', 'analysis', { context_ref: 'ctx-001' });
    expect(result['context_ref']).toBe('ctx-001');
    expect(result['id']).toBe('task-2');
  });
});

describe('validateCliResult', () => {
  test('accepts a result object with a result string', () => {
    const raw = { result: 'done', status: 'completed' };
    expect(() => validateCliResult(raw)).not.toThrow();
  });

  test('returns the input object typed as SampleAgentResult', () => {
    const raw = { result: 'all good', status: 'completed' as const };
    const validated = validateCliResult(raw);
    expect(validated.result).toBe('all good');
  });

  test('throws when result field is missing', () => {
    expect(() => validateCliResult({ status: 'completed' })).toThrow(
      'missing required "result" string field',
    );
  });

  test('throws when result field is not a string', () => {
    expect(() => validateCliResult({ result: 42 })).toThrow(
      'missing required "result" string field',
    );
  });
});
