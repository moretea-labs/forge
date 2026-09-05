import { createHash } from 'crypto';
import { spawnSync } from 'child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'fs';
import { dirname, join, relative, resolve } from 'path';
import { runBunTestFile, TEST_FAILURE_CODES, type BunTestFileRunResult } from '../../scripts/run-bun-test-file';
import { runBoundedChild } from '../runtime/shared/bounded-child-supervisor';
import { ensureRepositoryCheckStorage, type RepositoryCheckStorageAuthority } from '../runtime/execution/process-runtime/check-storage';

export const TEST_MODULES = [
  'core', 'controller', 'process-runtime', 'routing', 'repository',
  'browser', 'ios', 'workflow', 'runner', 'release',
] as const;
export const TEST_RESOURCES = [
  'pure', 'temp-isolated', 'controller-home-isolated', 'git-worktree',
  'process-tree', 'fixed-port', 'runtime-singleton', 'destructive',
] as const;

export type TestModule = (typeof TEST_MODULES)[number];
export type TestResource = (typeof TEST_RESOURCES)[number];
export type TestGate = 'affected' | 'core' | 'integration' | 'infrastructure' | 'fault' | 'full';

/**
 * Acceptance evidence is the default. Tests must protect externally observable
 * contracts, migrations/rollback, failure injection, security boundaries, or
 * a recorded production incident. Do not add tests for private helpers,
 * implementation payloads, copy, enum order, or mock-only lifecycles.
 */
export const TEST_GOVERNANCE_POLICY = 'acceptance-first-no-internal-unit-tests' as const;

export interface TestManifestEntry {
  module: TestModule;
  resource: TestResource;
  smoke?: boolean;
}

export interface TestManifest {
  version: 1;
  modules: TestModule[];
  resources: TestResource[];
  pathModuleRules: Array<{ prefix: string; modules: TestModule[] }>;
  tests: Record<string, TestManifestEntry>;
}

export interface TestSelection {
  gate: TestGate;
  changedPaths: string[];
  modules: TestModule[];
  files: string[];
  reason: string;
}

const MANIFEST_PATH = 'tests/test-manifest.v1.json';
const CHECKPOINT_SUBDIR = join('tests', 'checkpoints');
const RECEIPT_SUBDIR = join('tests', 'receipts');
const INFRASTRUCTURE_RESOURCES = new Set<TestResource>([
  'git-worktree', 'process-tree', 'fixed-port', 'runtime-singleton',
]);
const CONTENT_EXCLUDES = [
  '.ai/', '.git/', '.codegraph/', '.forge/', '_ops/', 'node_modules/', 'tasks/', 'plans/', 'references/',
  'dist/', 'coverage/',
];
const CHANGE_EXCLUDES = [...CONTENT_EXCLUDES, 'tmp/', 'temp/'];
const EPHEMERAL_SUFFIXES = [
  '.log', '.tmp', '.temp', '.pid', '.lock', '.trace', '.out', '.cache', '.bak', '.swp', '.swo',
];
const TEST_INPUT_CONFIG = [MANIFEST_PATH, 'package.json', 'bun.lock', 'tsconfig.json'];
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs', '.json'];

function git(repoRoot: string, args: string[]): string {
  const result = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) return '';
  return result.stdout ?? '';
}

function hashFiles(repoRoot: string, paths: string[], namespace: string): string {
  const hash = createHash('sha256').update(`${namespace}\n`);
  for (const path of [...new Set(paths)].sort()) {
    hash.update(`${path}\0`);
    try {
      hash.update(readFileSync(resolve(repoRoot, path)));
    } catch (_error) {
      hash.update('missing');
    }
  }
  return hash.digest('hex');
}

function repositoryFiles(repoRoot: string, includeUntracked: boolean): string[] {
  const args = includeUntracked
    ? ['ls-files', '--cached', '--others', '--exclude-standard', '-z']
    : ['ls-files', '--cached', '-z'];
  return git(repoRoot, args).split('\0').filter(Boolean);
}

export function testContentDigest(repoRoot: string): string {
  return hashFiles(
    repoRoot,
    repositoryFiles(repoRoot, true).filter((path) => !CONTENT_EXCLUDES.some((prefix) => path.startsWith(prefix))),
    'forge-test-content-v1',
  );
}

export function trackedTreeDigest(repoRoot: string): string {
  return hashFiles(repoRoot, repositoryFiles(repoRoot, false), 'forge-tracked-tree-v1');
}

