import { describe, it, expect } from 'vitest';
import {
  countIdentityMarkers,
  extractMarkdownPointers,
  hasLoadSkipTable,
  namedByClaudeMd,
  parseStageContract,
  splitSections,
} from '../src/parse.js';
import { STAGE_CONTRACT_SECTIONS } from '../src/model.js';

describe('hasLoadSkipTable', () => {
  it('detects a table with a Load or Skip column', () => {
    expect(
      hasLoadSkipTable('| Task | Load | Skip |\n|--|--|--|\n| a | b | c |'),
    ).toBe(true);
  });

  it('detects a load/skip heading', () => {
    expect(hasLoadSkipTable('## Load/skip routing\n\nsome text')).toBe(true);
  });

  it('is false for prose with no table', () => {
    expect(hasLoadSkipTable('# Identity\n\nWe value brevity.')).toBe(false);
  });
});

describe('namedByClaudeMd', () => {
  const text = 'See `references/voice.md` and runbook.md for details.';

  it('matches by full path and by basename', () => {
    expect(namedByClaudeMd(text, 'references/voice.md')).toBe(true);
    expect(namedByClaudeMd(text, 'runbook.md')).toBe(true);
  });

  it('does not match a basename inside a longer name', () => {
    expect(namedByClaudeMd('see old-runbook.md', 'runbook.md')).toBe(false);
  });
});

describe('extractMarkdownPointers', () => {
  it('extracts distinct workspace-relative Markdown paths', () => {
    const md = 'Load `runbook.md`, then references/voice.md and runbook.md.';
    expect(extractMarkdownPointers(md).sort()).toEqual([
      'references/voice.md',
      'runbook.md',
    ]);
  });

  it('ignores the tail of a URL', () => {
    expect(extractMarkdownPointers('see https://example.com/readme.md')).toEqual(
      [],
    );
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
    expect(sections[1].body.trim()).toBe('body a');
  });
});

describe('countIdentityMarkers', () => {
  it('counts behavioural directive markers', () => {
    expect(countIdentityMarkers('Always X. Never Y. You must Z.')).toBe(3);
    expect(countIdentityMarkers('The user lives in Berlin.')).toBe(0);
  });
});

describe('parseStageContract', () => {
  it('reports no gaps for a complete contract', () => {
    const md =
      '## Input\nx\n## Process\ny\n## Output\nz\n## Completion\ndone';
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
