// Copy the authored golden template tree into `dist/` so a built or published
// CLI can resolve it. `tsc` emits only compiled `.ts`; the SPEC §7.2 template
// bytes under `src/templates/` are non-`.ts` (Markdown, `.gitkeep`, `.json`,
// the pre-commit hook) and are never emitted by the compiler, so without this
// step `node dist/cli.js init` fails: `src/init.ts` resolves its templates
// relative to `import.meta.url`, which from `dist/init.js` points at
// `dist/templates/`, a directory `tsc` never creates. This runs after `tsc`
// in the `build` script and mirrors the reader's `.DS_Store` ignore.
import { cpSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(repoRoot, 'src', 'templates');
const dest = join(repoRoot, 'dist', 'templates');

// Replace, don't merge: a template removed from source must not linger in dist.
rmSync(dest, { recursive: true, force: true });
cpSync(src, dest, {
  recursive: true,
  // Never ship OS noise; matches the generator's TEMPLATE_IGNORED_NAMES.
  filter: (source) => basename(source) !== '.DS_Store',
});
console.log(`Copied ${src} -> ${dest}`);
