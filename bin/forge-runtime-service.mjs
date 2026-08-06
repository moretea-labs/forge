#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const entry = join(root, 'src', 'runtime', 'root', 'service-runner-entry.ts');
const loader = join(root, 'src', 'runtime', 'shared', 'node-ts-loader.mjs');
const result = spawnSync(process.execPath, ['--loader', loader, entry, ...process.argv.slice(2)], { stdio: 'inherit', env: process.env });
if (result.error) {
  console.error(`Forge Runtime service runner failed: ${result.error.message}`);
  process.exit(1);
}
process.exit(typeof result.status === 'number' ? result.status : 1);
