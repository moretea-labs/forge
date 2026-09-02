#!/usr/bin/env node
import { readFileSync, existsSync, lstatSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, extname, normalize, resolve } from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname);
const failures = [];
function text(path) {
  const absolute = resolve(root, path);
  if (!existsSync(absolute)) {
    failures.push(`missing required architecture file: ${path}`);
    return '';
  }
  return readFileSync(absolute, 'utf8');
}
function requireText(path, needle) {
  if (!text(path).includes(needle)) failures.push(`${path} must contain ${JSON.stringify(needle)}`);
}
function hasFilesystemContent(path) {
  const absolute = resolve(root, path);
  if (!existsSync(absolute)) return false;
  if (!lstatSync(absolute).isDirectory()) return true;
  return readdirSync(absolute, { withFileTypes: true }).some((entry) =>
    entry.isDirectory() ? hasFilesystemContent(`${path}/${entry.name}`) : true,
  );
}
function requireMissing(path) {
  if (hasFilesystemContent(path)) failures.push(`${path} must be deleted`);
}
function requireMatch(path, expression, description) {
  if (!expression.test(text(path))) failures.push(`${path} must ${description}`);
}
function forbid(path, expression, description) {
  if (expression.test(text(path))) failures.push(`${path} violates ${description}`);
}
function forbidBetween(path, startNeedle, endNeedle, expression, description) {
  const source = text(path);
  const start = source.indexOf(startNeedle);
  const end = start >= 0 ? source.indexOf(endNeedle, start + startNeedle.length) : -1;
  if (start < 0 || end < 0) {
    failures.push(`${path} must expose the checked architecture region for ${description}`);
    return;
  }
  if (expression.test(source.slice(start, end))) failures.push(`${path} violates ${description}`);
}
function sourceFiles(directory) {
  const absolute = resolve(root, directory);
  if (!existsSync(absolute)) return [];
  const files = [];
  for (const entry of readdirSync(absolute, { withFileTypes: true })) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) files.push(...sourceFiles(path));
    else if (entry.isFile() && path.endsWith('.ts')) files.push(path);
  }
  return files;
}

function productionTypeScriptFiles() {
  return [
    ...sourceFiles('src'),
    ...sourceFiles('packages'),
    ...sourceFiles('adapters'),
    ...sourceFiles('apps'),
    ...sourceFiles('plugins'),
  ].sort();
}

function staticTypeScriptDependencyGraph(files) {
  let ts;
  try {
    ts = createRequire(import.meta.url)('typescript');
  } catch (error) {
    failures.push(`TypeScript dependency is required for architecture import-cycle analysis: ${error instanceof Error ? error.message : String(error)}`);
    return new Map();
  }

  const orderedFiles = [...files].sort();
  const known = new Set(orderedFiles);
  const graph = new Map(orderedFiles.map((path) => [path, new Set()]));

  function resolveTypeScriptImport(fromPath, specifier) {
    if (!specifier.startsWith('.')) return undefined;
    const base = normalize(`${dirname(fromPath)}/${specifier}`).replaceAll('\\', '/');
    const extension = extname(base);
    const withoutRuntimeExtension = ['.js', '.mjs', '.cjs'].includes(extension)
      ? base.slice(0, -extension.length)
      : base;
    const candidates = extension === '.ts'
      ? [base]
      : [withoutRuntimeExtension, `${withoutRuntimeExtension}.ts`, `${withoutRuntimeExtension}/index.ts`];
    return candidates.find((candidate) => known.has(candidate));
  }

  for (const path of orderedFiles) {
    const sourceFile = ts.createSourceFile(path, text(path), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    for (const statement of sourceFile.statements) {
      let specifier;
      if ((ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement))
          && statement.moduleSpecifier
          && ts.isStringLiteralLike(statement.moduleSpecifier)) {
        specifier = statement.moduleSpecifier.text;
      } else if (ts.isImportEqualsDeclaration(statement)
          && ts.isExternalModuleReference(statement.moduleReference)
          && statement.moduleReference.expression
          && ts.isStringLiteralLike(statement.moduleReference.expression)) {
        specifier = statement.moduleReference.expression.text;
      }
      if (!specifier) continue;
      const target = resolveTypeScriptImport(path, specifier);
      if (target) graph.get(path).add(target);
    }
  }
  return graph;
}

function relativeStaticTypeScriptDependencyGraph(directory = 'src') {
  return staticTypeScriptDependencyGraph(sourceFiles(directory));
}

function productionStaticTypeScriptDependencyGraph() {
  return staticTypeScriptDependencyGraph(productionTypeScriptFiles());
}

function dependencyEdges(graph) {
  const edges = [];
  for (const [from, targets] of graph) {
    for (const to of targets) edges.push(`${from} -> ${to}`);
  }
  return edges.sort();
}

function edgeSet(graph, predicate) {
  return new Set(dependencyEdges(graph).filter((edge) => predicate(edge)));
}

function edgeParts(edge) {
  const separator = edge.indexOf(' -> ');
  return { from: edge.slice(0, separator), to: edge.slice(separator + 4) };
}

function architectureRoot(path) {
  if (path.startsWith('packages/kernel/')) return path.split('/').slice(0, 3).join('/');
  if (path.startsWith('adapters/')) return path.split('/').slice(0, 2).join('/');
  if (path.startsWith('apps/')) return path.split('/').slice(0, 2).join('/');
  if (path.startsWith('plugins/')) return path.split('/').slice(0, 2).join('/');
  if (path.startsWith('src/runtime/root/')) return 'src/runtime/root';
  return path.startsWith('src/') ? 'src' : path.split('/')[0];
}

function requireExactShrinkingDebt(label, actual, allowed) {
  for (const edge of actual) {
    if (!allowed.has(edge)) failures.push(`${label} introduced forbidden dependency: ${edge}`);
  }
  for (const edge of allowed) {
    if (!actual.has(edge)) failures.push(`${label} allowlist contains retired dependency; remove it so the debt ledger only shrinks: ${edge}`);
  }
}

// Kernel V2 B7 graph analysis. Legacy boundary debt below is exact and must only shrink.
// Inventory is derived from the production graph before the gate is activated.
function stronglyConnectedComponents(graph) {
  let index = 0;
  const indices = new Map();
  const lowLinks = new Map();
  const stack = [];
  const onStack = new Set();
  const components = [];

  function visit(node) {
    indices.set(node, index);
    lowLinks.set(node, index);
    index += 1;
    stack.push(node);
    onStack.add(node);

    for (const target of graph.get(node) ?? []) {
      if (!indices.has(target)) {
        visit(target);
        lowLinks.set(node, Math.min(lowLinks.get(node), lowLinks.get(target)));
      } else if (onStack.has(target)) {
        lowLinks.set(node, Math.min(lowLinks.get(node), indices.get(target)));
      }
    }

    if (lowLinks.get(node) !== indices.get(node)) return;
    const component = [];
    while (stack.length) {
      const member = stack.pop();
      onStack.delete(member);
      component.push(member);
      if (member === node) break;
    }
    components.push(component.sort());
  }

  for (const node of [...graph.keys()].sort()) {
    if (!indices.has(node)) visit(node);
  }
  return components;
}

function requireAcyclicProductionTypeScript() {
  const graph = productionStaticTypeScriptDependencyGraph();
  const cyclic = stronglyConnectedComponents(graph).filter((component) =>
    component.length > 1 || (component.length === 1 && graph.get(component[0])?.has(component[0])),
  );
  for (const component of cyclic) {
    failures.push(`production TypeScript import cycle: ${component.join(' -> ')}`);
  }
}

