import { describe, it, expect } from 'vitest';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { audit } from '../src/audit.js';
import { readWorkspace } from '../src/workspace.js';
import { DEFAULT_THRESHOLDS } from '../src/model.js';
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

  it('does NOT fire on a qualified bare-name that resolves in the same cell', () => {
    const findings = audit(
      buildWorkspace({
        'CLAUDE.md':
          '## Load/skip table\n| Task | Load | Skip |\n|--|--|--|\n| catalog | `references/kit/` (catalog + `_template.md`) | x |',
        'references/kit/_template.md': 'template',
      }),
    );
    expect(rule(findings, 'STALE_CONTENT')).toHaveLength(0);
  });

  it('does NOT fire on a bare structural-convention name (CONTEXT.md)', () => {
    const findings = audit(
      buildWorkspace({
        'CLAUDE.md':
          "## Load/skip table\n| Task | Load | Skip |\n|--|--|--|\n| handoff | the target stage's `CONTEXT.md` | x |",
      }),
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

describe('audit(): F8 DUPLICATION (whole-workspace, §4.8)', () => {
  // A ~50-word voice paragraph, comfortably over the 40-token block floor.
  const voicePara =
    'We write in a warm but concise register, favouring short declarative sentences ' +
    'over hedged qualifications, and we name a concrete source for every factual claim ' +
    'rather than gesturing vaguely at the wider literature, because a reader benefits ' +
    'from being able to verify each statement without having to guess where it came from.';

  // Two distinct ~55-word blocks, each over the floor, sharing no 5-word shingle.
  const longParaA =
    'the operator reviews every incoming digest each morning and then files the relevant ' +
    'items carefully under the correct client label long before the daily standup begins ' +
    'so that nothing important ever slips through the cracks and the weekly status report ' +
    'stays accurate complete current and genuinely useful to the whole distributed delivery ' +
    'team across every region';
  const longParaB =
    'annual budget forecasts for the upcoming fiscal year depend heavily on procurement ' +
    'timelines vendor negotiations contract renewals and seasonal customer demand which the ' +
    'finance group models separately using historical baselines while the marketing ' +
    'organisation independently prepares its own campaigns targeting newer audiences within ' +
    'several emerging coastal markets through partnerships sponsorships and paid experiments';

  it('fires on both sides of two routed files sharing a block, naming the other', () => {
    const findings = audit(
      buildWorkspace({
        'CLAUDE.md': `# Root identity\n\n## Voice\n\n${voicePara}`,
        'references/voice.md': `# Voice\n\n${voicePara}`,
      }),
    );
    const onClaude = at(findings, 'DUPLICATION', 'CLAUDE.md');
    const onVoice = at(findings, 'DUPLICATION', 'references/voice.md');
    expect(onClaude?.message).toContain('references/voice.md');
    expect(onClaude?.message).toMatch(/\(F8 DUPLICATION\)\.$/);
    expect(onVoice?.message).toContain('CLAUDE.md');
  });

  it('fires on a near-duplicate (a few words changed, still over the floor)', () => {
    const scopeBase =
      'Scope on this engagement is fixed at the start and never renegotiated midstream ' +
      'without a formal written change request signed by both the client and the delivery lead. ' +
      'Every deliverable listed in the statement of work has an explicit acceptance test, and ' +
      'anything that falls outside that list is logged as a future opportunity rather than ' +
      'absorbed silently into the current sprint. The team protects its focus by routing all ' +
      'new ideas through the backlog, where they are prioritised against the agreed goals at ' +
      'the next planning review instead of derailing the present commitment to the customer.';
    const scopeVariant = scopeBase.replace('the delivery lead', 'our principal sponsor');
    const findings = audit(
      buildWorkspace({
        'CLAUDE.md': '# Root identity',
        'references/scope-discipline.md': `# Scope discipline\n\n${scopeBase}`,
        'references/engagement-scope.md': `# Engagement scope\n\n${scopeVariant}`,
      }),
    );
    expect(paths(findings, 'DUPLICATION')).toEqual([
      'references/engagement-scope.md',
      'references/scope-discipline.md',
    ]);
  });

  it('is silent on a shared heading, link line, and below-floor paraphrase', () => {
    // Both blocks clear the token floor, so the silence is the Jaccard floor at
    // work (distinct prose), not a too-short block being skipped.
    const findings = audit(
      buildWorkspace({
        'CLAUDE.md': '# Root identity',
        'references/a.md': `## Notes\n\n[ref](http://example.com)\n\n${longParaA}`,
        'references/b.md': `## Notes\n\n[ref](http://example.com)\n\n${longParaB}`,
      }),
    );
    expect(rule(findings, 'DUPLICATION')).toHaveLength(0);
  });

  it('is silent when one side is an excluded home (.memory/ identical copy)', () => {
    const findings = audit(
      buildWorkspace({
        'CLAUDE.md': `# Root identity\n\n## Voice\n\n${voicePara}`,
        '.memory/user-x.md': `# Notes\n\n${voicePara}`,
      }),
    );
    expect(rule(findings, 'DUPLICATION')).toHaveLength(0);
  });

  it('wires the similarity floor: a below-floor pair fires once it is lowered', () => {
    const sharedPrefix =
      'the operator reviews every incoming digest each morning and files the relevant ' +
      'items under the correct client label before the standup so that nothing slips';
    const ws = buildWorkspace({
      'CLAUDE.md': '# Root identity',
      'references/a.md':
        `# A\n\n${sharedPrefix} through the cracks and the weekly report stays accurate ` +
        'complete and genuinely useful to the whole distributed team this quarter',
      'references/b.md':
        `# B\n\n${sharedPrefix} downstream when budget forecasts vendor negotiations and ` +
        'seasonal procurement timelines drift past their original published baselines',
    });
    expect(rule(audit(ws), 'DUPLICATION')).toHaveLength(0);
    const lowered = audit(ws, {
      thresholds: { ...DEFAULT_THRESHOLDS, duplicationSimilarityFloor: 0.1 },
    });
    expect(rule(lowered, 'DUPLICATION').length).toBeGreaterThan(0);
  });

  it('keeps two findings at one path deterministic (the determinism mustFix)', () => {
    // references/c.md duplicates a different block of each of a.md and b.md, so
    // it carries two F8 findings at one path/rule: they must order by message.
    const findings = audit(
      buildWorkspace({
        'CLAUDE.md': '# Root identity',
        'references/a.md': `# A\n\n${longParaA}`,
        'references/b.md': `# B\n\n${longParaB}`,
        'references/c.md': `# C\n\n## one\n\n${longParaA}\n\n## two\n\n${longParaB}`,
      }),
    );
    const onC = rule(findings, 'DUPLICATION').filter((f) => f.path === 'references/c.md');
    expect(onC).toHaveLength(2);
    expect(onC.map((f) => f.message)).toEqual([
      expect.stringContaining('references/a.md'),
      expect.stringContaining('references/b.md'),
    ]);
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

  it('the harness routing homes (#13) produce no findings', () => {
    const routed = [
      '.memory/some-note.md',
      '.claude/skills/example/SKILL.md',
      '02-build/CONTEXT.md',
      '02-build/spec.md',
      '02-build/specs/deep.md',
    ];
    expect(findings.some((f) => routed.includes(f.path))).toBe(false);
  });

  it('the undotted memory/skills orphans still flag (exact-path precision)', () => {
    expect(at(findings, 'HIDDEN_CONTEXT', 'memory/note-1.md')).toBeDefined();
    expect(at(findings, 'HIDDEN_CONTEXT', 'skills/cleanup.md')).toBeDefined();
  });

  it('does not size-flag a large binary file (#14)', () => {
    expect(findings.some((f) => f.path === 'report.pdf')).toBe(false);
  });

  it('does not audit the skipped archives/ directory (#14)', () => {
    expect(findings.some((f) => f.path.startsWith('archives/'))).toBe(false);
  });

  it('produces exactly the expected findings', () => {
    expect(findings).toHaveLength(12);
  });
});
