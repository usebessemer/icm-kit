import { describe, it, expect } from 'vitest';
import {
  assertGate,
  projectExtract,
  projectSupport,
  redactInstance,
  renderManifest,
  SecretLeakError,
  shapeOnly,
  splitFrontmatter,
  UnclassifiedFilesError,
} from '../src/sanitize.js';
import type { Workspace, WorkspaceFile } from '../src/workspace.js';

/**
 * Unit tests for the SPEC §8 support-mode projection engine, gate, and
 * manifest. The transforms are exercised as pure functions and end-to-end
 * through `projectSupport` on synthetic in-memory trees (so a binary, an
 * archive the disk reader would ignore, and a deliberate secret leak can all be
 * constructed precisely). The CLI e2e over the committed fixtures lives in
 * `cli.test.ts`.
 */

/**
 * Build a Workspace from a `path -> content` list, honouring an explicit
 * `isText: false` for the binary path (matching `readWorkspace`, which stores
 * empty content for a binary). Mirrors the shape the reader produces so the
 * engine sees exactly what it would on disk.
 */
function makeWorkspace(
  entries: Array<{ path: string; content: string; isText?: boolean }>,
): Workspace {
  const files: WorkspaceFile[] = [...entries]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map(({ path, content, isText }) => ({
      path,
      content: isText === false ? '' : content,
      bytes: Buffer.byteLength(content, 'utf8'),
      isText: isText ?? true,
      tracked: false,
      postForkCommits: null,
      existedAtForkPoint: false,
    }));
  const tree = files.map((f) => f.path);
  const claudeMd = new Map<string, string>();
  for (const f of files) {
    if (f.path === 'CLAUDE.md' || f.path.endsWith('/CLAUDE.md')) {
      claudeMd.set(f.path, f.content);
    }
  }
  return { root: '/virtual', files, tree, claudeMd };
}

/** One tree touching every emitting and omitting rule of the §8.2 table. */
const TREE = makeWorkspace([
  { path: 'CLAUDE.md', content: '# Root\n\nThin router.\n' },
  { path: 'CONVENTIONS.md', content: '# Conventions\n\nStructural companion.\n' },
  { path: 'settings.json', content: '{ "permissions": {} }\n' },
  { path: '.claude/skills/sum/SKILL.md', content: '# Skill\n\nPortable capability.\n' },
  { path: '.claude/hooks/h.js', content: '// harness hook\n' },
  { path: '.claude/assets/logo.png', content: 'binarybytes', isText: false },
  { path: 'sync/protocol.md', content: '# Sync\n\nStructural protocol.\n' },
  { path: 'references/architecture.md', content: '# Arch\n\nShared primer.\n' },
  {
    path: 'references/voice.md',
    content: '# Voice\n\nThe operator Devon Vale writes terse.\n\n## Register\n\nWarm, concrete.\n',
  },
  { path: 'context/state.md', content: '# State\n\nDevon Vale is mid-flight on Acme.\n' },
  {
    path: 'context/fm.md',
    content: '---\ntitle: state\nowner: Zephyr Private\n---\n\n# Heading\n\nprivate body prose.\n',
  },
  { path: '.memory/note.md', content: '# Note\n\nDevon Vale signs off as D.V.\n' },
  {
    path: 'board/state.md',
    content:
      '# Board\n\n| Item | Owner | Status |\n| --- | --- | --- |\n| Acme | Devon Vale | OPEN |\n\n## Notes\n\nDevon Vale owns it.\n',
  },
  { path: 'registry.md', content: '# Registry\n\n| Stream | Lead |\n| --- | --- |\n| kit | Devon Vale |\n' },
  { path: 'decisions/log.md', content: '# Log\n\n## 2026-01-01 · Ship it\n\nDevon Vale decided.\n' },
  { path: 'channels/general.md', content: '# general\n\n## Thread\n\nDevon Vale: hello.\n' },
  { path: 'archives/old.md', content: '# Old\n\nRetired plan.\n' },
  { path: 'secrets/creds.txt', content: 'API_KEY=sk-zzz-000\n' },
]);

const result = projectSupport(TREE);

function emitted(path: string): string | undefined {
  return result.files.find((f) => f.path === path)?.content;
}
function noteFor(path: string): string {
  return result.entries.find((e) => e.path === path)!.note;
}

