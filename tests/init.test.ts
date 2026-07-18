import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assembleFiles,
  InvalidRoleError,
  NonEmptyTargetError,
  RoleClassConflictError,
  UnknownClassError,
  writeWorkspace,
  type GeneratedFile,
} from '../src/init.js';
import { audit } from '../src/audit.js';
import { readWorkspace } from '../src/workspace.js';
import { findDuplicateProse } from '../src/parse.js';
import { DEFAULT_THRESHOLDS } from '../src/model.js';
import { DEFAULT_TOKEN_COUNTER } from '../src/tokens.js';

/**
 * The generator is the inverse of the reader: it resolves the §7.2 template
 * tree, applies the `--role` expansion, guards a non-empty target, and writes
 * through one injectable seam. These tests exercise the assembly, the guard,
 * and the seam without asserting the audit-green invariant (subtask 4's gate
 * test owns that); the byte-fidelity check reads `src/templates/` directly.
 */

const here = dirname(fileURLToPath(import.meta.url));
const templatesDir = join(here, '..', 'src', 'templates');

/** Walk `src/templates/` into POSIX-relative paths, matching the generator. */
function walkTemplatePaths(dir: string, root = dir): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === '.DS_Store') continue;
    const abs = join(dir, entry);
    if (statSync(abs).isDirectory()) out.push(...walkTemplatePaths(abs, root));
    else out.push(relative(root, abs).split(sep).join('/'));
  }
  return out;
}

const templatePaths = walkTemplatePaths(templatesDir).sort();

function pathsOf(files: readonly GeneratedFile[]): string[] {
  return files.map((f) => f.path);
}

describe('assembleFiles(): the role-less default layout (§7.2)', () => {
  const files = assembleFiles();

  it('emits every template file, and nothing else, sorted by path', () => {
    expect(pathsOf(files)).toEqual(templatePaths);
  });

  it('includes the .gitkeep markers and non-Markdown harness files', () => {
    const paths = pathsOf(files);
    expect(paths).toContain('workspaces/.gitkeep');
    expect(paths).toContain('.memory/.gitkeep');
    expect(paths).toContain('.claude/settings.json');
    expect(paths).toContain('.githooks/pre-commit');
    expect(paths).toContain('archives/README.md');
  });

  it('reproduces each template byte-for-byte with LF newlines', () => {
    for (const file of files) {
      const onDisk = readFileSync(join(templatesDir, file.path), 'utf8');
      expect(file.content).toBe(onDisk);
      expect(file.content.includes('\r')).toBe(false);
    }
  });
});

describe('assembleFiles(): the --role expansion (§7.6)', () => {
  it('adds a minimal L1 role and drops the workspaces marker', () => {
    const paths = pathsOf(assembleFiles({ role: 'example' }));
    expect(paths).toContain('workspaces/example/CLAUDE.md');
    expect(paths).toContain('workspaces/example/context/.gitkeep');
    expect(paths).not.toContain('workspaces/.gitkeep');
    // No pre-built references/ or .claude/skills/ level for the role (§7.6).
    expect(paths.some((p) => p.startsWith('workspaces/example/references/'))).toBe(false);
    expect(paths.some((p) => p.startsWith('workspaces/example/.claude/'))).toBe(false);
  });

  it('writes a non-empty charter naming the role', () => {
    const charter = assembleFiles({ role: 'example' }).find(
      (f) => f.path === 'workspaces/example/CLAUDE.md',
    );
    expect(charter?.content).toContain('# The example role');
    expect(charter?.content.includes('\r')).toBe(false);
  });

  it('rejects a role name that is not a single safe path segment', () => {
    for (const bad of ['..', '.', '', 'a/b', 'a\\b', '../evil']) {
      expect(() => assembleFiles({ role: bad })).toThrow(InvalidRoleError);
    }
  });
});

