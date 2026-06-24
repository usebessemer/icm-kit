import { describe, it, expect } from 'vitest';
import {
  countIdentityMarkers,
  declaredWorkFolders,
  extractLoadSkipReferences,
  findDuplicateProse,
  hasBehaviourBlock,
  hasLoadSkipTable,
  hasSupersededBanner,
  isAppendOnlyLog,
  isIdentityHeading,
  namedByClaudeMd,
  parseStageContract,
  proseBlocks,
  splitSections,
} from '../src/parse.js';
import { STAGE_CONTRACT_SECTIONS } from '../src/model.js';

describe('hasLoadSkipTable', () => {
  it('detects a table naming both Load and Skip columns', () => {
    expect(
      hasLoadSkipTable('| Task | Load | Skip |\n|--|--|--|\n| a | b | c |'),
    ).toBe(true);
  });

  it('detects a load/skip heading', () => {
    expect(hasLoadSkipTable('## Load/skip routing\n\nsome text')).toBe(true);
  });

  it('is false for a table with only a Load column (tightened)', () => {
    expect(hasLoadSkipTable('| Step | Load |\n|--|--|\n| 1 | 2 |')).toBe(false);
  });

  it('is false for prose with no table', () => {
    expect(hasLoadSkipTable('# Identity\n\nWe value brevity.')).toBe(false);
  });
});

describe('extractLoadSkipReferences (within-cell resolution, §4.3)', () => {
  const table = (cell: string): string =>
    `## Load/skip table\n| Task | Load | Skip |\n| -- | -- | -- |\n| t | ${cell} | x |`;

  it('extracts a qualified pointer from the table rows, not from prose', () => {
    const md = 'See `old.md` in prose.\n\n' + table('references/voice.md');
    expect(extractLoadSkipReferences(md)).toEqual([
      {
        token: 'references/voice.md',
        structural: false,
        candidates: ['references/voice.md'],
      },
    ]);
  });

  it('qualifies a bare name with a directory token in the same cell', () => {
    const refs = extractLoadSkipReferences(
      table('`references/kit/` (catalog + `_template.md`)'),
    );
    expect(refs).toHaveLength(1);
    expect(refs[0].token).toBe('_template.md');
    expect(refs[0].candidates).toContain('references/kit/_template.md');
  });

  it('qualifies a bare name with a relative directory token in the same cell (#27)', () => {
    // The AIOS shape: the same-cell directory is itself a sibling-workspace hop.
    // The pairing must produce the relative candidate; the resolver (§4.3) then
    // POSIX-normalizes it against the containing CLAUDE.md's directory.
    const refs = extractLoadSkipReferences(
      table('`../coaching/references/sc-methodology/complexes/` (catalog + `_template.md`)'),
    );
    expect(refs).toHaveLength(1);
    expect(refs[0].token).toBe('_template.md');
    expect(refs[0].candidates).toContain(
      '../coaching/references/sc-methodology/complexes/_template.md',
    );
  });

  it('marks a bare structural-convention name (CONTEXT.md) as structural', () => {
    expect(extractLoadSkipReferences(table("the stage's `CONTEXT.md`"))).toEqual([
      { token: 'CONTEXT.md', structural: true, candidates: ['CONTEXT.md'] },
    ]);
  });

  it('does not mark a qualified CONTEXT.md path as structural', () => {
    const refs = extractLoadSkipReferences(table('01-discovery/CONTEXT.md'));
    expect(refs[0].structural).toBe(false);
  });
});

describe('declaredWorkFolders (§2.5 work-folder row)', () => {
  it('counts a folder named in prose', () => {
    expect(declaredWorkFolders('Work lives under `projects/`.').has('projects')).toBe(
      true,
    );
  });

  it('does not count a folder named only in the Skip column', () => {
    const md = '| Task | Load | Skip |\n|--|--|--|\n| a | references/ | drafts/ |';
    expect(declaredWorkFolders(md).has('drafts')).toBe(false);
  });

  it('excludes canonical homes', () => {
    const folders = declaredWorkFolders('uses context/ and references/ and projects/');
    expect(folders.has('context')).toBe(false);
    expect(folders.has('references')).toBe(false);
    expect(folders.has('projects')).toBe(true);
  });
});

