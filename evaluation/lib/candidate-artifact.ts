import { createHash, type Hash } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { ForgeCommand } from './types.ts';

export type EvaluationCandidateArtifactBinding =
  | { kind: 'executable'; entryPath?: string }
  | { kind: 'prefix_argument'; index: 0; entryPath?: string };

export interface MaterializedCandidateArtifact {
  sourcePath: string;
  materializedPath: string;
  entryPath: string;
  command: ForgeCommand;
  digest: string;
}

function portableRelative(root: string, path: string): string {
  const value = relative(root, path).replaceAll('\\', '/');
  return value || '.';
}

function assertWithin(root: string, path: string, code: string): void {
  const rel = relative(root, path);
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error(code);
}

function hashArtifactNode(hash: Hash, root: string, path: string): void {
  const stat = lstatSync(path);
  const rel = portableRelative(root, path);
  if (stat.isSymbolicLink()) {
    const resolved = realpathSync(path);
    assertWithin(realpathSync(root), resolved, `EVALUATION_CANDIDATE_ARTIFACT_EXTERNAL_SYMLINK:${rel}`);
    hash.update(`symlink\0${rel}\0${readlinkSync(path)}\0`);
    return;
  }
  if (stat.isDirectory()) {
    hash.update(`directory\0${rel}\0`);
    const entries = readdirSync(path).sort();
    for (const entry of entries) hashArtifactNode(hash, root, join(path, entry));
    return;
  }
  if (stat.isFile()) {
    const executable = (stat.mode & 0o111) === 0 ? '0' : '1';
    hash.update(`file\0${rel}\0${executable}\0`);
    hash.update(readFileSync(path));
    hash.update('\0');
    return;
  }
  throw new Error(`EVALUATION_CANDIDATE_ARTIFACT_NODE_UNSUPPORTED:${rel}`);
}

export function evaluationCandidateArtifactDigest(inputPath: string): string {
  const path = resolve(inputPath);
  if (!existsSync(path)) throw new Error(`EVALUATION_CANDIDATE_ARTIFACT_MISSING:${path}`);
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) throw new Error('EVALUATION_CANDIDATE_ARTIFACT_ROOT_SYMLINK_UNSUPPORTED');
  const root = stat.isDirectory() ? path : dirname(path);
  const hash = createHash('sha256');
  hash.update('forge-evaluation-candidate-artifact/v1\0');
  hashArtifactNode(hash, root, path);
  return `sha256:${hash.digest('hex')}`;
}

function resolveArtifactEntry(artifactPath: string, binding: EvaluationCandidateArtifactBinding): string {
  const artifact = resolve(artifactPath);
  const stat = lstatSync(artifact);
  if (!stat.isDirectory()) {
    if (binding.entryPath !== undefined) throw new Error('EVALUATION_CANDIDATE_ARTIFACT_ENTRY_PATH_FILE_INVALID');
    return artifact;
  }
  const entryPath = binding.entryPath?.trim();
  if (!entryPath) throw new Error('EVALUATION_CANDIDATE_ARTIFACT_ENTRY_PATH_REQUIRED');
  const entry = resolve(artifact, entryPath);
  assertWithin(artifact, entry, 'EVALUATION_CANDIDATE_ARTIFACT_ENTRY_OUTSIDE_ROOT');
  if (!existsSync(entry)) throw new Error(`EVALUATION_CANDIDATE_ARTIFACT_ENTRY_MISSING:${entryPath}`);
  assertWithin(realpathSync(artifact), realpathSync(entry), 'EVALUATION_CANDIDATE_ARTIFACT_ENTRY_SYMLINK_OUTSIDE_ROOT');
  return entry;
}

function boundCommandToken(command: ForgeCommand, binding: EvaluationCandidateArtifactBinding): string | undefined {
  return binding.kind === 'executable' ? command.executable : command.prefixArguments?.[binding.index];
}

function rewriteCommandBinding(command: ForgeCommand, binding: EvaluationCandidateArtifactBinding, materializedEntry: string): ForgeCommand {
  if (binding.kind === 'executable') {
    return { executable: materializedEntry, ...(command.prefixArguments ? { prefixArguments: [...command.prefixArguments] } : {}) };
  }
  const prefixArguments = [...(command.prefixArguments ?? [])];
  prefixArguments[binding.index] = materializedEntry;
  return { executable: command.executable, prefixArguments };
}

export function assertEvaluationCandidateArtifact(input: {
  candidateId: string;
  artifactPath: string;
  artifactDigest: string;
  binding: EvaluationCandidateArtifactBinding;
  command: ForgeCommand;
}): void {
  const artifactPath = resolve(input.artifactPath);
  if (!existsSync(artifactPath)) throw new Error(`EVALUATION_CANDIDATE_ARTIFACT_MISSING:${input.candidateId}`);
  const entry = resolveArtifactEntry(artifactPath, input.binding);
  const token = boundCommandToken(input.command, input.binding);
  if (!token || !existsSync(resolve(token)) || realpathSync(resolve(token)) !== realpathSync(entry)) {
    throw new Error(`EVALUATION_CANDIDATE_ARTIFACT_NOT_BOUND_TO_COMMAND:${input.candidateId}`);
  }
  const observed = evaluationCandidateArtifactDigest(artifactPath);
  if (observed !== input.artifactDigest) {
    throw new Error(`EVALUATION_CANDIDATE_ARTIFACT_DIGEST_MISMATCH:${input.candidateId}`);
  }
}

export function materializeEvaluationCandidateArtifact(input: {
  candidateId: string;
  artifactPath: string;
  artifactDigest: string;
  binding: EvaluationCandidateArtifactBinding;
  command: ForgeCommand;
  trialRoot: string;
}): MaterializedCandidateArtifact {
  assertEvaluationCandidateArtifact(input);
  const sourcePath = resolve(input.artifactPath);
  const sourceStat = lstatSync(sourcePath);
  const materializedPath = sourceStat.isDirectory()
    ? join(input.trialRoot, 'candidate-artifact')
    : join(input.trialRoot, 'candidate-artifact', basename(sourcePath));
  mkdirSync(dirname(materializedPath), { recursive: true });
  cpSync(sourcePath, materializedPath, {
    recursive: sourceStat.isDirectory(),
    dereference: false,
    errorOnExist: true,
    force: false,
    preserveTimestamps: true,
    verbatimSymlinks: true,
  });
  const materializedDigest = evaluationCandidateArtifactDigest(materializedPath);
  if (materializedDigest !== input.artifactDigest) {
    throw new Error(`EVALUATION_CANDIDATE_ARTIFACT_MATERIALIZATION_MISMATCH:${input.candidateId}`);
  }
  const sourceEntry = resolveArtifactEntry(sourcePath, input.binding);
  const entryRelative = sourceStat.isDirectory() ? relative(sourcePath, sourceEntry) : '';
  const materializedEntry = sourceStat.isDirectory() ? resolve(materializedPath, entryRelative) : materializedPath;
  return {
    sourcePath,
    materializedPath,
    entryPath: materializedEntry,
    command: rewriteCommandBinding(input.command, input.binding, materializedEntry),
    digest: materializedDigest,
  };
}

export function assertMaterializedCandidateArtifactUnchanged(candidateId: string, artifact: MaterializedCandidateArtifact): void {
  if (evaluationCandidateArtifactDigest(artifact.materializedPath) !== artifact.digest) {
    throw new Error(`EVALUATION_CANDIDATE_ARTIFACT_MUTATED:${candidateId}`);
  }
}
