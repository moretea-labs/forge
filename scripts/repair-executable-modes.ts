import { resolve } from 'path';
import { fileURLToPath } from 'url';
import { repairExecutableModes } from '../src/cli/editing/executable-modes';

const checkOnly = process.argv.includes('--check');
const result = repairExecutableModes(resolve(fileURLToPath(new URL('..', import.meta.url))), checkOnly);
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (checkOnly && result.missingExecutable.length > 0) process.exitCode = 1;