describe('isIdentityHeading', () => {
  it('recognises identity headings', () => {
    expect(isIdentityHeading('Voice and conventions')).toBe(true);
    expect(isIdentityHeading('Operating principles')).toBe(true);
  });

  it('does not recognise ops-manual headings', () => {
    expect(isIdentityHeading('iMessage operations')).toBe(false);
    expect(isIdentityHeading('Email workflow')).toBe(false);
  });
});

describe('hasBehaviourBlock (density-normalised, F1 soft / W3)', () => {
  it('fires on a dense rules block', () => {
    expect(
      hasBehaviourBlock(
        '## Rules\nAlways do X. Never do Y. You must do Z. Do not do W.',
      ),
    ).toBe(true);
  });

  it('does not fire on a situational fact that merely narrates behaviour', () => {
    expect(
      hasBehaviourBlock('The client always pays cash and never disputes invoices.'),
    ).toBe(false);
  });

  it('does not fire on a few directive words spread thin', () => {
    const sparse =
      'The team always meets on Monday and the lead never cancels and new members should attend ' +
      'and we then review the prior notes and the open items and the next steps together as a group '.repeat(
        2,
      );
    expect(hasBehaviourBlock(sparse)).toBe(false);
  });
});

describe('isAppendOnlyLog (F1 append-only exemption, §4.1)', () => {
  it('fires on a decisions-log shape (dated ## entries)', () => {
    const log = [
      '# Decisions Log',
      '',
      'Append-only record.',
      '',
      '## 2026-05-14 — a',
      'x',
      '## 2026-05-15 — b',
      'y',
      '## 2026-05-16 — c',
      'z',
    ].join('\n');
    expect(isAppendOnlyLog(log)).toBe(true);
  });

  it('fires on an async-channel shape (dated ### entries)', () => {
    const chan = [
      '# Channel',
      '### 2026-06-10 · A — x',
      '### 2026-06-11 · B — y',
      '### 2026-06-12 · C — z',
    ].join('\n');
    expect(isAppendOnlyLog(chan)).toBe(true);
  });

  it('does not count a literal YYYY-MM-DD template placeholder as a dated entry', () => {
    const tmpl = '# Doc\n\n## YYYY-MM-DD — title\n\nFormat per entry, no real dates yet.';
    expect(isAppendOnlyLog(tmpl)).toBe(false);
  });

  it('does not fire below the three-entry threshold or on ordinary prose', () => {
    expect(isAppendOnlyLog('# Notes\n\n## 2026-01-01 kickoff\n\n## 2026-02-01 review')).toBe(
      false,
    );
    expect(isAppendOnlyLog('# Guide\n\n## Setup\n\n## Usage\n\n## FAQ')).toBe(false);
  });
});

describe('splitSections', () => {
  it('splits on headings and keeps a level-0 preamble', () => {
    const sections = splitSections('intro\n\n# A\nbody a\n## B\nbody b');
    expect(sections.map((s) => ({ level: s.level, heading: s.heading }))).toEqual(
      [
        { level: 0, heading: '' },
        { level: 1, heading: 'A' },
        { level: 2, heading: 'B' },
      ],
    );
  });
});

describe('countIdentityMarkers', () => {
  it('counts behavioural directive markers', () => {
    expect(countIdentityMarkers('Always X. Never Y. You must Z.')).toBe(3);
    expect(countIdentityMarkers('The user lives in Berlin.')).toBe(0);
  });
});

describe('namedByClaudeMd', () => {
  it('matches by full path and basename, not as a substring of a longer name', () => {
    const text = 'See `references/voice.md` and runbook.md for details.';
    expect(namedByClaudeMd(text, 'references/voice.md')).toBe(true);
    expect(namedByClaudeMd(text, 'runbook.md')).toBe(true);
    expect(namedByClaudeMd('see old-runbook.md', 'runbook.md')).toBe(false);
  });
});

describe('parseStageContract', () => {
  it('reports no gaps for a complete contract', () => {
    const md = '## Input\nx\n## Process\ny\n## Output\nz\n## Completion\ndone';
    expect(parseStageContract(md, STAGE_CONTRACT_SECTIONS)).toEqual({
      missing: [],
      empty: [],
    });
  });

  it('tolerates a case and plural variation in headings', () => {
    const md = '## inputs\nx\n## Process\ny\n## Outputs\nz\n## Completion\ndone';
    expect(parseStageContract(md, STAGE_CONTRACT_SECTIONS)).toEqual({
      missing: [],
      empty: [],
    });
  });

  it('reports missing and empty sections', () => {
    const md = '## Input\nx\n## Process\n\n## Output\nz';
    expect(parseStageContract(md, STAGE_CONTRACT_SECTIONS)).toEqual({
      missing: ['Completion'],
      empty: ['Process'],
    });
  });
});

