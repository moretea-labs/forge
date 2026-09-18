import { randomUUID } from 'node:crypto';
import { parseChatgptConversationIdentity } from './chatgpt-conversation';
import { parseSupervisorCompletion, renderEffectMarker, renderSupervisorPrompt, sha256, validateEffectId } from './protocol';
import { WorkflowSupervisorStore } from './store';
import type { WorkflowAssistantObservation, WorkflowAssistantObservationResult, WorkflowContractValidation, WorkflowSupervisorBrowserPollResult, WorkflowSupervisorBrowserTask, WorkflowSupervisorCompletion, WorkflowSupervisorEffect, WorkflowSupervisorLifecycleHooks, WorkflowSupervisorTask, WorkflowSupervisorTaskInput, WorkflowSupervisorTurnSettlement, WorkflowSupervisorValidators } from './types';

function effectId(): string { return `fx_${randomUUID().replaceAll('-', '')}`; }
const rejectUnconfigured = async (): Promise<WorkflowContractValidation> => ({ valid: false, reason: 'validator_unconfigured' });

export class WorkflowSupervisorControlPlane {
  readonly validators: WorkflowSupervisorValidators;
  readonly hooks: WorkflowSupervisorLifecycleHooks;
  constructor(readonly store: WorkflowSupervisorStore, validators: Partial<WorkflowSupervisorValidators> = {}, hooks: WorkflowSupervisorLifecycleHooks = {}) {
    this.validators = { completionContract: validators.completionContract ?? rejectUnconfigured, userBlockerPolicy: validators.userBlockerPolicy ?? rejectUnconfigured };
    this.hooks = hooks;
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
  browserTasks(): WorkflowSupervisorBrowserTask[] { return this.store.listTasks().filter((task) => !this.store.terminalAction(task.taskId) && this.browserTaskActive(task)).map(browserTask); }
  browserPoll(input: { conversationId: string; conversationUrl: string }): WorkflowSupervisorBrowserPollResult {
    const task = this.requireBrowserTask(input.conversationId, input.conversationUrl);
    if (!this.browserTaskActive(task)) throw new Error('WORKFLOW_SUPERVISOR_BROWSER_TASK_INACTIVE');
    const projection = browserTask(task);
    const terminal = this.store.terminalAction(task.taskId);
    if (terminal) return { authorized: true, task: projection, terminal };
    const pending = this.store.nextBrowserEffect(task.taskId);
    if (!pending) return { authorized: true, task: projection };
    return { authorized: true, task: projection, command: { mode: pending.mode, effectId: pending.effect.effectId, kind: pending.effect.kind, prompt: pending.effect.prompt, dispatchGeneration: pending.generation, conversationId: task.conversationId, conversationUrl: task.conversationUrl } };
  }
  browserBeginEffect(input: { conversationId: string; conversationUrl: string; effectId: string; dispatchId: string; dispatchGeneration: number; evidence?: Record<string, unknown> }): { started: boolean; mode: 'send' | 'reconcile'; generation: number } {
    const task = this.requireBrowserTask(input.conversationId, input.conversationUrl);
    const pending = this.store.nextBrowserEffect(task.taskId);
    const effectId = validateEffectId(input.effectId);
    if (!pending || pending.effect.effectId !== effectId) throw new Error('WORKFLOW_SUPERVISOR_BROWSER_EFFECT_NOT_CURRENT');
    if (pending.mode !== 'send' || pending.generation !== input.dispatchGeneration) return { started: false, mode: 'reconcile', generation: pending.generation };
    const snapshot = browserSnapshot(input.evidence);
    if (!snapshot || browserTextHasEffect(snapshot.latestUserText, effectId) || !this.browserSnapshotMatchesSource(task, pending.effect, snapshot)) {
      return { started: false, mode: 'reconcile', generation: pending.generation };
    }
    const dispatchEvidence = {
      surface: typeof input.evidence?.surface === 'string' ? input.evidence.surface.slice(0, 128) : 'chrome-extension',
      baseline_user_sha256: browserTextSha256(snapshot.latestUserText),
      baseline_assistant_sha256: sha256(snapshot.latestAssistantResponse),
      baseline_has_source_completion: Boolean(pending.effect.sourceCompletionFingerprint),
    };
    const started = this.store.recordEffectDispatchStarted(effectId, input.dispatchGeneration, input.dispatchId, dispatchEvidence);
    return { started, mode: started ? 'send' : 'reconcile', generation: input.dispatchGeneration };
  }
  browserObserveEffect(input: { conversationId: string; conversationUrl: string; effectId: string; observationId: string; outcome: 'applied' | 'not_applied' | 'unknown'; evidence?: Record<string, unknown> }): { recorded: true } {
    const task = this.requireBrowserTask(input.conversationId, input.conversationUrl);
    const effect = this.store.getEffect(validateEffectId(input.effectId));
    if (!effect || effect.taskId !== task.taskId) throw new Error('WORKFLOW_SUPERVISOR_BROWSER_EFFECT_TASK_MISMATCH');
    if (input.outcome !== 'not_applied') {
      this.observeEffect({ effectId: effect.effectId, observationId: input.observationId, outcome: input.outcome, evidence: sanitizeBrowserEvidence(input.evidence) });
      return { recorded: true };
    }
    const pending = this.store.nextBrowserEffect(task.taskId);
    const dispatch = this.store.latestEffectDispatch(effect.effectId);
    const snapshot = browserSnapshot(input.evidence);
    const sourceMatches = snapshot ? this.browserSnapshotMatchesSource(task, effect, snapshot) : false;
    const preservedBaseline = Boolean(snapshot && dispatch
      && browserTextSha256(snapshot.latestUserText) === dispatch.evidence.baseline_user_sha256
      && sha256(snapshot.latestAssistantResponse) === dispatch.evidence.baseline_assistant_sha256);
    const targetAbsent = Boolean(snapshot && !browserTextHasEffect(snapshot.latestUserText, effect.effectId));
    if (!pending || pending.effect.effectId !== effect.effectId || pending.mode !== 'reconcile' || !dispatch || pending.generation !== dispatch.generation || !snapshot || !sourceMatches || !preservedBaseline || !targetAbsent) {
      this.store.recordEffectObservation(effect.effectId, input.observationId, 'unknown', { reconciliation: true, reason: 'not_applied_proof_incomplete' });
      return { recorded: true };
    }
    this.store.recordEffectNotAppliedProof(effect.effectId, input.observationId, {
      reconciliation: true, dispatch_generation: dispatch.generation, source_completion_fingerprint: effect.sourceCompletionFingerprint ?? 'enrollment_baseline',
      latest_user_sha256: browserTextSha256(snapshot.latestUserText), latest_assistant_sha256: sha256(snapshot.latestAssistantResponse), target_marker_present: false,
    });
    return { recorded: true };
  }
  browserObserveProviderTurn(input: { conversationId: string; conversationUrl: string; generating: boolean; latestAssistantResponse: string; observedAtMs: number; graceMs: number }): { state: 'inactive' | 'none' | 'generating' | 'idle_pending' | 'recovery_reserved' | 'exhausted'; recoveryEffect?: WorkflowSupervisorEffect } {
    const task = this.requireBrowserTask(input.conversationId, input.conversationUrl);
    if (!this.browserTaskActive(task)) return { state: 'inactive' };
    const sourceEffect = this.store.latestAppliedEffectWithoutCompletion(task.taskId);
    if (!sourceEffect) return { state: 'none' };
    const recoveryId = effectId();
    const recoveryReason = `Applied Supervisor effect ${sourceEffect.effectId} reached a provider-idle turn without a committed Supervisor completion. Resume from durable Forge state; the source effect remains applied and must not be replayed.`;
    return this.store.observeProviderTurn({
      taskId: task.taskId,
      effectId: sourceEffect.effectId,
      generating: input.generating,
      assistantDigest: sha256(input.latestAssistantResponse),
      observedAtMs: input.observedAtMs,
      graceMs: input.graceMs,
      maxRecoveryDepth: 2,
      recovery: { effectId: recoveryId, prompt: renderSupervisorPrompt(task, recoveryId, 'recovery', undefined, recoveryReason) },
    });
  }
  async browserObserveAssistant(input: { conversationId: string; conversationUrl: string; responseText: string }): Promise<WorkflowAssistantObservationResult> {
    const task = this.requireBrowserTask(input.conversationId, input.conversationUrl);
    return await this.observeAssistantTurn({ taskId: task.taskId, conversationId: task.conversationId, responseText: input.responseText });
  }

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

    // Persist exact assistant-turn evidence before lower-layer reconciliation.
    // Replayed observation may therefore retry a missed settlement without asking
    // the provider to regenerate the completion.
    const committed = this.store.commitCompletion(completion);
    const settlement: WorkflowSupervisorTurnSettlement = await this.hooks.assistantTurnCommitted?.(task, completion)
      ?? { continuationAllowed: true };

    if (parsed.proposal.action === 'CONTINUE') {
      if (!settlement.continuationAllowed) {
        throw new Error(`WORKFLOW_SUPERVISOR_LOWER_LAYER_CONTINUATION_BLOCKED:${settlement.reason ?? 'unspecified'}`);
      }
      const nextId = effectId();
      const prompt = renderSupervisorPrompt(task, nextId, 'continuation', parsed.proposal.checkpoint, undefined, settlement.continuationContext);
      const withSuccessor = this.store.commitCompletion(completion, { effectId: nextId, kind: 'continuation', prompt });
      return { action: 'CONTINUE', completionFingerprint, terminal: false, successorEffect: withSuccessor.successorEffect!, deduplicated: committed.deduplicated || withSuccessor.deduplicated };
    }

    const validator = parsed.proposal.action === 'DONE' ? this.validators.completionContract : this.validators.userBlockerPolicy;
    const validation = await validator(task, parsed.proposal);
    const correctionId = validation.valid ? undefined : effectId();
    const resolved = this.store.resolveTerminal({ completionFingerprint, taskId: task.taskId, action: parsed.proposal.action, accepted: validation.valid, reason: validation.reason,
      ...(correctionId ? { correction: { effectId: correctionId, prompt: renderSupervisorPrompt(task, correctionId, 'correction', parsed.proposal.checkpoint, validation.reason, settlement.continuationContext) } } : {}) });
    return { action: parsed.proposal.action, completionFingerprint, terminal: validation.valid, ...(resolved.successorEffect ? { successorEffect: resolved.successorEffect } : {}), validation, deduplicated: committed.deduplicated || resolved.deduplicated };
  }

