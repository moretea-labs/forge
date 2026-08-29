#!/usr/bin/env node
import { chmodSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHECK_ONLY = process.argv.includes('--check');

const WORKFLOW_CONTRACT = JSON.parse(readFileSync(join(ROOT, 'assets/workflow-contract.v1.json'), 'utf8'));
const HELPER_FILES = Array.isArray(WORKFLOW_CONTRACT?.helpers?.scripts)
  ? WORKFLOW_CONTRACT.helpers.scripts.filter((value) => typeof value === 'string' && value.trim()).map((value) => value.trim())
  : [];
if (HELPER_FILES.length === 0) throw new Error('[generated-authority] assets/workflow-contract.v1.json must declare helpers.scripts');

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
    return replaceExact(source, '    - bun run typecheck\n', '    - bun run check:type\n', `${name}: downstream typecheck command`);
  }
  return source;
}

const PACKAGE_VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;

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

const MODULE_HELPERS = new Set([
  'check-skill-version.ts',
  'workflow-contract.ts',
  'inspect-project-state.ts',
  'migrate-workflow-docs.ts',
]);

function typescriptCompatibilityWrapper(name) {
  const reexport = MODULE_HELPERS.has(name)
    ? `export * from "../assets/templates/helpers/${name.replace(/\.ts$/, '')}";\n`
    : '';
  return `#!/usr/bin/env bun\n${reexport}import { runTrackedForgeHelper } from "./lib/run-forge-helper";\n\nif (import.meta.main) runTrackedForgeHelper("${name}");\n`;
}

function syncGeneratedText(targetRel, expected, expectedMode = 0o755) {
  const targetPath = join(ROOT, targetRel);
  const actual = readFileSync(targetPath, 'utf8');
  const actualMode = statSync(targetPath).mode & 0o777;
  const contentDrift = actual !== expected;
  const modeDrift = actualMode !== expectedMode;
  if (!contentDrift && !modeDrift) return false;
  if (CHECK_ONLY) {
    const reasons = [contentDrift ? 'content' : '', modeDrift ? `mode:${actualMode.toString(8)}!=${expectedMode.toString(8)}` : ''].filter(Boolean).join(',');
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
  const sourcePath = join(ROOT, sourceRel);
  const targetPath = join(ROOT, targetRel);
  const source = readFileSync(sourcePath, 'utf8');
  const expected = transform(source);
  const actual = readFileSync(targetPath, 'utf8');
  const expectedMode = statSync(sourcePath).mode & 0o777;
  const actualMode = statSync(targetPath).mode & 0o777;
  const contentDrift = actual !== expected;
  const modeDrift = actualMode !== expectedMode;
  if (!contentDrift && !modeDrift) return false;
  if (CHECK_ONLY) {
    const reasons = [contentDrift ? 'content' : '', modeDrift ? `mode:${actualMode.toString(8)}!=${expectedMode.toString(8)}` : ''].filter(Boolean).join(',');
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
  const expected = name.endsWith('.sh')
    ? shellCompatibilityWrapper(name)
    : typescriptCompatibilityWrapper(name);
  drift = syncGeneratedText(`scripts/${name}`, expected) || drift;
}
for (const name of REFERENCE_CONFIG_FILES) {
  drift = syncGeneratedText(`docs/reference-configs/${name}`, referenceConfigStub(name), 0o644) || drift;
}
for (const name of CLAUDE_TEMPLATE_FILES) {
  drift = syncText(`.claude/templates/${name}`, `assets/templates/${name}`, (source) => projectClaudeTemplate(name, source)) || drift;
}

if (CHECK_ONLY && drift) process.exit(1);
console.log(`[generated-authority] ${CHECK_ONLY ? 'verified' : 'synchronized'} ${HELPER_FILES.length + REFERENCE_CONFIG_FILES.length + CLAUDE_TEMPLATE_FILES.length} projections`);