describe('proseBlocks (F8 segmentation, §4.8)', () => {
  it('normalizes prose and drops code fences, tables, and link-/path-only lines', () => {
    const md = [
      '# Heading',
      'First sentence of PROSE here.',
      '',
      '```',
      'const code = 1;',
      '```',
      '| a | b |',
      '| - | - |',
      '[link](http://example.com)',
      'references/voice.md',
      'Second real sentence.',
    ].join('\n');
    expect(proseBlocks(md)).toEqual([
      ['first', 'sentence', 'of', 'prose', 'here', 'second', 'real', 'sentence'],
    ]);
  });

  it('produces one block per heading section and drops empty sections', () => {
    expect(proseBlocks('# A\nalpha beta\n# B\n\n# C\ngamma')).toEqual([
      ['alpha', 'beta'],
      ['gamma'],
    ]);
  });

  it('does not read a # inside a fence as a heading, and drops the fenced code', () => {
    const md = [
      '# Real Heading',
      'Actual prose one here.',
      '',
      '```sh',
      '# this shell comment is not a heading',
      'echo leaked fenced code that must never reach prose',
      '```',
      'Actual prose two here.',
    ].join('\n');
    const blocks = proseBlocks(md);
    // One block (the fence did not split the section), and no fenced tokens.
    expect(blocks).toEqual([
      ['actual', 'prose', 'one', 'here', 'actual', 'prose', 'two', 'here'],
    ]);
    expect(blocks.flat()).not.toContain('echo');
    expect(blocks.flat()).not.toContain('leaked');
    expect(blocks.flat()).not.toContain('comment');
  });

  it('strips an unclosed fence to end of document', () => {
    const md = ['# H', 'kept prose line', '```', '# not a heading', 'dangling code'].join(
      '\n',
    );
    expect(proseBlocks(md)).toEqual([['kept', 'prose', 'line']]);
  });

  it('keeps a mismatched inner fence (~~~ inside a ``` block) as code', () => {
    const md = [
      '# H',
      'real prose alpha here.',
      '```bash',
      '# shell comment not a heading',
      'echo one',
      '~~~',
      '# still inside the code fence',
      'echo two',
      '```',
      'real prose beta here.',
    ].join('\n');
    const blocks = proseBlocks(md);
    expect(blocks).toEqual([
      ['real', 'prose', 'alpha', 'here', 'real', 'prose', 'beta', 'here'],
    ]);
    expect(blocks.flat()).not.toContain('echo');
    expect(blocks.flat()).not.toContain('still');
  });

  it('keeps a shorter inner fence (``` inside a ```` block) as code', () => {
    const md = [
      '# H',
      'intro prose word.',
      '````md',
      '```js',
      'leaked = secret(value)',
      '```',
      '````',
      'outro prose word.',
    ].join('\n');
    const blocks = proseBlocks(md);
    expect(blocks).toEqual([['intro', 'prose', 'word', 'outro', 'prose', 'word']]);
    expect(blocks.flat()).not.toContain('leaked');
    expect(blocks.flat()).not.toContain('secret');
  });
});

