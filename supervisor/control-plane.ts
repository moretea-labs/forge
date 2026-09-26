import { randomUUID } from 'node:crypto';
import { parseChatgptConversationIdentity } from './chatgpt-conversation';
import { parseSupervisorCompletion, renderEffectMarker, renderSupervisorPrompt, sha256, validateEffectId } from './protocol';
import { WorkflowSupervisorStore } from './store';
import type { WorkflowAssistantObservation, WorkflowAssistantObservationResult, WorkflowContractValidation, WorkflowSupervisorBrowserPollResult, WorkflowSupervisorBrowserTask, WorkflowSupervisorCompletion, WorkflowSupervisorDiscoveredConversation, WorkflowSupervisorEffect, WorkflowSupervisorLifecycleHooks, WorkflowSupervisorProjectScope, WorkflowSupervisorTask, WorkflowSupervisorTaskInput, WorkflowSupervisorTurnSettlement, WorkflowSupervisorValidators } from './types';

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
  reserveEnrollment(taskId: string, canonicalEffectId?: string): WorkflowSupervisorEffect {
    const task = this.requireTask(taskId);
    // A task that already reached a terminal supervisor action is not deliverable.
    // Reserving another enrollment effect for it produced an "enrolled" result that
    // could never be delivered, so the ControllerRound waited forever instead of
    // surfacing the operator/provider decision that terminal state represents.
    requireNonTerminalTask(this.store, task.taskId);
    const id = canonicalEffectId ? validateEffectId(canonicalEffectId) : effectId();
    return this.store.reserveEffect({ taskId, effectId: id, kind: 'enrollment', originKey: `enrollment:${taskId}`, prompt: renderSupervisorPrompt(task, id, 'enrollment') });
  }
  /** @deprecated Compatibility RPC. Recovery policy no longer lives in Supervisor/Scheduler. */
  reserveSchedulerRecovery(taskId: string, _recoveryKey?: string): WorkflowSupervisorEffect | undefined {
    const task = this.requireTask(taskId);
    requireNonTerminalTask(this.store, task.taskId);
    return undefined;
  }
  observeEffect(input: { effectId: string; observationId: string; outcome: 'applied' | 'not_applied' | 'unknown'; evidence?: Record<string, unknown> }): void {
    this.store.recordEffectObservation(validateEffectId(input.effectId), input.observationId, input.outcome, input.evidence);
  }
  getTask(taskId: string): WorkflowSupervisorTask | undefined { return this.store.getTask(taskId); }
  getEffect(id: string): WorkflowSupervisorEffect | undefined { return this.store.getEffect(validateEffectId(id)); }
  browserDiscoverySnapshot() { return this.store.discoverySnapshot(); }
  recordBrowserDiscovery(source: string, conversations: readonly WorkflowSupervisorDiscoveredConversation[]) {
    // Discovery is durable observation only. Creating a Supervisor task/effect
    // requires the explicit Work/current-conversation enrollment path.
    return this.store.recordDiscovery(source, conversations);
  }
  browserProjectScopes(): WorkflowSupervisorProjectScope[] {
    const scopes = new Map<string, WorkflowSupervisorProjectScope>();
    for (const task of this.store.listTasks()) {
      const scope = this.hooks.projectScopeForTask?.(task);
      if (!scope?.title.trim()) continue;
      const normalized: WorkflowSupervisorProjectScope = {
        title: scope.title.trim().slice(0, 512),
        ...(scope.repoId?.trim() ? { repoId: scope.repoId.trim().slice(0, 256) } : {}),
        ...(scope.controllerHome?.trim() ? { controllerHome: scope.controllerHome.trim().slice(0, 2048) } : {}),
      };
      const key = `${normalized.title.toLocaleLowerCase()}\n${normalized.repoId ?? ''}\n${normalized.controllerHome ?? ''}`;
      scopes.set(key, normalized);
    }
    return [...scopes.values()];
  }
  browserTasks(): WorkflowSupervisorBrowserTask[] {
    return this.store.listTasks().filter((task) => {
      if (this.store.terminalAction(task.taskId)) return false;
      // Browser observation is needed only while there is something to send,
      // reconcile, or observe to completion. An otherwise-active Requirement is
      // not itself a reason to re-open Work/Requirement authority and snapshot
      // the browser every second.
      const appliedEffectAwaitingCompletion = this.store.hasAppliedEffectAwaitingCompletion(task.taskId);
      const needsBrowserAttention = Boolean(
        this.store.nextBrowserEffect(task.taskId)
        || appliedEffectAwaitingCompletion,
      );
      // Once a browser effect has been applied, observation and any bounded
      // Supervisor recovery belong to the Supervisor external-effect
      // lifecycle. A transient lower ControllerRound wait must not strand
      // that effect before assistant completion is observed.
      return needsBrowserAttention && this.browserTaskActiveForExternalEffect(task);
    }).map(browserTask);
  }
  browserPoll(input: { conversationId: string; conversationUrl: string }): WorkflowSupervisorBrowserPollResult {
    const task = this.requireBrowserTask(input.conversationId, input.conversationUrl);
    if (!this.browserTaskActiveForExternalEffect(task)) throw new Error('WORKFLOW_SUPERVISOR_BROWSER_TASK_INACTIVE');
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
      const evidence = sanitizeBrowserEvidence(input.evidence);
      this.observeEffect({ effectId: effect.effectId, observationId: input.observationId, outcome: input.outcome, evidence });
      if (input.outcome === 'applied') this.hooks.effectApplied?.(task, effect, { observationId: input.observationId, evidence });
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
  browserObserveProviderTurn(input: { conversationId: string; conversationUrl: string; generating: boolean; latestAssistantResponse: string; providerActivityText?: string; providerFailureCode?: string; observedAtMs: number; graceMs: number }): { state: 'inactive' | 'none' | 'generating' | 'idle_pending' | 'recovery_reserved' | 'exhausted'; recoveryEffect?: WorkflowSupervisorEffect } {
    const task = this.requireBrowserTask(input.conversationId, input.conversationUrl);
    if (!this.browserTaskActiveForExternalEffect(task)) return { state: 'inactive' };
    const sourceEffect = this.store.latestAppliedEffectWithoutCompletion(task.taskId);
    if (!sourceEffect) return { state: 'none' };
    const recoveryId = effectId();
    const providerFailureCode = input.providerFailureCode?.trim();
    const recoveryReason = providerFailureCode
      ? `Applied Supervisor effect ${sourceEffect.effectId} ended with provider failure ${providerFailureCode} before a committed Supervisor completion. Resume from durable Forge state; the source effect remains applied and must not be replayed.`
      : `Applied Supervisor effect ${sourceEffect.effectId} reached a provider-idle turn without a committed Supervisor completion. Resume from durable Forge state; the source effect remains applied and must not be replayed.`;
    return this.store.observeProviderTurn({
      taskId: task.taskId,
      effectId: sourceEffect.effectId,
      generating: input.generating,
      assistantDigest: sha256(`${input.latestAssistantResponse}\n${input.providerActivityText ?? ''}`),
      providerFailureCode,
      observedAtMs: input.observedAtMs,
      graceMs: input.graceMs,
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
    const responseSha256 = sha256(input.responseText);
    const expectedEffect = this.store.latestAppliedEffectWithoutCompletion(task.taskId);
    // A live applied effect always wins: an old compact receipt must never be
    // allowed to satisfy a newer causal obligation. Only when no effect is
    // awaiting completion may an exact persisted response hash recover the
    // original effect context for idempotent duplicate observation.
    const priorCompletion = expectedEffect ? undefined : this.store.getCompletionByResponseSha256(task.taskId, responseSha256);
    const expectedEffectId = expectedEffect?.effectId ?? priorCompletion?.sourceEffectId;
    const parsed = parseSupervisorCompletion(
      input.responseText,
      expectedEffectId ? { task, effectId: expectedEffectId } : undefined,
    );
    const sourceEffect = this.store.getEffect(parsed.proposal.sourceEffectId);
    if (!sourceEffect || sourceEffect.taskId !== task.taskId || !this.store.effectApplied(sourceEffect.effectId)) throw new Error('WORKFLOW_SUPERVISOR_CAUSAL_EFFECT_NOT_APPLIED');
    const explicitIdentityProtocol = sourceEffect.prompt.includes('conversation_id=') && sourceEffect.prompt.includes('task_id=') && sourceEffect.prompt.includes('supervisor_state');
    if (parsed.proposal.conversationId && parsed.proposal.conversationId !== task.conversationId) throw new Error('WORKFLOW_SUPERVISOR_RESPONSE_CONVERSATION_MISMATCH');
    if (parsed.proposal.taskId && parsed.proposal.taskId !== task.taskId) throw new Error('WORKFLOW_SUPERVISOR_RESPONSE_TASK_MISMATCH');
    if (explicitIdentityProtocol && !parsed.proposal.conversationId) throw new Error('WORKFLOW_SUPERVISOR_RESPONSE_CONVERSATION_ID_REQUIRED');
    if (explicitIdentityProtocol && !parsed.proposal.taskId) throw new Error('WORKFLOW_SUPERVISOR_RESPONSE_TASK_ID_REQUIRED');
    if (explicitIdentityProtocol && !parsed.proposal.supervisorState) throw new Error('WORKFLOW_SUPERVISOR_RESPONSE_STATE_REQUIRED');
    if (explicitIdentityProtocol && !parsed.proposal.activeScope) throw new Error('WORKFLOW_SUPERVISOR_RESPONSE_ACTIVE_SCOPE_REQUIRED');
    const expectedScope = typeof task.completionContract.requirement_id === 'string' && task.completionContract.requirement_id.trim()
      ? `requirement:${task.completionContract.requirement_id.trim()}`
      : typeof task.continuationPolicy.active_scope === 'string' && task.continuationPolicy.active_scope.trim()
        ? task.continuationPolicy.active_scope.trim()
        : undefined;
    if (expectedScope && parsed.proposal.activeScope && parsed.proposal.activeScope !== expectedScope) throw new Error('WORKFLOW_SUPERVISOR_RESPONSE_ACTIVE_SCOPE_MISMATCH');
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
      const nextId = settlement.continuationEffectId
        ? validateEffectId(settlement.continuationEffectId)
        : effectId();
      const checkpoint = parsed.proposal.reason === 'compact_receipt' ? undefined : parsed.proposal.checkpoint;
      const prompt = renderSupervisorPrompt(task, nextId, 'continuation', checkpoint, undefined, settlement.continuationContext);
      const withSuccessor = this.store.commitCompletion(completion, { effectId: nextId, kind: 'continuation', prompt });
      return { action: 'CONTINUE', completionFingerprint, terminal: false, successorEffect: withSuccessor.successorEffect!, deduplicated: committed.deduplicated || withSuccessor.deduplicated };
    }

    const validator = parsed.proposal.action === 'DONE' ? this.validators.completionContract : this.validators.userBlockerPolicy;
    const validation = await validator(task, parsed.proposal);
    const correctionId = validation.valid ? undefined : effectId();
    const resolved = this.store.resolveTerminal({ completionFingerprint, taskId: task.taskId, action: parsed.proposal.action, accepted: validation.valid, reason: validation.reason,
      ...(correctionId ? { correction: { effectId: correctionId, prompt: renderSupervisorPrompt(task, correctionId, 'correction', parsed.proposal.reason === 'compact_receipt' ? undefined : parsed.proposal.checkpoint, validation.reason, settlement.continuationContext) } } : {}) });
    return { action: parsed.proposal.action, completionFingerprint, terminal: validation.valid, ...(resolved.successorEffect ? { successorEffect: resolved.successorEffect } : {}), validation, deduplicated: committed.deduplicated || resolved.deduplicated };
  }

  private browserTaskActive(task: WorkflowSupervisorTask): boolean { return this.hooks.browserTaskActive?.(task) ?? true; }
  private browserTaskActiveForExternalEffect(task: WorkflowSupervisorTask): boolean {
    return this.store.hasAppliedEffectAwaitingCompletion(task.taskId) || this.browserTaskActive(task);
  }

  private browserSnapshotMatchesSource(task: WorkflowSupervisorTask, effect: WorkflowSupervisorEffect, snapshot: { latestUserText: string; latestAssistantResponse: string }): boolean {
    if (!effect.sourceCompletionFingerprint) return true;
    const completion = this.store.getCompletion(effect.sourceCompletionFingerprint);
    if (!completion || completion.taskId !== task.taskId || sha256(snapshot.latestAssistantResponse) !== completion.responseSha256) return false;
    const sourceEffect = this.store.getEffect(completion.sourceEffectId);
    return Boolean(sourceEffect
      && sourceEffect.taskId === task.taskId
      && (normalizeBrowserText(snapshot.latestUserText) === normalizeBrowserText(sourceEffect.prompt)
        || browserTextHasEffect(snapshot.latestUserText, sourceEffect.effectId)));
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
/**
 * A task that already reached DONE/NEEDS_USER can never deliver another effect.
 * Reserving into it reported `enrolled` and left the caller waiting for a turn
 * that the terminal action forbids.
 */
function requireNonTerminalTask(store: WorkflowSupervisorStore, taskId: string): void {
  const terminal = store.terminalAction(taskId);
  if (terminal) throw new Error(`WORKFLOW_SUPERVISOR_TASK_TERMINAL:${terminal}`);
}
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
