/**
 * Demo session backdoor — enabled only when DEMO_MODE=true.
 *
 * Provides two endpoints:
 *   GET  /api/demo/users            → list of seeded demo users with roles
 *   POST /api/demo/session  { userId } → issue a session JWT for that user
 *
 * These endpoints let the demo login page show one-click quick-login buttons
 * for the pre-seeded accounts (superadmin, etc.) without requiring a passkey
 * ceremony. They must never be enabled in production.
 */

import type { AppState } from '../index';
import { getCorsHeaders } from './auth';
import { signJwt } from '../auth/jwt';
import { generateCsrfToken, csrfCookieHeader } from '../auth/csrf';
import { authCookieHeader } from '../auth/cookie-config';

export function isDemoMode(): boolean {
  return process.env.DEMO_MODE === 'true';
}

export async function handleDemoSessionRequest(
  req: Request,
  url: URL,
  appState: AppState,
): Promise<Response | null> {
  if (!isDemoMode()) return null;
  if (!url.pathname.startsWith('/api/demo/')) return null;

  const corsHeaders = getCorsHeaders(req);
  const { sql } = appState;

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  // GET /api/demo/users — return all seeded users that have an explicit role
  if (req.method === 'GET' && url.pathname === '/api/demo/users') {
    try {
      const users = await sql<{ id: string; username: string; role: string }[]>`
        SELECT
          id,
          properties->>'username' AS username,
          properties->>'role'     AS role
        FROM entities
        WHERE type = 'user'
          AND properties->>'role' IS NOT NULL
        ORDER BY
          CASE properties->>'role'
            WHEN 'superuser'       THEN 0
            WHEN 'account_manager' THEN 1
            WHEN 'supervisor'      THEN 2
            ELSE 3
          END,
          properties->>'username'
      `;
      return new Response(JSON.stringify(users), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    } catch (err) {
      console.error('DEMO USERS ERROR:', err);
      return new Response(JSON.stringify({ error: 'Internal Server Error' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
  }

  // POST /api/demo/session — issue a session JWT for a demo user.
  //
  // Accepts either:
  //   { userId }   — look up an existing seeded user by id
  //   { username } — create a new plain user on the fly (no passkey needed)
  //
  // The username path lets demo visitors create fresh accounts without going
  // through a WebAuthn ceremony, which requires hardware authenticators that
  // are typically unavailable in demo/cloud environments.
  if (req.method === 'POST' && url.pathname === '/api/demo/session') {
    try {
      const body = (await req.json().catch(() => ({}))) as {
        userId?: string;
        username?: string;
      };

      let u: { id: string; username: string; role: string };

      if (body.userId) {
        const rows = await sql<{ id: string; username: string; role: string }[]>`
          SELECT
            id,
            properties->>'username' AS username,
            properties->>'role'     AS role
          FROM entities
          WHERE id = ${body.userId}
            AND type = 'user'
          LIMIT 1
        `;
        if (rows.length === 0) {
          return new Response(JSON.stringify({ error: 'User not found' }), {
            status: 404,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
        u = rows[0];
      } else if (body.username) {
        const trimmed = body.username.trim();
        if (!trimmed) {
          return new Response(JSON.stringify({ error: 'username must not be blank' }), {
            status: 400,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
        // Upsert: return existing user if username is taken, create otherwise.
        const existing = await sql<{ id: string; role: string }[]>`
          SELECT id, properties->>'role' AS role
          FROM entities
          WHERE type = 'user' AND properties->>'username' = ${trimmed}
          LIMIT 1
        `;
        if (existing.length > 0) {
          u = { id: existing[0].id, username: trimmed, role: existing[0].role ?? '' };
        } else {
          const newId = crypto.randomUUID();
          await sql`
            INSERT INTO entities (id, type, properties, tenant_id)
            VALUES (${newId}, 'user', ${sql.json({ username: trimmed })}, null)
          `;
          u = { id: newId, username: trimmed, role: '' };
        }
      } else {
        return new Response(JSON.stringify({ error: 'userId or username required' }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      const isSuperadmin = u.role === 'superuser';
      const accessFlags = {
        isSuperadmin,
        isAccountManager: isSuperadmin || u.role === 'account_manager',
        isSupervisor: isSuperadmin || u.role === 'supervisor',
      };

      const token = await signJwt({ id: u.id, username: u.username });
      const csrfToken = generateCsrfToken();

      const res = new Response(
        JSON.stringify({ user: { id: u.id, username: u.username, ...accessFlags } }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
      res.headers.append('Set-Cookie', authCookieHeader(token));
      res.headers.append('Set-Cookie', csrfCookieHeader(csrfToken));
      return res;
    } catch (err) {
      console.error('DEMO SESSION ERROR:', err);
      return new Response(JSON.stringify({ error: 'Internal Server Error' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
  }

  return null;
}