  private browserTaskActive(task: WorkflowSupervisorTask): boolean { return this.hooks.browserTaskActive?.(task) ?? true; }

  private browserSnapshotMatchesSource(task: WorkflowSupervisorTask, effect: WorkflowSupervisorEffect, snapshot: { latestUserText: string; latestAssistantResponse: string }): boolean {
    if (!effect.sourceCompletionFingerprint) return true;
    const completion = this.store.getCompletion(effect.sourceCompletionFingerprint);
    if (!completion || completion.taskId !== task.taskId || sha256(snapshot.latestAssistantResponse) !== completion.responseSha256) return false;
    const sourceEffect = this.store.getEffect(completion.sourceEffectId);
    return Boolean(sourceEffect && sourceEffect.taskId === task.taskId && normalizeBrowserText(snapshot.latestUserText) === normalizeBrowserText(sourceEffect.prompt));
  }

  private requireTask(taskId: string): WorkflowSupervisorTask { const task = this.store.getTask(taskId); if (!task) throw new Error('WORKFLOW_SUPERVISOR_TASK_UNKNOWN'); return task; }
  private requireBrowserTask(conversationId: string, conversationUrl: string): WorkflowSupervisorTask {
    const observed = parseChatgptConversationIdentity(conversationUrl);
    if (observed.conversationId !== conversationId) throw new Error('WORKFLOW_SUPERVISOR_BROWSER_CONVERSATION_MISMATCH');
    const task = this.store.getTaskByConversationId(conversationId);
    if (!task) throw new Error('WORKFLOW_SUPERVISOR_BROWSER_CONVERSATION_NOT_ENROLLED');
    const registered = parseChatgptConversationIdentity(task.conversationUrl);
    if (task.conversationId !== conversationId || registered.conversationId !== conversationId || registered.canonicalUrl !== observed.canonicalUrl) throw new Error('WORKFLOW_SUPERVISOR_BROWSER_CONVERSATION_MISMATCH');
    return task;
  }
}

