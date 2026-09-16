import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runAdaptiveExperiment, type AdaptiveCandidate } from './adaptive-workflow.ts';

function arg(name: string): string | undefined { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : undefined; }
const experimentPath = resolve(arg('--experiment') ?? '');
if (!experimentPath || experimentPath === resolve('')) throw new Error('--experiment required');
const formal = JSON.parse(readFileSync(experimentPath, 'utf8')) as { candidates: [AdaptiveCandidate, AdaptiveCandidate] };
const repetitions = Number(arg('--repetitions') ?? '3');
const result = await runAdaptiveExperiment({ sourceRoot: process.cwd(), candidates: formal.candidates, repetitions });
const text = `${JSON.stringify(result, null, 2)}\n`;
const output = arg('--output'); if (output) writeFileSync(resolve(output), text); process.stdout.write(text);
