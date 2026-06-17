import { describe, it, expect } from 'vitest';
import { classify } from '../src/classify.js';
import type { Classification } from '../src/model.js';
import { readFixture } from './helpers/fixtures.js';

/**
 * Tests for the SPEC §2.5 classifier. They walk every row of the default
 * classification table against the committed `clean` fixture workspace, plus
 * the load/skip override, nested L1 workspaces, and the unclassified path that
 * surfaces as Hidden context (§4.2). No rule evaluation here: that is the audit
 * runner (#4).
 */

const clean = readFixture('clean');

function classifyPath(path: string): Classification {
  return classify(path, clean.tree, clean.claudeMd);
}

/** A fully-specified expected Classification, with defaults filled in. */
function expected(
  over: Partial<Classification> & { path: string },
): Classification {
  return {
    routingLevel: null,
    contentType: null,
    loadPattern: null,
    carriesOperations: false,
    unclassified: false,
    stageContract: false,
    ...over,
  };
}

describe('classify(): SPEC §2.5 default table (first match wins)', () => {
  it('row 1: root CLAUDE.md is identity, always, L0, and carries operations', () => {
    expect(classifyPath('CLAUDE.md')).toEqual(
      expected({
        path: 'CLAUDE.md',
        routingLevel: 'L0',
        contentType: 'identity',
        loadPattern: 'always',
        carriesOperations: true,
      }),
    );
  });

  it('row 2: context/**/*.md is situational, always, at any depth', () => {
    expect(classifyPath('context/profile.md')).toEqual(
      expected({
        path: 'context/profile.md',
        routingLevel: 'L0',
        contentType: 'situational',
        loadPattern: 'always',
      }),
    );
    expect(classifyPath('context/nested/state.md')).toEqual(
      expected({
        path: 'context/nested/state.md',
        routingLevel: 'L0',
        contentType: 'situational',
        loadPattern: 'always',
      }),
    );
  });

  it('row 3: references/**/*.md is reference, on_demand, at any depth', () => {
    expect(classifyPath('references/voice.md')).toEqual(
      expected({
        path: 'references/voice.md',
        routingLevel: 'L0',
        contentType: 'reference',
        loadPattern: 'on_demand',
      }),
    );
    expect(classifyPath('references/api/http.md')).toEqual(
      expected({
        path: 'references/api/http.md',
        routingLevel: 'L0',
        contentType: 'reference',
        loadPattern: 'on_demand',
      }),
    );
  });

  it('row 4: NN-name/CONTEXT.md is a reference stage contract at L2', () => {
    expect(classifyPath('01-discovery/CONTEXT.md')).toEqual(
      expected({
        path: '01-discovery/CONTEXT.md',
        routingLevel: 'L2',
        contentType: 'reference',
        loadPattern: 'on_demand',
        stageContract: true,
      }),
    );
  });

  it('row 5: *.md under a named work folder is working, per_item', () => {
    expect(classifyPath('projects/alpha/notes.md')).toEqual(
      expected({
        path: 'projects/alpha/notes.md',
        routingLevel: 'L0',
        contentType: 'working',
        loadPattern: 'per_item',
      }),
    );
  });

  it('final row: an unrouted *.md is unclassified with null axes', () => {
    expect(classifyPath('orphan.md')).toEqual(
      expected({ path: 'orphan.md', unclassified: true }),
    );
    expect(classifyPath('loose/extra.md')).toEqual(
      expected({ path: 'loose/extra.md', unclassified: true }),
    );
  });

  it('a non-Markdown file matches no row and is unclassified', () => {
    expect(classifyPath('notes.txt')).toEqual(
      expected({ path: 'notes.txt', unclassified: true }),
    );
  });
});

describe('classify(): load/skip-table override (§2.5)', () => {
  it('a file named by the CLAUDE.md load/skip table routes as a reference', () => {
    expect(classifyPath('runbook.md')).toEqual(
      expected({
        path: 'runbook.md',
        routingLevel: 'L0',
        contentType: 'reference',
        loadPattern: 'on_demand',
      }),
    );
  });

  it('carriesOperations is set only for a CLAUDE.md with a load/skip table', () => {
    expect(classifyPath('CLAUDE.md').carriesOperations).toBe(true);
    expect(classifyPath('subws/CLAUDE.md').carriesOperations).toBe(false);
  });
});

describe('classify(): nested L1 workspaces (§2.2)', () => {
  it('a nested CLAUDE.md is identity at L1 (introduces an L1 scope)', () => {
    expect(classifyPath('subws/CLAUDE.md')).toEqual(
      expected({
        path: 'subws/CLAUDE.md',
        routingLevel: 'L1',
        contentType: 'identity',
        loadPattern: 'always',
      }),
    );
  });

  it('files inside a nested workspace classify by type but at L1', () => {
    expect(classifyPath('subws/context/team.md')).toEqual(
      expected({
        path: 'subws/context/team.md',
        routingLevel: 'L1',
        contentType: 'situational',
        loadPattern: 'always',
      }),
    );
  });
});

describe('classify(): harness routing homes (#13, §2.5)', () => {
  const tree = [
    'CLAUDE.md',
    '.memory/note.md',
    '.claude/skills/example/SKILL.md',
    '.claude/skills/stray.md',
    '02-build/CONTEXT.md',
    '02-build/spec.md',
    'memory/note.md',
    'skills/cleanup.md',
  ];
  const claudeMd = new Map([['CLAUDE.md', '# root']]);
  const c = (path: string): Classification => classify(path, tree, claudeMd);

  it('routes the .memory store as situational / always', () => {
    expect(c('.memory/note.md')).toEqual(
      expected({
        path: '.memory/note.md',
        routingLevel: 'L0',
        contentType: 'situational',
        loadPattern: 'always',
      }),
    );
  });

  it('routes a .claude/skills/<slug>/SKILL.md as reference / on_demand', () => {
    expect(c('.claude/skills/example/SKILL.md')).toEqual(
      expected({
        path: '.claude/skills/example/SKILL.md',
        routingLevel: 'L0',
        contentType: 'reference',
        loadPattern: 'on_demand',
      }),
    );
  });

  it('routes a numbered-stage working file as working / per_item / L2', () => {
    expect(c('02-build/spec.md')).toEqual(
      expected({
        path: '02-build/spec.md',
        routingLevel: 'L2',
        contentType: 'working',
        loadPattern: 'per_item',
      }),
    );
  });

  it('still classifies the stage CONTEXT.md as the contract (precedence)', () => {
    expect(c('02-build/CONTEXT.md')).toEqual(
      expected({
        path: '02-build/CONTEXT.md',
        routingLevel: 'L2',
        contentType: 'reference',
        loadPattern: 'on_demand',
        stageContract: true,
      }),
    );
  });

  it('does not mistype a stray skills file as a skill (precision)', () => {
    expect(c('.claude/skills/stray.md').unclassified).toBe(true);
  });

  it('leaves undotted memory/ and skills/ folders unclassified (exact path only)', () => {
    expect(c('memory/note.md').unclassified).toBe(true);
    expect(c('skills/cleanup.md').unclassified).toBe(true);
  });
});
