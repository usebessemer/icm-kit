/**
 * Token counting: the size signal behind MONOLITHIC_CONTEXT (§4.1) and
 * LAYER_BLOAT (§4.5).
 *
 * SPEC §4.1 mandates tiktoken `cl100k_base` as the proxy for Claude's
 * tokenizer. v0.1 ships an approximate stand-in (roughly four characters per
 * token) abstracted behind the `TokenCounter` type, so a precise tiktoken
 * implementation can be injected without touching the rules.
 *
 * Caveat for the AIOS milestone run: the chars/4 approximation under-counts
 * dense Markdown relative to real `cl100k_base` (a ~15KB structured file lands
 * near the 4,000-token cap by tiktoken but below it by chars/4). Wire a real
 * tiktoken counter before auditing borderline real workspaces. For synthetic
 * fixtures, size files clearly past the threshold so the approximation holds.
 */

/** Counts the tokens in a piece of text. */
export type TokenCounter = (text: string) => number;

/**
 * Approximate token count: ~4 characters per token, rounded up. A deliberate
 * stand-in for tiktoken `cl100k_base` (SPEC §4.1); see the module caveat.
 */
export const approximateTokenCounter: TokenCounter = (text) =>
  Math.ceil(text.length / 4);

/** The counter the audit runner uses unless one is injected. */
export const DEFAULT_TOKEN_COUNTER: TokenCounter = approximateTokenCounter;
