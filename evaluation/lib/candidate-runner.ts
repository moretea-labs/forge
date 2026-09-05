import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import {
  assertEvaluationCandidateArtifact,
  assertMaterializedCandidateArtifactUnchanged,
  materializeEvaluationCandidateArtifact,
  type EvaluationCandidateArtifactBinding,
} from './candidate-artifact.ts';
import {
  CROSS_VERSION_EVALUATION_AUTHORITY,
  evaluationRunIdentity,
  type EvaluationCacheMode,
  type EvaluationCandidateIdentity,
  type EvaluationEnvironmentIdentity,
  type EvaluationRunIdentity,
  type FrozenEvaluationProtocol,
} from './protocol.ts';
import { runPublicMcpEvaluationInSnapshot } from './public-mcp-runner.ts';
import { runEvaluationInSnapshot } from './runner.ts';
import { evaluationScenarioDigest } from './scenario.ts';
import {
  changedFiles,
  cleanupIsolatedSnapshot,
  createIsolatedSnapshot,
  evaluationIsolationIdentity,
  isolatedEvaluationEnvironment,
  resolveSourcePath,
  type EvaluationIsolationIdentity,
} from './sandbox.ts';
import { captureCommand, commandSucceeded } from './trace.ts';
import type { CommandRecord, EvaluationReport, EvaluationScenario, ForgeCommand } from './types.ts';

export const PAIRED_CANDIDATE_RUN_SCHEMA = 'forge-paired-candidate-run/v1' as const;

export interface EvaluationCandidateAdapter {
  identity: EvaluationCandidateIdentity;
  artifactPath: string;
  artifactBinding: EvaluationCandidateArtifactBinding;
  command: ForgeCommand;
  warmup?: {
    arguments: readonly string[];
    timeoutMs?: number;
  };
}

export interface PlannedCandidateTrial {
  sequence: number;
  repetition: number;
  cacheMode: EvaluationCacheMode;
  candidateIndex: 0 | 1;
}

export interface CandidateTrialResult extends PlannedCandidateTrial {
  runIdentity: EvaluationRunIdentity;
  isolation: EvaluationIsolationIdentity;
  warmupCommands: readonly CommandRecord[];
  report: EvaluationReport;
}

