import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  SCENARIO_SCHEMA,
  type ChangedPathsValidator,
  type CommandValidator,
  type EvaluationBehaviorClass,
  type EvaluationCorpusClass,
  type EvaluationProvenanceKind,
  type EvaluationRepositoryFixture,
  type EvaluationScenario,
  type ExecutionOutputValidator,
  type ForgeCliExecutionStep,
  type ForgeMcpCall,
  type ScenarioExecution,
  type GroundTruth,
  type ScenarioValidator,
  type ValidatorKind,
} from './types.ts';

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, nested]) => nested !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function evaluationScenarioDigest(scenario: EvaluationScenario): string {
  return `sha256:${createHash('sha256').update(canonicalJson(scenario)).digest('hex')}`;
}

function fail(path: string, message: string): never {
  throw new Error(`Invalid evaluation scenario ${path}: ${message}`);
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(path, 'must be an object');
  return value as Record<string, unknown>;
}

function string(value: unknown, path: string, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && value.trim().length === 0)) fail(path, 'must be a non-empty string');
  return value;
}

function stringArray(value: unknown, path: string, minimum = 0): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || entry.trim().length === 0)) {
    fail(path, 'must be an array of non-empty strings');
  }
  if (value.length < minimum) fail(path, `must contain at least ${minimum} item(s)`);
  return [...value];
}

function positiveInteger(value: unknown, path: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) fail(path, 'must be a positive integer');
  return value;
}

function integer(value: unknown, path: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value)) fail(path, 'must be an integer');
  return value;
}

function boolean(value: unknown, path: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') fail(path, 'must be a boolean');
  return value;
}

function repositoryFixture(value: unknown, index: number): EvaluationRepositoryFixture {
  const input = record(value, `fixtures.repositories[${index}]`);
  const id = string(input.id, `fixtures.repositories[${index}].id`);
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(id) || id === 'primary') {
    fail(`fixtures.repositories[${index}].id`, 'must be a stable lowercase fixture id and may not equal primary');
  }
  return { id };
}

function corpusClass(value: unknown, path: string): EvaluationCorpusClass {
  if (value === 'shared' || value === 'v2_only') return value;
  fail(path, 'must be shared or v2_only');
}

function behaviorClass(value: unknown, path: string): EvaluationBehaviorClass {
  if (
    value === 'discovery_context'
    || value === 'bounded_mutation'
    || value === 'work_lifecycle'
    || value === 'failure_classification'
    || value === 'restart_recovery'
    || value === 'multi_repo_concurrency'
  ) return value;
  fail(path, 'must be a declared Golden Corpus behavior class');
}

function provenanceKind(value: unknown, path: string): EvaluationProvenanceKind {
  if (value === 'historical_regression' || value === 'historical_behavior' || value === 'synthetic_fixture') return value;
  fail(path, 'must be historical_regression, historical_behavior, or synthetic_fixture');
}

function executionStep(value: unknown, index: number): ForgeCliExecutionStep {
  const input = record(value, `execution.steps[${index}]`);
  return {
    id: string(input.id, `execution.steps[${index}].id`),
    arguments: stringArray(input.arguments, `execution.steps[${index}].arguments`, 1),
    timeoutMs: positiveInteger(input.timeoutMs, `execution.steps[${index}].timeoutMs`),
    expectedExitCode: integer(input.expectedExitCode, `execution.steps[${index}].expectedExitCode`),
    traceFile: input.traceFile === undefined ? undefined : string(input.traceFile, `execution.steps[${index}].traceFile`),
  };
}

