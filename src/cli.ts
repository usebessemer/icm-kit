#!/usr/bin/env node
import { resolve } from 'node:path';
import { Command } from 'commander';
import { audit } from './audit.js';
import { readWorkspace } from './workspace.js';
import { SPEC_VERSION } from './model.js';
import type { Finding } from './model.js';

const program = new Command();

program
  .name('icm-kit')
  .description('Tooling for the Interpretable Context Methodology')
  .version('0.16.0');

program
  .command('init')
  .description('Scaffold a new ICM-compliant workspace (not yet implemented)')
  .action(() => {
    console.log('init: not yet implemented');
    process.exit(1);
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
