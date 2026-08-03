#!/usr/bin/env bun
import { resolve } from 'path';
import { exportRequirementPortfolio } from '../src/cli/controller/requirement-portfolio-export';
import { resolveRepoPreferredControllerHome } from '../src/cli/repositories/controller-home';

function valueAfter(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

try {
  const args = process.argv.slice(2);
  const repoRoot = resolve(valueAfter(args, '--repo') ?? process.cwd());
  const repoId = valueAfter(args, '--repo-id')?.trim();
  const outputDir = valueAfter(args, '--output');
  if (!repoId) throw new Error('--repo-id is required');
  if (!outputDir) throw new Error('--output is required');
  const manifest = exportRequirementPortfolio({
    controllerHome: resolveRepoPreferredControllerHome(repoRoot, valueAfter(args, '--controller-home')),
    repoId,
    repoRoot,
    outputDir: resolve(outputDir),
  });
  console.log(JSON.stringify(manifest, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
