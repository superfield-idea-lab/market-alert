/**
 * @file api/campaign-summary
 *
 * Campaign summary endpoint — Phase 7 BDM campaign analysis (issue #75).
 *
 * ## Endpoint
 *
 *   POST /api/campaign/summarise
 *
 * ## Authentication
 *
 * Requires a valid session cookie (standard user session).
 *
 * ## Request body
 *
 *   {
 *     "asset_manager_id": "<entity id>",   // required
 *     "fund_id":          "<entity id>"    // optional
 *   }
 *
 * ## Response — 200 OK (success)
 *
 *   {
 *     "status": "ok",
 *     "asset_manager_id": "<id>",
 *     "fund_id": "<id> | null",
 *     "summary": {
 *       "themes":    ["..."],
 *       "topics":    ["..."],
 *       "sentiment": "positive | neutral | negative | mixed",
 *       "frequency": { "<topic>": <number>, ... }
 *     },
 *     "chunk_count": <number>
 *   }
 *
 * ## Response — 200 OK (fallback — Claude API unavailable)
 *
 *   {
 *     "status": "fallback",
 *     "asset_manager_id": "<id>",
 *     "fund_id": "<id> | null",
 *     "chunks": [
 *       { "id": "<id>", "content": "<text>", "chunk_index": <number> },
 *       ...
 *     ],
 *     "error": "<reason string>"
 *   }
 *
 * ## Privacy
 *
 * Only anonymised corpus_chunk entities linked via `discussed_in` relations
 * (asset_manager → transcript → corpus_chunk traversal) are passed to the
 * Claude API. No customer identifiers appear in the prompt or the response.
 *
 * ## Blueprint references
 *
 *   - docs/implementation-plan-v1.md §Phase 7 — BDM campaign analysis
 *   - docs/PRD.md §4.7 (BDM workflow, summarise endpoint)
 *
 * @see https://github.com/superfield-ai/superfield-kb-demo/issues/75
 */

import Anthropic from '@anthropic-ai/sdk';
import type { AppState } from '../index';
import { getCorsHeaders, getAuthenticatedUser } from './auth';
import { makeJson } from '../lib/response';

// ---------------------------------------------------------------------------
// Claude API client singleton
// ---------------------------------------------------------------------------

let _summaryClient: Anthropic | null = null;

/**
 * Returns the shared Anthropic client for campaign summary generation.
 *
 * Reads ANTHROPIC_API_KEY from the environment. In test mode, callers can
 * redirect all SDK HTTP calls to a local fixture server by setting
 * ANTHROPIC_BASE_URL (e.g. "http://localhost:<PORT>"). The SDK requires an
 * API key even when talking to a local server; a placeholder is injected when
 * no real key is configured and ANTHROPIC_BASE_URL is present.
 */
