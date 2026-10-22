import { writeAtomicTextFile } from '../shared/atomic-text-file';
import { createHash, randomUUID } from 'crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'fs';
import { basename, dirname, join, relative, resolve } from 'path';
import { ensureControllerHome } from '../../effects/controller-home';
import { CONTROL_PLANE_SCHEMA_VERSION } from '../control-plane/persistence/sqlite-store';
import { packageRuntimeSourceRoot } from '../control-plane/runtime-generation';
import { FORGE_VERSION } from '../../version';
import { publishRuntimeRelease, type RuntimeReleaseAuthority } from './release-store';
import { assertRuntimeReleaseExecutionSurface } from './release-manifest';
import { assertRuntimeReleaseExecutionCanaries } from './release-execution-canary';
import type { RuntimeReleaseManifest } from './types';
import { assertStorageHeadroom } from '../shared/storage-capacity';

export interface PackageRuntimeFileRecord {
  path: string;
  sha256: string;
  bytes: number;
}

export interface PackageRuntimeRelease {
  releaseId: string;
  releaseRoot: string;
  packageRoot: string;
  packageVersion: string;
  packageFingerprint: string;
  artifactIdentity: string;
  entrypointPath: string;
  manifestPath: string;
  indexPath: string;
  fileCount: number;
  authority: RuntimeReleaseAuthority;
}

// A package Runtime is an immutable, independently launchable release. Its
// TypeScript entrypoints import both `src/` and the top-level modular-monolith
// roots at runtime, so retaining only `src/` creates a release that passes
// staging but cannot start after the installed package moves or disappears.
const PACKAGE_RUNTIME_ROOTS = ['src', 'adapters', 'packages', 'supervisor', 'bin', 'assets', 'scripts', 'node_modules'] as const;
const PACKAGE_RUNTIME_FILES = ['package.json'] as const;
// Compiled releases execute only compiled/bundled artifacts. Keep a tiny package
// projection for browser-extension installation plus two legacy Recovery
// recognition sentinels; neither sentinel is executed when the compiled
// Connector sidecar is present.
const COMPILED_RUNTIME_PACKAGE_ROOTS = ['adapters/computer/chrome-extension'] as const;
const COMPILED_RUNTIME_PACKAGE_FILES = [
  'package.json',
  'src/cli/index.ts',
  'src/runtime/shared/node-ts-loader.mjs',
] as const;
const PACKAGE_RUNTIME_STAGING_RESERVE_BYTES = 256 * 1024 * 1024;

function isNonRuntimePackageHelper(path: string): boolean {
  if (path.startsWith('scripts/benchmark-')) return true;
  if (path.startsWith('scripts/check-release-')) return true;
  if (path.startsWith('scripts/public-release')) return true;
  return path === 'scripts/route-nl-vs-ts-eval.ts'
    || path === 'scripts/check-npm-release.sh'
    || path === 'scripts/check-public-release-surface.sh'
    || path === 'scripts/check-tarball-install-smoke.sh'
    || path === 'scripts/publish-release-tarball.sh'
    || path === 'scripts/stage-runtime-release.ts'
    || path === 'scripts/package-source-archive.sh';
}

