import { createHash, randomUUID } from 'crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'fs';
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

const PACKAGE_RUNTIME_ROOTS = ['src', 'bin', 'assets', 'scripts'] as const;
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
  if (stat.isSymbolicLink()) return;
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
  return `#!/usr/bin/env node\n`
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
    + `const runtime=join(packageRoot,'bin','forge-runtime.mjs');\n`
    + `const child=spawn(process.execPath,[runtime,...process.argv.slice(2)],{stdio:'inherit',env:{...process.env,FORGE_FORCE_NODE:'1'}});\n`
    + `for(const signal of ['SIGINT','SIGTERM','SIGHUP']){try{process.on(signal,()=>child.kill(signal));}catch{}}\n`
    + `child.on('error',(error)=>{console.error('FORGE_PACKAGE_RUNTIME_LAUNCH_FAILED: '+error.message);process.exit(1);});\n`
    + `child.on('exit',(code)=>process.exit(code??1));\n`;
}

export function materializePackageRuntimeRelease(input: {
  controllerHome?: string;
  packageRoot?: string;
  operationId?: string;
} = {}): PackageRuntimeRelease {
  const controllerHome = ensureControllerHome(input.controllerHome);
  const packageRoot = resolve(input.packageRoot ?? packageRuntimeSourceRoot());
  const version = packageVersion(packageRoot);
  const records = packageRuntimeFileIndex(packageRoot);
  const fingerprint = packageRuntimeFingerprint(records);
  const safeVersion = version.replace(/[^A-Za-z0-9._-]+/g, '-');
  const releaseId = `package-${safeVersion}-${fingerprint.slice(0, 16)}`;
  const releaseRoot = join(controllerHome, 'runtime', 'releases', releaseId);
  const indexPath = join(releaseRoot, 'package-files.json');
  const indexJson = `${JSON.stringify({ schemaVersion: 1, package: '@moretea-labs/forge', version, fingerprint, files: records }, null, 2)}\n`;
  atomicWrite(indexPath, indexJson);
  const entrypointPath = join(releaseRoot, 'forge-runtime');
  const launcher = launcherSource({ packageRoot, indexPath, indexSha256: sha256(Buffer.from(indexJson)) });
  atomicWrite(entrypointPath, launcher, 0o700);
  chmodSync(entrypointPath, 0o700);
  const artifactIdentity = `sha256:${sha256(Buffer.from(launcher))}`;
  const manifest: RuntimeReleaseManifest = {
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
    createdAt: new Date().toISOString(),
  };
  const manifestPath = join(releaseRoot, 'manifest.json');
  atomicWrite(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
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
