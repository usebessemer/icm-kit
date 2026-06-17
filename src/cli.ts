#!/usr/bin/env node
import { resolve } from 'node:path';
import { Command } from 'commander';
import { audit } from './audit.js';
import { readWorkspace } from './workspace.js';
import type { Finding } from './model.js';

const program = new Command();

program
  .name('icm-kit')
  .description('Tooling for the Interpretable Context Methodology')
  .version('0.1.0');

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
  .action((path: string) => {
    const findings = audit(readWorkspace(resolve(path)));
    report(findings);
    // v0.1 output and exit policy are the tool's concern (SPEC §5): a clean
    // workspace exits 0, any finding exits non-zero so checks can gate on it.
    if (findings.length > 0) process.exitCode = 1;
  });

function report(findings: readonly Finding[]): void {
  if (findings.length === 0) {
    console.log('No findings: workspace is ICM-compliant against SPEC v0.2.');
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