describe('findDuplicateProse (F8 comparator, §4.8)', () => {
  const wordCount = (t: string): number =>
    t.trim() ? t.trim().split(/\s+/).length : 0;
  const opts = {
    shingleSize: 5,
    similarityFloor: 0.8,
    minBlockTokens: 40,
    countTokens: wordCount,
  };

  // A 45-word block, comfortably over the 40-token floor.
  const para =
    'the operator reviews every incoming digest each morning and files the relevant ' +
    'items under the correct client label before the standup so that nothing slips ' +
    'through the cracks and the weekly report stays accurate complete and genuinely ' +
    'useful to the whole distributed team across regions';

  // A distinct 45-word block sharing no 5-word shingle with `para`.
  const otherPara =
    'budget forecasts for the upcoming fiscal year depend heavily on procurement ' +
    'timelines vendor negotiations and seasonal demand which finance models separately ' +
    'using historical baselines while marketing prepares independent campaigns targeting ' +
    'newer audiences in emerging coastal markets through partnerships and paid experiments';

  it('pairs two files sharing an identical block over the token floor', () => {
    expect(
      findDuplicateProse(
        [
          { path: 'a.md', content: `# A\n${para}` },
          { path: 'b.md', content: `# B\n${para}` },
        ],
        opts,
      ),
    ).toEqual([{ left: 'a.md', right: 'b.md' }]);
  });

  it('does not pair when the shared block is below the token floor', () => {
    const short = 'a tiny shared line of prose';
    expect(
      findDuplicateProse(
        [
          { path: 'a.md', content: `# A\n${short}` },
          { path: 'b.md', content: `# B\n${short}` },
        ],
        opts,
      ),
    ).toEqual([]);
  });

  it('does not pair genuinely different prose blocks', () => {
    expect(
      findDuplicateProse(
        [
          { path: 'a.md', content: `# A\n${para}` },
          { path: 'b.md', content: `# B\n${otherPara}` },
        ],
        opts,
      ),
    ).toEqual([]);
  });

  it('orders each returned pair by input order (deterministic)', () => {
    const pairs = findDuplicateProse(
      [
        { path: 'context/x.md', content: `# X\n${para}` },
        { path: 'references/y.md', content: `# Y\n${para}` },
      ],
      opts,
    );
    expect(pairs).toEqual([
      { left: 'context/x.md', right: 'references/y.md' },
    ]);
  });

  it('compares a sub-shingle-width block as a single whole-block shingle', () => {
    // A block with fewer words than the shingle width still shingles (as one
    // whole-block token), so identical short-but-over-floor blocks match and
    // distinct ones do not. Floor lowered so the 3-word blocks qualify.
    const lowFloor = { ...opts, minBlockTokens: 1 };
    expect(
      findDuplicateProse(
        [
          { path: 'a.md', content: '# A\nthree word block' },
          { path: 'b.md', content: '# B\nthree word block' },
        ],
        lowFloor,
      ),
    ).toEqual([{ left: 'a.md', right: 'b.md' }]);
    expect(
      findDuplicateProse(
        [
          { path: 'a.md', content: '# A\nthree word block' },
          { path: 'b.md', content: '# B\nfour different short words' },
        ],
        lowFloor,
      ),
    ).toEqual([]);
  });
});

