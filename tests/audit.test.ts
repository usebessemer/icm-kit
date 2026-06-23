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

  it('F9 / W5: the one live-routed file carrying a superseded banner', () => {
    expect(paths(findings, 'SUPERSEDED_BUT_LIVE')).toEqual([
      'references/superseded-routing.md',
    ]);
    expect(
      at(findings, 'SUPERSEDED_BUT_LIVE', 'references/superseded-routing.md')?.relatedRule,
    ).toBe('ROUTABLE_FILES');
  });

  it('produces exactly the expected findings', () => {
    expect(findings).toHaveLength(15);
  });
});
