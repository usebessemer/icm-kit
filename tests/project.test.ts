import { describe, it, expect } from 'vitest';
import { classifyProjection } from '../src/project.js';
import {
  PROJECTION_HOME_RULE,
  type ProjectionClassification,
  type ProjectionHome,
  type ProjectionRule,
} from '../src/model.js';
import { buildWorkspace } from './helpers/fixtures.js';

/**
 * Tests for the SPEC §8.2 projection classifier. They walk every row of the
 * first-match-wins rule table against one synthetic tree, plus the fail-closed
 * unclassified path and the `references/voice.md`-vs-other-`references/` split.
 * No redaction here: `shape_only`/`redact_instance` produce nothing yet, they
 * are only classifications (subtask 2 builds the transforms).
 */

// One tree covering every §8.2 rule row. buildWorkspace registers the two
// CLAUDE.md files as the lineage; the rest classify by path.
const ws = buildWorkspace({
  'CLAUDE.md': '# Root',
  'workspaces/writer/CLAUDE.md': '# Writer role',
  '.claude/skills/summarize/SKILL.md': '# Summarize skill',
  '.claude/hooks/pre-commit.js': '// hook',
  '.claude/settings.json': '{}',
  'CONVENTIONS.md': 'conventions',
  'EXPANSIONS.md': 'expansions',
  'connections.md': 'connections',
  'README.md': 'readme',
  'settings.json': '{}',
  'settings.local.json': '{}',
  'sync/protocol.md': 'sync protocol',
  '.env': 'SECRET=1',
  '.env.local': 'SECRET=2',
  'secrets/key.pem': 'private key',
  'config/api-token.txt': 'a token',
  'config/db-credential.json': 'a credential',
  'archives/old-notes.md': 'retired',
  '.memory/note.md': 'a memory',
  'context/state.md': 'active state',
  'context/nested/deep.md': 'nested state',
  'references/voice.md': 'voice register',
  'references/architecture.md': 'the ICM primer',
  'references/deep/guide.md': 'nested reference',
  'board/STATE.md': 'the board',
  'registry.md': 'a registry',
  'decisions/log.md': 'decision log',
  'channels/general.md': 'a channel',
  'notes.txt': 'a stray non-md file',
  'random/data.md': 'a stray md file in no home',
});

function proj(path: string): ProjectionClassification {
  return classifyProjection(path, ws.tree, ws.claudeMd);
}

/** Assert `path` lands in `home`, with the rule the model binds to that home. */
function expectHome(path: string, home: ProjectionHome): void {
  const rule: ProjectionRule = PROJECTION_HOME_RULE[home];
  expect(proj(path)).toEqual({ path, home, rule, unclassified: false });
}

describe('classifyProjection(): SPEC §8.2 rule table (first match wins)', () => {
  it('row 1: any CLAUDE.md is router / pass_through (root and nested)', () => {
    expectHome('CLAUDE.md', 'router');
    expectHome('workspaces/writer/CLAUDE.md', 'router');
  });

  it('row 2: .claude/skills/<slug>/SKILL.md is skill / pass_through', () => {
    expectHome('.claude/skills/summarize/SKILL.md', 'skill');
  });

  it('row 3: other .claude/** files are harness / pass_through', () => {
    expectHome('.claude/hooks/pre-commit.js', 'harness');
    // settings.json under .claude/ is caught by the .claude/** row, still harness.
    expectHome('.claude/settings.json', 'harness');
  });

  it('row 4: root companions by basename are companion / pass_through', () => {
    expectHome('CONVENTIONS.md', 'companion');
    expectHome('EXPANSIONS.md', 'companion');
    expectHome('connections.md', 'companion');
    expectHome('README.md', 'companion');
  });

  it('row 5: settings.json / settings.local.json are harness / pass_through', () => {
    expectHome('settings.json', 'harness');
    expectHome('settings.local.json', 'harness');
  });

  it('row 6: sync/** is sync / pass_through', () => {
    expectHome('sync/protocol.md', 'sync');
  });

  it('row 7: secrets-shaped paths are secret / omit_assert_absence', () => {
    expectHome('.env', 'secret');
    expectHome('.env.local', 'secret');
    expectHome('secrets/key.pem', 'secret');
    expectHome('config/api-token.txt', 'secret');
    expectHome('config/db-credential.json', 'secret');
  });

  it('row 8: archives/** is archive / omit', () => {
    expectHome('archives/old-notes.md', 'archive');
  });

  it('row 9: .memory/**/*.md is memory / shape_only', () => {
    expectHome('.memory/note.md', 'memory');
  });

  it('row 10: context/**/*.md is context / shape_only, at any depth', () => {
    expectHome('context/state.md', 'context');
    expectHome('context/nested/deep.md', 'context');
  });

  it('row 11: references/voice.md is voice / shape_only', () => {
    expectHome('references/voice.md', 'voice');
  });

  it('row 12: other references/**/*.md is reference / pass_through', () => {
    expectHome('references/architecture.md', 'reference');
    expectHome('references/deep/guide.md', 'reference');
  });

  it('row 13: board/**, registry.md, decisions/**, channels/** are instance_record / redact_instance', () => {
    expectHome('board/STATE.md', 'instance_record');
    expectHome('registry.md', 'instance_record');
    expectHome('decisions/log.md', 'instance_record');
    expectHome('channels/general.md', 'instance_record');
  });
});

describe('classifyProjection(): the references/voice.md split (sanitize-only)', () => {
  it('splits voice.md (shape_only) from every other references/ file (pass_through)', () => {
    // classify() calls both `reference`; the projection distinguishes them.
    expect(proj('references/voice.md')).toMatchObject({
      home: 'voice',
      rule: 'shape_only',
    });
    expect(proj('references/architecture.md')).toMatchObject({
      home: 'reference',
      rule: 'pass_through',
    });
  });
});

describe('classifyProjection(): fail-closed (SPEC §8.2 final row)', () => {
  it('returns unclassified for a file matching no rule, never a silent home', () => {
    expect(proj('notes.txt')).toEqual({
      path: 'notes.txt',
      home: null,
      rule: null,
      unclassified: true,
    });
    expect(proj('random/data.md')).toEqual({
      path: 'random/data.md',
      home: null,
      rule: null,
      unclassified: true,
    });
  });

  it('never emits a home whose rule disagrees with the model map', () => {
    for (const path of ws.tree) {
      const result = proj(path);
      if (result.home !== null) {
        expect(result.rule).toBe(PROJECTION_HOME_RULE[result.home]);
        expect(result.unclassified).toBe(false);
      } else {
        expect(result.rule).toBeNull();
        expect(result.unclassified).toBe(true);
      }
    }
  });
});