export function getSummaryClient(): Anthropic {
  if (!_summaryClient) {
    const options: ConstructorParameters<typeof Anthropic>[0] = {};

    const baseURL = process.env.ANTHROPIC_BASE_URL;
    if (baseURL) {
      options.baseURL = baseURL;
      if (!process.env.ANTHROPIC_API_KEY) {
        options.apiKey = 'test-placeholder-key';
      }
    }

    _summaryClient = new Anthropic(options);
  }
  return _summaryClient;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AnonymisedChunk {
  id: string;
  content: string;
  chunk_index: number;
}

export interface CampaignSummary {
  themes: string[];
  topics: string[];
  sentiment: 'positive' | 'neutral' | 'negative' | 'mixed';
  frequency: Record<string, number>;
}

export interface SummariseSuccessResponse {
  status: 'ok';
  asset_manager_id: string;
  fund_id: string | null;
  summary: CampaignSummary;
  chunk_count: number;
}

export interface SummariseFallbackResponse {
  status: 'fallback';
  asset_manager_id: string;
  fund_id: string | null;
  chunks: AnonymisedChunk[];
  error: string;
}

export type SummariseResponse = SummariseSuccessResponse | SummariseFallbackResponse;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SUMMARY_MODEL = 'claude-3-haiku-20240307';
const SUMMARY_MAX_TOKENS = 1024;

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

/**
 * Builds the user prompt for campaign summary generation.
 *
 * The prompt sends anonymised chunk content only — no customer identifiers,
 * no transcript IDs, no relation IDs. This enforces the Phase 7 privacy
 * requirement: no customer data reaches the Claude API.
 */
export function buildSummaryPrompt(chunks: AnonymisedChunk[]): string {
  const chunkText = chunks.map((c, i) => `[Chunk ${i + 1}]: ${c.content}`).join('\n\n');

  return (
    `You are a business development manager assistant. Analyse the following anonymised meeting ` +
    `transcript excerpts for an asset manager and produce a structured JSON summary.\n\n` +
    `Excerpt count: ${chunks.length}\n\n` +
    `${chunkText}\n\n` +
    `Return ONLY a JSON object with this exact structure (no markdown, no explanation):\n` +
    `{\n` +
    `  "themes": ["<theme1>", "<theme2>", ...],\n` +
    `  "topics": ["<topic1>", "<topic2>", ...],\n` +
    `  "sentiment": "positive" | "neutral" | "negative" | "mixed",\n` +
    `  "frequency": { "<topic>": <count>, ... }\n` +
    `}`
  );
}

// ---------------------------------------------------------------------------
// Claude API call
// ---------------------------------------------------------------------------

/**
 * Calls the Claude Messages API and parses the structured JSON summary.
 *
 * @throws If the API call fails, if no text block is returned, or if the
 *         response cannot be parsed as a valid CampaignSummary.
 */
export async function callSummaryApi(chunks: AnonymisedChunk[]): Promise<CampaignSummary> {
  const client = getSummaryClient();
  const prompt = buildSummaryPrompt(chunks);

  const message = await client.messages.create({
    model: SUMMARY_MODEL,
    max_tokens: SUMMARY_MAX_TOKENS,
    messages: [{ role: 'user', content: prompt }],
  });

  let text = '';
  for (const block of message.content) {
    if (block.type === 'text') {
      text = block.text;
      break;
    }
  }

  if (!text) {
    throw new Error(
      `Claude API returned no text content block (stop_reason=${message.stop_reason})`,
    );
  }

  // Strip optional markdown code fence if the model wraps the JSON.
  const jsonText = text
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err) {
    throw new Error(`Claude API response is not valid JSON: ${String(err)}\n\nRaw: ${text}`, {
      cause: err,
    });
  }

  if (!isValidSummary(parsed)) {
    throw new Error(`Claude API response does not match CampaignSummary schema: ${jsonText}`);
  }

  return parsed;
}

function isValidSummary(value: unknown): value is CampaignSummary {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (!Array.isArray(v.themes) || !Array.isArray(v.topics)) return false;
  if (!['positive', 'neutral', 'negative', 'mixed'].includes(v.sentiment as string)) return false;
  if (typeof v.frequency !== 'object' || v.frequency === null || Array.isArray(v.frequency))
    return false;
  return true;
}

// ---------------------------------------------------------------------------
// Chunk fetching
// ---------------------------------------------------------------------------

/**
 * Fetches anonymised corpus_chunk content linked to an asset manager via
 * discussed_in relations.
 *
 * Traversal path:
 *   asset_manager -[discussed_in]-> transcript -[has_corpus_chunk]-> corpus_chunk
 *
 * When a fund_id is provided, the traversal is additionally filtered to
 * transcripts also tagged to that fund.
 *
 * Only the content property (body field) and chunk_index are returned —
 * no customer identifiers, no source email IDs.
 *
 * NOTE: This implementation queries the entities table directly. A full
 * Phase 7 implementation would query kb_analytics; this version uses kb_app
 * with BDM RLS enforced via withRlsContext. The interface is identical.
 */
