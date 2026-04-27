/**
 * Test session helper for integration tests.
 *
 * Calls POST /api/test/session (only active when the server is started with
 * TEST_MODE=true) to create a user entity and receive a signed session cookie
 * issued by the server's own JWT and cookie infrastructure. This is the
 * canonical pattern for integration test setup after password-based auth was
 * removed (issue #14, AUTH blueprint).
 *
 * The server endpoint creates the user entity and signs the JWT using the same
 * ephemeral key pair the server uses for all other sessions — so tokens are
 * always valid for that server process.
 *
 * Usage:
 *   const session = await createTestSession(base, { username: 'alice' });
 *   const res = await fetch(`${base}/api/tasks`, {
 *     headers: { Cookie: session.cookie },
 *   });
 *
 * No mocks — real server HTTP, real Postgres, real JWT signing.
 */

export interface TestSession {
  /** Formatted Cookie header value, e.g. "superfield_auth=<token>; __Host-csrf-token=<csrf>" */
  cookie: string;
  /** The CSRF token string (for X-CSRF-Token header) */
  csrfToken: string;
  /** The created user's UUID */
  userId: string;
  /** The created user's username */
  username: string;
}

/**
 * Create a test user entity via the server's backdoor endpoint and return the
 * session cookie and CSRF token for use in integration test HTTP requests.
 *
 * The server must be started with TEST_MODE=true for this to work.
 *
 * @param baseUrl - Server base URL, e.g. "http://localhost:31416"
 * @param opts.username - Optional username; defaults to a timestamped unique name
 */
export async function createTestSession(
  baseUrl: string,
  opts: { username?: string; role?: string } = {},
): Promise<TestSession> {
  const res = await fetch(`${baseUrl}/api/test/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: opts.username, role: opts.role }),
  });

  if (!res.status.toString().startsWith('2')) {
    const body = await res.text();
    throw new Error(`createTestSession failed with ${res.status}: ${body}`);
  }

  const data = (await res.json()) as { user: { id: string; username: string } };
  const setCookies = res.headers.getSetCookie
    ? res.headers.getSetCookie()
    : [res.headers.get('set-cookie') ?? ''];

  const cookiePairs: string[] = [];
  let csrfToken = '';

  for (const raw of setCookies) {
    const pair = raw.split(';')[0].trim();
    if (pair) cookiePairs.push(pair);
    if (pair.startsWith('__Host-csrf-token=')) {
      csrfToken = pair.split('=').slice(1).join('=');
    }
  }

  return {
    cookie: cookiePairs.join('; '),
    csrfToken,
    userId: data.user.id,
    username: data.user.username,
  };
}
