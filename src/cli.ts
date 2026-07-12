#!/usr/bin/env node
import { resolve } from 'node:path';
import { Command } from 'commander';
import { audit } from './audit.js';
import { readWorkspace } from './workspace.js';
import { InvalidRoleError, NonEmptyTargetError, writeWorkspace } from './init.js';
import { SPEC_VERSION } from './model.js';
import type { Finding } from './model.js';

const program = new Command();

program
  .name('icm-kit')
  .description('Tooling for the Interpretable Context Methodology')
  .version('0.19.0');

program
  .command('init')
  .description('Scaffold a new ICM-compliant workspace')
  .argument('[target]', 'directory to scaffold into', '.')
  .option('--overwrite', 'write into a non-empty target instead of refusing it')
  .option('--role <name>', 'also scaffold a minimal L1 role workspace (§7.6)')
  .action((target: string, options: { overwrite?: boolean; role?: string }) => {
    const root = resolve(target);
    try {
      const written = writeWorkspace(root, {
        overwrite: options.overwrite,
        role: options.role,
      });
      console.log(`Scaffolded ${written.length} file(s) into ${root}.`);
      const roleNote = options.role ? ` with role "${options.role}"` : '';
      console.log(`ICM-compliant workspace ready${roleNote}. Run icm-kit audit to verify.`);
    } catch (err) {
      // Every init failure is user-facing, not a crash: report it on stderr and
      // set a non-zero exit code rather than surface an unhandled stack trace.
      if (err instanceof NonEmptyTargetError || err instanceof InvalidRoleError) {
        // Known user errors: the message is already actionable as-is.
        console.error(`init: ${err.message}`);
      } else {
        // Anything else (e.g. a template-resolution failure from a build that
        // never copied dist/templates) still fails cleanly rather than dumping a
        // trace; flag it as unexpected so it is not mistaken for a user mistake.
        const message = err instanceof Error ? err.message : String(err);
        console.error(`init failed: ${message}`);
      }
      process.exitCode = 1;
    }
  });

program
  .command('audit')
  .description('Check an existing workspace against the ICM spec')
  .argument('[path]', 'workspace root to audit', '.')
  .option(
    '--ignore <names>',
    'comma-separated file/dir names to skip, merged with the defaults',
  )
  .option(
    '--fork-point <ref>',
    'git commit marking the fork/import boundary for KIT_BOILERPLATE (F7); defaults to the repository root commit',
  )
  .action((path: string, options: { ignore?: string; forkPoint?: string }) => {
    const ignore = options.ignore
      ? options.ignore
          .split(',')
          .map((name) => name.trim())
          .filter(Boolean)
      : undefined;
    const findings = audit(
      readWorkspace(resolve(path), { ignore, forkPoint: options.forkPoint }),
    );
    report(findings);
    // Output and exit policy are the tool's concern (SPEC §5): a clean
    // workspace exits 0, any finding exits non-zero so checks can gate on it.
    if (findings.length > 0) process.exitCode = 1;
  });

function report(findings: readonly Finding[]): void {
  if (findings.length === 0) {
    console.log(`No findings: workspace is ICM-compliant against SPEC ${SPEC_VERSION}.`);
    return;
  }
  for (const f of findings) {
    const related = f.relatedRule ? ` (enforces ${f.relatedRule})` : '';
    console.log(`${f.severity}  ${f.rule}${related}  ${f.path}`);
    console.log(`    ${f.message}`);
  }
  console.log(`\n${findings.length} finding(s).`);
}

program.parse();