function mcpCall(value: unknown, index: number): ForgeMcpCall {
  const input = record(value, `execution.calls[${index}]`);
  const expectedOutcome = input.expectedOutcome === undefined ? 'success' : input.expectedOutcome;
  if (expectedOutcome !== 'success' && expectedOutcome !== 'error') fail(`execution.calls[${index}].expectedOutcome`, 'must be success or error');
  const captureInput = input.capture === undefined ? undefined : record(input.capture, `execution.calls[${index}].capture`);
  const capture = captureInput === undefined ? undefined : Object.fromEntries(
    Object.entries(captureInput).map(([key, selector]) => [
      string(key, `execution.calls[${index}].capture key`),
      string(selector, `execution.calls[${index}].capture.${key}`),
    ]),
  );
  return {
    id: string(input.id, `execution.calls[${index}].id`),
    tool: string(input.tool, `execution.calls[${index}].tool`),
    arguments: structuredClone(record(input.arguments ?? {}, `execution.calls[${index}].arguments`)),
    capture,
    expectedOutcome,
    timeoutMs: positiveInteger(input.timeoutMs, `execution.calls[${index}].timeoutMs`),
    restartBefore: boolean(input.restartBefore, `execution.calls[${index}].restartBefore`),
    parallelGroup: input.parallelGroup === undefined ? undefined : string(input.parallelGroup, `execution.calls[${index}].parallelGroup`),
  };
}

function groundTruth(value: unknown): GroundTruth {
  const input = record(value, 'groundTruth');
  return {
    intendedBehavior: stringArray(input.intendedBehavior, 'groundTruth.intendedBehavior', 1),
    affectedDomains: stringArray(input.affectedDomains, 'groundTruth.affectedDomains', 1),
    behavioralInvariants: stringArray(input.behavioralInvariants, 'groundTruth.behavioralInvariants', 1),
    regressionRisks: stringArray(input.regressionRisks, 'groundTruth.regressionRisks', 1),
  };
}

function validatorKind(value: unknown, path: string): ValidatorKind {
  if (value === 'behavior' || value === 'invariant' || value === 'regression' || value === 'change_precision') return value;
  fail(path, 'must be behavior, invariant, regression, or change_precision');
}

function validator(value: unknown, index: number): ScenarioValidator {
  const input = record(value, `validators[${index}]`);
  const kind = validatorKind(input.kind, `validators[${index}].kind`);
  const id = string(input.id, `validators[${index}].id`);
  if (input.type === 'command') {
    const expectedExitCode = input.expectedExitCode === undefined ? 0 : input.expectedExitCode;
    if (typeof expectedExitCode !== 'number' || !Number.isInteger(expectedExitCode)) {
      fail(`validators[${index}].expectedExitCode`, 'must be an integer');
    }
    const result: CommandValidator = {
      id,
      kind,
      type: 'command',
      command: string(input.command, `validators[${index}].command`),
      arguments: stringArray(input.arguments ?? [], `validators[${index}].arguments`),
      expectedExitCode,
      timeoutMs: positiveInteger(input.timeoutMs, `validators[${index}].timeoutMs`),
    };
    return result;
  }
  if (input.type === 'execution_output') {
    if (kind !== 'behavior' && kind !== 'invariant' && kind !== 'regression') {
      fail(`validators[${index}].kind`, 'execution_output validators must be behavior, invariant, or regression');
    }
    const includes = stringArray(input.includes ?? [], `validators[${index}].includes`);
    const excludes = stringArray(input.excludes ?? [], `validators[${index}].excludes`);
    if (includes.length === 0 && excludes.length === 0 && input.expectedExitCode === undefined) {
      fail(`validators[${index}]`, 'execution_output must declare includes, excludes, or expectedExitCode');
    }
    const stream = input.stream === undefined ? 'stdout' : input.stream;
    if (stream !== 'stdout' && stream !== 'stderr' && stream !== 'combined') {
      fail(`validators[${index}].stream`, 'must be stdout, stderr, or combined');
    }
    const result: ExecutionOutputValidator = {
      id,
      kind,
      type: 'execution_output',
      stepId: input.stepId === undefined ? undefined : string(input.stepId, `validators[${index}].stepId`),
      stream,
      includes: includes.length > 0 ? includes : undefined,
      excludes: excludes.length > 0 ? excludes : undefined,
      expectedExitCode: integer(input.expectedExitCode, `validators[${index}].expectedExitCode`),
    };
    return result;
  }
  if (input.type === 'changed_paths') {
    if (kind !== 'regression' && kind !== 'change_precision') {
      fail(`validators[${index}].kind`, 'changed_paths validators must be regression or change_precision');
    }
    const requiredGlobs = stringArray(input.requiredGlobs ?? [], `validators[${index}].requiredGlobs`);
    const forbiddenGlobs = stringArray(input.forbiddenGlobs ?? [], `validators[${index}].forbiddenGlobs`);
    if (requiredGlobs.length === 0 && forbiddenGlobs.length === 0) {
      fail(`validators[${index}]`, 'changed_paths must declare requiredGlobs, forbiddenGlobs, or both');
    }
    const result: ChangedPathsValidator = {
      id,
      kind,
      type: 'changed_paths',
      ...(requiredGlobs.length > 0 ? { requiredGlobs } : {}),
      ...(forbiddenGlobs.length > 0 ? { forbiddenGlobs } : {}),
    };
    return result;
  }
  fail(`validators[${index}].type`, 'must be command, execution_output, or changed_paths');
}