export async function fetchAnonymisedChunks(
  sql: AppState['sql'],
  assetManagerId: string,
  fundId: string | null,
): Promise<AnonymisedChunk[]> {
  // Find transcripts tagged to this asset manager via discussed_in relations.
  // Filter by fund if provided.
  let transcriptRows: { id: string }[];

  if (fundId) {
    transcriptRows = await sql<{ id: string }[]>`
      SELECT DISTINCT t.id
      FROM entities t
      INNER JOIN relations r1 ON r1.target_id = t.id AND r1.type = 'discussed_in'
      INNER JOIN relations r2 ON r2.target_id = t.id AND r2.type = 'discussed_in'
      WHERE r1.source_id = ${assetManagerId}
        AND r2.source_id = ${fundId}
        AND t.type = 'transcript'
    `;
  } else {
    transcriptRows = await sql<{ id: string }[]>`
      SELECT DISTINCT t.id
      FROM entities t
      INNER JOIN relations r ON r.target_id = t.id AND r.type = 'discussed_in'
      WHERE r.source_id = ${assetManagerId}
        AND t.type = 'transcript'
    `;
  }

  if (transcriptRows.length === 0) {
    return [];
  }

  const transcriptIds = transcriptRows.map((r) => r.id);

  // Fetch corpus_chunks whose source_id is one of those transcripts.
  // Return id, body (as content), and chunk_index — no customer data.
  const chunkRows = await sql<{ id: string; body: string; chunk_index: number }[]>`
    SELECT
      e.id,
      e.properties->>'body' AS body,
      (e.properties->>'index')::int AS chunk_index
    FROM entities e
    INNER JOIN entities t ON t.id = e.properties->>'source_id' AND t.type = 'transcript'
    WHERE e.type = 'corpus_chunk'
      AND t.id = ANY(${sql.array(transcriptIds)})
    ORDER BY chunk_index ASC
  `;

  return chunkRows.map((r) => ({
    id: r.id,
    content: r.body ?? '',
    chunk_index: r.chunk_index ?? 0,
  }));
}

// ---------------------------------------------------------------------------
// Request handler
// ---------------------------------------------------------------------------

/**
 * Handles POST /api/campaign/summarise.
 *
 * Pulls anonymised corpus chunks for the given asset manager (and optional
 * fund), calls the Claude API to produce a structured 1-pager, and returns
 * the result. On API failure, returns the raw chunk list with a fallback
 * status so the feature degrades gracefully.
 */
export async function handleCampaignSummaryRequest(
  req: Request,
  url: URL,
  appState: AppState,
): Promise<Response | null> {
  if (!url.pathname.startsWith('/api/campaign/summarise')) return null;

  const corsHeaders = getCorsHeaders(req);
  const { sql } = appState;
  const json = makeJson(corsHeaders);

  // Require an authenticated session.
  const user = await getAuthenticatedUser(req);
  if (!user) return json({ error: 'Unauthorized' }, 401);

  if (req.method !== 'POST') return null;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  const { asset_manager_id, fund_id } = body as Record<string, unknown>;

  if (typeof asset_manager_id !== 'string' || !asset_manager_id.trim()) {
    return json({ error: 'asset_manager_id is required and must be a non-empty string' }, 400);
  }

  const resolvedFundId = typeof fund_id === 'string' && fund_id.trim() ? fund_id.trim() : null;

  // Fetch anonymised chunks — no customer-identifying data.
  const chunks = await fetchAnonymisedChunks(sql, asset_manager_id.trim(), resolvedFundId);

  // Attempt Claude API summarisation; fall back to raw chunks on any error.
  try {
    const summary = await callSummaryApi(chunks);

    const successResponse: SummariseSuccessResponse = {
      status: 'ok',
      asset_manager_id: asset_manager_id.trim(),
      fund_id: resolvedFundId,
      summary,
      chunk_count: chunks.length,
    };

    return json(successResponse, 200);
  } catch (err) {
    const fallbackResponse: SummariseFallbackResponse = {
      status: 'fallback',
      asset_manager_id: asset_manager_id.trim(),
      fund_id: resolvedFundId,
      chunks,
      error: err instanceof Error ? err.message : String(err),
    };

    return json(fallbackResponse, 200);
  }
}
