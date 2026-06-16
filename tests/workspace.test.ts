import { describe, it, expect } from 'vitest';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readWorkspace } from '../src/workspace.js';

/**
 * The workspace reader walks a directory into the shape the audit runner
 * consumes: a POSIX-relative file tree, each file's text and byte size, and the
 * CLAUDE.md lineage. Tested against the committed `clean` fixture (#3).
 */

const here = dirname(fileURLToPath(import.meta.url));
const cleanRoot = join(here, 'fixtures', 'clean');

describe('readWorkspace()', () => {
  const ws = readWorkspace(cleanRoot);

  it('lists every file as a POSIX-relative path', () => {
    expect(ws.tree).toContain('CLAUDE.md');
    expect(ws.tree).toContain('context/nested/state.md');
    expect(ws.tree).toContain('subws/CLAUDE.md');
    expect(ws.tree).toContain('notes.txt');
  });

  it('captures both CLAUDE.md files in the lineage with their text', () => {
    expect([...ws.claudeMd.keys()].sort()).toEqual([
      'CLAUDE.md',
      'subws/CLAUDE.md',
    ]);
    expect(ws.claudeMd.get('CLAUDE.md')).toContain('Load/skip table');
  });

  it('records text and a positive byte size for each file', () => {
    const root = ws.files.find((f) => f.path === 'CLAUDE.md');
    expect(root?.content).toContain('Clean sample workspace');
    expect(root?.bytes).toBeGreaterThan(0);
  });

  it('sorts the tree deterministically', () => {
    expect([...ws.tree]).toEqual([...ws.tree].sort());
  });
});
