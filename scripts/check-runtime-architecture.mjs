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
  const files = [];
  for (const entry of readdirSync(resolve(root, directory), { withFileTypes: true })) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) files.push(...sourceFiles(path));
    else if (entry.isFile() && path.endsWith('.ts')) files.push(path);
  }
  return files;
}

function relativeStaticTypeScriptDependencyGraph(directory = 'src') {
  let ts;
  try {
    ts = createRequire(import.meta.url)('typescript');
  } catch (error) {
    failures.push(`TypeScript dependency is required for architecture import-cycle analysis: ${error instanceof Error ? error.message : String(error)}`);
    return new Map();
  }

  const files = sourceFiles(directory).sort();
  const known = new Set(files);
  const graph = new Map(files.map((path) => [path, new Set()]));

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

  for (const path of files) {
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
  const graph = relativeStaticTypeScriptDependencyGraph('src');
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
    failures.push(`docs/architecture/${name} must be merged into CURRENT.md/EVOLUTION.md or deleted instead of acting as parallel root architecture authority; Git history is the archive`);
  }
}

for (const path of ['README.md', 'docs/ROADMAP.md', 'docs/architecture/CURRENT.md', 'docs/architecture/index.md']) {
  forbid(path, /\/Users\//, 'maintained documentation must not contain personal absolute macOS paths');
  forbid(path, /\bRepo Harness\b/i, 'maintained documentation must use the current Forge product identity');
  forbid(path, /(?:^|\n)\s*(?:>\s*)?(?:\*\*)?Status(?:\*\*)?\s*:\s*[^\n]*(?:implementation in progress|Phase\s+\d+)/i, 'maintained documentation must not carry transient execution status; use Plan/Work/evidence or history');
}

const required = [
  'src/runtime/gateway/mcp/router.ts',
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
  'src/cli/mcp/tool-contract.ts',
  'src/cli/github/contracts.ts',
  'src/runtime/gateway/mcp/runtime-tool-definitions.ts',
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
requireText('src/runtime/gateway/mcp/runtime-tools.ts', 'executeWorkVerification({');
requireText('src/cli/local-bridge/facade-api.ts', 'executeWorkVerification({');
forbid(
  'src/cli/local-bridge/facade-api.ts',
  /runControllerCheck\s*\(/,
  'Local Bridge Work verification must use the canonical persisted Work verification service',
);
forbid(
  'src/runtime/gateway/mcp/runtime-tools.ts',
  /function\s+classifyTerminalCheckEvidence\s*\(/,
  'terminal Check evidence classification belongs to Process Runtime, not the Gateway transport',
);
forbid(
  'src/runtime/control-plane/execution/work-verification-service.ts',
  /runControllerCheck\s*\(/,
  'route Work verification through persisted Process Runtime instead of synchronous check execution',
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
  if (path === 'src/runtime/control-plane/facade/work-contract-store.ts' || path === 'src/runtime/control-plane/execution/work-completion-authority.ts') continue;
  forbid(
    path,
    /\brecordWorkCompletionReceipt\s*\(/,
    'route Work completion through the canonical work-completion-authority instead of writing terminal receipts directly',
  );
}
requireText('src/runtime/control-plane/execution/work-finalization-service.ts', 'completeWorkWithReceipt(');
requireText('src/runtime/gateway/mcp/execution-tools.ts', 'resetFinalizationStagesForRequest');
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
  'src/runtime/gateway/mcp/runtime-tools.ts',
  /\b(?:createRequirement|resumeRetainedCancelledWorkContract)\s*\(/,
  'keep Requirement admission and retained-cancelled Work lifecycle authority out of the MCP transport',
);
forbid(
  'src/runtime/gateway/mcp/runtime-tools.ts',
  /\b(?:updateWorkContract|writeWorkHandle)\s*\(/,
  'keep WorkContract/WorkHandle persistence policy out of the MCP transport',
);
forbid(
  'src/runtime/gateway/mcp/execution-tools.ts',
  /\bcreateWorkContract\s*\(/,
  'route compatibility work preparation through canonical Work admission authority',
);
forbid(
  'src/cli/mcp/legacy-tool-service.ts',
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
requireMissing('docs/architecture/history/global-hook-runtime.md');
requireMissing('docs/architecture/history/ios-semantic-automation-provider-v2.md');
requireMissing('docs/architecture/history/chatgpt-handoff-facade.md');
requireMissing('docs/architecture/history/README.md');
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
const server = text('src/cli/mcp/server.ts');
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
  'src/runtime/gateway/mcp/router.ts',
  /\bcreateExecutionJob\b|\bgetExecutionJob\b/,
  'Gateway Router must not retain dormant ExecutionJob creation or lookup paths',
);
requireText('src/runtime/gateway/mcp/router.ts', 'executionJobCreationRetired');
requireText('src/runtime/gateway/mcp/router.ts', "'EXECUTION_JOB_RETIRED'");
requireText('src/runtime/gateway/mcp/execution-tools.ts', 'isDurableWorkOperation');
requireText('src/runtime/gateway/mcp/execution-tools.ts', "'work_execute'");
requireText('src/runtime/gateway/mcp/execution-tools.ts', "'work_validate'");
requireText('src/runtime/gateway/mcp/execution-tools.ts', "'work_finalize'");
requireText('src/runtime/execution/workers/executor.ts', 'executeWork(runtimeContext');
requireText('src/runtime/execution/workers/executor.ts', 'validateWork(runtimeContext');
requireText('src/runtime/execution/workers/executor.ts', 'finalizeWork(runtimeContext');
forbid(
  'src/runtime/execution/workers/executor.ts',
  /gateway\/mcp\/execution-tools|callExecutionTool\s*\(/,
  'Execution Worker must invoke control-plane Work application services directly, never MCP transport',
);
requireText('src/runtime/execution/workers/executor.ts', '__from_durable_worker');
requireText('src/runtime/gateway/mcp/runtime-tools.ts', 'managedProcessOperationDigest');
forbid(
  'src/runtime/gateway/mcp/runtime-tools.ts',
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
  'src/cli/mcp/repository-tools.ts',
  /\bsubmitLocalBridgeJob\b|\bexecuteLocalBridgeJob\b|\bwaitForRepositoryCommandHandoff\b/,
  'Repository command MCP fallback must use Process Runtime or an external-Controller handoff, never Local Bridge Jobs',
);
forbid(
  'src/cli/mcp/legacy-tool-service.ts',
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
  'src/cli/mcp/legacy-tool-service.ts',
  /\bretryAgentJob\b/,
  'Legacy MCP must not call Agent Run retry',
);
forbid('src/runtime/gateway/mcp/router.ts', /Use process_get \/ process_wait \/ process_logs/, 'Gateway follow-up instructions must use an always-exposed neutral Work facade');
requireMatch(
  'src/runtime/gateway/mcp/router.ts',
  /const DIRECT_REPOSITORY_TOOLS = new Set\(\[[\s\S]*?'repository_list'[\s\S]*?'repository_get'[\s\S]*?'repository_workbench'[\s\S]*?\]\);/,
  'declare DIRECT_REPOSITORY_TOOLS with repository_list, repository_get, and repository_workbench',
);
requireText('src/runtime/gateway/mcp/runtime-tools.ts', "case 'controller_context'");
requireText('src/runtime/gateway/mcp/runtime-tools.ts', "case 'local_bridge_status'");
requireText('src/runtime/gateway/mcp/runtime-tools.ts', 'readAgentExecutableReadinessSnapshot');
requireText('src/runtime/gateway/mcp/runtime-tools.ts', 'connectorExposedTools');
requireText('src/runtime/gateway/mcp/runtime-tools.ts', 'currentCallableTools');
forbid('src/runtime/gateway/mcp/runtime-tools.ts', /inspectAgentExecutableReadiness|resolveAgentExecutable|writeAgentExecutableReadinessSnapshot/, 'Gateway readiness must only read the Daemon-produced Agent executable snapshot');
forbidBetween(
  'src/runtime/gateway/mcp/runtime-tools.ts',
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
requireText('src/runtime/gateway/mcp/runtime-tools.ts', 'CONTEXT_PROJECTION_SOURCE_MISMATCH');
forbid('src/runtime/gateway/mcp/router.ts', /const DIRECT_HOT_READ_TOOLS = new Set\([\s\S]*?['"]controller_context['"][\s\S]*?\);/, 'controller_context must use a materialized projection or Durable Job, never the legacy Gateway path');
forbid('src/runtime/gateway/mcp/router.ts', /const DIRECT_HOT_READ_TOOLS = new Set\([\s\S]*?['"](?:local_bridge_status|get_local_job|get_local_job_output)['"][\s\S]*?\);/, 'Local Bridge observations must use bounded snapshots, never reconciliation in the Gateway');
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
forbid('src/runtime/gateway/mcp/router.ts', /Math\.min\(\s*typeof args\.timeout_ms[\s\S]{0,140}?,\s*120_000\s*\)/, 'Agent parent timeout must never silently truncate timeout_ms to 120 seconds');
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
requireText('src/runtime/workflow/schedules/store.ts', "'occurrences.json'");
requireText('src/runtime/projections/git-status-sampler.ts', 'writeRepositoryGitStatusSample');
requireText('src/runtime/projections/git-status-sampler.ts', 'readRepositoryGitStatusSample');
requireText('src/cli/mcp/repository-tools.ts', 'readRepositoryGitStatusSample');
requireText('src/cli/mcp/repository-tools.ts', 'args.refresh === true');
forbidBetween(
  'src/cli/mcp/repository-tools.ts',
  "case 'repository_git_status':",
  "case 'repository_git_diff':",
  /repositoryGitStatus\s*\(/,
  'repository_git_status must default to daemon samples; live refresh must be explicit and sampled',
);
requireText('src/runtime/control-plane/execution/session-store.ts', 'lastValidatedAt: now');
requireText('src/runtime/control-plane/execution/validation.ts', 'warnings.push');
requireText('src/runtime/control-plane/execution/work-handle-store.ts', "failed: ['validating', 'editing', 'committed', 'merged', 'cleaned', 'failed_terminal_cleanup']");
requireText('src/runtime/gateway/mcp/execution-tools.ts', "from '../../control-plane/execution/work-finalization-service'");
requireText('src/runtime/gateway/mcp/execution-tools.ts', "from '../../control-plane/execution/work-preparation-service'");
requireText('src/runtime/gateway/mcp/execution-tools.ts', "from '../../control-plane/execution/work-operation-service'");
requireText('src/runtime/gateway/mcp/execution-tools.ts', 'Compatibility exports: implementation authority lives in control-plane execution.');
requireText('src/runtime/gateway/mcp/execution-tools.ts', 'resetFinalizationStagesForRequest,');
requireText('src/runtime/gateway/mcp/execution-tools.ts', 'selectDefaultWorkValidationChecks');
requireText('src/runtime/gateway/mcp/runtime-tools.ts', "callExecutionTool(ctx, 'work_finalize'");
forbid(
  'src/runtime/gateway/mcp/runtime-tools.ts',
  /repositoryGit(?:Commit|FinishWorkflow|MergeBranch|DeleteBranch|RebaseOnto)\s*\(/,
  'rh_work facade finalization must delegate to the canonical Work finalization application service instead of performing Git delivery itself',
);
forbid(
  'src/runtime/gateway/mcp/execution-tools.ts',
  /function\s+finalizeWork\s*\(/,
  'MCP execution transport must delegate Work finalization to the control-plane application service',
);
forbid(
  'src/runtime/gateway/mcp/execution-tools.ts',
  /function\s+(?:prepareWork|adoptExistingWorkHead)\s*\(/,
  'MCP execution transport must delegate Work preparation/adoption to the control-plane application service',
);
forbid(
  'src/runtime/gateway/mcp/execution-tools.ts',
  /function\s+(?:executeWork|validateWork)\s*\(/,
  'MCP execution transport must delegate Work execute/validate operations to the control-plane application service',
);
forbid(
  'src/runtime/gateway/mcp/execution-tools.ts',
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
requireText('src/runtime/workflow/schedules/types.ts', "'repository-event'");
requireText('src/runtime/workflow/schedules/types.ts', "'dependency-checkpoint'");
requireText('src/runtime/workflow/schedules/store.ts', 'saveScheduleDecision');
requireText('src/runtime/workflow/schedules/settlement.ts', 'backoffMinutes');
requireText('src/runtime/release/release-gate.ts', 'releaseReady');
requireText('src/cli/mcp/transports/http.ts', "'/ready'");
requireText('src/cli/mcp/transports/http.ts', "'/repos/:repoId/health'");
requireText('src/runtime/control-plane/governance/external-effects.ts', 'EXTERNAL_EFFECT_AUTHORIZATION_REQUIRED');
requireText('src/runtime/control-plane/governance/external-effects.ts', 'AUTOMATED_REQUIREMENT_REQUIRES_CANDIDATE');
requireText('src/cli/mcp/tools.ts', "export * from './legacy-tool-service'");

for (const path of [
  'src/runtime/gateway/mcp/router.ts',
  'src/runtime/gateway/mcp/runtime-tools.ts',
  'src/runtime/control-plane/global-scheduler/scheduler.ts',
  'src/runtime/control-plane/repo-actor/actor.ts',
  'src/runtime/workflow/schedules/engine.ts',
  'src/runtime/workflow/schedules/work-continuation.ts',
  'src/cli/mcp/transports/http.ts',
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
if (text('src/cli/mcp/tools.ts').split(/\r?\n/).length > 40) failures.push('src/cli/mcp/tools.ts must remain a thin compatibility facade');

if (failures.length) {
  console.error('[runtime-architecture] FAILED');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log(`[runtime-architecture] OK (${required.length} required modules/documents checked)`);
