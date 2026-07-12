import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readWorkspace, type Workspace } from '../src/workspace.js';
import { proseBlocks } from '../src/parse.js';
import { generateGoldenWorkspace } from './helpers/fixtures.js';

/**
 * The workspace reader walks a directory into the shape the audit runner
 * consumes: a POSIX-relative file tree, each file's text and byte size, and the
 * CLAUDE.md lineage. Tested against init's golden output (SPEC §7): the reader
 * and the generator are inverses, so reading what init writes is the honest
 * reader fixture. The tree is generated off-repo (one source of truth,
 * src/templates/), so no committed reader fixture can drift from it.
 */

const here = dirname(fileURLToPath(import.meta.url));

describe('readWorkspace()', () => {
  let ws: Workspace;
  let cleanup: () => void;
  beforeAll(() => {
    const golden = generateGoldenWorkspace();
    cleanup = golden.cleanup;
    ws = readWorkspace(golden.root);
  });
  afterAll(() => cleanup());

  it('lists every file as a POSIX-relative path (nested paths included)', () => {
    expect(ws.tree).toContain('CLAUDE.md');
    expect(ws.tree).toContain('channels/inbox.md');
    expect(ws.tree).toContain('identity/decision-boundary.md');
    expect(ws.tree).toContain('references/voice.md');
    // archives/ is walk-ignored (§7.2), so its file never enters the tree.
    expect(ws.tree).not.toContain('archives/README.md');
  });

  it('captures the sole root CLAUDE.md in the lineage with its text', () => {
    // init's role-less default has exactly one CLAUDE.md (the root identity):
    // no nested workspace ships until `--role` adds one (§7.6).
    expect([...ws.claudeMd.keys()].sort()).toEqual(['CLAUDE.md']);
    expect(ws.claudeMd.get('CLAUDE.md')).toContain('Role-routing table');
  });

  it('records text and a positive byte size for each file', () => {
    const root = ws.files.find((f) => f.path === 'CLAUDE.md');
    expect(root?.content).toContain('Thin root, everything routed');
    expect(root?.bytes).toBeGreaterThan(0);
  });

  it('sorts the tree deterministically', () => {
    expect([...ws.tree]).toEqual([...ws.tree].sort());
  });

  it('marks a Markdown file as text', () => {
    // init's golden tree ships no .txt, so isText is exercised against a routed
    // Markdown file, which is always UTF-8 text.
    expect(ws.files.find((f) => f.path === 'references/voice.md')?.isText).toBe(true);
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
