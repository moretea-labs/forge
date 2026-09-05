#!/usr/bin/env bun

import { loadScenario } from './lib/scenario.ts';
import { runPublicMcpEvaluation } from './lib/public-mcp-runner.ts';
import { runEvaluation } from './lib/runner.ts';

function usage(): string {
  return [
    'Usage: bun evaluation/run.ts --scenario <scenario.json> --output <directory> [options]',
    '',
    'Options:',
    '  --repo <path>                 Resolve scenario snapshot.source from this repository (default: cwd).',
    '  --forge-command <executable>  Forge CLI executable (default: forge).',
    '  --forge-command-arg <value>   Prefix argument for the Forge CLI; repeatable.',
    '  --keep-sandbox                Retain the isolated temporary clone for diagnosis.',
  ].join('\n');
}

interface Options {
  scenario?: string;
  output?: string;
  repo?: string;
  forgeCommand?: string;
  forgeArguments: string[];
  keepSandbox: boolean;
}

function parseArguments(argv: string[]): Options {
  const options: Options = { forgeArguments: [], keepSandbox: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (argument === '--help' || argument === '-h') {
      console.log(usage());
      process.exit(0);
    }
    if (argument === '--keep-sandbox') {
      options.keepSandbox = true;
      continue;
    }
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${argument}`);
    if (argument === '--scenario') options.scenario = value;
    else if (argument === '--output') options.output = value;
    else if (argument === '--repo') options.repo = value;
    else if (argument === '--forge-command') options.forgeCommand = value;
    else if (argument === '--forge-command-arg') options.forgeArguments.push(value);
    else throw new Error(`Unknown argument: ${argument}`);
    index += 1;
  }
  if (!options.scenario || !options.output) throw new Error('--scenario and --output are required');
  return options;
}

try {
  const options = parseArguments(process.argv.slice(2));
  const scenario = loadScenario(options.scenario!);
  const evaluationInput = {
    scenario,
    repositoryRoot: options.repo,
    outputDirectory: options.output,
    forgeCommand: options.forgeCommand
      ? { executable: options.forgeCommand, prefixArguments: options.forgeArguments }
      : undefined,
    keepSandbox: options.keepSandbox,
  };
  const report = scenario.execution.interface === 'forge_mcp'
    ? await runPublicMcpEvaluation(evaluationInput)
    : runEvaluation(evaluationInput);
  console.log(JSON.stringify({ scenario: report.scenario.id, status: report.trace.finalResult.status, output: options.output }, null, 2));
  process.exit(report.trace.finalResult.status === 'passed' ? 0 : 1);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  console.error(usage());
  process.exit(2);
}
