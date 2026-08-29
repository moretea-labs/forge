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

function projectHelper(name, source) {
  if (name === 'check-architecture-sync.sh') {
    const block = `if [[ -f "docs/architecture/current/README.md" ]]; then\n  if [[ ! -f "docs/architecture/CURRENT.md" ]]; then\n    echo "[ArchitectureSync] architecture baseline failed: missing required file docs/architecture/CURRENT.md" >&2\n    exit 1\n  fi\n\n  if ! grep -Fq "Runtime Authority" "docs/architecture/CURRENT.md"; then\n    echo "[ArchitectureSync] architecture baseline failed: docs/architecture/CURRENT.md must contain: Runtime Authority" >&2\n    exit 1\n  fi\n\n  if ! grep -Fq "Not Runtime Authority" "docs/architecture/current/README.md"; then\n    echo "[ArchitectureSync] architecture baseline failed: docs/architecture/current/README.md must contain: Not Runtime Authority" >&2\n    exit 1\n  fi\nfi\n\n`;
    return replaceExact(source, block, '', `${name}: self-host architecture baseline`);
  }
  if (name === 'ensure-task-workflow.sh' || name === 'plan-to-todo.sh') {
    return replaceExact(source, '    - bun run typecheck\n', '    - bun run check:type\n', `${name}: downstream typecheck command`);
  }
  if (name === 'migrate-project-template.sh') {
    const block = `#\n# The self-host repository invokes this script directly, so delegating to a\n# discovered copy of this same filename used to recurse. Installed helper\n# copies use an explicit source root when one is supplied, otherwise the\n# installed \`forge\` CLI.\n`;
    return replaceExact(source, block, '', `${name}: self-host recursion note`);
  }
  if (name === 'workflow-contract.ts') {
    return replaceExact(
      source,
      '  return contract.helpers.runtimeDirectory ?? contract.helpers.compatibilityDirectory ?? "scripts";\n',
      '  return contract.helpers.dir ?? "scripts";\n',
      `${name}: packaged compatibility helper directory`,
    );
  }
  return source;
}

function projectClaudeTemplate(name, source) {
  if (name === 'contract.template.md') {
    return replaceExact(source, '    - bun run typecheck\n', '    - bun run check:type\n', `${name}: downstream typecheck command`);
  }
  return source;
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
  drift = syncText(`scripts/${name}`, `assets/templates/helpers/${name}`, (source) => projectHelper(name, source)) || drift;
}
for (const name of REFERENCE_CONFIG_FILES) {
  drift = syncText(`docs/reference-configs/${name}`, `assets/reference-configs/${name}`) || drift;
}
for (const name of CLAUDE_TEMPLATE_FILES) {
  drift = syncText(`.claude/templates/${name}`, `assets/templates/${name}`, (source) => projectClaudeTemplate(name, source)) || drift;
}

if (CHECK_ONLY && drift) process.exit(1);
console.log(`[generated-authority] ${CHECK_ONLY ? 'verified' : 'synchronized'} ${HELPER_FILES.length + REFERENCE_CONFIG_FILES.length + CLAUDE_TEMPLATE_FILES.length} projections`);