describe('assembleFiles(): the --class delegating-lead binder (§7.9)', () => {
  it('adds the minimal L1 devlead class and drops the workspaces marker', () => {
    const paths = pathsOf(assembleFiles({ class: 'devlead' }));
    // Exactly two files, and nothing more: the charter and a situational pointer.
    expect(paths).toContain('workspaces/devlead/CLAUDE.md');
    expect(paths).toContain('workspaces/devlead/context/leaf.md');
    expect(paths).not.toContain('workspaces/.gitkeep');
    // No pre-built references/ or .claude/skills/ level; routing depth stays 2 (§7.9).
    expect(paths.some((p) => p.startsWith('workspaces/devlead/references/'))).toBe(false);
    expect(paths.some((p) => p.startsWith('workspaces/devlead/.claude/'))).toBe(false);
    // The class adds files only under workspaces/devlead/: no shipped file changes.
    const added = paths.filter((p) => p.startsWith('workspaces/devlead/'));
    expect(added.sort()).toEqual([
      'workspaces/devlead/CLAUDE.md',
      'workspaces/devlead/context/leaf.md',
    ]);
  });

  it('writes a non-empty charter carrying the delegating-lead contract', () => {
    const charter = assembleFiles({ class: 'devlead' }).find(
      (f) => f.path === 'workspaces/devlead/CLAUDE.md',
    );
    expect(charter?.content).toContain('# The delegating-lead class (devlead)');
    // The three-clause contract (§7.9 smallest-first: surface / delegate / bubble up).
    expect(charter?.content).toContain('Surface, do not decide');
    expect(charter?.content).toContain('Delegate, do not author');
    expect(charter?.content).toContain('Bubble up');
    expect(charter?.content.includes('\r')).toBe(false);
  });

  it('leaf.md is a situational pointer with no dense behaviour block (W3)', () => {
    const leaf = assembleFiles({ class: 'devlead' }).find(
      (f) => f.path === 'workspaces/devlead/context/leaf.md',
    );
    expect(leaf?.content).toContain('# The dev leaf');
    expect(leaf?.content.includes('\r')).toBe(false);
  });

  it('rejects an unknown class value (only devlead is known in v1)', () => {
    for (const bad of ['lead', 'devLead', 'executor', 'nope', '']) {
      expect(() => assembleFiles({ class: bad })).toThrow(UnknownClassError);
    }
  });

  it('refuses --role and --class together (mutually exclusive, §7.9)', () => {
    expect(() => assembleFiles({ role: 'example', class: 'devlead' })).toThrow(
      RoleClassConflictError,
    );
    // The conflict is caught before any known/unknown validation of either value.
    expect(() => assembleFiles({ role: '../evil', class: 'devlead' })).toThrow(
      RoleClassConflictError,
    );
  });
});

describe('writeWorkspace(): the injectable writer seam (criterion 5)', () => {
  it('routes every file through the writer without touching disk', () => {
    const target = join(tmpdir(), 'icm-init-never-created-xyz');
    let captured: readonly GeneratedFile[] | undefined;
    const returned = writeWorkspace(target, {
      writer: (_t, files) => {
        captured = files;
      },
    });
    expect(existsSync(target)).toBe(false);
    expect(captured).toEqual(returned);
    expect(pathsOf(returned)).toEqual(templatePaths);
  });
});