describe('projectSupport(): rule dispatch (SPEC §8.2)', () => {
  it('classifies every file, gate PASS, nothing unclassified', () => {
    expect(result.gate.ok).toBe(true);
    expect(result.gate.unclassified).toEqual([]);
    expect(result.gate.leaked).toEqual([]);
    expect(result.entries).toHaveLength(TREE.files.length);
  });

  it('pass_through emits the file verbatim (router, companion, harness, sync, reference, skill)', () => {
    expect(emitted('CLAUDE.md')).toBe('# Root\n\nThin router.\n');
    expect(emitted('CONVENTIONS.md')).toBe('# Conventions\n\nStructural companion.\n');
    expect(emitted('settings.json')).toBe('{ "permissions": {} }\n');
    expect(emitted('sync/protocol.md')).toBe('# Sync\n\nStructural protocol.\n');
    expect(emitted('references/architecture.md')).toBe('# Arch\n\nShared primer.\n');
    expect(emitted('.claude/skills/sum/SKILL.md')).toBe('# Skill\n\nPortable capability.\n');
    expect(emitted('.claude/hooks/h.js')).toBe('// harness hook\n');
  });

  it('shape_only keeps heading levels, redacts heading text and body prose', () => {
    expect(emitted('.memory/note.md')).toBe(
      '# <!-- redacted heading -->\n<!-- redacted: 1 lines -->\n',
    );
    expect(emitted('references/voice.md')).toBe(
      '# <!-- redacted heading -->\n<!-- redacted: 1 lines -->\n## <!-- redacted heading -->\n<!-- redacted: 1 lines -->\n',
    );
    // Neither the body name nor the heading text survives a shaped file.
    expect(emitted('context/state.md')).not.toContain('Devon Vale');
  });

  it('shape_only redacts frontmatter values but keeps the keys as shape (review B1)', () => {
    expect(emitted('context/fm.md')).toBe(
      '---\ntitle: <!-- redacted -->\nowner: <!-- redacted -->\n---\n# <!-- redacted heading -->\n<!-- redacted: 1 lines -->\n',
    );
    // The private frontmatter value never survives.
    expect(emitted('context/fm.md')).not.toContain('Zephyr Private');
  });

  it('redact_instance keeps the table skeleton and heading levels, redacts headings, rows, and prose', () => {
    expect(emitted('board/state.md')).toBe(
      '# <!-- redacted heading -->\n| Item | Owner | Status |\n| --- | --- | --- |\n<!-- redacted: 1 rows -->\n## <!-- redacted heading -->\n<!-- redacted: 1 lines -->\n',
    );
    // Dated decision headings collapse to level-only shape; their text and bodies go.
    expect(emitted('decisions/log.md')).toBe(
      '# <!-- redacted heading -->\n## <!-- redacted heading -->\n<!-- redacted: 1 lines -->\n',
    );
    // Neither the instance name nor a heading date survives a redacted record.
    for (const p of ['board/state.md', 'registry.md', 'decisions/log.md', 'channels/general.md']) {
      expect(emitted(p)).not.toContain('Devon Vale');
    }
    expect(emitted('decisions/log.md')).not.toContain('2026-01-01');
  });

  it('omit drops archives with a manifest line (never silently)', () => {
    expect(emitted('archives/old.md')).toBeUndefined();
    expect(noteFor('archives/old.md')).toContain('omitted');
  });

  it('omit_assert_absence drops the secret and flags it as present in source', () => {
    expect(emitted('secrets/creds.txt')).toBeUndefined();
    expect(result.gate.secretsPresent).toEqual(['secrets/creds.txt']);
    expect(noteFor('secrets/creds.txt')).toContain('secret-shaped');
  });

  it('omits a binary from an emitting home with a manifest line, never a shaped empty file', () => {
    expect(emitted('.claude/assets/logo.png')).toBeUndefined();
    expect(noteFor('.claude/assets/logo.png')).toContain('binary');
  });

  it('is deterministic: a second projection produces byte-identical files', () => {
    const again = projectSupport(TREE);
    expect(again.files).toEqual(result.files);
  });
});

describe('projectSupport(): the fail-closed gate (SPEC §8)', () => {
  it('marks an unclassified file, gate FAIL, and assertGate throws (nothing written)', () => {
    const ws = makeWorkspace([
      { path: 'CLAUDE.md', content: '# Root\n' },
      { path: 'stray.txt', content: 'no home' },
    ]);
    const r = projectSupport(ws);
    expect(r.gate.ok).toBe(false);
    expect(r.gate.unclassified).toEqual(['stray.txt']);
    expect(() => assertGate(r)).toThrow(UnclassifiedFilesError);
  });

  it('detects a secret whose content leaks into an emitted file and fails closed', () => {
    const ws = makeWorkspace([
      { path: 'CLAUDE.md', content: '# Root\n' },
      { path: 'secrets/token.txt', content: 'LEAKED_SECRET_VALUE' },
      { path: 'references/pub.md', content: '# Pub\n\nLEAKED_SECRET_VALUE slipped in.\n' },
    ]);
    const r = projectSupport(ws);
    expect(r.gate.ok).toBe(false);
    expect(r.gate.leaked).toEqual(['references/pub.md']);
    expect(() => assertGate(r)).toThrow(SecretLeakError);
  });
});

