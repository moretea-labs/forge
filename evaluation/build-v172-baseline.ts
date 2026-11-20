#!/usr/bin/env bun
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { evaluationCandidateArtifactDigest } from './lib/candidate-artifact.ts';
import { readV172BaselineReconstructionAuthority, v172BaselineReconstructionDigest } from './lib/baseline.ts';

function sha256(path: string): string {
  return `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`;
}

function main(): void {
  const [outputArg] = process.argv.slice(2);
  if (!outputArg) throw new Error('Usage: bun evaluation/build-v172-baseline.ts <new-external-artifact-directory>');
  const repoRoot = process.cwd();
  const output = resolve(outputArg);
  const receiptPath = `${output}.receipt.json`;
  if (existsSync(output) || existsSync(receiptPath)) throw new Error('EVALUATION_BASELINE_OUTPUT_EXISTS');
  const authority = readV172BaselineReconstructionAuthority(repoRoot);
  const observedNpm = execFileSync(authority.installer.executable, ['--version'], { encoding: 'utf8' }).trim();
  if (observedNpm !== authority.installer.version) throw new Error(`EVALUATION_BASELINE_NPM_VERSION_MISMATCH:${observedNpm}`);

  const staging = mkdtempSync(join(tmpdir(), 'forge-v172-baseline-build-'));
  try {
    const packageDir = join(staging, 'package');
    mkdirSync(packageDir, { recursive: true });
    const offlineEnv = {
      ...process.env,
      npm_config_registry: authority.publishedPackage.registry,
      npm_config_offline: 'true',
    };
    const packOutput = execFileSync(authority.installer.executable, [
      'pack', authority.publishedPackage.specifier, '--silent', '--pack-destination', staging,
      '--registry', authority.publishedPackage.registry,
    ], { encoding: 'utf8', env: offlineEnv }).trim().split(/\r?\n/).filter(Boolean).at(-1);
    if (!packOutput) throw new Error('EVALUATION_BASELINE_TARBALL_MISSING');
    const tarball = resolve(staging, packOutput);
    if (sha256(tarball) !== authority.publishedPackage.tarballSha256) throw new Error('EVALUATION_BASELINE_TARBALL_DRIFT');

    execFileSync('tar', ['-xzf', tarball, '-C', packageDir, '--strip-components=1'], { stdio: 'inherit' });
    if (sha256(join(packageDir, 'package.json')) !== authority.publishedPackage.releaseManifestSha256) {
      throw new Error('EVALUATION_BASELINE_PUBLISHED_MANIFEST_DRIFT');
    }
    cpSync(resolve(repoRoot, authority.dependencyLock.path), join(packageDir, 'package-lock.json'));
    execFileSync(authority.installer.executable, authority.installer.arguments as string[], {
      cwd: packageDir,
      stdio: 'inherit',
      env: offlineEnv,
    });
    const entry = join(packageDir, authority.entryPath);
    if (!existsSync(entry)) throw new Error('EVALUATION_BASELINE_ENTRY_MISSING');
    const artifactDigest = evaluationCandidateArtifactDigest(packageDir);

    mkdirSync(dirname(output), { recursive: true });
    cpSync(packageDir, output, { recursive: true, dereference: false, errorOnExist: true, force: false, preserveTimestamps: true, verbatimSymlinks: true });
    const copiedDigest = evaluationCandidateArtifactDigest(output);
    if (copiedDigest !== artifactDigest) throw new Error('EVALUATION_BASELINE_COPY_DIGEST_MISMATCH');
    const receipt = {
      schemaVersion: 'forge-evaluation-baseline-build-receipt/v1',
      reconstructionDigest: v172BaselineReconstructionDigest(repoRoot),
      artifactDigest,
      entryPath: authority.entryPath,
      npmVersion: observedNpm,
      installedTopLevelCount: readdirSync(join(output, 'node_modules')).length,
    } as const;
    writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx' });
    console.log(JSON.stringify(receipt));
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
