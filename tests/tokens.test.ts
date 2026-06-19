import { describe, it, expect } from 'vitest';
import {
  approximateTokenCounter,
  tiktokenCounter,
  DEFAULT_TOKEN_COUNTER,
} from '../src/tokens.js';

/**
 * The token counter is the size signal behind F1 (§4.1) and F5 (§4.5). v0.1
 * uses tiktoken cl100k_base as the default, with the chars/4 approximation kept
 * as a dependency-free fallback.
 */

describe('tiktokenCounter (§4.1 default)', () => {
  it('counts the empty string as zero tokens', () => {
    expect(tiktokenCounter('')).toBe(0);
  });

  it('produces real cl100k_base counts', () => {
    expect(tiktokenCounter('hello world')).toBe(2);
  });

  it('grows with input length', () => {
    const short = tiktokenCounter('one two three');
    const long = tiktokenCounter('one two three '.repeat(50));
    expect(long).toBeGreaterThan(short);
  });

  it('is the default counter (chars/4 must not drive a real audit)', () => {
    expect(DEFAULT_TOKEN_COUNTER).toBe(tiktokenCounter);
  });
});

describe('approximateTokenCounter (dependency-free fallback)', () => {
  it('counts the empty string as zero tokens', () => {
    expect(approximateTokenCounter('')).toBe(0);
  });

  it('approximates ~4 characters per token, rounding up', () => {
    expect(approximateTokenCounter('a'.repeat(4000))).toBe(1000);
    expect(approximateTokenCounter('a'.repeat(4001))).toBe(1001);
  });
});
