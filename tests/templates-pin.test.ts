import { describe, it, expect } from 'vitest';
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeWorkspace } from '../src/init.js';

/**
 * Generator-output fidelity pin (subtask 5).
 *
 * init's clean output is not committed as a second tree; the generator emits it
 * from `src/templates/` at runtime (the audit and reader tests consume the
 * generated form). This pin regenerates the tree to disk and asserts
 * `writeWorkspace()` reproduces `src/templates/` exactly: the same path-set (no
 * file dropped, invented, or renamed by the generator) with LF-normalised bytes
 * (no CR survives generation).
 *
 * Scope, stated honestly: this verifies the GENERATOR, not that `src/templates/`
 * is unchanged. `writeWorkspace()` reads its bytes live from `src/templates/`, so
 * editing a template moves both sides of the comparison together and does NOT
 * redden this pin (a compliance-breaking template edit is caught instead by the
 * audit-green gate). What reddens here is a generator-logic regression: a walk
 * that skips or invents a file, a change to the emitted path-set, or a transform
 * that mangles bytes or reintroduces CRLF.
 *
 * The comparison LF-normalises the on-disk template before matching, because the
 * generator LF-normalises on read (SPEC §7.1); the separate `\r` assertion pins
 * that the emitted bytes are Unix newlines regardless of checkout.
 */

const here = dirname(fileURLToPath(import.meta.url));
const templatesDir = join(here, '..', 'src', 'templates');

/** Walk a directory into sorted POSIX-relative paths, skipping OS noise. */
function walkRel(dir: string, root = dir): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === '.DS_Store') continue;
    const abs = join(dir, entry);
    if (statSync(abs).isDirectory()) out.push(...walkRel(abs, root));
    else out.push(relative(root, abs).split(sep).join('/'));
  }
  return out.sort();
}

describe("init's golden output pins to src/templates/ (one source of truth)", () => {
  it('regenerates src/templates/ byte-for-byte, with no path added or dropped', () => {
    const dir = mkdtempSync(join(tmpdir(), 'icm-pin-'));
    try {
      writeWorkspace(dir);

      const generated = walkRel(dir);
      const templates = walkRel(templatesDir);
      // Same path set: the generator neither drops nor invents a file.
      expect(generated).toEqual(templates);
      expect(generated.length).toBeGreaterThan(0);

      // Same bytes at every path, and Unix newlines throughout.
      for (const rel of templates) {
        const parts = rel.split('/');
        const onDisk = readFileSync(join(templatesDir, ...parts), 'utf8').replace(
          /\r\n/g,
          '\n',
        );
        const written = readFileSync(join(dir, ...parts), 'utf8');
        expect(written, `byte drift at ${rel}`).toBe(onDisk);
        expect(written.includes('\r'), `stray CR at ${rel}`).toBe(false);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
