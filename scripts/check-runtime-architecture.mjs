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

let typeScriptCompiler;
let typeScriptCompilerLoadAttempted = false;
function loadTypeScriptCompiler() {
  if (typeScriptCompilerLoadAttempted) return typeScriptCompiler;
  typeScriptCompilerLoadAttempted = true;
  try {
    typeScriptCompiler = createRequire(import.meta.url)('typescript');
  } catch (error) {
    failures.push(`TypeScript dependency is required for architecture import analysis: ${error instanceof Error ? error.message : String(error)}`);
  }
  return typeScriptCompiler;
}

const WORK_LIFECYCLE_PATCH_FIELDS = new Set(['status', 'phase', 'dispatchState', 'evidenceState', 'workKind']);

function unwrapTypeScriptExpression(ts, node) {
  let current = node;
  while (ts.isParenthesizedExpression(current)
      || ts.isAsExpression(current)
      || ts.isTypeAssertionExpression(current)
      || ts.isNonNullExpression(current)
      || (typeof ts.isSatisfiesExpression === 'function' && ts.isSatisfiesExpression(current))) {
    current = current.expression;
  }
  return current;
}

function staticTypeScriptPropertyName(ts, name) {
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) return name.text;
  if (ts.isComputedPropertyName(name) && ts.isStringLiteralLike(name.expression)) return name.expression.text;
  return undefined;
}

function inlineWorkLifecyclePatchFields(ts, node) {
  const expression = unwrapTypeScriptExpression(ts, node);
  if (!ts.isObjectLiteralExpression(expression)) return [];
  const fields = new Set();
  for (const property of expression.properties) {
    if (ts.isSpreadAssignment(property)) {
      for (const field of inlineWorkLifecyclePatchFields(ts, property.expression)) fields.add(field);
      continue;
    }
    if (!(ts.isPropertyAssignment(property)
        || ts.isShorthandPropertyAssignment(property)
        || ts.isMethodDeclaration(property)
        || ts.isGetAccessorDeclaration(property)
        || ts.isSetAccessorDeclaration(property))) continue;
    const name = staticTypeScriptPropertyName(ts, property.name);
    if (name && WORK_LIFECYCLE_PATCH_FIELDS.has(name)) fields.add(name);
  }
  return [...fields].sort();
}

