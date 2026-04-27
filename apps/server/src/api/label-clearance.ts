/**
 * @file api/label-clearance
 *
 * Label-based clearance controls and per-label content-key encryption API (issue #225).
 *
 * ## Layering model
 *
 * The tenant/customer RLS (existing) is the outer boundary; label grants are an
 * additional inner boundary applied on top.
 *
 * ## Endpoints
 *
 * ### Access label management (admin/superuser only)
 *
 * POST   /api/labels
 *   Create a new clearance label.
 *   Body: { name, description?, tenantId? }
 *   Auth: superuser.
 *
 * GET    /api/labels
 *   List clearance labels.
 *   Query: ?tenantId=
 *   Auth: superuser.
 *
 * POST   /api/labels/:name/content-key
 *   Generate (or rotate) the per-label KMS-wrapped content key.
 *   Query: ?tenantId=
 *   Auth: superuser.
 *
 * ### User grant management (admin/superuser only)
 *
 * POST   /api/labels/:name/grants
 *   Grant a label to a user.
 *   Body: { userId, tenantId? }
 *   Auth: superuser.
 *
 * DELETE /api/labels/:name/grants/:userId
 *   Revoke a label grant from a user.
 *   Query: ?tenantId=
 *   Auth: superuser.
 *
 * GET    /api/labels/:name/grants
 *   List users who hold the given label.
 *   Query: ?tenantId=
 *   Auth: superuser.
 *
 * GET    /api/users/:userId/labels
 *   List labels held by a user.
 *   Auth: superuser or the user themselves.
 *
 * ### Labeled ground-truth records (authenticated)
 *
 * POST   /api/labels/:name/ground-truth
 *   Write a labeled ground-truth record for an entity.
 *   Body: { entityId, tenantId?, plaintext }
 *   Auth: superuser.
 *
 * GET    /api/labels/:name/ground-truth/:entityId
 *   Read and decrypt a labeled ground-truth record.
 *   Query: ?tenantId=
 *   Auth: authenticated user who holds the label (or superuser).
 *
 * Canonical docs: docs/implementation-plan-v1.md Phase 9 — label clearance
 * Issue #225
 */

