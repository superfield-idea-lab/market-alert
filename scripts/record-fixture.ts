#!/usr/bin/env bun
/**
 * @file record-fixture.ts
 *
 * Fixture recorder CLI — makes real HTTP requests to external APIs and
 * serializes full request/response pairs to tests/fixtures/{service}/.
 *
 * ## Usage
 *
 *   bun run scripts/record-fixture.ts --service anthropic --output tests/fixtures/anthropic
 *
 * ## Fixture format
 *
 * Each fixture file is a JSON object:
 *   {
 *     "recorded_at": "<ISO-8601 timestamp>",
 *     "service": "<service name>",
 *     "request": { "method", "url", "headers", "body" },
 *     "response": { "status", "statusText", "headers", "body" }
 *   }
 *
 * Files are named `{service}_{timestamp}.json` where timestamp is a
 * sortable ISO-8601 date string with colons replaced by dashes.
 *
 * ## Blueprint refs
 *
 * - TEST-D-001: golden-fixture-recording
 * - TEST-A-003: fixture-refresh-pipeline
 * - TEST-C-003: golden-fixture-recorded
 * - TEST-C-025: fixtures-refreshed (recorded_at < 30 days)
 *
 * Canonical doc: docs/implementation-plan-v1.md § Phase 0
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FixtureRequest {
  body: unknown;
  headers: Record<string, string>;
  method: string;
  url: string;
}

export interface FixtureResponse {
  body: unknown;
  headers: Record<string, string>;
  status: number;
  statusText: string;
}

export interface GoldenFixture {
  recorded_at: string;
  request: FixtureRequest;
  response: FixtureResponse;
  service: string;
}

// ---------------------------------------------------------------------------
// Core recorder function
// ---------------------------------------------------------------------------

/**
 * Makes a real HTTP request and returns a serialized GoldenFixture.
 * This function is the unit-testable kernel of the recorder.
 */
export async function recordRequest(opts: {
  body?: unknown;
  headers?: Record<string, string>;
  method?: string;
  service: string;
  url: string;
}): Promise<GoldenFixture> {
  const method = opts.method ?? 'POST';
  const reqHeaders: Record<string, string> = {
    'content-type': 'application/json',
    ...opts.headers,
  };

  const fetchInit: RequestInit = {
    headers: reqHeaders,
    method,
  };

  if (opts.body !== undefined) {
    fetchInit.body = JSON.stringify(opts.body);
  }

  const response = await fetch(opts.url, fetchInit);

  // Collect response headers
  const resHeaders: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    resHeaders[key] = value;
  });

  // Parse response body — try JSON first, fall back to text
  let body: unknown;
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    body = await response.json();
  } else {
    body = await response.text();
  }

  const recorded_at = new Date().toISOString();

  return {
    recorded_at,
    request: {
      body: opts.body ?? null,
      headers: reqHeaders,
      method,
      url: opts.url,
    },
    response: {
      body,
      headers: resHeaders,
      status: response.status,
      statusText: response.statusText,
    },
    service: opts.service,
  };
}

// ---------------------------------------------------------------------------
// File writer
// ---------------------------------------------------------------------------

/**
 * Writes a GoldenFixture to disk at `{outputDir}/{service}_{timestamp}.json`.
 * Creates the output directory if it doesn't exist.
 * Returns the absolute path of the written file.
 */
export function writeFixture(fixture: GoldenFixture, outputDir: string): string {
  mkdirSync(outputDir, { recursive: true });

  // Sortable timestamp: 2024-01-15T10-30-00.000Z (colons → dashes)
  const timestamp = fixture.recorded_at.replace(/:/g, '-').replace(/\./g, '-');
  const filename = `${fixture.service}_${timestamp}.json`;
  const filePath = join(outputDir, filename);

  writeFileSync(filePath, JSON.stringify(fixture, null, 2) + '\n', 'utf-8');

  return filePath;
}

// ---------------------------------------------------------------------------
// Anthropic recorder preset
// ---------------------------------------------------------------------------

/**
 * Records a single Anthropic Messages API call for the autolearn context use
 * case. Requires ANTHROPIC_API_KEY in the environment.
 *
 * This is the canonical initial fixture per issue #98 and TEST-C-003.
 */
export async function recordAnthropicAutolearn(outputDir: string): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      'ANTHROPIC_API_KEY environment variable is required to record Anthropic fixtures.',
    );
  }

  const fixture = await recordRequest({
    body: {
      max_tokens: 64,
      messages: [
        {
          content:
            'You are a knowledge base assistant. Summarize: "The sky is blue because of Rayleigh scattering." in one sentence.',
          role: 'user',
        },
      ],
      model: 'claude-3-haiku-20240307',
    },
    headers: {
      'anthropic-version': '2023-06-01',
      'x-api-key': apiKey,
    },
    method: 'POST',
    service: 'anthropic',
    url: 'https://api.anthropic.com/v1/messages',
  });

  return writeFixture(fixture, outputDir);
}

// ---------------------------------------------------------------------------
// Schema drift checker
// ---------------------------------------------------------------------------

/**
 * Compares the top-level keys of two fixture response bodies.
 * Returns { drifted: false } if identical, or { drifted: true, added, removed }
 * if there are new or missing fields.
 */
export function checkSchemaDrift(
  baseline: GoldenFixture,
  updated: GoldenFixture,
): { drifted: false } | { added: string[]; drifted: true; removed: string[] } {
  const getKeys = (fixture: GoldenFixture): Set<string> => {
    if (fixture.response.body !== null && typeof fixture.response.body === 'object') {
      return new Set(Object.keys(fixture.response.body as Record<string, unknown>));
    }
    return new Set<string>();
  };

  const baselineKeys = getKeys(baseline);
  const updatedKeys = getKeys(updated);

  const added = [...updatedKeys].filter((k) => !baselineKeys.has(k));
  const removed = [...baselineKeys].filter((k) => !updatedKeys.has(k));

  if (added.length === 0 && removed.length === 0) {
    return { drifted: false };
  }

  return { added, drifted: true, removed };
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

// Run only when executed directly (not imported by tests)
const isMain =
  typeof Bun !== 'undefined' &&
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isMain) {
  const args = process.argv.slice(2);
  const serviceIdx = args.indexOf('--service');
  const outputIdx = args.indexOf('--output');

  const service = serviceIdx >= 0 ? args[serviceIdx + 1] : undefined;
  const output = outputIdx >= 0 ? args[outputIdx + 1] : undefined;

  if (!service) {
    console.error('Usage: bun run scripts/record-fixture.ts --service <service> [--output <dir>]');
    process.exit(1);
  }

  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const outputDir = output ? resolve(output) : join(repoRoot, 'tests', 'fixtures', service);

  if (service === 'anthropic') {
    console.log(`Recording Anthropic autolearn fixture → ${outputDir}`);
    try {
      const path = await recordAnthropicAutolearn(outputDir);
      console.log(`Fixture recorded: ${path}`);
    } catch (err) {
      console.error(`Recording failed: ${(err as Error).message}`);
      process.exit(1);
    }
  } else {
    console.error(`Unknown service: ${service}. Supported: anthropic`);
    process.exit(1);
  }
}