function boundedBrowserText(value: unknown, max: number): string | undefined { return typeof value === 'string' && Buffer.byteLength(value, 'utf8') <= max ? value : undefined; }
function browserSnapshot(evidence: Record<string, unknown> | undefined): { latestUserText: string; latestAssistantResponse: string } | undefined {
  const latestUserText = boundedBrowserText(evidence?.latest_user_text, 128 * 1024);
  const latestAssistantResponse = boundedBrowserText(evidence?.latest_assistant_response, 512 * 1024);
  return latestUserText === undefined || latestAssistantResponse === undefined ? undefined : { latestUserText, latestAssistantResponse };
}
function normalizeBrowserText(value: string): string { return value.replace(/\s+/g, ' ').trim(); }
function browserTextSha256(value: string): string { return sha256(normalizeBrowserText(value)); }
function browserTextHasEffect(value: string, effectId: string): boolean { return value.includes(renderEffectMarker(effectId)); }
const PERSISTED_BROWSER_EVIDENCE_KEYS = new Set(['exact_user_message', 'reconciliation', 'reason', 'surface', 'target_marker_present']);
function sanitizeBrowserEvidence(evidence: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!evidence) return {};
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(evidence)) {
    if (!PERSISTED_BROWSER_EVIDENCE_KEYS.has(key)) continue;
    if (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) sanitized[key] = value;
    else if (typeof value === 'string' && value.length <= 512) sanitized[key] = value;
  }
  return sanitized;
}

function browserTask(task: WorkflowSupervisorTask): WorkflowSupervisorBrowserTask { return { taskId: task.taskId, conversationId: task.conversationId, conversationUrl: task.conversationUrl }; }
function jsonIdentity(...values: string[]): string { return JSON.stringify(values); }