describe('writeWorkspace(): the non-empty-target guard (criterion 4)', () => {
  it('refuses a non-empty target and writes nothing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'icm-guard-'));
    writeFileSync(join(dir, 'keep.txt'), 'existing');
    try {
      expect(() =>
        writeWorkspace(dir, {
          writer: () => {
            throw new Error('writer must not run when the guard trips');
          },
        }),
      ).toThrow(NonEmptyTargetError);
      // The pre-existing file is untouched; nothing was scaffolded.
      expect(readdirSync(dir)).toEqual(['keep.txt']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('proceeds into a non-empty target when overwrite is set', () => {
    const dir = mkdtempSync(join(tmpdir(), 'icm-overwrite-'));
    writeFileSync(join(dir, 'keep.txt'), 'existing');
    try {
      let called = false;
      writeWorkspace(dir, { overwrite: true, writer: () => (called = true) });
      expect(called).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writes freely into an empty directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'icm-empty-'));
    try {
      let called = false;
      writeWorkspace(dir, { writer: () => (called = true) });
      expect(called).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('writeWorkspace(): the default disk writer (criteria 2, 8)', () => {
  it('writes the tree byte-for-byte and initialises no git', () => {
    const dir = mkdtempSync(join(tmpdir(), 'icm-write-'));
    try {
      const written = writeWorkspace(dir);
      for (const file of written) {
        expect(readFileSync(join(dir, file.path), 'utf8')).toBe(file.content);
      }
      expect(existsSync(join(dir, '.git'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Subtask 4: the v1.0 audit-green gate (SPEC §7.1)
//
// The empirical form of the §7.1 invariant: a freshly generated, un-ignited tree
// audits to zero findings. Each case generates into an off-repo tmp dir (so the
// reader's NO_GIT defaults apply and F7 stays silent, §7.8), audits it, and
// asserts no finding survives. A structure-completeness assertion pins every
// §7.2 path; an end-to-end CLI case and a gate-from-the-built-dist case prove
// the same invariant through the wired tool and through the published artifact.
// ---------------------------------------------------------------------------

const repoRoot = join(here, '..');
const tsx = join(repoRoot, 'node_modules', '.bin', 'tsx');

/**
 * Every path `init` emits, POSIX-relative, pinned to subtask 2's golden tree
 * (`git ls-files src/templates`, 30 files). A named constant so subtask 5 can
 * reuse it and so a generator that silently drops or adds a file fails here.
 */
const GENERATED_PATHS = [
  '.claude/settings.json',
  '.claude/settings.local.json',
  '.claude/skills/triage/SKILL.md',
  '.claude/skills/weekly-review/SKILL.md',
  '.githooks/pre-commit',
  '.memory/.gitkeep',
  'BOOTSTRAP.md',
  'CLAUDE.md',
  'CONVENTIONS.md',
  'EXPANSIONS.md',
  'README.md',
  'archives/README.md',
  'board/STATE.md',
  'board/registry.md',
  'channels/catch-up.md',
  'channels/inbox.md',
  'channels/l0-handoff.md',
  'channels/l1-to-l0.md',
  'channels/l1-to-l1.md',
  'channels/sync-log.md',
  'connections.md',
  'decisions/log.md',
  'identity/decision-boundary.md',
  'identity/email-workflow.md',
  'references/_template.md',
  'references/agent-roles.md',
  'references/context-architecture.md',
  'references/voice.md',
  'sync/protocol.md',
  'workspaces/.gitkeep',
].sort();

/** The committed template count PR #51 (subtask 2) shipped; a drop must fail. */
const TEMPLATE_FILE_COUNT = 30;

/**
 * `archives/` is walk-ignored by the reader (SPEC §7.2, §2.5), so its file never
 * enters the audit and never appears in `readWorkspace().tree`; it is asserted
 * on the raw fs path instead. Every other generated file is walked.
 */
const WALK_IGNORED_PATHS = new Set(['archives/README.md']);
const WALKED_PATHS = GENERATED_PATHS.filter((p) => !WALK_IGNORED_PATHS.has(p));

/** Every file on disk under `dir`, POSIX-relative, sorted (no ignore list). */
function walkDiskPaths(dir: string, root = dir): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    if (statSync(abs).isDirectory()) out.push(...walkDiskPaths(abs, root));
    else out.push(relative(root, abs).split(sep).join('/'));
  }
  return out.sort();
}

interface CliResult {
  status: number;
  stdout: string;
  stderr: string;
}

function run(bin: string, args: string[]): CliResult {
  try {
    const stdout = execFileSync(bin, args, { cwd: repoRoot, encoding: 'utf8' });
    return { status: 0, stdout, stderr: '' };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { status: e.status ?? -1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

/** Run the CLI from source through tsx (mirrors tests/cli.test.ts). */
function runFromSource(args: string[]): CliResult {
  return run(tsx, ['src/cli.ts', ...args]);
}

/** Run the built CLI through node (the gate-from-dist path). */
function runFromDist(args: string[]): CliResult {
  return run(process.execPath, ['dist/cli.js', ...args]);
}

/** Create a fresh off-repo tmp dir, run `fn` against it, always clean it up. */
function inTmp(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'icm-init-'));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('init: the pinned template tree (§7.2)', () => {
  it('ships exactly the committed golden template count (no silent drop)', () => {
    // PR #51 (subtask 2) shipped 29 files instead of 30 because a global
    // gitignore (`**/.claude/settings.local.json`) blocked `git add` while the
    // author's local on-disk audit passed. Pin the committed count so a silent
    // global-ignore drop is impossible to miss (refs #51).
    const committed = execFileSync('git', ['ls-files', 'src/templates'], {
      cwd: repoRoot,
      encoding: 'utf8',
    })
      .split('\n')
      .filter(Boolean);
    expect(committed).toHaveLength(TEMPLATE_FILE_COUNT);
  });

  it('pins GENERATED_PATHS to the on-disk template tree', () => {
    // The hardcoded pin must equal what subtask 2 actually emits; a template
    // added or removed forces a conscious update here and to the count above.
    expect(GENERATED_PATHS).toEqual([...templatePaths].sort());
    expect(GENERATED_PATHS).toHaveLength(TEMPLATE_FILE_COUNT);
  });
});

describe('init: the v1.0 audit-green gate (§7.1)', () => {
  it('generates a role-less default that audits to zero findings (in-process)', () => {
    inTmp((dir) => {
      writeWorkspace(dir);
      // No git init and no forkPoint: the tree reads off-repo (tracked: false),
      // so F7 stays silent by the reader's NO_GIT defaults (§7.8).
      const findings = audit(readWorkspace(dir));
      // On failure surface the offending file+rule so a regression is named.
      expect(findings, JSON.stringify(findings, null, 2)).toHaveLength(0);
    });
  });

  it('generates a --role example workspace that audits to zero findings', () => {
    inTmp((dir) => {
      // The minimal role adds workspaces/example/CLAUDE.md (a thin L1 charter)
      // and an empty context/ home; both must audit clean (SPEC §7.6).
      writeWorkspace(dir, { role: 'example' });
      const findings = audit(readWorkspace(dir));
      expect(findings, JSON.stringify(findings, null, 2)).toHaveLength(0);
    });
  });

  it('generates a --class devlead workspace that audits to zero findings', () => {
    inTmp((dir) => {
      // The core AC (SPEC §7.9): the synthesized delegating-lead workspace
      // (workspaces/devlead/CLAUDE.md charter + a situational context/leaf.md)
      // satisfies the §7.1 audit-green invariant. The charter is original
      // paraphrase (F8 clear), compact (F5/F1 clear), and leaf.md is
      // situational-only (W3 silent).
      writeWorkspace(dir, { class: 'devlead' });
      const findings = audit(readWorkspace(dir));
      expect(findings, JSON.stringify(findings, null, 2)).toHaveLength(0);
    });
  });

  it('the devlead charter is original paraphrase, not lifted from agent-roles (F8)', () => {
    // Fix A: pin that the charter shares no duplicate prose block with the
    // shipped references/agent-roles.md, using findDuplicateProse's real
    // signature (a DuplicationInput[] plus DuplicationOptions), not two strings.
    const files = assembleFiles({ class: 'devlead' });
    const devleadCharter = files.find(
      (f) => f.path === 'workspaces/devlead/CLAUDE.md',
    )!.content;
    const agentRolesTemplate = assembleFiles().find(
      (f) => f.path === 'references/agent-roles.md',
    )!.content;
    const pairs = findDuplicateProse(
      [
        { path: 'devlead-charter', content: devleadCharter },
        { path: 'agent-roles', content: agentRolesTemplate },
      ],
      {
        shingleSize: DEFAULT_THRESHOLDS.duplicationShingleSize,
        similarityFloor: DEFAULT_THRESHOLDS.duplicationSimilarityFloor,
        minBlockTokens: DEFAULT_THRESHOLDS.duplicationMinBlockTokens,
        countTokens: DEFAULT_TOKEN_COUNTER,
      },
    );
    expect(pairs).toEqual([]);
  });

  it('emits every SPEC §7.2 path (structure completeness)', () => {
    inTmp((dir) => {
      writeWorkspace(dir);
      const tree = readWorkspace(dir).tree;
      // Every walked path is present in the read tree and on disk...
      for (const p of WALKED_PATHS) {
        expect(tree, `missing from read tree: ${p}`).toContain(p);
        expect(existsSync(join(dir, ...p.split('/'))), `missing on disk: ${p}`).toBe(
          true,
        );
      }
      // ...and the read tree holds exactly that set: no extra, none missing.
      expect([...tree].sort()).toEqual(WALKED_PATHS);
      // archives/ is walk-ignored: on disk, but never in the tree (never audited).
      expect(tree).not.toContain('archives/README.md');
      expect(existsSync(join(dir, 'archives', 'README.md'))).toBe(true);
      // All 30 golden files land on disk (the tree omits only archives/).
      expect(walkDiskPaths(dir)).toEqual(GENERATED_PATHS);
      // identity/ ships POPULATED, not held by a .gitkeep: both files non-empty.
      for (const p of ['identity/decision-boundary.md', 'identity/email-workflow.md']) {
        expect(statSync(join(dir, ...p.split('/'))).size).toBeGreaterThan(0);
      }
    });
  });
});

describe('init: end-to-end through the CLI (§7.1)', () => {
  it('init then audit reports zero findings from source (tsx, exit 0)', () => {
    inTmp((dir) => {
      const init = runFromSource(['init', dir]);
      expect(init.status, init.stderr).toBe(0);
      const result = runFromSource(['audit', dir]);
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(result.stdout).toContain(
        'No findings: workspace is ICM-compliant against SPEC',
      );
    });
  }, 20000);

  it('a bad --role fails cleanly with exit 1 and no stack trace', () => {
    inTmp((dir) => {
      const { status, stderr } = runFromSource(['init', dir, '--role', '../evil']);
      expect(status).toBe(1);
      expect(stderr).toContain('invalid role name');
      // Clean stderr, not an unhandled InvalidRoleError stack dump (error boundary).
      expect(stderr).not.toMatch(/\n\s+at /);
    });
  }, 20000);

  it('init --class devlead then audit reports zero findings from source (exit 0)', () => {
    inTmp((dir) => {
      const init = runFromSource(['init', dir, '--class', 'devlead']);
      expect(init.status, init.stderr).toBe(0);
      const result = runFromSource(['audit', dir]);
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(result.stdout).toContain(
        'No findings: workspace is ICM-compliant against SPEC',
      );
    });
  }, 20000);

  it('an unknown --class fails cleanly with exit 1 and no stack trace', () => {
    inTmp((dir) => {
      const { status, stderr } = runFromSource(['init', dir, '--class', 'nope']);
      expect(status).toBe(1);
      expect(stderr).toContain('unknown class');
      expect(stderr).not.toMatch(/\n\s+at /);
    });
  }, 20000);

  it('--role and --class together is a usage error that writes no tree', () => {
    inTmp((dir) => {
      const { status, stderr } = runFromSource([
        'init',
        dir,
        '--role',
        'x',
        '--class',
        'devlead',
      ]);
      expect(status).toBe(1);
      expect(stderr).toContain('cannot combine --role and --class');
      expect(stderr).not.toMatch(/\n\s+at /);
      // Mutual exclusion is refused before any write: the target stays empty.
      expect(readdirSync(dir)).toEqual([]);
    });
  }, 20000);
});

describe('init: the gate from the built dist (durable packaging fix)', () => {
  it('builds, then a built CLI init+audit yields 30 files and zero findings', () => {
    // The rest of the suite runs tsx-from-source, so a dist-packaging gap (tsc
    // copies no templates) stays invisible; this case runs the BUILT CLI, so a
    // build that cannot init fails here rather than at a user's install (refs #52).
    execFileSync('npm', ['run', 'build'], { cwd: repoRoot, encoding: 'utf8' });
    inTmp((dir) => {
      const init = runFromDist(['init', dir]);
      expect(init.status, init.stderr).toBe(0);
      expect(walkDiskPaths(dir)).toEqual(GENERATED_PATHS);
      expect(walkDiskPaths(dir)).toHaveLength(TEMPLATE_FILE_COUNT);
      const result = runFromDist(['audit', dir]);
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(result.stdout).toContain(
        'No findings: workspace is ICM-compliant against SPEC',
      );
    });
  }, 120000);
});