function genericWorkLifecycleMutationRecords(files) {
  const ts = loadTypeScriptCompiler();
  if (!ts) return [];
  const records = [];
  for (const path of [...files].sort()) {
    const sourceFile = ts.createSourceFile(path, text(path), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    function visit(node) {
      if (ts.isCallExpression(node) && node.arguments.length >= 3) {
        const callee = node.expression;
        const callName = ts.isIdentifier(callee)
          ? callee.text
          : ts.isPropertyAccessExpression(callee)
            ? callee.name.text
            : undefined;
        if (callName === 'updateWorkContract') {
          const fields = inlineWorkLifecyclePatchFields(ts, node.arguments[2]);
          if (fields.length > 0) {
            const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
            records.push({ path, line: line + 1, fields });
          }
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(sourceFile);
  }
  return records;
}

function staticTypeScriptImportRecords(files) {
  const ts = loadTypeScriptCompiler();
  if (!ts) return [];
  const records = [];
  for (const path of [...files].sort()) {
    const sourceFile = ts.createSourceFile(path, text(path), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    function visit(node) {
      let specifier;
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
          && node.moduleSpecifier
          && ts.isStringLiteralLike(node.moduleSpecifier)) {
        specifier = node.moduleSpecifier.text;
      } else if (ts.isImportEqualsDeclaration(node)
          && ts.isExternalModuleReference(node.moduleReference)
          && node.moduleReference.expression
          && ts.isStringLiteralLike(node.moduleReference.expression)) {
        specifier = node.moduleReference.expression.text;
      } else if (ts.isCallExpression(node)
          && node.expression.kind === ts.SyntaxKind.ImportKeyword
          && node.arguments.length === 1
          && ts.isStringLiteralLike(node.arguments[0])) {
        specifier = node.arguments[0].text;
      }
      if (specifier) records.push({ from: path, specifier });
      ts.forEachChild(node, visit);
    }
    visit(sourceFile);
  }
  return records;
}

function staticTypeScriptDependencyGraph(files) {
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

  for (const { from, specifier } of staticTypeScriptImportRecords(orderedFiles)) {
    const target = resolveTypeScriptImport(from, specifier);
    if (target) graph.get(from).add(target);
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

function requireExactShrinkingInventory(label, actual, allowed) {
  for (const entry of actual) {
    if (!allowed.has(entry)) failures.push(`${label} introduced forbidden entry: ${entry}`);
  }
  for (const entry of allowed) {
    if (!actual.has(entry)) failures.push(`${label} allowlist contains retired entry; remove it so the debt ledger only shrinks: ${entry}`);
  }
}

// Stage 4 boundary: rh_work is an ABI/translation adapter. Durable lifecycle
// ownership stays in Kernel/application services and physical WorkHandle state
// may not be persisted from the MCP adapter.
requireText('adapters/mcp/runtime-gateway/runtime-tools.ts', "if (name === 'rh_work') return callWorkAdapter(ctx, args);");
requireText('adapters/mcp/runtime-gateway/controller-authority-adapter.ts', 'controllerTerminalizationAuthorityForInvocation');
requireText('adapters/mcp/runtime-gateway/controller-authority-adapter.ts', 'assertControllerRoundInvocationAuthority');
requireText('adapters/mcp/runtime-gateway/work-controller-operations.ts', 'export async function callRhWorkControllerOperation');
requireText('adapters/mcp/runtime-gateway/work-adapter.ts', 'callRhWorkControllerOperation(ctx, repository, operation, args)');
forbid('adapters/mcp/runtime-gateway/work-adapter.ts', /operation === ['"](?:controller_get_owner|controller_claim|controller_disposition|controller_release|launcher_start)['"]/, 'rh_work compatibility adapter must delegate ControllerRound/Launcher operation orchestration to work-controller-operations');
requireText('adapters/mcp/runtime-gateway/work-requirement-operations.ts', 'export async function callRhWorkRequirementOperation');
requireText('adapters/mcp/runtime-gateway/work-requirement-operations.ts', 'admitRequirement');
requireText('adapters/mcp/runtime-gateway/work-requirement-operations.ts', 'continueRequirement');
requireText('adapters/mcp/runtime-gateway/work-requirement-operations.ts', 'promoteRequirementCandidate');
requireText('adapters/mcp/runtime-gateway/work-adapter.ts', 'callRhWorkRequirementOperation(ctx, repository, operation, requirementOperationArgs)');
forbid('adapters/mcp/runtime-gateway/work-adapter.ts', /if\s*\(\s*operation === ['"](?:requirement_create|requirement_promote_candidate|requirement_continue)['"]/, 'rh_work compatibility adapter must delegate Requirement operation orchestration to work-requirement-operations');
requireText('adapters/mcp/runtime-gateway/work-plan-operations.ts', 'export async function callRhWorkPlanOperation');
requireText('adapters/mcp/runtime-gateway/work-plan-operations.ts', 'export async function callRhWorkPlanCreateOperation');
forbid('adapters/mcp/runtime-gateway/work-plan-operations.ts', /approvePlanContractAsync|acceptPlanStepEvidence/, 'legacy plan_approve/plan_accept_step must stay a bounded compatibility read instead of a Plan lifecycle writer');
requireText('adapters/mcp/runtime-gateway/work-plan-operations.ts', 'supersedePlanContract');
requireText('adapters/mcp/runtime-gateway/work-plan-operations.ts', 'resolvePlanAdmission');
requireText('adapters/mcp/runtime-gateway/work-plan-operations.ts', 'admitPlanContractAsync');
requireText('adapters/mcp/runtime-gateway/work-adapter.ts', 'callRhWorkPlanOperation(store, operation, args)');
requireText('adapters/mcp/runtime-gateway/work-adapter.ts', 'callRhWorkPlanCreateOperation(store, operation, args');
forbid('adapters/mcp/runtime-gateway/work-adapter.ts', /if\s*\(\s*operation === ['"](?:plan_list|plan_get|plan_approve|plan_supersede|plan_create)['"]/, 'rh_work compatibility adapter must delegate Plan transport/admission orchestration to work-plan-operations');
forbid('adapters/mcp/runtime-gateway/work-adapter.ts', /\b(?:transitionWorkHandle|writeWorkHandle|markWorkHandleFailed)\s*\(/, 'rh_work adapter must not persist WorkHandle lifecycle state; use the canonical completion/finalization authority');
forbid('adapters/mcp/runtime-gateway/work-adapter.ts', /control-plane\/facade\/work-contract-store|kernel\/work\/infrastructure/, 'rh_work adapter must consume canonical Work application/API authority, not persistence infrastructure');
forbid('adapters/mcp/runtime-gateway/work-adapter.ts', /\b(?:appendWorkEvidence|recordWorkCompletionReceipt|updateWorkContract)\s*\(/, 'rh_work adapter must not write Work lifecycle/evidence records directly');
forbid('adapters/mcp/runtime-gateway/work-adapter.ts', /\b(?:createRequirement|resumeRetainedCancelledWorkContract|acceptRequirementOutcome)\s*\(/, 'rh_work adapter must delegate Requirement and retained-Work lifecycle transitions to canonical application authorities');
forbid('adapters/mcp/runtime-gateway/work-adapter.ts', /function\s+(?:assert|evaluate|derive)[A-Za-z0-9_]*ImplementationReview/, 'rh_work adapter must not implement implementation-review policy authority');
forbid('adapters/mcp/runtime-gateway/work-adapter.ts', /repositoryGit(?:Commit|FinishWorkflow|MergeBranch|DeleteBranch|RebaseOnto)\s*\(/, 'rh_work adapter must delegate physical Git delivery to canonical Work finalization authority');

// #197 MCP mega-adapter decomposition. These are debt ledgers, not target
// architecture: entries may only disappear. New domain-authority imports or
// switch cases must be implemented in the owning domain adapter/application API,
// never added to runtime-tools/router while decomposition is in progress.
const MCP_GATEWAY_AUTHORITY_IMPORT_PATTERN = /(?:packages\/kernel\/|src\/runtime\/|src\/cli\/(?:repositories|editing)\/)/;

function gatewayAuthorityImportInventoryFromSources(sources, importPattern = MCP_GATEWAY_AUTHORITY_IMPORT_PATTERN) {
  const ts = loadTypeScriptCompiler();
  if (!ts) return new Set();
  const records = new Set();
  for (const { path, source } of sources) {
    const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    function visit(node) {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
          && node.moduleSpecifier
          && ts.isStringLiteralLike(node.moduleSpecifier)
          && importPattern.test(node.moduleSpecifier.text)) {
        records.add(`${path}::${node.moduleSpecifier.text}`);
      }
      ts.forEachChild(node, visit);
    }
    visit(sourceFile);
  }
  return records;
}

function runtimeToolSwitchCaseInventory(source) {
  const marker = 'export async function callRuntimeTool';
  const start = source.indexOf(marker);
  if (start < 0) return new Set();
  return new Set([...source.slice(start).matchAll(/case\s+['"]([^'"]+)['"]\s*:/g)].map((match) => match[1]));
}

const MCP_RUNTIME_GATEWAY_AUTHORITY_IMPORT_DEBT = new Set([
  'adapters/mcp/runtime-gateway/runtime-tools.ts::../../../src/runtime/execution/process-runtime/check-result',
]);

const MCP_RUNTIME_TOOLS_SWITCH_CASE_DEBT = new Set();

const mcpAdapterBoundaryFixture = process.env.FORGE_MCP_RUNTIME_ADAPTER_BOUNDARY_FIXTURE;
if (mcpAdapterBoundaryFixture) {
  const fixture = JSON.parse(mcpAdapterBoundaryFixture);
  const sources = Array.isArray(fixture.sources) ? fixture.sources : [];
  requireExactShrinkingDebt(
    'MCP runtime adapter authority-import fixture debt',
    gatewayAuthorityImportInventoryFromSources(sources),
    new Set(Array.isArray(fixture.allowedImports) ? fixture.allowedImports : []),
  );
  const runtimeSource = sources.find((entry) => entry.path === 'adapters/mcp/runtime-gateway/runtime-tools.ts')?.source ?? '';
  requireExactShrinkingInventory(
    'MCP runtime-tools switch-case fixture debt',
    runtimeToolSwitchCaseInventory(runtimeSource),
    new Set(Array.isArray(fixture.allowedCases) ? fixture.allowedCases : []),
  );
  if (failures.length) {
    console.error('[mcp-runtime-adapter-boundary-guardrail] FAILED');
    for (const failure of failures) console.error(`- ${failure}`);
    process.exit(1);
  }
  console.log('[mcp-runtime-adapter-boundary-guardrail] OK');
  process.exit(0);
}

requireExactShrinkingDebt(
  'MCP runtime mega-adapter direct domain-authority import debt',
  gatewayAuthorityImportInventoryFromSources([
    { path: 'adapters/mcp/runtime-gateway/runtime-tools.ts', source: text('adapters/mcp/runtime-gateway/runtime-tools.ts') },
    { path: 'adapters/mcp/runtime-gateway/router.ts', source: text('adapters/mcp/runtime-gateway/router.ts') },
  ]),
  MCP_RUNTIME_GATEWAY_AUTHORITY_IMPORT_DEBT,
);
requireExactShrinkingInventory(
  'MCP runtime-tools switch-case debt',
  runtimeToolSwitchCaseInventory(text('adapters/mcp/runtime-gateway/runtime-tools.ts')),
  MCP_RUNTIME_TOOLS_SWITCH_CASE_DEBT,
);

const MCP_PURE_TRANSPORT_FORBIDDEN_IMPORT_PATTERN = /(?:packages\/kernel\/|src\/runtime\/)/;
requireExactShrinkingDebt(
  'MCP pure transport adapter authority imports',
  gatewayAuthorityImportInventoryFromSources([
    { path: 'adapters/mcp/runtime-gateway/shared-adapter.ts', source: text('adapters/mcp/runtime-gateway/shared-adapter.ts') },
    { path: 'adapters/mcp/runtime-gateway/result-adapter.ts', source: text('adapters/mcp/runtime-gateway/result-adapter.ts') },
  ], MCP_PURE_TRANSPORT_FORBIDDEN_IMPORT_PATTERN),
  new Set(),
);

const FROZEN_CAPABILITY_PREFIX_FILES = [
  'adapters/mcp/runtime-gateway/runtime-tools.ts',
  'adapters/mcp/runtime-gateway/work-adapter.ts',
  'adapters/mcp/runtime-gateway/work-input-compatibility.ts',
  'adapters/mcp/runtime-gateway/work-controller-recovery-operations.ts',
  'adapters/mcp/runtime-gateway/work-plan-repair-operations.ts',
  'adapters/mcp/controller-round-compatibility.ts',
  'adapters/mcp/frozen-client-semantic-compatibility.ts',
];
const CANONICAL_FROZEN_SEMANTIC_PREFIX = 'semantic.v1:';

function frozenCapabilityPrefixRecordsFromSources(sources) {
  const records = new Set();
  const protocolLiteral = /(['"`])([a-z][a-z0-9_-]*(?:\.[a-z0-9_-]+)+:)\1/g;
  for (const { path, source } of sources) {
    for (const match of source.matchAll(protocolLiteral)) {
      const prefix = match[2];
      if (prefix === CANONICAL_FROZEN_SEMANTIC_PREFIX) continue;
      records.add(`${path}::${prefix}`);
    }
  }
  return records;
}

const capabilityPrefixFixture = process.env.FORGE_CAPABILITY_PREFIX_GUARDRAIL_FIXTURE;
if (capabilityPrefixFixture) {
  const fixture = JSON.parse(capabilityPrefixFixture);
  const actual = frozenCapabilityPrefixRecordsFromSources(Array.isArray(fixture.sources) ? fixture.sources : []);
  const allowed = new Set(Array.isArray(fixture.allowed) ? fixture.allowed : []);
  requireExactShrinkingInventory('frozen capability prefix fixture debt', actual, allowed);
  if (failures.length) {
    console.error('[frozen-capability-prefix-guardrail] FAILED');
    for (const failure of failures) console.error(`- ${failure}`);
    process.exit(1);
  }
  console.log(`[frozen-capability-prefix-guardrail] OK (${actual.size} debt entries)`);
  process.exit(0);
}

const LEGACY_FROZEN_CAPABILITY_PREFIX_DEBT = new Set([
  'adapters/mcp/runtime-gateway/work-controller-recovery-operations.ts::controller.authority.recover:',
  'adapters/mcp/runtime-gateway/work-controller-recovery-operations.ts::controller.provider.recover:',
  'adapters/mcp/runtime-gateway/work-plan-repair-operations.ts::plan.step.retry:',
  'adapters/mcp/runtime-gateway/work-input-compatibility.ts::schedule.delete:',
  'adapters/mcp/runtime-gateway/work-input-compatibility.ts::work.review:',
  'adapters/mcp/controller-round-compatibility.ts::controller.disposition:',
  'adapters/mcp/controller-round-compatibility.ts::controller.round:',
  'adapters/mcp/controller-round-compatibility.ts::plan.obligations.v1:',
]);
requireExactShrinkingInventory(
  'legacy frozen capability prefix debt',
  frozenCapabilityPrefixRecordsFromSources(FROZEN_CAPABILITY_PREFIX_FILES.map((path) => ({ path, source: text(path) }))),
  LEGACY_FROZEN_CAPABILITY_PREFIX_DEBT,
);

const SEMANTIC_AUTHORITY_CRITICAL_ROOTS = [
  'packages/kernel',
  'src/runtime/control-plane',
  'src/runtime/execution',
  'adapters/mcp/runtime-gateway',
  'src/cli/local-bridge',
];
const HUMAN_READABLE_SEMANTIC_FIELDS = new Set(['message', 'reason', 'description', 'checkId', 'check_id']);
const HUMAN_READABLE_STRING_MATCH_METHODS = new Set(['includes', 'startsWith', 'endsWith', 'match', 'search']);

function humanReadableSemanticExpression(ts, node) {
  if (ts.isIdentifier(node)) return HUMAN_READABLE_SEMANTIC_FIELDS.has(node.text);
  if (ts.isPropertyAccessExpression(node)) return HUMAN_READABLE_SEMANTIC_FIELDS.has(node.name.text);
  if (ts.isElementAccessExpression(node)
      && node.argumentExpression
      && ts.isStringLiteralLike(node.argumentExpression)) {
    return HUMAN_READABLE_SEMANTIC_FIELDS.has(node.argumentExpression.text);
  }
  if (ts.isParenthesizedExpression(node)
      || ts.isAsExpression(node)
      || ts.isTypeAssertionExpression(node)
      || ts.isNonNullExpression(node)) {
    return humanReadableSemanticExpression(ts, node.expression);
  }
  if (ts.isConditionalExpression(node)) {
    return humanReadableSemanticExpression(ts, node.whenTrue)
      || humanReadableSemanticExpression(ts, node.whenFalse);
  }
  if (ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && ['trim', 'toLowerCase', 'toUpperCase'].includes(node.expression.name.text)) {
    return humanReadableSemanticExpression(ts, node.expression.expression);
  }
  return false;
}

function isHumanReadableSemanticMatcherCall(ts, node) {
  if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return false;
  const method = node.expression.name.text;
  if (HUMAN_READABLE_STRING_MATCH_METHODS.has(method)
      && humanReadableSemanticExpression(ts, node.expression.expression)) return true;
  return method === 'test' && node.arguments.some((argument) => humanReadableSemanticExpression(ts, argument));
}

function semanticAuthorityStringMatchRecordsFromSources(sources) {
  const ts = loadTypeScriptCompiler();
  if (!ts) return new Set();
  const records = new Set();
  for (const { path, source } of [...sources].sort((left, right) => left.path.localeCompare(right.path))) {
    const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    function collectCondition(expression) {
      function visitCondition(node) {
        if (isHumanReadableSemanticMatcherCall(ts, node)) {
          records.add(`${path}::${node.getText(sourceFile).replace(/\s+/g, ' ').trim()}`);
        }
        ts.forEachChild(node, visitCondition);
      }
      visitCondition(expression);
    }
    function visit(node) {
      if (ts.isIfStatement(node) || ts.isWhileStatement(node) || ts.isDoStatement(node)) collectCondition(node.expression);
      else if (ts.isConditionalExpression(node)) collectCondition(node.condition);
      else if (ts.isForStatement(node) && node.condition) collectCondition(node.condition);
      ts.forEachChild(node, visit);
    }
    visit(sourceFile);
  }
  return records;
}

function semanticAuthorityProductionStringMatchRecords() {
  const paths = SEMANTIC_AUTHORITY_CRITICAL_ROOTS.flatMap((directory) => sourceFiles(directory));
  return semanticAuthorityStringMatchRecordsFromSources(paths.map((path) => ({ path, source: text(path) })));
}

const LEGACY_INTERACTION_AUTHORITY_OWNER_DECLARATION = /\b(?:class|interface|type|function|const)\s+\w*(?:Browser|Desktop)\w*(?:Authority|Persistence)\b/;
function legacyInteractionAuthorityOwnerRecordsFromSources(sources) {
  const records = new Set();
  for (const { path, source } of sources) {
    for (const line of String(source).split('\n')) {
      if (LEGACY_INTERACTION_AUTHORITY_OWNER_DECLARATION.test(line)) records.add(`${path}::${line.trim()}`);
    }
  }
  return records;
}

const interactionAuthorityGuardrailFixture = process.env.FORGE_INTERACTION_AUTHORITY_GUARDRAIL_FIXTURE;
if (interactionAuthorityGuardrailFixture) {
  const fixture = JSON.parse(interactionAuthorityGuardrailFixture);
  const actual = legacyInteractionAuthorityOwnerRecordsFromSources(Array.isArray(fixture.sources) ? fixture.sources : []);
  if (actual.size > 0) {
    console.error('[interaction-authority-guardrail] FAILED');
    for (const record of actual) console.error(`- Browser/Desktop durable interaction authority must live only in Computer target authority: ${record}`);
    process.exit(1);
  }
  console.log('[interaction-authority-guardrail] OK');
  process.exit(0);
}

const semanticAuthorityGuardrailFixture = process.env.FORGE_SEMANTIC_AUTHORITY_GUARDRAIL_FIXTURE;
if (semanticAuthorityGuardrailFixture) {
  const fixture = JSON.parse(semanticAuthorityGuardrailFixture);
  const actual = semanticAuthorityStringMatchRecordsFromSources(Array.isArray(fixture.sources) ? fixture.sources : []);
  const allowed = new Set(Array.isArray(fixture.allowed) ? fixture.allowed : []);
  requireExactShrinkingInventory('semantic authority fixture debt', actual, allowed);
  if (failures.length) {
    console.error('[semantic-authority-guardrail] FAILED');
    for (const failure of failures) console.error(`- ${failure}`);
    process.exit(1);
  }
  console.log(`[semantic-authority-guardrail] OK (${actual.size} debt entries)`);
  process.exit(0);
}

const SEMANTIC_STRING_AUTHORITY_DEBT = new Set([
  `adapters/mcp/runtime-gateway/execution-tools.ts::message.includes(':')`,
  `adapters/mcp/runtime-gateway/process-tools.ts::message.includes(':')`,
  `adapters/mcp/runtime-gateway/context-adapter.ts::error.message.startsWith('PLUGIN_NOT_FOUND:')`,
  `packages/kernel/controller/domain/controller-round-transition-policy.ts::reason.startsWith('consecutive_failures:')`,
  `packages/kernel/controller/domain/controller-round-transition-policy.ts::reason.startsWith('repeated_state:')`,
  `packages/kernel/controller/domain/controller-round-transition-policy.ts::reason.startsWith('round_budget_exhausted:')`,
  `packages/kernel/controller/application/continuation-service.ts::error.message.startsWith('CONTROLLER_RELAY_ROUND_ALREADY_OPEN:')`,
  `src/cli/local-bridge/facade-api.ts::selection.reason.includes('Small')`,
  `src/cli/local-bridge/facade-api.ts::selection.reason.includes('small')`,
  `src/cli/local-bridge/job-store.ts::message.startsWith(\"LOCAL_JOB_ID_REQUIRED:\")`,
  `src/cli/local-bridge/job-store.ts::message.startsWith(\"LOCAL_JOB_PATH_INVALID:\")`,
  `src/cli/local-bridge/server.ts::message.startsWith(\"REPOSITORY_SELF_PROTECTED\")`,
  `src/runtime/control-plane/execution/work-execution-support.ts::reason.includes('infrastructure')`,
  `src/runtime/control-plane/execution/work-execution-support.ts::reason.includes('terminal')`,
  `src/runtime/control-plane/execution/work-execution-support.ts::reason.includes('timed out')`,
  `src/runtime/control-plane/execution/work-execution-support.ts::reason.includes('unavailable')`,
  `src/runtime/control-plane/execution/work-head-settlement.ts::error.message.includes('CONTROL_PLANE_REVISION_CONFLICT')`,
  `src/runtime/control-plane/facade/requirement-authority.ts::error.message.startsWith('REQUIREMENT_ALREADY_EXISTS:')`,
  `src/runtime/control-plane/global-scheduler/reconciliation.ts::message.includes(':')`,
  `src/runtime/control-plane/global-scheduler/reconciliation.ts::message.startsWith('WRITER_FENCED:')`,
  `src/runtime/control-plane/global-scheduler/scheduler.ts::error.message.startsWith('LOCK_HELD:')`,
  `src/runtime/control-plane/launcher/chatgpt-work-continuation.ts::error.message.includes(':')`,
  `src/runtime/control-plane/persistence/sqlite-store.ts::(error instanceof Error ? error.message : String(error)).startsWith('CONTROL_PLANE_SQLITE_BUSY:')`,
  `src/runtime/control-plane/persistence/sqlite-store.ts::/database is locked|SQLITE_BUSY/i.test(message)`,
  `src/runtime/control-plane/persistence/sqlite-store.ts::message.startsWith('CONTROL_PLANE_')`,
  `src/runtime/control-plane/persistence/sqlite-store.ts::message.startsWith('CONTROL_PLANE_SQLITE_CORRUPT:')`,
  `src/runtime/execution/jobs/store.ts::error.message.startsWith('WRITER_FENCED:')`,
  `src/runtime/execution/process-runtime/lightweight-managed.ts::error.message.startsWith('PROCESS_REQUEST_CONFLICT:')`,
  `src/runtime/execution/process-runtime/process-runner-entry.ts::message.startsWith('PROCESS_RUNNER_ALREADY_STARTED:')`,
  `src/runtime/execution/process-runtime/process-runner-entry.ts::message.startsWith('PROCESS_RUNNER_RECEIPT_CORRUPT:')`,
  `src/runtime/execution/thin-harness/fast-executor.ts::message.includes(':')`,
  `src/runtime/execution/thin-harness/fast-executor.ts::message.includes('\\0')`,
  `src/runtime/execution/thin-harness/fingerprint-worker.ts::error.message.startsWith('SNAPSHOT_BUDGET')`,
  `src/runtime/execution/thin-harness/fingerprint-worker.ts::message.startsWith('CANCELLED')`,
  `src/runtime/execution/thin-harness/fingerprint-worker.ts::message.startsWith('SNAPSHOT_BUDGET')`,
  `src/runtime/execution/thin-harness/fingerprint-worker.ts::message.startsWith('SNAPSHOT_TOO_DIRTY')`,
  `src/runtime/execution/thin-harness/fingerprint-worker.ts::message.startsWith('SNAPSHOT_WORKER_TIMEOUT')`,
  `src/runtime/execution/workers/executor.ts::message.startsWith('LEGACY_JOB_TIMEOUT:')`,
]);
requireExactShrinkingInventory(
  'human-readable semantic authority debt',
  semanticAuthorityProductionStringMatchRecords(),
  SEMANTIC_STRING_AUTHORITY_DEBT,
);

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
    failures.push(`docs/architecture/${name} must be merged into CURRENT.md/EVOLUTION.md or deleted instead of acting as parallel root architecture authority; Git history is the archive`);
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
  'src/runtime/control-plane/execution/content-equivalent-commit-authority.ts',
  'src/runtime/control-plane/execution/implementation-review-content.ts',
  'packages/protocols/handoff/status.ts',
  'packages/kernel/work/domain/admission-policy.ts',
  'packages/kernel/work/domain/implementation-review.ts',
  'packages/kernel/work/domain/state-machine.ts',
  'packages/kernel/identity/domain/scope.ts',
  'packages/kernel/memory/domain/operational-prior.ts',
  'packages/kernel/memory/api/index.ts',
  'packages/kernel/memory/index.ts',
  'src/runtime/evidence/operational-shadow.ts',
  'src/runtime/control-plane/persistence/operational-prior-store.ts',
  'evaluation/lib/shadow-operational-prior.ts',
  'packages/kernel/work/domain/check-receipt.ts',
  'packages/kernel/work/domain/execution-snapshot.ts',
  'packages/kernel/work/domain/repository-completion-receipt.ts',
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
// Operational priors retain their bounded mechanical consumers. The accepted
// assistant-loop ADR adds semantic experience through its own API/adapter;
// neither consumer may move persistence or semantic acceptance into the reducer.
const stage7fMemoryImports = staticTypeScriptImportRecords(productionTypeScriptFiles());
const stage7fKernelMemoryConsumers = new Set([
  'src/runtime/evidence/operational-shadow.ts',
  'src/runtime/control-plane/persistence/operational-prior-store.ts',
  'src/runtime/context/assistant-context.ts',
  'src/runtime/context/assistant-work-context.ts',
  'src/runtime/control-plane/persistence/experience-store.ts',
  'src/cli/commands/brain-assistant.ts',
]);
const stage7fOperationalStoreConsumers = new Set([
  'src/runtime/control-plane/execution/work-verification-service.ts',
  'src/runtime/execution/process-runtime/check-facade.ts',
]);
for (const { from, specifier } of stage7fMemoryImports) {
  if (from.startsWith('packages/kernel/memory/') && /(?:src\/runtime|control-plane|sqlite-store|context-plane)/.test(specifier)) {
    failures.push(`Stage7F Kernel Memory must remain pure and persistence-free: ${from} -> ${specifier}`);
  }
  if (/packages\/kernel\/memory/.test(specifier)
      && !stage7fKernelMemoryConsumers.has(from)
      && !from.startsWith('packages/kernel/memory/')) {
    failures.push(`Stage7F Memory has an unauthorized production consumer: ${from} -> ${specifier}`);
  }
  if (/operational-shadow/.test(specifier) && from !== 'src/runtime/control-plane/persistence/operational-prior-store.ts') {
    failures.push(`Stage7F typed operational extractor may feed only the derived persistence adapter: ${from} -> ${specifier}`);
  }
  if (/operational-prior-store/.test(specifier) && !stage7fOperationalStoreConsumers.has(from)) {
    failures.push(`Stage7F operational Memory store has an unauthorized active consumer: ${from} -> ${specifier}`);
  }
}
forbid('src/runtime/control-plane/persistence/operational-prior-store.ts', /context-plane|brain|pks|requirement-authority|plan-contract|work-state-machine|approval|authorization/, 'Stage7F operational Memory must remain mechanical derived state only');
requireText('src/runtime/control-plane/persistence/operational-prior-store.ts', "OPERATIONAL_MEMORY_NAMESPACE = 'operational_memory_prior'");
requireText('src/runtime/control-plane/persistence/operational-prior-store.ts', 'resolveCheckCompletionGraceWaitMs');
requireText('src/runtime/execution/process-runtime/check-facade.ts', 'resolveCheckCompletionGraceWaitMs');
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
requireText('adapters/mcp/runtime-gateway/work-adapter.ts', 'executeWorkVerification({');
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
requireText('packages/kernel/work/infrastructure/work-contract-store.ts', 'activateWorkContract');
requireText('packages/kernel/work/infrastructure/work-contract-store.ts', 'failWorkContract');
requireText('packages/kernel/work/infrastructure/work-contract-store.ts', 'cancelWorkContract');
requireText('packages/kernel/work/infrastructure/work-contract-store.ts', 'recordWorkEvidenceState');
requireText('packages/kernel/work/infrastructure/work-contract-store.ts', 'WORK_LIFECYCLE_REQUIRES_TRANSITION_API');
requireText('packages/kernel/work/infrastructure/work-contract-store.ts', 'work_contract_schema_v3_migrated');
forbid('packages/kernel/work/infrastructure/work-contract-store.ts', /phaseForStatusUpdate|dispatchStateForStatusUpdate/, 'Work status must not regain hidden phase/dispatch transition authority');
forbid('packages/kernel/work/infrastructure/work-contract-store.ts', /phaseEvidence:\s*legacyPhaseEvidence\(/, 'new Work construction must not reuse legacy migration phase-evidence inference');
requireText('src/runtime/control-plane/facade/work-contract-store.ts', '@deprecated Kernel V2 compatibility shim');
requireText('src/runtime/control-plane/facade/work-state-machine.ts', '@deprecated Kernel V2 compatibility shim');
requireText('src/runtime/control-plane/facade/work-implementation-review.ts', '@deprecated Kernel V2 compatibility shim');
requireText('packages/kernel/work/domain/types.ts', "['implementation', 'verification', 'review', 'delivery', 'cleanup']");
requireText('src/cli/repositories/selected-path-actions.ts', 'beforeCommitGuard');
requireText('src/runtime/control-plane/execution/direct-edit-work-completion.ts', 'prepareReviewedDirectEditWorkCommit');
requireText('src/runtime/control-plane/execution/direct-edit-work-completion.ts', 'completeReviewedDirectEditWorkAfterCommit');
requireText('src/runtime/control-plane/execution/direct-edit-work-completion.ts', 'transferReviewedWorkAuthorityAcrossContentEquivalentCommit');
requireText('src/runtime/control-plane/execution/work-verification-service.ts', 'planWorkVerificationAcrossContentEquivalentCommit');
forbid(
  'src/runtime/control-plane/execution/work-verification-service.ts',
  /export\s+function\s+transferWorkVerificationAcrossContentEquivalentCommit\s*\(/,
  'content-equivalent verification planning must stay pure; authority persistence belongs to the atomic transfer owner',
);
requireText('src/runtime/control-plane/execution/content-equivalent-commit-authority.ts', 'transferReviewedWorkAuthorityAcrossContentEquivalentCommit');
requireText('src/runtime/control-plane/execution/content-equivalent-commit-authority.ts', 'recordContentEquivalentCommitAuthorityTransfer');
requireText('packages/kernel/work/infrastructure/work-contract-store.ts', 'recordContentEquivalentCommitAuthorityTransfer');
requireText('src/runtime/control-plane/execution/edit-validation-coordinator.ts', 'workId: session.workId');
requireText('src/runtime/control-plane/execution/edit-validation-coordinator.ts', 'verificationSnapshot: work ?');
requireText('src/runtime/control-plane/execution/work-finalization-service.ts', 'assertPhysicalImplementationReviewGate');
requireText('src/runtime/control-plane/execution/work-finalization-service.ts', 'assertPhysicalBranchCleanupImplementationReviewGate');
requireText('src/runtime/control-plane/execution/work-finalization-service.ts', 'transferReviewedWorkAuthorityAcrossContentEquivalentCommit');
requireText('adapters/mcp/runtime-gateway/runtime-tool-definitions.ts', 'review_decision');
requireText('adapters/mcp/runtime-gateway/runtime-tool-definitions.ts', 'implementation_review_findings');
requireText('adapters/mcp/runtime-gateway/work-adapter.ts', "operation === 'review'");
requireText('adapters/mcp/runtime-gateway/work-adapter.ts', 'implementationReviewContentFingerprint');
requireText('adapters/mcp/controller-round-compatibility.ts', "'review'");
requireText('packages/kernel/controller/infrastructure/controller-round-store.ts', 'readControllerRoundContextSnapshot');
const controllerRoundTransitionPolicyPath = 'packages/kernel/controller/domain/controller-round-transition-policy.ts';
if (existsSync(resolve(root, controllerRoundTransitionPolicyPath))) {
  requireText(controllerRoundTransitionPolicyPath, "case 'provider_dispatch_outcome_unknown'");
  requireText(controllerRoundTransitionPolicyPath, "blockedReason: 'provider_dispatch_outcome_unknown'");
  forbid(
    'packages/kernel/controller/infrastructure/controller-round-store.ts',
    /blockedReason\s*(?:===|:)\s*['"]provider_dispatch_outcome_unknown['"]/,
    'ControllerRound outcome-unknown lifecycle semantics must be owned by the canonical transition policy, not the store',
  );
} else {
  requireText('packages/kernel/controller/infrastructure/controller-round-store.ts', "blockedReason === 'provider_dispatch_outcome_unknown'");
  requireText('packages/kernel/controller/infrastructure/controller-round-store.ts', "blockedReason: 'provider_dispatch_outcome_unknown'");
}
requireText('src/runtime/control-plane/launcher/chatgpt-work-continuation.ts', 'CHATGPT_AUTOMATION_SUBMISSION_OUTCOME_UNKNOWN');
requireText('adapters/chatgpt/controller-host.ts', 'CONTROLLER_HOST_PROVIDER_DISPATCH_OUTCOME_UNKNOWN');
requireText('packages/kernel/controller/application/continuation-service.ts', 'const outcomeUnknown =');
requireText('packages/kernel/controller/application/continuation-service.ts', 'outcomeUnknown });');
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
for (const record of genericWorkLifecycleMutationRecords([...sourceFiles('src'), ...sourceFiles('adapters')])) {
  failures.push(`${record.path}:${record.line} violates Work lifecycle authority: updateWorkContract patch owns ${record.fields.join(', ')}; use explicit Kernel lifecycle commands`);
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
requireText('adapters/mcp/runtime-gateway/work-adapter.ts', 'completeRemoteEffectWorkFromProcessReceipt');
requireText('src/runtime/control-plane/execution/work-finalization-service.ts', 'packages/kernel/work/api/index');
requireText('src/runtime/control-plane/facade/goal-workloop.ts', 'packages/kernel/work/api/index');
requireText('packages/kernel/work/domain/types.ts', 'predecessorWorkId?: string');
forbid('src/runtime/control-plane/facade/goal-workloop.ts', /PLAN_(?:STEP_|SUCCESSOR_|NOT_EXECUTABLE|EXECUTION_BASELINE)/, 'Work admission must not consult Plan item status, binding, dependency or approval state');
requireText('src/runtime/control-plane/facade/goal-workloop.ts', "requestedBy ?? 'chatgpt') === 'scheduler'");
// V2 Goal authority convergence: lifecycle enums are canonical Kernel Goal
// domain facts and explicit Controller goal_complete is the Requirement semantic
// acceptance boundary. PlanStep progression is retired: Plan items are authored
// working memory that never selects, gates or progresses Work.
requireText('packages/kernel/goal/domain/types.ts', 'export const REQUIREMENT_STATES');
requireText('packages/kernel/goal/domain/types.ts', 'export const PLAN_CONTRACT_STATUSES');
requireText('packages/kernel/goal/domain/types.ts', 'export const PLAN_STEP_STATUSES');
requireText('src/runtime/control-plane/persistence/requirement-store.ts', 'packages/kernel/goal/api/index');
requireText('src/runtime/control-plane/facade/types.ts', 'packages/kernel/goal/api/index');
requireText('src/runtime/control-plane/persistence/requirement-store.ts', 'reviseRequirementSemantic');
requireText('src/runtime/control-plane/facade/plan-contract-store.ts', 'revisePlanSemanticContext');
requireText('docs/architecture/decisions/20260924-thin-semantic-working-context.md', 'only three cross-domain model-authored semantic records');
requireText('docs/architecture/decisions/20260924-thin-semantic-working-context.md', 'semantic revision must be applied to the latest persisted aggregate inside the same storage transaction');
requireText('src/runtime/control-plane/facade/requirement-authority.ts', 'acceptRequirementOutcome');
requireText('src/runtime/control-plane/facade/requirement-authority.ts', 'completeRequirementGoal');
requireText('src/runtime/control-plane/facade/requirement-authority.ts', 'withPlanAdmissionLock');
requireText('src/runtime/control-plane/facade/plan-contract-store.ts', 'PLAN_REQUIREMENT_TERMINAL');
requireText('adapters/mcp/runtime-gateway/work-controller-operations.ts', 'completeRequirementGoal');
forbid('adapters/mcp/runtime-gateway/runtime-tools.ts', /\bacceptRequirementOutcome\s*\(/, 'MCP transport must delegate Requirement-bound goal completion to the canonical Goal application boundary');
requireText('adapters/mcp/runtime-gateway/work-controller-operations.ts', "disposition === 'goal_complete' && work.requirementId");
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
requireMissing('packages/kernel/scheduler/domain/continuation.ts');
requireMissing('packages/kernel/scheduler/application/continuation-service.ts');
requireMissing('packages/kernel/scheduler/infrastructure/continuation-dispatch-store.ts');
requireText('packages/kernel/controller/application/continuation-service.ts', 'resumeControllerRoundOccurrence');
requireText('packages/kernel/controller/application/continuation-service.ts', 'getRetainedControllerSession');
requireText('packages/kernel/controller/application/continuation-service.ts', 'getControllerWorkBinding');
requireText('packages/kernel/controller/application/continuation-service.ts', 'beginControllerRoundProviderDispatch');
requireText('packages/kernel/controller/application/continuation-service.ts', 'host.resume(bindingRecord.binding');
requireText('packages/kernel/controller/infrastructure/controller-round-store.ts', 'controller-provider-dispatch-start');
requireText('packages/kernel/controller/domain/controller-round-transition-policy.ts', "type: 'provider_dispatch_started'");
forbid('packages/kernel/controller/application/continuation-service.ts', /scheduler_continuation_dispatch|ScheduledContinuationDispatch/, 'Controller continuation must not recreate Scheduler-owned continuation lifecycle persistence');
requireText('src/runtime/control-plane/launcher/chatgpt-round-continuation.ts', 'beginControllerRoundProviderDispatch');
requireText('src/runtime/control-plane/global-scheduler/maintenance.ts', 'beginControllerRoundProviderDispatch');
requireText('src/runtime/root/scheduled-controller-composition.ts', 'controllerHostForScheduledBinding');
requireMissing('adapters/scheduler/controller-binding.ts');
requireText('adapters/chatgpt/controller-host.ts', 'createChatgptControllerHost');
requireText('adapters/controller-process/controller-host.ts', 'createProcessControllerHost');
requireText('src/runtime/workflow/schedules/engine.ts', 'resumeControllerRoundOccurrence');
requireText('src/runtime/workflow/schedules/engine.ts', 'workflowSupervisorBoundaryForWork');
requireText('src/runtime/workflow/schedules/engine.ts', 'workflow_supervisor_owns_outer_turn');
requireText('src/runtime/control-plane/launcher/chatgpt-work-continuation.ts', 'ensureWorkflowSupervisorEnrollmentForWork');
requireText('src/runtime/control-plane/launcher/chatgpt-round-continuation.ts', "outerTurnOwner: 'workflow_supervisor'");
requireText('src/runtime/control-plane/global-scheduler/maintenance.ts', 'workflowSupervisorBoundaryForWork');
requireText('src/runtime/root/workflow-supervisor-composition.ts', 'registerWorkflowSupervisorTask');
requireText('src/runtime/root/workflow-supervisor-composition.ts', 'reserveWorkflowSupervisorEnrollment');
requireText('supervisor/entry.ts', 'forgeWorkflowSupervisorValidators()');
requireText('supervisor/forge-validators.ts', "requirement.state !== 'done'");
requireText('supervisor/forge-validators.ts', "requirement.state === 'waiting_for_user'");
forbid('src/runtime/root/workflow-supervisor-composition.ts', /WorkflowSupervisorStore|supervisor\.sqlite|registerTask\(|reserveEffect\(/, 'Forge composition must access Supervisor state only through daemon RPC, never open its database or become a second writer');
requireText('src/runtime/root/workflow-supervisor-composition.ts', 'workflowSupervisorBoundaryForWork');
requireText('src/runtime/root/workflow-supervisor-composition.ts', '`forge:${repoId}:conversation:${conversationId}`');
forbid('supervisor/client.ts', /task_has_effect|taskHasAnyEffect/, 'Supervisor boundary is derived from canonical Work+conversation facts; do not add a second ownership projection RPC');
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
requireText('supervisor/store.ts', 'BEGIN IMMEDIATE');
requireText('supervisor/store.ts', 'completions_one_per_source_effect');
requireText('supervisor/store.ts', 'WORKFLOW_SUPERVISOR_SOURCE_EFFECT_COMPLETION_CONFLICT');
requireText('supervisor/paths.ts', 'resolveControllerHome');
requireText('supervisor/paths.ts', "join(resolveWorkflowSupervisorForgeHome(controllerHome), 'supervisor')");
forbid('supervisor/paths.ts', /control-plane\/persistence\/sqlite-store|workflow-run-store|packages\/kernel\/(?:work|controller)/, 'Workflow Supervisor path authority may share the canonical Controller Home root but must not depend on lower lifecycle persistence or Kernel authorities');
forbid('supervisor/store.ts', /resolveControllerHome|FORGE_CONTROLLER_HOME|control-plane\/persistence\/sqlite-store|workflow-run-store|packages\/kernel\/(?:work|controller)/, 'Workflow Supervisor persistence must resolve its root only through supervisor/paths and remain a separate database authority');
requireMissing('supervisor/service.ts');
requireText('src/runtime/root/runtime.ts', 'startWorkflowSupervisorRuntime');
requireText('src/runtime/root/runtime.ts', 'WORKFLOW_SUPERVISOR_STOPPED');
requireText('src/runtime/root/workflow-supervisor-runtime.ts', 'startWorkflowSupervisorRuntime(controllerHome: string)');
requireText('src/runtime/root/workflow-supervisor-runtime.ts', 'new WorkflowSupervisorStore(forgeHome)');
requireText('src/runtime/root/workflow-supervisor-runtime.ts', 'createWorkflowSupervisorServer');
requireText('src/runtime/root/workflow-supervisor-runtime.ts', 'startWorkflowSupervisorNativeBrowserAdapter');
requireText('supervisor/native-browser-adapter.ts', "surface: 'macos-native'");
forbid('supervisor/native-browser-adapter.ts', /supervisor\/store|sqlite|scheduler|packages\/kernel\/(?:work|controller)|control-plane\/persistence/, 'Native Supervisor browser adapter is transport-only and must not own durable lifecycle, Scheduler, Work, Controller, or persistence authority');
requireText('src/runtime/root/workflow-supervisor-composition.ts', 'resolveWorkflowSupervisorForgeHome(options.controllerHome)');
forbid('src/runtime/root/workflow-supervisor-runtime.ts', /createPlatformServiceManagerHost|launchd|systemd|startDetached/, 'Workflow Supervisor reuses the Canonical Runtime process lifecycle and must not own a second OS service');
requireText('supervisor/entry.ts', "argument('--controller-home')");
forbid('supervisor/entry.ts', /FORGE_HOME|--forge-home/, 'Workflow Supervisor foreground entry must use the canonical Controller Home authority rather than a second Forge-home root');
requireText('supervisor/control-plane.ts', 'await validator(task, parsed.proposal)');
requireText('supervisor/protocol.ts', 'SUPERVISOR_BLOCK_END');
requireText('supervisor/server.ts', 'createWorkflowSupervisorServer');
forbid('supervisor/server.ts', /from ['"]\.\/store['"]|supervisor\.sqlite|BEGIN IMMEDIATE/, 'Supervisor transport must relay typed commands through the control plane and never own persistence');
requireText('supervisor/chrome-extension/manifest.json', 'nativeMessaging');
forbid('supervisor/chrome-extension/background.js', /browser_begin_effect|browser_observe_effect|forge-workflow-supervisor-effect/, 'Chrome extension is discovery/assistant-observation only; native macOS transport is the sole outbound Supervisor sender');
requireText('supervisor/chrome-extension/content.js', 'FORGE_WORKFLOW_SUPERVISOR');
requireText('supervisor/native-messaging/host.ts', 'ALLOWED_BROWSER_METHODS');
requireText('supervisor/native-messaging/host.ts', 'browser_observe_assistant');
requireText('supervisor/store.ts', 'recordEffectNotAppliedProof');
requireText('supervisor/store.ts', '`effect-dispatch:${effectId}:${generation}`');
requireText('supervisor/control-plane.ts', 'PERSISTED_BROWSER_EVIDENCE_KEYS');
requireText('supervisor/control-plane.ts', "reason: 'not_applied_proof_incomplete'");
requireText('supervisor/server.ts', "if (!['applied','unknown'].includes(outcome))");
forbid('supervisor/chrome-extension/background.js', /chrome\.storage|supervisor\.sqlite|BEGIN IMMEDIATE/, 'Chrome recovery must reconstruct from daemon journal state rather than durable browser shadow state');
forbid('supervisor/chrome-extension/content.js', /chrome\.storage|supervisor\.sqlite|BEGIN IMMEDIATE/, 'Chrome content reconciliation must remain an observation surface rather than durable recovery authority');
forbid('supervisor/native-messaging/host.ts', /task_register|reserve_enrollment|supervisor\.sqlite|BEGIN IMMEDIATE|bun:sqlite|node:sqlite|from ['"][^'"]*(?:store|control-plane)['"]/, 'Chrome Native Messaging host must remain a stateless browser-method relay and never own Supervisor persistence/lifecycle');
forbid('supervisor/chrome-extension/background.js', /task_register|reserve_enrollment|supervisor\.sqlite|BEGIN IMMEDIATE|chrome\.storage/, 'Chrome extension background must consume daemon-authorized browser commands and never become durable workflow authority');
forbid('supervisor/chrome-extension/content.js', /task_register|reserve_enrollment|supervisor\.sqlite|BEGIN IMMEDIATE|chrome\.storage/, 'Chrome content script must observe/execute one exact page only and never own durable workflow state');

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
requireText('adapters/mcp/runtime-gateway/work-compat-adapter.ts', 'managedProcessOperationDigest');
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
  'adapters/mcp/runtime-gateway/routing-policy.ts',
  /const DIRECT_REPOSITORY_TOOLS = new Set\(\[[\s\S]*?'repository_list'[\s\S]*?'repository_get'[\s\S]*?'repository_workbench'[\s\S]*?\]\);/,
  'declare DIRECT_REPOSITORY_TOOLS with repository_list, repository_get, and repository_workbench',
);
requireText('adapters/mcp/runtime-gateway/runtime-observation-adapter.ts', "case 'controller_context'");
requireText('adapters/mcp/runtime-gateway/runtime-observation-adapter.ts', "case 'local_bridge_status'");
requireText('adapters/mcp/runtime-gateway/runtime-tools.ts', 'connectorExposedTools');
requireText('adapters/mcp/runtime-gateway/runtime-tools.ts', 'currentCallableTools');
forbid('adapters/mcp/runtime-gateway/runtime-observation-adapter.ts', /inspectAgentExecutableReadiness|resolveAgentExecutable|writeAgentExecutableReadinessSnapshot/, 'Runtime observation adapter must not perform Agent executable discovery or mutate readiness snapshots');
forbidBetween(
  'adapters/mcp/runtime-gateway/runtime-observation-adapter.ts',
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
requireText('adapters/mcp/runtime-gateway/runtime-observation-adapter.ts', 'CONTEXT_PROJECTION_SOURCE_MISMATCH');
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
requireText('adapters/mcp/runtime-gateway/work-adapter.ts', "callExecutionTool(ctx, 'work_finalize'");
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
requireText('adapters/mcp/transports/http-observation.ts', "'/ready'");
requireText('adapters/mcp/transports/http-observation.ts', "'/repos/:repoId/health'");
requireText('src/runtime/control-plane/governance/external-effects.ts', 'EXTERNAL_EFFECT_AUTHORIZATION_REQUIRED');
requireText('src/runtime/control-plane/governance/external-effects.ts', 'AUTOMATED_REQUIREMENT_REQUIRES_CANDIDATE');
requireText('adapters/mcp/tool-mapping/tools.ts', "export * from './legacy-tool-service'");
requireText('src/cli/mcp/tools.ts', '@deprecated Kernel V2 compatibility shim');

for (const path of [
  'adapters/mcp/runtime-gateway/router.ts',
  'adapters/mcp/runtime-gateway/runtime-tools.ts',
  'adapters/mcp/runtime-gateway/work-adapter.ts',
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
// Compatibility-facade thinness is enforced by ownership/consumer boundaries, not source line counts.
const b7ProductionFiles = productionTypeScriptFiles();
const b7ProductionImports = staticTypeScriptImportRecords(b7ProductionFiles);
const b7ProductionGraph = staticTypeScriptDependencyGraph(b7ProductionFiles);
for (const { from, specifier } of b7ProductionImports) {
  if (from.startsWith('packages/kernel/') && specifier.startsWith('@modelcontextprotocol/')) {
    failures.push(`Kernel modules must remain independent of MCP SDK transport contracts: ${from} -> ${specifier}`);
  }
  if (from.startsWith('packages/kernel/')
      && ['adapters/mcp', 'src/cli/mcp', 'runtime/gateway/mcp'].some((segment) => specifier.includes(segment))) {
    failures.push(`Kernel modules must never depend on MCP adapters or retired MCP gateway paths: ${from} -> ${specifier}`);
  }
  if (from.startsWith('packages/plugin-runtime/')
      && ['adapters/', 'src/runtime/'].some((segment) => specifier.includes(segment))) {
    failures.push(`Plugin Runtime provider dispatch must not depend on concrete adapters or Runtime implementations: ${from} -> ${specifier}`);
  }
  if (from.startsWith('adapters/computer/') && specifier.includes('src/runtime/')) {
    failures.push(`Computer adapters must consume provider-neutral ports and contracts rather than depend on Runtime implementations: ${from} -> ${specifier}`);
  }
  if (from.startsWith('packages/plugin-runtime/computer/')
      && (['controller-home', 'external-registration'].some((segment) => specifier.includes(segment))
        || ['node:fs', 'fs', 'node:path', 'path'].includes(specifier))) {
    failures.push(`Computer provider runtime must remain independent of Controller Home and filesystem-backed provider discovery: ${from} -> ${specifier}`);
  }
  if (from !== 'src/runtime/plugins/macos-capability-broker.ts' && specifier.includes('macos-capability-broker')) {
    failures.push(`Deprecated macOS capability broker is compatibility/test-only and must have no production consumers: ${from} -> ${specifier}`);
  }
}
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
  if (from.startsWith('packages/kernel/')
      && (to.startsWith('adapters/mcp/') || to.startsWith('src/cli/mcp/') || to.startsWith('src/runtime/gateway/mcp/'))) {
    failures.push(`Kernel modules must never depend on MCP adapters or retired MCP gateway paths: ${edge}`);
  }
  if (/^packages\/kernel\/[^/]+\/(?:domain|application)\//.test(from) && to.startsWith('src/')) {
    failures.push(`Kernel domain/application must depend only on Kernel/protocol ports, never legacy src mechanisms: ${edge}`);
  }
  if (from.startsWith('packages/plugin-runtime/') && (to.startsWith('adapters/') || to.startsWith('src/runtime/'))) {
    failures.push(`Plugin Runtime provider dispatch must not depend on concrete adapters or Runtime implementations: ${edge}`);
  }
  if (from.startsWith('packages/plugin-runtime/computer/')
      && (to.includes('/controller-home') || to.endsWith('/external-registration.ts'))) {
    failures.push(`Computer provider runtime must remain independent of Controller Home and provider discovery implementations: ${edge}`);
  }
  if (to === 'src/runtime/plugins/macos-capability-broker.ts' && from !== to) {
    failures.push(`Deprecated macOS capability broker is compatibility/test-only and must have no production consumers: ${edge}`);
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
  'packages/kernel/work/infrastructure/work-contract-store.ts -> src/cli/repositories/controller-home.ts',
  'packages/kernel/work/infrastructure/work-contract-store.ts -> src/cli/repositories/locks.ts',
  'packages/kernel/work/infrastructure/work-contract-store.ts -> src/runtime/shared/json-files.ts',
  'packages/kernel/work/infrastructure/work-contract-store.ts -> src/runtime/control-plane/persistence/sqlite-store.ts',
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
  'packages/kernel/controller/infrastructure/controller-binding-store.ts -> src/cli/repositories/locks.ts',
  'packages/kernel/controller/infrastructure/controller-binding-store.ts -> src/runtime/control-plane/persistence/sqlite-store.ts',
  'packages/kernel/scheduler/infrastructure/schedule-store.ts -> src/cli/repositories/controller-home.ts',
  'packages/kernel/scheduler/infrastructure/schedule-store.ts -> src/cli/repositories/locks.ts',
  'packages/kernel/scheduler/infrastructure/schedule-store.ts -> src/runtime/control-plane/facade/handoff-inbox-store.ts',
  'packages/kernel/scheduler/infrastructure/schedule-store.ts -> src/runtime/shared/json-files.ts',
  'packages/kernel/scheduler/infrastructure/schedule-store.ts -> src/runtime/evidence/event-ledger.ts',
]);
requireExactShrinkingDebt('Kernel -> legacy src dependency debt', b7KernelLegacyEdges, B7_ALLOWED_KERNEL_LEGACY_EDGES);
const b7ProductionEdges = new Set(dependencyEdges(b7ProductionGraph));
for (const requiredEdge of [
  'packages/kernel/work/domain/types.ts -> packages/kernel/identity/api/index.ts',
  'packages/kernel/scheduler/domain/schedule.ts -> packages/kernel/identity/api/index.ts',
]) {
  if (!b7ProductionEdges.has(requiredEdge)) failures.push(`Portable semantic identity contract must be consumed through the Kernel Identity boundary: ${requiredEdge}`);
}

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
// Thin Plan authority: Plan items are authored working memory. Work execution,
// Plan admission and Plan revision must never re-acquire PlanStep execution
// writers, Plan approval/acceptance gates or Plan-derived Work progression.
const retiredPlanExecutionSymbols = [
  'claimPlanStepForWork',
  'completePlanStepForWork',
  'acceptPlanStepEvidence',
  'repairPlanStepForTechnicalRetry',
  'repairDanglingPlanStepWorkBinding',
  'replanActivePlanBoundWorkScope',
  'retireTerminalPlanBoundWorkAuthorities',
  'getPlanExecutionBaselineRevision',
  'updatePlanContractWithExecutionBaseline',
  'refreshPlanBoundWorkRevision',
  'retirePlanBoundWorkContract',
  'rebindPlanBoundWorkContract',
];
for (const path of productionTypeScriptFiles()) {
  const source = text(path);
  for (const symbol of retiredPlanExecutionSymbols) {
    if (new RegExp(`\\b${symbol}\\b`).test(source)) failures.push(`${path} must not reintroduce retired PlanStep execution writer ${symbol}`);
  }
}
const retiredPlanGateCodes = /PLAN_STEP_(?:SEMANTIC_ACCEPTANCE_REQUIRED|TERMINAL_WORK_RECONCILIATION_REQUIRED|DEPENDENCIES_PENDING|ALREADY_ACTIVE|ALREADY_COMPLETED|MULTIPLE_PRIMARY_WORKS|BOUND_WORK_MISSING|REUSES_ACTIVE_WORK|WORK_CONTRACT_MISMATCH)|PLAN_NOT_EXECUTABLE|PLAN_EXECUTION_BASELINE_LOCKED|PLAN_OBLIGATION_CONTINUITY_REQUIRED|PLAN_STEP_SEMANTIC_ACCEPTANCE/;
for (const path of [
  'src/runtime/control-plane/facade/goal-workloop.ts',
  'src/runtime/control-plane/facade/plan-contract-store.ts',
  'src/runtime/control-plane/facade/requirement-authority.ts',
  'src/runtime/control-plane/global-scheduler/autonomous-continuation.ts',
  'adapters/mcp/runtime-gateway/work-plan-operations.ts',
  'adapters/mcp/runtime-gateway/work-plan-repair-operations.ts',
  'adapters/mcp/runtime-gateway/work-repair-adapter.ts',
]) {
  if (retiredPlanGateCodes.test(text(path))) failures.push(`${path} must not reintroduce a PlanStep execution gate`);
}
for (const path of ['packages/kernel/progression/api/index.ts']) requireMissing(path);
for (const path of productionTypeScriptFiles()) {
  if (/packages\/kernel\/progression/.test(text(path))) failures.push(`${path} must not depend on the retired PlanStep progression engine`);
}
// Thin semantic Work lifecycle: Work is open/completed/cancelled and
// work.complete is a mechanical durable close. Review findings are durable
// observations, never a completion gate.
requireText('packages/kernel/work/domain/types.ts', "export type SemanticWorkState = 'open' | 'completed' | 'cancelled';");
requireText('adapters/mcp/runtime-gateway/work-semantic-operations.ts', "'work_get', 'work_revise', 'work_complete'");
for (const path of [
  'packages/kernel/work/domain/state-machine.ts',
  'src/runtime/control-plane/execution/work-evidence-policy.ts',
  'src/runtime/control-plane/facade/goal-workloop.ts',
]) {
  forbid(path, /READ_ONLY_REVIEW_CLEAN_SCOPE|cleanReadOnlyReviewEvidence|READ_ONLY_REVIEW_FINDINGS_BLOCK/, 'read-only review findings must not gate terminal completion');
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
requireText('adapters/mcp/transports/http-observation.ts', 'controllerInstanceId: process.env.FORGE_MCP_INSTANCE_ID');
forbid('adapters/mcp/transports/http.ts', /\{\s*instanceId:\s*process\.env\.FORGE_MCP_INSTANCE_ID/, 'MCP process identity must not be exposed as semantic Forge instanceId');
requireText('adapters/mcp/transports/http.ts', "adapterId: 'mcp-http'");
requireText('adapters/mcp/transports/session-registry.ts', 'connectionId: string');
requireText('adapters/mcp/transports/session-registry.ts', 'reservation.connectionId !== input.connectionId');
requireText('adapters/mcp/tunnels/openai-secure-tunnel.ts', 'tunnelMatches: boolean');
requireText('adapters/mcp/tunnels/openai-secure-tunnel.ts', 'credentialReference(config.runtimeApiKeyRef');
forbid('adapters/mcp/tunnels/openai-secure-tunnel.ts', /\bidentityMatches\b/, 'tunnel binding match must not masquerade as Forge semantic identity');

// C0 Computer capability boundary: Browser and Desktop remain separate providers.
requireText('packages/protocols/computer/contract.ts', 'COMPUTER_BROWSER_AUTOMATION_CAPABILITY');
requireText('packages/protocols/computer/contract.ts', 'ComputerRuntimeProviderCapabilityId');
requireText('packages/plugin-runtime/computer/provider.ts', 'ComputerRuntimeProviderCapabilityId');
requireText('packages/plugin-runtime/computer/provider-registry.ts', 'COMPUTER_PROVIDER_AMBIGUOUS');
requireText('packages/plugin-runtime/computer/provider-registry.ts', 'COMPUTER_PROVIDER_DUPLICATE_ID');
forbid('packages/plugin-runtime/computer/provider-registry.ts', /throw new Error\(/, 'Computer provider resolution must expose typed provider errors rather than raw order-dependent failures');

requireText('packages/protocols/computer/contract.ts', 'COMPUTER_CAPABILITY_PROTOCOL_VERSION');
requireText('packages/protocols/computer/contract.ts', 'COMPUTER_CAPABILITY_EXECUTION_METHOD');
requireText('packages/protocols/computer/contract.ts', 'export interface ComputerCapabilityAdvertisement');
forbid('adapters/computer/desktop-operator-negotiation.ts', /interface\s+ComputerCapabilityAdvertisement/, 'Desktop Operator negotiation must consume the provider-neutral Computer capability advertisement contract instead of redefining it');
requireText('packages/plugin-runtime/computer/provider.ts', 'export interface ComputerProvider');
requireText('packages/plugin-runtime/computer/provider-registry.ts', 'export class ComputerProviderRegistry');
requireText('adapters/computer/desktop-operator-contract.ts', 'DESKTOP_OPERATOR_PROVIDER_PLUGIN_ID');
requireText('adapters/computer/desktop-operator-negotiation.ts', 'negotiateDesktopOperatorComputerHandshake');
requireText('adapters/computer/desktop-operator-negotiation.ts', 'buildDesktopOperatorComputerInvocation');
requireText('adapters/computer/desktop-operator-provider.ts', 'createDesktopOperatorComputerProvider');
requireText('adapters/computer/desktop-operator-discovery.ts', 'ComputerProviderRegistrationLookup');
requireText('adapters/computer/desktop-operator-discovery.ts', "source: 'registration'");
requireText('adapters/computer/desktop-operator-discovery.ts', "PLUGIN_COMPUTER_PROVIDER_REGISTRATION_REQUIRED");
forbid('adapters/computer/desktop-operator-discovery.ts', /legacy_fallback|DesktopOperatorLegacyFallbackMode|unregistered_v0_2/, 'Computer provider discovery must not bypass canonical Desktop Operator registration with a legacy socket fallback');
forbid('src/runtime/root/computer-composition.ts', /legacyFallback|unregistered_v0_2/, 'Computer Runtime composition must not enable an unregistered Desktop Operator compatibility provider');
requireText('src/cli/commands/computer.ts', "new Command('computer')");
requireText('src/cli/commands/computer.ts', 'installOfficialPlugin(COMPUTER_PROVIDER_PLUGIN_ID');
requireText('src/cli/commands/computer.ts', 'provider release: independent');
requireText('src/cli/commands/computer.ts', 'COMPUTER_PROVIDER_UNINSTALLER_MISSING');
requireText('src/cli/commands/computer.ts', 'readControllerStoredPluginManifest');
requireText('src/cli/commands/computer.ts', 'syncControllerPluginManifest');
requireText('src/cli/commands/computer.ts', 'removeControllerPluginManifestProjection');
requireText('src/cli/commands/computer.ts', 'withOfficialPluginLifecycleLock');
forbid('src/cli/commands/computer.ts', /controllerPluginRepository\(|syncAssistantPluginRegistry|getAssistantPluginManifest\(/, 'Computer status/doctor must use Controller-scoped stored/targeted provider APIs rather than a fake repository or global execution-style manifest lookup');
requireText('src/cli/commands/plugin.ts', 'external-plugin:${pluginId}');
requireText('src/runtime/plugins/store.ts', 'export function readControllerStoredPluginManifest');
requireText('src/runtime/plugins/store.ts', 'export function syncControllerPluginManifest');
requireText('src/runtime/plugins/store.ts', 'export function removeControllerPluginManifestProjection');
requireText('src/runtime/plugins/store.ts', 'export function readStoredAssistantPluginManifest');
requireText('src/runtime/plugins/store.ts', 'export function syncAssistantPluginManifest');
requireText('src/runtime/plugins/store.ts', 'export function removeAssistantPluginManifestProjection');
requireText('src/cli/index.ts', 'buildComputerCommand');
requireText('src/cli/index.ts', "'computer'");

forbid('adapters/computer/desktop-operator-provider.ts', /getExternalPluginRegistration|controller-home|computerCapabilities|internalCapabilities|browserAutomationProtocolVersion|browserAutomationActions|macos_browser_automation|computer_execute/, 'Desktop Operator provider transport must consume discovery and negotiation results rather than own Controller lookup or wire negotiation');
forbid('adapters/computer/desktop-operator-negotiation.ts', /getExternalPluginRegistration|controller-home|desktop-operator-discovery/, 'Desktop Operator negotiation must depend on protocol/contract facts, not endpoint discovery');
forbid('adapters/computer/desktop-operator-discovery.ts', /macos_browser_automation|LEGACY_BROWSER_AUTOMATION/, 'Desktop Operator discovery must own endpoint resolution only, not compatibility protocol negotiation');
forbid('adapters/computer/desktop-operator-provider.ts', /getExternalPluginAdapter|AssistantPluginActionExecutionInput|desktop_session_open|NATIVE_BROWSER_BUNDLE_IDS|activateDesktopOperatorBrowserApplication/, 'Desktop Operator Computer transport adapter must not own Runtime plugin-action application activation glue');
for (const path of sourceFiles('adapters/computer')) {
  forbid(path, /AssistantPluginError/, 'Computer adapters must expose provider errors through plugin-runtime rather than depend on Runtime plugin error types');
}
requireText('src/runtime/root/computer-composition.ts', 'lookupRegistration: (providerPluginId) =>');
requireText('src/runtime/root/computer-composition.ts', 'computerProviderRegistrationSnapshot(registration)');
requireText('src/runtime/root/computer-composition.ts', 'getExternalPluginAdapter(input.controllerHome, DESKTOP_OPERATOR_PROVIDER_PLUGIN_ID)');
requireText('src/runtime/plugins/browser-automation-service.ts', 'executeRuntimeComputerBrowserAutomation');
requireText('src/runtime/plugins/browser-adapter.ts', 'activateRuntimeComputerBrowserApplication');
forbid('src/runtime/plugins/browser-automation-service.ts', /desktop_operator|macos-capability-broker|desktop-operator\.sock|macos_browser_automation/, 'Browser automation must depend on the provider-neutral Computer boundary, not Desktop Operator transport details');
forbid('src/runtime/plugins/browser-adapter.ts', /desktop_operator|Desktop Operator|getExternalPluginAdapter|desktop_session_open/, 'Browser adapter must not know the concrete Desktop Operator application provider');
for (const path of sourceFiles('src/runtime/plugins').filter((entry) => /\/browser-(?!registration\.ts)[^/]+\.ts$/.test(entry))) {
  forbid(path, /desktop_operator|Desktop Operator|desktop-operator\.sock|macos_browser_automation/, 'Browser modules must depend on Computer capabilities rather than concrete Desktop Operator transport identity');
}
requireText('src/runtime/plugins/macos-capability-broker.ts', '@deprecated C0 compatibility shim');
requireText('src/runtime/plugins/macos-capability-broker.ts', 'executeRuntimeComputerBrowserAutomation');
forbid('src/runtime/plugins/macos-capability-broker.ts', /callDesktopOperatorComputerBrowserAutomation/, 'Deprecated macOS broker execution must delegate to Runtime Computer composition rather than call the concrete provider directly');
requireText('src/runtime/control-plane/facade/types.ts', 'semanticCapabilities?: string[]');
forbid('src/runtime/control-plane/facade/capability-registry.ts', /plugin\.desktop_operator/, 'Control Plane capability discovery must rank provider-declared semantic capabilities rather than concrete Desktop Operator plugin identity');
requireText('src/runtime/plugins/external-provider-policy.ts', 'resolveExternalProviderPolicy');
requireText('src/runtime/plugins/desktop-operator-external-policy.ts', 'verifyExactForegroundDesktopSession');
forbid('src/runtime/plugins/external-adapter.ts', /desktop_operator|desktopOperator|DESKTOP_|['\"]desktop_[a-z_]|desktop-operator-external-policy/, 'Generic external plugin adapter must delegate provider-specific Desktop policy through ExternalProviderPolicy');
requireText('src/runtime/plugins/desktop-operator-registration.ts', 'COMPUTER_OBSERVE_CAPABILITY');
requireText('src/runtime/plugins/desktop-operator-registration.ts', 'COMPUTER_INPUT_CAPABILITY');
requireText('src/runtime/plugins/desktop-operator-registration.ts', 'COMPUTER_CAPTURE_CAPABILITY');
requireText('src/runtime/plugins/desktop-operator-registration.ts', 'pluginVersion: options.pluginVersion');
forbid('src/runtime/plugins/desktop-operator-registration.ts', /pluginVersion:\s*options\.pluginVersion\s*\?\?|pluginVersion:\s*['"]0\./, 'Forge must not invent the Desktop Operator provider release version');
requireText('packages/plugin-runtime/external/unix-jsonl-transport.ts', 'EXTERNAL_RPC_METHOD_PATTERN');
requireText('src/runtime/plugins/external-unix-socket.ts', 'callExternalUnixJsonl');
forbid('src/runtime/plugins/external-unix-socket.ts', /createConnection|EXTERNAL_RPC_METHOD_PATTERN|packages\/protocols\/computer|computer_execute|macos_browser_automation/, 'Runtime external Unix socket compatibility layer must delegate async transport and must not own Computer/Desktop provider method identities');
forbid('adapters/computer/desktop-operator-provider.ts', /src\/runtime\/plugins\/external-unix-socket|callExternalUnixSocket/, 'Computer provider adapters must consume provider-neutral plugin-runtime transport rather than Runtime socket implementation');

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
}
for (const path of sourceFiles('src/runtime/plugins')) {
  if (['src/runtime/plugins/browser-runtime-contract.ts', 'src/runtime/plugins/browser-provider-registry.ts', 'src/runtime/plugins/browser-session-types.ts'].includes(path)) continue;
  forbid(path, /from\s+['"]\.\/browser-(?:runtime-contract|provider-registry|session-types)['"]/, 'active Browser runtime code must consume plugin-runtime/protocol Browser contracts, not retired local owners');
}
// Computer SurfaceTarget is the only durable interaction-target authority. Browser
// compatibility may retain old type/API names, but it must not recreate a Browser
// or Desktop authority/persistence owner alongside Computer.
requireMissing('adapters/browser/session-authority.ts');
requireMissing('adapters/browser/sqlite-session-authority.ts');
requireMissing('packages/plugin-runtime/browser/session-persistence.ts');
requireMissing('src/runtime/root/browser-session-persistence.ts');
forbid('packages/plugin-runtime/browser/session-authority.ts', /\bBrowserSession(?:Authority|Persistence)Port\b/, 'Browser compatibility contracts must not expose a second durable authority or persistence port');
requireText('src/runtime/plugins/browser-session-authority.ts', 'findComputerBackedBrowserSession');
requireText('src/runtime/plugins/browser-session-authority.ts', 'saveComputerBackedBrowserSession');
forbid('src/runtime/plugins/browser-session-authority.ts', /\b(?:writeControlPlaneRecord|deleteControlPlaneRecord|withControlPlaneTransaction|createBrowserSessionAuthority|runtimeBrowserSessionAuthority)\b/, 'Browser compatibility facade must delegate semantic identity to Computer and cannot persist its own authority');
requireText('src/runtime/plugins/browser-session-legacy-migration.ts', 'readLegacyBrowserSessionMigrationEntries');
requireText('src/runtime/plugins/browser-session-store.ts', 'PLUGIN_BROWSER_SESSION_CONTEXT_REQUIRED');
forbid('src/runtime/plugins/browser-session-store.ts', /writeJsonAtomic\(sessionPath|readLegacyBrowserSessionJson|rmSync\(sessionPath/, 'steady-state Browser session identity must never fall back to repository-local JSON outside Computer target authority');
forbid('src/runtime/plugins/browser-session-legacy-migration.ts', /\b(?:writeControlPlaneRecord|deleteControlPlaneRecord|withControlPlaneTransaction|createBrowserSessionAuthority|runtimeBrowserSessionAuthority)\b/, 'legacy Browser migration may read retired state but cannot mutate or recreate Browser durable authority');
requireText('src/runtime/root/browser-session-composition.ts', 'BrowserSessionExecutionContext');
forbid('src/runtime/root/browser-session-composition.ts', /\b(?:createBrowserSessionAuthority|runtimeBrowserSessionAuthority|createRuntimeBrowserSessionPersistence)\b/, 'Browser Runtime composition may carry execution context but cannot compose a second durable interaction authority');
for (const path of [
  ...sourceFiles('adapters/browser'),
  ...sourceFiles('packages/plugin-runtime/browser'),
  ...sourceFiles('src/runtime/plugins'),
  ...sourceFiles('src/runtime/root'),
]) {
  if (path === 'src/runtime/plugins/browser-session-legacy-migration.ts') continue;
  forbid(path, LEGACY_INTERACTION_AUTHORITY_OWNER_DECLARATION, 'Browser/Desktop durable interaction authority must live only in Computer target authority');
}
// Workflow Asset authority: editable content stays in files; machine registry stays metadata-only.
requireText('packages/workflow-runtime/domain/workflow-asset.ts', 'export interface WorkflowAssetDefinition');
requireText('packages/workflow-runtime/domain/workflow-asset.ts', 'workflowAssetContentDigest');
requireText('src/runtime/control-plane/persistence/workflow-content-store.ts', 'ensureControllerWorkflowContentRoot');
requireText('src/runtime/control-plane/persistence/workflow-registry-store.ts', "WORKFLOW_REGISTRY_NAMESPACE = 'workflow_registry'");
requireText('src/runtime/control-plane/persistence/workflow-registry-store.ts', 'WORKFLOW_REGISTRY_CONTENT_IDENTITY_CHANGED');
forbid('src/runtime/control-plane/persistence/workflow-registry-store.ts', /\b(?:prompts|scripts|templates|selectors|resources)\s*:/, 'Workflow machine registry must not persist editable prompt/script/template/selector/resource bodies');
for (const path of sourceFiles('packages/workflow-runtime')) {
  forbid(path, /xiaohongshu|douyin|instagram|reddit|facebook/i, 'generic Workflow Runtime contracts must not own site/business choreography');
  forbid(path, /from\s+['"][^'"]*(?:src\/runtime|adapters)\//, 'Workflow Runtime package contracts must remain independent from Runtime/adapters implementation authority');
}
requireText('src/runtime/plugins/browser-registration.ts', 'export const browserPluginAdapter');
requireText('src/runtime/plugins/first-party-registry.ts', "from './browser-registration'");
forbid('src/runtime/plugins/first-party-registry.ts', /from\s+['"]\.\/browser-adapter['"]/, 'first-party registry must depend on the thin Browser registration entrypoint, not the action implementation');
forbid('src/runtime/plugins/browser-adapter.ts', /export\s+const\s+browserPluginAdapter/, 'Browser action implementation must not also own first-party plugin registration');

if (failures.length) {
  console.error('[runtime-architecture] FAILED');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log(`[runtime-architecture] OK (${required.length} required modules/documents checked)`);
