import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { analyzeFormalEvidence } from './posthoc-analysis.ts';

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : undefined;
}
const evidenceDir = arg('--evidence');
if (!evidenceDir) throw new Error('--evidence required');
const result = analyzeFormalEvidence({ evidenceDir: resolve(evidenceDir) });
const text = `${JSON.stringify(result, null, 2)}\n`;
const output = arg('--output');
if (output) writeFileSync(resolve(output), text);
process.stdout.write(text);
