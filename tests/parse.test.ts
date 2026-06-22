import { describe, it, expect } from 'vitest';
import {
  countIdentityMarkers,
  declaredWorkFolders,
  extractLoadSkipReferences,
  findDuplicateProse,
  hasBehaviourBlock,
  hasLoadSkipTable,
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
});