import type { AppState } from '../index';
import { getCorsHeaders, getAuthenticatedUser } from './auth';
import { isSuperuser, makeJson } from '../lib/response';
import { emitAuditEvent } from '../policies/audit-service';
import {
  createAccessLabel,
  getAccessLabel,
  listAccessLabels,
  createLabelContentKey,
  grantUserLabel,
  revokeUserLabel,
  listUserLabels,
  writeLabeledGroundTruth,
  readLabeledGroundTruth,
  LabelNotFoundError,
  LabelContentKeyMissingError,
  LabelClearanceDeniedError,
  LabelGrantNotFoundError,
} from 'db/label-clearance';

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function handleLabelClearanceRequest(
  req: Request,
  url: URL,
  appState: AppState,
): Promise<Response | null> {
  const { pathname } = url;

  // Only handle /api/labels and /api/users/:id/labels
  if (!pathname.startsWith('/api/labels') && !pathname.match(/^\/api\/users\/[^/]+\/labels/)) {
    return null;
  }

  const corsHeaders = getCorsHeaders(req);
  const json = makeJson(corsHeaders);
  const { sql } = appState;

  const user = await getAuthenticatedUser(req);
  if (!user) return json({ error: 'Unauthorized' }, 401);

  // ── GET /api/users/:userId/labels ─────────────────────────────────────────
  // Returns label grants held by the given user.
  // Auth: superuser, or the user themselves.
  const userLabelsMatch = pathname.match(/^\/api\/users\/([^/]+)\/labels$/);
  if (req.method === 'GET' && userLabelsMatch) {
    const targetUserId = userLabelsMatch[1];
    if (!isSuperuser(user.id) && user.id !== targetUserId) {
      return json({ error: 'Forbidden' }, 403);
    }
    const tenantId = url.searchParams.has('tenantId')
      ? url.searchParams.get('tenantId')
      : undefined;
    const grants = await listUserLabels(sql, targetUserId, tenantId ?? undefined);
    return json({ grants });
  }

  // All /api/labels/* routes below require superuser for mutations.
  // Read-only routes also require superuser for the MVP.

  // ── POST /api/labels ──────────────────────────────────────────────────────
  if (req.method === 'POST' && pathname === '/api/labels') {
    if (!isSuperuser(user.id)) return json({ error: 'Forbidden' }, 403);

    let body: { name?: unknown; description?: unknown; tenantId?: unknown };
    try {
      body = await req.json();
    } catch {
      return json({ error: 'Invalid JSON body' }, 400);
    }

    if (typeof body.name !== 'string' || !body.name.trim()) {
      return json({ error: 'name is required and must be a non-empty string' }, 400);
    }
    const tenantId =
      body.tenantId === undefined ? null : typeof body.tenantId === 'string' ? body.tenantId : null;

    try {
      const label = await createAccessLabel(sql, {
        name: body.name.trim(),
        description: typeof body.description === 'string' ? body.description : '',
        tenantId,
        createdBy: user.id,
      });

      await emitAuditEvent({
        actor_id: user.id,
        action: 'label.create',
        entity_type: 'access_label',
        entity_id: label.name,
        before: null,
        after: { name: label.name, tenant_id: label.tenant_id },
        ts: new Date().toISOString(),
      }).catch((err) => console.warn('[audit] label.create audit write failed:', err));

      return json({ label }, 201);
    } catch (err) {
      const msg = (err as Error).message ?? '';
      if (msg.includes('duplicate') || msg.includes('unique')) {
        return json({ error: `Label "${body.name}" already exists in this tenant scope` }, 409);
      }
      throw err;
    }
  }

  // ── GET /api/labels ───────────────────────────────────────────────────────
  if (req.method === 'GET' && pathname === '/api/labels') {
    if (!isSuperuser(user.id)) return json({ error: 'Forbidden' }, 403);

    const tenantIdParam = url.searchParams.get('tenantId');
    const limit = Math.min(Number(url.searchParams.get('limit') ?? '100') || 100, 500);
    const offset = Math.max(Number(url.searchParams.get('offset') ?? '0') || 0, 0);

    // tenantId='' means global; absent means all
    const tenantId =
      tenantIdParam === null ? undefined : tenantIdParam === '' ? null : tenantIdParam;

    const labels = await listAccessLabels(sql, { tenantId, limit, offset });
    return json({ labels });
  }

  // ── POST /api/labels/:name/content-key ────────────────────────────────────
  const contentKeyMatch = pathname.match(/^\/api\/labels\/([^/]+)\/content-key$/);
  if (req.method === 'POST' && contentKeyMatch) {
    if (!isSuperuser(user.id)) return json({ error: 'Forbidden' }, 403);

    const labelName = decodeURIComponent(contentKeyMatch[1]);
    const tenantId = url.searchParams.get('tenantId') ?? null;

    try {
      const label = await createLabelContentKey(sql, labelName, tenantId);

      await emitAuditEvent({
        actor_id: user.id,
        action: 'label.content_key.create',
        entity_type: 'access_label',
        entity_id: labelName,
        before: null,
        after: { name: labelName, tenant_id: tenantId, key_set: true },
        ts: new Date().toISOString(),
      }).catch((err) => console.warn('[audit] label.content_key.create audit write failed:', err));

      // Never return the wrapped key bytes in the response — only metadata.
      return json({
        label: {
          name: label.name,
          tenant_id: label.tenant_id,
          has_content_key: label.wrapped_content_key !== null,
          updated_at: label.updated_at,
        },
      });
    } catch (err) {
      if (err instanceof LabelNotFoundError) return json({ error: err.message }, 404);
      throw err;
    }
  }

  // ── POST /api/labels/:name/grants ─────────────────────────────────────────
  const grantsMatch = pathname.match(/^\/api\/labels\/([^/]+)\/grants$/);
  if (req.method === 'POST' && grantsMatch) {
    if (!isSuperuser(user.id)) return json({ error: 'Forbidden' }, 403);

    const labelName = decodeURIComponent(grantsMatch[1]);

    let body: { userId?: unknown; tenantId?: unknown };
    try {
      body = await req.json();
    } catch {
      return json({ error: 'Invalid JSON body' }, 400);
    }

    if (typeof body.userId !== 'string' || !body.userId.trim()) {
      return json({ error: 'userId is required' }, 400);
    }

    const tenantId =
      body.tenantId === undefined ? null : typeof body.tenantId === 'string' ? body.tenantId : null;

    try {
      const grant = await grantUserLabel(sql, {
        userId: body.userId,
        labelName,
        tenantId,
        grantedBy: user.id,
      });

      await emitAuditEvent({
        actor_id: user.id,
        action: 'label.grant',
        entity_type: 'user_label',
        entity_id: grant.id,
        before: null,
        after: { user_id: grant.user_id, label_name: grant.label_name, tenant_id: grant.tenant_id },
        ts: new Date().toISOString(),
      }).catch((err) => console.warn('[audit] label.grant audit write failed:', err));

      return json({ grant }, 201);
    } catch (err) {
      if (err instanceof LabelNotFoundError) return json({ error: err.message }, 404);
      throw err;
    }
  }

  // ── GET /api/labels/:name/grants ──────────────────────────────────────────
  if (req.method === 'GET' && grantsMatch) {
    if (!isSuperuser(user.id)) return json({ error: 'Forbidden' }, 403);

    const labelName = decodeURIComponent(grantsMatch[1]);
    const tenantId = url.searchParams.get('tenantId') ?? null;

    // List all users with this label by joining user_labels.
    // Since listUserLabels is keyed by userId, do a label-centric query inline.
    interface GrantRow {
      id: string;
      user_id: string;
      label_name: string;
      tenant_id: string | null;
      granted_by: string;
      granted_at: string;
    }

    let grants: GrantRow[];
    if (tenantId === null) {
      grants = await sql<GrantRow[]>`
        SELECT id, user_id, label_name, tenant_id, granted_by, granted_at
        FROM user_labels
        WHERE label_name = ${labelName} AND tenant_id IS NULL
        ORDER BY granted_at DESC
      `;
    } else {
      grants = await sql<GrantRow[]>`
        SELECT id, user_id, label_name, tenant_id, granted_by, granted_at
        FROM user_labels
        WHERE label_name = ${labelName} AND tenant_id = ${tenantId}
        ORDER BY granted_at DESC
      `;
    }
    return json({ grants });
  }

  // ── DELETE /api/labels/:name/grants/:userId ───────────────────────────────
  const revokeMatch = pathname.match(/^\/api\/labels\/([^/]+)\/grants\/([^/]+)$/);
  if (req.method === 'DELETE' && revokeMatch) {
    if (!isSuperuser(user.id)) return json({ error: 'Forbidden' }, 403);

    const labelName = decodeURIComponent(revokeMatch[1]);
    const targetUserId = decodeURIComponent(revokeMatch[2]);
    const tenantId = url.searchParams.get('tenantId') ?? null;

    try {
      await revokeUserLabel(sql, targetUserId, labelName, tenantId);

      await emitAuditEvent({
        actor_id: user.id,
        action: 'label.revoke',
        entity_type: 'user_label',
        entity_id: `${targetUserId}:${labelName}`,
        before: { user_id: targetUserId, label_name: labelName, tenant_id: tenantId },
        after: null,
        ts: new Date().toISOString(),
      }).catch((err) => console.warn('[audit] label.revoke audit write failed:', err));

      return json({ success: true });
    } catch (err) {
      if (err instanceof LabelGrantNotFoundError) return json({ error: err.message }, 404);
      throw err;
    }
  }

  // ── POST /api/labels/:name/ground-truth ───────────────────────────────────
  const groundTruthListMatch = pathname.match(/^\/api\/labels\/([^/]+)\/ground-truth$/);
  if (req.method === 'POST' && groundTruthListMatch) {
    if (!isSuperuser(user.id)) return json({ error: 'Forbidden' }, 403);

    const labelName = decodeURIComponent(groundTruthListMatch[1]);

    let body: { entityId?: unknown; tenantId?: unknown; plaintext?: unknown };
    try {
      body = await req.json();
    } catch {
      return json({ error: 'Invalid JSON body' }, 400);
    }

    if (typeof body.entityId !== 'string' || !body.entityId.trim()) {
      return json({ error: 'entityId is required' }, 400);
    }
    if (typeof body.plaintext !== 'string') {
      return json({ error: 'plaintext is required and must be a string' }, 400);
    }

    const tenantId =
      body.tenantId === undefined ? null : typeof body.tenantId === 'string' ? body.tenantId : null;

    try {
      const record = await writeLabeledGroundTruth(sql, {
        entityId: body.entityId,
        labelName,
        tenantId,
        plaintext: body.plaintext,
        createdBy: user.id,
      });

      await emitAuditEvent({
        actor_id: user.id,
        action: 'label.ground_truth.write',
        entity_type: 'labeled_ground_truth',
        entity_id: record.id,
        before: null,
        after: {
          entity_id: record.entity_id,
          label_name: record.label_name,
          tenant_id: record.tenant_id,
        },
        ts: new Date().toISOString(),
      }).catch((err) => console.warn('[audit] label.ground_truth.write audit write failed:', err));

      // Return the record metadata — never the encrypted_content bytes directly.
      return json(
        {
          record: {
            id: record.id,
            entity_id: record.entity_id,
            label_name: record.label_name,
            tenant_id: record.tenant_id,
            created_by: record.created_by,
            created_at: record.created_at,
          },
        },
        201,
      );
    } catch (err) {
      if (err instanceof LabelNotFoundError) return json({ error: err.message }, 404);
      if (err instanceof LabelContentKeyMissingError) return json({ error: err.message }, 422);
      throw err;
    }
  }

  // ── GET /api/labels/:name/ground-truth/:entityId ──────────────────────────
  const groundTruthReadMatch = pathname.match(/^\/api\/labels\/([^/]+)\/ground-truth\/([^/]+)$/);
  if (req.method === 'GET' && groundTruthReadMatch) {
    const labelName = decodeURIComponent(groundTruthReadMatch[1]);
    const entityId = decodeURIComponent(groundTruthReadMatch[2]);
    const tenantId = url.searchParams.get('tenantId') ?? null;

    // Superusers bypass the label clearance check — they can read any record.
    const requestingUserId = isSuperuser(user.id)
      ? null // null means skip grant check below
      : user.id;

    try {
      let plaintext: string;
      let record: Awaited<ReturnType<typeof readLabeledGroundTruth>>['record'];

      if (requestingUserId === null) {
        // Superuser path: fetch directly without label clearance check.
        const label = await getAccessLabel(sql, labelName, tenantId);
        if (!label) return json({ error: `Label "${labelName}" not found` }, 404);

        interface RawRow {
          id: string;
          entity_id: string;
          label_name: string;
          tenant_id: string | null;
          encrypted_content: string;
          created_by: string;
          created_at: string;
        }

        let rows: RawRow[];
        if (tenantId === null) {
          rows = await sql<RawRow[]>`
            SELECT id, entity_id, label_name, tenant_id, encrypted_content, created_by, created_at
            FROM labeled_ground_truth
            WHERE entity_id = ${entityId} AND label_name = ${labelName} AND tenant_id IS NULL
            LIMIT 1
          `;
        } else {
          rows = await sql<RawRow[]>`
            SELECT id, entity_id, label_name, tenant_id, encrypted_content, created_by, created_at
            FROM labeled_ground_truth
            WHERE entity_id = ${entityId} AND label_name = ${labelName} AND tenant_id = ${tenantId}
            LIMIT 1
          `;
        }

        if (rows.length === 0) {
          return json(
            {
              error: `No labeled ground truth found for entity "${entityId}" with label "${labelName}"`,
            },
            404,
          );
        }

        record = rows[0];
        const { decryptLabeledContent: dec } = await import('db/label-clearance');
        plaintext = await dec(label, record.encrypted_content);
      } else {
        const result = await readLabeledGroundTruth(sql, {
          entityId,
          labelName,
          tenantId,
          requestingUserId,
        });
        record = result.record;
        plaintext = result.plaintext;
      }

      return json({
        id: record.id,
        entity_id: record.entity_id,
        label_name: record.label_name,
        tenant_id: record.tenant_id,
        created_by: record.created_by,
        created_at: record.created_at,
        content: plaintext,
      });
    } catch (err) {
      if (err instanceof LabelClearanceDeniedError) return json({ error: err.message }, 403);
      if (err instanceof LabelNotFoundError) return json({ error: err.message }, 404);
      if (err instanceof LabelContentKeyMissingError) return json({ error: err.message }, 422);
      // LabeledGroundTruthNotFoundError
      if ((err as Error).name === 'LabeledGroundTruthNotFoundError') {
        return json({ error: (err as Error).message }, 404);
      }
      throw err;
    }
  }

  return null;
}
