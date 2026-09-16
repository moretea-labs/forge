import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { assertEvaluationCandidateArtifact, type EvaluationCandidateArtifactBinding } from '../lib/candidate-artifact.ts';
import { cleanupIsolatedSnapshot, createIsolatedSnapshot, isolatedEvaluationEnvironment, type IsolatedSnapshot } from '../lib/sandbox.ts';
import type { ForgeCommand } from '../lib/types.ts';

export const ADAPTIVE_EVALUATOR_SCHEMA = 'forge-adaptive-workflow/v2' as const;
export const ADAPTIVE_EVALUATOR_VERSION = 'forge-adaptive-workflow/v2' as const;
export const ADAPTIVE_SOURCE_REVISION = 'c873cfeb11a223ced342e7101c016261b4a93b38' as const;
export type AdaptiveWorkflowId = 'investigation_direct' | 'dependency_durable_admission' | 'restart_durable_work_visible';
export type AdaptiveCacheMode = 'cold' | 'warm';

export interface AdaptiveCandidate {
  identity: { candidateId: string; versionLabel: string; artifactDigest: string; sourceRevision: string; executionSurface: string };
  artifactPath: string;
  artifactBinding: EvaluationCandidateArtifactBinding;
  command: ForgeCommand;
  warmup?: { arguments: readonly string[]; timeoutMs?: number };
}

export interface AdaptiveTrial {
  workflowId: AdaptiveWorkflowId;
  cacheMode: AdaptiveCacheMode;
  repetition: number;
  candidateIndex: number;
  candidateId: string;
  goalSuccess: boolean;
  toolInteractions: number;
  retries: number;
  recoveryActions: number;
  restarts: number;
  harnessSetupMs: number;
  warmupMs: number;
  initialConnectMs: number;
  restartConnectMs: number;
  toolCallMs: number;
  candidateActiveMs: number;
  totalTrialMs: number;
  steps: Array<{ tool: string; durationMs: number; outcome: 'success' | 'error'; summary: string }>;
  failure?: string;
}

export interface AdaptiveComparison {
  workflowId: AdaptiveWorkflowId | 'overall';
  cacheMode: AdaptiveCacheMode | 'all';
  pairCount: number;
  baselineGoalSuccessRate: number;
  candidateGoalSuccessRate: number;
  baselineMeanToolInteractions: number;
  candidateMeanToolInteractions: number;
  baselineMeanRetries: number;
  candidateMeanRetries: number;
  baselineMeanRecoveryActions: number;
  candidateMeanRecoveryActions: number;
  baselineMeanRestarts: number;
  candidateMeanRestarts: number;
  baselineMeanCandidateActiveMs: number;
  candidateMeanCandidateActiveMs: number;
  candidateActiveDeltaMs: number;
  candidateActiveDeltaRatio: number | null;
  candidateActiveDelta95CiMs: [number, number] | null;
  baselineMeanHarnessSetupMs: number;
  candidateMeanHarnessSetupMs: number;
}

const WORKFLOWS: readonly AdaptiveWorkflowId[] = ['investigation_direct', 'dependency_durable_admission', 'restart_durable_work_visible'];
const CACHE_MODES: readonly AdaptiveCacheMode[] = ['cold', 'warm'];

const BASE_ARGS = Object.freeze({
  operation: 'start', requested_by: 'user', work_kind: 'investigation', scope_clear: true,
  requires_investigation: true, requires_long_running_checks: false, requires_parallelism: false,
  requires_recovery: false, requires_worker: false, requires_external_effect: false,
  requires_approval: false, requires_user_approval: false, destructive: false,
  remote_write: false, secret_access: false,
});

