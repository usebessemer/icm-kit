#!/usr/bin/env node
import { Command } from 'commander';

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
  .description('Check an existing workspace against the ICM spec (not yet implemented)')
  .action(() => {
    console.log('audit: not yet implemented');
    process.exit(1);
  });

program.parse();
