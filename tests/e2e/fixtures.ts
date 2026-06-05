/**
 * @file fixtures.ts
 *
 * Re-exports canonical demo fixture constants and provides a session helper
 * that authenticates as a specific fixture user via /api/demo/session.
 *
 * All e2e tests that need to act as a known fixture persona (researcher,
 * admin, supervisor) should use these helpers instead of hardcoding IDs or
 * calling /api/test/session with an ad-hoc username.
 *
 * @see packages/db/demo-seed.ts — canonical fixture definitions
 * @see tests/e2e/environment.ts — sets DEMO_MODE=true so demo endpoints are active
 */

export { DEMO_FIXTURES } from '../../packages/db/demo-seed';
export type { DemoFixtures } from '../../packages/db/demo-seed';

import { DEMO_FIXTURES } from '../../packages/db/demo-seed';

export type FixtureRole = keyof typeof DEMO_FIXTURES.users;

export interface FixtureSession {
  /** Raw Set-Cookie header value — use to inject session into a browser context or fetch call. */
  cookie: string;
  /** The fixture user's entity ID — matches DEMO_FIXTURES.users[role].id. */
  userId: string;
  /** The fixture user's username. */
  username: string;
}

/**
 * Obtain a session cookie for the given fixture role by calling
 * POST /api/demo/session with the fixture user's known entity ID.
 *
 * Requires the test server to be running with DEMO_MODE=true (which
 * startE2EServer() ensures). The session is issued for the exact fixture
 * user from the seed, so server-side role checks behave as the demo does.
 *
 * @param baseUrl — the test server base URL, e.g. `http://localhost:31415`
 * @param role    — which fixture user to authenticate as
 */
export async function getFixtureSession(
  baseUrl: string,
  role: FixtureRole,
): Promise<FixtureSession> {
  const user = DEMO_FIXTURES.users[role];
  const res = await fetch(`${baseUrl}/api/demo/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId: user.id }),
  });
  if (!res.ok) {
    throw new Error(
      `getFixtureSession: /api/demo/session returned ${res.status} for role '${role}'`,
    );
  }
  return {
    cookie: res.headers.get('set-cookie') ?? '',
    userId: user.id,
    username: user.username,
  };
}
