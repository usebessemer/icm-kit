import { describe, it, expect } from 'vitest';
import { normalizePosix } from '../src/paths.js';

describe('normalizePosix', () => {
  it('collapses interior `..` into the joined parent (the F3 nested-CLAUDE.md case)', () => {
    // A pointer joined from a nested CLAUDE.md dir reduces to the tree entry it
    // names, so a membership test can match (SPEC §4.3).
    expect(normalizePosix('workspaces/x/../../context/f.md')).toBe('context/f.md');
  });

  it('collapses a single sibling hop', () => {
    expect(normalizePosix('workspaces/coaching/../oss/notes.md')).toBe(
      'workspaces/oss/notes.md',
    );
  });

  it('preserves leading `..` that escapes the root (security-relevant invariant)', () => {
    // A path that climbs above its own root cannot be collapsed without
    // inventing a parent: it stays literal so it resolves to nothing in the
    // tree rather than silently aliasing an in-tree path (SPEC §4.3).
    expect(normalizePosix('../../x')).toBe('../../x');
    expect(normalizePosix('../..')).toBe('../..');
    expect(normalizePosix('..')).toBe('..');
  });

  it('keeps escaping `..` ahead of real segments instead of cancelling them', () => {
    expect(normalizePosix('../context/f.md')).toBe('../context/f.md');
  });

  it('strips a leading `./`', () => {
    expect(normalizePosix('./context/f.md')).toBe('context/f.md');
  });

  it('strips a `.` segment anywhere', () => {
    expect(normalizePosix('context/./f.md')).toBe('context/f.md');
  });

  it('drops a trailing slash', () => {
    expect(normalizePosix('context/')).toBe('context');
  });

  it('returns the empty string unchanged', () => {
    expect(normalizePosix('')).toBe('');
  });

  it('passes a clean relative path through untouched', () => {
    expect(normalizePosix('context/training.md')).toBe('context/training.md');
  });
});
