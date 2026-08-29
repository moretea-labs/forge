#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
const byHash = new Map();

for (const path of files) {
  let content;
  try { content = readFileSync(path); }
  catch { continue; }
  if (content.includes(0)) continue;
  const hash = createHash('sha256').update(content).digest('hex');
  const group = byHash.get(hash) ?? [];
  group.push({ path, lines: content.toString('utf8').split(/\r?\n/).length - 1 });
  byHash.set(hash, group);
}

function isGeneratedTemplateProjection(paths) {
  if (paths.length !== 2) return false;
  const claude = paths.find((path) => path.startsWith('.claude/templates/'));
  const asset = paths.find((path) => path.startsWith('assets/templates/'));
  return Boolean(claude && asset && basename(claude) === basename(asset) && claude.endsWith('.template.md'));
}

function isGuidanceAlias(paths) {
  return paths.every((path) => ['AGENTS.md', 'CLAUDE.md'].includes(basename(path)));
}

function isPlaceholder(paths, lines) {
  return lines <= 1 && paths.every((path) => path.endsWith('/.gitkeep'));
}

const duplicateGroups = [...byHash.values()].filter((group) => group.length > 1);
const failures = [];
let classifiedGroups = 0;
let classifiedRedundantLines = 0;
for (const group of duplicateGroups) {
  const paths = group.map(({ path }) => path).sort();
  const lines = group[0].lines;
  const redundantLines = lines * (group.length - 1);
  if (isGeneratedTemplateProjection(paths) || isGuidanceAlias(paths) || isPlaceholder(paths, lines)) {
    classifiedGroups += 1;
    classifiedRedundantLines += redundantLines;
    continue;
  }
  failures.push({ paths, lines, redundantLines });
}

if (failures.length) {
  console.error('[source-duplication] FAILED');
  for (const failure of failures) {
    console.error(`- unclassified exact duplicate (${failure.lines} lines each, ${failure.redundantLines} redundant):`);
    for (const path of failure.paths) console.error(`  - ${path}`);
  }
  process.exit(1);
}

console.log(`[source-duplication] OK (${classifiedGroups} intentional groups, ${classifiedRedundantLines} classified redundant lines, 0 unclassified groups)`);