const allowedArchitectureRootMarkdown = new Set(['CURRENT.md', 'EVOLUTION.md', 'history.md', 'index.md']);
const architectureRootMarkdown = readdirSync(resolve(root, 'docs/architecture'), { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
  .map((entry) => entry.name)
  .sort();
for (const name of architectureRootMarkdown) {
  if (!allowedArchitectureRootMarkdown.has(name)) {
    failures.push(`docs/architecture/${name} must be archived under docs/architecture/history/ instead of acting as parallel root architecture authority`);
  }
}

for (const path of ['README.md', 'docs/ROADMAP.md', 'docs/architecture/CURRENT.md', 'docs/architecture/index.md']) {
  forbid(path, /\/Users\//, 'maintained documentation must not contain personal absolute macOS paths');
  forbid(path, /\bRepo Harness\b/i, 'maintained documentation must use the current Forge product identity');
  forbid(path, /(?:^|\n)\s*(?:>\s*)?(?:\*\*)?Status(?:\*\*)?\s*:\s*[^\n]*(?:implementation in progress|Phase\s+\d+)/i, 'maintained documentation must not carry transient execution status; use Plan/Work/evidence or history');
}

const required = [
  'adapters/mcp/runtime-gateway/router.ts',
  'src/cli/agent-jobs/executable-resolver.ts',
  'src/runtime/control-plane/global-scheduler/scheduler.ts',
  'src/runtime/control-plane/global-scheduler/config.ts',
  'src/runtime/control-plane/global-scheduler/state.ts',
  'src/runtime/control-plane/global-scheduler/worker-launch.ts',
  'src/runtime/control-plane/global-scheduler/dispatch-capacity.ts',
  'src/runtime/control-plane/global-scheduler/projection-refresh.ts',
  'src/runtime/control-plane/global-scheduler/worker-lifecycle.ts',
  'src/runtime/control-plane/global-scheduler/worker-stderr.ts',
  'src/runtime/control-plane/global-scheduler/worker-attachment.ts',
  'src/runtime/control-plane/global-scheduler/worker-lifecycle-store.ts',
  'src/runtime/control-plane/global-scheduler/maintenance.ts',
  'src/runtime/control-plane/global-scheduler/source-scan.ts',
  'src/runtime/control-plane/global-scheduler/durable-admission.ts',
  'src/runtime/control-plane/global-scheduler/worker-exit-decision.ts',
  'src/runtime/control-plane/global-scheduler/worker-exit-reconciler.ts',
  'src/runtime/control-plane/global-scheduler/worker-process.ts',
  'src/runtime/control-plane/repo-actor/actor.ts',
  'src/runtime/execution/jobs/store.ts',
  'src/runtime/execution/jobs/timeouts.ts',
  'src/runtime/execution/jobs/receipt-store.ts',
  'src/runtime/execution/workers/worker-entry.ts',
  'src/runtime/execution/thin-harness/index.ts',
  'src/runtime/execution/thin-harness/execution-router.ts',
  'src/runtime/control-plane/routing/route-policy.ts',
  'src/runtime/control-plane/routing/workspace-admission.ts',
  'src/runtime/control-plane/facade/requirement-authority.ts',
  'src/runtime/control-plane/facade/repository-work-admission.ts',
  'src/runtime/control-plane/execution/retained-work-resume.ts',
  'src/runtime/control-plane/execution/work-handle-authority.ts',
  'src/runtime/control-plane/execution/work-verification-context.ts',
  'src/runtime/control-plane/execution/work-verification-service.ts',
  'src/runtime/control-plane/execution/implementation-review-content.ts',
  'packages/kernel/work/domain/implementation-review.ts',
  'packages/kernel/work/domain/state-machine.ts',
  'packages/kernel/work/domain/types.ts',
  'packages/kernel/work/application/work-service.ts',
  'packages/kernel/work/ports/work-contract-store.ts',
  'packages/kernel/work/infrastructure/work-contract-store.ts',
  'packages/kernel/work/api/index.ts',
  'packages/kernel/controller/domain/types.ts',
  'packages/kernel/controller/ports/controller-host.ts',
  'packages/kernel/controller/infrastructure/controller-session-store.ts',
  'packages/kernel/controller/application/controller-service.ts',
  'packages/kernel/controller/api/index.ts',
  'src/runtime/control-plane/facade/work-implementation-review.ts',
  'src/runtime/control-plane/execution/repository-work-attribution.ts',
  'src/runtime/control-plane/execution/work-completion-authority.ts',
  'src/runtime/control-plane/execution/work-evidence-policy.ts',
  'src/runtime/control-plane/execution/work-execution-support.ts',
  'src/runtime/control-plane/execution/work-finalization-service.ts',
  'src/runtime/control-plane/execution/work-preparation-service.ts',
  'src/runtime/control-plane/execution/work-operation-service.ts',
  'src/runtime/control-plane/facade/work-state-machine.ts',
  'src/runtime/evidence/process-check-execution.ts',
  'src/runtime/context/semantic-navigation-contract.ts',
  'packages/protocols/mcp/tool-contract.ts',
  'packages/protocols/mcp/execution-context.ts',
  'src/cli/github/contracts.ts',
  'adapters/mcp/runtime-gateway/runtime-tool-definitions.ts',
  'adapters/mcp/server.ts',
  'adapters/mcp/oauth.ts',
  'adapters/mcp/multi-repository.ts',
  'adapters/mcp/toolset.ts',
  'adapters/mcp/tool-mapping/tools.ts',
  'adapters/mcp/tool-mapping/legacy-tool-service.ts',
  'adapters/mcp/tool-mapping/repository-tools.ts',
  'adapters/mcp/tool-mapping/access-tools.ts',
  'adapters/mcp/transports/http.ts',
  'adapters/mcp/transports/stdio.ts',
  'adapters/mcp/transports/session-registry.ts',
  'docs/architecture/CURRENT.md',
  'src/runtime/resources/leases/store.ts',
  'src/runtime/evidence/event-ledger.ts',
  'src/runtime/evidence/evidence-store.ts',
  'src/runtime/evidence/artifact-store.ts',
  'src/runtime/projections/materialized-view.ts',
  'src/runtime/projections/git-status-sampler.ts',
  'src/runtime/projections/controller-context.ts',
  'src/runtime/projections/invalidation.ts',
  'src/runtime/workflow/schedules/engine.ts',
  'src/runtime/workflow/schedules/work-continuation.ts',
  'scripts/smoke-runtime-recovery.ts',
  'scripts/smoke-schedule-engine.ts',
  'src/runtime/release/release-gate.ts',
  'src/runtime/root/runtime.ts',
  'src/runtime/root/readiness.ts',
  'src/runtime/root/types.ts',
  'src/runtime/root/status.ts',
  'src/runtime/root/release-manifest.ts',
  'src/runtime/root/service.ts',
  'src/runtime/root/service-runner.ts',
  'src/runtime/standalone-recovery/core.ts',
  'src/runtime/standalone-recovery/entry.ts',
  'src/cli/commands/init-hook.ts',
  'src/cli/commands/runtime.ts',
  'src/cli/index.ts',
];
for (const path of required) text(path);
requireAcyclicProductionTypeScript();
for (const path of sourceFiles('src/runtime/control-plane')) {
  forbid(path, /(?:from\s+['"]|import\s*\(\s*['"])(?:\.\.\/)+gateway\//, 'control-plane domain/application code must not depend on Gateway transport');
}
requireText('src/runtime/control-plane/routing/route-policy.ts', "export function decideRoute");
requireText('src/runtime/control-plane/routing/route-policy.ts', 'inputFingerprint');
requireText('src/runtime/control-plane/routing/route-policy.ts', 'policyVersion');
requireText('src/runtime/control-plane/execution/work-verification-service.ts', 'runPersistedCheckViaProcessRuntime({');
requireText('src/runtime/control-plane/execution/work-verification-service.ts', 'interactiveWaitMs: input.interactiveWaitMs ?? 0');
requireText('src/runtime/control-plane/execution/work-verification-service.ts', 'checkContentRevision');
requireText('src/runtime/control-plane/execution/work-verification-service.ts', 'observedGitHead');
requireText('adapters/mcp/runtime-gateway/runtime-tools.ts', 'executeWorkVerification({');
requireText('src/cli/local-bridge/facade-api.ts', 'executeWorkVerification({');
forbid(
  'src/cli/local-bridge/facade-api.ts',
  /runControllerCheck\s*\(/,
  'Local Bridge Work verification must use the canonical persisted Work verification service',
);
forbid(
  'adapters/mcp/runtime-gateway/runtime-tools.ts',
  /function\s+classifyTerminalCheckEvidence\s*\(/,
  'terminal Check evidence classification belongs to Process Runtime, not the Gateway transport',
);
forbid(
  'src/runtime/control-plane/execution/work-verification-service.ts',
  /runControllerCheck\s*\(/,
  'route Work verification through persisted Process Runtime instead of synchronous check execution',
);


// Kernel V2 B1/B2: Work lifecycle/review authority lives in packages/kernel/work.
// Historical facade modules are compatibility-only re-exports. Gateway/finalizer
// consume the Kernel API/domain instead of owning a parallel policy/store.
requireText('packages/kernel/work/domain/implementation-review.ts', 'assertImplementationReviewPreDeliveryBoundary');
requireText('packages/kernel/work/domain/implementation-review.ts', 'deriveImplementationReviewAcrossCommit');
requireText('packages/kernel/work/domain/state-machine.ts', 'validateWorkSemanticTransition');
requireText('packages/kernel/work/application/work-service.ts', 'transitionWorkContractPhase');
requireText('packages/kernel/work/api/index.ts', "export * from '../application/work-service'");
requireText('src/runtime/control-plane/execution/implementation-review-content.ts', 'implementationReviewContentFingerprint');
requireText('src/runtime/control-plane/execution/implementation-review-content.ts', 'implementationReviewIndexFingerprint');
requireText('packages/kernel/work/infrastructure/work-contract-store.ts', 'requestWorkImplementationReview');
requireText('packages/kernel/work/infrastructure/work-contract-store.ts', 'recordWorkImplementationReview');
requireText('src/runtime/control-plane/facade/work-contract-store.ts', '@deprecated Kernel V2 compatibility shim');
requireText('src/runtime/control-plane/facade/work-state-machine.ts', '@deprecated Kernel V2 compatibility shim');
requireText('src/runtime/control-plane/facade/work-implementation-review.ts', '@deprecated Kernel V2 compatibility shim');
requireText('packages/kernel/work/domain/types.ts', "['implementation', 'verification', 'review', 'delivery', 'cleanup']");
requireText('src/cli/repositories/selected-path-actions.ts', 'beforeCommitGuard');
requireText('src/runtime/control-plane/execution/direct-edit-work-completion.ts', 'prepareReviewedDirectEditWorkCommit');
requireText('src/runtime/control-plane/execution/direct-edit-work-completion.ts', 'completeReviewedDirectEditWorkAfterCommit');
requireText('src/runtime/control-plane/execution/work-verification-service.ts', 'transferWorkVerificationAcrossContentEquivalentCommit');
requireText('src/runtime/control-plane/execution/edit-validation-coordinator.ts', 'workId: session.workId');
requireText('src/runtime/control-plane/execution/edit-validation-coordinator.ts', 'verificationSnapshot: work ?');
requireText('src/runtime/control-plane/execution/work-finalization-service.ts', 'assertPhysicalImplementationReviewGate');
requireText('src/runtime/control-plane/execution/work-finalization-service.ts', 'assertPhysicalBranchCleanupImplementationReviewGate');
requireText('src/runtime/control-plane/execution/work-finalization-service.ts', 'transferWorkVerificationAcrossContentEquivalentCommit');
requireText('adapters/mcp/runtime-gateway/runtime-tool-definitions.ts', 'review_decision');
requireText('adapters/mcp/runtime-gateway/runtime-tool-definitions.ts', 'implementation_review_findings');
requireText('adapters/mcp/runtime-gateway/runtime-tools.ts', "operation === 'review'");
requireText('adapters/mcp/runtime-gateway/runtime-tools.ts', 'implementationReviewContentFingerprint');
requireText('adapters/mcp/controller-round-compatibility.ts', "'review'");
requireText('packages/kernel/controller/infrastructure/controller-round-store.ts', 'readControllerRoundContextSnapshot');
requireText('adapters/chatgpt/controller-round-host.ts', 'buildChatgptControllerRoundPrompt');
requireText('adapters/chatgpt/controller-round-settlement-store.ts', 'recordChatgptControllerRoundSettlement');
forbid('packages/kernel/controller/infrastructure/controller-round-store.ts', /browserSessionId|conversationUrl|recordControllerRoundTabSettlement|buildControllerRoundRelayPrompt|capability_id=/, 'Kernel ControllerRound must remain provider/transport neutral; ChatGPT/MCP rendering and settlement belong to adapters');
requireText('src/runtime/control-plane/global-scheduler/maintenance.ts', "controllerTypes: ['chatgpt']");
requireText('src/runtime/control-plane/facade/suggested-actions.ts', "case 'review'");
forbid(
  'adapters/mcp/runtime-gateway/runtime-tools.ts',
  /function\s+(?:assert|evaluate|derive)[A-Za-z0-9_]*ImplementationReview/,
  'Gateway transport must not implement implementation-review policy authority',
);
forbid(
  'src/runtime/control-plane/execution/work-finalization-service.ts',
  /function\s+deriveImplementationReviewAcrossCommit/,
  'Finalizer must consume the canonical Kernel Work review derivation instead of owning a second review authority',
);
for (const adapter of [
  'src/cli/controller/work-mode.ts',
  'src/runtime/control-plane/facade/types.ts',
]) {
  requireText(adapter, '@deprecated Compatibility adapter');
  requireText(adapter, 'decideRoute(');
  forbid(adapter, /expectedFiles\s*>|expectedChangedLines\s*>|KIND_RANK|providerOrder\s*\(/, 'delegate all routing thresholds and provider selection to Route Policy');
}
let routeAuthorityCount = 0;
for (const path of sourceFiles('src')) {
  routeAuthorityCount += (text(path).match(/export function decideRoute\s*\(/g) ?? []).length;
  forbid(path, /requirePlanForGoalWorkloop\s*:\s*true/, 'never restore mandatory Plan gating in production');
}
if (routeAuthorityCount !== 1) failures.push(`exactly one decideRoute authority is required; found ${routeAuthorityCount}`);
forbid(
  'src/runtime/control-plane/facade/goal-workloop.ts',
  /function\s+(?:evaluateWorkCompletionEvidence|evaluateWorkImplementationEvidence|verificationRecordAppliesToCurrentWorkspace)\s*\(/,
  'keep Work evidence policy in the canonical work-evidence-policy module instead of reimplementing it in the facade',
);
requireText('src/runtime/control-plane/facade/goal-workloop.ts', "from '../execution/work-evidence-policy'");
for (const path of sourceFiles('src/runtime/control-plane')) {
  if (path === 'src/runtime/control-plane/execution/work-completion-authority.ts') continue;
  forbid(
    path,
    /\brecordWorkCompletionReceipt\s*\(/,
    'route Work completion through the canonical work-completion-authority instead of writing terminal receipts directly',
  );
}
// B2 ownership fence: production code may consume only the Kernel Work API/domain,
// never the retired facade store/state-machine or Kernel persistence implementation.
for (const path of sourceFiles('src')) {
  forbid(path, /(?:from\s+['"]|import\s*\(\s*['"])[^'"]*(?:work-contract-store|work-state-machine|work-implementation-review)['"]/, 'production source must consume packages/kernel/work instead of retired Work facade authority');
  forbid(path, /packages\/kernel\/work\/infrastructure\/work-contract-store/, 'production source must consume the Work application/API boundary, not persistence infrastructure');
}
forbid(
  'adapters/mcp/runtime-gateway/runtime-tools.ts',
  /control-plane\/facade\/work-contract-store|kernel\/work\/infrastructure/,
  'MCP Gateway must not mutate Work through facade/persistence authority',
);
forbid(
  'adapters/mcp/runtime-gateway/runtime-tools.ts',
  /\b(?:appendWorkEvidence|recordWorkCompletionReceipt)\s*\(/,
  'MCP Gateway must submit Work application commands instead of writing lifecycle/evidence records directly',
);
requireText('adapters/mcp/runtime-gateway/runtime-tools.ts', 'completeRemoteEffectWorkFromProcessReceipt');
requireText('src/runtime/control-plane/execution/work-finalization-service.ts', 'packages/kernel/work/api/index');
requireText('src/runtime/control-plane/facade/goal-workloop.ts', 'packages/kernel/work/api/index');
// B3 ControllerSession authority and provider-neutral host boundary.
requireText('packages/kernel/controller/domain/types.ts', 'export interface ControllerBinding');
requireText('packages/kernel/controller/domain/types.ts', 'export interface ControllerLease');
requireText('packages/kernel/controller/ports/controller-host.ts', 'export interface ControllerHost');
requireText('packages/kernel/controller/ports/controller-host.ts', 'resume(binding: ControllerBinding, roundContext: ControllerRoundContext)');
requireText('packages/kernel/controller/infrastructure/controller-session-store.ts', 'claimControllerSession');
requireText('packages/kernel/controller/infrastructure/controller-session-store.ts', 'releaseControllerSessionWithAuthority');
requireText('src/runtime/control-plane/facade/controller-session-store.ts', '@deprecated Kernel V2 compatibility shim');
forbid('packages/kernel/controller/index.ts', /infrastructure\//, 'Kernel module root must expose only its public API');
forbid('packages/kernel/controller/application/controller-service.ts', /export\s+\*\s+from\s+['"]\.\.\/infrastructure\//, 'Controller application façade must not wildcard-export infrastructure');
// B4 Scheduler continuation authority: Schedule owns occurrence state only;
// continuation resolves exact Work + retained ControllerSession + opaque ControllerBinding
// and dispatches exclusively through ControllerHost.resume.
requireText('packages/kernel/scheduler/domain/schedule.ts', 'export interface RepositorySchedule');
requireText('packages/kernel/scheduler/domain/schedule.ts', 'export interface ScheduleOccurrence');
requireText('packages/kernel/scheduler/infrastructure/schedule-store.ts', "'occurrences.json'");
requireText('packages/kernel/scheduler/infrastructure/schedule-store.ts', 'saveScheduleDecision');
requireText('packages/kernel/scheduler/application/schedule-service.ts', 'createSchedule');
requireText('packages/kernel/scheduler/api/index.ts', "../application/schedule-service");
forbid('packages/kernel/scheduler/api/index.ts', /\.\.\/infrastructure\//, 'Scheduler public API must expose application/domain surfaces, not infrastructure stores');
requireText('packages/kernel/scheduler/application/eligibility.ts', 'evaluateScheduleTriggerEligibility');
requireText('packages/kernel/scheduler/application/eligibility.ts', 'evaluateScheduleOccurrenceAdmission');
requireText('packages/kernel/scheduler/application/eligibility.ts', 'scheduleTriggerWindowKey');
requireText('packages/kernel/scheduler/application/settlement.ts', 'applyScheduleFailure');
requireText('packages/kernel/scheduler/application/settlement.ts', 'applyScheduleRetryableFailure');
requireText('packages/kernel/scheduler/application/settlement.ts', 'settleScheduledExecution');
requireText('src/runtime/workflow/schedules/settlement.ts', '@deprecated Kernel V2 compatibility shim');
requireText('packages/kernel/scheduler/domain/continuation.ts', 'export interface ScheduledContinuationDispatch');
requireText('packages/kernel/scheduler/application/continuation-service.ts', 'resumeScheduledControllerContinuation');
requireText('packages/kernel/scheduler/application/continuation-service.ts', 'getRetainedControllerSession');
requireText('packages/kernel/scheduler/application/continuation-service.ts', 'getControllerSessionBinding');
requireText('packages/kernel/scheduler/application/continuation-service.ts', 'host.resume(bindingRecord.binding');
requireText('packages/kernel/scheduler/application/continuation-service.ts', 'SCHEDULE_CONTINUATION_OUTCOME_UNKNOWN');
requireText('packages/kernel/scheduler/application/continuation-service.ts', 'scheduler_continuation_prepare');
requireText('packages/kernel/scheduler/application/continuation-service.ts', 'scheduler_continuation_bind_round');
requireText('src/runtime/root/scheduled-controller-composition.ts', 'controllerHostForScheduledBinding');
requireMissing('adapters/scheduler/controller-binding.ts');
requireText('adapters/chatgpt/controller-host.ts', 'createChatgptControllerHost');
requireText('adapters/controller-process/controller-host.ts', 'createProcessControllerHost');
requireText('src/runtime/workflow/schedules/engine.ts', 'resumeScheduledControllerContinuation');
requireText('src/runtime/workflow/schedules/engine.ts', 'evaluateScheduleTriggerEligibility');
requireText('src/runtime/workflow/schedules/engine.ts', 'evaluateScheduleOccurrenceAdmission');
requireText('src/runtime/workflow/schedules/engine.ts', 'controller_session_id');
requireText('src/runtime/workflow/schedules/engine.ts', 'controller_binding_id');
requireText('src/runtime/workflow/schedules/store.ts', '@deprecated Kernel V2 compatibility shim');
requireText('src/runtime/workflow/schedules/store.ts', 'packages/kernel/scheduler/api/index');
forbid('src/runtime/workflow/schedules/store.ts', /scheduler\/infrastructure\//, 'legacy Schedule shim must route through the Kernel Scheduler public API');
requireText('src/runtime/workflow/schedules/types.ts', '@deprecated Kernel V2 compatibility shim');
for (const path of sourceFiles('packages/kernel/scheduler')) {
  forbid(path, /(?:from\s+['"]|import\s*\(\s*['"])[^'"]*adapters\//, 'Kernel Scheduler must not import provider adapters');
  forbid(path, /\b(?:runWorkChatgptContinuation|launchSuperController|getChatgptWorkConversationBinding)\b|\bbrowser_session_id\b|\bconversation_url\b|\blaunch_args\b/, 'Kernel Scheduler must not own provider transport or provider binding payload fields');
}
forbid('src/runtime/workflow/schedules/engine.ts', /\brunWorkChatgptContinuation\b|\blaunchSuperController\b/, 'Schedule execution must dispatch Controller continuation through Kernel Scheduler + ControllerHost, never launch providers directly');
for (const path of sourceFiles('src')) {
  forbid(path, /(?:from\s+['"]|import\s*\(\s*['"])[^'"]*workflow\/schedules\/(?:store|types|settlement)['"]/, 'production source must consume packages/kernel/scheduler instead of retired Schedule store/types/settlement authority');
}
for (const path of sourceFiles('src')) {
  forbid(path, /(?:from\s+['"]|import\s*\(\s*['"])[^'"]*controller-session-store['"]/, 'production source must consume packages/kernel/controller instead of retired ControllerSession facade authority');
}
const B7_KERNEL_INTERNAL_COMPATIBILITY_SHIMS = new Set([
  'src/runtime/control-plane/facade/controller-session-store.ts',
  'src/runtime/control-plane/facade/controller-round-relay.ts',
  'src/runtime/control-plane/facade/work-contract-store.ts',
  'src/runtime/control-plane/facade/work-state-machine.ts',
  'src/runtime/control-plane/facade/work-implementation-review.ts',
  'src/runtime/control-plane/facade/types.ts',
  'src/runtime/workflow/schedules/settlement.ts',
  'src/runtime/workflow/schedules/types.ts',
]);
for (const path of sourceFiles('src')) {
  if (B7_KERNEL_INTERNAL_COMPATIBILITY_SHIMS.has(path)) continue;
  forbid(path, /packages\/kernel\/[^'"/]+\/(?:domain|application|infrastructure)\//, 'active legacy Runtime code must consume Kernel public api/index surfaces; direct internals are compatibility-boundary-only');
}
requireText('src/runtime/control-plane/facade/types.ts', 'packages/kernel/work/domain/types');
requireText('src/runtime/control-plane/facade/types.ts', 'packages/kernel/controller/domain/types');
requireText('src/runtime/control-plane/execution/work-finalization-service.ts', 'completeWorkWithReceipt(');
requireText('adapters/mcp/runtime-gateway/execution-tools.ts', 'resetFinalizationStagesForRequest');
forbid(
  'src/runtime/plugins/browser-handoff-host.ts',
  /browser\/sessions|saveBrowserSession|writeBrowserSession|sessionPath/,
  'Browser handoff sidecars must return interaction results and never write BrowserSession authority directly',
);
forbid(
  'src/runtime/plugins/browser-adapter.ts',
  /BROWSER_POST_DISPATCH_REPLAY_SAFE_ACTIONS|POST_DISPATCH_REPLAY_SAFE_ACTIONS/,
  'Browser replay safety must come from Browser Runtime transaction policy, not an adapter-local allowlist',
);
requireText('src/runtime/plugins/browser-runtime.ts', 'browserActionCanReplayAfterDispatch');
forbid(
  'adapters/mcp/runtime-gateway/runtime-tools.ts',
  /\b(?:createRequirement|resumeRetainedCancelledWorkContract)\s*\(/,
  'keep Requirement admission and retained-cancelled Work lifecycle authority out of the MCP transport',
);
forbid(
  'adapters/mcp/runtime-gateway/runtime-tools.ts',
  /\b(?:updateWorkContract|writeWorkHandle)\s*\(/,
  'keep WorkContract/WorkHandle persistence policy out of the MCP transport',
);
forbid(
  'adapters/mcp/runtime-gateway/execution-tools.ts',
  /\bcreateWorkContract\s*\(/,
  'route compatibility work preparation through canonical Work admission authority',
);
forbid(
  'adapters/mcp/tool-mapping/legacy-tool-service.ts',
  /\bcreateWorkContract\s*\(/,
  'keep the legacy MCP surface as translation over canonical Work admission authority',
);
requireMissing('src/runtime/control-plane/daemon-entry.ts');
requireMissing('scripts/smoke-runtime-control-plane.ts');
requireMissing('src/cli/controller/lifecycle.ts');
requireMissing('src/cli/commands/supervisor.ts');
requireMissing('src/runtime/control-plane/goal-loop');
requireMissing('src/cli/repositories/goal-registry.ts');
requireMissing('src/runtime/assistant');
requireMissing('src/runtime/personal-assistant');
requireMissing('src/runtime/workflow/findings');
forbid(
  'src/runtime/control-plane/global-scheduler/scheduler.ts',
  /tickGoalLoopsForController|lastGoalLoopTick/,
  'Scheduler must not restore autonomous Goal Loop polling',
);
requireMissing('src/cli/controller/restart-coordinator-entry.ts');
requireMissing('scripts/controller-runtime.sh');
requireMissing('scripts/activate-source-baseline.command');
requireMissing('scripts/restart-forge.sh');
requireMissing('src/cli/controller/stable-state');
requireMissing('src/cli/controller/runtime-slots.ts');
requireMissing('src/runtime/bootstrap/runtime-authority.ts');
requireMissing('src/runtime/bootstrap/activation-transaction.ts');
requireMissing('src/runtime/bootstrap/stable-bootstrap.ts');
requireMissing('src/runtime/supervisor');
requireMissing('docs/architecture/current/stable-external-runtime-supervisor.md');
requireMissing('docs/architecture/modules/controller-runtime/stable-supervisor.md');
requireMissing('docs/operations/stable-external-runtime-supervisor.md');
requireMissing('docs/operations/stable-state-and-process-runtime.md');
requireMissing('ARCHITECTURE_MIGRATION_REPORT.md');
requireMissing('OPTIMIZATION_REPORT.md');
requireMissing('docs/architecture/RELIABILITY-PROGRAM.md');
requireMissing('docs/architecture/p0-canonical-single-runtime-plan.md');
requireMissing('docs/architecture/transactional-adoption-planner.md');
requireMissing('docs/architecture/global-hook-runtime.md');
requireMissing('docs/architecture/ios-semantic-automation-provider-v2.md');
requireMissing('docs/architecture/chatgpt-handoff-facade.md');
requireText('docs/architecture/history/global-hook-runtime.md', 'Status: **Historical Evidence — Not Runtime Authority**');
requireText('docs/architecture/history/ios-semantic-automation-provider-v2.md', 'Status: **Historical Design Evidence — Not Runtime Authority**');
requireText('docs/architecture/history/chatgpt-handoff-facade.md', 'Status: **Historical Design Rationale — Not Runtime Authority**');
requireText('docs/architecture/history/README.md', 'Status: **Historical Evidence — Not Runtime Authority**');
requireMissing('docs/operations/20260802-requirement-portfolio-migration.md');
requireMissing('docs/runbooks/RELIABILITY-SESSION-PROTOCOL.md');
requireMissing('docs/architecture/decisions/20260718-mcp-session-lifecycle-and-ingress-isolation.md');
requireMissing('docs/architecture/decisions/20260802-requirement-centered-control-plane.md');
requireMissing('docs/researches/20260801-control-plane-state-store-inventory.md');
requireMissing('docs/architecture/snapshots/2026-05-25-agentic-dev-plugin-review.md');
requireMissing('bin/repo-harness.mjs');
requireMissing('bin/repo-harness-hook.mjs');
requireMissing('bin/repo-harness-runtime.mjs');
requireMissing('src/runtime/control-plane/daemon-client.ts');
requireMissing('src/runtime/control-plane/daemon-ownership.ts');
requireMissing('src/runtime/workflow/portfolio');
for (const path of sourceFiles('src')) {
  const source = text(path);
  for (const retiredAuthority of [
    'runtime-writer-context',
    'runtime-slots',
    'writer-authority',
    'activation-authority.json',
    'active-slot.json',
    'bootstrap/runtime-authority',
    'bootstrap/activation-transaction',
    'bootstrap/stable-bootstrap',
  ]) {
    if (source.includes(retiredAuthority)) {
      failures.push(`${path} still references retired authority: ${retiredAuthority}`);
    }
  }
}
requireText('src/runtime/execution/process-runtime/gc.ts', "from '../../root/write-fence'");
forbid(
  'src/runtime/execution/process-runtime/gc.ts',
  /runtime-writer-context|assertThisRuntimeMayWrite/,
  'use only the Canonical Runtime write fence for cleanup',
);
requireText('src/runtime/execution/workers/ownership.ts', 'from "../../root/write-fence"');
requireText('src/runtime/execution/workers/ownership.ts', "assertRuntimeMayWrite('renew_lease'");
forbid(
  'src/runtime/execution/workers/ownership.ts',
  /daemon-client|readControllerDaemonStatus|CONTROLLER_EPOCH_STALE|controllerStartedAt/,
  'derive Worker validity from Canonical Runtime ownership/release fencing, never Daemon projection state',
);
forbid(
  'src/runtime/execution/workers/worker-entry.ts',
  /--controller-started-at|controllerStartedAt/,
  'inherit only the immutable Canonical Runtime/release claim and owner PID',
);
forbid(
  'src/runtime/control-plane/global-scheduler/scheduler.ts',
  /--controller-started-at|controllerStartedAt|ownerStartedAt|ownerEpoch/,
  'spawn Workers and refresh projections without a legacy lifecycle epoch authority',
);
for (const projectionPath of [
  'src/runtime/projections/invalidation.ts',
  'src/runtime/projections/materialized-view.ts',
  'src/runtime/projections/controller-context.ts',
]) {
  forbid(
    projectionPath,
    /controllerStartedAt|ownerEpoch/,
    'use process identity and bounded staleness only, not a legacy lifecycle epoch authority',
  );
}
requireText('src/runtime/projections/invalidation.ts', 'runtimeInstanceId?: string');
requireText('src/runtime/projections/materialized-view.ts', 'currentOwner.runtimeInstanceId !== owner.runtimeInstanceId');
requireText('src/runtime/control-plane/global-scheduler/projection-refresh.ts', 'getRuntimeWriteClaim()?.runtimeInstanceId');
forbid(
  'src/runtime/execution/jobs/receipt-store.ts',
  /ownerEpoch|releaseFencingToken/,
  'persist only non-secret Canonical Runtime/release identity in OperationReceipt ownership evidence',
);

requireText('docs/architecture/CURRENT.md', 'Canonical Runtime is activated as one immutable whole release');
requireText('docs/architecture/CURRENT.md', 'Runtime availability/recovery keeps Forge itself healthy');
requireText('docs/architecture/CURRENT.md', 'Historical Issue/Task/Local Job and compatibility projections must not become second mutable authorities.');
requireText('src/runtime/root/runtime.ts', 'export class CanonicalForgeRuntime');
forbid('src/runtime/control-plane/runtime-status-client.ts', /ensureControllerDaemon|child_process|daemon-entry|StableSupervisor|ownerEpoch|slot\?:/, 'keep Forge Runtime status observation read-only and free of legacy lifecycle authority');
requireText('src/runtime/root/runtime.ts', "startInProcessScheduler");
requireText('src/runtime/root/runtime.ts', 'startRuntimeMcpTransport');
forbid(
  'src/runtime/root/runtime.ts',
  /StableSupervisorRuntime|createStableIngressRouter|runtime-slots|mcp\/keepalive|ensureControllerDaemon|child_process/,
  'Canonical Runtime must not depend on Supervisor, Stable Ingress, slots, KeepAlive, an independent Daemon lifecycle, or child-process ownership for core modules',
);
requireText('src/runtime/root/types.ts', 'ready: boolean');
requireText('src/runtime/root/types.ts', 'diagnostics:');
forbid(
  'src/runtime/root/types.ts',
  /RuntimeLifecycle|\blifecycle\s*:|\bdegraded\b|\bpartial\b|\brecovering\b/,
  'public Canonical Runtime readiness must remain one boolean with diagnostic evidence only',
);
forbid(
  'src/runtime/root/readiness.ts',
  /\bdegraded\b|\bpartial\b|\brecovering\b|setLifecycle|RuntimeLifecycle/,
  'Canonical Runtime readiness must not grow another lifecycle or recovery state machine',
);
requireText('src/runtime/root/status.ts', 'This is a read-only projection, never lifecycle authority.');
requireText('src/runtime/root/status.ts', 'owner.runtimeInstanceId === snapshot.runtimeInstanceId');
requireText('src/runtime/root/status.ts', 'owner.pid === snapshot.pid');
requireText('src/runtime/root/runtime.ts', 'writeRuntimeStatusSnapshot');
requireText('src/runtime/root/runtime.ts', 'removeRuntimeStatusSnapshot');
forbid(
  'src/cli/commands/runtime.ts',
  /controller\/lifecycle|restart-coordinator|daemon-client|CanonicalForgeRuntime|ensureControllerHome|\.command\(['"](?:start|stop|restart|doctor)['"]\)|rebuildRepositoryProjection/,
  'runtime CLI must remain a read-only observer; forge-runtime is the sole canonical lifecycle entrypoint',
);
requireText('src/cli/commands/runtime.ts', 'observeRuntimeStatus');
requireText('src/cli/commands/runtime.ts', 'readRepositoryProjection');
forbid(
  'src/cli/index.ts',
  /buildSupervisorCommand|addCommand\(buildSupervisorCommand\(\)\)/,
  'the public root CLI must not expose the legacy Supervisor lifecycle',
);
requireMissing('src/cli/commands/controller.ts');
requireText('src/runtime/root/release-manifest.ts', "entrypoint must be forge-runtime");
requireText('src/runtime/root/release-manifest.ts', 'databaseSchemaCompatibility');
requireText('src/runtime/root/release-manifest.ts', 'workerProtocolVersion');
requireText('src/runtime/root/service.ts', 'RunAtLoad');
requireText('src/runtime/root/service.ts', 'SuccessfulExit');
requireText('src/runtime/root/service.ts', 'ThrottleInterval');
requireText('src/runtime/root/service-runner.ts', 'activeRuntimeReleaseManifest');
requireText('src/runtime/standalone-recovery/core.ts', 'restartPrimaryRuntime');
requireText('src/runtime/standalone-recovery/core.ts', 'recoverPrimaryRuntime');
requireText('src/runtime/standalone-recovery/core.ts', "action: 'restart_primary_runtime'");
requireText('src/runtime/standalone-recovery/core.ts', 'restartAttempts >= maximumRestartAttempts');
requireText('src/runtime/standalone-recovery/core.ts', 'rollbackPreviousLocked');
requireText('src/runtime/standalone-recovery/entry.ts', "'restart_primary_runtime'");
requireText('src/runtime/standalone-recovery/entry.ts', "'recover_primary_runtime'");
forbid(
  'src/runtime/standalone-recovery/core.ts',
  /runtime-slots|active-slot|blue\/green|StableSupervisor|component rollback/i,
  'recover only the canonical whole Runtime through one active/previous release authority',
);
requireText('src/cli/commands/init-hook.ts', "new Command('setup')");
requireText('src/cli/commands/init-hook.ts', "['open', 'next']");
requireText('src/cli/commands/init-hook.ts', "command(name)");
requireText('src/cli/commands/init-hook.ts', "command('close')");
requireText('src/cli/commands/init-hook.ts', "'.forge'");
requireText('src/cli/editing/edit-session.ts', 'beforeMode');
requireText('src/cli/editing/edit-session.ts', 'afterMode');
requireText('src/cli/editing/edit-session.ts', '{ mode: record.beforeMode }');
requireText('src/cli/editing/executable-modes.ts', "mode | 0o111");
requireText('scripts/repair-executable-modes.ts', "process.argv.includes('--check')");
requireText('package.json', 'check:executable-modes');
requireText('package.json', 'repair:executable-modes');
forbid('src/cli/index.ts', /forge-mode-repair-request|repairExecutableModes/, 'keep executable-mode repair explicit instead of hiding it in normal CLI startup');

forbid(
  'scripts/smoke-runtime-recovery.ts',
  /\bcreateExecutionJob\b|\battachExecutionWorker\b|\btransitionExecutionJobFromWorker\b/,
  'Runtime recovery smoke must validate WorkContract and Process Runtime recovery without creating or driving ExecutionJobs',
);
requireText('scripts/smoke-runtime-recovery.ts', 'acceptSubmittedWorkContract');
requireText('scripts/smoke-runtime-recovery.ts', 'recoverManagedProcesses');
requireText('scripts/smoke-runtime-recovery.ts', 'listExecutionJobs');
forbid(
  'scripts/smoke-schedule-engine.ts',
  /\bcreateExecutionJob\b|\bgetExecutionJob\b|\btransitionExecutionJob\b|\bsettleScheduledExecution\b/,
  'Schedule smoke must validate external-controller handoffs and deterministic maintenance without reviving ExecutionJob dispatch',
);
requireText('scripts/smoke-schedule-engine.ts', 'listHandoffItems');
requireText('scripts/smoke-schedule-engine.ts', 'listExecutionJobs');
requireText('scripts/smoke-schedule-engine.ts', "operation: 'runtime_maintenance_apply'");
const server = text('adapters/mcp/server.ts');
const runtimeCall = server.indexOf('callRuntimeTool(ctx, name, args)');
const durableCall = server.indexOf('routeDurableMcpCall(ctx, name, args)');
const legacyCall = server.indexOf('callMultiRepositoryTool(ctx, name, args)');
if (!(runtimeCall >= 0 && durableCall > runtimeCall && legacyCall > durableCall)) {
  failures.push('MCP routing must evaluate runtime reads/control, then durable acceptance, before the legacy Worker-only implementation');
}
const executionToolCall = server.indexOf('const executionResult = await callExecutionTool(ctx, name, args)');
const durableCallAfterExecution = server.indexOf('const durableResult = await routeDurableMcpCall(ctx, name, args)');
if (!(executionToolCall >= 0 && durableCallAfterExecution > executionToolCall)) {
  failures.push('Public MCP Work mutations must execute through callExecutionTool before any durable Operation admission');
}
// SuperController peer model: Work mutations are owned by WorkContract + Process Runtime.
// They must not be forced back onto the retired ExecutionJob durable path at the gateway.
const executionRegion = executionToolCall >= 0 && durableCallAfterExecution > executionToolCall
  ? server.slice(executionToolCall, durableCallAfterExecution)
  : '';
if (executionRegion.includes('forceDurable: true') && executionRegion.includes('isDurableWorkOperation')) {
  failures.push('Public MCP Work mutations must not force the retired durable ExecutionJob path');
}
forbid(
  'adapters/mcp/runtime-gateway/router.ts',
  /\bcreateExecutionJob\b|\bgetExecutionJob\b/,
  'Gateway Router must not retain dormant ExecutionJob creation or lookup paths',
);
requireText('adapters/mcp/runtime-gateway/router.ts', 'executionJobCreationRetired');
requireText('adapters/mcp/runtime-gateway/router.ts', "'EXECUTION_JOB_RETIRED'");
requireText('adapters/mcp/runtime-gateway/execution-tools.ts', 'isDurableWorkOperation');
requireText('adapters/mcp/runtime-gateway/execution-tools.ts', "'work_execute'");
requireText('adapters/mcp/runtime-gateway/execution-tools.ts', "'work_validate'");
requireText('adapters/mcp/runtime-gateway/execution-tools.ts', "'work_finalize'");
requireText('src/runtime/execution/workers/executor.ts', 'executeWork(runtimeContext');
requireText('src/runtime/execution/workers/executor.ts', 'validateWork(runtimeContext');
requireText('src/runtime/execution/workers/executor.ts', 'finalizeWork(runtimeContext');
forbid(
  'src/runtime/execution/workers/executor.ts',
  /gateway\/mcp\/execution-tools|callExecutionTool\s*\(/,
  'Execution Worker must invoke control-plane Work application services directly, never MCP transport',
);
requireText('src/runtime/execution/workers/executor.ts', '__from_durable_worker');
requireText('adapters/mcp/runtime-gateway/runtime-tools.ts', 'managedProcessOperationDigest');
forbid(
  'adapters/mcp/runtime-gateway/runtime-tools.ts',
  /\bcreateExecutionJob\b/,
  'Runtime MCP tools must not retain dormant ExecutionJob creation paths',
);
forbid(
  'src/runtime/execution/jobs/legacy-adapter.ts',
  /\bcreateExecutionJob\b|\bdispatchLegacyLocalJob\b/,
  'Legacy Local Bridge compatibility must be read-only and must not dispatch new ExecutionJobs',
);
forbid(
  'src/cli/local-bridge/server.ts',
  /\bsubmitLocalBridgeJob\b|\bdispatchLocalBridgeJob\b|\basyncExecute\b/,
  'Local Bridge HTTP creation routes must return retirement handoffs without dormant Job submission or dispatch code',
);
forbid(
  'adapters/mcp/tool-mapping/repository-tools.ts',
  /\bsubmitLocalBridgeJob\b|\bexecuteLocalBridgeJob\b|\bwaitForRepositoryCommandHandoff\b/,
  'Repository command MCP fallback must use Process Runtime or an external-Controller handoff, never Local Bridge Jobs',
);
forbid(
  'adapters/mcp/tool-mapping/legacy-tool-service.ts',
  /\bsubmitLocalBridgeJob\b|\bexecuteLocalBridgeJob\b|\bacceptTaskJob\b|\bdispatchAcceptedTaskJob\b|\bstartTaskJob\b|\blegacy_agent_run\b/,
  'Legacy MCP compatibility may read or cancel historical Jobs and Runs but must not create or dispatch new ones',
);
forbid(
  'src/cli/local-bridge/job-store.ts',
  /\blocalBridgeJobCreationRetired\b/,
  'The Local Bridge write boundary must be a direct retirement error, not a hidden guard around dormant creation code',
);
requireMatch(
  'src/cli/local-bridge/job-store.ts',
  /export function submitLocalBridgeJob\([\s\S]*?\{\s*throw new Error\([\s\S]*?LOCAL_BRIDGE_JOB_RETIRED[\s\S]*?\);\s*\}/,
  'submitLocalBridgeJob must fail closed directly with LOCAL_BRIDGE_JOB_RETIRED',
);
forbid(
  'src/cli/local-bridge/job-store.ts',
  /\bacceptTaskJob\b|\bexecuteLaunchTask\b|\bexecuteQuickSession\b/,
  'Historical Local Bridge records must not retain an Agent dispatch path',
);
requireMatch(
  'src/cli/local-bridge/job-store.ts',
  /export function executeLocalBridgeJobInline\([\s\S]*?return dispatchLocalBridgeJob\(repoRoot, jobId\);\s*\}/,
  'The Local Bridge compatibility execution API must terminate through the read-only retirement path',
);
// Agent Run write boundaries: creation and retry must fail closed at the function entry.
requireMatch(
  'src/cli/agent-jobs/job-manager.ts',
  /export function startTaskJob\([\s\S]*?\{\s*throw new Error\([\s\S]*?AGENT_RUN_RETIRED[\s\S]*?\);\s*\}/,
  'startTaskJob must fail closed directly with AGENT_RUN_RETIRED',
);
requireMatch(
  'src/cli/agent-jobs/job-manager.ts',
  /export function retryAgentJob\([\s\S]*?\{\s*\/\/ Fail closed[\s\S]*?throw new Error\([\s\S]*?AGENT_RUN_RETIRED[\s\S]*?\);\s*\}/,
  'retryAgentJob must fail closed before any Task mutation with AGENT_RUN_RETIRED',
);
forbid(
  'src/cli/local-bridge/server.ts',
  /\bretryAgentJob\b|\bacceptTaskJob\b|\bstartTaskJob\b/,
  'Local Bridge HTTP must not call Agent Run create/start/retry write boundaries',
);
forbid(
  'adapters/mcp/tool-mapping/legacy-tool-service.ts',
  /\bretryAgentJob\b/,
  'Legacy MCP must not call Agent Run retry',
);
forbid('adapters/mcp/runtime-gateway/router.ts', /Use process_get \/ process_wait \/ process_logs/, 'Gateway follow-up instructions must use an always-exposed neutral Work facade');
requireMatch(
  'adapters/mcp/runtime-gateway/router.ts',
  /const DIRECT_REPOSITORY_TOOLS = new Set\(\[[\s\S]*?'repository_list'[\s\S]*?'repository_get'[\s\S]*?'repository_workbench'[\s\S]*?\]\);/,
  'declare DIRECT_REPOSITORY_TOOLS with repository_list, repository_get, and repository_workbench',
);
requireText('adapters/mcp/runtime-gateway/runtime-tools.ts', "case 'controller_context'");
requireText('adapters/mcp/runtime-gateway/runtime-tools.ts', "case 'local_bridge_status'");
requireText('adapters/mcp/runtime-gateway/runtime-tools.ts', 'readAgentExecutableReadinessSnapshot');
requireText('adapters/mcp/runtime-gateway/runtime-tools.ts', 'connectorExposedTools');
requireText('adapters/mcp/runtime-gateway/runtime-tools.ts', 'currentCallableTools');
forbid('adapters/mcp/runtime-gateway/runtime-tools.ts', /inspectAgentExecutableReadiness|resolveAgentExecutable|writeAgentExecutableReadinessSnapshot/, 'Gateway readiness must only read the Daemon-produced Agent executable snapshot');
forbidBetween(
  'adapters/mcp/runtime-gateway/runtime-tools.ts',
  "case 'repository_runtime_snapshot':",
  "case 'runtime_performance_diagnostics':",
  /rebuildRepositoryProjection\s*\(/,
  'repository_runtime_snapshot must be a bounded materialized-view read, never a live rebuild',
);
requireText('src/cli/local-bridge/job-store.ts', 'listLocalBridgeJobSnapshots');
forbid(
  'src/runtime/execution/workers/executor.ts',
  /\bwriteControllerContextProjection\b/,
  'Execution Workers must not write controller-context projections; the keyed projection owner is the only writer',
);
requireText('src/runtime/projections/controller-context.ts', 'controllerContextProjectionPayloadMatchesSourceIdentity');
requireText('src/runtime/projections/controller-context.ts', 'sourceIdentityMatches');
requireText('adapters/mcp/runtime-gateway/runtime-tools.ts', 'CONTEXT_PROJECTION_SOURCE_MISMATCH');
forbid('adapters/mcp/runtime-gateway/router.ts', /const DIRECT_HOT_READ_TOOLS = new Set\([\s\S]*?['"]controller_context['"][\s\S]*?\);/, 'controller_context must use a materialized projection or Durable Job, never the legacy Gateway path');
forbid('adapters/mcp/runtime-gateway/router.ts', /const DIRECT_HOT_READ_TOOLS = new Set\([\s\S]*?['"](?:local_bridge_status|get_local_job|get_local_job_output)['"][\s\S]*?\);/, 'Local Bridge observations must use bounded snapshots, never reconciliation in the Gateway');
requireText('src/runtime/execution/jobs/types.ts', 'requestId: string');
requireText('src/runtime/execution/jobs/types.ts', 'semanticKey: string');
requireText('src/runtime/execution/jobs/types.ts', 'admissionTimeoutMs: number');
requireText('src/runtime/execution/jobs/types.ts', 'queueTimeoutMs: number');
requireText('src/runtime/execution/jobs/types.ts', 'executionTimeoutMs: number');
requireText('src/runtime/execution/jobs/types.ts', 'interactiveWaitMs: number');
requireText('src/runtime/execution/jobs/timeouts.ts', 'executionTimeoutDecision');
requireText('src/runtime/control-plane/facade/operation-digest.ts', 'operationId');
requireText('src/runtime/control-plane/facade/operation-digest.ts', 'resultRef');
requireText('src/runtime/control-plane/facade/operation-digest.ts', 'nextActions');
requireText('src/runtime/control-plane/facade/operation-digest.ts', 'admissionTimeoutMs');
forbid('adapters/mcp/runtime-gateway/router.ts', /Math\.min\(\s*typeof args\.timeout_ms[\s\S]{0,140}?,\s*120_000\s*\)/, 'Agent parent timeout must never silently truncate timeout_ms to 120 seconds');
requireText('src/runtime/execution/jobs/store.ts', "'active.json'");
requireText('src/runtime/execution/jobs/store.ts', "'recent.json'");
requireText('src/runtime/execution/jobs/store.ts', "'requests'");
requireText('src/runtime/execution/jobs/store.ts', 'transitionExecutionJobFromWorker');
requireText('src/runtime/execution/jobs/receipt-store.ts', "state: 'started' | 'completed'");
requireText('src/runtime/execution/thin-harness/execution-router.ts', "mode: 'fast'");
requireText('src/runtime/execution/thin-harness/execution-router.ts', 'routeExecution');
requireText('src/runtime/execution/thin-harness/types.ts', 'FastExecutionReceipt');
requireText('docs/architecture/CURRENT.md', '### Ephemeral Direct — default');
requireText('src/runtime/resources/leases/types.ts', 'fencingToken: number');
requireText('src/runtime/resources/leases/store.ts', 'assertFencingToken');
requireText('src/runtime/resources/leases/store.ts', 'expectedLeaseMap');
requireText('src/runtime/resources/claims/conflicts.ts', "'repo-content:*'");
requireText('src/runtime/control-plane/repo-actor/actor.ts', 'repo-actor-mailbox');
requireText('src/runtime/control-plane/global-scheduler/scheduler.ts', 'maxConcurrentRepositories');
requireText('src/runtime/control-plane/global-scheduler/scheduler.ts', 'createSchedulerDispatchCapacity');
requireText('src/runtime/control-plane/global-scheduler/dispatch-capacity.ts', 'maxHeavyChecks');
requireText('src/runtime/control-plane/global-scheduler/dispatch-capacity.ts', 'maxAgentProcesses');
requireText('src/runtime/control-plane/global-scheduler/scheduler.ts', 'normalizeSchedulerConfig');
requireText('src/runtime/control-plane/global-scheduler/config.ts', 'normalizeSchedulerConfig');
requireText('src/runtime/control-plane/global-scheduler/scheduler.ts', 'writeSchedulerHealthSnapshot');
requireText('src/runtime/control-plane/global-scheduler/state.ts', 'writeSchedulerHealthSnapshot');
requireText('src/runtime/control-plane/global-scheduler/scheduler.ts', 'buildSchedulerWorkerLaunchDescriptor');
requireText('src/runtime/control-plane/global-scheduler/worker-launch.ts', 'buildSchedulerWorkerLaunchDescriptor');
requireText('src/runtime/control-plane/global-scheduler/scheduler.ts', 'refreshSchedulerRepositoryProjections');
requireText('src/runtime/control-plane/global-scheduler/projection-refresh.ts', 'refreshRepositoryProjectionForRepository');
requireText('src/runtime/control-plane/global-scheduler/scheduler.ts', 'buildSchedulerWorkerSpawnedLifecycle');
requireText('src/runtime/control-plane/global-scheduler/worker-lifecycle.ts', 'buildSchedulerWorkerExitFailure');
requireText('src/runtime/control-plane/global-scheduler/scheduler.ts', 'createSchedulerWorkerStderrCapture');
requireText('src/runtime/control-plane/global-scheduler/worker-stderr.ts', 'MAX_SCHEDULER_WORKER_STDERR_BYTES');
requireText('src/runtime/control-plane/global-scheduler/scheduler.ts', 'persistSchedulerWorkerAttachment');
requireText('src/runtime/control-plane/global-scheduler/worker-attachment.ts', 'attachExecutionWorker');
requireText('src/runtime/control-plane/global-scheduler/scheduler.ts', 'runSchedulerPeriodicCleanup');
requireText('src/runtime/control-plane/global-scheduler/maintenance.ts', 'runSchedulerValidationReconciliation');
requireText('src/runtime/control-plane/global-scheduler/scheduler.ts', 'planSchedulerSourceSampling');
requireText('src/runtime/control-plane/global-scheduler/source-scan.ts', 'selectSchedulerSourceScanRepositories');
requireText('src/runtime/control-plane/global-scheduler/scheduler.ts', 'runSchedulerDurableAdmission');
requireText('src/runtime/control-plane/global-scheduler/durable-admission.ts', 'markExecutionJobSchedulerObserved');
requireText('src/runtime/control-plane/global-scheduler/worker-exit-reconciler.ts', 'persistSchedulerTerminalWorkerLifecycle');
requireText('src/runtime/control-plane/global-scheduler/worker-lifecycle-store.ts', 'TERMINAL_JOB_STATUSES');
requireText('src/runtime/control-plane/global-scheduler/worker-exit-reconciler.ts', 'evaluateSchedulerWorkerExitCandidate');
requireText('src/runtime/control-plane/global-scheduler/worker-exit-decision.ts', 'TERMINAL_JOB_STATUSES');
requireText('src/runtime/control-plane/global-scheduler/scheduler.ts', 'reconcileSchedulerWorkerExit');
requireText('src/runtime/control-plane/global-scheduler/worker-exit-reconciler.ts', 'releaseExecutionLeases');
requireText('src/runtime/control-plane/global-scheduler/scheduler.ts', 'cleanupSchedulerWorkerProcesses');
requireText('src/runtime/control-plane/global-scheduler/scheduler.ts', 'registerSchedulerWorkerProcess');
requireText('src/runtime/control-plane/global-scheduler/scheduler.ts', 'spawnSchedulerWorkerProcess');
requireText('src/runtime/control-plane/global-scheduler/scheduler.ts', 'wireSchedulerWorkerProcess');
requireText('src/runtime/control-plane/global-scheduler/worker-process.ts', 'cleanupSchedulerWorkerProcesses');
requireText('src/runtime/control-plane/global-scheduler/worker-process.ts', 'dependencies.spawnProcess');
requireText('src/runtime/control-plane/global-scheduler/worker-process.ts', 'terminateProcessTree');
requireText('src/runtime/control-plane/global-scheduler/worker-process.ts', "child.once('close'");
requireText('src/runtime/control-plane/global-scheduler/scheduler.ts', 'writeAgentExecutableReadinessSnapshot');
requireText('src/runtime/control-plane/global-scheduler/scheduler.ts', 'sampleRepositoryGitStatusForRepositories');
requireText('src/cli/agent-jobs/executable-resolver.ts', 'revalidateAgentExecutable');
requireText('src/cli/agent-jobs/executable-resolver.ts', 'AGENT_EXECUTABLE_IDENTITY_CHANGED');
forbidBetween(
  'src/runtime/control-plane/global-scheduler/scheduler.ts',
  'activeJobs = withControllerLock(',
  '} catch (error) {',
  /this\.spawnWorker\s*\(/,
  'Execution Worker spawn must happen outside the global scheduler lock',
);
forbidBetween(
  'src/runtime/control-plane/repo-actor/actor.ts',
  'const dispatch = withControllerLock(',
  '// Projection materialization',
  /rebuildRepositoryProjection\s*\(/,
  'Projection rebuild must happen outside the Repo Actor mailbox lock',
);
requireText('packages/kernel/scheduler/infrastructure/schedule-store.ts', "'occurrences.json'");
requireText('src/runtime/projections/git-status-sampler.ts', 'writeRepositoryGitStatusSample');
requireText('src/runtime/projections/git-status-sampler.ts', 'readRepositoryGitStatusSample');
requireText('adapters/mcp/tool-mapping/repository-tools.ts', 'readRepositoryGitStatusSample');
requireText('adapters/mcp/tool-mapping/repository-tools.ts', 'args.refresh === true');
forbidBetween(
  'adapters/mcp/tool-mapping/repository-tools.ts',
  "case 'repository_git_status':",
  "case 'repository_git_diff':",
  /repositoryGitStatus\s*\(/,
  'repository_git_status must default to daemon samples; live refresh must be explicit and sampled',
);
requireText('src/runtime/control-plane/execution/session-store.ts', 'lastValidatedAt: now');
requireText('src/runtime/control-plane/execution/validation.ts', 'warnings.push');
requireText('src/runtime/control-plane/execution/work-handle-store.ts', "failed: ['validating', 'editing', 'committed', 'merged', 'cleaned', 'failed_terminal_cleanup']");
requireText('adapters/mcp/runtime-gateway/execution-tools.ts', "from '../../../src/runtime/control-plane/execution/work-finalization-service'");
requireText('adapters/mcp/runtime-gateway/execution-tools.ts', "from '../../../src/runtime/control-plane/execution/work-preparation-service'");
requireText('adapters/mcp/runtime-gateway/execution-tools.ts', "from '../../../src/runtime/control-plane/execution/work-operation-service'");
requireText('adapters/mcp/runtime-gateway/execution-tools.ts', 'Compatibility exports: implementation authority lives in control-plane execution.');
requireText('adapters/mcp/runtime-gateway/execution-tools.ts', 'resetFinalizationStagesForRequest,');
requireText('adapters/mcp/runtime-gateway/execution-tools.ts', 'selectDefaultWorkValidationChecks');
requireText('adapters/mcp/runtime-gateway/runtime-tools.ts', "callExecutionTool(ctx, 'work_finalize'");
forbid(
  'adapters/mcp/runtime-gateway/runtime-tools.ts',
  /repositoryGit(?:Commit|FinishWorkflow|MergeBranch|DeleteBranch|RebaseOnto)\s*\(/,
  'rh_work facade finalization must delegate to the canonical Work finalization application service instead of performing Git delivery itself',
);
forbid(
  'adapters/mcp/runtime-gateway/execution-tools.ts',
  /function\s+finalizeWork\s*\(/,
  'MCP execution transport must delegate Work finalization to the control-plane application service',
);
forbid(
  'adapters/mcp/runtime-gateway/execution-tools.ts',
  /function\s+(?:prepareWork|adoptExistingWorkHead)\s*\(/,
  'MCP execution transport must delegate Work preparation/adoption to the control-plane application service',
);
forbid(
  'adapters/mcp/runtime-gateway/execution-tools.ts',
  /function\s+(?:executeWork|validateWork)\s*\(/,
  'MCP execution transport must delegate Work execute/validate operations to the control-plane application service',
);
forbid(
  'adapters/mcp/runtime-gateway/execution-tools.ts',
  /(?:ensureManagedWorkspace|admitPreparedRepositoryWorkContract)\s*\(/,
  'MCP execution transport must not own managed-workspace or WorkContract preparation admission',
);
requireText('src/runtime/control-plane/execution/work-preparation-service.ts', 'export function prepareWork(');
requireText('src/runtime/control-plane/execution/work-preparation-service.ts', 'function adoptExistingWorkHead(');
requireText('src/runtime/control-plane/execution/work-operation-service.ts', 'export async function executeWork(');
requireText('src/runtime/control-plane/execution/work-operation-service.ts', 'export async function validateWork(');
requireText('src/runtime/control-plane/execution/work-finalization-service.ts', 'resetFinalizationStagesForRequest');
requireText('src/runtime/control-plane/execution/work-finalization-service.ts', 'finalizationComplete');
forbidBetween(
  'src/runtime/control-plane/execution/work-finalization-service.ts',
  'export async function finalizeWork(',
  '// WORK_FINALIZATION_SERVICE_END',
  /withControllerLock\([\s\S]{0,900}?(?:repositoryGitCommit|repositoryGitFinishWorkflow|runCleanup|repositoryGitDeleteBranch)/,
  'Work finalization must not hold the controller lock while committing, merging, deleting branches, or removing worktrees',
);
requireText('packages/kernel/scheduler/domain/schedule.ts', "'repository-event'");
requireText('packages/kernel/scheduler/domain/schedule.ts', "'dependency-checkpoint'");
requireText('packages/kernel/scheduler/infrastructure/schedule-store.ts', 'saveScheduleDecision');
requireText('packages/kernel/scheduler/application/settlement.ts', 'backoffMinutes');
requireText('src/runtime/release/release-gate.ts', 'releaseReady');
requireText('adapters/mcp/transports/http.ts', "'/ready'");
requireText('adapters/mcp/transports/http.ts', "'/repos/:repoId/health'");
requireText('src/runtime/control-plane/governance/external-effects.ts', 'EXTERNAL_EFFECT_AUTHORIZATION_REQUIRED');
requireText('src/runtime/control-plane/governance/external-effects.ts', 'AUTOMATED_REQUIREMENT_REQUIRES_CANDIDATE');
requireText('adapters/mcp/tool-mapping/tools.ts', "export * from './legacy-tool-service'");
requireText('src/cli/mcp/tools.ts', '@deprecated Kernel V2 compatibility shim');

for (const path of [
  'adapters/mcp/runtime-gateway/router.ts',
  'adapters/mcp/runtime-gateway/runtime-tools.ts',
  'src/runtime/control-plane/global-scheduler/scheduler.ts',
  'src/runtime/control-plane/repo-actor/actor.ts',
  'src/runtime/workflow/schedules/engine.ts',
  'src/runtime/workflow/schedules/work-continuation.ts',
  'adapters/mcp/transports/http.ts',
]) {
  forbid(path, /\b(?:spawnSync|execSync|execFileSync)\s*\(/, 'the non-blocking Gateway/Controller hot-path rule');
}

requireText('scripts/run-governed-gate.ts', "label: 'source duplication'");
requireText('scripts/run-governed-gate.ts', "args: ['scripts/check-source-duplication.mjs']");
requireText('scripts/run-governed-gate.ts', "label: 'controller UI bundle'");
requireText('scripts/run-governed-gate.ts', "args: ['run', 'check:controller-ui']");
requireText('docs/architecture/CURRENT.md', '## State ownership');
requireText('docs/architecture/CURRENT.md', '## Runtime and MCP boundary');
requireText('docs/architecture/CURRENT.md', '## Testing and verification');
requireText('plans/README.md', 'not the runtime execution queue');
if (text('src/cli/mcp/tools.ts').split(/\r?\n/).length > 6) failures.push('src/cli/mcp/tools.ts must remain a thin compatibility facade');
if (text('src/cli/mcp/legacy-tool-service.ts').split(/\r?\n/).length > 6) failures.push('src/cli/mcp/legacy-tool-service.ts must remain a thin compatibility facade');
if (text('src/cli/mcp/repository-tools.ts').split(/\r?\n/).length > 6) failures.push('src/cli/mcp/repository-tools.ts must remain a thin compatibility facade');
for (const path of sourceFiles('packages/kernel')) {
  forbid(path, /(?:from\s+['\"]|import\s*\(\s*['\"])[^'\"]*(?:adapters\/mcp|src\/cli\/mcp|runtime\/gateway\/mcp)/, 'Kernel modules must never depend on MCP adapters or retired MCP gateway paths');
  forbid(path, /@modelcontextprotocol\//, 'Kernel modules must remain independent of MCP SDK transport contracts');
}

const b7ProductionGraph = productionStaticTypeScriptDependencyGraph();
for (const edge of dependencyEdges(b7ProductionGraph)) {
  const { from, to } = edgeParts(edge);
  if (from.startsWith('packages/kernel/') && to.startsWith('packages/kernel/')) {
    const fromModule = architectureRoot(from);
    const toModule = architectureRoot(to);
    if (fromModule !== toModule && !to.startsWith(`${toModule}/api/`) && to !== `${toModule}/index.ts`) {
      failures.push(`Kernel sibling modules must use public API boundaries: ${edge}`);
    }
  }
  if (from.startsWith('adapters/') && to.startsWith('adapters/') && architectureRoot(from) !== architectureRoot(to)) {
    failures.push(`adapter sibling wiring belongs in a composition root, not another adapter: ${edge}`);
  }
  if (from.startsWith('adapters/') && to.startsWith('packages/kernel/')) {
    const kernelModule = architectureRoot(to);
    if (!to.startsWith(`${kernelModule}/api/`) && to !== `${kernelModule}/index.ts`) {
      failures.push(`adapters must consume Kernel public APIs, not internal implementation: ${edge}`);
    }
  }
}
for (const compositionPath of [
  'src/runtime/root/scheduled-controller-composition.ts',
  'src/runtime/root/controller-round-composition.ts',
]) requireText(compositionPath, 'Kernel V2 composition root');

// Exact legacy edges are frozen below after a read-only graph inventory; new debt is never accepted.
// The V2 baseline lineage is immutable; this gate must not require rebasing onto unrelated main work.
const b7KernelLegacyEdges = edgeSet(b7ProductionGraph, (edge) => {
  const { from, to } = edgeParts(edge);
  return from.startsWith('packages/kernel/') && to.startsWith('src/');
});
const B7_ALLOWED_KERNEL_LEGACY_EDGES = new Set([
  'packages/kernel/work/domain/types.ts -> src/runtime/evidence/process-check-receipt.ts',
  'packages/kernel/work/domain/types.ts -> src/cli/controller/types.ts',
  'packages/kernel/work/domain/types.ts -> src/runtime/control-plane/governance/access-policy.ts',
  'packages/kernel/work/domain/types.ts -> src/runtime/control-plane/routing/route-policy.ts',
  'packages/kernel/work/infrastructure/work-contract-store.ts -> src/cli/repositories/controller-home.ts',
  'packages/kernel/work/infrastructure/work-contract-store.ts -> src/cli/repositories/locks.ts',
  'packages/kernel/work/infrastructure/work-contract-store.ts -> src/runtime/shared/json-files.ts',
  'packages/kernel/work/infrastructure/work-contract-store.ts -> src/runtime/control-plane/persistence/sqlite-store.ts',
  'packages/kernel/work/infrastructure/work-contract-store.ts -> src/runtime/control-plane/facade/work-admission-policy.ts',
  'packages/kernel/controller/infrastructure/controller-session-store.ts -> src/cli/repositories/controller-home.ts',
  'packages/kernel/controller/infrastructure/controller-session-store.ts -> src/cli/repositories/locks.ts',
  'packages/kernel/controller/infrastructure/controller-session-store.ts -> src/runtime/control-plane/execution/session-store.ts',
  'packages/kernel/controller/infrastructure/controller-session-store.ts -> src/runtime/shared/json-files.ts',
  'packages/kernel/controller/infrastructure/controller-session-store.ts -> src/runtime/control-plane/persistence/sqlite-store.ts',
  'packages/kernel/controller/infrastructure/controller-round-store.ts -> src/cli/repositories/locks.ts',
  'packages/kernel/controller/infrastructure/controller-round-store.ts -> src/runtime/control-plane/persistence/requirement-store.ts',
  'packages/kernel/controller/infrastructure/controller-round-store.ts -> src/runtime/control-plane/persistence/sqlite-store.ts',
  'packages/kernel/controller/infrastructure/controller-round-store.ts -> src/runtime/execution/work-activity.ts',
  'packages/kernel/controller/infrastructure/controller-round-store.ts -> src/runtime/control-plane/facade/handoff-inbox-store.ts',
  'packages/kernel/controller/infrastructure/controller-round-store.ts -> src/runtime/control-plane/facade/types.ts',
  'packages/kernel/controller/infrastructure/controller-binding-store.ts -> src/cli/repositories/locks.ts',
  'packages/kernel/controller/infrastructure/controller-binding-store.ts -> src/runtime/control-plane/persistence/sqlite-store.ts',
  'packages/kernel/scheduler/infrastructure/schedule-store.ts -> src/cli/repositories/controller-home.ts',
  'packages/kernel/scheduler/infrastructure/schedule-store.ts -> src/cli/repositories/locks.ts',
  'packages/kernel/scheduler/infrastructure/schedule-store.ts -> src/runtime/control-plane/facade/handoff-inbox-store.ts',
  'packages/kernel/scheduler/infrastructure/schedule-store.ts -> src/runtime/shared/json-files.ts',
  'packages/kernel/scheduler/infrastructure/schedule-store.ts -> src/runtime/evidence/event-ledger.ts',
  'packages/kernel/scheduler/infrastructure/continuation-dispatch-store.ts -> src/cli/repositories/locks.ts',
  'packages/kernel/scheduler/infrastructure/continuation-dispatch-store.ts -> src/runtime/control-plane/persistence/sqlite-store.ts',
]);
requireExactShrinkingDebt('Kernel -> legacy src dependency debt', b7KernelLegacyEdges, B7_ALLOWED_KERNEL_LEGACY_EDGES);

const b7LifecycleOwnerMarkers = new Map([
  ['WorkContract transition authority', ['packages/kernel/work/domain/state-machine.ts']],
  ['ControllerSession claim authority', ['packages/kernel/controller/infrastructure/controller-session-store.ts']],
  ['ControllerRound relay authority', ['packages/kernel/controller/infrastructure/controller-round-store.ts']],
  ['Schedule occurrence authority', ['packages/kernel/scheduler/infrastructure/schedule-store.ts']],
  ['Forge instance identity authority', ['packages/kernel/identity/infrastructure/identity-store.ts']],
]);
for (const [label, owners] of b7LifecycleOwnerMarkers) {
  for (const owner of owners) text(owner);
  if (new Set(owners).size !== 1) failures.push(`${label} must have exactly one declared durable owner`);
}
const b7UniqueMutationSymbols = new Map([
  ['transitionWorkContractPhase', 'Work lifecycle mutation'],
  ['claimControllerSession', 'ControllerSession claim mutation'],
  ['beginInitialControllerRoundDispatch', 'ControllerRound dispatch mutation'],
  ['ensureForgeInstanceIdentity', 'Forge instance identity creation'],
]);
for (const [symbol, label] of b7UniqueMutationSymbols) {
  let count = 0;
  for (const path of productionTypeScriptFiles()) {
    count += (text(path).match(new RegExp(`export\\s+(?:async\\s+)?function\\s+${symbol}\\s*\\(`, 'g')) ?? []).length;
  }
  if (count !== 1) failures.push(`${label} must have exactly one exported production owner; found ${count} for ${symbol}`);
}
for (const path of [
  'src/runtime/gateway/mcp/execution-tools.ts',
  'src/runtime/gateway/mcp/legacy-ios-tool-adapter.ts',
  'src/runtime/gateway/mcp/persisted-check-process.ts',
  'src/runtime/gateway/mcp/process-tools.ts',
  'src/runtime/gateway/mcp/router.ts',
  'src/runtime/gateway/mcp/runtime-tool-definitions.ts',
  'src/runtime/gateway/mcp/runtime-tools.ts',
  'src/runtime/gateway/mcp/work-validation-reconciler.ts',
]) requireText(path, '@deprecated Kernel V2 compatibility shim');
for (const path of [
  'src/cli/mcp/access-tools.ts',
  'src/cli/mcp/legacy-context.ts',
  'src/cli/mcp/legacy-tool-service.ts',
  'src/cli/mcp/multi-repository.ts',
  'src/cli/mcp/repository-tools.ts',
  'src/cli/mcp/server.ts',
  'src/cli/mcp/tools.ts',
  'src/cli/mcp/toolset.ts',
]) requireText(path, '@deprecated Kernel V2 compatibility shim');
requireText('src/runtime/control-plane/execution/work-execution-support.ts', 'packages/protocols/mcp/execution-context');
requireText('src/runtime/control-plane/execution/work-preparation-service.ts', 'packages/protocols/mcp/execution-context');
requireText('src/runtime/control-plane/execution/work-operation-service.ts', 'packages/protocols/mcp/execution-context');
requireText('src/runtime/control-plane/execution/work-finalization-service.ts', 'packages/protocols/mcp/execution-context');
for (const path of [
  'adapters/mcp/transports/http.ts',
  'adapters/mcp/transports/session-registry.ts',
  'adapters/mcp/transports/stdio.ts',
]) forbid(path, /recordWorkCompletionReceipt|transitionWorkContractPhase|releaseControllerSessionWithAuthority|recordWorkImplementationReview/, 'MCP transport/session lifecycle must never terminalize Work or Controller authority');

// Kernel V2 B6: semantic Forge identity is independent of Runtime processes,
// transport sessions, OAuth credentials, tunnel ids, and endpoint rotation.
for (const path of [
  'packages/kernel/identity/domain/types.ts',
  'packages/kernel/identity/application/identity-service.ts',
  'packages/kernel/identity/infrastructure/identity-store.ts',
  'packages/kernel/identity/api/index.ts',
]) text(path);
for (const symbol of ['ForgeInstanceIdentity', 'Principal', 'CredentialReference', 'CapabilityGrant', 'ConnectionIdentity']) {
  requireText('packages/kernel/identity/domain/types.ts', `interface ${symbol}`);
}
requireText('packages/kernel/identity/application/identity-service.ts', 'export function connectionIdentity');
requireText('packages/kernel/identity/infrastructure/identity-store.ts', "'identity', 'forge-instance.json'");
requireText('packages/kernel/identity/infrastructure/identity-store.ts', 'linkSync(temporary, path)');
forbid(
  'packages/kernel/identity/domain/types.ts',
  /\b(?:tunnelId|mcpServerUrl|endpointUrl|runtimeApiKey|accessToken|refreshToken|oauthToken|bearerToken)\b/,
  'Kernel identity contracts must contain semantic ids or credential references, never transport endpoint/tunnel/token material',
);
forbidBetween(
  'packages/kernel/identity/application/identity-service.ts',
  'const semanticKey = [',
  "].join('\\u0000')",
  /\b(?:endpoint|url|tunnel|pid|process|session)\b/i,
  'ConnectionIdentity semantic key must remain independent of endpoint, tunnel, process, and session identity',
);
forbidBetween(
  'packages/kernel/identity/infrastructure/identity-store.ts',
  'const identity: ForgeInstanceIdentity = {',
  '};',
  /\b(?:pid|process|endpoint|url|tunnel|token)\b/i,
  'ForgeInstanceIdentity creation must remain independent of process and adapter transport/auth metadata',
);
for (const path of [
  'src/cli/mcp/auth.ts',
  'src/cli/mcp/setup.ts',
  'src/cli/mcp/openai-secure-tunnel.ts',
]) {
  requireText(path, '@deprecated Kernel V2 compatibility shim');
  if (text(path).split(/\r?\n/).length > 6) failures.push(`${path} must remain a thin B6 compatibility facade`);
}
requireText('adapters/mcp/auth.ts', 'forgeInstanceId?: string');
forbid('adapters/mcp/auth.ts', /server:\s*\{[\s\S]{0,512}?instanceId\??:\s*string/, 'MCP server process identity must not share semantic Forge instanceId naming');
requireText('adapters/mcp/setup.ts', 'ensureForgeInstanceIdentity');
requireText('adapters/mcp/setup.ts', 'MCP_FORGE_INSTANCE_ID_MISMATCH');
requireText('src/runtime/root/types.ts', 'forgeInstanceId: string');
requireText('src/runtime/root/types.ts', 'runtimeInstanceId: string');
requireText('src/runtime/root/runtime.ts', 'readonly forgeInstanceId: string');
requireText('src/runtime/root/runtime.ts', 'ensureForgeInstanceIdentity');
requireText('src/runtime/root/entry.ts', 'forgeInstanceId: runtime.forgeInstanceId');
requireText('adapters/mcp/transports/http.ts', 'forgeInstanceId: forgeInstance.instanceId');
requireText('adapters/mcp/transports/http.ts', 'controllerInstanceId: process.env.FORGE_MCP_INSTANCE_ID');
forbid('adapters/mcp/transports/http.ts', /\{\s*instanceId:\s*process\.env\.FORGE_MCP_INSTANCE_ID/, 'MCP process identity must not be exposed as semantic Forge instanceId');
requireText('adapters/mcp/transports/http.ts', "adapterId: 'mcp-http'");
requireText('adapters/mcp/transports/session-registry.ts', 'connectionId: string');
requireText('adapters/mcp/transports/session-registry.ts', 'reservation.connectionId !== input.connectionId');
requireText('adapters/mcp/tunnels/openai-secure-tunnel.ts', 'tunnelMatches: boolean');
requireText('adapters/mcp/tunnels/openai-secure-tunnel.ts', 'credentialReference(config.runtimeApiKeyRef');
forbid('adapters/mcp/tunnels/openai-secure-tunnel.ts', /\bidentityMatches\b/, 'tunnel binding match must not masquerade as Forge semantic identity');

// C0 Computer capability boundary: Browser and Desktop remain separate providers.
requireText('packages/protocols/computer/contract.ts', 'COMPUTER_BROWSER_AUTOMATION_CAPABILITY');
requireText('packages/plugin-runtime/computer/provider.ts', 'export interface ComputerProvider');
requireText('packages/plugin-runtime/computer/provider-registry.ts', 'export class ComputerProviderRegistry');
requireText('adapters/computer/desktop-operator-provider.ts', 'createDesktopOperatorComputerProvider');
requireText('src/runtime/root/computer-composition.ts', 'createDesktopOperatorComputerProvider');
requireText('src/runtime/plugins/browser-automation-service.ts', 'executeRuntimeComputerBrowserAutomation');
requireText('src/runtime/plugins/browser-adapter.ts', 'activateRuntimeComputerBrowserApplication');
forbid('src/runtime/plugins/browser-automation-service.ts', /desktop_operator|macos-capability-broker|desktop-operator\.sock|macos_browser_automation/, 'Browser automation must depend on the provider-neutral Computer boundary, not Desktop Operator transport details');
forbid('src/runtime/plugins/browser-adapter.ts', /desktop_operator|Desktop Operator|getExternalPluginAdapter|desktop_session_open/, 'Browser adapter must not know the concrete Desktop Operator application provider');
for (const path of sourceFiles('src/runtime/plugins').filter((entry) => /\/browser-(?!registration\.ts)[^/]+\.ts$/.test(entry))) {
  forbid(path, /desktop_operator|Desktop Operator|desktop-operator\.sock|macos_browser_automation/, 'Browser modules must depend on Computer capabilities rather than concrete Desktop Operator transport identity');
}
requireText('src/runtime/plugins/macos-capability-broker.ts', '@deprecated C0 compatibility shim');
if (text('src/runtime/plugins/macos-capability-broker.ts').split(/\r?\n/).length > 24) failures.push('src/runtime/plugins/macos-capability-broker.ts must remain a thin C0 compatibility facade');
for (const path of sourceFiles('packages/plugin-runtime')) {
  forbid(path, /(?:from\s+['"]|import\s*\(\s*['"])[^'"]*(?:adapters\/|src\/runtime\/)/, 'Plugin Runtime provider dispatch must not depend on concrete adapters or Runtime implementations');
}
requireText('src/runtime/plugins/desktop-operator-registration.ts', 'COMPUTER_OBSERVE_CAPABILITY');
requireText('src/runtime/plugins/desktop-operator-registration.ts', 'COMPUTER_INPUT_CAPABILITY');
requireText('src/runtime/plugins/desktop-operator-registration.ts', 'COMPUTER_CAPTURE_CAPABILITY');

// C0 Browser runtime authority: contracts and provider selection belong to plugin-runtime/protocols.
requireText('packages/plugin-runtime/browser/runtime-contract.ts', 'export interface BrowserTransaction');
requireText('packages/plugin-runtime/browser/provider-registry.ts', 'export class BrowserProviderRegistry');
requireText('packages/plugin-runtime/browser/provider-registry.ts', 'export class BrowserProviderSelectionError');
forbid('packages/plugin-runtime/browser/provider-registry.ts', /AssistantPluginError|src\/runtime|adapters\//, 'Browser provider selection must remain provider-neutral inside plugin-runtime');
requireText('packages/protocols/browser/session.ts', 'export interface BrowserSessionState');
for (const path of [
  'src/runtime/plugins/browser-runtime-contract.ts',
  'src/runtime/plugins/browser-provider-registry.ts',
  'src/runtime/plugins/browser-session-types.ts',
]) {
  requireText(path, '@deprecated C0 compatibility shim');
  if (text(path).split(/\r?\n/).length > 6) failures.push(`${path} must remain a thin C0 compatibility facade`);
}
for (const path of sourceFiles('src/runtime/plugins')) {
  if (['src/runtime/plugins/browser-runtime-contract.ts', 'src/runtime/plugins/browser-provider-registry.ts', 'src/runtime/plugins/browser-session-types.ts'].includes(path)) continue;
  forbid(path, /from\s+['"]\.\/browser-(?:runtime-contract|provider-registry|session-types)['"]/, 'active Browser runtime code must consume plugin-runtime/protocol Browser contracts, not retired local owners');
}
requireText('packages/plugin-runtime/browser/session-authority.ts', 'export interface BrowserSessionAuthorityPort');
forbid('packages/plugin-runtime/browser/session-authority.ts', /sqlite|control-plane|src\/runtime|adapters\//, 'Browser session authority port must not own persistence implementation');
requireText('adapters/browser/sqlite-session-authority.ts', 'createSqliteBrowserSessionAuthority');
requireText('src/runtime/root/browser-session-composition.ts', 'createSqliteBrowserSessionAuthority');
requireText('src/runtime/plugins/browser-session-authority.ts', '@deprecated C0 compatibility shim');
if (text('src/runtime/plugins/browser-session-authority.ts').split(/\r?\n/).length > 26) failures.push('src/runtime/plugins/browser-session-authority.ts must remain a thin C0 compatibility facade');
for (const path of sourceFiles('src/runtime/plugins')) {
  if (path === 'src/runtime/plugins/browser-session-authority.ts') continue;
  forbid(path, /from\s+['"]\.\/browser-session-authority['"]/, 'active Browser runtime code must consume the composed BrowserSessionAuthorityPort, not the retired authority owner');
}
requireText('src/runtime/plugins/browser-registration.ts', 'export const browserPluginAdapter');
requireText('src/runtime/plugins/first-party-registry.ts', "from './browser-registration'");
forbid('src/runtime/plugins/first-party-registry.ts', /from\s+['"]\.\/browser-adapter['"]/, 'first-party registry must depend on the thin Browser registration entrypoint, not the action implementation');
forbid('src/runtime/plugins/browser-adapter.ts', /export\s+const\s+browserPluginAdapter/, 'Browser action implementation must not also own first-party plugin registration');
if (text('src/runtime/plugins/browser-registration.ts').split(/\r?\n/).length > 20) failures.push('src/runtime/plugins/browser-registration.ts must remain a thin registration adapter');

if (failures.length) {
  console.error('[runtime-architecture] FAILED');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log(`[runtime-architecture] OK (${required.length} required modules/documents checked)`);
