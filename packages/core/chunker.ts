/**
 * @file chunker
 *
 * Sentence-boundary, max-tokens chunker for CorpusChunk production.
 *
 * ## Design
 *
 * Given a string of text (e.g. the plaintext body of an Email entity), the
 * chunker splits the text into an ordered list of chunks that satisfy:
 *
 *   1. Each chunk is no longer than `maxTokens` tokens, where a token is
 *      approximated as a whitespace-delimited word. The approximation is
 *      intentionally simple so that the chunker has no external dependencies
 *      and is deterministic across environments.
 *
 *   2. Chunk boundaries fall on sentence boundaries wherever possible.
 *      A sentence boundary is detected with a simple regex:
 *        - a period, exclamation mark, or question mark
 *        - followed by optional closing punctuation ('"', ''', ')', ']', '}')
 *        - followed by whitespace or end-of-string
 *
 *   3. If a single sentence exceeds `maxTokens`, it is split at word
 *      boundaries so that the ceiling is never exceeded.
 *
 * ## Token counting
 *
 * `countTokens(text)` splits on whitespace runs and returns the count.
 * This is an intentional simplification: a production deployment would use
 * a subword tokenizer (e.g. tiktoken for cl100k_base) to produce exact counts
 * that align with the embedding model's context window. The approximation is
 * adequate for Phase 2 where the model has not yet been selected.
 *
 * ## Usage
 *
 * ```ts
 * import { chunkText } from 'core/chunker';
 *
 * const chunks = chunkText(emailBody, { maxTokens: 512 });
 * // chunks: Array<{ text: string; tokenCount: number }>
 * ```
 *
 * ## Canonical docs
 *
 * - `docs/implementation-plan-v1.md` §Phase 2
 * - `docs/PRD.md` §Autolearning
 *
 * @see https://github.com/superfield-ai/superfield-kb-demo/issues/29
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** A single text chunk produced by the chunker. */
export interface TextChunk {
  /** Trimmed chunk text. */
  text: string;
  /** Approximate token count (whitespace-delimited words). */
  tokenCount: number;
}

/** Options for `chunkText`. */
export interface ChunkOptions {
  /**
   * Maximum number of tokens (whitespace-delimited words) per chunk.
   * Must be a positive integer. Defaults to 512.
   */
  maxTokens?: number;
}

// ---------------------------------------------------------------------------
// Token counting
// ---------------------------------------------------------------------------

/**
 * Counts the approximate number of tokens in a string.
 *
 * Tokens are approximated as whitespace-delimited word sequences. An empty
 * string or a string containing only whitespace returns 0.
 *
 * This approximation intentionally avoids subword tokenizer dependencies.
 * Replace this function with a tiktoken-based counter when the embedding
 * model is selected in a later phase.
 */
export function countTokens(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).length;
}

// ---------------------------------------------------------------------------
// Sentence splitting
// ---------------------------------------------------------------------------

/**
 * Splits `text` into candidate sentences using a lightweight regex.
 *
 * A sentence boundary is detected at any position where:
 *   - the preceding character is `.`, `!`, or `?`
 *   - optionally followed by closing punctuation: `"`, `'`, `)`, `]`, `}`
 *   - followed by one or more whitespace characters
 *
 * This heuristic handles the majority of English prose; it is not intended
 * to be a general-purpose sentence splitter.
 *
 * The returned strings are trimmed and non-empty.
 */
function splitIntoSentences(text: string): string[] {
  // Split on sentence-ending punctuation followed by whitespace.
  // Use a lookahead so the punctuation stays with the preceding sentence.
  const raw = text.split(/(?<=[.!?]['"')\]}\s]*)\s+/);
  return raw.map((s) => s.trim()).filter((s) => s.length > 0);
}

// ---------------------------------------------------------------------------
// Core chunker
// ---------------------------------------------------------------------------

/**
 * Splits `text` into an ordered list of chunks bounded by sentence boundaries
 * and a configurable max-tokens ceiling.
 *
 * @param text       - Input text to chunk (e.g. an email body).
 * @param options    - `{ maxTokens }` — defaults to 512.
 * @returns          An ordered array of `TextChunk` objects. Returns an empty
 *                   array when `text` is blank.
 *
 * @throws {RangeError} when `maxTokens` is not a positive integer.
 */
export function chunkText(text: string, options: ChunkOptions = {}): TextChunk[] {
  const maxTokens = options.maxTokens ?? 512;

  if (!Number.isInteger(maxTokens) || maxTokens < 1) {
    throw new RangeError(`chunkText: maxTokens must be a positive integer, got ${maxTokens}`);
  }

  const trimmed = text.trim();
  if (!trimmed) return [];

  const sentences = splitIntoSentences(trimmed);
  const chunks: TextChunk[] = [];
  let currentWords: string[] = [];

  for (const sentence of sentences) {
    const sentenceWords = sentence
      .trim()
      .split(/\s+/)
      .filter((w) => w.length > 0);

    if (sentenceWords.length === 0) continue;

    // If adding this sentence would exceed the ceiling, flush current buffer first.
    if (currentWords.length > 0 && currentWords.length + sentenceWords.length > maxTokens) {
      chunks.push(makeChunk(currentWords));
      currentWords = [];
    }

    // If the sentence itself exceeds the ceiling, split it at word boundaries.
    if (sentenceWords.length > maxTokens) {
      // Flush any words accumulated before this sentence
      if (currentWords.length > 0) {
        chunks.push(makeChunk(currentWords));
        currentWords = [];
      }

      // Emit full-ceiling slices from the oversized sentence
      for (let i = 0; i < sentenceWords.length; i += maxTokens) {
        const slice = sentenceWords.slice(i, i + maxTokens);
        chunks.push(makeChunk(slice));
      }
    } else {
      // Accumulate sentence words into the current buffer
      currentWords.push(...sentenceWords);
    }
  }

  // Flush any remaining words
  if (currentWords.length > 0) {
    chunks.push(makeChunk(currentWords));
  }

  return chunks;
}

/** Builds a TextChunk from an array of words. */
function makeChunk(words: string[]): TextChunk {
  const text = words.join(' ');
  return { text, tokenCount: words.length };
}
