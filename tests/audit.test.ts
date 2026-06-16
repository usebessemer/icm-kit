import { describe, it, expect } from 'vitest';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { audit } from '../src/audit.js';
import { readWorkspace } from '../src/workspace.js';
import type { Finding } from '../src/model.js';
import { buildWorkspace } from './helpers/fixtures.js';

/**
 * Audit-runner tests. The `clean` fixture run is the no-false-positives guard;
 * the `aios-mirror` run is the honest real-shapes reproduction (#11). In-memory
 * cases pin each rule, including the false positives the #11 review surfaced.
 */

const here = dirname(fileURLToPath(import.meta.url));
const cleanRoot = join(here, 'fixtures', 'clean');
const aiosRoot = join(here, 'fixtures', 'aios-mirror');

function rule(findings: Finding[], code: string): Finding[] {
  return findings.filter((f) => f.rule === code);
}

function at(findings: Finding[], code: string, path: string): Finding | undefined {
  return findings.find((f) => f.rule === code && f.path === path);
}

function paths(findings: Finding[], code: string): string[] {
  return rule(findings, code)
    .map((f) => f.path)
    .sort();
}

describe('audit(): no false positives on the clean fixture', () => {
  const findings = audit(readWorkspace(cleanRoot));

  it('flags only the two intentionally unrouted files, as HIDDEN_CONTEXT', () => {
    expect(findings.map((f) => ({ rule: f.rule, path: f.path }))).toEqual([
      { rule: 'HIDDEN_CONTEXT', path: 'loose/extra.md' },
      { rule: 'HIDDEN_CONTEXT', path: 'orphan.md' },
    ]);
  });
});

describe('audit(): well-formedness rules', () => {
  it('W1 fires when no CLAUDE.md is at the root', () => {
    const findings = audit(buildWorkspace({ 'context/x.md': 'fact' }));
    expect(rule(findings, 'ROOT_IDENTITY')).toHaveLength(1);
  });

  it('W2 fires on competing case-variant root identity files', () => {
    // Note: unreachable via readWorkspace on a case-insensitive FS; this pins
    // the intended behaviour via the in-memory builder.
    const findings = audit(
      buildWorkspace({ 'CLAUDE.md': '# id', 'claude.md': '# dup' }),
    );
    expect(rule(findings, 'SINGLE_ROOT_IDENTITY')).toHaveLength(1);
  });

  it('W6 / F4 fires past the depth-3 cap', () => {
    const findings = audit(
      buildWorkspace({
        'CLAUDE.md': '# r',
        'a/CLAUDE.md': '# a',
        'a/b/CLAUDE.md': '# b',
        'a/b/c/CLAUDE.md': '# c',
        'a/b/c/deep.md': 'x',
      }),
    );
    expect(at(findings, 'OVER_ROUTING', 'a/b/c/deep.md')?.relatedRule).toBe(
      'ROUTING_DEPTH',
    );
  });

  it('W7 / F6 fires on a stage contract missing a section', () => {
    const findings = audit(
      buildWorkspace({
        'CLAUDE.md': '# r',
        '01-x/CONTEXT.md': '## Input\nx\n## Process\ny\n## Output\nz',
      }),
    );
    const f6 = at(findings, 'MALFORMED_STAGE_CONTRACT', '01-x/CONTEXT.md');
    expect(f6?.relatedRule).toBe('STAGE_CONTRACT_SHAPE');
    expect(f6?.message).toContain('Completion');
  });
});

describe('audit(): F1 MONOLITHIC_CONTEXT', () => {
  it('hard signal fires on an oversized CLAUDE.md', () => {
    const findings = audit(buildWorkspace({ 'CLAUDE.md': 'word '.repeat(4500) }));
    expect(at(findings, 'MONOLITHIC_CONTEXT', 'CLAUDE.md')).toBeDefined();
  });

  it('hard signal fires on an oversized non-CLAUDE file', () => {
    const findings = audit(
      buildWorkspace({
        'CLAUDE.md': '# r',
        'references/big.md': 'word '.repeat(8500),
      }),
    );
    expect(at(findings, 'MONOLITHIC_CONTEXT', 'references/big.md')).toBeDefined();
  });

  it('soft signal / W3 fires on a dense behaviour block in a context file', () => {
    const findings = audit(
      buildWorkspace({
        'CLAUDE.md': '# r',
        'context/mixed.md':
          '# Facts\nThe user lives in Berlin.\n\n## Behaviour\nAlways respond tersely. Never use em dashes. You must cite sources. Do not hedge.',
      }),
    );
    expect(at(findings, 'MONOLITHIC_CONTEXT', 'context/mixed.md')?.relatedRule).toBe(
      'CONTENT_SEGREGATION',
    );
  });

  it('soft signal does NOT fire on situational prose that narrates behaviour', () => {
    const findings = audit(
      buildWorkspace({
        'CLAUDE.md': '# r',
        'context/client.md':
          '# Client\nThe client always pays cash and never disputes invoices.',
      }),
    );
    expect(rule(findings, 'MONOLITHIC_CONTEXT')).toHaveLength(0);
  });
});

