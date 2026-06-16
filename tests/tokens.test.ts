import { describe, it, expect } from 'vitest';
import {
  approximateTokenCounter,
  DEFAULT_TOKEN_COUNTER,
} from '../src/tokens.js';

/**
 * The token counter is the size signal behind F1 (§4.1) and F5 (§4.5). SPEC
 * §4.1 mandates tiktoken cl100k_base; v0.1 ships an approximate stand-in
 * abstracted behind TokenCounter so the precise tokenizer can be swapped in.
 * These tests pin the approximation's contract, not exact tiktoken parity.
 */

describe('approximateTokenCounter (§4.1 stand-in)', () => {
  it('counts the empty string as zero tokens', () => {
    expect(approximateTokenCounter('')).toBe(0);
  });

  it('approximates ~4 characters per token, rounding up', () => {
    expect(approximateTokenCounter('a'.repeat(4000))).toBe(1000);
    expect(approximateTokenCounter('a'.repeat(4001))).toBe(1001);
  });

  it('grows monotonically with input length', () => {
    const short = approximateTokenCounter('a'.repeat(100));
    const long = approximateTokenCounter('a'.repeat(1000));
    expect(long).toBeGreaterThan(short);
  });

  it('is the default counter', () => {
    expect(DEFAULT_TOKEN_COUNTER).toBe(approximateTokenCounter);
  });
});
