import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { loadScenario } from './scenario.ts';
import type { EvaluationBehaviorClass, EvaluationScenario } from './types.ts';

export const GOLDEN_CORPUS_SCHEMA = 'forge-golden-corpus/v1' as const;
export const REQUIRED_SHARED_BEHAVIOR_CLASSES = [
  'discovery_context',
  'bounded_mutation',
  'work_lifecycle',
  'failure_classification',
  'restart_recovery',
  'multi_repo_concurrency',
] as const satisfies readonly EvaluationBehaviorClass[];

export interface GoldenCorpusManifest {
  schemaVersion: typeof GOLDEN_CORPUS_SCHEMA;
  shared: string[];
  v2Only: string[];
}

export interface LoadedGoldenCorpus {
  manifest: GoldenCorpusManifest;
  shared: EvaluationScenario[];
  v2Only: EvaluationScenario[];
}

function fail(message: string): never {
  throw new Error(`Invalid Golden Corpus: ${message}`);
}

function fullCommit(value: string | undefined, label: string): string {
  const commit = value?.trim() ?? '';
  if (!/^[0-9a-f]{40,64}$/i.test(commit)) fail(`${label} must be a full immutable Git commit id`);
  return commit;
}

function parseManifest(path: string): GoldenCorpusManifest {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  if (raw.schemaVersion !== GOLDEN_CORPUS_SCHEMA) fail(`schemaVersion must equal ${GOLDEN_CORPUS_SCHEMA}`);
  const strings = (value: unknown, label: string): string[] => {
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || entry.trim() === '')) fail(`${label} must be an array of non-empty scenario paths`);
    return value.map((entry) => String(entry));
  };
  const shared = strings(raw.shared, 'shared');
  const v2Only = strings(raw.v2Only, 'v2Only');
  const all = [...shared, ...v2Only];
  if (new Set(all).size !== all.length) fail('scenario paths must be unique across shared and v2Only');
  return { schemaVersion: GOLDEN_CORPUS_SCHEMA, shared, v2Only };
}

function git(repoRoot: string, args: string[]): string {
  try {
    return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (error) {
    fail(`git ${args.join(' ')} failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function validateIndependentOracle(scenario: EvaluationScenario): void {
  const independent = scenario.validators.some((validator) =>
    validator.type === 'execution_output'
    || (validator.type === 'changed_paths' && (validator.requiredGlobs?.length ?? 0) > 0));
  if (!independent) fail(`${scenario.id} must include an evaluator-owned execution_output oracle or a positive changed-path oracle`);
}

function validateScenarioProvenance(repoRoot: string, scenario: EvaluationScenario, expectedClass: 'shared' | 'v2_only'): void {
  if (scenario.corpus?.class !== expectedClass) fail(`${scenario.id} corpus.class must equal ${expectedClass}`);
  if (!scenario.corpus?.behaviorClass) fail(`${scenario.id} must declare corpus.behaviorClass`);
  const snapshotCommit = fullCommit(scenario.snapshot.commit, `${scenario.id}.snapshot.commit`);
  const sourceCommit = fullCommit(scenario.provenance?.sourceCommit, `${scenario.id}.provenance.sourceCommit`);
  if (snapshotCommit !== sourceCommit) fail(`${scenario.id} snapshot.commit must equal provenance.sourceCommit`);
  git(repoRoot, ['rev-parse', '--verify', `${snapshotCommit}^{commit}`]);
  const kind = scenario.provenance?.kind;
  if (!kind) fail(`${scenario.id} must declare provenance.kind`);
  if (kind === 'synthetic_fixture' && expectedClass === 'shared') fail(`${scenario.id} synthetic fixtures cannot enter the shared A/B corpus`);
  if (kind === 'historical_regression') {
    const fixCommit = fullCommit(scenario.provenance?.fixCommit, `${scenario.id}.provenance.fixCommit`);
    git(repoRoot, ['rev-parse', '--verify', `${fixCommit}^{commit}`]);
    if (fixCommit === sourceCommit) fail(`${scenario.id} regression source and fix commits must differ`);
    git(repoRoot, ['merge-base', '--is-ancestor', sourceCommit, fixCommit]);
  }
  validateIndependentOracle(scenario);
}

export function loadGoldenCorpus(manifestPath = resolve(process.cwd(), 'evaluation', 'corpus.json')): LoadedGoldenCorpus {
  if (!existsSync(manifestPath)) fail(`manifest not found: ${manifestPath}`);
  const manifest = parseManifest(manifestPath);
  const evaluationRoot = dirname(manifestPath);
  const repoRoot = resolve(evaluationRoot, '..');
  const load = (path: string) => loadScenario(resolve(evaluationRoot, path));
  const shared = manifest.shared.map(load);
  const v2Only = manifest.v2Only.map(load);
  const ids = [...shared, ...v2Only].map((scenario) => scenario.id);
  if (new Set(ids).size !== ids.length) fail('scenario ids must be globally unique');
  for (const scenario of shared) validateScenarioProvenance(repoRoot, scenario, 'shared');
  for (const scenario of v2Only) validateScenarioProvenance(repoRoot, scenario, 'v2_only');
  if (shared.length < 24) fail(`shared corpus must contain at least 24 scenarios; found ${shared.length}`);
  const covered = new Set(shared.map((scenario) => scenario.corpus!.behaviorClass));
  const missing = REQUIRED_SHARED_BEHAVIOR_CLASSES.filter((behavior) => !covered.has(behavior));
  if (missing.length > 0) fail(`shared corpus is missing behavior class(es): ${missing.join(', ')}`);
  return { manifest, shared, v2Only };
}