export function isTestRelevantChangedPath(rawPath: string): boolean {
  const path = String(rawPath ?? '').replace(/^\.\//, '').replace(/\\/g, '/').trim();
  if (!path || CHANGE_EXCLUDES.some((prefix) => path.startsWith(prefix))) return false;
  const name = path.split('/').at(-1) ?? '';
  if (!name || name === '.DS_Store') return false;
  if (path.startsWith('tests/') && name.startsWith('.') && !/\.test\.(?:ts|mjs)$/.test(name)) return false;
  if (EPHEMERAL_SUFFIXES.some((suffix) => name.endsWith(suffix))) return false;
  return true;
}

/**
 * Fingerprint only the candidate's actual Git delta. This remains fail-closed
 * for tracked, staged, and untracked pollution without re-reading every clean
 * tracked file after each test.
 */
export function workspaceMutationDigest(repoRoot: string): string {
  const hash = createHash('sha256').update('forge-workspace-mutation-v2\n');
  hash.update(git(repoRoot, ['diff', '--binary', '--no-ext-diff']));
  hash.update('\0staged\0');
  hash.update(git(repoRoot, ['diff', '--cached', '--binary', '--no-ext-diff']));
  const untracked = git(repoRoot, ['ls-files', '--others', '--exclude-standard', '-z'])
    .split('\0')
    .filter(Boolean)
    .filter(isTestRelevantChangedPath);
  hash.update('\0untracked\0');
  hash.update(hashFiles(repoRoot, untracked, 'forge-untracked-mutation-v2'));
  return hash.digest('hex');
}

function resolveLocalDependency(repoRoot: string, importer: string, specifier: string): string | undefined {
  const absoluteBase = specifier.startsWith('.')
    ? resolve(dirname(resolve(repoRoot, importer)), specifier)
    : resolve(repoRoot, specifier);
  const candidates = [
    absoluteBase,
    ...SOURCE_EXTENSIONS.map((extension) => `${absoluteBase}${extension}`),
    ...SOURCE_EXTENSIONS.map((extension) => join(absoluteBase, `index${extension}`)),
  ];
  for (const candidate of candidates) {
    try {
      if (!existsSync(candidate) || !statSync(candidate).isFile()) continue;
      const local = relative(repoRoot, candidate).replace(/\\/g, '/');
      if (!local.startsWith('../') && local !== '..') return local;
    } catch (_error) {
      // A disappearing candidate is simply not an input.
    }
  }
  return undefined;
}

export function testInputPaths(repoRoot: string, testFile: string): string[] {
  const pending = [testFile.replace(/^\.\//, '')];
  const inputs = new Set<string>();
  while (pending.length > 0 && inputs.size < 2_000) {
    const file = pending.shift()!;
    if (inputs.has(file)) continue;
    inputs.add(file);
    let source: string;
    try {
      source = readFileSync(resolve(repoRoot, file), 'utf8');
    } catch (_error) {
      continue;
    }
    const specifiers = new Set<string>();
    for (const pattern of [
      /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)['"]([^'"]+)['"]/g,
      /['"]((?:src|scripts|tests|assets)\/[^'"]+)['"]/g,
    ]) {
      pattern.lastIndex = 0;
      for (let match = pattern.exec(source); match; match = pattern.exec(source)) specifiers.add(match[1]!);
    }
    for (const specifier of specifiers) {
      if (!specifier.startsWith('.') && !/^(?:src|scripts|tests|assets)\//.test(specifier)) continue;
      const dependency = resolveLocalDependency(repoRoot, file, specifier);
      if (dependency && !inputs.has(dependency)) pending.push(dependency);
    }
  }
  for (const config of TEST_INPUT_CONFIG) if (existsSync(resolve(repoRoot, config))) inputs.add(config);
  return [...inputs].sort();
}

export function testInputDigest(repoRoot: string, testFile: string): string {
  return hashFiles(repoRoot, testInputPaths(repoRoot, testFile), 'forge-test-input-v2');
}

function listTestsOnDisk(directory: string, repoRoot: string): string[] {
  if (!existsSync(directory)) return [];
  const found: string[] = [];
  for (const name of readdirSync(directory)) {
    const absolute = join(directory, name);
    const stat = statSync(absolute);
    if (stat.isDirectory()) found.push(...listTestsOnDisk(absolute, repoRoot));
    else if (/\.test\.(?:ts|mjs)$/.test(name)) found.push(relative(repoRoot, absolute).replace(/\\/g, '/'));
  }
  return found;
}

export function loadTestManifest(repoRoot: string): TestManifest {
  return JSON.parse(readFileSync(join(repoRoot, MANIFEST_PATH), 'utf8')) as TestManifest;
}

export function validateTestManifest(repoRoot: string, manifest = loadTestManifest(repoRoot)): string[] {
  const errors: string[] = [];
  if (manifest.version !== 1) errors.push(`unsupported manifest version: ${String(manifest.version)}`);
  if (JSON.stringify(manifest.modules) !== JSON.stringify(TEST_MODULES)) errors.push('module catalog does not match v1 contract');
  if (JSON.stringify(manifest.resources) !== JSON.stringify(TEST_RESOURCES)) errors.push('resource catalog does not match v1 contract');
  const diskFiles = listTestsOnDisk(join(repoRoot, 'tests'), repoRoot).sort();
  const declaredFiles = Object.keys(manifest.tests).sort();
  for (const file of diskFiles) if (!manifest.tests[file]) errors.push(`test is not declared: ${file}`);
  for (const file of declaredFiles) if (!diskFiles.includes(file)) errors.push(`manifest entry has no test file: ${file}`);
  for (const [file, entry] of Object.entries(manifest.tests)) {
    if (!TEST_MODULES.includes(entry.module)) errors.push(`${file}: invalid module ${String(entry.module)}`);
    if (!TEST_RESOURCES.includes(entry.resource)) errors.push(`${file}: invalid resource ${String(entry.resource)}`);
  }
  if (!Object.values(manifest.tests).some((entry) => entry.smoke)) errors.push('manifest has no core smoke tests');
  return errors;
}

export interface ChangedPathOptions {
  explicit?: string[];
  baseRef?: string;
}

export function collectChangedPaths(repoRoot: string, options: ChangedPathOptions = {}): string[] {
  const paths = new Set((options.explicit ?? []).map((path) => path.replace(/^\.\//, '')));
  if (options.baseRef) {
    const mergeBase = git(repoRoot, ['merge-base', options.baseRef, 'HEAD']).trim();
    if (mergeBase) {
      for (const path of git(repoRoot, ['diff', '--name-only', '-z', `${mergeBase}...HEAD`]).split('\0').filter(Boolean)) paths.add(path);
    }
  }
  for (const args of [
    ['diff', '--name-only', '-z'],
    ['diff', '--cached', '--name-only', '-z'],
    ['ls-files', '--others', '--exclude-standard', '-z'],
  ]) {
    for (const path of git(repoRoot, args).split('\0').filter(Boolean)) paths.add(path);
  }
  return [...paths].filter(isTestRelevantChangedPath).sort();
}

function modulesForChangedPath(path: string, manifest: TestManifest): TestModule[] {
  const testEntry = manifest.tests[path];
  if (testEntry) return [testEntry.module];
  const rule = [...manifest.pathModuleRules]
    .sort((a, b) => b.prefix.length - a.prefix.length)
    .find((candidate) => path === candidate.prefix || path.startsWith(candidate.prefix));
  if (rule) return rule.modules;
  if (path.startsWith('tasks/') || path.startsWith('plans/')) return ['core'];
  if (path.startsWith('src/cli/')) return ['controller'];
  if (path.startsWith('src/')) return ['core', 'process-runtime'];
  if (path.startsWith('tests/')) return ['core'];
  return ['core', 'workflow'];
}

export function selectTests(
  manifest: TestManifest,
  gate: TestGate,
  changedPaths: string[],
  explicitTestFiles: string[] = [],
): TestSelection {
  const meaningfulChangedPaths = [...new Set(changedPaths.map((path) => path.replace(/^\.\//, '')).filter(isTestRelevantChangedPath))].sort();
  const changedModules = new Set<TestModule>();
  for (const path of meaningfulChangedPaths) for (const module of modulesForChangedPath(path, manifest)) changedModules.add(module);
  if (changedModules.size === 0) changedModules.add('core');
  const direct = new Set(explicitTestFiles.length > 0
    ? explicitTestFiles
    : meaningfulChangedPaths.filter((path) => Boolean(manifest.tests[path])));
  const entries = Object.entries(manifest.tests);
  let selected: string[];
  if (explicitTestFiles.length > 0) {
    selected = explicitTestFiles.filter((file) => Boolean(manifest.tests[file]));
  } else if (gate === 'core') {
    selected = entries.filter(([, entry]) => entry.smoke || (entry.module === 'core' && entry.resource === 'pure')).map(([file]) => file);
  } else if (gate === 'affected') {
    selected = meaningfulChangedPaths.length === 0
      ? entries.filter(([, entry]) => entry.smoke).map(([file]) => file)
      : entries.filter(([file, entry]) => (
          (direct.has(file) && !INFRASTRUCTURE_RESOURCES.has(entry.resource) && entry.resource !== 'destructive')
          || entry.smoke
          || (changedModules.has(entry.module) && entry.resource === 'pure')
        )).map(([file]) => file);
  } else if (gate === 'integration') {
    selected = entries.filter(([, entry]) => changedModules.has(entry.module)
      && (entry.resource === 'temp-isolated' || entry.resource === 'controller-home-isolated')).map(([file]) => file);
  } else if (gate === 'infrastructure') {
    selected = entries.filter(([, entry]) => INFRASTRUCTURE_RESOURCES.has(entry.resource)).map(([file]) => file);
  } else if (gate === 'fault') {
    selected = entries.filter(([, entry]) => entry.resource === 'destructive').map(([file]) => file);
  } else {
    selected = entries.filter(([, entry]) => entry.resource !== 'destructive').map(([file]) => file);
  }
  selected.sort();
  const noChanges = meaningfulChangedPaths.length === 0;
  return {
    gate,
    changedPaths: meaningfulChangedPaths,
    modules: [...changedModules].sort(),
    files: selected,
    reason: explicitTestFiles.length > 0
      ? 'explicit test files'
      : noChanges ? 'no changes detected; core smoke only' : `changed paths mapped to ${[...changedModules].sort().join(', ')}`,
  };
}

interface TestCheckpoint {
  version: 2;
  key: string;
  inputDigest: string;
  runnerDigest: string;
  testDigest: string;
  toolchain: string;
  capability: string;
  file: string;
  module: TestModule;
  resource: TestResource;
  status: 'passed' | 'failed';
  failureClass?: string;
  failureCode?: string;
  durationMs: number;
  attempts: number;
  completedAt: string;
}

function atomicJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temporary, path);
}

function toolchainSignature(): string {
  return JSON.stringify({ bun: Bun.version, node: process.version, platform: process.platform, arch: process.arch });
}

function capabilitySignature(): string {
  return createHash('sha256').update(JSON.stringify({
    ci: process.env.CI ?? '',
    controllerHome: Boolean(process.env.FORGE_CONTROLLER_HOME),
    docker: Boolean(process.env.DOCKER_HOST),
  })).digest('hex').slice(0, 16);
}

function readPassedCheckpoint(path: string, key: string): TestCheckpoint | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const checkpoint = JSON.parse(readFileSync(path, 'utf8')) as TestCheckpoint;
    return checkpoint.version === 2 && checkpoint.key === key && checkpoint.status === 'passed' ? checkpoint : undefined;
  } catch (_error) {
    return undefined;
  }
}

async function runPool<T>(items: T[], concurrency: number, run: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  const boundedConcurrency = Math.max(1, Math.trunc(Number.isFinite(concurrency) ? concurrency : 1));
  await Promise.all(Array.from({ length: Math.min(boundedConcurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      await run(items[index]!);
    }
  }));
}

export interface RunTestSelectionOptions {
  useCache?: boolean;
  storageAuthority?: RepositoryCheckStorageAuthority;
  pureConcurrency?: number;
  tempConcurrency?: number;
}

export async function runTestSelection(
  repoRoot: string,
  manifest: TestManifest,
  selection: TestSelection,
  options: RunTestSelectionOptions = {},
): Promise<number> {
  const useCache = options.useCache ?? true;
  const storage = ensureRepositoryCheckStorage(repoRoot, options.storageAuthority);
  const baselineWorkspace = workspaceMutationDigest(repoRoot);
  const contentDigest = testContentDigest(repoRoot);
  const runnerDigest = hashFiles(repoRoot, [
    MANIFEST_PATH,
    'scripts/run-bun-test-file.ts',
    'scripts/test-governance.ts',
    'src/testing/test-governance.ts',
    'src/runtime/shared/bounded-child-supervisor.ts',
    'src/runtime/shared/process-tree.ts',
  ], 'test-runner-v1');
  const toolchain = toolchainSignature();
  const capability = capabilitySignature();
  let failures = 0;
  let cacheHits = 0;
  const cacheProvenance: Array<{
    file: string;
    checkpointKey: string;
    checkpointPath: string;
    inputDigest: string;
    testDigest: string;
    runnerDigest: string;
    completedAt: string;
    durationMs: number;
    attempts: number;
  }> = [];
  let contaminated = false;
  let serialEquivalentMs = 0;
  const runStartedAt = performance.now();

  const runOne = async (file: string): Promise<void> => {
    if (contaminated) return;
    const entry = manifest.tests[file]!;
    const testDigest = hashFiles(repoRoot, [file], 'test-file-v1');
    const inputDigest = testInputDigest(repoRoot, file);
    const key = createHash('sha256').update(JSON.stringify({
      inputDigest, runnerDigest, testDigest, toolchain, capability, file,
    })).digest('hex');
    const checkpointPath = join(storage.physicalRoot, CHECKPOINT_SUBDIR, `${key}.json`);
    const cachedCheckpoint = useCache ? readPassedCheckpoint(checkpointPath, key) : undefined;
    if (cachedCheckpoint) {
      cacheHits += 1;
      serialEquivalentMs += cachedCheckpoint.durationMs;
      const checkpointRelativePath = `controller-home://checks/${join(CHECKPOINT_SUBDIR, `${key}.json`).replace(/\\/g, '/')}`;
      cacheProvenance.push({
        file,
        checkpointKey: cachedCheckpoint.key,
        checkpointPath: checkpointRelativePath,
        inputDigest: cachedCheckpoint.inputDigest,
        testDigest: cachedCheckpoint.testDigest,
        runnerDigest: cachedCheckpoint.runnerDigest,
        completedAt: cachedCheckpoint.completedAt,
        durationMs: cachedCheckpoint.durationMs,
        attempts: cachedCheckpoint.attempts,
      });
      console.error(`[tests] cache hit ${file} key=${cachedCheckpoint.key.slice(0, 16)} completedAt=${cachedCheckpoint.completedAt} evidence=${checkpointRelativePath}`);
      return;
    }

    let attempts = 0;
    let result: BunTestFileRunResult;
    const startedAt = performance.now();
    do {
      attempts += 1;
      console.error(`[tests] ${file}${attempts > 1 ? ' (infrastructure retry)' : ''}`);
      if (file.endsWith('.test.mjs')) {
        const independent = await runBoundedChild('node', ['--test', file], {
          cwd: repoRoot,
          env: process.env,
          timeoutMs: Number(process.env.BUN_TEST_FILE_WALL_TIMEOUT_MS ?? 120_000),
          stdio: 'inherit',
          forwardSignals: true,
        });
        result = {
          exitCode: independent.status,
          lingeringPids: independent.residualPids,
          remainingPids: independent.remainingPids,
          pidReuseFenced: independent.pidReuseFenced,
          ...(independent.failureCode ? {
            failureClass: 'infrastructure' as const,
            failureCode: independent.timedOut
              ? TEST_FAILURE_CODES.INFRA_FILE_WALL_TIMEOUT
              : TEST_FAILURE_CODES.INFRA_RUNNER_DID_NOT_CONVERGE,
          } : independent.status === 0 ? {} : {
            failureClass: 'source' as const,
            failureCode: TEST_FAILURE_CODES.SOURCE_ASSERTION_FAILED,
          }),
        };
      } else if (file.startsWith('tests/infrastructure/')) {
        const independent = await runBoundedChild(process.execPath, [
          'test', '--timeout', process.env.BUN_TEST_TIMEOUT_MS ?? '60000', '--max-concurrency', '1', file,
        ], {
          cwd: repoRoot,
          env: process.env,
          timeoutMs: Number(process.env.BUN_TEST_FILE_WALL_TIMEOUT_MS ?? 120_000),
          stdio: 'inherit',
          forwardSignals: true,
        });
        result = {
          exitCode: independent.status,
          lingeringPids: independent.residualPids,
          remainingPids: independent.remainingPids,
          pidReuseFenced: independent.pidReuseFenced,
          ...(independent.failureCode ? {
            failureClass: 'infrastructure' as const,
            failureCode: independent.timedOut
              ? TEST_FAILURE_CODES.INFRA_FILE_WALL_TIMEOUT
              : TEST_FAILURE_CODES.INFRA_RUNNER_DID_NOT_CONVERGE,
          } : independent.status === 0 ? {} : {
            failureClass: 'source' as const,
            failureCode: TEST_FAILURE_CODES.SOURCE_ASSERTION_FAILED,
          }),
        };
      } else {
        result = await runBunTestFile([
          '--timeout', process.env.BUN_TEST_TIMEOUT_MS ?? '60000',
          '--max-concurrency', '1',
          file,
        ], { forwardSignals: true, cwd: repoRoot });
      }
      if (workspaceMutationDigest(repoRoot) !== baselineWorkspace) {
        contaminated = true;
        result = {
          ...result,
          exitCode: 1,
          failureClass: 'infrastructure',
          failureCode: TEST_FAILURE_CODES.INFRA_WORKTREE_MUTATION,
        };
        console.error(`[tests] ${TEST_FAILURE_CODES.INFRA_WORKTREE_MUTATION}: tracked tree changed while running ${file}`);
        break;
      }
    } while (result.failureClass === 'infrastructure' && attempts < 2);

    const checkpoint: TestCheckpoint = {
      version: 2,
      key,
      inputDigest,
      runnerDigest,
      testDigest,
      toolchain,
      capability,
      file,
      module: entry.module,
      resource: entry.resource,
      status: result.exitCode === 0 ? 'passed' : 'failed',
      failureClass: result.failureClass,
      failureCode: result.failureCode,
      durationMs: Math.round(performance.now() - startedAt),
      attempts,
      completedAt: new Date().toISOString(),
    };
    atomicJson(checkpointPath, checkpoint);
    serialEquivalentMs += checkpoint.durationMs;
    if (result.exitCode !== 0) failures += 1;
  };

  const pure = selection.files.filter((file) => manifest.tests[file]!.resource === 'pure');
  const temporary = selection.files.filter((file) => manifest.tests[file]!.resource === 'temp-isolated');
  const serial = selection.files.filter((file) => !pure.includes(file) && !temporary.includes(file));
  await runPool(pure, Number(process.env.TEST_PURE_CONCURRENCY ?? options.pureConcurrency ?? 8), runOne);
  await runPool(temporary, Number(process.env.TEST_TEMP_CONCURRENCY ?? options.tempConcurrency ?? 4), runOne);
  const serialLanes = new Map<TestResource, string[]>();
  for (const file of serial) {
    const resource = manifest.tests[file]!.resource;
    const lane = serialLanes.get(resource) ?? [];
    lane.push(file);
    serialLanes.set(resource, lane);
  }
  await Promise.all([...serialLanes.entries()].map(async ([resource, files]) => {
    console.error(`[tests] serial lane ${resource}: ${files.length} file(s)`);
    for (const file of files) await runOne(file);
  }));

  if (workspaceMutationDigest(repoRoot) !== baselineWorkspace) contaminated = true;

  const durationMs = Math.round(performance.now() - runStartedAt);
  const serialReduction = serialEquivalentMs > 0
    ? Math.max(0, 1 - (durationMs / serialEquivalentMs))
    : 0;

  const receipt = {
    version: 1,
    gate: selection.gate,
    contentDigest,
    runnerDigest,
    status: failures === 0 && !contaminated ? 'passed' : 'failed',
    selected: selection.files.length,
    cacheHits,
    cacheProvenance: cacheProvenance.sort((left, right) => left.file.localeCompare(right.file)),
    failures,
    modules: selection.modules,
    durationMs,
    serialEquivalentMs,
    serialReduction,
    lanes: Object.fromEntries([
      ['pure', pure.length],
      ['temp-isolated', temporary.length],
      ...[...serialLanes.entries()].map(([resource, files]) => [resource, files.length]),
    ]),
    completedAt: new Date().toISOString(),
  };
  atomicJson(join(storage.physicalRoot, RECEIPT_SUBDIR, `${contentDigest}-${selection.gate}.json`), receipt);
  console.error(`[tests] ${receipt.status}: ${selection.files.length} selected, ${cacheHits} checkpoint hit(s), ${failures} failure(s), ${(serialReduction * 100).toFixed(1)}% vs serial`);
  return receipt.status === 'passed' ? 0 : 1;
}
