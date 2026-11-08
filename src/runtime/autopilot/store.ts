import { randomUUID } from 'crypto';
import {
  readControlPlaneRecord,
  writeControlPlaneRecord,
  type ControlPlaneRecord,
} from '../control-plane/persistence/sqlite-store';
import type { AutopilotPolicy, AutopilotRun, AutopilotRunStatus } from './types';

const NAMESPACE = 'requirement_autopilot_run';

export function defaultAutopilotPolicy(input: Partial<AutopilotPolicy> = {}): AutopilotPolicy {
  return {
    provider: 'deepseek',
    model: input.model?.trim() || 'deepseek-chat',
    maxTotalTokens: Math.max(1_000, Math.min(Math.trunc(input.maxTotalTokens ?? 50_000), 500_000)),
    maxTurns: Math.max(1, Math.min(Math.trunc(input.maxTurns ?? 12), 48)),
    maxToolCalls: Math.max(1, Math.min(Math.trunc(input.maxToolCalls ?? 32), 128)),
    checkpointPlanIds: [...new Set((input.checkpointPlanIds ?? []).map((value) => value.trim()).filter(Boolean))].slice(0, 64),
  };
}

export function readAutopilotRun(
  controllerHome: string,
  repoId: string,
  requirementId: string,
): ControlPlaneRecord<AutopilotRun> | undefined {
  return readControlPlaneRecord<AutopilotRun>(controllerHome, NAMESPACE, repoId, requirementId);
}

export function createAutopilotRun(
  controllerHome: string,
  input: {
    repoId: string;
    checkoutId: string;
    requirementId: string;
    requirementRevision: number;
    grantId: string;
    policy: AutopilotPolicy;
    now?: Date;
  },
): ControlPlaneRecord<AutopilotRun> {
  const existing = readAutopilotRun(controllerHome, input.repoId, input.requirementId);
  if (existing && ['running', 'paused'].includes(existing.value.status)) {
    throw new Error(`AUTOPILOT_RUN_ACTIVE: ${existing.value.runId}`);
  }
  const at = (input.now ?? new Date()).toISOString();
  const value: AutopilotRun = {
    schemaVersion: 1,
    runId: `autopilot_${randomUUID().replaceAll('-', '')}`,
    repoId: input.repoId,
    checkoutId: input.checkoutId,
    requirementId: input.requirementId,
    requirementRevision: input.requirementRevision,
    grantId: input.grantId,
    status: 'running',
    policy: input.policy,
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, turns: 0, toolCalls: 0 },
    evidenceRefs: [],
    createdAt: at,
    updatedAt: at,
  };
  return writeControlPlaneRecord(controllerHome, {
    namespace: NAMESPACE,
    scope: input.repoId,
    key: input.requirementId,
    schemaVersion: 1,
    value,
    action: 'autopilot_run_started',
    expectedRevision: existing?.revision ?? null,
  });
}

export function updateAutopilotRun(
  controllerHome: string,
  repoId: string,
  requirementId: string,
  mutate: (current: AutopilotRun) => AutopilotRun,
  action = 'autopilot_run_updated',
): ControlPlaneRecord<AutopilotRun> {
  const current = readAutopilotRun(controllerHome, repoId, requirementId);
  if (!current) throw new Error(`AUTOPILOT_RUN_NOT_FOUND: ${requirementId}`);
  const next = mutate(structuredClone(current.value));
  next.updatedAt = new Date().toISOString();
  return writeControlPlaneRecord(controllerHome, {
    namespace: NAMESPACE,
    scope: repoId,
    key: requirementId,
    schemaVersion: 1,
    value: next,
    action,
    expectedRevision: current.revision,
  });
}

export function setAutopilotRunStatus(
  controllerHome: string,
  repoId: string,
  requirementId: string,
  status: AutopilotRunStatus,
  stopReason?: string,
): ControlPlaneRecord<AutopilotRun> {
  return updateAutopilotRun(controllerHome, repoId, requirementId, (run) => {
    const next = { ...run, status };
    if (stopReason) next.stopReason = stopReason.slice(0, 1_000);
    else delete next.stopReason;
    return next;
  }, `autopilot_run_${status}`);
}