export const ADAPTIVE_WORKFLOW_CONTRACT = Object.freeze({
  schemaVersion: 'forge-adaptive-workflow-contract/v2',
  sourceRevision: ADAPTIVE_SOURCE_REVISION,
  profile: 'controller',
  toolset: 'advanced',
  workflows: {
    investigation_direct: { objective: 'Evaluation bounded investigation', needs_dependencies: false },
    dependency_durable_admission: { objective: 'Evaluation dependency ordered durable admission', needs_dependencies: true },
    restart_durable_work_visible: { objective: 'Evaluation restart durable Work visibility', needs_dependencies: true },
  },
});

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value);
}
function digest(value: unknown): string { return `sha256:${createHash('sha256').update(canonical(value)).digest('hex')}`; }

export function adaptiveEvaluatorImplementationDigest(): string {
  return `sha256:${createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex')}`;
}
export function adaptiveWorkflowContractDigest(): string { return digest(ADAPTIVE_WORKFLOW_CONTRACT); }

function stringEnvironment(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
}
function normalizedToolPayload(result: unknown): unknown {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return result;
  const record = result as Record<string, unknown>;
  if (record.structuredContent && typeof record.structuredContent === 'object') return record.structuredContent;
  const content = Array.isArray(record.content) ? record.content : [];
  const text = content.find((entry) => entry && typeof entry === 'object' && (entry as Record<string, unknown>).type === 'text') as Record<string, unknown> | undefined;
  if (typeof text?.text === 'string') { try { return JSON.parse(text.text); } catch { return { text: text.text }; } }
  return record;
}
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<T>((_r, reject) => { timer = setTimeout(() => reject(new Error(`ADAPTIVE_TIMEOUT:${label}`)), timeoutMs); })]);
  } finally { if (timer) clearTimeout(timer); }
}

interface Connection { client: Client; transport: StdioClientTransport; }
async function openConnection(candidate: AdaptiveCandidate, sandbox: IsolatedSnapshot, env: NodeJS.ProcessEnv): Promise<{ connection: Connection; durationMs: number }> {
  const started = performance.now();
  const transport = new StdioClientTransport({
    command: candidate.command.executable,
    args: [...(candidate.command.prefixArguments ?? []), 'mcp', 'serve', '--repo', sandbox.repository, '--controller-home', sandbox.controllerHome, '--transport', 'stdio', '--profile', 'controller', '--toolset', 'advanced'],
    cwd: sandbox.repository,
    env: stringEnvironment(env),
    stderr: 'pipe',
  });
  const client = new Client({ name: 'forge-supplemental-adaptive', version: '2.0.0' });
  try { await withTimeout(client.connect(transport), 30_000, 'connect'); }
  catch (error) { await client.close().catch(() => undefined); throw error; }
  return { connection: { client, transport }, durationMs: performance.now() - started };
}
async function closeConnection(connection: Connection | undefined): Promise<void> { if (connection) await connection.client.close().catch(() => undefined); }

async function callTool(connection: Connection, tool: string, args: Record<string, unknown>) {
  const started = performance.now();
  try {
    const response = await withTimeout(connection.client.callTool({ name: tool, arguments: args }), 60_000, tool);
    const payload = normalizedToolPayload(response);
    return { payload, isError: (response as { isError?: boolean }).isError === true, durationMs: performance.now() - started };
  } catch (error) {
    return { payload: { error: error instanceof Error ? error.message : String(error) }, isError: true, durationMs: performance.now() - started };
  }
}
function payloadText(payload: unknown): string { return JSON.stringify(payload); }
function includesAll(payload: unknown, needles: readonly string[]): boolean { const text = payloadText(payload); return needles.every((needle) => text.includes(needle)); }