describe('shapeOnly() / redactInstance() / splitFrontmatter()', () => {
  it('shapeOnly collapses a headingless note to a single marker', () => {
    expect(shapeOnly('just some private prose\nover two lines\n')).toBe(
      '<!-- redacted: 2 lines -->\n',
    );
  });

  it('redactInstance keeps a table header and delimiter, redacts the data rows', () => {
    const out = redactInstance('| A | B |\n| - | - |\n| 1 | 2 |\n| 3 | 4 |\n');
    expect(out).toBe('| A | B |\n| - | - |\n<!-- redacted: 2 rows -->\n');
  });

  it('redacts frontmatter values (incl. nested), keeps keys, parent, and fences (review B1)', () => {
    const out = shapeOnly(
      '---\nname: n\ndescription: private fact\nmetadata:\n  type: user\ntags:\n  - acme\n---\n# H\n\nbody\n',
    );
    expect(out).toBe(
      '---\nname: <!-- redacted -->\ndescription: <!-- redacted -->\nmetadata:\n  type: <!-- redacted -->\ntags:\n  - <!-- redacted -->\n---\n# <!-- redacted heading -->\n<!-- redacted: 1 lines -->\n',
    );
  });

  it('splitFrontmatter detects a terminated block and rejects an unterminated one', () => {
    expect(splitFrontmatter('---\na: 1\n---\nbody\n')).toEqual({
      frontmatter: '---\na: 1\n---',
      rest: 'body\n',
    });
    expect(splitFrontmatter('---\na: 1\nno close\n')).toEqual({
      frontmatter: null,
      rest: '---\na: 1\nno close\n',
    });
  });
});

describe('renderManifest()', () => {
  const manifest = renderManifest(result);

  it('stamps the SPEC version, the gate verdict, and per-file rules', () => {
    expect(manifest).toContain('SPEC v');
    expect(manifest).toContain('Gate: PASS');
    expect(manifest).toContain('board/state.md');
    expect(manifest).toContain('redact_instance');
  });

  it('flags the secrets-shaped file loudly and states the home-based boundary', () => {
    expect(manifest).toContain('secrets-shaped file present: secrets/creds.txt');
    expect(manifest).toContain('home-based');
    expect(manifest).toContain('independent leak-check');
  });

  it('shows the survived before/after skeleton for a redacted file', () => {
    expect(manifest).toContain('| # <!-- redacted heading -->');
    expect(manifest).toContain('lines -> ');
  });
});

/**
 * Extract mode (SPEC §8.5): the scoped capability harvest. The tree below mirrors
 * the `aios-mirror` shape (a skill under `.claude/skills/example/`, a routing
 * root `CLAUDE.md` carrying private prose + a load table, and the private homes
 * and a secret and an unclassified client doc all *out of scope*), so the
 * extraction is exercised precisely: the include set + its minimal routing
 * context, and nothing else.
 */