describe('hasSupersededBanner (F9 top-region banner, §4.9)', () => {
  const scan = 15;

  it('fires on a blockquote banner as the first line', () => {
    expect(
      hasSupersededBanner('> Superseded: replaced by references/new.md.\n\nold notes', scan),
    ).toBe(true);
  });

  it('fires on a banner under a title heading (top region spans the first section)', () => {
    expect(hasSupersededBanner('# Old plan\n\n> Deprecated: see build-c.md', scan)).toBe(true);
  });

  it('fires on bolded, heading-styled, and status: marker forms', () => {
    expect(hasSupersededBanner('**Deprecated** — do not use.', scan)).toBe(true);
    expect(hasSupersededBanner('## Retired\n\nmoved to archives', scan)).toBe(true);
    expect(hasSupersededBanner('Status: superseded\n\nbody', scan)).toBe(true);
    expect(hasSupersededBanner('Reframed: this became build-b.', scan)).toBe(true);
  });

  it('does not fire on a deprecation mentioned mid-line in prose', () => {
    expect(
      hasSupersededBanner('# Notes\n\nThe v1 pipeline was deprecated last year.', scan),
    ).toBe(false);
  });

  it('does not fire on a marker word that is not at line start', () => {
    expect(hasSupersededBanner('The plan is now obsolete and retired.', scan)).toBe(false);
  });

  it('does not scan past the line cap or out of the first section', () => {
    const deep = '# T\n\nintro\n\n## Later\n\n> Superseded: x';
    expect(hasSupersededBanner(deep, scan)).toBe(false); // banner is in a later section
    const buried = ['# T', ...Array(20).fill('filler line'), '> Superseded: x'].join('\n');
    expect(hasSupersededBanner(buried, scan)).toBe(false); // beyond the 15-line cap
  });

  it('does not fire on an empty or banner-less file', () => {
    expect(hasSupersededBanner('', scan)).toBe(false);
    expect(hasSupersededBanner('# Spec\n\nA working build spec, current and live.', scan)).toBe(
      false,
    );
  });

  it('gives a heading-first file the full scan budget (no phantom-preamble off-by-one)', () => {
    const banner = '> Deprecated: use v2 instead.';
    // "# Title" is physical line 1; a banner on physical line 15 must still fire.
    const at15 = ['# Title', ...Array(13).fill('filler prose line.'), banner].join('\n');
    expect(hasSupersededBanner(at15, 15)).toBe(true);
    // A banner on physical line 16 is past the cap.
    const at16 = ['# Title', ...Array(14).fill('filler prose line.'), banner].join('\n');
    expect(hasSupersededBanner(at16, 15)).toBe(false);
  });

  it('does not treat a marker inside a fenced code example as a banner', () => {
    const fenced = [
      '# Config reference',
      '',
      '```yaml',
      'status: deprecated',
      'name: example',
      '```',
      '',
      'Current, in active use.',
    ].join('\n');
    expect(hasSupersededBanner(fenced, scan)).toBe(false);
    // A real banner after the fence still fires (fence is stripped, not the file).
    const real = ['```sh', 'echo example', '```', '', '> Superseded: replaced by new.md'].join(
      '\n',
    );
    expect(hasSupersededBanner(real, scan)).toBe(true);
  });

  it('fires on a label-shaped single-word marker but not when it opens prose', () => {
    // Label-shaped: end of line, separator, closing emphasis, or by/as.
    for (const banner of [
      'Deprecated.',
      'Obsolete!',
      '(Deprecated)',
      'Retired.',
      'Superseded by build-c.md',
      'Reframed as the W5 lens',
      '**Deprecated**',
    ]) {
      expect(hasSupersededBanner(banner, scan)).toBe(true);
    }
    // Live prose / section titles that merely open with a marker word: not banners.
    for (const prose of [
      '# Deprecated features',
      'Do not use tabs; use spaces.',
      'Deprecated APIs are documented below.',
      'Obsolete-stock report for Q3',
      'Reframed the problem as a graph search.',
    ]) {
      expect(hasSupersededBanner(prose, scan)).toBe(false);
    }
  });

  it('keeps phrase markers firing bare, before a trailing target path', () => {
    expect(hasSupersededBanner('Replaced by build-c.md', scan)).toBe(true);
    expect(hasSupersededBanner('No longer current; see upstream.', scan)).toBe(true);
  });

  it('fires on a marker immediately followed by an ISO date (the real banner shape, #28)', () => {
    // pain.md: marker + date + `by`. The date precedes the separator, so the
    // pre-#28 label-shape guard (which expected a separator or `by`/`as`
    // directly after the marker) missed it.
    expect(
      hasSupersededBanner(
        '# Pain — hypothesis\n\n> **SUPERSEDED 2026-06-01 by the discovery call.** Confirmed pain lives elsewhere.',
        scan,
      ),
    ).toBe(true);
    // build-b-aios.md: a warning emoji precedes the marker, and the date is
    // followed by `(see ...)`, never `by`/`as`: caught by the emoji strip plus
    // the date label-shape, not by the `by`/`as` path.
    expect(
      hasSupersededBanner(
        '# Build B\n\n> **Distinct from Build A** (...)\n>\n> **⚠️ REFRAMED 2026-06-03 (see [decisions/log.md](x)).** The standalone-platform framing is superseded.',
        scan,
      ),
    ).toBe(true);
    // The bare date shape, plus a date + em-dash + emoji-prefix case (a real
    // banner separator); the post-date anchor accepts the em-dash terminator.
    expect(hasSupersededBanner('Superseded 2026-06-01.', scan)).toBe(true);
    expect(hasSupersededBanner('⚠️ Deprecated 2025-01-01 — see v2.', scan)).toBe(true);
  });

  it('does not treat a marker followed by a non-date token as a dated banner', () => {
    // Only a full ISO date is date-shaped; a bare year or a word is not.
    expect(hasSupersededBanner('Deprecated 2024 roadmap notes', scan)).toBe(false);
    expect(hasSupersededBanner('Obsolete inventory list for the warehouse', scan)).toBe(false);
  });

  it('does not fire on prose that opens with a marker and an ISO date but runs on', () => {
    // The date must be label-terminated; a date that flows into a verb/noun is
    // an ordinary sentence, not a banner. These are the FP class the post-date
    // anchor closes (#28 review): each must stay silent.
    expect(
      hasSupersededBanner('Deprecated 2024-01-15 was the original ship date', scan),
    ).toBe(false);
    expect(
      hasSupersededBanner('Superseded 2023-01-01 builds are no longer supported', scan),
    ).toBe(false);
    expect(
      hasSupersededBanner('Obsolete 2020-01-01 hardware is still in the warehouse', scan),
    ).toBe(false);
  });
});
