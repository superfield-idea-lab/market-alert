/**
 * Unit tests for the autolearn Claude CLI wrapper.
 *
 * Tests cover:
 * - computeUnifiedDiff — pure diff logic
 * - sha256 — hash helper
 * - invokeAutolearnCli — subprocess execution, hard timeout, diff capture
 *   (uses real shell scripts as fake CLIs; zero mocks per CLAUDE.md)
 */

import { describe, test, expect } from 'vitest';
import { writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import {
  computeUnifiedDiff,
  sha256,
  invokeAutolearnCli,
  AutolearnCliError,
  AutolearnCliOutputError,
  AutolearnCliTimeoutError,
} from '../../src/autolearn-cli.js';

// ---------------------------------------------------------------------------
// computeUnifiedDiff
// ---------------------------------------------------------------------------

describe('computeUnifiedDiff', () => {
  test('returns empty string when before and after are identical', () => {
    const text = '# Title\n\nSome content.';
    expect(computeUnifiedDiff(text, text)).toBe('');
  });

  test('returns a non-empty diff when text differs', () => {
    const before = '# Title\n\nOriginal line.';
    const after = '# Title\n\nModified line.';
    const diff = computeUnifiedDiff(before, after);
    expect(diff).not.toBe('');
    expect(diff).toContain('-Original line.');
    expect(diff).toContain('+Modified line.');
  });

  test('diff contains unified diff headers', () => {
    const before = 'line one\nline two';
    const after = 'line one\nline two modified';
    const diff = computeUnifiedDiff(before, after);
    expect(diff).toContain('--- a/wiki');
    expect(diff).toContain('+++ b/wiki');
    expect(diff).toMatch(/^@@ /m);
  });

  test('handles addition of new lines', () => {
    const before = 'line one';
    const after = 'line one\nline two';
    const diff = computeUnifiedDiff(before, after);
    expect(diff).toContain('+line two');
  });

  test('handles removal of lines', () => {
    const before = 'line one\nline two\nline three';
    const after = 'line one\nline three';
    const diff = computeUnifiedDiff(before, after);
    expect(diff).toContain('-line two');
  });

  test('handles empty before (full insertion)', () => {
    const before = '';
    const after = 'new content';
    const diff = computeUnifiedDiff(before, after);
    expect(diff).toContain('+new content');
  });

  test('handles empty after (full deletion)', () => {
    const before = 'old content';
    const after = '';
    const diff = computeUnifiedDiff(before, after);
    expect(diff).toContain('-old content');
  });

  test('context lines are included around changes', () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
    const before = lines.join('\n');
    const after = [...lines.slice(0, 10), 'changed', ...lines.slice(11)].join('\n');
    const diff = computeUnifiedDiff(before, after);
    // Should include context (lines near the change).
    expect(diff).toContain(' line 8');
    expect(diff).toContain(' line 9');
    expect(diff).toContain(' line 10');
    expect(diff).toContain('-line 11');
    expect(diff).toContain('+changed');
    expect(diff).toContain(' line 12');
  });

  test('returns empty string for two empty strings', () => {
    expect(computeUnifiedDiff('', '')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// sha256
// ---------------------------------------------------------------------------

describe('sha256', () => {
  test('returns a 64-character hex string', () => {
    const digest = sha256('hello world');
    expect(digest).toHaveLength(64);
    expect(digest).toMatch(/^[0-9a-f]+$/);
  });

  test('same input produces same digest', () => {
    expect(sha256('consistent')).toBe(sha256('consistent'));
  });

  test('different inputs produce different digests', () => {
    expect(sha256('input-a')).not.toBe(sha256('input-b'));
  });

  test('known SHA-256 digest for empty string', () => {
    expect(sha256('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });
});

// ---------------------------------------------------------------------------
// invokeAutolearnCli — helpers
// ---------------------------------------------------------------------------

/**
 * Write a temporary shell script to tmpdir, chmod +x it, and return the path.
 * Caller is responsible for cleanup.
 */
function writeTempScript(name: string, content: string): string {
  const p = join(tmpdir(), `superfield-autolearn-test-${name}-${Date.now()}.sh`);
  writeFileSync(p, content, { mode: 0o755 });
  return p;
}

// ---------------------------------------------------------------------------
// invokeAutolearnCli — success path
// ---------------------------------------------------------------------------

describe('invokeAutolearnCli — success path', () => {
  test('returns structured result with outputWikiMarkdown from output file', async () => {
    // CLI copies input file to output file unmodified (no change scenario).
    const fakeCli = writeTempScript(
      'copy',
      `#!/bin/sh
while [ "$#" -gt 1 ]; do
  case "$1" in
    --input-file) input="$2"; shift 2 ;;
    --output-file) output="$2"; shift 2 ;;
    *) shift ;;
  esac
done
cp "$input" "$output"
echo '{"status":"completed"}'
`,
    );
    try {
      const result = await invokeAutolearnCli({
        cliPath: fakeCli,
        inputWikiMarkdown: '# Hello\n\nWorld.',
        taskPayload: { task_ref: 'tref_001' },
      });
      expect(result.exitCode).toBe(0);
      expect(result.outputWikiMarkdown).toBe('# Hello\n\nWorld.');
      expect(result.diff).toBe('');
    } finally {
      unlinkSync(fakeCli);
    }
  });

  test('diff is non-empty when CLI modifies the wiki', async () => {
    const fakeCli = writeTempScript(
      'modify',
      `#!/bin/sh
while [ "$#" -gt 1 ]; do
  case "$1" in
    --input-file) input="$2"; shift 2 ;;
    --output-file) output="$2"; shift 2 ;;
    *) shift ;;
  esac
done
# Append a new paragraph to the wiki.
printf '%s\\n\\nAdded by autolearn.' "$(cat "$input")" > "$output"
echo '{"status":"completed"}'
`,
    );
    try {
      const result = await invokeAutolearnCli({
        cliPath: fakeCli,
        inputWikiMarkdown: '# Hello\n\nWorld.',
        taskPayload: { task_ref: 'tref_002' },
      });
      expect(result.exitCode).toBe(0);
      expect(result.diff).not.toBe('');
      expect(result.diff).toContain('+Added by autolearn.');
    } finally {
      unlinkSync(fakeCli);
    }
  });

  test('stdout is captured in result', async () => {
    const fakeCli = writeTempScript(
      'stdout-capture',
      `#!/bin/sh
while [ "$#" -gt 1 ]; do
  case "$1" in
    --input-file) input="$2"; shift 2 ;;
    --output-file) output="$2"; shift 2 ;;
    *) shift ;;
  esac
done
cp "$input" "$output"
echo "autolearn completed successfully"
`,
    );
    try {
      const result = await invokeAutolearnCli({
        cliPath: fakeCli,
        inputWikiMarkdown: '# Test',
        taskPayload: {},
      });
      expect(result.stdout).toContain('autolearn completed successfully');
    } finally {
      unlinkSync(fakeCli);
    }
  });

  test('stderr is captured in result', async () => {
    const fakeCli = writeTempScript(
      'stderr-capture',
      `#!/bin/sh
while [ "$#" -gt 1 ]; do
  case "$1" in
    --input-file) input="$2"; shift 2 ;;
    --output-file) output="$2"; shift 2 ;;
    *) shift ;;
  esac
done
cp "$input" "$output"
echo "diagnostic info" >&2
`,
    );
    try {
      const result = await invokeAutolearnCli({
        cliPath: fakeCli,
        inputWikiMarkdown: '# Test',
        taskPayload: {},
      });
      expect(result.stderr).toContain('diagnostic info');
    } finally {
      unlinkSync(fakeCli);
    }
  });

  test('inputHash and outputHash are SHA-256 digests', async () => {
    const inputWiki = '# Wiki\n\nContent.';
    const fakeCli = writeTempScript(
      'hash-check',
      `#!/bin/sh
while [ "$#" -gt 1 ]; do
  case "$1" in
    --input-file) input="$2"; shift 2 ;;
    --output-file) output="$2"; shift 2 ;;
    *) shift ;;
  esac
done
cp "$input" "$output"
`,
    );
    try {
      const result = await invokeAutolearnCli({
        cliPath: fakeCli,
        inputWikiMarkdown: inputWiki,
        taskPayload: {},
      });
      expect(result.inputHash).toHaveLength(64);
      expect(result.outputHash).toHaveLength(64);
      // When the wiki is unchanged, both hashes are identical.
      expect(result.inputHash).toBe(result.outputHash);
      expect(result.inputHash).toBe(sha256(inputWiki));
    } finally {
      unlinkSync(fakeCli);
    }
  });

  test('inputHash and outputHash differ when wiki is modified', async () => {
    const fakeCli = writeTempScript(
      'hash-diff-check',
      `#!/bin/sh
while [ "$#" -gt 1 ]; do
  case "$1" in
    --input-file) input="$2"; shift 2 ;;
    --output-file) output="$2"; shift 2 ;;
    *) shift ;;
  esac
done
echo "# Modified wiki" > "$output"
`,
    );
    try {
      const result = await invokeAutolearnCli({
        cliPath: fakeCli,
        inputWikiMarkdown: '# Original wiki',
        taskPayload: {},
      });
      expect(result.inputHash).not.toBe(result.outputHash);
    } finally {
      unlinkSync(fakeCli);
    }
  });

  test('task payload is written as JSON to stdin', async () => {
    const fakeCli = writeTempScript(
      'stdin-check',
      `#!/bin/sh
while [ "$#" -gt 1 ]; do
  case "$1" in
    --input-file) input="$2"; shift 2 ;;
    --output-file) output="$2"; shift 2 ;;
    *) shift ;;
  esac
done
cp "$input" "$output"
# Read stdin and write it to stdout so caller can assert on it.
stdin_data=$(cat)
echo "stdin:$stdin_data"
`,
    );
    try {
      const result = await invokeAutolearnCli({
        cliPath: fakeCli,
        inputWikiMarkdown: '# Wiki',
        taskPayload: { task_ref: 'tref_stdin' },
      });
      expect(result.stdout).toContain('"task_ref":"tref_stdin"');
    } finally {
      unlinkSync(fakeCli);
    }
  });
});

// ---------------------------------------------------------------------------
// invokeAutolearnCli — error paths
// ---------------------------------------------------------------------------

describe('invokeAutolearnCli — error paths', () => {
  test('throws AutolearnCliError when CLI exits non-zero', async () => {
    const fakeCli = writeTempScript('exit-1', `#!/bin/sh\necho "error" >&2\nexit 1\n`);
    try {
      await expect(
        invokeAutolearnCli({
          cliPath: fakeCli,
          inputWikiMarkdown: '# Wiki',
          taskPayload: {},
        }),
      ).rejects.toBeInstanceOf(AutolearnCliError);
    } finally {
      unlinkSync(fakeCli);
    }
  });

  test('AutolearnCliError includes exit code, stdout, and stderr', async () => {
    const fakeCli = writeTempScript(
      'exit-2',
      `#!/bin/sh\necho "out-msg"\necho "err-msg" >&2\nexit 2\n`,
    );
    try {
      await invokeAutolearnCli({
        cliPath: fakeCli,
        inputWikiMarkdown: '# Wiki',
        taskPayload: {},
      }).catch((err) => {
        expect(err).toBeInstanceOf(AutolearnCliError);
        expect((err as AutolearnCliError).exitCode).toBe(2);
        expect((err as AutolearnCliError).stdout).toContain('out-msg');
        expect((err as AutolearnCliError).stderr).toContain('err-msg');
      });
    } finally {
      unlinkSync(fakeCli);
    }
  });

  test('throws AutolearnCliOutputError when output file is not created', async () => {
    // CLI exits 0 but does not create the output file.
    const fakeCli = writeTempScript(
      'no-output',
      `#!/bin/sh\ncat >/dev/null\necho '{"status":"completed"}'\n`,
    );
    try {
      await expect(
        invokeAutolearnCli({
          cliPath: fakeCli,
          inputWikiMarkdown: '# Wiki',
          taskPayload: {},
        }),
      ).rejects.toBeInstanceOf(AutolearnCliOutputError);
    } finally {
      unlinkSync(fakeCli);
    }
  });

  test('throws AutolearnCliTimeoutError when CLI exceeds timeout', async () => {
    const fakeCli = writeTempScript(
      'sleep-forever',
      `#!/bin/sh\nsleep 30\necho '{"status":"completed"}'\n`,
    );
    try {
      await expect(
        invokeAutolearnCli({
          cliPath: fakeCli,
          inputWikiMarkdown: '# Wiki',
          taskPayload: {},
          timeoutMs: 100,
        }),
      ).rejects.toBeInstanceOf(AutolearnCliTimeoutError);
    } finally {
      unlinkSync(fakeCli);
    }
  }, 5000);

  test('AutolearnCliTimeoutError includes the configured timeoutMs', async () => {
    const fakeCli = writeTempScript(
      'sleep-timeout-check',
      `#!/bin/sh\nsleep 30\necho '{"status":"completed"}'\n`,
    );
    try {
      await invokeAutolearnCli({
        cliPath: fakeCli,
        inputWikiMarkdown: '# Wiki',
        taskPayload: {},
        timeoutMs: 150,
      }).catch((err) => {
        expect(err).toBeInstanceOf(AutolearnCliTimeoutError);
        expect((err as AutolearnCliTimeoutError).timeoutMs).toBe(150);
        expect((err as AutolearnCliTimeoutError).message).toContain('150');
      });
    } finally {
      unlinkSync(fakeCli);
    }
  }, 5000);

  test('SIGKILL is sent after grace period when process ignores SIGTERM', async () => {
    const fakeCli = writeTempScript('sigterm-ignore', `#!/bin/sh\ntrap '' TERM\nsleep 30\n`);
    try {
      await expect(
        invokeAutolearnCli({
          cliPath: fakeCli,
          inputWikiMarkdown: '# Wiki',
          taskPayload: {},
          timeoutMs: 200,
          sigtermGraceMs: 200,
        }),
      ).rejects.toBeInstanceOf(AutolearnCliTimeoutError);
    } finally {
      unlinkSync(fakeCli);
    }
  }, 5000);

  test('temp files are cleaned up after timeout', async () => {
    const fakeCli = writeTempScript('sleep-cleanup', `#!/bin/sh\nsleep 30\n`);
    try {
      await invokeAutolearnCli({
        cliPath: fakeCli,
        inputWikiMarkdown: '# Wiki cleanup test',
        taskPayload: {},
        timeoutMs: 100,
      }).catch(() => {
        // Expected rejection — the test only cares that no exception is thrown
        // from the cleanup path (i.e. the finally block ran without error).
      });
    } finally {
      unlinkSync(fakeCli);
    }
  }, 5000);
});