export function classifyAdaptiveStep(workflowId: AdaptiveWorkflowId, step: 'admit' | 'status', payload: unknown, isError: boolean): { success: boolean; shouldRestart: boolean; summary: string } {
  if (workflowId === 'investigation_direct') {
    const success = !isError && includesAll(payload, ['direct_control', '"workContractCreated":false', 'investigation']);
    return { success, shouldRestart: false, summary: success ? 'direct_without_work' : 'unexpected_routing' };
  }
  if (step === 'admit') {
    const retained = isError && includesAll(payload, ['goal_workloop', '"workContractCreated":true', '"canonicalWorkRetained":true', 'CONTROLLER_AUTHENTICATED_SESSION_REQUIRED']);
    return { success: retained, shouldRestart: workflowId === 'restart_durable_work_visible' && retained, summary: retained ? 'durable_work_retained' : 'durable_admission_contract_failed' };
  }
  const visible = isError && includesAll(payload, ['Evaluation restart durable Work visibility', '"activeWork":[{', 'RUNTIME_NOT_RUNNING']);
  return { success: visible, shouldRestart: false, summary: visible ? 'durable_work_visible_after_restart' : 'restart_projection_failed' };
}

function startArgs(workflowId: AdaptiveWorkflowId): Record<string, unknown> {
  const contract = ADAPTIVE_WORKFLOW_CONTRACT.workflows[workflowId];
  return { ...BASE_ARGS, objective: contract.objective, needs_dependencies: contract.needs_dependencies };
}

function warmCandidate(candidate: AdaptiveCandidate, sandbox: IsolatedSnapshot, env: NodeJS.ProcessEnv): number {
  const started = performance.now();
  const result = spawnSync(candidate.command.executable, [...(candidate.command.prefixArguments ?? []), ...(candidate.warmup?.arguments ?? ['--version'])], {
    cwd: sandbox.repository, env: stringEnvironment(env), encoding: 'utf8', timeout: candidate.warmup?.timeoutMs ?? 30_000,
  });
  if (result.status !== 0) throw new Error(`ADAPTIVE_WARMUP_FAILED:${candidate.identity.candidateId}:${result.stderr ?? ''}`);
  return performance.now() - started;
}

export async function runAdaptiveTrial(input: {
  sourceRoot: string;
  candidate: AdaptiveCandidate;
  candidateIndex: number;
  workflowId: AdaptiveWorkflowId;
  cacheMode: AdaptiveCacheMode;
  repetition: number;
}): Promise<AdaptiveTrial> {
  const totalStarted = performance.now();
  const setupStarted = performance.now();
  const sandbox = createIsolatedSnapshot(input.sourceRoot, ADAPTIVE_SOURCE_REVISION);
  const harnessSetupMs = performance.now() - setupStarted;
  const env = isolatedEvaluationEnvironment(sandbox);
  let connection: Connection | undefined;
  let initialConnectMs = 0, restartConnectMs = 0, toolCallMs = 0, warmupMs = 0;
  let toolInteractions = 0, retries = 0, recoveryActions = 0, restarts = 0;
  const steps: AdaptiveTrial['steps'] = [];
  let goalSuccess = false;
  let failure: string | undefined;
  try {
    if (input.cacheMode === 'warm') warmupMs = warmCandidate(input.candidate, sandbox, env);
    const opened = await openConnection(input.candidate, sandbox, env); connection = opened.connection; initialConnectMs = opened.durationMs;
    const first = await callTool(connection, 'rh_work', startArgs(input.workflowId));
    toolInteractions += 1; toolCallMs += first.durationMs;
    const firstClass = classifyAdaptiveStep(input.workflowId, 'admit', first.payload, first.isError);
    steps.push({ tool: 'rh_work', durationMs: first.durationMs, outcome: first.isError ? 'error' : 'success', summary: firstClass.summary });
    if (input.workflowId === 'investigation_direct' || input.workflowId === 'dependency_durable_admission') {
      goalSuccess = firstClass.success;
    } else if (firstClass.shouldRestart) {
      await closeConnection(connection); connection = undefined; restarts += 1;
      const reopened = await openConnection(input.candidate, sandbox, env); connection = reopened.connection; restartConnectMs += reopened.durationMs;
      const second = await callTool(connection, 'rh_status', {}); toolInteractions += 1; toolCallMs += second.durationMs;
      const secondClass = classifyAdaptiveStep(input.workflowId, 'status', second.payload, second.isError);
      steps.push({ tool: 'rh_status', durationMs: second.durationMs, outcome: second.isError ? 'error' : 'success', summary: secondClass.summary });
      goalSuccess = firstClass.success && secondClass.success;
    } else {
      goalSuccess = false;
    }
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  } finally {
    await closeConnection(connection);
    cleanupIsolatedSnapshot(sandbox.root);
  }
  const candidateActiveMs = initialConnectMs + restartConnectMs + toolCallMs;
  return {
    workflowId: input.workflowId, cacheMode: input.cacheMode, repetition: input.repetition,
    candidateIndex: input.candidateIndex, candidateId: input.candidate.identity.candidateId,
    goalSuccess, toolInteractions, retries, recoveryActions, restarts,
    harnessSetupMs, warmupMs, initialConnectMs, restartConnectMs, toolCallMs, candidateActiveMs,
    totalTrialMs: performance.now() - totalStarted, steps, ...(failure ? { failure } : {}),
  };
}

