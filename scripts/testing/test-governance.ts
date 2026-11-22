import { createHash } from 'crypto';
import { spawnSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'fs';
import { dirname, join, relative, resolve } from 'path';
import {
  classifyTestSignal,
  mapTestSupervisorFailure,
  runBunTestFile,
  TEST_FAILURE_CODES,
  type BunTestFileRunResult,
  type TestFailureClass,
} from '../run-bun-test-file';
import { runBoundedChild, type BoundedChildRunResult } from '../../src/runtime/shared/bounded-child-supervisor';
import {
  ensureRepositoryCheckStorage,
  type RepositoryCheckStorageAuthority,
} from '../../src/runtime/execution/process-runtime/check-storage';
import {
  MAX_STRUCTURED_CHECK_FAILURE_DETAILS,
  type StructuredCheckFailureEvidence,
} from '../../src/runtime/execution/process-runtime/check-result';

export const TEST_MODULES = [
  'core',
  'controller',
  'process-runtime',
  'routing',
  'repository',
  'browser',
  'ios',
  'workflow',
  'runner',
  'release',
] as const;
export const TEST_RESOURCES = [
  'pure',
  'temp-isolated',
  'controller-home-isolated',
  'git-worktree',
  'process-tree',
  'fixed-port',
  'runtime-singleton',
  'destructive',
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
  /** Explicit authorization to exercise this test on a pinned source snapshot. */
  committedSnapshot?: boolean;
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
  'git-worktree',
  'process-tree',
  'fixed-port',
  'runtime-singleton',
]);
const CONTENT_EXCLUDES = [
  '.ai/',
  '.git/',
  '.codegraph/',
  '.forge/',
  '_ops/',
  'node_modules/',
  'tasks/',
  'plans/',
  'references/',
  'dist/',
  'coverage/',
];
const CHANGE_EXCLUDES = [...CONTENT_EXCLUDES, 'tmp/', 'temp/'];
const EPHEMERAL_SUFFIXES = [
  '.log',
  '.tmp',
  '.temp',
  '.pid',
  '.lock',
  '.trace',
  '.out',
  '.cache',
  '.bak',
  '.swp',
  '.swo',
];
const TEST_INPUT_CONFIG = [MANIFEST_PATH, 'package.json', 'bun.lock', 'tsconfig.json'];
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs', '.json'];

function git(repoRoot: string, args: string[]): string {
  const result = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) return '';
  return result.stdout ?? '';
}

