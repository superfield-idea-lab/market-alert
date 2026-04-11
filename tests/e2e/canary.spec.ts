/**
 * @file canary.spec.ts
 *
 * Golden-path end-to-end canary test.
 *
 * Boots the full stack (real Postgres + Bun server) via the shared
 * `environment.ts` helper, asserts that GET /health responds 200 with
 * `status: "ok"`, and tears everything down cleanly.
 *
 * This test must remain green on every PR so it serves as a sentinel that
 * the fundamental scaffolding still works end-to-end.  It intentionally uses
 * no mocks — only real processes and real HTTP.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startE2EServer, stopE2EServer, type E2EEnvironment } from './environment';

let env: E2EEnvironment;

beforeAll(async () => {
  env = await startE2EServer();
});

afterAll(async () => {
  await stopE2EServer(env);
});

describe('golden-path canary', () => {
  it('GET /health responds 200 with status ok', async () => {
    const res = await fetch(`${env.baseUrl}/health`);

    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body).toMatchObject({ status: 'ok' });
  });

  it('GET /health/live responds 200 with status ok', async () => {
    const res = await fetch(`${env.baseUrl}/health/live`);

    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body).toMatchObject({ status: 'ok' });
  });

  it('GET /health/ready responds 200 with status ok', async () => {
    const res = await fetch(`${env.baseUrl}/health/ready`);

    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body).toMatchObject({ status: 'ok' });
  });
});