function mean(values: readonly number[]): number { return values.reduce((sum, value) => sum + value, 0) / values.length; }
function t95(n: number): number {
  if (n <= 1) return Infinity;
  const critical: Record<number, number> = { 2:12.706,3:4.303,4:3.182,5:2.776,6:2.571,7:2.447,8:2.365,9:2.306,10:2.262,11:2.228,12:2.201,13:2.179,14:2.160,15:2.145,16:2.131,17:2.120,18:2.110,19:2.101,20:2.093,21:2.086,22:2.080,23:2.074,24:2.069,25:2.064,26:2.060,27:2.056,28:2.052,29:2.048,30:2.045 };
  return critical[n] ?? 1.96;
}
function confidenceInterval(values: number[]): [number, number] | null {
  if (values.length < 2) return null;
  const center = mean(values); const variance = values.reduce((sum, value) => sum + ((value - center) ** 2), 0) / (values.length - 1);
  const margin = t95(values.length) * Math.sqrt(variance / values.length); return [center - margin, center + margin];
}

export function compareAdaptiveTrials(trials: readonly AdaptiveTrial[], workflowId: AdaptiveWorkflowId | 'overall', cacheMode: AdaptiveCacheMode | 'all'): AdaptiveComparison {
  const filtered = trials.filter((trial) => (workflowId === 'overall' || trial.workflowId === workflowId) && (cacheMode === 'all' || trial.cacheMode === cacheMode));
  const pairs = new Map<string, AdaptiveTrial[]>();
  for (const trial of filtered) { const key = `${trial.workflowId}:${trial.cacheMode}:${trial.repetition}`; const list = pairs.get(key) ?? []; list.push(trial); pairs.set(key, list); }
  const baseline: AdaptiveTrial[] = [], candidate: AdaptiveTrial[] = [], deltas: number[] = [];
  for (const [key, pair] of pairs) {
    if (pair.length !== 2) throw new Error(`ADAPTIVE_PAIR_INCOMPLETE:${key}`);
    const a = pair.find((trial) => trial.candidateIndex === 0); const b = pair.find((trial) => trial.candidateIndex === 1);
    if (!a || !b) throw new Error(`ADAPTIVE_PAIR_IDENTITY_INVALID:${key}`);
    baseline.push(a); candidate.push(b); deltas.push(b.candidateActiveMs - a.candidateActiveMs);
  }
  const bm = mean(baseline.map((x) => x.candidateActiveMs)); const cm = mean(candidate.map((x) => x.candidateActiveMs));
  return {
    workflowId, cacheMode, pairCount: pairs.size,
    baselineGoalSuccessRate: mean(baseline.map((x) => x.goalSuccess ? 1 : 0)), candidateGoalSuccessRate: mean(candidate.map((x) => x.goalSuccess ? 1 : 0)),
    baselineMeanToolInteractions: mean(baseline.map((x) => x.toolInteractions)), candidateMeanToolInteractions: mean(candidate.map((x) => x.toolInteractions)),
    baselineMeanRetries: mean(baseline.map((x) => x.retries)), candidateMeanRetries: mean(candidate.map((x) => x.retries)),
    baselineMeanRecoveryActions: mean(baseline.map((x) => x.recoveryActions)), candidateMeanRecoveryActions: mean(candidate.map((x) => x.recoveryActions)),
    baselineMeanRestarts: mean(baseline.map((x) => x.restarts)), candidateMeanRestarts: mean(candidate.map((x) => x.restarts)),
    baselineMeanCandidateActiveMs: bm, candidateMeanCandidateActiveMs: cm, candidateActiveDeltaMs: cm - bm,
    candidateActiveDeltaRatio: bm === 0 ? null : (cm - bm) / bm, candidateActiveDelta95CiMs: confidenceInterval(deltas),
    baselineMeanHarnessSetupMs: mean(baseline.map((x) => x.harnessSetupMs)), candidateMeanHarnessSetupMs: mean(candidate.map((x) => x.harnessSetupMs)),
  };
}