function requiredGit(repoRoot: string, args: string[]): string {
  const result = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (result.error || result.status !== 0) {
    throw new Error(
      `Cannot determine complete Git change baseline (${args[0]}): ${result.error?.message ?? result.stderr?.trim() ?? `exit ${result.status}`}`,
    );
  }
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

/**
 * Whole-workspace content guard for Gates. Preserve every tracked/untracked
 * input, but reuse Git's blob identity for clean regular files rather than
 * re-reading thousands of unchanged files on each Gate boundary.
 * Dirty, deleted and untracked content is still read from disk; neither the
 * commit SHA nor Git index alone can stand in for the working-tree candidate.
 */
export function testContentDigest(repoRoot: string): string {
  const index = new Map<string, { mode: string; blob: string; trusted: boolean }>();
  // One Git query returns both stage data and unsafe index flags. Do not trust
  // skip-worktree or assume-unchanged entries as proof of live file bytes.
  for (const record of requiredGit(repoRoot, ['ls-files', '--stage', '-v', '-z']).split('\0').filter(Boolean)) {
    const entry = /^(. )([0-7]{6}) ([0-9a-f]{40,64}) (\d)\t([\s\S]+)$/.exec(record);
    if (!entry || entry[4] !== '0') throw new Error('Cannot fingerprint unresolved Git index entry');
    index.set(entry[5]!, { mode: entry[2]!, blob: entry[3]!, trusted: entry[1] === 'H ' });
  }
  // --no-renames keeps each record one NUL-delimited status + path, including
  // a staged rename's deleted source and newly created destination.
  const modified = new Set<string>();
  const untracked: string[] = [];
  for (const record of requiredGit(repoRoot, [
    'status',
    '--porcelain=v1',
    '--no-renames',
    '-z',
    '--untracked-files=all',
  ])
    .split('\0')
    .filter(Boolean)) {
    if (record.length < 4 || record[2] !== ' ') throw new Error('Cannot fingerprint Git working-tree status');
    const path = record.slice(3);
    if (record.slice(0, 2) === '??') untracked.push(path);
    else modified.add(path);
  }
  const paths = [...new Set([...index.keys(), ...untracked])]
    .filter((path) => !CONTENT_EXCLUDES.some((prefix) => path.startsWith(prefix)))
    .sort();
  const blobLength = index.values().next().value?.blob.length;
  const format =
    blobLength === 40
      ? 'sha1'
      : blobLength === 64
        ? 'sha256'
        : requiredGit(repoRoot, ['rev-parse', '--show-object-format']).trim();
  if (format !== 'sha1' && format !== 'sha256') throw new Error('Unsupported Git object format: ' + format);
  // Git's clean/smudge filters and line-ending conversions can make an index
  // blob differ from the actual checked-out bytes even when status is clean.
  // Preserve byte-exact CAS with the original full read in these repositories.
  const attributes = spawnSync(
    'git',
    ['config', '--get-regexp', '^(core\\.autocrlf|core\\.eol|core\\.attributesfile|filter\\..*)'],
    { cwd: repoRoot, encoding: 'utf8' },
  );
  if (attributes.error || (attributes.status !== 0 && attributes.status !== 1)) {
    throw new Error('Cannot inspect Git content conversion configuration');
  }
  const byteFiltersPossible =
    attributes.status === 0 ||
    existsSync(resolve(repoRoot, '.git/info/attributes')) ||
    paths.some((path) => path === '.gitattributes' || path.endsWith('/.gitattributes'));
  const digest = createHash('sha256').update('forge-test-content-v2\n');
  for (const path of paths) {
    digest.update(`${path}\0`);
    const entry = index.get(path);
    if (
      !byteFiltersPossible &&
      entry?.trusted &&
      !modified.has(path) &&
      (entry.mode === '100644' || entry.mode === '100755')
    ) {
      digest.update(entry.blob);
      continue;
    }
    try {
      const content = readFileSync(resolve(repoRoot, path));
      // Match Git's blob identity exactly, so staging, committing or reverting
      // identical bytes cannot make a content-only Gate cache miss.
      digest.update(createHash(format).update(`blob ${content.length}\0`).update(content).digest('hex'));
    } catch (_error) {
      digest.update('missing');
    }
  }
  return digest.digest('hex');
}

export function trackedTreeDigest(repoRoot: string): string {
  return hashFiles(repoRoot, repositoryFiles(repoRoot, false), 'forge-tracked-tree-v1');
}

export function isTestRelevantChangedPath(rawPath: string): boolean {
  const path = String(rawPath ?? '')
    .replace(/^\.\//, '')
    .replace(/\\/g, '/')
    .trim();
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
  if (JSON.stringify(manifest.modules) !== JSON.stringify(TEST_MODULES))
    errors.push('module catalog does not match v1 contract');
  if (JSON.stringify(manifest.resources) !== JSON.stringify(TEST_RESOURCES))
    errors.push('resource catalog does not match v1 contract');
  const diskFiles = listTestsOnDisk(join(repoRoot, 'tests'), repoRoot).sort();
  const declaredFiles = Object.keys(manifest.tests).sort();
  for (const file of diskFiles) if (!manifest.tests[file]) errors.push(`test is not declared: ${file}`);
  for (const file of declaredFiles)
    if (!diskFiles.includes(file)) errors.push(`manifest entry has no test file: ${file}`);
  for (const [file, entry] of Object.entries(manifest.tests)) {
    if (!TEST_MODULES.includes(entry.module)) errors.push(`${file}: invalid module ${String(entry.module)}`);
    if (!TEST_RESOURCES.includes(entry.resource)) errors.push(`${file}: invalid resource ${String(entry.resource)}`);
    if (
      entry.committedSnapshot !== undefined &&
      (entry.committedSnapshot !== true || entry.resource !== 'controller-home-isolated')
    )
      errors.push(`${file}: committedSnapshot requires a controller-home-isolated opt-in`);
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
    const baseRef = options.baseRef.trim();
    if (/^0{40}(?:0{24})?$/.test(baseRef)) {
      // The initial push has no before commit: check the full tracked tree.
      for (const path of requiredGit(repoRoot, ['ls-files', '--cached', '-z']).split('\0').filter(Boolean))
        paths.add(path);
    } else {
      // An unresolvable/shallow base must fail closed, never shrink to HEAD-only.
      const mergeBase = requiredGit(repoRoot, ['merge-base', baseRef, 'HEAD']).trim();
      if (!mergeBase) throw new Error(`Cannot determine complete Git change baseline for ${baseRef}`);
      for (const path of requiredGit(repoRoot, ['diff', '--no-renames', '--name-only', '-z', `${mergeBase}...HEAD`])
        .split('\0')
        .filter(Boolean))
        paths.add(path);
    }
  }
  for (const args of [
    ['diff', '--no-renames', '--name-only', '-z'],
    ['diff', '--cached', '--no-renames', '--name-only', '-z'],
    ['ls-files', '--others', '--exclude-standard', '-z'],
  ]) {
    for (const path of git(repoRoot, args).split('\0').filter(Boolean)) paths.add(path);
  }
  return [...paths].filter(isTestRelevantChangedPath).sort();
}

/** Deleted and renamed-away paths still affect test selection, but cannot be formatted. */
export function existingChangedFiles(repoRoot: string, changedPaths: Iterable<string>): string[] {
  return [...changedPaths].filter((path) => {
    const absolute = resolve(repoRoot, path);
    if (relative(repoRoot, absolute).startsWith('..')) return false;
    try {
      return statSync(absolute).isFile();
    } catch {
      return false;
    }
  });
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
  const meaningfulChangedPaths = [
    ...new Set(changedPaths.map((path) => path.replace(/^\.\//, '')).filter(isTestRelevantChangedPath)),
  ].sort();
  const changedModules = new Set<TestModule>();
  for (const path of meaningfulChangedPaths)
    for (const module of modulesForChangedPath(path, manifest)) changedModules.add(module);
  if (changedModules.size === 0) changedModules.add('core');
  const direct = new Set(
    explicitTestFiles.length > 0
      ? explicitTestFiles
      : meaningfulChangedPaths.filter((path) => Boolean(manifest.tests[path])),
  );
  const entries = Object.entries(manifest.tests);
  let selected: string[];
  if (explicitTestFiles.length > 0) {
    selected = explicitTestFiles.filter((file) => Boolean(manifest.tests[file]));
  } else if (gate === 'core') {
    selected = entries
      .filter(([, entry]) => entry.smoke || (entry.module === 'core' && entry.resource === 'pure'))
      .map(([file]) => file);
  } else if (gate === 'affected') {
    selected =
      meaningfulChangedPaths.length === 0
        ? entries.filter(([, entry]) => entry.smoke).map(([file]) => file)
        : entries
            .filter(
              ([file, entry]) =>
                (direct.has(file) &&
                  !INFRASTRUCTURE_RESOURCES.has(entry.resource) &&
                  entry.resource !== 'destructive') ||
                entry.smoke ||
                (changedModules.has(entry.module) && entry.resource === 'pure'),
            )
            .map(([file]) => file);
  } else if (gate === 'integration') {
    selected = entries
      .filter(
        ([, entry]) =>
          changedModules.has(entry.module) &&
          (entry.resource === 'temp-isolated' || entry.resource === 'controller-home-isolated'),
      )
      .map(([file]) => file);
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
    reason:
      explicitTestFiles.length > 0
        ? 'explicit test files'
        : gate === 'full'
          ? 'full non-destructive suite'
          : gate === 'infrastructure'
            ? 'infrastructure suite'
            : gate === 'fault'
              ? 'fault-injection suite'
              : noChanges
                ? 'no changes detected; core smoke only'
                : `changed paths mapped to ${[...changedModules].sort().join(', ')}`,
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
  return createHash('sha256')
    .update(
      JSON.stringify({
        ci: process.env.CI ?? '',
        controllerHome: Boolean(process.env.FORGE_CONTROLLER_HOME),
        docker: Boolean(process.env.DOCKER_HOST),
      }),
    )
    .digest('hex')
    .slice(0, 16);
}

function readPassedCheckpoint(path: string, key: string): TestCheckpoint | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const checkpoint = JSON.parse(readFileSync(path, 'utf8')) as TestCheckpoint;
    return checkpoint.version === 2 && checkpoint.key === key && checkpoint.status === 'passed'
      ? checkpoint
      : undefined;
  } catch (_error) {
    return undefined;
  }
}

async function runPool<T>(items: T[], concurrency: number, run: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  const boundedConcurrency = Math.max(1, Math.trunc(Number.isFinite(concurrency) ? concurrency : 1));
  await Promise.all(
    Array.from({ length: Math.min(boundedConcurrency, items.length) }, async () => {
      while (cursor < items.length) {
        const index = cursor++;
        await run(items[index]!);
      }
    }),
  );
}

export interface TestRunReceipt {
  version: 1;
  gate: TestGate;
  contentDigest: string;
  runnerDigest: string;
  status: 'passed' | 'failed';
  selected: number;
  cacheHits: number;
  cacheProvenance: Array<Record<string, unknown>>;
  failures: number;
  failureEvidence: StructuredCheckFailureEvidence;
  modules: TestModule[];
  durationMs: number;
  serialEquivalentMs: number;
  serialReduction: number;
  lanes: Record<string, number>;
  completedAt: string;
}

export interface RunTestSelectionOptions {
  useCache?: boolean;
  /** Temporary pinned-commit test source, never registered as a development checkout. */
  isolatedCandidateRoot?: string;
  isolatedCandidateRevision?: string;
  storageAuthority?: RepositoryCheckStorageAuthority;
  pureConcurrency?: number;
  tempConcurrency?: number;
  onReceipt?: (receipt: TestRunReceipt) => void;
}

function classifyIndependentTestChild(
  result: BoundedChildRunResult,
): Pick<BunTestFileRunResult, 'failureClass' | 'failureCode' | 'signal'> {
  const infrastructureFailure = mapTestSupervisorFailure(result.failureCode);
  if (infrastructureFailure) return { failureClass: 'infrastructure', failureCode: infrastructureFailure };
  const interrupted = classifyTestSignal(result.signal);
  if (interrupted) return { ...interrupted, signal: result.signal ?? undefined };
  if (result.status !== 0) return { failureClass: 'source', failureCode: TEST_FAILURE_CODES.SOURCE_ASSERTION_FAILED };
  return {};
}

export async function runTestSelection(
  repoRoot: string,
  manifest: TestManifest,
  selection: TestSelection,
  options: RunTestSelectionOptions = {},
): Promise<number> {
  const useCache = options.useCache ?? true;
  const storage = ensureRepositoryCheckStorage(repoRoot, options.storageAuthority);
  const eligibleForSnapshot = (entry: TestManifestEntry): boolean =>
    entry.resource === 'pure' ||
    entry.resource === 'temp-isolated' ||
    (entry.resource === 'controller-home-isolated' && entry.committedSnapshot === true);
  const fullyIsolated = Boolean(
    options.isolatedCandidateRoot && selection.files.every((file) => eligibleForSnapshot(manifest.tests[file]!)),
  );
  // A fixed Git tree identifies committed test sources without rehashing
  // unrelated Writer dirty. Shared/mixed suites retain the workspace digest.
  const committedTree = fullyIsolated
    ? requiredGit(options.isolatedCandidateRoot!, ['rev-parse', '--verify', 'HEAD^{tree}']).trim()
    : undefined;
  const contentDigest = committedTree
    ? createHash('sha256').update(`forge-test-content-git-tree-v1\n${committedTree}`).digest('hex')
    : testContentDigest(repoRoot);
  const runnerInputs = [
    MANIFEST_PATH,
    'scripts/run-bun-test-file.ts',
    'scripts/test-governance.ts',
    'scripts/testing/test-governance.ts',
    'src/runtime/shared/bounded-child-supervisor.ts',
    'src/runtime/shared/process-tree.ts',
  ];
  const runnerDigest = fullyIsolated
    ? hashFiles(
        options.isolatedCandidateRoot!,
        runnerInputs,
        `test-runner-v1:committed:${options.isolatedCandidateRevision ?? 'unknown'}`,
      )
    : hashFiles(repoRoot, runnerInputs, 'test-runner-v1');
  const isolatedRunnerDigest = fullyIsolated
    ? runnerDigest
    : options.isolatedCandidateRoot
      ? hashFiles(
          options.isolatedCandidateRoot,
          runnerInputs,
          `test-runner-v1:committed:${options.isolatedCandidateRevision ?? 'unknown'}`,
        )
      : undefined;
  const toolchain = toolchainSignature();
  const capability = capabilitySignature();
  let failures = 0;
  let cacheHits = 0;
  const failureClasses = new Set<TestFailureClass>();
  const failureDetails: StructuredCheckFailureEvidence['failureDetails'] = [];
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
    // Only independent resource classes run against an immutable candidate
    // copy. Shared/host-dependent tests retain the registered checkout until
    // their external dependencies can be isolated without changing semantics.
    const isolated = options.isolatedCandidateRoot && eligibleForSnapshot(entry);
    const testRoot = isolated ? options.isolatedCandidateRoot! : repoRoot;
    // The isolated Git fixture has its own commit identity. Outer publication
    // baseline variables refer to the canonical repo, not this test fixture.
    const testEnv = isolated ? { ...process.env } : process.env;
    if (isolated) {
      delete testEnv.TEST_BASE_REF;
      delete testEnv.FORGE_CHECK_CANDIDATE_SHA;
      delete testEnv.FORGE_CHECK_SOURCE_QUALITY_MODE;
    }
    const checkRunnerDigest = isolated ? isolatedRunnerDigest! : runnerDigest;
    const testDigest = hashFiles(testRoot, [file], 'test-file-v1');
    const inputDigest = testInputDigest(testRoot, file);
    const key = createHash('sha256')
      .update(
        JSON.stringify({
          inputDigest,
          runnerDigest: checkRunnerDigest,
          testDigest,
          toolchain,
          capability,
          file,
        }),
      )
      .digest('hex');
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
      console.error(
        `[tests] cache hit ${file} key=${cachedCheckpoint.key.slice(0, 16)} completedAt=${cachedCheckpoint.completedAt} evidence=${checkpointRelativePath}`,
      );
      return;
    }

    let attempts = 0;
    let result: BunTestFileRunResult;
    const startedAt = performance.now();
    do {
      attempts += 1;
      // Ignore changes between child runs, but preserve the strict workspace
      // mutation veto during each child. A simultaneous external Writer cannot
      // be distinguished from test mutation here without process isolation.
      const testWorkspaceBefore = workspaceMutationDigest(testRoot);
      console.error(`[tests] ${file}${attempts > 1 ? ' (infrastructure retry)' : ''}`);
      if (file.endsWith('.test.mjs')) {
        const independent = await runBoundedChild('node', ['--test', file], {
          cwd: testRoot,
          env: testEnv,
          timeoutMs: Number(process.env.BUN_TEST_FILE_WALL_TIMEOUT_MS ?? 120_000),
          stdio: 'inherit',
          forwardSignals: true,
        });
        result = {
          exitCode: independent.status,
          lingeringPids: independent.residualPids,
          remainingPids: independent.remainingPids,
          pidReuseFenced: independent.pidReuseFenced,
          ...classifyIndependentTestChild(independent),
        };
      } else if (file.startsWith('tests/infrastructure/')) {
        const independent = await runBoundedChild(
          process.execPath,
          ['test', '--timeout', process.env.BUN_TEST_TIMEOUT_MS ?? '60000', '--max-concurrency', '1', file],
          {
            cwd: testRoot,
            env: testEnv,
            timeoutMs: Number(process.env.BUN_TEST_FILE_WALL_TIMEOUT_MS ?? 120_000),
            stdio: 'inherit',
            forwardSignals: true,
          },
        );
        result = {
          exitCode: independent.status,
          lingeringPids: independent.residualPids,
          remainingPids: independent.remainingPids,
          pidReuseFenced: independent.pidReuseFenced,
          ...classifyIndependentTestChild(independent),
        };
      } else {
        result = await runBunTestFile(
          ['--timeout', process.env.BUN_TEST_TIMEOUT_MS ?? '60000', '--max-concurrency', '1', file],
          { forwardSignals: true, cwd: testRoot, env: testEnv },
        );
      }
      if (
        workspaceMutationDigest(testRoot) !== testWorkspaceBefore ||
        testInputDigest(testRoot, file) !== inputDigest
      ) {
        contaminated = true;
        result = {
          ...result,
          exitCode: 1,
          failureClass: 'infrastructure',
          failureCode: TEST_FAILURE_CODES.INFRA_WORKTREE_MUTATION,
        };
        console.error(
          `[tests] ${TEST_FAILURE_CODES.INFRA_WORKTREE_MUTATION}: tracked tree changed while running ${file}`,
        );
        break;
      }
    } while (result.failureClass === 'infrastructure' && attempts < 2);

    const checkpoint: TestCheckpoint = {
      version: 2,
      key,
      inputDigest,
      runnerDigest: checkRunnerDigest,
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
    if (result.exitCode !== 0) {
      failures += 1;
      const failureClass = result.failureClass ?? 'infrastructure';
      const failureCode = result.failureCode ?? TEST_FAILURE_CODES.INFRA_UNCLASSIFIED_NONZERO;
      failureClasses.add(failureClass);
      failureDetails.push({
        file,
        failureClass,
        failureCode,
        attempts,
        durationMs: checkpoint.durationMs,
        ...(result.signal ? { signal: result.signal } : {}),
      });
      failureDetails.sort((left, right) => left.file.localeCompare(right.file));
      if (failureDetails.length > MAX_STRUCTURED_CHECK_FAILURE_DETAILS) failureDetails.pop();
    }
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
  await Promise.all(
    [...serialLanes.entries()].map(async ([resource, files]) => {
      console.error(`[tests] serial lane ${resource}: ${files.length} file(s)`);
      for (const file of files) await runOne(file);
    }),
  );

  // A completed suite is not invalidated by edits made after its last child
  // exited. Each executed child was checked against its own pre-run baseline.
  const durationMs = Math.round(performance.now() - runStartedAt);
  const serialReduction = serialEquivalentMs > 0 ? Math.max(0, 1 - durationMs / serialEquivalentMs) : 0;

  const status = failures === 0 && !contaminated ? ('passed' as const) : ('failed' as const);
  const failureEvidence: StructuredCheckFailureEvidence = {
    schemaVersion: 1,
    producer: 'test-governance',
    gate: selection.gate,
    status,
    failures,
    failureClasses: [...failureClasses].sort(),
    failureDetails: [...failureDetails],
    failureDetailsTruncated: failures > failureDetails.length,
    contaminated,
  };
  const receipt: TestRunReceipt = {
    version: 1,
    gate: selection.gate,
    contentDigest,
    runnerDigest,
    status,
    selected: selection.files.length,
    cacheHits,
    cacheProvenance: cacheProvenance.sort((left, right) => left.file.localeCompare(right.file)),
    failures,
    failureEvidence,
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
  options.onReceipt?.(receipt);
  console.error(
    `[tests] ${receipt.status}: ${selection.files.length} selected, ${cacheHits} checkpoint hit(s), ${failures} failure(s), ${(serialReduction * 100).toFixed(1)}% vs serial`,
  );
  return receipt.status === 'passed' ? 0 : 1;
}
