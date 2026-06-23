import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readWorkspace } from '../src/workspace.js';
import { proseBlocks } from '../src/parse.js';

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

  it('marks a UTF-8 file as text regardless of extension', () => {
    expect(ws.files.find((f) => f.path === 'notes.txt')?.isText).toBe(true);
  });
});

const aiosRoot = join(here, 'fixtures', 'aios-mirror');

describe('readWorkspace(): binary sniff and ignore (#14)', () => {
  const ws = readWorkspace(aiosRoot);

  it('flags a binary file (NUL in head) as not text, with empty content', () => {
    const pdf = ws.files.find((f) => f.path === 'report.pdf');
    expect(pdf?.isText).toBe(false);
    expect(pdf?.content).toBe('');
    expect(pdf?.bytes).toBeGreaterThan(0);
  });

  it('skips the archives/ directory by default', () => {
    expect(ws.tree.some((p) => p.startsWith('archives/'))).toBe(false);
  });

  it('merges a caller ignore set with the defaults (name-based)', () => {
    const pruned = readWorkspace(aiosRoot, { ignore: ['memory'] });
    expect(pruned.tree.some((p) => p.startsWith('memory/'))).toBe(false);
    // `.memory` is a different name and is not ignored.
    expect(pruned.tree.some((p) => p.startsWith('.memory/'))).toBe(true);
  });
});

describe('readWorkspace(): CRLF normalization (folded F8-review residual)', () => {
  // A committed CRLF fixture is fragile (git autocrlf may rewrite it), so write
  // one at runtime and read it through the production path.
  it('normalizes CRLF to LF, so a # inside a CRLF fence is still stripped', () => {
    const dir = mkdtempSync(join(tmpdir(), 'icm-crlf-'));
    try {
      writeFileSync(join(dir, 'CLAUDE.md'), '# Root\n');
      mkdirSync(join(dir, 'references'));
      const crlf = [
        '# Title',
        'real prose alpha here.',
        '```sh',
        '# not a heading, just a shell comment',
        'leaked fenced code line',
        '```',
        'real prose beta here.',
      ].join('\r\n');
      writeFileSync(join(dir, 'references', 'doc.md'), crlf);

      const ws = readWorkspace(dir);
      const doc = ws.files.find((f) => f.path === 'references/doc.md');
      // Load-bearing assertions first: without normalization the trailing \r
      // defeats the fence regex, the fence is not stripped, and the code leaks
      // into the prose blocks. (The \r check below would short-circuit the test
      // before these run, so it goes last.)
      const words = proseBlocks(doc?.content ?? '').flat();
      expect(words).not.toContain('leaked');
      expect(words).not.toContain('code');
      expect(words).toEqual([
        'real',
        'prose',
        'alpha',
        'here',
        'real',
        'prose',
        'beta',
        'here',
      ]);
      expect(doc?.content.includes('\r')).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
