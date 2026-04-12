/**
 * @file annotation-agent.ts
 *
 * Anthropic API SDK client for annotation thread replies — Phase 6 (issue #65).
 *
 * When an RM opens an annotation thread on a wiki page passage, this module
 * calls the Anthropic Messages API to produce a concise suggested correction.
 * The reply is returned as a plain string ready to be stored in the
 * `thread` JSONB field of a `wiki_annotation` entity.
 *
 * ## Design decisions
 *
 * - Uses `@anthropic-ai/sdk` directly (not the Claude CLI) per PRD §6.
 * - The model and max_tokens are kept conservative for interactive latency.
 * - The system prompt encodes the correction assistant persona only; no
 *   prompt tuning beyond a working default is in scope for this issue.
 * - The ANTHROPIC_API_KEY environment variable is required in production;
 *   in test mode the key may be a placeholder because MSW intercepts the call.
 *
 * ## Blueprint references
 *
 *   - PRD §6 — Anthropic API SDK (annotation agent)
 *   - Implementation plan Phase 6 — annotation agent backed by Anthropic API SDK
 *
 * @see https://github.com/superfield-ai/superfield-kb-demo/issues/65
 */

import Anthropic from '@anthropic-ai/sdk';

// ---------------------------------------------------------------------------
// Client singleton
// ---------------------------------------------------------------------------

let _client: Anthropic | null = null;

/**
 * Returns the shared Anthropic client instance, creating it on first call.
 *
 * The client uses the `ANTHROPIC_API_KEY` environment variable automatically
 * (the SDK reads it at construction time). In test mode the key may be a
 * placeholder because a real `node:http` server is started on a local port and
 * ANTHROPIC_BASE_URL is set to redirect the SDK's HTTP calls to that server,
 * which replays the golden fixture response.
 */
export function getAnnotationClient(): Anthropic {
  if (!_client) {
    const options: ConstructorParameters<typeof Anthropic>[0] = {};

    // Allow tests to redirect all Anthropic API calls to a local fixture server
    // by setting ANTHROPIC_BASE_URL (e.g. "http://localhost:PORT").
    const baseURL = process.env.ANTHROPIC_BASE_URL;
    if (baseURL) {
      options.baseURL = baseURL;
      // The SDK requires an API key even when talking to a local fixture server.
      // Use a placeholder when no real key is configured.
      if (!process.env.ANTHROPIC_API_KEY) {
        options.apiKey = 'test-placeholder-key';
      }
    }

    _client = new Anthropic(options);
  }
  return _client;
}

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

const ANNOTATION_MODEL = 'claude-3-haiku-20240307';
const ANNOTATION_MAX_TOKENS = 512;

/**
 * Constructs the user message for the annotation correction request.
 *
 * The prompt presents:
 *   1. The selected wiki page passage the RM flagged.
 *   2. The RM's opening comment describing the perceived error.
 *
 * The agent is asked to produce a concise corrected version of the passage.
 */
export function buildAnnotationPrompt(passage: string, rmComment: string): string {
  return (
    `You are a knowledge base correction assistant. An RM has flagged the following passage as potentially incorrect:\n\n` +
    `Passage: "${passage}"\n` +
    `RM comment: "${rmComment}"\n\n` +
    `Provide a concise corrected version of the passage.`
  );
}

// ---------------------------------------------------------------------------
// Agent call
// ---------------------------------------------------------------------------

/**
 * Calls the Anthropic Messages API to produce a suggested correction for
 * the annotated passage.
 *
 * @param passage   - The verbatim wiki page passage the RM selected.
 * @param rmComment - The RM's opening comment.
 * @returns The agent's reply text (first content block of type "text").
 * @throws  If the API call fails or returns an unexpected shape.
 */
export async function callAnnotationAgent(passage: string, rmComment: string): Promise<string> {
  const client = getAnnotationClient();
  const prompt = buildAnnotationPrompt(passage, rmComment);

  const message = await client.messages.create({
    model: ANNOTATION_MODEL,
    max_tokens: ANNOTATION_MAX_TOKENS,
    messages: [{ role: 'user', content: prompt }],
  });

  // Extract the first text content block.
  for (const block of message.content) {
    if (block.type === 'text') {
      return block.text;
    }
  }

  throw new Error(
    `Anthropic API returned no text content block (stop_reason=${message.stop_reason})`,
  );
}