describe('audit(): F3 STALE_CONTENT (scoped to the load/skip table)', () => {
  it('fires on a load/skip pointer to a missing file', () => {
    const findings = audit(
      buildWorkspace({
        'CLAUDE.md':
          '## Load/skip table\n| Task | Load | Skip |\n|--|--|--|\n| t | references/gone.md | x |',
        'references/here.md': 'present',
      }),
    );
    expect(at(findings, 'STALE_CONTENT', 'CLAUDE.md')?.message).toContain(
      'references/gone.md',
    );
  });

  it('does NOT fire on a Markdown path mentioned only in prose', () => {
    const findings = audit(
      buildWorkspace({ 'CLAUDE.md': '# r\nHistoric notes lived in `old-notes.md`.' }),
    );
    expect(rule(findings, 'STALE_CONTENT')).toHaveLength(0);
  });
});

describe('audit(): F5 LAYER_BLOAT (size + heading, not marker density)', () => {
  it('fires on a directive-dense ops manual section (the inversion fix)', () => {
    const findings = audit(
      buildWorkspace({
        'CLAUDE.md':
          '# Identity\nWe are terse.\n\n## iMessage operations\n' +
          'You must open it and never skip and always file it. '.repeat(50),
      }),
    );
    expect(at(findings, 'LAYER_BLOAT', 'CLAUDE.md')?.message).toContain(
      'iMessage operations',
    );
  });

  it('does NOT fire on a large recognisably-identity section', () => {
    const findings = audit(
      buildWorkspace({
        'CLAUDE.md': '## Voice and conventions\n' + 'word '.repeat(700),
      }),
    );
    expect(rule(findings, 'LAYER_BLOAT')).toHaveLength(0);
  });

  it('does NOT fire on the permitted load/skip table', () => {
    const findings = audit(
      buildWorkspace({
        'CLAUDE.md':
          '## Load/skip table\n| Task | Load | Skip |\n|--|--|--|\n' +
          '| task | references/voice.md | context/ |\n'.repeat(200),
        'references/voice.md': 'v',
      }),
    );
    expect(rule(findings, 'LAYER_BLOAT')).toHaveLength(0);
  });

  it('variant A fires when the root routes a task at a child-workspace file', () => {
    const findings = audit(
      buildWorkspace({
        'CLAUDE.md':
          '## Load/skip table\n| Task | Load | Skip |\n|--|--|--|\n| t | child/references/guide.md | x |',
        'child/CLAUDE.md': '# child',
        'child/references/guide.md': 'guide',
      }),
    );
    expect(at(findings, 'LAYER_BLOAT', 'CLAUDE.md')).toBeDefined();
  });
});

describe('audit(): work-folder declaration', () => {
  it('a folder named only in the Skip column is not a work folder (file is hidden)', () => {
    const findings = audit(
      buildWorkspace({
        'CLAUDE.md': '| Task | Load | Skip |\n|--|--|--|\n| a | references/ | drafts/ |',
        'drafts/x.md': 'work',
      }),
    );
    expect(at(findings, 'HIDDEN_CONTEXT', 'drafts/x.md')).toBeDefined();
  });

  it('a folder declared in prose is a work folder (file routes, no finding)', () => {
    const findings = audit(
      buildWorkspace({
        'CLAUDE.md': 'Work products live under `drafts/`.',
        'drafts/x.md': 'work',
      }),
    );
    expect(at(findings, 'HIDDEN_CONTEXT', 'drafts/x.md')).toBeUndefined();
  });
});

describe('audit(): honest reproduction of the AIOS shapes (#11)', () => {
  const findings = audit(readWorkspace(aiosRoot));

  it('F5: the three directive-dense ops manuals in the root identity', () => {
    expect(rule(findings, 'LAYER_BLOAT')).toHaveLength(3);
    expect(rule(findings, 'LAYER_BLOAT').every((f) => f.path === 'CLAUDE.md')).toBe(
      true,
    );
  });

  it('F2 / W5: every unrouted file', () => {
    expect(paths(findings, 'HIDDEN_CONTEXT')).toEqual([
      'content-plan.md',
      'digest-sources.md',
      'memory/note-1.md',
      'memory/note-2.md',
      'priorities-old.md',
      'skills/cleanup.md',
    ]);
  });

  it('F3: the two dangling load/skip pointers, not the prose path', () => {
    const messages = rule(findings, 'STALE_CONTENT')
      .map((f) => f.message)
      .join('\n');
    expect(rule(findings, 'STALE_CONTENT')).toHaveLength(2);
    expect(messages).toContain('references/model-routing.md');
    expect(messages).toContain('context/archived-plan.md');
    expect(messages).not.toContain('old-notes.md');
  });

  it('F1 / W3: only the mixed context file; no size findings (honest under-report)', () => {
    expect(paths(findings, 'MONOLITHIC_CONTEXT')).toEqual(['context/digest.md']);
    expect(at(findings, 'MONOLITHIC_CONTEXT', 'context/digest.md')?.relatedRule).toBe(
      'CONTENT_SEGREGATION',
    );
  });

  it('no false positives on the situational/voice guard files', () => {
    expect(findings.some((f) => f.path === 'context/profile.md')).toBe(false);
    expect(findings.some((f) => f.path === 'references/voice.md')).toBe(false);
  });

  it('produces exactly the expected findings', () => {
    expect(findings).toHaveLength(12);
  });
});
