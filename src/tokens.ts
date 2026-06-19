/**
 * Token counting: the size signal behind MONOLITHIC_CONTEXT (§4.1) and
 * LAYER_BLOAT (§4.5).
 *
 * SPEC §4.1 mandates tiktoken `cl100k_base` as the proxy for Claude's
 * tokenizer. v0.1 wires it (`js-tiktoken`, pure JS, ranks bundled) as the
 * default counter, behind the `TokenCounter` seam so a different tokenizer can
 * be injected. The earlier chars/4 approximation is kept as a dependency-free
 * fallback but is not the default: it under-counts dense Markdown and must not
 * drive a real audit (a ~15KB structured file lands near the 4,000-token cap by
 * tiktoken but below it by chars/4).
 *
 * Thresholds are deliberately NOT tuned to reproduce any one hand-audit; see
 * SPEC §5 (open question 3). Files a human calls "monolithic" by judgement may
 * sit under the spec's size caps and be caught instead by LAYER_BLOAT / W3, or
 * not mechanically caught at all. Honest under-reporting is the correct v0.1
 * outcome.
 */

import { getEncoding } from 'js-tiktoken';
import type { Tiktoken } from 'js-tiktoken';

/** Counts the tokens in a piece of text. */
export type TokenCounter = (text: string) => number;

/** Lazily built `cl100k_base` encoder; the ranks load on first use. */
let encoder: Tiktoken | null = null;

/** Token count via tiktoken `cl100k_base` (SPEC §4.1). */
export const tiktokenCounter: TokenCounter = (text) => {
  encoder ??= getEncoding('cl100k_base');
  return encoder.encode(text).length;
};

/**
 * Approximate token count: ~4 characters per token, rounded up. A
 * dependency-free fallback; under-counts dense Markdown, so it is not the
 * default and must not drive a real audit (see the module note).
 */
export const approximateTokenCounter: TokenCounter = (text) =>
  Math.ceil(text.length / 4);

/** The counter the audit runner uses unless one is injected. */
export const DEFAULT_TOKEN_COUNTER: TokenCounter = tiktokenCounter;