export function parseScenario(value: unknown): EvaluationScenario {
  const input = record(value, 'scenario');
  if (input.schemaVersion !== SCENARIO_SCHEMA) fail('schemaVersion', `must equal ${SCENARIO_SCHEMA}`);
  const snapshot = record(input.snapshot, 'snapshot');
  const execution = record(input.execution, 'execution');
  let parsedExecution: ScenarioExecution;
  if (execution.interface === 'forge_cli') {
    const legacyArguments = execution.arguments === undefined ? undefined : stringArray(execution.arguments, 'execution.arguments', 1);
    const steps = execution.steps === undefined
      ? undefined
      : Array.isArray(execution.steps)
        ? execution.steps.map((entry, index) => executionStep(entry, index))
        : fail('execution.steps', 'must be an array');
    if (!legacyArguments && (!steps || steps.length === 0)) fail('execution', 'must declare arguments or at least one step');
    if (legacyArguments && steps) fail('execution', 'must not declare both arguments and steps');
    if (steps && new Set(steps.map((step) => step.id)).size !== steps.length) fail('execution.steps', 'ids must be unique');
    parsedExecution = {
      interface: 'forge_cli',
      arguments: legacyArguments,
      timeoutMs: positiveInteger(execution.timeoutMs, 'execution.timeoutMs'),
      traceFile: execution.traceFile === undefined ? undefined : string(execution.traceFile, 'execution.traceFile'),
      steps,
    };
  } else if (execution.interface === 'forge_mcp') {
    const calls = Array.isArray(execution.calls)
      ? execution.calls.map((entry, index) => mcpCall(entry, index))
      : fail('execution.calls', 'must be an array');
    if (calls.length === 0) fail('execution.calls', 'must contain at least one public MCP call');
    if (new Set(calls.map((call) => call.id)).size !== calls.length) fail('execution.calls', 'ids must be unique');
    const parallelGroups = new Map<string, number[]>();
    calls.forEach((call, index) => {
      if (!call.parallelGroup) return;
      const indices = parallelGroups.get(call.parallelGroup) ?? [];
      indices.push(index);
      parallelGroups.set(call.parallelGroup, indices);
      if (call.restartBefore) fail(`execution.calls[${index}]`, 'restartBefore is not allowed inside a parallelGroup');
    });
    for (const [group, indices] of parallelGroups) {
      if (indices.length < 2) fail('execution.calls', `parallelGroup ${group} must contain at least two calls`);
      const captureKeys = new Set<string>();
      for (let index = 0; index < indices.length; index += 1) {
        const callIndex = indices[index]!;
        if (index > 0 && callIndex !== indices[index - 1]! + 1) fail('execution.calls', `parallelGroup ${group} calls must be contiguous`);
        for (const key of Object.keys(calls[callIndex]!.capture ?? {})) {
          if (captureKeys.has(key)) fail('execution.calls', `parallelGroup ${group} capture keys must be unique: ${key}`);
          captureKeys.add(key);
        }
      }
    }
    const profile = execution.profile === undefined ? 'controller' : execution.profile;
    if (profile !== 'planner' && profile !== 'executor' && profile !== 'orchestrator' && profile !== 'controller') fail('execution.profile', 'must be planner, executor, orchestrator, or controller');
    const toolset = execution.toolset === undefined ? 'advanced' : execution.toolset;
    if (toolset !== 'facade' && toolset !== 'core' && toolset !== 'advanced' && toolset !== 'full') fail('execution.toolset', 'must be facade, core, advanced, or full');
    parsedExecution = { interface: 'forge_mcp', profile, toolset, calls };
  } else {
    fail('execution.interface', 'must be forge_cli or forge_mcp');
  }
  const fixtures = input.fixtures === undefined ? undefined : (() => {
    const fixtureInput = record(input.fixtures, 'fixtures');
    const repositories = fixtureInput.repositories === undefined
      ? []
      : Array.isArray(fixtureInput.repositories)
        ? fixtureInput.repositories.map((entry, index) => repositoryFixture(entry, index))
        : fail('fixtures.repositories', 'must be an array');
    if (new Set(repositories.map((fixture) => fixture.id)).size !== repositories.length) fail('fixtures.repositories', 'ids must be unique');
    return repositories.length > 0 ? { repositories } : undefined;
  })();

  const validators = Array.isArray(input.validators)
    ? input.validators.map((entry, index) => validator(entry, index))
    : fail('validators', 'must be an array');
  if (validators.length === 0) fail('validators', 'must contain at least one validator');
  if (new Set(validators.map((entry) => entry.id)).size !== validators.length) fail('validators', 'ids must be unique');

  const commit = string(snapshot.commit, 'snapshot.commit');
  if (!/^[0-9a-f]{7,64}$/i.test(commit)) fail('snapshot.commit', 'must be an immutable Git commit id');
  return {
    schemaVersion: SCENARIO_SCHEMA,
    id: string(input.id, 'id'),
    title: string(input.title, 'title'),
    userIntent: string(input.userIntent, 'userIntent'),
    snapshot: { source: string(snapshot.source, 'snapshot.source'), commit },
    groundTruth: groundTruth(input.groundTruth),
    fixtures,
    execution: parsedExecution,
    validators,
    corpus: input.corpus === undefined ? undefined : (() => {
      const corpus = record(input.corpus, 'corpus');
      return {
        class: corpusClass(corpus.class, 'corpus.class'),
        behaviorClass: behaviorClass(corpus.behaviorClass, 'corpus.behaviorClass'),
      };
    })(),
    provenance: input.provenance === undefined ? undefined : (() => {
      const provenance = record(input.provenance, 'provenance');
      return {
        kind: provenance.kind === undefined ? undefined : provenanceKind(provenance.kind, 'provenance.kind'),
        sourceCommit: provenance.sourceCommit === undefined ? undefined : string(provenance.sourceCommit, 'provenance.sourceCommit'),
        fixCommit: provenance.fixCommit === undefined ? undefined : string(provenance.fixCommit, 'provenance.fixCommit'),
        references: provenance.references === undefined ? undefined : stringArray(provenance.references, 'provenance.references'),
        note: provenance.note === undefined ? undefined : string(provenance.note, 'provenance.note'),
      };
    })(),
  };
}

export function loadScenario(path: string): EvaluationScenario {
  const absolute = resolve(path);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(absolute, 'utf8'));
  } catch (error) {
    throw new Error(`Unable to read evaluation scenario ${absolute}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return parseScenario(parsed);
}
