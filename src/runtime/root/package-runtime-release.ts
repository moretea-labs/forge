import { createHash, randomUUID } from 'crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'fs';
import { dirname, join, relative, resolve } from 'path';
import { ensureControllerHome } from '../../cli/repositories/controller-home';
import { CONTROL_PLANE_SCHEMA_VERSION } from '../control-plane/persistence/sqlite-store';
import { packageRuntimeSourceRoot } from '../control-plane/runtime-generation';
import { FORGE_VERSION } from '../../version';
import { publishRuntimeRelease, type RuntimeReleaseAuthority } from './release-store';
import type { RuntimeReleaseManifest } from './types';

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

// A package Runtime is an immutable, independently launchable release.  Its
// TypeScript entrypoints import production modules at runtime, so retaining
// only source files creates a release that passes staging but cannot start
// after the installed package moves or disappears.
const PACKAGE_RUNTIME_ROOTS = ['src', 'bin', 'assets', 'scripts', 'node_modules'] as const;
const PACKAGE_RUNTIME_FILES = ['package.json'] as const;

function sha256(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function atomicWrite(path: string, content: string, mode = 0o600): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  writeFileSync(temporary, content, { encoding: 'utf8', mode });
  renameSync(temporary, path);
}

function walkRegularFiles(root: string, current: string, output: string[]): void {
  if (!existsSync(current)) return;
  const stat = lstatSync(current);
  // Package managers such as Bun can materialize dependency files as
  // symlinks. Follow file links while snapshotting their bytes, but never
  // traverse a linked directory: the resulting release must contain only
  // regular files beneath its own immutable package root.
  if (stat.isSymbolicLink()) {
    const target = statSync(current);
    if (target.isFile()) output.push(relative(root, current).split('\\').join('/'));
    return;
  }
  if (stat.isFile()) {
    output.push(relative(root, current).split('\\').join('/'));
    return;
  }
  if (!stat.isDirectory()) return;
  for (const entry of readdirSync(current).sort()) walkRegularFiles(root, join(current, entry), output);
}

export function packageRuntimeFileIndex(packageRoot = packageRuntimeSourceRoot()): PackageRuntimeFileRecord[] {
  const root = resolve(packageRoot);
  const paths: string[] = [];
  for (const directory of PACKAGE_RUNTIME_ROOTS) walkRegularFiles(root, join(root, directory), paths);
  for (const file of PACKAGE_RUNTIME_FILES) walkRegularFiles(root, join(root, file), paths);
  const unique = [...new Set(paths)].sort();
  if (!unique.includes('package.json') || !unique.some((path) => path === 'bin/forge-runtime.mjs')) {
    throw new Error(`PACKAGE_RUNTIME_SURFACE_INCOMPLETE: ${root}`);
  }
  return unique.map((path) => {
    const bytes = readFileSync(join(root, path));
    return { path, sha256: sha256(bytes), bytes: bytes.length };
  });
}