describe('projectExtract(): scoped capability harvest (SPEC §8.5)', () => {
  // A private name that must never survive: it sits in the routing CLAUDE.md
  // body and in every out-of-scope home, never in the skill being extracted.
  const CANARY = 'Cordelia Ashgrove';

  const WS = makeWorkspace([
    {
      path: 'CLAUDE.md',
      content: `# AIOS root\n\nWe are ${CANARY}, the operator. Voice: terse.\n\n## Load table\n\n| Task | Load |\n| --- | --- |\n| draft | references/voice.md |\n`,
    },
    {
      path: '.claude/skills/example/SKILL.md',
      content: '# Example skill\n\nA portable capability. No private instance here.\n',
    },
    { path: 'context/profile.md', content: `# Profile\n\n${CANARY} is mid-flight on Acme.\n` },
    { path: '.memory/note.md', content: `# Note\n\n${CANARY} signs off as C.A.\n` },
    { path: 'references/voice.md', content: `# Voice\n\n${CANARY} writes terse.\n` },
    { path: 'secrets/creds.txt', content: 'API_KEY=sk-secret-000\n' },
    // Unclassified in support mode; must not block or appear (it is out of scope).
    { path: 'clients/acme/brief.md', content: `# Acme brief\n\n${CANARY} owns it.\n` },
  ]);

  const result = projectExtract(WS, ['.claude/skills/example/']);
  const paths = result.files.map((f) => f.path).sort();
  const blob = result.files.map((f) => f.content).join('\n');

  it('emits only the include set + its minimal routing context, nothing else', () => {
    expect(paths).toEqual(['.claude/skills/example/SKILL.md', 'CLAUDE.md']);
    expect(result.gate.ok).toBe(true);
    // The out-of-scope homes, including the unclassified client doc and the
    // secret, neither block the run nor appear in the tree.
    for (const p of ['clients/acme/brief.md', 'secrets/creds.txt', 'context/profile.md', '.memory/note.md']) {
      expect(paths).not.toContain(p);
    }
  });

  it('passes the included skill through verbatim', () => {
    expect(result.files.find((f) => f.path === '.claude/skills/example/SKILL.md')?.content).toBe(
      '# Example skill\n\nA portable capability. No private instance here.\n',
    );
  });

  it('shape-redacts the routing CLAUDE.md (router -> shape_only, not pass_through)', () => {
    const claude = result.files.find((f) => f.path === 'CLAUDE.md')!.content;
    expect(claude).toContain('# <!-- redacted heading -->');
    // Heading text, body prose, and the load table are all gone from the router.
    expect(claude).not.toContain('Load table');
    expect(claude).not.toContain('references/voice.md');
  });

  it('leaves zero canary occurrences anywhere in the extracted tree', () => {
    expect(blob).not.toContain(CANARY);
  });

  it('is deterministic: a second projection is byte-identical', () => {
    const again = projectExtract(WS, ['.claude/skills/example/']);
    expect(again.files).toEqual(result.files);
  });

  it('records the include set and every routing file it pulled in', () => {
    expect(result.mode).toBe('extract');
    expect(result.includes).toEqual(['.claude/skills/example']);
    expect(result.routing).toEqual(['CLAUDE.md']);
    const manifest = renderManifest(result);
    expect(manifest).toContain('icm-kit sanitize --mode extract');
    expect(manifest).toContain('.claude/skills/example');
    expect(manifest).toContain('routing context pulled in');
    // The manifest carries the §8.6 required-leak-check protocol for public output.
    expect(manifest).toContain('REQUIRED');
    expect(manifest).toContain('leak-check');
    expect(manifest).toContain('2026-07-05');
  });

  it('an included secret is omitted, flagged present, and asserted absent (gate OK)', () => {
    const ws = makeWorkspace([
      { path: 'CLAUDE.md', content: '# Root\n\nprivate.\n' },
      { path: 'secrets/creds.txt', content: 'API_KEY=sk-000\n' },
    ]);
    const r = projectExtract(ws, ['secrets/']);
    expect(r.files.map((f) => f.path)).toEqual(['CLAUDE.md']); // routing only; secret omitted
    expect(r.gate.secretsPresent).toEqual(['secrets/creds.txt']);
    expect(r.gate.ok).toBe(true);
  });

  it('fails closed on an unclassified included file (assertGate throws)', () => {
    const ws = makeWorkspace([
      { path: 'CLAUDE.md', content: '# Root\n' },
      { path: 'loose/orphan.md', content: '# Orphan\n\nno home\n' },
    ]);
    const r = projectExtract(ws, ['loose/']);
    expect(r.gate.ok).toBe(false);
    expect(r.gate.unclassified).toEqual(['loose/orphan.md']);
    expect(() => assertGate(r)).toThrow(UnclassifiedFilesError);
  });
});

describe('projectExtract(): routing chain across nested workspaces (SPEC §8.5, §2.2)', () => {
  const WS = makeWorkspace([
    { path: 'CLAUDE.md', content: '# Root\n\nRoot identity, private.\n' },
    { path: 'workspaces/sub/CLAUDE.md', content: '# Sub role\n\nSub identity, private.\n' },
    { path: 'workspaces/sub/context/state.md', content: '# State\n\nprivate nested context.\n' },
    // Out of scope: a sibling context file that must not be pulled in.
    { path: 'workspaces/sub/references/api.md', content: '# API\n\nshared.\n' },
  ]);
  const result = projectExtract(WS, ['workspaces/sub/context/']);

  it('pulls in every containing-root CLAUDE.md, nearest up to the audit root, each shaped', () => {
    const paths = result.files.map((f) => f.path).sort();
    expect(paths).toEqual([
      'CLAUDE.md',
      'workspaces/sub/CLAUDE.md',
      'workspaces/sub/context/state.md',
    ]);
    expect(result.routing).toEqual(['CLAUDE.md', 'workspaces/sub/CLAUDE.md']);
    // Both routers are shaped, not passed through: their private identity is gone.
    for (const r of ['CLAUDE.md', 'workspaces/sub/CLAUDE.md']) {
      const c = result.files.find((f) => f.path === r)!.content;
      expect(c).toContain('# <!-- redacted heading -->');
      expect(c).not.toContain('identity');
    }
    // The out-of-scope sibling under the same nested workspace is not emitted.
    expect(paths).not.toContain('workspaces/sub/references/api.md');
  });
});
