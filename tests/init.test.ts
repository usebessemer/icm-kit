import { describe, it, expect } from 'vitest';
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
  writeWorkspace,
  type GeneratedFile,
} from '../src/init.js';

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
    const paths = pathsOf(assembleFiles('example'));
    expect(paths).toContain('workspaces/example/CLAUDE.md');
    expect(paths).toContain('workspaces/example/context/.gitkeep');
    expect(paths).not.toContain('workspaces/.gitkeep');
    // No pre-built references/ or .claude/skills/ level for the role (§7.6).
    expect(paths.some((p) => p.startsWith('workspaces/example/references/'))).toBe(false);
    expect(paths.some((p) => p.startsWith('workspaces/example/.claude/'))).toBe(false);
  });

  it('writes a non-empty charter naming the role', () => {
    const charter = assembleFiles('example').find(
      (f) => f.path === 'workspaces/example/CLAUDE.md',
    );
    expect(charter?.content).toContain('# The example role');
    expect(charter?.content.includes('\r')).toBe(false);
  });

  it('rejects a role name that is not a single safe path segment', () => {
    for (const bad of ['..', '.', '', 'a/b', 'a\\b', '../evil']) {
      expect(() => assembleFiles(bad)).toThrow(InvalidRoleError);
    }
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
