#!/usr/bin/env node
import { chmodSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHECK_ONLY = process.argv.includes('--check');
const COMMITTED = process.env.FORGE_CHECK_SOURCE_QUALITY_MODE === 'committed';
if (COMMITTED && !CHECK_ONLY) throw new Error('[generated-authority] committed candidate supports --check only');
const candidateRef = process.env.FORGE_CHECK_CANDIDATE_SHA?.trim();
if (COMMITTED && !candidateRef) throw new Error('[generated-authority] committed check requires candidate SHA');
const candidateRevision = COMMITTED
  ? execFileSync('git', ['rev-parse', '--verify', '--end-of-options', candidateRef + '^{commit}'], {
      cwd: ROOT,
      encoding: 'utf8',
    }).trim()
  : '';
if (COMMITTED && !/^[0-9a-f]{40,64}$/.test(candidateRevision))
  throw new Error('[generated-authority] invalid candidate commit');
if (COMMITTED) console.error('[generated-authority] checking pinned candidate ' + candidateRevision.slice(0, 12));

const WORKFLOW_CONTRACT = JSON.parse(
  COMMITTED
    ? execFileSync('git', ['show', candidateRevision + ':assets/workflow-contract.v1.json'], {
        cwd: ROOT,
        encoding: 'utf8',
      })
    : readFileSync(join(ROOT, 'assets/workflow-contract.v1.json'), 'utf8'),
);
const HELPER_FILES = Array.isArray(WORKFLOW_CONTRACT?.helpers?.scripts)
  ? WORKFLOW_CONTRACT.helpers.scripts
      .filter((value) => typeof value === 'string' && value.trim())
      .map((value) => value.trim())
  : [];
if (HELPER_FILES.length === 0)
  throw new Error('[generated-authority] assets/workflow-contract.v1.json must declare helpers.scripts');

const REFERENCE_CONFIG_FILES = [
  'AGENTS.md',
  'CLAUDE.md',
  'agentic-development-flow.md',
  'ai-workflows.md',
  'changelog-versioning.md',
  'coding-standards.md',
  'development-protocol.md',
  'document-generation.md',
  'evaluator-rubric.md',
  'external-tooling.md',
  'git-strategy.md',
  'global-working-rules.md',
  'handoff-protocol.md',
  'harness-overview.md',
  'hook-operations.md',
  'release-deploy.md',
  'spa-day-protocol.md',
  'sprint-contracts.md',
  'workflow-orchestration.md',
];

const CLAUDE_TEMPLATE_FILES = [
  'contract.template.md',
  'implementation-notes.template.md',
  'plan.template.md',
  'prd.template.md',
  'research.template.md',
  'review.template.md',
  'spec.template.md',
  'sprint.template.md',
];

// Read only the committed projection inputs through one length-delimited Git
// blob batch. The canonical checkout, index and concurrent Writer edits are not inputs.
const candidateSource = new Map();
if (COMMITTED) {
  const paths = [
    'package.json',
    ...HELPER_FILES.map((name) => `scripts/${name}`),
    ...REFERENCE_CONFIG_FILES.map((name) => `docs/reference-configs/${name}`),
    ...CLAUDE_TEMPLATE_FILES.flatMap((name) => [`.claude/templates/${name}`, `assets/templates/${name}`]),
  ];
  const tree = execFileSync('git', ['ls-tree', '-r', '-z', candidateRevision], {
    cwd: ROOT,
    maxBuffer: 64 * 1024 * 1024,
  });
  const byPath = new Map();
  for (const record of tree.toString('utf8').split('\0').filter(Boolean)) {
    const match = /^(\d{6}) (blob|commit) ([a-f0-9]{40,64})\t([\s\S]+)$/.exec(record);
    if (!match) throw new Error('[generated-authority] malformed Git tree entry');
    if (match[2] === 'blob') byPath.set(match[4], { mode: match[1], oid: match[3] });
  }
  const inputs = paths.map((path) => {
    const entry = byPath.get(path);
    if (!entry || !['100644', '100755'].includes(entry.mode)) {
      throw new Error('[generated-authority] missing or nonregular committed projection: ' + path);
    }
    return { path, ...entry };
  });
  const batch = spawnSync('git', ['cat-file', '--batch'], {
    cwd: ROOT,
    input: inputs.map((entry) => entry.oid).join('\n') + '\n',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (batch.error || batch.status !== 0 || !batch.stdout) {
    throw new Error('[generated-authority] cannot load committed projection blobs');
  }
  let cursor = 0;
  for (const entry of inputs) {
    const headerEnd = batch.stdout.indexOf(10, cursor);
    if (headerEnd < 0) throw new Error('[generated-authority] truncated Git batch header');
    const header = batch.stdout.subarray(cursor, headerEnd).toString('utf8');
    const parsed = /^([a-f0-9]{40,64}) blob (\d+)$/.exec(header);
    if (!parsed || parsed[1] !== entry.oid) throw new Error('[generated-authority] unexpected Git blob header');
    const length = Number(parsed[2]);
    const start = headerEnd + 1;
    const end = start + length;
    if (!Number.isSafeInteger(length) || end >= batch.stdout.length || batch.stdout[end] !== 10) {
      throw new Error('[generated-authority] truncated Git blob');
    }
    candidateSource.set(entry.path, { content: batch.stdout.subarray(start, end), mode: parseInt(entry.mode, 8) });
    cursor = end + 1;
  }
  if (cursor !== batch.stdout.length) throw new Error('[generated-authority] unexpected Git batch trailing bytes');
}

function sourceText(path) {
  if (!COMMITTED) return readFileSync(join(ROOT, path), 'utf8');
  const entry = candidateSource.get(path);
  if (!entry) throw new Error('[generated-authority] missing committed source: ' + path);
  return entry.content.toString('utf8');
}

function sourceMode(path) {
  if (!COMMITTED) return statSync(join(ROOT, path)).mode;
  const entry = candidateSource.get(path);
  if (!entry) throw new Error('[generated-authority] missing committed source mode: ' + path);
  return entry.mode;
}

function replaceExact(text, before, after, label) {
  const first = text.indexOf(before);
  if (first < 0) throw new Error(`[generated-authority] transform precondition missing: ${label}`);
  if (text.indexOf(before, first + before.length) >= 0) {
    throw new Error(`[generated-authority] transform precondition ambiguous: ${label}`);
  }
  return `${text.slice(0, first)}${after}${text.slice(first + before.length)}`;
}

function projectClaudeTemplate(name, source) {
  if (name === 'contract.template.md') {
    return replaceExact(
      source,
      '    - bun run typecheck\n',
      '    - bun run check:type\n',
      `${name}: downstream typecheck command`,
    );
  }
  return source;
}

const PACKAGE_VERSION = JSON.parse(sourceText('package.json')).version;

function referenceConfigStub(name) {
  const docId = name.replace(/\.md$/, '');
  return `<!-- forge: reference-config-stub v1 -->
# forge Reference: ${docId}

> **Runtime Docs**: user-level forge reference
> **Doc ID**: ${docId}
> **Version**: ${PACKAGE_VERSION}
> **Source Command**: \`forge docs path ${docId}\`

This repo keeps workflow facts and runtime artifacts locally under \`.ai/\`.
The full generic runtime guide is supplied by the installed forge
package/user-level runtime so each repository does not need to refresh a full
copy of shared documentation.

Use:

\`\`\`bash
forge docs path ${docId}
forge docs show ${docId}
\`\`\`
`;
}

function shellCompatibilityWrapper(name) {
  return `#!/bin/bash\nset -euo pipefail\nSCRIPT_DIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"\nexec "$SCRIPT_DIR/lib/run-forge-helper.sh" "${name}" "$@"\n`;
}

const MODULE_HELPERS = new Set(['workflow-contract.ts', 'inspect-project-state.ts', 'migrate-workflow-docs.ts']);

function typescriptCompatibilityWrapper(name) {
  const reexport = MODULE_HELPERS.has(name)
    ? `export * from "../assets/templates/helpers/${name.replace(/\.ts$/, '')}";\n`
    : '';
  return `#!/usr/bin/env bun\n${reexport}import { runTrackedForgeHelper } from "./lib/run-forge-helper";\n\nif (import.meta.main) runTrackedForgeHelper("${name}");\n`;
}

// Git shared repositories intentionally add group-write permission to
// checked-out files (core.sharedRepository=true). Git tracks only the
// executable bit, so ignore that one local permission bit while keeping
// owner/world permissions and executable intent strict.
function comparableMode(mode) {
  return mode & 0o777 & ~0o020;
}

function syncGeneratedText(targetRel, expected, expectedMode = 0o755) {
  const targetPath = join(ROOT, targetRel);
  const actual = sourceText(targetRel);
  const actualMode = comparableMode(sourceMode(targetRel));
  const contentDrift = actual !== expected;
  const modeDrift = actualMode !== expectedMode;
  if (!contentDrift && !modeDrift) return false;
  if (CHECK_ONLY) {
    const reasons = [
      contentDrift ? 'content' : '',
      modeDrift ? `mode:${actualMode.toString(8)}!=${expectedMode.toString(8)}` : '',
    ]
      .filter(Boolean)
      .join(',');
    console.error(`[generated-authority] drift(${reasons}): ${targetRel} != generated compatibility wrapper`);
    return true;
  }
  if (contentDrift) {
    const temporary = `${targetPath}.tmp-${process.pid}`;
    writeFileSync(temporary, expected);
    chmodSync(temporary, expectedMode);
    renameSync(temporary, targetPath);
  } else {
    chmodSync(targetPath, expectedMode);
  }
  console.log(`[generated-authority] updated ${targetRel} compatibility wrapper`);
  return true;
}

function syncText(sourceRel, targetRel, transform = (value) => value) {
  const targetPath = join(ROOT, targetRel);
  const source = sourceText(sourceRel);
  const expected = transform(source);
  const actual = sourceText(targetRel);
  const expectedMode = comparableMode(sourceMode(sourceRel));
  const actualMode = comparableMode(sourceMode(targetRel));
  const contentDrift = actual !== expected;
  const modeDrift = actualMode !== expectedMode;
  if (!contentDrift && !modeDrift) return false;
  if (CHECK_ONLY) {
    const reasons = [
      contentDrift ? 'content' : '',
      modeDrift ? `mode:${actualMode.toString(8)}!=${expectedMode.toString(8)}` : '',
    ]
      .filter(Boolean)
      .join(',');
    console.error(`[generated-authority] drift(${reasons}): ${targetRel} != projection(${sourceRel})`);
    return true;
  }
  if (contentDrift) {
    const temporary = `${targetPath}.tmp-${process.pid}`;
    writeFileSync(temporary, expected);
    chmodSync(temporary, expectedMode);
    renameSync(temporary, targetPath);
  } else {
    chmodSync(targetPath, expectedMode);
  }
  console.log(`[generated-authority] updated ${targetRel} from ${sourceRel}`);
  return true;
}

let drift = false;
for (const name of HELPER_FILES) {
  const expected = name.endsWith('.sh') ? shellCompatibilityWrapper(name) : typescriptCompatibilityWrapper(name);
  drift = syncGeneratedText(`scripts/${name}`, expected) || drift;
}
for (const name of REFERENCE_CONFIG_FILES) {
  drift = syncGeneratedText(`docs/reference-configs/${name}`, referenceConfigStub(name), 0o644) || drift;
}
for (const name of CLAUDE_TEMPLATE_FILES) {
  drift =
    syncText(`.claude/templates/${name}`, `assets/templates/${name}`, (source) =>
      projectClaudeTemplate(name, source),
    ) || drift;
}

if (CHECK_ONLY && drift) process.exit(1);
console.log(
  `[generated-authority] ${CHECK_ONLY ? 'verified' : 'synchronized'} ${HELPER_FILES.length + REFERENCE_CONFIG_FILES.length + CLAUDE_TEMPLATE_FILES.length} projections`,
);
