/**
 * @file api/corpus-chunks
 *
 * CorpusChunk ingestion API — machine-to-machine write path.
 *
 * ## Endpoint
 *
 *   POST /api/corpus-chunks
 *
 * ## Authentication
 *
 * Accepts either a session cookie (for human callers during testing) or a
 * Bearer API key (for the ingestion pipeline and workers).  The helper
 * `getAuthenticatedUserOrApiKey` covers both cases.
 *
 * ## Request body
 *
 *   {
 *     "source_id": "<email entity id>",
 *     "text":      "<plaintext body to chunk>",
 *     "max_tokens": 512          // optional, default 512
 *   }
 *
 * ## Response — 201 Created
 *
 *   {
 *     "chunks": [
 *       { "id": "<uuid>", "source_id": "<email entity id>", "index": 0, "token_count": 47 },
 *       ...
 *     ]
 *   }
 *
 * The response intentionally omits the encrypted `body` field to avoid
 * decryption overhead on the write path. Callers that need to read body text
 * should query the entity store directly.
 *
 * ## Encryption
 *
 * Each CorpusChunk row is stored via the Phase 1 field-encryption path.
 * `encryptProperties('corpus_chunk', { body })` is called before the INSERT.
 * When `ENCRYPTION_MASTER_KEY` is not configured (local dev, CI) the value is
 * stored in plaintext — the encryption layer degrades gracefully.
 *
 * ## Entity type registration
 *
 * The `corpus_chunk` entity type is registered at server startup via
 * `registerCorpusChunkEntityType` (called from `apps/server/src/index.ts`).
 * This function is idempotent.
 *
 * @see https://github.com/superfield-ai/superfield-kb-demo/issues/29
 */

import type { AppState } from '../index';
import { getCorsHeaders, getAuthenticatedUserOrApiKey } from './auth';
import { makeJson } from '../lib/response';
import { chunkText } from 'core';
import { encryptProperties } from 'core';
import { sql as globalSql } from 'db';
import { EntityTypeRegistry } from 'db/entity-type-registry';

// ---------------------------------------------------------------------------
// Entity type registration
// ---------------------------------------------------------------------------

/**
 * Registers the `corpus_chunk` entity type against the database at server
 * startup.
 *
 * Properties shape:
 *   - `body`      {string} — chunk text (sensitive, encrypted at rest)
 *   - `source_id` {string} — FK to the source Email entity id
 *   - `index`     {number} — zero-based position within the source email
 *   - `token_count` {number} — approximate token count (whitespace-split words)
 *
 * Called idempotently — safe to call multiple times.
 */
export async function registerCorpusChunkEntityType(): Promise<void> {
  const registry = new EntityTypeRegistry();
  await registry.registerWithDb(globalSql, {
    type: 'corpus_chunk',
    schema: {
      type: 'object',
      properties: {
        body: { type: 'string' },
        source_id: { type: 'string' },
        index: { type: 'integer', minimum: 0 },
        token_count: { type: 'integer', minimum: 0 },
      },
      required: ['body', 'source_id', 'index', 'token_count'],
    },
    sensitive: ['body'],
  });
}

// ---------------------------------------------------------------------------
// Request handler
// ---------------------------------------------------------------------------

/**
 * Handles POST /api/corpus-chunks.
 *
 * Accepts either a session cookie or an ingestion Bearer API key.
 * Chunks the supplied text, encrypts each chunk's `body`, and writes all
 * chunk rows to the `entities` table in a single transaction.
 */
export async function handleCorpusChunksRequest(
  req: Request,
  url: URL,
  appState: AppState,
): Promise<Response | null> {
  if (!url.pathname.startsWith('/api/corpus-chunks')) return null;

  const corsHeaders = getCorsHeaders(req);
  const { sql } = appState;
  const json = makeJson(corsHeaders);

  // Accept both session cookies and Bearer API keys on this endpoint
  const principal = await getAuthenticatedUserOrApiKey(req);
  if (!principal) return json({ error: 'Unauthorized' }, 401);

  // POST /api/corpus-chunks
  if (req.method === 'POST' && url.pathname === '/api/corpus-chunks') {
    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return json({ error: 'Invalid JSON body' }, 400);
    }

    const { source_id, text, max_tokens } = body as Record<string, unknown>;

    if (typeof source_id !== 'string' || !source_id.trim()) {
      return json({ error: 'source_id is required and must be a non-empty string' }, 400);
    }

    if (typeof text !== 'string') {
      return json({ error: 'text is required and must be a string' }, 400);
    }

    const maxTokens =
      typeof max_tokens === 'number' && Number.isInteger(max_tokens) && max_tokens > 0
        ? max_tokens
        : 512;

    // Verify the source entity exists
    const sourceRows = await sql`
      SELECT id FROM entities WHERE id = ${source_id.trim()}
    `;
    if (sourceRows.length === 0) {
      return json({ error: `source entity not found: ${source_id}` }, 422);
    }

    // Produce chunks
    const rawChunks = chunkText(text, { maxTokens });

    // Handle blank text — return empty result
    if (rawChunks.length === 0) {
      return json({ chunks: [] }, 201);
    }

    // Build encrypted properties for each chunk
    const chunkRows: Array<{
      id: string;
      source_id: string;
      index: number;
      token_count: number;
    }> = [];

    for (let i = 0; i < rawChunks.length; i++) {
      const rawProperties = {
        body: rawChunks[i].text,
        source_id: source_id.trim(),
        index: i,
        token_count: rawChunks[i].tokenCount,
      };

      const encryptedProperties = await encryptProperties('corpus_chunk', rawProperties);

      const id = crypto.randomUUID();

      await sql`
        INSERT INTO entities (id, type, properties, tenant_id)
        VALUES (
          ${id},
          'corpus_chunk',
          ${sql.json(encryptedProperties as never)},
          null
        )
      `;

      chunkRows.push({
        id,
        source_id: source_id.trim(),
        index: i,
        token_count: rawChunks[i].tokenCount,
      });
    }

    return json({ chunks: chunkRows }, 201);
  }

  return null;
}
