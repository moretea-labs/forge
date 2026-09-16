import { randomUUID } from 'node:crypto';
import { parseSupervisorCompletion, renderSupervisorPrompt, sha256, validateEffectId } from './protocol';
import { WorkflowSupervisorStore } from './store';
import type { WorkflowAssistantObservation, WorkflowAssistantObservationResult, WorkflowContractValidation, WorkflowSupervisorCompletion, WorkflowSupervisorEffect, WorkflowSupervisorTask, WorkflowSupervisorTaskInput, WorkflowSupervisorValidators } from './types';

function effectId(): string { return `fx_${randomUUID().replaceAll('-', '')}`; }
const rejectUnconfigured = async (): Promise<WorkflowContractValidation> => ({ valid: false, reason: 'validator_unconfigured' });

export class WorkflowSupervisorControlPlane {
  readonly validators: WorkflowSupervisorValidators;
  constructor(readonly store: WorkflowSupervisorStore, validators: Partial<WorkflowSupervisorValidators> = {}) {
    this.validators = { completionContract: validators.completionContract ?? rejectUnconfigured, userBlockerPolicy: validators.userBlockerPolicy ?? rejectUnconfigured };
  }
  registerTask(input: WorkflowSupervisorTaskInput): WorkflowSupervisorTask { return this.store.registerTask(input); }
  reserveEnrollment(taskId: string): WorkflowSupervisorEffect {
    const task = this.requireTask(taskId); const id = effectId();
    return this.store.reserveEffect({ taskId, effectId: id, kind: 'enrollment', originKey: `enrollment:${taskId}`, prompt: renderSupervisorPrompt(task, id, 'enrollment') });
  }
  observeEffect(input: { effectId: string; observationId: string; outcome: 'applied' | 'not_applied' | 'unknown'; evidence?: Record<string, unknown> }): void {
    this.store.recordEffectObservation(validateEffectId(input.effectId), input.observationId, input.outcome, input.evidence);
  }
  getTask(taskId: string): WorkflowSupervisorTask | undefined { return this.store.getTask(taskId); }
  getEffect(id: string): WorkflowSupervisorEffect | undefined { return this.store.getEffect(validateEffectId(id)); }

  async observeAssistantTurn(input: WorkflowAssistantObservation): Promise<WorkflowAssistantObservationResult> {
    const task = this.requireTask(input.taskId);
    if (task.conversationId !== input.conversationId) throw new Error('WORKFLOW_SUPERVISOR_CONVERSATION_MISMATCH');
    const parsed = parseSupervisorCompletion(input.responseText);
    const sourceEffect = this.store.getEffect(parsed.proposal.sourceEffectId);
    if (!sourceEffect || sourceEffect.taskId !== task.taskId || !this.store.effectApplied(sourceEffect.effectId)) throw new Error('WORKFLOW_SUPERVISOR_CAUSAL_EFFECT_NOT_APPLIED');
    const responseSha256 = sha256(input.responseText);
    const controlBlockSha256 = sha256(parsed.controlBlock);
    const completionFingerprint = sha256(jsonIdentity(task.taskId, task.conversationId, parsed.proposal.sourceEffectId, responseSha256, controlBlockSha256));
    const completion: WorkflowSupervisorCompletion = { completionFingerprint, taskId: task.taskId, sourceEffectId: parsed.proposal.sourceEffectId, action: parsed.proposal.action, responseSha256, controlBlockSha256, proposal: parsed.proposal, committedAt: new Date().toISOString() };
    const terminal = this.store.terminalAction(task.taskId);
    if (terminal) throw new Error(`WORKFLOW_SUPERVISOR_TASK_TERMINAL:${terminal}`);

    if (parsed.proposal.action === 'CONTINUE') {
      const nextId = effectId();
      const prompt = renderSupervisorPrompt(task, nextId, 'continuation', parsed.proposal.checkpoint);
      const committed = this.store.commitCompletion(completion, { effectId: nextId, kind: 'continuation', prompt });
      return { action: 'CONTINUE', completionFingerprint, terminal: false, successorEffect: committed.successorEffect!, deduplicated: committed.deduplicated };
    }

    const committed = this.store.commitCompletion(completion);
    const validator = parsed.proposal.action === 'DONE' ? this.validators.completionContract : this.validators.userBlockerPolicy;
    const validation = await validator(task, parsed.proposal);
    const correctionId = validation.valid ? undefined : effectId();
    const resolved = this.store.resolveTerminal({ completionFingerprint, taskId: task.taskId, action: parsed.proposal.action, accepted: validation.valid, reason: validation.reason,
      ...(correctionId ? { correction: { effectId: correctionId, prompt: renderSupervisorPrompt(task, correctionId, 'correction', parsed.proposal.checkpoint, validation.reason) } } : {}) });
    return { action: parsed.proposal.action, completionFingerprint, terminal: validation.valid, ...(resolved.successorEffect ? { successorEffect: resolved.successorEffect } : {}), validation, deduplicated: committed.deduplicated || resolved.deduplicated };
  }

  private requireTask(taskId: string): WorkflowSupervisorTask { const task = this.store.getTask(taskId); if (!task) throw new Error('WORKFLOW_SUPERVISOR_TASK_UNKNOWN'); return task; }
}

function jsonIdentity(...values: string[]): string { return JSON.stringify(values); }