export interface PairedCandidateRun {
  schemaVersion: typeof PAIRED_CANDIDATE_RUN_SCHEMA;
  authority: typeof CROSS_VERSION_EVALUATION_AUTHORITY;
  protocolDigest: string;
  environmentFingerprint: string;
  scenarioId: string;
  candidateIds: readonly [string, string];
  orderPolicy: FrozenEvaluationProtocol['trialPolicy']['orderPolicy'];
  trials: readonly CandidateTrialResult[];
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

function assertCandidateArtifact(candidate: EvaluationCandidateAdapter, scenario: EvaluationScenario): void {
  const expectedSurface = scenario.execution.interface === 'forge_mcp' ? 'public_mcp' : 'public_cli';
  if (candidate.identity.executionSurface !== expectedSurface) {
    throw new Error(`EVALUATION_CANDIDATE_EXECUTION_SURFACE_MISMATCH:${candidate.identity.candidateId}:${expectedSurface}`);
  }
  assertEvaluationCandidateArtifact({
    candidateId: candidate.identity.candidateId,
    artifactPath: candidate.artifactPath,
    artifactDigest: candidate.identity.artifactDigest,
    binding: candidate.artifactBinding,
    command: candidate.command,
  });
}

function seededSwap(seed: string, scenarioId: string, cacheMode: EvaluationCacheMode, repetition: number): boolean {
  const value = createHash('sha256').update(`${seed}\0${scenarioId}\0${cacheMode}\0${repetition}`).digest();
  return (value[0] & 1) === 1;
}

export function planCandidateTrials(protocol: FrozenEvaluationProtocol, scenarioId: string): PlannedCandidateTrial[] {
  const trials: PlannedCandidateTrial[] = [];
  let sequence = 0;
  protocol.trialPolicy.cacheModes.forEach((cacheMode, cacheIndex) => {
    for (let repetition = 0; repetition < protocol.trialPolicy.repetitions; repetition += 1) {
      const swap = protocol.trialPolicy.orderPolicy === 'balanced_alternating'
        ? ((repetition + cacheIndex) % 2 === 1)
        : seededSwap(protocol.trialPolicy.randomSeed ?? '', scenarioId, cacheMode, repetition);
      const order: readonly [0 | 1, 0 | 1] = swap ? [1, 0] : [0, 1];
      for (const candidateIndex of order) {
        trials.push({ sequence, repetition, cacheMode, candidateIndex });
        sequence += 1;
      }
    }
  });
  return trials;
}

export async function runPairedCandidateEvaluation(input: {
  protocol: FrozenEvaluationProtocol;
  scenario: EvaluationScenario;
  candidates: readonly [EvaluationCandidateAdapter, EvaluationCandidateAdapter];
  environment: EvaluationEnvironmentIdentity;
  repositoryRoot?: string;
  keepSandboxes?: boolean;
}): Promise<PairedCandidateRun> {
  if (!input.protocol.corpus.scenarioIds.includes(input.scenario.id)) {
    throw new Error(`EVALUATION_SCENARIO_NOT_IN_FROZEN_CORPUS:${input.scenario.id}`);
  }
  const expectedScenarioDigest = input.protocol.corpus.scenarioDigests[input.scenario.id];
  const observedScenarioDigest = evaluationScenarioDigest(input.scenario);
  if (expectedScenarioDigest !== observedScenarioDigest) {
    throw new Error(`EVALUATION_SCENARIO_DIGEST_MISMATCH:${input.scenario.id}`);
  }
  if (input.candidates[0].identity.candidateId === input.candidates[1].identity.candidateId) {
    throw new Error('EVALUATION_CANDIDATE_IDS_MUST_BE_DISTINCT');
  }
  for (const candidate of input.candidates) assertCandidateArtifact(candidate, input.scenario);
  if (input.protocol.trialPolicy.cacheModes.includes('warm')) {
    if (input.protocol.trialPolicy.warmupTrials < 1) throw new Error('EVALUATION_WARM_CACHE_REQUIRES_WARMUP_TRIALS');
    for (const candidate of input.candidates) {
      if (!candidate.warmup) throw new Error(`EVALUATION_WARMUP_COMMAND_REQUIRED:${candidate.identity.candidateId}`);
    }
  }

  const repositoryRoot = resolve(input.repositoryRoot ?? process.cwd());
  const source = resolveSourcePath(repositoryRoot, input.scenario.snapshot.source);
  const plan = planCandidateTrials(input.protocol, input.scenario.id);
  const trials: CandidateTrialResult[] = [];

  for (const planned of plan) {
    const candidate = input.candidates[planned.candidateIndex];
    const sandbox = createIsolatedSnapshot(source, input.scenario.snapshot.commit);
    const retained = input.keepSandboxes === true;
    const isolation = evaluationIsolationIdentity(sandbox);
    const candidateArtifact = materializeEvaluationCandidateArtifact({
      candidateId: candidate.identity.candidateId,
      artifactPath: candidate.artifactPath,
      artifactDigest: candidate.identity.artifactDigest,
      binding: candidate.artifactBinding,
      command: candidate.command,
      trialRoot: sandbox.root,
    });
    const trialCommand = candidateArtifact.command;
    const env = {
      ...isolatedEvaluationEnvironment(sandbox),
      FORGE_EVALUATION_CANDIDATE_ID: candidate.identity.candidateId,
      FORGE_EVALUATION_CACHE_MODE: planned.cacheMode,
      FORGE_EVALUATION_REPETITION: String(planned.repetition),
      FORGE_EVALUATION_SEQUENCE: String(planned.sequence),
    };
    try {
      const warmupCommands: CommandRecord[] = [];
      if (planned.cacheMode === 'warm') {
        const warmup = candidate.warmup!;
        for (let warmupIndex = 0; warmupIndex < input.protocol.trialPolicy.warmupTrials; warmupIndex += 1) {
          const command = captureCommand({
            kind: 'forge',
            command: trialCommand.executable,
            arguments: [...(trialCommand.prefixArguments ?? []), ...warmup.arguments],
            cwd: sandbox.repository,
            timeoutMs: warmup.timeoutMs ?? input.protocol.trialPolicy.timeoutMs,
            env,
          });
          warmupCommands.push(command);
          if (!commandSucceeded(command)) {
            throw new Error(`EVALUATION_WARMUP_FAILED:${candidate.identity.candidateId}:${planned.repetition}:${warmupIndex}`);
          }
        }
        assertMaterializedCandidateArtifactUnchanged(candidate.identity.candidateId, candidateArtifact);
        const warmupChanges = changedFiles(sandbox.repository).files;
        if (warmupChanges.length > 0) {
          throw new Error(`EVALUATION_WARMUP_MUTATED_REPOSITORY:${candidate.identity.candidateId}:${warmupChanges.join(',')}`);
        }
      }
      const report = input.scenario.execution.interface === 'forge_mcp'
        ? await runPublicMcpEvaluationInSnapshot({
            scenario: input.scenario,
            sandbox,
            forgeCommand: trialCommand,
            retained,
            env,
          })
        : runEvaluationInSnapshot({
            scenario: input.scenario,
            sandbox,
            forgeCommand: trialCommand,
            retained,
            env,
          });
      assertMaterializedCandidateArtifactUnchanged(candidate.identity.candidateId, candidateArtifact);
      trials.push({
        ...planned,
        runIdentity: evaluationRunIdentity({ protocol: input.protocol, candidate: candidate.identity, environment: input.environment }),
        isolation,
        warmupCommands,
        report,
      });
    } finally {
      if (!retained) cleanupIsolatedSnapshot(sandbox.root);
    }
  }

  return deepFreeze({
    schemaVersion: PAIRED_CANDIDATE_RUN_SCHEMA,
    authority: CROSS_VERSION_EVALUATION_AUTHORITY,
    protocolDigest: input.protocol.protocolDigest,
    environmentFingerprint: input.environment.fingerprint,
    scenarioId: input.scenario.id,
    candidateIds: [input.candidates[0].identity.candidateId, input.candidates[1].identity.candidateId] as const,
    orderPolicy: input.protocol.trialPolicy.orderPolicy,
    trials,
  });
}