function sha256(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function walkRegularFiles(root: string, current: string, output: string[], prefix = ''): void {
  if (!existsSync(current)) return;
  const stat = lstatSync(current);
  // Package managers such as Bun can materialize dependency files as
  // symlinks. Follow file links while snapshotting their bytes, but never
  // traverse a linked directory: the resulting release must contain only
  // regular files beneath its own immutable package root.
  if (stat.isSymbolicLink()) {
    const target = statSync(current);
    if (target.isFile()) {
      const relativePath = relative(root, current).split('\\').join('/');
      output.push(prefix ? `${prefix}/${relativePath}` : relativePath);
    }
    return;
  }
  if (stat.isFile()) {
    const relativePath = relative(root, current).split('\\').join('/');
    output.push(prefix ? `${prefix}/${relativePath}` : relativePath);
    return;
  }
  if (!stat.isDirectory()) return;
  for (const entry of readdirSync(current).sort()) walkRegularFiles(root, join(current, entry), output, prefix);
}

function packageSourcePath(packageRoot: string, path: string, dependencyRoot = packageRoot): string {
  return path === 'node_modules' || path.startsWith('node_modules/')
    ? join(resolve(dependencyRoot), path)
    : join(resolve(packageRoot), path);
}

function packageFileIndex(
  packageRoot: string,
  roots: readonly string[],
  files: readonly string[],
  dependencyRoot = packageRoot,
): PackageRuntimeFileRecord[] {
  const root = resolve(packageRoot);
  const dependencies = resolve(dependencyRoot);
  const paths: string[] = [];
  for (const directory of roots) {
    if (directory === 'node_modules' && dependencies !== root) {
      const dependencyNodeModules = join(dependencies, 'node_modules');
      walkRegularFiles(dependencyNodeModules, dependencyNodeModules, paths, 'node_modules');
    } else {
      walkRegularFiles(root, join(root, directory), paths);
    }
  }
  for (const file of files) walkRegularFiles(root, join(root, file), paths);
  return [...new Set(paths)].sort().map((path) => {
    const bytes = readFileSync(packageSourcePath(root, path, dependencies));
    return { path, sha256: sha256(bytes), bytes: bytes.length };
  });
}

export function packageRuntimeFileIndex(packageRoot = packageRuntimeSourceRoot(), dependencyRoot = packageRoot): PackageRuntimeFileRecord[] {
  const root = resolve(packageRoot);
  const records = packageFileIndex(root, PACKAGE_RUNTIME_ROOTS, PACKAGE_RUNTIME_FILES, dependencyRoot)
    .filter((record) => !isNonRuntimePackageHelper(record.path));
  const paths = new Set(records.map((record) => record.path));
  if (!paths.has('package.json') || !paths.has('bin/forge-runtime.mjs')) {
    throw new Error(`PACKAGE_RUNTIME_SURFACE_INCOMPLETE: ${root}`);
  }
  return records;
}

interface PackageRuntimeDependencyManifest {
  dependencies?: Record<string, unknown>;
  optionalDependencies?: Record<string, unknown>;
}

function readPackageRuntimeDependencyManifest(packageRoot: string): PackageRuntimeDependencyManifest {
  try {
    const parsed = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as PackageRuntimeDependencyManifest;
    return {
      dependencies: parsed.dependencies && typeof parsed.dependencies === 'object' ? parsed.dependencies : undefined,
      optionalDependencies: parsed.optionalDependencies && typeof parsed.optionalDependencies === 'object' ? parsed.optionalDependencies : undefined,
    };
  } catch {
    return {};
  }
}

function installedDependencyDirectory(root: string, name: string): string {
  return join(root, 'node_modules', ...name.split('/'));
}

/**
 * Discover the hoisted dependency root when the package is installed in a
 * layout where dependencies are siblings rather than nested beneath the
 * package (Bun global installs hoist to `<global>/node_modules/*`). Returns
 * undefined for nested layouts (npm global installs, source checkouts), where
 * dependencies live under the package's own `node_modules`.
 */
function hoistedPackageRuntimeDependencyRoot(packageRoot: string): string | undefined {
  let current = resolve(packageRoot);
  for (let depth = 0; depth < 4; depth += 1) {
    const parent = dirname(current);
    if (parent === current) return undefined;
    // `<root>/node_modules/<pkg>` or `<root>/node_modules/<scope>/<pkg>`
    if (basename(parent) === 'node_modules') return dirname(parent);
    current = parent;
  }
  return undefined;
}

/**
 * One canonical dependency-closure discovery for immutable package Runtime
 * releases (#305). A nested layout (every declared dependency present under
 * the package's own `node_modules`, or no declared dependencies) keeps the
 * existing whole-tree snapshot. Otherwise the closure resolves every declared
 * dependency through standard node resolution inside the discovered dependency
 * root (nested-inside-dependency first, then hoisted siblings) and fails
 * closed when a required dependency is missing. Every closure record path
 * mirrors its resolved install location relative to
 * `<dependencyRoot>/node_modules`, so the existing single dependencyRoot
 * source mapping stays exact and the immutable release never depends on the
 * original global package's live path.
 */
export function packageRuntimeDependencyRecords(
  packageRoot = packageRuntimeSourceRoot(),
  dependencyRoot = packageRuntimeDependencyRootDiscovery(packageRoot),
): PackageRuntimeFileRecord[] {
  const root = resolve(packageRoot);
  const dependencies = dependencyRoot === undefined ? undefined : resolve(dependencyRoot);
  if (dependencies === undefined || dependencies === root) return [];
  const manifest = readPackageRuntimeDependencyManifest(root);
  const required = Object.keys(manifest.dependencies ?? {});
  const optional = Object.keys(manifest.optionalDependencies ?? {});
  if (required.length === 0 && optional.length === 0) return [];

  const records = new Map<string, PackageRuntimeFileRecord>();
  const installed = new Set<string>();
  // Resolution is scoped to the dependency root subtree: starting from the
  // package root would admit `<packageRoot>/node_modules` installs whose
  // record paths are indistinguishable from hoisted ones under the single
  // dependencyRoot source mapping. Hoisted layouts keep no nested installs
  // beneath the package, and a dependency satisfied by neither location
  // fails closed.
  const resolveDependencyInstall = (name: string, fromDir: string): string | undefined => {
    let current = resolve(fromDir);
    for (let depth = 0; depth < 16; depth += 1) {
      const candidate = installedDependencyDirectory(current, name);
      if (existsSync(candidate)) return candidate;
      if (current === dependencies) return undefined;
      const parent = dirname(current);
      if (parent === current || relative(dependencies, parent).startsWith('..')) return undefined;
      current = parent;
    }
    return undefined;
  };
  const queue: Array<{ name: string; fromDir: string; optional: boolean }> = [
    ...required.map((name) => ({ name, fromDir: dependencies, optional: false })),
    ...optional.map((name) => ({ name, fromDir: dependencies, optional: true })),
  ];
  while (queue.length > 0) {
    const item = queue.shift()!;
    const installDir = resolveDependencyInstall(item.name, item.fromDir);
    if (!installDir) {
      if (item.optional) continue;
      throw new Error(`PACKAGE_RUNTIME_DEPENDENCY_MISSING: ${item.name} (required by ${relative(dependencies, item.fromDir) || 'dependency root'})`);
    }
    // The record path mirrors the resolved install location relative to the
    // dependency root, so standard node resolution inside the immutable
    // release finds exactly these bytes.
    const recordPrefix = relative(dependencies, installDir).split('\\').join('/');
    if (recordPrefix === '' || recordPrefix.startsWith('..')) {
      throw new Error(`PACKAGE_RUNTIME_DEPENDENCY_RESOLUTION_ESCAPE: ${item.name} -> ${installDir}`);
    }
    if (installed.has(installDir)) continue;
    installed.add(installDir);
    const innerFiles: string[] = [];
    walkDependencyPackageFiles(installDir, installDir, innerFiles, recordPrefix);
    for (const path of innerFiles) {
      const bytes = readFileSync(join(installDir, path.slice(recordPrefix.length + 1)));
      records.set(path, { path, sha256: sha256(bytes), bytes: bytes.length });
    }
    const innerManifest = readPackageRuntimeDependencyManifest(installDir);
    queue.push(
      ...Object.keys(innerManifest.dependencies ?? {}).map((name) => ({ name, fromDir: installDir, optional: false })),
      ...Object.keys(innerManifest.optionalDependencies ?? {}).map((name) => ({ name, fromDir: installDir, optional: true })),
    );
  }
  return [...records.values()].sort((left, right) => left.path.localeCompare(right.path));
}

/**
 * Walk one resolved dependency package without descending into its own nested
 * `node_modules`: nested dependencies are resolved by the closure resolver so
 * each install location is recorded exactly once at its resolution path.
 */
function walkDependencyPackageFiles(root: string, current: string, output: string[], prefix: string): void {
  if (!existsSync(current)) return;
  const stat = lstatSync(current);
  if (stat.isSymbolicLink()) {
    const target = statSync(current);
    if (target.isFile()) {
      const relativePath = relative(root, current).split('\\').join('/');
      output.push(`${prefix}/${relativePath}`);
    }
    return;
  }
  if (stat.isFile()) {
    const relativePath = relative(root, current).split('\\').join('/');
    output.push(`${prefix}/${relativePath}`);
    return;
  }
  if (!stat.isDirectory()) return;
  if (relative(root, current) === 'node_modules') return;
  for (const entry of readdirSync(current).sort()) walkDependencyPackageFiles(root, join(current, entry), output, prefix);
}

/**
 * Package file index for a hoisted dependency layout: the package's own
 * `node_modules` is not walked (it holds nothing in a Bun global install);
 * dependency bytes come exclusively from the verified closure so every
 * `node_modules/**` record maps back to the dependency root exactly.
 */
export function packageRuntimeClosureFileIndex(packageRoot: string, dependencyRoot: string): PackageRuntimeFileRecord[] {
  const root = resolve(packageRoot);
  const ownRoots = PACKAGE_RUNTIME_ROOTS.filter((directory) => directory !== 'node_modules');
  const ownRecords = packageFileIndex(root, ownRoots, PACKAGE_RUNTIME_FILES)
    .filter((record) => !isNonRuntimePackageHelper(record.path));
  const records = [...ownRecords, ...packageRuntimeDependencyRecords(root, dependencyRoot)]
    .sort((left, right) => left.path.localeCompare(right.path))
    .filter((record, index, all) => index === 0 || all[index - 1]!.path !== record.path);
  const paths = new Set(records.map((record) => record.path));
  if (!paths.has('package.json') || !paths.has('bin/forge-runtime.mjs')) {
    throw new Error(`PACKAGE_RUNTIME_SURFACE_INCOMPLETE: ${root}`);
  }
  return records;
}

/**
 * Canonical layout discovery for `materializePackageRuntimeRelease`: nested
 * when every declared dependency is satisfied from the package's own
 * `node_modules` (or none are declared); otherwise the hoisted ancestor root
 * that must satisfy the closure. A required dependency satisfied by neither
 * layout fails closed.
 */
export function packageRuntimeDependencyRootDiscovery(packageRoot = packageRuntimeSourceRoot()): string | undefined {
  const root = resolve(packageRoot);
  const manifest = readPackageRuntimeDependencyManifest(root);
  const required = Object.keys(manifest.dependencies ?? {});
  const optional = Object.keys(manifest.optionalDependencies ?? {});
  if (required.length === 0 && optional.length === 0) return root;
  const missingNested: string[] = [];
  for (const name of [...required, ...optional]) {
    if (existsSync(installedDependencyDirectory(root, name))) continue;
    missingNested.push(name);
  }
  if (missingNested.length === 0) return root;
  const hoisted = hoistedPackageRuntimeDependencyRoot(root);
  if (hoisted === undefined) {
    const missingRequired = missingNested.filter((name) => required.includes(name));
    if (missingRequired.length === 0) return root;
    throw new Error(`PACKAGE_RUNTIME_DEPENDENCY_MISSING: ${missingRequired.join(', ')}`);
  }
  for (const name of required) {
    if (!existsSync(installedDependencyDirectory(hoisted, name))) {
      throw new Error(`PACKAGE_RUNTIME_DEPENDENCY_MISSING: ${name}`);
    }
  }
  return hoisted;
}

export function compiledRuntimePackageFileIndex(packageRoot = packageRuntimeSourceRoot()): PackageRuntimeFileRecord[] {
  const root = resolve(packageRoot);
  const records = packageFileIndex(root, COMPILED_RUNTIME_PACKAGE_ROOTS, COMPILED_RUNTIME_PACKAGE_FILES);
  const paths = new Set(records.map((record) => record.path));
  for (const required of COMPILED_RUNTIME_PACKAGE_FILES) {
    if (!paths.has(required)) throw new Error(`COMPILED_RUNTIME_PACKAGE_SURFACE_INCOMPLETE: ${required}`);
  }
  if (![...paths].some((path) => path.startsWith('adapters/computer/chrome-extension/'))) {
    throw new Error('COMPILED_RUNTIME_PACKAGE_SURFACE_INCOMPLETE: adapters/computer/chrome-extension');
  }
  return records;
}

export function packageRuntimeFingerprint(records: PackageRuntimeFileRecord[]): string {
  const hash = createHash('sha256');
  for (const record of records) hash.update(record.path).update('\0').update(record.sha256).update('\0').update(String(record.bytes)).update('\n');
  return hash.digest('hex');
}

function packageRuntimeArtifactIdentity(root: string, records: PackageRuntimeFileRecord[], dependencyRoot = root): string {
  const hash = createHash('sha256');
  for (const record of records) {
    hash.update(record.path).update('\0').update(readFileSync(packageSourcePath(root, record.path, dependencyRoot))).update('\0');
  }
  return `sha256:${hash.digest('hex')}`;
}

function assertPackageRuntimeSnapshot(snapshotRoot: string, records: PackageRuntimeFileRecord[]): void {
  if (!existsSync(snapshotRoot)) throw new Error('PACKAGE_RUNTIME_RELEASE_IMMUTABILITY_VIOLATION: package snapshot is missing');
  const rootStat = lstatSync(snapshotRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error('PACKAGE_RUNTIME_RELEASE_IMMUTABILITY_VIOLATION: package snapshot is not a regular directory');
  }
  for (const record of records) {
    const path = join(snapshotRoot, record.path);
    if (!existsSync(path)) throw new Error(`PACKAGE_RUNTIME_RELEASE_IMMUTABILITY_VIOLATION: package file is missing: ${record.path}`);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`PACKAGE_RUNTIME_RELEASE_IMMUTABILITY_VIOLATION: package file is not regular: ${record.path}`);
    }
    const bytes = readFileSync(path);
    if (bytes.length !== record.bytes || sha256(bytes) !== record.sha256) {
      throw new Error(`PACKAGE_RUNTIME_RELEASE_IMMUTABILITY_VIOLATION: package file changed: ${record.path}`);
    }
  }
}

