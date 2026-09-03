import { createHash } from 'crypto';
import type {
  BootstrapAction,
  BootstrapBlocker,
  BootstrapDesiredState,
  BootstrapEvaluation,
  BootstrapObservation,
  BootstrapSnapshot,
  BootstrapStatus,
  BootstrapStep,
} from './types';

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort();
}

function byId<T extends { id: string }>(values: readonly T[]): T[] {
  return [...values].sort((left, right) => left.id.localeCompare(right.id));
}

function normalizeDesired(value: BootstrapDesiredState): BootstrapDesiredState {
  return {
    ...value,
    controllers: [...new Set([value.primaryController, ...value.controllers])].sort(),
    capabilityIntents: uniqueSorted(value.capabilityIntents),
    connectivity: {
      ...value.connectivity,
      ...(value.connectivity.endpoint?.trim() ? { endpoint: value.connectivity.endpoint.trim() } : { endpoint: undefined }),
      ...(value.connectivity.tunnelId?.trim() ? { tunnelId: value.connectivity.tunnelId.trim() } : { tunnelId: undefined }),
    },
  };
}

function normalizedObservations(values: readonly BootstrapObservation[]): BootstrapObservation[] {
  return byId(values).map((value) => ({
    ...value,
    summary: value.summary.trim(),
    reasonCodes: value.reasonCodes ? uniqueSorted(value.reasonCodes) : undefined,
  }));
}

function normalizedActions(values: readonly BootstrapAction[]): BootstrapAction[] {
  return byId(values).map((value) => ({ ...value, summary: value.summary.trim() }));
}

function normalizedBlockers(values: readonly BootstrapBlocker[]): BootstrapBlocker[] {
  return [...values]
    .sort((left, right) => left.code.localeCompare(right.code))
    .map((value) => ({ ...value, actionIds: uniqueSorted(value.actionIds) }));
}

function normalizedSteps(values: readonly BootstrapStep[]): BootstrapStep[] {
  return byId(values).map((value) => ({
    ...value,
    dependsOn: uniqueSorted(value.dependsOn),
    observationIds: uniqueSorted(value.observationIds),
    blockerCodes: uniqueSorted(value.blockerCodes),
    actionIds: uniqueSorted(value.actionIds),
  }));
}

function assertUnique(label: string, values: readonly string[]): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (!value.trim()) throw new Error(`BOOTSTRAP_INVALID_${label.toUpperCase()}: blank identifier`);
    if (seen.has(value)) throw new Error(`BOOTSTRAP_DUPLICATE_${label.toUpperCase()}: ${value}`);
    seen.add(value);
  }
}

function assertReferences(evaluation: BootstrapEvaluation): void {
  assertUnique('observation', evaluation.observations.map((entry) => entry.id));
  assertUnique('action', evaluation.actions.map((entry) => entry.id));
  assertUnique('blocker', evaluation.blockers.map((entry) => entry.code));
  assertUnique('step', evaluation.steps.map((entry) => entry.id));
  const observations = new Set(evaluation.observations.map((entry) => entry.id));
  const actions = new Set(evaluation.actions.map((entry) => entry.id));
  const blockers = new Set(evaluation.blockers.map((entry) => entry.code));
  const steps = new Set(evaluation.steps.map((entry) => entry.id));
  for (const step of evaluation.steps) {
    for (const id of step.observationIds) if (!observations.has(id)) throw new Error(`BOOTSTRAP_OBSERVATION_NOT_FOUND: ${step.id}:${id}`);
    for (const id of step.actionIds) if (!actions.has(id)) throw new Error(`BOOTSTRAP_ACTION_NOT_FOUND: ${step.id}:${id}`);
    for (const code of step.blockerCodes) if (!blockers.has(code)) throw new Error(`BOOTSTRAP_BLOCKER_NOT_FOUND: ${step.id}:${code}`);
    for (const dependency of step.dependsOn) if (!steps.has(dependency)) throw new Error(`BOOTSTRAP_STEP_DEPENDENCY_NOT_FOUND: ${step.id}:${dependency}`);
  }
  for (const blocker of evaluation.blockers) {
    if (!steps.has(blocker.stepId)) throw new Error(`BOOTSTRAP_BLOCKER_STEP_NOT_FOUND: ${blocker.code}:${blocker.stepId}`);
    for (const actionId of blocker.actionIds) if (!actions.has(actionId)) throw new Error(`BOOTSTRAP_BLOCKER_ACTION_NOT_FOUND: ${blocker.code}:${actionId}`);
  }
}

function statusFor(steps: readonly BootstrapStep[], blockers: readonly BootstrapBlocker[]): BootstrapStatus {
  if (blockers.length > 0 || steps.some((step) => step.state === 'blocked')) return 'blocked';
  if (steps.length > 0 && steps.every((step) => step.state === 'ready' || step.state === 'skipped')) return 'ready';
  return 'in_progress';
}

function fingerprintPayload(evaluation: BootstrapEvaluation): unknown {
  return {
    desired: normalizeDesired(evaluation.desired),
    observations: normalizedObservations(evaluation.observations).map(({ observedAt: _observedAt, ...rest }) => rest),
    steps: normalizedSteps(evaluation.steps),
    blockers: normalizedBlockers(evaluation.blockers),
    actions: normalizedActions(evaluation.actions),
  };
}

export function bootstrapStateFingerprint(evaluation: BootstrapEvaluation): string {
  return createHash('sha256').update(JSON.stringify(fingerprintPayload(evaluation))).digest('hex');
}

export function buildBootstrapSnapshot(input: {
  controllerHome: string;
  evaluation: BootstrapEvaluation;
  previous?: BootstrapSnapshot;
  now?: () => Date;
}): BootstrapSnapshot {
  assertReferences(input.evaluation);
  const fingerprint = bootstrapStateFingerprint(input.evaluation);
  if (input.previous?.stateFingerprint === fingerprint && input.previous.controllerHome === input.controllerHome) return input.previous;
  const now = (input.now ?? (() => new Date()))().toISOString();
  const desired = normalizeDesired(input.evaluation.desired);
  const observations = normalizedObservations(input.evaluation.observations);
  const steps = normalizedSteps(input.evaluation.steps);
  const blockers = normalizedBlockers(input.evaluation.blockers);
  const actions = normalizedActions(input.evaluation.actions);
  return {
    schemaVersion: 1,
    status: statusFor(steps, blockers),
    revision: (input.previous?.revision ?? 0) + 1,
    stateFingerprint: fingerprint,
    controllerHome: input.controllerHome,
    desired,
    observations,
    steps,
    blockers,
    actions,
    createdAt: input.previous?.createdAt ?? now,
    updatedAt: now,
  };
}
