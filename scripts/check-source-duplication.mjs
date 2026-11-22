#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

// Publication checks the exact committed Git tree. Blob object IDs already
// identify equal content, so avoid re-reading every source file (and unrelated
// Writer Dirty) merely to rediscover which blobs might be duplicates.
const committedMode = process.env.FORGE_CHECK_SOURCE_QUALITY_MODE === 'committed';
const candidateRef = process.env.FORGE_CHECK_CANDIDATE_SHA?.trim();
if (committedMode && !candidateRef) throw new Error('[source-duplication] committed mode requires candidate SHA');
const byHash = new Map();
if (committedMode) {
  const revision = execFileSync('git', ['rev-parse', '--verify', '--end-of-options', candidateRef + '^{commit}'], {
    encoding: 'utf8',
  }).trim();
  const tree = execFileSync('git', ['ls-tree', '-r', '-z', revision], { maxBuffer: 64 * 1024 * 1024 });
  for (const record of tree.toString('utf8').split('\0').filter(Boolean)) {
    const entry = /^(\d{6}) (blob|commit) ([a-f0-9]{40,64})\t([\s\S]+)$/.exec(record);
    if (!entry) throw new Error('[source-duplication] could not parse committed Git tree entry');
    const [, mode, kind, oid, path] = entry;
    if (kind !== 'blob') continue;
    // A Git symlink's blob is its target name, not the target's content.
    // Fail closed rather than silently changing the workspace check semantics.
    if (mode === '120000') throw new Error('[source-duplication] committed symlink needs content resolution: ' + path);
    const group = byHash.get(oid) ?? [];
    group.push({ path });
    byHash.set(oid, group);
  }
  // Read only repeated blob payloads, through one Git process. Starting a
  // separate git cat-file for each duplicate group costs more than the scan.
  const duplicateOids = [...byHash].filter(([, group]) => group.length > 1).map(([oid]) => oid);
  if (duplicateOids.length > 0) {
    const batch = spawnSync('git', ['cat-file', '--batch'], {
      input: duplicateOids.join('\n') + '\n',
      maxBuffer: 64 * 1024 * 1024,
    });
    if (batch.error || batch.status !== 0 || !batch.stdout) {
      throw new Error(
        '[source-duplication] could not read candidate duplicate blobs: ' +
          (batch.error?.message ?? batch.stderr?.toString() ?? batch.status),
      );
    }
    const output = batch.stdout;
    let cursor = 0;
    for (const oid of duplicateOids) {
      const headerEnd = output.indexOf(10, cursor);
      if (headerEnd < 0) throw new Error('[source-duplication] truncated Git batch header');
      const header = output.subarray(cursor, headerEnd).toString('utf8');
      const match = /^([a-f0-9]{40,64}) blob (\d+)$/.exec(header);
      if (!match || match[1] !== oid) throw new Error('[source-duplication] unexpected Git blob response: ' + header);
      const size = Number(match[2]);
      const start = headerEnd + 1;
      const end = start + size;
      if (!Number.isSafeInteger(size) || end >= output.length || output[end] !== 10) {
        throw new Error('[source-duplication] truncated or invalid Git batch blob');
      }
      cursor = end + 1;
      const content = output.subarray(start, end);
      if (content.includes(0)) {
        byHash.delete(oid);
        continue;
      }
      const lines = content.toString('utf8').split(/\r?\n/).length - 1;
      for (const entry of byHash.get(oid)) {
        entry.lines = lines;
        entry.content = content;
      }
    }
    if (cursor !== output.length) throw new Error('[source-duplication] unexpected extra Git blob data');
  }
} else {
  const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
  for (const path of files) {
    let content;
    try {
      content = readFileSync(path);
    } catch {
      continue;
    }
    if (content.includes(0)) continue;
    const hash = createHash('sha256').update(content).digest('hex');
    const group = byHash.get(hash) ?? [];
    group.push({ path, lines: content.toString('utf8').split(/\r?\n/).length - 1 });
    byHash.set(hash, group);
  }
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

function isPureBarrelReExport(paths, lines, candidateContent) {
  if (lines !== 1) return false;
  return paths.every((path) => {
    const source = (candidateContent ? candidateContent.toString('utf8') : readFileSync(path, 'utf8')).trim();
    return /^export\s+\*\s+from\s+['"]\.\/[^'"]+['"];?$/.test(source);
  });
}

const duplicateGroups = [...byHash.values()].filter((group) => group.length > 1);
const failures = [];
let classifiedGroups = 0;
let classifiedRedundantLines = 0;
for (const group of duplicateGroups) {
  const paths = group.map(({ path }) => path).sort();
  const lines = group[0].lines;
  const redundantLines = lines * (group.length - 1);
  if (
    isGeneratedTemplateProjection(paths) ||
    isGuidanceAlias(paths) ||
    isPlaceholder(paths, lines) ||
    isPureBarrelReExport(paths, lines, group[0].content)
  ) {
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

console.log(
  `[source-duplication] OK (${classifiedGroups} intentional groups, ${classifiedRedundantLines} classified redundant lines, 0 unclassified groups)`,
);
