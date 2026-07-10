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

  it('does NOT fire on an oversized append-only log (accreting ledger, §4.1)', () => {
    // ~300 dated entries, comfortably over the 8000-token cap, but exempt: an
    // append-only log grows by design (tail-archive, not split).
    const entries = Array.from(
      { length: 300 },
      (_, i) => `## 2026-01-${String((i % 28) + 1).padStart(2, '0')} — entry ${i}\n` +
        'word '.repeat(30),
    ).join('\n\n');
    const findings = audit(
      buildWorkspace({
        'CLAUDE.md': '# r',
        'decisions/log.md': `# Decisions Log\n\nAppend-only record.\n\n${entries}`,
      }),
    );
    expect(rule(findings, 'MONOLITHIC_CONTEXT')).toHaveLength(0);
  });

  it('still fires on an oversized file with too few dated entries to be a log', () => {
    const findings = audit(
      buildWorkspace({
        'CLAUDE.md': '# r',
        'references/notes.md':
          '# Notes\n\n## 2026-01-01 kickoff\n\n## 2026-02-01 review\n\n' +
          'word '.repeat(8500),
      }),
    );
    expect(at(findings, 'MONOLITHIC_CONTEXT', 'references/notes.md')).toBeDefined();
  });

  it('does NOT exempt a CLAUDE.md even when it carries dated headings (L0 cap holds)', () => {
    const dated = '## 2026-01-01 a\n## 2026-02-01 b\n## 2026-03-01 c\n';
    const findings = audit(
      buildWorkspace({ 'CLAUDE.md': `# root\n${dated}` + 'word '.repeat(4500) }),
    );
    expect(at(findings, 'MONOLITHIC_CONTEXT', 'CLAUDE.md')).toBeDefined();
  });

  it('still fires on an oversized bloat file with only incidental dated headings', () => {
    // The over-exempt probe: three dated `##` scattered among prose `##` must
    // not buy a size exemption (dominance guard).
    const prose = Array.from({ length: 20 }, (_, i) => `## Section ${i}\n` + 'word '.repeat(450));
    const body = ['# Big', '## 2026-01-01 x', '## 2026-02-01 y', '## 2026-03-01 z', ...prose];
    const findings = audit(
      buildWorkspace({ 'CLAUDE.md': '# r', 'references/bloat.md': body.join('\n') }),
    );
    expect(at(findings, 'MONOLITHIC_CONTEXT', 'references/bloat.md')).toBeDefined();
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

describe('audit(): F3 resolves relative paths from a nested CLAUDE.md (#27)', () => {
  // The AIOS shape: a nested workspace's load/skip table points up to a root
  // home (`../../context/...`) and across to a sibling workspace (`../coaching/...`).
  // The resolver POSIX-normalizes each candidate against the containing
  // CLAUDE.md's directory, so a ref whose target exists must not be flagged.
  it('does NOT fire on cross-altitude and sibling refs whose targets exist', () => {
    const findings = audit(
      buildWorkspace({
        'CLAUDE.md': '# root identity',
        'context/training.md': 'protocol',
        'identity/voice.md': 'voice',
        'decisions/log.md': 'log',
        'workspaces/coaching/CLAUDE.md':
          '## Load/skip table\n| Task | Load | Skip |\n|--|--|--|\n| t | `../../context/training.md`, `../../identity/voice.md` | x |',
        'workspaces/coaching/references/sc-methodology/session-structure.md': 'sessions',
        'workspaces/consulting/CLAUDE.md':
          '## Load/skip table\n| Task | Load | Skip |\n|--|--|--|\n| t | `../../decisions/log.md` | x |',
        'workspaces/training/CLAUDE.md':
          '## Load/skip table\n| Task | Load | Skip |\n|--|--|--|\n| plan | `../../context/training.md`, `../coaching/references/sc-methodology/session-structure.md` | x |',
      }),
    );
    expect(rule(findings, 'STALE_CONTENT')).toHaveLength(0);
  });

  it('does NOT fire on a bare _template.md qualified by a relative same-cell dir', () => {
    const findings = audit(
      buildWorkspace({
        'CLAUDE.md': '# root identity',
        'workspaces/coaching/references/sc-methodology/complexes/_template.md': 'tpl',
        'workspaces/training/CLAUDE.md':
          '## Load/skip table\n| Task | Load | Skip |\n|--|--|--|\n| design | `../coaching/references/sc-methodology/complexes/` (catalog + `_template.md`) | x |',
      }),
    );
    expect(rule(findings, 'STALE_CONTENT')).toHaveLength(0);
  });

  it('normalizes a same-directory (./) ref from the root CLAUDE.md', () => {
    const findings = audit(
      buildWorkspace({
        'CLAUDE.md':
          '## Load/skip table\n| Task | Load | Skip |\n|--|--|--|\n| t | `./references/voice.md` | x |',
        'references/voice.md': 'voice',
      }),
    );
    expect(rule(findings, 'STALE_CONTENT')).toHaveLength(0);
  });

  it('still fires on a genuinely missing relative ref from a nested CLAUDE.md', () => {
    const findings = audit(
      buildWorkspace({
        'CLAUDE.md': '# root identity',
        'workspaces/coaching/CLAUDE.md':
          '## Load/skip table\n| Task | Load | Skip |\n|--|--|--|\n| t | `../../context/gone.md` | x |',
      }),
    );
    expect(
      at(findings, 'STALE_CONTENT', 'workspaces/coaching/CLAUDE.md')?.message,
    ).toContain('../../context/gone.md');
  });
});

describe('audit(): F3 dedups one stale ref to one finding (#27)', () => {
  it('emits one finding for a token repeated across N cells', () => {
    const findings = audit(
      buildWorkspace({
        'CLAUDE.md':
          '## Load/skip table\n| Task | Load | Skip |\n|--|--|--|\n| a | references/gone.md | x |\n| b | references/gone.md | y |\n| c | references/gone.md | z |',
      }),
    );
    expect(rule(findings, 'STALE_CONTENT')).toHaveLength(1);
    expect(at(findings, 'STALE_CONTENT', 'CLAUDE.md')?.message).toContain(
      'references/gone.md',
    );
  });

  it('keeps distinct missing tokens as distinct findings', () => {
    const findings = audit(
      buildWorkspace({
        'CLAUDE.md':
          '## Load/skip table\n| Task | Load | Skip |\n|--|--|--|\n| a | references/gone.md | x |\n| b | references/also-gone.md | y |',
      }),
    );
    expect(rule(findings, 'STALE_CONTENT')).toHaveLength(2);
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

  it('does NOT fire on an oversized lead-contract / operating-model block (v0.14)', () => {
    const findings = audit(
      buildWorkspace({
        'CLAUDE.md':
          '## L0 operating model (the role contract)\n' + 'word '.repeat(700),
      }),
    );
    expect(rule(findings, 'LAYER_BLOAT')).toHaveLength(0);
  });

  it('still fires on an oversized situational block reusing a contract word (v0.14)', () => {
    const findings = audit(
      buildWorkspace({
        'CLAUDE.md':
          '## Operating model in practice (daily run loop)\n' + 'word '.repeat(700),
      }),
    );
    expect(at(findings, 'LAYER_BLOAT', 'CLAUDE.md')?.message).toContain(
      'Operating model in practice',
    );
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

describe('audit(): F6 + W3 heuristic precision (#36)', () => {
  it('F6 does NOT fire on a dash-qualified Process heading with content', () => {
    // `—` is the em-dash, as a real CONTEXT.md heading carries it.
    const findings = audit(
      buildWorkspace({
        'CLAUDE.md': '# r',
        '01-x/CONTEXT.md':
          '## Input\nx\n## Process — repeats at 1mo / 3mo / 6mo\ny\n## Output\nz\n## Completion\ndone',
      }),
    );
    expect(rule(findings, 'MALFORMED_STAGE_CONTRACT')).toHaveLength(0);
  });

  it('F6 still fires when a section is genuinely missing, despite qualifiers elsewhere', () => {
    const findings = audit(
      buildWorkspace({
        'CLAUDE.md': '# r',
        '01-x/CONTEXT.md':
          '## Input — brief\nx\n## Output\nz\n## Completion\ndone',
      }),
    );
    expect(
      at(findings, 'MALFORMED_STAGE_CONTRACT', '01-x/CONTEXT.md')?.message,
    ).toContain('Process');
  });

  // A dense, contiguous behaviour block: many directive markers, tightly packed.
  const behaviourBlock =
    '## Script\nAlways open warm. Never push. You must confirm the budget. ' +
    'Do not hedge. Avoid jargon. Prefer short questions. You should mirror their tone.';

  it('W3 does NOT fire on a transient leaf work file (a scripted call agenda)', () => {
    // A per-item working file at depth: behaviour density is the deliverable.
    const findings = audit(
      buildWorkspace({
        'CLAUDE.md': '# r',
        '02-scope/monday-call-agenda.md': `# Monday call agenda\n\n${behaviourBlock}`,
      }),
    );
    expect(
      findings.some((f) => f.path === '02-scope/monday-call-agenda.md'),
    ).toBe(false);
  });

  it('W3 still fires on an always-loaded standing file mixing situational + behaviour', () => {
    const findings = audit(
      buildWorkspace({
        'CLAUDE.md': '# r',
        'context/profile.md': `# Client profile\nBerlin-based, pays quarterly.\n\n${behaviourBlock}`,
      }),
    );
    expect(
      at(findings, 'MONOLITHIC_CONTEXT', 'context/profile.md')?.relatedRule,
    ).toBe('CONTENT_SEGREGATION');
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

  it('does not flag two files that share only fenced code (blocker regression)', () => {
    // Identical fenced block (with a # comment inside) but distinct prose. With
    // fence-aware segmentation the code is stripped, so nothing substantive
    // matches; without it, the leaked code would be a false-positive duplicate.
    const fence = [
      '```sh',
      '# deploy script comment that is not a markdown heading at all',
      'set -euo pipefail',
      'for region in us eu ap sa af me oc la na il; do',
      '  echo "deploying the api service to the ${region} cluster and then waiting"',
      '  kubectl apply -f manifests/ && kubectl rollout status deploy/api --timeout 90',
      '  sleep 5 && curl --silent --fail https://health.internal/${region}/ready',
      'done',
      '```',
    ].join('\n');
    const findings = audit(
      buildWorkspace({
        'CLAUDE.md': '# Root identity',
        'references/a.md': `# A\n\n${voicePara}\n\n${fence}`,
        'references/b.md': `# B\n\n${longParaB}\n\n${fence}`,
      }),
    );
    expect(rule(findings, 'DUPLICATION')).toHaveLength(0);
  });

  it('does not flag two work-product deliverables that share a block (pair guard)', () => {
    const findings = audit(
      buildWorkspace({
        'CLAUDE.md': '# Root identity\n\nClient work lives under `engagements/`.',
        'engagements/javed/report.md': `# Javed\n\n${longParaA}`,
        'engagements/maria/report.md': `# Maria\n\n${longParaA}`,
      }),
    );
    expect(rule(findings, 'DUPLICATION')).toHaveLength(0);
  });

  it('still flags a work product duplicating durable reference content', () => {
    const findings = audit(
      buildWorkspace({
        'CLAUDE.md': '# Root identity\n\nClient work lives under `engagements/`.',
        'engagements/javed/report.md': `# Javed\n\n${longParaA}`,
        'references/playbook.md': `# Playbook\n\n${longParaA}`,
      }),
    );
    expect(paths(findings, 'DUPLICATION')).toEqual([
      'engagements/javed/report.md',
      'references/playbook.md',
    ]);
  });

  it('does not flag two docs whose only shared block is a displayed (nested-fence) code example', () => {
    // Minimal distinct prose (below the token floor) plus a large shared code
    // block shown verbatim in a 4-backtick fence wrapping a 3-backtick one.
    // Without run-length-aware stripping the leaked code dominates and is
    // identical, firing a false positive (Jaccard ~0.9); with the fix it is
    // stripped and the short intros fall under the floor, so nothing qualifies.
    const displayed = [
      '````md',
      '```js',
      '// deployment example shown verbatim in the documentation for every region',
      'const deploy = (region) => kubectl.apply(manifests).then(() => rollout(region, timeout));',
      'for (const region of ["us", "eu", "ap", "sa", "af", "me", "oc", "la", "na", "il"]) {',
      '  await deploy(region); await healthcheck(region); await notify(channel, region);',
      '}',
      '```',
      '````',
    ].join('\n');
    const findings = audit(
      buildWorkspace({
        'CLAUDE.md': '# Root identity',
        'references/a.md': `# A\n\nIntro alpha.\n\n${displayed}`,
        'references/b.md': `# B\n\nIntro beta.\n\n${displayed}`,
      }),
    );
    expect(rule(findings, 'DUPLICATION')).toHaveLength(0);
  });

  it('does not flag a nested-workspace .memory/ copy (depth-robust guard)', () => {
    const findings = audit(
      buildWorkspace({
        'CLAUDE.md': `# Root identity\n\n## Voice\n\n${voicePara}`,
        'subws/CLAUDE.md': '# Sub identity',
        'subws/.memory/note.md': `# Note\n\n${voicePara}`,
      }),
    );
    expect(rule(findings, 'DUPLICATION')).toHaveLength(0);
  });

  it('does not flag a nested-workspace .claude/skills copy (depth-robust guard)', () => {
    const findings = audit(
      buildWorkspace({
        'CLAUDE.md': `# Root identity\n\n## Voice\n\n${voicePara}`,
        'subws/CLAUDE.md': '# Sub identity',
        'subws/.claude/skills/demo/SKILL.md': `# Demo\n\n${voicePara}`,
      }),
    );
    expect(rule(findings, 'DUPLICATION')).toHaveLength(0);
  });

  it('does not flag an archives/ copy (retired-content guard)', () => {
    const findings = audit(
      buildWorkspace({
        'CLAUDE.md': `# Root identity\n\nSee \`archives/old.md\`.\n\n## Voice\n\n${voicePara}`,
        'archives/old.md': `# Old\n\n${voicePara}`,
      }),
    );
    expect(rule(findings, 'DUPLICATION')).toHaveLength(0);
  });

  it('does not flag an L2 numbered-stage work file (stage-scratch guard)', () => {
    const findings = audit(
      buildWorkspace({
        'CLAUDE.md': `# Root identity\n\n## Voice\n\n${voicePara}`,
        '01-stage/work.md': `# Work\n\n${voicePara}`,
      }),
    );
    expect(rule(findings, 'DUPLICATION')).toHaveLength(0);
  });
});

describe('audit(): F9 SUPERSEDED_BUT_LIVE (§4.9)', () => {
  it('fires on a live-routed file opening with a superseded banner, backing W5', () => {
    const findings = audit(
      buildWorkspace({
        'CLAUDE.md': '# Root identity',
        'references/old.md': '> Superseded: replaced by references/new.md.\n\nstale notes',
      }),
    );
    const f9 = at(findings, 'SUPERSEDED_BUT_LIVE', 'references/old.md');
    expect(f9?.relatedRule).toBe('ROUTABLE_FILES');
    expect(f9?.message).toMatch(/\(F9 SUPERSEDED_BUT_LIVE\)\.$/);
    expect(f9?.message).toContain('reference');
  });

  it('is silent on a deprecation mentioned mid-document, not at line start', () => {
    const findings = audit(
      buildWorkspace({
        'CLAUDE.md': '# Root identity',
        'references/notes.md': '# Notes\n\nThe v1 pipeline was deprecated last year.',
      }),
    );
    expect(rule(findings, 'SUPERSEDED_BUT_LIVE')).toHaveLength(0);
  });

  it('is silent on a banner file that already lives under archives/', () => {
    const findings = audit(
      buildWorkspace({
        'CLAUDE.md': '# Root identity\n\nSee `archives/old.md`.',
        'archives/old.md': '> Superseded: replaced by references/new.md.\n\nretired',
      }),
    );
    expect(rule(findings, 'SUPERSEDED_BUT_LIVE')).toHaveLength(0);
  });

  it('is silent on an unclassified banner file (that is F2 HIDDEN_CONTEXT, not F9)', () => {
    const findings = audit(
      buildWorkspace({
        'CLAUDE.md': '# Root identity',
        'orphan.md': '> Deprecated: do not use.\n\nunrouted and dead',
      }),
    );
    expect(rule(findings, 'SUPERSEDED_BUT_LIVE')).toHaveLength(0);
    expect(at(findings, 'HIDDEN_CONTEXT', 'orphan.md')).toBeDefined();
  });

  it('is silent on a live file with no banner', () => {
    const findings = audit(
      buildWorkspace({
        'CLAUDE.md': '# Root identity',
        'references/live.md': '# Live\n\nCurrent reference content, in active use.',
      }),
    );
    expect(rule(findings, 'SUPERSEDED_BUT_LIVE')).toHaveLength(0);
  });

  it('is silent when a marker word only appears inside a top-of-file code example', () => {
    const findings = audit(
      buildWorkspace({
        'CLAUDE.md': '# Root identity',
        'references/config.md':
          '# Config\n\n```yaml\nstatus: deprecated\nname: example\n```\n\nCurrent, in active use.',
      }),
    );
    expect(rule(findings, 'SUPERSEDED_BUT_LIVE')).toHaveLength(0);
  });

  it('fires on a label-shaped banner but not a live doc that opens with a marker word', () => {
    const findings = audit(
      buildWorkspace({
        'CLAUDE.md': '# Root identity',
        'references/dead.md': 'Deprecated.\n\nOld notes, kept live by mistake.',
        'references/deprecated-features.md':
          '# Deprecated features\n\nA live reference that documents APIs scheduled for removal.',
      }),
    );
    expect(paths(findings, 'SUPERSEDED_BUT_LIVE')).toEqual(['references/dead.md']);
  });
});

describe('audit(): F7 KIT_BOILERPLATE (§4.7, injected synthetic git)', () => {
  // The committed fixtures live in icm-kit's own git history, so a real fork
  // point cannot be faked there; F7's git signal is injected via buildWorkspace's
  // 2nd arg instead (see fixtures.ts). "Inherited and never adapted": present at
  // the fork point, no commit since.
  const boilerplate = {
    tracked: true,
    existedAtForkPoint: true,
    postForkCommits: 0,
  };

  it('fires once on a tracked, routed reference file untouched since the fork', () => {
    const findings = audit(
      buildWorkspace(
        {
          'CLAUDE.md': '# Root identity',
          'references/3ms-framework.md': '# 3MS framework\n\nUpstream kit content.',
        },
        { 'references/3ms-framework.md': boilerplate },
      ),
    );
    const f7 = rule(findings, 'KIT_BOILERPLATE');
    expect(f7).toHaveLength(1);
    expect(f7[0].path).toBe('references/3ms-framework.md');
    expect(f7[0].relatedRule).toBeUndefined();
    expect(f7[0].message).toMatch(/\(F7 KIT_BOILERPLATE\)\.$/);
  });

  it('fires on a routed skill: an un-adapted kit skill is exactly the target', () => {
    const findings = audit(
      buildWorkspace(
        {
          'CLAUDE.md': '# Root identity',
          '.claude/skills/onboard/SKILL.md':
            '# Onboard\n\nUpstream skill, never adapted.',
        },
        { '.claude/skills/onboard/SKILL.md': boilerplate },
      ),
    );
    expect(paths(findings, 'KIT_BOILERPLATE')).toEqual([
      '.claude/skills/onboard/SKILL.md',
    ]);
  });

  it('is silent once a single commit after the fork has touched the file', () => {
    // postForkCommits is the one distinguishing variable from the positive case.
    const findings = audit(
      buildWorkspace(
        {
          'CLAUDE.md': '# Root identity',
          'references/3ms-framework.md': '# 3MS framework\n\nNow adapted.',
        },
        {
          'references/3ms-framework.md': {
            tracked: true,
            existedAtForkPoint: true,
            postForkCommits: 1,
          },
        },
      ),
    );
    expect(rule(findings, 'KIT_BOILERPLATE')).toHaveLength(0);
  });

  it('never flags CLAUDE.md, even untouched since the fork (identity is exempt)', () => {
    const findings = audit(
      buildWorkspace(
        { 'CLAUDE.md': '# Root identity\n\nUntouched since the fork.' },
        { 'CLAUDE.md': boilerplate },
      ),
    );
    expect(rule(findings, 'KIT_BOILERPLATE')).toHaveLength(0);
  });

  it('is silent off-repo (the default untracked provenance)', () => {
    const findings = audit(
      buildWorkspace({
        'CLAUDE.md': '# Root identity',
        'references/doc.md': '# Doc\n\nContent, but no git history is injected.',
      }),
    );
    expect(rule(findings, 'KIT_BOILERPLATE')).toHaveLength(0);
  });

  it('exempts the harness and work homes, even when untouched since the fork', () => {
    // .memory/ is always-loaded; an NN-stage file is per-task scratch. "Untouched
    // since fork" is expected in both, not a defect (the anti-noise guard).
    const findings = audit(
      buildWorkspace(
        {
          'CLAUDE.md': '# Root identity',
          '.memory/note.md': '# Note\n\nAlways-loaded memory.',
          '02-build/spec.md': '# Spec\n\nStage scratch.',
        },
        {
          '.memory/note.md': boilerplate,
          '02-build/spec.md': boilerplate,
        },
      ),
    );
    expect(rule(findings, 'KIT_BOILERPLATE')).toHaveLength(0);
  });

  it('exempts a routed file under archives/ (retired content)', () => {
    const findings = audit(
      buildWorkspace(
        {
          'CLAUDE.md': '# Root identity\n\nRetired drafts live under `archives/`.',
          'archives/old.md': '# Old\n\nRetired, untouched since the fork.',
        },
        { 'archives/old.md': boilerplate },
      ),
    );
    expect(rule(findings, 'KIT_BOILERPLATE')).toHaveLength(0);
    // The file is routed (declared work folder), so the silence is the archive
    // guard, not the unrouted guard: F2 would fire on an unrouted file.
    expect(at(findings, 'HIDDEN_CONTEXT', 'archives/old.md')).toBeUndefined();
  });

  it('reports an unrouted untouched file as F2 HIDDEN_CONTEXT, not F7', () => {
    const findings = audit(
      buildWorkspace(
        {
          'CLAUDE.md': '# Root identity',
          'orphan.md': '# Orphan\n\nUnrouted and untouched since the fork.',
        },
        { 'orphan.md': boilerplate },
      ),
    );
    expect(rule(findings, 'KIT_BOILERPLATE')).toHaveLength(0);
    expect(at(findings, 'HIDDEN_CONTEXT', 'orphan.md')).toBeDefined();
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

describe('audit(): F2 reachability closure (pointer-file routing, #33)', () => {
  it('routes files indexed only by a routed pointer file (the coaching shape)', () => {
    // coaching/CLAUDE.md names the `ed.md` pointer; ed.md's ## Workspace table
    // links the program files. The programs sit in no canonical home and no
    // CLAUDE.md names them, yet they are reachable through the routed pointer.
    const findings = audit(
      buildWorkspace({
        'CLAUDE.md':
          '# Coaching\n\n## Clients\n| Client | Pointer |\n|--|--|\n| Ed | [ed.md](ed.md) |',
        'ed.md':
          '# Ed\n\n## Workspace\n- [ed/2026-06-build-the-ladder.md](ed/2026-06-build-the-ladder.md)\n- [ed/2026-06-hold-the-line.md](ed/2026-06-hold-the-line.md)',
        'ed/2026-06-build-the-ladder.md': '# Build the ladder\n\nprogram content',
        'ed/2026-06-hold-the-line.md': '# Hold the line\n\nprogram content',
      }),
    );
    // No HIDDEN_CONTEXT anywhere: the pointer is named, the programs are linked.
    expect(rule(findings, 'HIDDEN_CONTEXT')).toHaveLength(0);
  });

  it('routes transitively, multi-hop, resolving each link against its own dir', () => {
    // canonical context hub -> ../ed/a.md -> b.md, each link relative to the
    // referencing file's directory (a `../` cross-dir hop included).
    const findings = audit(
      buildWorkspace({
        'CLAUDE.md': '# root',
        'context/hub.md': 'Start at [the program](../ed/a.md).',
        'ed/a.md': 'Then [the next step](b.md).',
        'ed/b.md': 'leaf',
      }),
    );
    expect(at(findings, 'HIDDEN_CONTEXT', 'ed/a.md')).toBeUndefined();
    expect(at(findings, 'HIDDEN_CONTEXT', 'ed/b.md')).toBeUndefined();
  });

  it('still flags a genuine orphan no routed file references (over-trigger guard)', () => {
    const findings = audit(
      buildWorkspace({
        'CLAUDE.md': '# root\n\nThe hub is [here](context/hub.md).',
        'context/hub.md': 'nothing links the orphan',
        'orphan.md': 'no routed file references this file',
      }),
    );
    expect(at(findings, 'HIDDEN_CONTEXT', 'orphan.md')).toBeDefined();
    expect(paths(findings, 'HIDDEN_CONTEXT')).toEqual(['orphan.md']);
  });

  it('an orphan cannot bootstrap routing from another orphan', () => {
    // Neither file is reachable from a canonical home, so the link between them
    // routes nothing: both stay hidden.
    const findings = audit(
      buildWorkspace({
        'CLAUDE.md': '# root',
        'orphan-a.md': 'see [b](orphan-b.md)',
        'orphan-b.md': 'leaf',
      }),
    );
    expect(paths(findings, 'HIDDEN_CONTEXT')).toEqual([
      'orphan-a.md',
      'orphan-b.md',
    ]);
  });

  it('a dead link routes no phantom file and does not crash', () => {
    const findings = audit(
      buildWorkspace({
        'CLAUDE.md': '# root\n\n[hub](context/hub.md)',
        'context/hub.md': 'see [gone](../does-not-exist.md)',
        'orphan.md': 'still hidden',
      }),
    );
    // Only the real orphan is hidden; the dangling target invents no finding.
    expect(paths(findings, 'HIDDEN_CONTEXT')).toEqual(['orphan.md']);
  });

  it('external URLs and #anchors route nothing', () => {
    const findings = audit(
      buildWorkspace({
        'CLAUDE.md': '# root\n\n[hub](context/hub.md)',
        'context/hub.md':
          'see [site](https://example.com/orphan.md) and [top](#heading)',
        'orphan.md': 'hidden despite the external lookalike link',
      }),
    );
    expect(at(findings, 'HIDDEN_CONTEXT', 'orphan.md')).toBeDefined();
  });

  it('routes a pointer named in a load/skip table and the file it links', () => {
    // The pointer `ed.md` is routed by a load/skip cell; its own link then routes
    // the program in a subfolder that no CLAUDE.md declares as a work folder, so
    // the program is reachable only through the closure.
    const findings = audit(
      buildWorkspace({
        'CLAUDE.md':
          '## Load/skip table\n| Task | Load | Skip |\n|--|--|--|\n| ed | ed.md | x |',
        'ed.md': 'program: [a](programs/a.md)',
        'programs/a.md': 'leaf',
      }),
    );
    expect(rule(findings, 'HIDDEN_CONTEXT')).toHaveLength(0);
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

  it('F8: the shared repeated-line block in sync.md / acme brief, both sides', () => {
    expect(paths(findings, 'DUPLICATION')).toEqual([
      'clients/acme/brief.md',
      'references/sync.md',
    ]);
    expect(at(findings, 'DUPLICATION', 'clients/acme/brief.md')?.message).toContain(
      'references/sync.md',
    );
  });

  it('F9 / W5: every live-routed file carrying a superseded banner, real shapes included (#28)', () => {
    // The synthetic `> Superseded: replaced by ...` shape plus the two real
    // AIOS dogfood shapes the rule was derived from but under-caught: a marker
    // trailed by an ISO date (`SUPERSEDED 2026-06-01 by ...`) and a warning
    // emoji ahead of the marker (`> **⚠️ REFRAMED 2026-06-03 ...`).
    expect(paths(findings, 'SUPERSEDED_BUT_LIVE')).toEqual([
      'references/build-b-aios.md',
      'references/pain.md',
      'references/superseded-routing.md',
    ]);
    expect(
      at(findings, 'SUPERSEDED_BUT_LIVE', 'references/superseded-routing.md')?.relatedRule,
    ).toBe('ROUTABLE_FILES');
  });

  it('produces exactly the expected findings', () => {
    expect(findings).toHaveLength(17);
  });
});
