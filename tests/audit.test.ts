import { describe, it, expect } from 'vitest';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { audit } from '../src/audit.js';
import { readWorkspace } from '../src/workspace.js';
import type { Finding } from '../src/model.js';
import { buildWorkspace } from './helpers/fixtures.js';

/**
 * Audit-runner tests. The `clean` fixture run is the no-false-positives guard:
 * a realistic well-formed workspace must stay quiet except for the two files
 * deliberately left unrouted. The in-memory cases pin each individual rule.
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

  it('ties HIDDEN_CONTEXT back to W5', () => {
    expect(at(findings, 'HIDDEN_CONTEXT', 'orphan.md')?.relatedRule).toBe(
      'ROUTABLE_FILES',
    );
  });
});

describe('audit(): well-formedness rules', () => {
  it('W1 fires when no CLAUDE.md is at the root', () => {
    const findings = audit(buildWorkspace({ 'context/x.md': 'fact' }));
    expect(rule(findings, 'ROOT_IDENTITY')).toHaveLength(1);
  });

  it('W2 fires on competing case-variant root identity files', () => {
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
    const f4 = at(findings, 'OVER_ROUTING', 'a/b/c/deep.md');
    expect(f4?.relatedRule).toBe('ROUTING_DEPTH');
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

describe('audit(): failure modes', () => {
  it('F1 hard signal fires on an oversized CLAUDE.md', () => {
    const findings = audit(
      buildWorkspace({ 'CLAUDE.md': 'x'.repeat(16004) }),
    );
    expect(rule(findings, 'MONOLITHIC_CONTEXT').some((f) => f.path === 'CLAUDE.md')).toBe(
      true,
    );
  });

  it('F1 hard signal fires on an oversized non-CLAUDE file', () => {
    const findings = audit(
      buildWorkspace({
        'CLAUDE.md': '# r',
        'references/big.md': 'x'.repeat(32004),
      }),
    );
    expect(at(findings, 'MONOLITHIC_CONTEXT', 'references/big.md')).toBeDefined();
  });

  it('F1 soft signal / W3 fires on a context file with a behaviour block', () => {
    const findings = audit(
      buildWorkspace({
        'CLAUDE.md': '# r',
        'context/mixed.md':
          '# Facts\nThe user lives in Berlin.\n\n# Behaviour\nAlways respond tersely. Never use em dashes. You must cite sources. Do not hedge.',
      }),
    );
    const f1 = at(findings, 'MONOLITHIC_CONTEXT', 'context/mixed.md');
    expect(f1?.relatedRule).toBe('CONTENT_SEGREGATION');
  });

  it('F3 fires on a CLAUDE.md pointer to a missing file', () => {
    const findings = audit(
      buildWorkspace({
        'CLAUDE.md': '# r\nSee references/gone.md for details.',
        'references/here.md': 'present',
      }),
    );
    const f3 = at(findings, 'STALE_CONTENT', 'CLAUDE.md');
    expect(f3?.message).toContain('references/gone.md');
  });

  it('F5 variant A fires when the root routes a task at a child-workspace file', () => {
    const findings = audit(
      buildWorkspace({
        'CLAUDE.md': '# r\nThe triage task loads child/references/guide.md.',
        'child/CLAUDE.md': '# child',
        'child/references/guide.md': 'guide',
      }),
    );
    expect(rule(findings, 'LAYER_BLOAT').some((f) => f.path === 'CLAUDE.md')).toBe(
      true,
    );
  });

  it('F5 variant B fires on a large non-identity block in a CLAUDE.md', () => {
    const findings = audit(
      buildWorkspace({
        'CLAUDE.md':
          '# Identity\nWe are terse.\n\n## iMessage workflow\n' +
          'Step instructions and contact facts. '.repeat(120),
      }),
    );
    const f5 = at(findings, 'LAYER_BLOAT', 'CLAUDE.md');
    expect(f5?.message).toContain('iMessage workflow');
  });
});

describe('audit(): reproduces the AIOS acceptance fixture (#2)', () => {
  const findings = audit(readWorkspace(aiosRoot));

  it('F1 MONOLITHIC_CONTEXT: the oversized root, sync, and client files plus the mixed context file', () => {
    expect(paths(findings, 'MONOLITHIC_CONTEXT')).toEqual([
      'CLAUDE.md',
      'clients/acme/brief.md',
      'context/digest.md',
      'references/sync.md',
    ]);
    // The mixed-content one is the soft signal, tied to W3; the others are size.
    expect(at(findings, 'MONOLITHIC_CONTEXT', 'context/digest.md')?.relatedRule).toBe(
      'CONTENT_SEGREGATION',
    );
    expect(at(findings, 'MONOLITHIC_CONTEXT', 'references/sync.md')?.relatedRule).toBeUndefined();
  });

  it('F5 LAYER_BLOAT: the three ops manuals embedded in the root identity', () => {
    expect(rule(findings, 'LAYER_BLOAT')).toHaveLength(3);
    expect(rule(findings, 'LAYER_BLOAT').every((f) => f.path === 'CLAUDE.md')).toBe(true);
  });

  it('F2 HIDDEN_CONTEXT / W5: every file no router points to', () => {
    expect(paths(findings, 'HIDDEN_CONTEXT')).toEqual([
      'content-plan.md',
      'digest-sources.md',
      'memory/note-1.md',
      'memory/note-2.md',
      'priorities-old.md',
      'skills/cleanup.md',
    ]);
    expect(
      rule(findings, 'HIDDEN_CONTEXT').every((f) => f.relatedRule === 'ROUTABLE_FILES'),
    ).toBe(true);
  });

  it('F3 STALE_CONTENT: the two dangling router pointers', () => {
    const stale = rule(findings, 'STALE_CONTENT');
    expect(stale).toHaveLength(2);
    const messages = stale.map((f) => f.message).join('\n');
    expect(messages).toContain('references/model-routing.md');
    expect(messages).toContain('context/archived-plan.md');
  });

  it('produces exactly the expected findings, nothing spurious', () => {
    expect(findings).toHaveLength(15);
  });
});