export function adaptiveCandidateOrder(workflowIndex: number, cacheIndex: number, repetition: number): [number, number] {
  return (workflowIndex + cacheIndex + repetition) % 2 === 0 ? [0, 1] : [1, 0];
}

export async function runAdaptiveExperiment(input: { sourceRoot: string; candidates: readonly [AdaptiveCandidate, AdaptiveCandidate]; repetitions: number }) {
  if (!Number.isInteger(input.repetitions) || input.repetitions < 2) throw new Error('ADAPTIVE_REPETITIONS_MINIMUM_2');
  for (const candidate of input.candidates) assertEvaluationCandidateArtifact({
    candidateId: candidate.identity.candidateId, artifactPath: candidate.artifactPath, artifactDigest: candidate.identity.artifactDigest,
    binding: candidate.artifactBinding, command: candidate.command,
  });
  const trials: AdaptiveTrial[] = [];
  for (let wi = 0; wi < WORKFLOWS.length; wi++) for (let ci = 0; ci < CACHE_MODES.length; ci++) for (let repetition = 0; repetition < input.repetitions; repetition++) {
    for (const candidateIndex of adaptiveCandidateOrder(wi, ci, repetition)) {
      trials.push(await runAdaptiveTrial({ sourceRoot: input.sourceRoot, candidate: input.candidates[candidateIndex]!, candidateIndex, workflowId: WORKFLOWS[wi]!, cacheMode: CACHE_MODES[ci]!, repetition }));
    }
  }
  for (const candidate of input.candidates) assertEvaluationCandidateArtifact({
    candidateId: candidate.identity.candidateId, artifactPath: candidate.artifactPath, artifactDigest: candidate.identity.artifactDigest,
    binding: candidate.artifactBinding, command: candidate.command,
  });
  const comparisons: AdaptiveComparison[] = [];
  for (const workflow of WORKFLOWS) for (const cacheMode of CACHE_MODES) comparisons.push(compareAdaptiveTrials(trials, workflow, cacheMode));
  const overall = compareAdaptiveTrials(trials, 'overall', 'all');
  return {
    schemaVersion: 'forge-supplemental-adaptive-result/v2', evaluatorVersion: ADAPTIVE_EVALUATOR_VERSION,
    evaluatorImplementationDigest: adaptiveEvaluatorImplementationDigest(), workflowContractDigest: adaptiveWorkflowContractDigest(),
    repetitions: input.repetitions, pairCount: WORKFLOWS.length * CACHE_MODES.length * input.repetitions, trialCount: trials.length,
    candidates: input.candidates.map((candidate) => candidate.identity), overall, comparisons, trials,
  };
}
