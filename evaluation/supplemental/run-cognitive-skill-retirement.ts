import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runCognitiveSkillRetirementEvaluation, type CognitiveSkillSource } from '../lib/cognitive-skill-retirement.ts';

function values(name: string): string[] {
  const out: string[] = [];
  for (let index = 0; index < process.argv.length; index += 1) if (process.argv[index] === name && process.argv[index + 1]) out.push(process.argv[index + 1]!);
  return out;
}
function value(name: string): string | undefined { return values(name)[0]; }

function loadSkills(entries: readonly string[]): CognitiveSkillSource[] {
  const grouped = new Map<string, { chunks: string[]; reads: number }>();
  let totalBytes = 0;
  for (const entry of entries) {
    const separator = entry.indexOf('=');
    if (separator <= 0 || separator === entry.length - 1) throw new Error('SKILL_ARGUMENT_MUST_BE_ID_EQUALS_PATH');
    const id = entry.slice(0, separator).trim();
    const path = resolve(entry.slice(separator + 1));
    const text = readFileSync(path, 'utf8');
    const bytes = Buffer.byteLength(text, 'utf8');
    if (bytes > 512 * 1024) throw new Error(`SKILL_FILE_TOO_LARGE:${id}`);
    totalBytes += bytes;
    if (totalBytes > 2 * 1024 * 1024) throw new Error('SKILL_INPUT_TOTAL_TOO_LARGE');
    const current = grouped.get(id) ?? { chunks: [], reads: 0 };
    current.chunks.push(text);
    current.reads += 1;
    grouped.set(id, current);
  }
  return [...grouped.entries()].map(([id, item]) => ({ id, text: item.chunks.join('\n'), readCount: item.reads }));
}

const controllerHomeValue = value('--controller-home');
if (!controllerHomeValue) throw new Error('--controller-home required');
const workspaceId = value('--workspace-id')?.trim();
if (!workspaceId) throw new Error('--workspace-id required');
const skillEntries = values('--skill');
if (!skillEntries.length) throw new Error('--skill id=path required');

const report = runCognitiveSkillRetirementEvaluation({
  controllerHome: resolve(controllerHomeValue),
  workspaceId,
  skillSources: loadSkills(skillEntries),
});
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
