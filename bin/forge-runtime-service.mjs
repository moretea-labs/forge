#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const entry = join(root, 'src', 'runtime', 'root', 'service-runner-entry.ts');
const loader = join(root, 'src', 'runtime', 'shared', 'node-ts-loader.mjs');
const args = process.argv.slice(2);

function isBunExecutable() {
  // launchd runs this launcher with a minimal PATH, so bun detection must not
  // depend on `command -v bun`. Prefer the executing runtime identity instead.
  return Boolean(process.versions?.bun) || /(?:^|[/\\-])bun(?:$|[/\\]|\.exe$)/i.test(process.execPath);
}

function run(command, commandArgs) {
  const result = spawnSync(command, commandArgs, { stdio: 'inherit', env: process.env });
  if (result.error) {
    console.error(`Forge Runtime service runner failed to run ${command}: ${result.error.message}`);
    process.exit(1);
  }
  process.exit(typeof result.status === 'number' ? result.status : 1);
}

if (process.env.FORGE_FORCE_NODE !== '1' && isBunExecutable()) {
  run(process.execPath, [entry, ...args]);
}
const result = spawnSync(process.execPath, ['--loader', loader, entry, ...args], { stdio: 'inherit', env: process.env });
if (result.error) {
  console.error(`Forge Runtime service runner failed: ${result.error.message}`);
  process.exit(1);
}
process.exit(typeof result.status === 'number' ? result.status : 1);
