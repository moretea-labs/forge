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
import { buildReport } from './report.ts';
import { runEvaluationInSnapshot } from './runner.ts';
import { evaluationScenarioDigest } from './scenario.ts';
import {
  changedFiles,
  cleanupIsolatedSnapshot,
  createIsolatedSnapshot,
  evaluationIsolationIdentity,
  inspectSourceState,
  isolatedEvaluationEnvironment,
  resolveSourcePath,
  type EvaluationIsolationIdentity,
  type IsolatedSnapshot,
} from './sandbox.ts';
import { captureCommand, commandSucceeded } from './trace.ts';
import { TRACE_SCHEMA, type CommandRecord, type EvaluationReport, type EvaluationScenario, type EvaluationTrace, type ForgeCommand } from './types.ts';

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
  failure?: {
    code: 'candidate_failure' | 'candidate_timeout';
    message: string;
    timedOut: boolean;
  };
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

function measuredCandidateFailureReport(input: {
  scenario: EvaluationScenario;
  sandbox: IsolatedSnapshot;
  retained: boolean;
  trialCommand: ForgeCommand;
  startedAtMs: number;
  failureCode: 'candidate_failure' | 'candidate_timeout';
  message: string;
  timedOut: boolean;
}): EvaluationReport {
  const observedAt = Date.now();
  const sourceAfter = inspectSourceState(input.sandbox.source);
  const changes = changedFiles(input.sandbox.repository);
  const sourceUnchanged = input.sandbox.sourceStateBefore.clean === sourceAfter.state.clean
    && input.sandbox.sourceStateBefore.statusDigest === sourceAfter.state.statusDigest;
  const failureCommand: CommandRecord = {
    kind: 'forge',
    stepId: 'candidate-execution',
    command: input.trialCommand.executable,
    arguments: [...(input.trialCommand.prefixArguments ?? []), '<evaluation>'],
    cwd: input.sandbox.repository,
    exitCode: 1,
    startedAt: new Date(input.startedAtMs).toISOString(),
    durationMs: Math.max(0, observedAt - input.startedAtMs),
    stdout: '',
    stderr: `${input.failureCode}:${input.message}`,
    timedOut: input.timedOut,
  };
  const trace: EvaluationTrace = {
    schemaVersion: TRACE_SCHEMA,
    scenarioId: input.scenario.id,
    taskInput: input.scenario.userIntent,
    snapshot: {
      commit: input.scenario.snapshot.commit,
      sourceStateBefore: input.sandbox.sourceStateBefore,
      sourceStateAfter: sourceAfter.state,
    },
    sandbox: {
      strategy: 'git-clone-no-local',
      retained: input.retained,
      ...(input.retained ? { path: input.sandbox.repository } : {}),
    },
    contextRetrieval: [],
    inspectedEvidence: [],
    changedFiles: changes.files,
    commands: [...input.sandbox.setupCommands, failureCommand, sourceAfter.command, ...changes.commands],
    checks: [],
    toolInteractions: [{
      kind: input.scenario.execution.interface === 'forge_mcp' ? 'forge_tool' : 'forge_cli',
      name: input.scenario.execution.interface,
      outcome: 'failure',
    }],
    finalResult: { status: 'failed', summary: `${input.failureCode}:${input.message}` },
    validation: [
      ...input.scenario.validators.map((validator) => ({
        id: validator.id,
        kind: validator.kind,
        status: 'failed' as const,
        summary: `Candidate execution did not reach validator evaluation: ${input.failureCode}`,
      })),
      sourceUnchanged
        ? { id: 'source-repository-unchanged', kind: 'isolation' as const, status: 'passed' as const, summary: 'Source Git status was unchanged before and after the failed candidate trial.' }
        : { id: 'source-repository-unchanged', kind: 'isolation' as const, status: 'failed' as const, summary: 'Source Git status changed during the failed candidate trial; do not trust this result.' },
    ],
  };
  return buildReport(input.scenario, trace);
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
    const trialStartedAtMs = Date.now();
    const warmupCommands: CommandRecord[] = [];
    try {
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
            const code = command.timedOut ? 'EVALUATION_CANDIDATE_WARMUP_TIMEOUT' : 'EVALUATION_CANDIDATE_WARMUP_FAILED';
            throw new Error(`${code}:${candidate.identity.candidateId}:${planned.repetition}:${warmupIndex}`);
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
            executionTimeoutMs: input.protocol.trialPolicy.timeoutMs,
            scenario: input.scenario,
            sandbox,
            forgeCommand: trialCommand,
            retained,
            env,
          })
        : runEvaluationInSnapshot({
            executionTimeoutMs: input.protocol.trialPolicy.timeoutMs,
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
    } catch (error) {
      assertMaterializedCandidateArtifactUnchanged(candidate.identity.candidateId, candidateArtifact);
      const message = error instanceof Error ? error.message : String(error);
      const measuredCandidateFailure = message.startsWith('EVALUATION_CANDIDATE_MCP_CONNECT_FAILED:')
        || message.startsWith('EVALUATION_CANDIDATE_TIMEOUT:')
        || message.startsWith('EVALUATION_CANDIDATE_MCP_CAPTURE_FAILED:')
        || message.startsWith('EVALUATION_CANDIDATE_WARMUP_FAILED:')
        || message.startsWith('EVALUATION_CANDIDATE_WARMUP_TIMEOUT:');
      if (!measuredCandidateFailure) throw error;
      const timedOut = message.includes('EVALUATION_MCP_TIMEOUT:')
        || message.includes('EVALUATION_CANDIDATE_TIMEOUT:')
        || message.startsWith('EVALUATION_CANDIDATE_WARMUP_TIMEOUT:')
        || warmupCommands.some((command) => command.timedOut);
      const failureCode = timedOut ? 'candidate_timeout' : 'candidate_failure';
      const report = measuredCandidateFailureReport({
        scenario: input.scenario,
        sandbox,
        retained,
        trialCommand,
        startedAtMs: trialStartedAtMs,
        failureCode,
        message,
        timedOut,
      });
      trials.push({
        ...planned,
        runIdentity: evaluationRunIdentity({ protocol: input.protocol, candidate: candidate.identity, environment: input.environment }),
        isolation,
        warmupCommands,
        report,
        failure: { code: failureCode, message, timedOut },
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
