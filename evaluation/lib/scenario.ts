import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  SCENARIO_SCHEMA,
  type ChangedPathsValidator,
  type CommandValidator,
  type EvaluationScenario,
  type GroundTruth,
  type ScenarioValidator,
  type ValidatorKind,
} from './types.ts';

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
  fail(`validators[${index}].type`, 'must be command or changed_paths');
}

export function parseScenario(value: unknown): EvaluationScenario {
  const input = record(value, 'scenario');
  if (input.schemaVersion !== SCENARIO_SCHEMA) fail('schemaVersion', `must equal ${SCENARIO_SCHEMA}`);
  const snapshot = record(input.snapshot, 'snapshot');
  const execution = record(input.execution, 'execution');
  if (execution.interface !== 'forge_cli') fail('execution.interface', 'only forge_cli is supported in v1');
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
    execution: {
      interface: 'forge_cli',
      arguments: stringArray(execution.arguments, 'execution.arguments', 1),
      timeoutMs: positiveInteger(execution.timeoutMs, 'execution.timeoutMs'),
      traceFile: execution.traceFile === undefined ? undefined : string(execution.traceFile, 'execution.traceFile'),
    },
    validators,
    provenance: input.provenance === undefined ? undefined : (() => {
      const provenance = record(input.provenance, 'provenance');
      return {
        sourceCommit: provenance.sourceCommit === undefined ? undefined : string(provenance.sourceCommit, 'provenance.sourceCommit'),
        fixCommit: provenance.fixCommit === undefined ? undefined : string(provenance.fixCommit, 'provenance.fixCommit'),
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