export function packageRuntimeFingerprint(records: PackageRuntimeFileRecord[]): string {
  const hash = createHash('sha256');
  for (const record of records) hash.update(record.path).update('\0').update(record.sha256).update('\0').update(String(record.bytes)).update('\n');
  return hash.digest('hex');
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

function stagePackageRuntimeSnapshot(sourceRoot: string, snapshotRoot: string, records: PackageRuntimeFileRecord[]): void {
  mkdirSync(snapshotRoot, { recursive: false, mode: 0o700 });
  for (const record of records) {
    const source = join(sourceRoot, record.path);
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

function launcherSource(input: { packageRoot: string; indexPath: string; indexSha256: string }): string {
  return `#!${process.execPath}\n`
    + `import { createHash } from 'node:crypto';\n`
    + `import { existsSync, readFileSync } from 'node:fs';\n`
    + `import { join } from 'node:path';\n`
    + `import { spawn } from 'node:child_process';\n`
    + `const packageRoot=${JSON.stringify(input.packageRoot)};\n`
    + `const indexPath=${JSON.stringify(input.indexPath)};\n`
    + `const expectedIndex=${JSON.stringify(input.indexSha256)};\n`
    + `const digest=(v)=>createHash('sha256').update(v).digest('hex');\n`
    + `let raw; try { raw=readFileSync(indexPath); } catch (error) { console.error('FORGE_PACKAGE_RUNTIME_INDEX_MISSING: '+error.message); process.exit(78); }\n`
    + `if(digest(raw)!==expectedIndex){console.error('FORGE_PACKAGE_RUNTIME_INDEX_CHANGED');process.exit(78);}\n`
    + `let records; try { records=JSON.parse(raw.toString('utf8')).files; } catch { console.error('FORGE_PACKAGE_RUNTIME_INDEX_INVALID'); process.exit(78); }\n`
    + `for(const record of records){const path=join(packageRoot,record.path);if(!existsSync(path)||digest(readFileSync(path))!==record.sha256){console.error('FORGE_PACKAGE_RUNTIME_SOURCE_CHANGED: '+record.path);process.exit(78);}}\n`
    + `const entry=join(packageRoot,'src','runtime','root','entry.ts');\n`
    + `const loader=join(packageRoot,'src','runtime','shared','node-ts-loader.mjs');\n`
    + `const args=process.versions?.bun?[entry,...process.argv.slice(2)]:['--loader',loader,entry,...process.argv.slice(2)];\n`
    + `const child=spawn(process.execPath,args,{stdio:'inherit',env:process.env});\n`
    + `for(const signal of ['SIGINT','SIGTERM','SIGHUP']){try{process.on(signal,()=>child.kill(signal));}catch{}}\n`
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
  manifestPath: string;
  expectedManifest: Omit<RuntimeReleaseManifest, 'createdAt'>;
}): void {
  const rootStat = lstatSync(input.releaseRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('PACKAGE_RUNTIME_RELEASE_IMMUTABILITY_VIOLATION: release root is not a regular directory');
  assertPackageRuntimeSnapshot(input.packageRoot, input.records);
  const assertFile = (path: string, expected: string, label: string) => {
    if (!existsSync(path)) throw new Error(`PACKAGE_RUNTIME_RELEASE_IMMUTABILITY_VIOLATION: ${label} is missing`);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || readFileSync(path, 'utf8') !== expected) {
      throw new Error(`PACKAGE_RUNTIME_RELEASE_IMMUTABILITY_VIOLATION: ${label} changed`);
    }
  };
  assertFile(input.indexPath, input.indexJson, 'package file index');
  assertFile(input.entrypointPath, input.launcher, 'runtime launcher');
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
    && JSON.stringify(manifest.arguments ?? []) === JSON.stringify(expected.arguments ?? [])
    && manifest.configurationSchemaVersion === expected.configurationSchemaVersion
    && resolve(manifest.controllerHome) === resolve(expected.controllerHome)
    && JSON.stringify(manifest.databaseSchemaCompatibility) === JSON.stringify(expected.databaseSchemaCompatibility)
    && manifest.workerProtocolVersion === expected.workerProtocolVersion
    && manifest.releaseRevision === expected.releaseRevision
    && manifest.cleanWorkspace === expected.cleanWorkspace
    && typeof manifest.createdAt === 'string'
    && Number.isFinite(Date.parse(manifest.createdAt));
  if (!compatible) throw new Error('PACKAGE_RUNTIME_RELEASE_IMMUTABILITY_VIOLATION: manifest identity changed');
}

export function materializePackageRuntimeRelease(input: {
  controllerHome?: string;
  packageRoot?: string;
  operationId?: string;
} = {}): PackageRuntimeRelease {
  const controllerHome = ensureControllerHome(input.controllerHome);
  const sourcePackageRoot = resolve(input.packageRoot ?? packageRuntimeSourceRoot());
  const version = packageVersion(sourcePackageRoot);
  const records = packageRuntimeFileIndex(sourcePackageRoot);
  const fingerprint = packageRuntimeFingerprint(records);
  const safeVersion = version.replace(/[^A-Za-z0-9._-]+/g, '-');
  const launcherBinding = sha256(`${resolve(process.execPath)}\0package-launcher-v4`);
  const releaseId = `package-${safeVersion}-${fingerprint.slice(0, 16)}-${launcherBinding.slice(0, 12)}`;
  const releasesRoot = join(controllerHome, 'runtime', 'releases');
  const releaseRoot = join(releasesRoot, releaseId);
  const packageRoot = join(releaseRoot, 'package');
  const indexPath = join(releaseRoot, 'package-files.json');
  const indexJson = `${JSON.stringify({ schemaVersion: 1, package: '@moretea-labs/forge', version, fingerprint, files: records }, null, 2)}\n`;
  const entrypointPath = join(releaseRoot, 'forge-runtime');
  const launcher = launcherSource({ packageRoot, indexPath, indexSha256: sha256(Buffer.from(indexJson)) });
  const artifactIdentity = `sha256:${sha256(Buffer.from(launcher))}`;
  const expectedManifest: Omit<RuntimeReleaseManifest, 'createdAt'> = {
    schemaVersion: 1,
    releaseId,
    artifactIdentity,
    entrypoint: 'forge-runtime',
    arguments: [],
    configurationSchemaVersion: 1,
    controllerHome,
    databaseSchemaCompatibility: { minimum: CONTROL_PLANE_SCHEMA_VERSION, maximum: CONTROL_PLANE_SCHEMA_VERSION },
    workerProtocolVersion: 1,
    releaseRevision: `package:${version}:${fingerprint}`,
    cleanWorkspace: true,
  };
  const manifestPath = join(releaseRoot, 'manifest.json');
  const assertExisting = () => assertImmutablePackageRuntimeRelease({
    releaseRoot, packageRoot, records, indexPath, indexJson, entrypointPath, launcher, manifestPath, expectedManifest,
  });

  if (existsSync(releaseRoot)) {
    assertExisting();
  } else {
    mkdirSync(releasesRoot, { recursive: true, mode: 0o700 });
    const stagingRoot = join(releasesRoot, `.staging-${releaseId}-${process.pid}-${randomUUID().slice(0, 8)}`);
    try {
      mkdirSync(stagingRoot, { recursive: false, mode: 0o700 });
      stagePackageRuntimeSnapshot(sourcePackageRoot, join(stagingRoot, 'package'), records);
      atomicWrite(join(stagingRoot, 'package-files.json'), indexJson);
      atomicWrite(join(stagingRoot, 'forge-runtime'), launcher, 0o700);
      chmodSync(join(stagingRoot, 'forge-runtime'), 0o700);
      const manifest: RuntimeReleaseManifest = { ...expectedManifest, createdAt: new Date().toISOString() };
      atomicWrite(join(stagingRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
      renameSync(stagingRoot, releaseRoot);
    } catch (error) {
      rmSync(stagingRoot, { recursive: true, force: true });
      if (!existsSync(releaseRoot)) throw error;
      assertExisting();
    }
  }

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