export function stagePackageRuntimeSnapshot(
  sourceRoot: string,
  snapshotRoot: string,
  records: PackageRuntimeFileRecord[],
  dependencyRoot = sourceRoot,
): void {
  mkdirSync(snapshotRoot, { recursive: false, mode: 0o700 });
  for (const record of records) {
    const source = packageSourcePath(sourceRoot, record.path, dependencyRoot);
    const link = lstatSync(source);
    const stat = link.isSymbolicLink() ? statSync(source) : link;
    if (!stat.isFile()) throw new Error(`PACKAGE_RUNTIME_SOURCE_CHANGED_DURING_STAGE: ${record.path}`);
    const bytes = readFileSync(source);
    if (bytes.length !== record.bytes || sha256(bytes) !== record.sha256) {
      throw new Error(`PACKAGE_RUNTIME_SOURCE_CHANGED_DURING_STAGE: ${record.path}`);
    }
    const destination = join(snapshotRoot, record.path);
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
    const mode = stat.mode & 0o777;
    writeFileSync(destination, bytes, { mode });
    try { chmodSync(destination, mode); } catch { /* best effort */ }
  }
  assertPackageRuntimeSnapshot(snapshotRoot, records);
}

function packageVersion(root: string): string {
  try {
    const value = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { name?: unknown; version?: unknown };
    if (value.name !== '@moretea-labs/forge') throw new Error('package name mismatch');
    if (typeof value.version !== 'string' || !value.version.trim()) throw new Error('package version missing');
    return value.version.trim();
  } catch (error) {
    throw new Error(`PACKAGE_RUNTIME_IDENTITY_INVALID: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function launcherSource(input: {
  indexSha256: string;
  entryRelativePath?: string;
  managerSignalsProcessGroup?: boolean;
}): string {
  const entryRelativePath = input.entryRelativePath ?? 'src/runtime/root/entry.ts';
  return `#!${process.execPath}\n`
    + `import { createHash } from 'node:crypto';\n`
    + `import { existsSync, readFileSync } from 'node:fs';\n`
    + `import { dirname, join } from 'node:path';\n`
    + `import { fileURLToPath } from 'node:url';\n`
    + `import { spawn } from 'node:child_process';\n`
    // macOS runs a byte-for-byte mirror of this launcher from its fixed,
    // TCC-stable service path. The mirrored file is not its immutable release
    // directory, so use the launch contract's attested release binding when it
    // is present. Direct execution from the immutable release still derives
    // the same root from the entrypoint location.
    + `const releaseRoot=process.env.FORGE_RELEASE_PATH?.trim()||dirname(fileURLToPath(import.meta.url));\n`
    + `const packageRoot=join(releaseRoot,'package');\n`
    + `const indexPath=join(releaseRoot,'package-files.json');\n`
    + `const expectedIndex=${JSON.stringify(input.indexSha256)};\n`
    + `const digest=(v)=>createHash('sha256').update(v).digest('hex');\n`
    + `let raw; try { raw=readFileSync(indexPath); } catch (error) { console.error('FORGE_PACKAGE_RUNTIME_INDEX_MISSING: '+error.message); process.exit(78); }\n`
    + `if(digest(raw)!==expectedIndex){console.error('FORGE_PACKAGE_RUNTIME_INDEX_CHANGED');process.exit(78);}\n`
    + `let records; try { records=JSON.parse(raw.toString('utf8')).files; } catch { console.error('FORGE_PACKAGE_RUNTIME_INDEX_INVALID'); process.exit(78); }\n`
    + `for(const record of records){const path=join(packageRoot,record.path);if(!existsSync(path)||digest(readFileSync(path))!==record.sha256){console.error('FORGE_PACKAGE_RUNTIME_SOURCE_CHANGED: '+record.path);process.exit(78);}}\n`
    + `const entry=join(packageRoot,...${JSON.stringify(entryRelativePath.split('/'))});\n`
    + `const loader=join(packageRoot,'src','runtime','shared','node-ts-loader.mjs');\n`
    + `const args=process.versions?.bun?[entry,...process.argv.slice(2)]:['--loader',loader,entry,...process.argv.slice(2)];\n`
    + `const child=spawn(process.execPath,args,{stdio:'inherit',env:process.env});\n`
    + `const managerSignalsProcessGroup=${input.managerSignalsProcessGroup ? "process.platform==='linux'&&Boolean(process.env.INVOCATION_ID)" : "false"};\n`
    + `for(const signal of ['SIGINT','SIGTERM','SIGHUP']){try{process.on(signal,()=>{if(!managerSignalsProcessGroup)child.kill(signal);});}catch{}}\n`
    + `child.on('error',(error)=>{console.error('FORGE_PACKAGE_RUNTIME_LAUNCH_FAILED: '+error.message);process.exit(1);});\n`
    + `child.on('exit',(code)=>process.exit(code??1));\n`;
}

function assertImmutablePackageRuntimeRelease(input: {
  releaseRoot: string;
  packageRoot: string;
  records: PackageRuntimeFileRecord[];
  indexPath: string;
  indexJson: string;
  entrypointPath: string;
  launcher: string;
  processRunnerPath: string;
  processRunnerLauncher: string;
  checkRunnerPath: string;
  checkRunnerLauncher: string;
  contextPackPath: string;
  contextPackLauncher: string;
  pluginActionSidecarPath: string;
  pluginActionSidecarLauncher: string;
  manifestPath: string;
  expectedManifest: Omit<RuntimeReleaseManifest, 'createdAt'>;
}): void {
  const rootStat = lstatSync(input.releaseRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('PACKAGE_RUNTIME_RELEASE_IMMUTABILITY_VIOLATION: release root is not a regular directory');
  assertPackageRuntimeSnapshot(input.packageRoot, input.records);
  const assertFile = (path: string, expected: string, label: string, executable = false) => {
    if (!existsSync(path)) throw new Error(`PACKAGE_RUNTIME_RELEASE_IMMUTABILITY_VIOLATION: ${label} is missing`);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || readFileSync(path, 'utf8') !== expected
      || (executable && process.platform !== 'win32' && (stat.mode & 0o111) === 0)) {
      throw new Error(`PACKAGE_RUNTIME_RELEASE_IMMUTABILITY_VIOLATION: ${label} changed`);
    }
  };
  assertFile(input.indexPath, input.indexJson, 'package file index');
  assertFile(input.entrypointPath, input.launcher, 'runtime launcher', true);
  assertFile(input.processRunnerPath, input.processRunnerLauncher, 'process runner launcher', true);
  assertFile(input.checkRunnerPath, input.checkRunnerLauncher, 'check runner launcher', true);
  assertFile(input.contextPackPath, input.contextPackLauncher, 'context pack launcher', true);
  assertFile(input.pluginActionSidecarPath, input.pluginActionSidecarLauncher, 'plugin action sidecar launcher', true);
  if (!existsSync(input.manifestPath)) throw new Error('PACKAGE_RUNTIME_RELEASE_IMMUTABILITY_VIOLATION: manifest is missing');
  const manifestStat = lstatSync(input.manifestPath);
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) throw new Error('PACKAGE_RUNTIME_RELEASE_IMMUTABILITY_VIOLATION: manifest is not a regular file');
  let manifest: RuntimeReleaseManifest;
  try {
    manifest = JSON.parse(readFileSync(input.manifestPath, 'utf8')) as RuntimeReleaseManifest;
  } catch {
    throw new Error('PACKAGE_RUNTIME_RELEASE_IMMUTABILITY_VIOLATION: manifest is unreadable');
  }
  const expected = input.expectedManifest;
  const compatible = manifest.schemaVersion === expected.schemaVersion
    && manifest.releaseId === expected.releaseId
    && manifest.artifactIdentity === expected.artifactIdentity
    && manifest.entrypoint === expected.entrypoint
    && manifest.executionMode === expected.executionMode
    && manifest.processRunnerEntrypoint === expected.processRunnerEntrypoint
    && manifest.processRunnerArtifactIdentity === expected.processRunnerArtifactIdentity
    && manifest.checkRunnerEntrypoint === expected.checkRunnerEntrypoint
    && manifest.checkRunnerArtifactIdentity === expected.checkRunnerArtifactIdentity
    && manifest.contextPackEntrypoint === expected.contextPackEntrypoint
    && manifest.contextPackArtifactIdentity === expected.contextPackArtifactIdentity
    && manifest.pluginActionSidecarEntrypoint === expected.pluginActionSidecarEntrypoint
    && manifest.pluginActionSidecarArtifactIdentity === expected.pluginActionSidecarArtifactIdentity
    && JSON.stringify(manifest.arguments ?? []) === JSON.stringify(expected.arguments ?? [])
    && manifest.configurationSchemaVersion === expected.configurationSchemaVersion
    && manifest.deploymentScope === expected.deploymentScope
    && (manifest.deploymentScope === 'portable'
      ? expected.deploymentScope === 'portable'
      : typeof manifest.controllerHome === 'string'
        && typeof expected.controllerHome === 'string'
        && resolve(manifest.controllerHome) === resolve(expected.controllerHome))
    && JSON.stringify(manifest.databaseSchemaCompatibility) === JSON.stringify(expected.databaseSchemaCompatibility)
    && manifest.workerProtocolVersion === expected.workerProtocolVersion
    && manifest.releaseRevision === expected.releaseRevision
    && manifest.cleanWorkspace === expected.cleanWorkspace
    && typeof manifest.createdAt === 'string'
    && Number.isFinite(Date.parse(manifest.createdAt));
  if (!compatible) throw new Error('PACKAGE_RUNTIME_RELEASE_IMMUTABILITY_VIOLATION: manifest identity changed');
  if (!expected.controllerHome) throw new Error('PACKAGE_RUNTIME_RELEASE_IMMUTABILITY_VIOLATION: package release must remain ControllerHome-bound');
  assertRuntimeReleaseExecutionSurface(input.manifestPath, expected.controllerHome);
}

export function materializePackageRuntimeRelease(input: {
  controllerHome?: string;
  packageRoot?: string;
  operationId?: string;
} = {}): PackageRuntimeRelease {
  const controllerHome = ensureControllerHome(input.controllerHome);
  const sourcePackageRoot = resolve(input.packageRoot ?? packageRuntimeSourceRoot());
  const version = packageVersion(sourcePackageRoot);
  // One canonical dependency-closure discovery covers both install layouts:
  // nested npm globals keep the whole own-node_modules snapshot, Bun-hoisted
  // globals snapshot the resolved closure from the hoisted dependency root
  // (#305). Missing required dependencies fail closed before any staging.
  const dependencyRoot = packageRuntimeDependencyRootDiscovery(sourcePackageRoot);
  const records = dependencyRoot !== undefined && dependencyRoot !== sourcePackageRoot
    ? packageRuntimeClosureFileIndex(sourcePackageRoot, dependencyRoot)
    : packageRuntimeFileIndex(sourcePackageRoot);
  const fingerprint = packageRuntimeFingerprint(records);
  const packageArtifactIdentity = packageRuntimeArtifactIdentity(sourcePackageRoot, records, dependencyRoot);
  const safeVersion = version.replace(/[^A-Za-z0-9._-]+/g, '-');
  const launcherBinding = sha256(`${resolve(process.execPath)}\0package-launcher-v9`);
  const releaseId = `package-${safeVersion}-${fingerprint.slice(0, 16)}-${launcherBinding.slice(0, 12)}`;
  const releasesRoot = join(controllerHome, 'runtime', 'releases');
  const releaseRoot = join(releasesRoot, releaseId);
  const packageRoot = join(releaseRoot, 'package');
  const indexPath = join(releaseRoot, 'package-files.json');
  const indexJson = `${JSON.stringify({ schemaVersion: 1, package: '@moretea-labs/forge', version, fingerprint, files: records }, null, 2)}\n`;
  const entrypointPath = join(releaseRoot, 'forge-runtime');
  const indexSha256 = sha256(Buffer.from(indexJson));
  const launcher = launcherSource({ indexSha256, managerSignalsProcessGroup: true });
  const artifactIdentity = `sha256:${sha256(Buffer.from(launcher))}`;
  const processRunnerEntrypoint = 'process-runner.js' as const;
  const processRunnerPath = join(releaseRoot, processRunnerEntrypoint);
  const processRunnerLauncher = launcherSource({
    indexSha256,
    entryRelativePath: 'src/runtime/execution/process-runtime/process-runner-entry.ts',
  });
  const processRunnerArtifactIdentity = `sha256:${sha256(Buffer.from(processRunnerLauncher))}`;
  const checkRunnerEntrypoint = 'forge-check-runner' as const;
  const checkRunnerPath = join(releaseRoot, checkRunnerEntrypoint);
  const checkRunnerLauncher = launcherSource({
    indexSha256,
    entryRelativePath: 'src/runtime/execution/process-runtime/check-runner-sidecar.ts',
  });
  const checkRunnerArtifactIdentity = `sha256:${sha256(Buffer.from(checkRunnerLauncher))}`;
  const contextPackEntrypoint = 'forge-context-pack' as const;
  const contextPackPath = join(releaseRoot, contextPackEntrypoint);
  const contextPackLauncher = launcherSource({
    indexSha256,
    entryRelativePath: 'adapters/mcp/runtime-gateway/context-pack-sidecar.ts',
  });
  const contextPackArtifactIdentity = `sha256:${sha256(Buffer.from(contextPackLauncher))}`;
  const pluginActionSidecarEntrypoint = 'forge-plugin-action-sidecar' as const;
  const pluginActionSidecarPath = join(releaseRoot, pluginActionSidecarEntrypoint);
  const pluginActionSidecarLauncher = launcherSource({
    indexSha256,
    entryRelativePath: 'src/runtime/plugins/plugin-action-sidecar.ts',
  });
  const pluginActionSidecarArtifactIdentity = `sha256:${sha256(Buffer.from(pluginActionSidecarLauncher))}`;
  const expectedManifest: Omit<RuntimeReleaseManifest, 'createdAt'> = {
    schemaVersion: 1,
    releaseId,
    artifactIdentity,
    entrypoint: 'forge-runtime',
    processRunnerEntrypoint,
    processRunnerArtifactIdentity,
    checkRunnerEntrypoint,
    checkRunnerArtifactIdentity,
    contextPackEntrypoint,
    contextPackArtifactIdentity,
    pluginActionSidecarEntrypoint,
    pluginActionSidecarArtifactIdentity,
    packageRoot: 'package',
    packageArtifactIdentity,
    arguments: [],
    configurationSchemaVersion: 1,
    controllerHome,
    databaseSchemaCompatibility: { minimum: CONTROL_PLANE_SCHEMA_VERSION, maximum: CONTROL_PLANE_SCHEMA_VERSION },
    workerProtocolVersion: 1,
    releaseRevision: `package:${version}:${fingerprint}`,
    cleanWorkspace: true,
  };
  const manifestPath = join(releaseRoot, 'manifest.json');
  const stagedBytes = records.reduce((total, record) => total + record.bytes, 0)
    + Buffer.byteLength(indexJson)
    + Buffer.byteLength(launcher)
    + Buffer.byteLength(processRunnerLauncher)
    + Buffer.byteLength(checkRunnerLauncher)
    + Buffer.byteLength(contextPackLauncher)
    + Buffer.byteLength(pluginActionSidecarLauncher)
    + Buffer.byteLength(JSON.stringify({ ...expectedManifest, createdAt: new Date(0).toISOString() }));
  let executionCanariesValidated = false;
  const assertExisting = () => assertImmutablePackageRuntimeRelease({
    releaseRoot, packageRoot, records, indexPath, indexJson, entrypointPath, launcher,
    processRunnerPath, processRunnerLauncher, checkRunnerPath, checkRunnerLauncher,
    contextPackPath, contextPackLauncher, pluginActionSidecarPath, pluginActionSidecarLauncher,
    manifestPath, expectedManifest,
  });

  if (existsSync(releaseRoot)) {
    assertExisting();
  } else {
    assertStorageHeadroom(controllerHome, {
      operation: 'materialize_package_runtime_release',
      requiredBytes: stagedBytes,
      reserveBytes: PACKAGE_RUNTIME_STAGING_RESERVE_BYTES,
    });
    mkdirSync(releasesRoot, { recursive: true, mode: 0o700 });
    const stagingRoot = join(releasesRoot, `.staging-${releaseId}-${process.pid}-${randomUUID().slice(0, 8)}`);
    try {
      mkdirSync(stagingRoot, { recursive: false, mode: 0o700 });
      stagePackageRuntimeSnapshot(sourcePackageRoot, join(stagingRoot, 'package'), records, dependencyRoot);
      writeAtomicTextFile(join(stagingRoot, 'package-files.json'), indexJson);
      writeAtomicTextFile(join(stagingRoot, 'forge-runtime'), launcher, 0o700);
      chmodSync(join(stagingRoot, 'forge-runtime'), 0o700);
      writeAtomicTextFile(join(stagingRoot, processRunnerEntrypoint), processRunnerLauncher, 0o700);
      chmodSync(join(stagingRoot, processRunnerEntrypoint), 0o700);
      writeAtomicTextFile(join(stagingRoot, checkRunnerEntrypoint), checkRunnerLauncher, 0o700);
      chmodSync(join(stagingRoot, checkRunnerEntrypoint), 0o700);
      writeAtomicTextFile(join(stagingRoot, contextPackEntrypoint), contextPackLauncher, 0o700);
      chmodSync(join(stagingRoot, contextPackEntrypoint), 0o700);
      writeAtomicTextFile(join(stagingRoot, pluginActionSidecarEntrypoint), pluginActionSidecarLauncher, 0o700);
      chmodSync(join(stagingRoot, pluginActionSidecarEntrypoint), 0o700);
      const manifest: RuntimeReleaseManifest = { ...expectedManifest, createdAt: new Date().toISOString() };
      const stagingManifestPath = join(stagingRoot, 'manifest.json');
      writeAtomicTextFile(stagingManifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      // A failed execution surface is still a staging failure. Do not promote an
      // immutable release directory until both manifest-owned runners execute
      // their bounded no-op canary successfully.
      assertRuntimeReleaseExecutionCanaries(stagingManifestPath, controllerHome);
      renameSync(stagingRoot, releaseRoot);
      executionCanariesValidated = true;
    } catch (error) {
      rmSync(stagingRoot, { recursive: true, force: true });
      if (!existsSync(releaseRoot)) throw error;
      assertExisting();
    }
  }

  if (!executionCanariesValidated) assertRuntimeReleaseExecutionCanaries(manifestPath, controllerHome);
  const authority = publishRuntimeRelease(controllerHome, manifestPath, input.operationId ?? `package-runtime-${FORGE_VERSION}-${Date.now()}`);
  return {
    releaseId,
    releaseRoot,
    packageRoot,
    packageVersion: version,
    packageFingerprint: fingerprint,
    artifactIdentity,
    entrypointPath,
    manifestPath,
    indexPath,
    fileCount: records.length,
    authority,
  };
}
