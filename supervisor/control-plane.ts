import { randomUUID } from 'node:crypto';
import { parseChatgptConversationIdentity } from './chatgpt-conversation';
import { parseSupervisorCompletion, renderEffectMarker, renderSupervisorPrompt, sha256, validateEffectId } from './protocol';
import { WorkflowSupervisorStore } from './store';
import type { WorkflowAssistantObservation, WorkflowAssistantObservationResult, WorkflowContractValidation, WorkflowSupervisorAutomationStatus, WorkflowSupervisorBrowserPollResult, WorkflowSupervisorBrowserTask, WorkflowSupervisorCompletion, WorkflowSupervisorDiscoveredConversation, WorkflowSupervisorEffect, WorkflowSupervisorLifecycleHooks, WorkflowSupervisorProjectScope, WorkflowSupervisorTask, WorkflowSupervisorTaskInput, WorkflowSupervisorTurnSettlement, WorkflowSupervisorValidators } from './types';

function compactProjectIdentity(value: string): string {
  return value.toLocaleLowerCase().replace(/[^a-z0-9]+/g, '');
}

function projectSlugFromUrl(value: string): string | undefined {
  try {
    const parsed = new URL(value);
    const match = /^\/g\/(g-p-[a-z0-9]+)(?:-([^/]+))?\/project\/?$/i.exec(parsed.pathname);
    return match?.[2] ? compactProjectIdentity(match[2]) : undefined;
  } catch {
    return undefined;
  }
}

function projectMatchesScope(conversation: WorkflowSupervisorDiscoveredConversation, scope: WorkflowSupervisorProjectScope): boolean {
  const names = [scope.title, ...(scope.aliases ?? [])]
    .map((value) => value.trim().toLocaleLowerCase())
    .filter(Boolean);
  if (conversation.projectTitle?.trim() && names.includes(conversation.projectTitle.trim().toLocaleLowerCase())) return true;
  const compactProjectTitle = conversation.projectTitle ? compactProjectIdentity(conversation.projectTitle) : '';
  if (compactProjectTitle && names.some((name) => compactProjectIdentity(name) === compactProjectTitle)) return true;
  const projectSlug = conversation.projectUrl ? projectSlugFromUrl(conversation.projectUrl) : undefined;
  if (!projectSlug) return false;
  return (scope.aliases ?? []).some((alias) => {
    const compact = compactProjectIdentity(alias);
    return compact.length >= 4 && compact === projectSlug;
  });
}

function effectId(): string { return `fx_${randomUUID().replaceAll('-', '')}`; }
function stableEffectId(originKey: string): string {
  return validateEffectId(`fx_${sha256(originKey).slice(0, 32)}`);
}
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
    const originKey = `enrollment:${taskId}`;
    // Supervisor owns the outer-turn effect identity. A lower ControllerRound may
    // rotate when the semantic Work carrier changes, but the Requirement + exact
    // conversation task must keep one enrollment effect. Reuse by origin before
    // considering a newer lower-layer canonical effect id.
    const existingForOrigin = this.store.getEffectByOriginKey(originKey);
    let effect: WorkflowSupervisorEffect;
    if (existingForOrigin) {
      if (existingForOrigin.taskId !== taskId) throw new Error(`WORKFLOW_SUPERVISOR_EFFECT_TASK_CONFLICT:${originKey}`);
      if (existingForOrigin.kind !== 'enrollment') throw new Error(`WORKFLOW_SUPERVISOR_EFFECT_KIND_CONFLICT:${originKey}`);
      effect = existingForOrigin;
    } else {
      const id = canonicalEffectId ? validateEffectId(canonicalEffectId) : stableEffectId(originKey);
      const existing = this.store.getEffect(id);
      if (existing) {
        if (existing.taskId !== taskId) throw new Error(`WORKFLOW_SUPERVISOR_EFFECT_TASK_CONFLICT:${originKey}`);
        if (existing.kind !== 'enrollment') throw new Error(`WORKFLOW_SUPERVISOR_EFFECT_KIND_CONFLICT:${originKey}`);
        effect = existing;
      } else {
        effect = this.store.reserveEffect({ taskId, effectId: id, kind: 'enrollment', originKey, prompt: renderSupervisorPrompt(task, id, 'enrollment') });
      }
    }
    const inheritedDispatch = this.hooks.inheritedEffectDispatch?.(task, effect);
    if (inheritedDispatch && !this.store.effectApplied(effect.effectId)) {
      this.store.recordEffectDispatchStarted(
        effect.effectId,
        inheritedDispatch.generation,
        inheritedDispatch.dispatchId,
        inheritedDispatch.evidence,
      );
    }
    return effect;
  }
  observeEffect(input: { effectId: string; observationId: string; outcome: 'applied' | 'not_applied' | 'unknown'; evidence?: Record<string, unknown> }): void {
    this.store.recordEffectObservation(validateEffectId(input.effectId), input.observationId, input.outcome, input.evidence);
  }
  getTask(taskId: string): WorkflowSupervisorTask | undefined { return this.store.getTask(taskId); }
  listTasks(activeOnly = false): WorkflowSupervisorTask[] {
    const tasks = this.store.listTasks();
    return activeOnly ? tasks.filter((task) => !this.store.terminalAction(task.taskId)) : tasks;
  }
  stopTask(taskId: string, reason = 'Stopped by operator request.'): { taskId: string; terminal: 'STOPPED'; deduplicated: boolean } {
    return this.store.stopTask(taskId, reason);
  }
  bindBootstrapConversation(input: { taskId: string; conversationId: string; conversationUrl: string }): WorkflowSupervisorTask {
    const identity = parseChatgptConversationIdentity(input.conversationUrl);
    if (identity.conversationId !== input.conversationId) throw new Error('WORKFLOW_SUPERVISOR_BOOTSTRAP_CONVERSATION_MISMATCH');
    const task = this.store.bindBootstrapConversation(input.taskId, identity.conversationId, identity.canonicalUrl);
    this.hooks.bootstrapConversationBound?.(task);
    return task;
  }
  getEffect(id: string): WorkflowSupervisorEffect | undefined { return this.store.getEffect(validateEffectId(id)); }
  /** Mechanical provider re-dispatch budget for one effect, used by recovery to surface exhaustion. */
  effectDispatchBudget(effectId: string): ReturnType<WorkflowSupervisorStore['effectDispatchBudget']> {
    return this.store.effectDispatchBudget(validateEffectId(effectId));
  }
  continuationProof(input: { repoId?: string; activeReleaseId: string; notBefore: string }) { return this.store.continuationProof(input); }
  browserDiscoverySnapshot() { return this.store.discoverySnapshot(); }
  bootstrapProjectUrl(taskId: string): string {
    const task = this.requireTask(taskId);
    const scope = this.hooks.projectScopeForTask?.(task);
    const title = scope?.title.trim();
    if (!scope || !title) throw new Error('WORKFLOW_SUPERVISOR_BOOTSTRAP_PROJECT_SCOPE_REQUIRED');
    const projects = new Map<string, string>();
    for (const conversation of this.store.discoverySnapshot().conversations) {
      if (!projectMatchesScope(conversation, scope)) continue;
      const value = conversation.projectUrl?.trim();
      if (!value) continue;
      try {
        const parsed = new URL(value);
        if (parsed.protocol !== 'https:' || parsed.hostname !== 'chatgpt.com') continue;
        const match = /^\/g\/(g-p-[a-z0-9]+)(?:-[^/]+)?\/project\/?$/i.exec(parsed.pathname);
        if (!match) continue;
        const projectId = match[1]!.toLocaleLowerCase();
        projects.set(projectId, `https://chatgpt.com/g/${match[1]!}/project`);
      } catch {
        continue;
      }
    }
    if (projects.size === 0) throw new Error('WORKFLOW_SUPERVISOR_BOOTSTRAP_PROJECT_NOT_DISCOVERED');
    if (projects.size !== 1) throw new Error('WORKFLOW_SUPERVISOR_BOOTSTRAP_PROJECT_AMBIGUOUS');
    return [...projects.values()][0]!;
  }
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
        ...(scope.aliases?.length ? { aliases: [...new Set(scope.aliases.map((value) => value.trim().slice(0, 256)).filter(Boolean))].slice(0, 16) } : {}),
        ...(scope.repoId?.trim() ? { repoId: scope.repoId.trim().slice(0, 256) } : {}),
        ...(scope.controllerHome?.trim() ? { controllerHome: scope.controllerHome.trim().slice(0, 2048) } : {}),
      };
      const key = `${normalized.title.toLocaleLowerCase()}\n${normalized.repoId ?? ''}\n${normalized.controllerHome ?? ''}`;
      scopes.set(key, normalized);
    }
    return [...scopes.values()];
  }
  browserTasks(): WorkflowSupervisorBrowserTask[] {
    const active = this.store.listTasks().flatMap((task) => {
      if (this.store.terminalAction(task.taskId)) return [];
      // A Computer page is an ephemeral delivery surface. An applied effect
      // awaiting its receipt remains eligible for read-only provider-health
      // observation, so a terminal stream error can reserve its one bounded
      // recovery effect. Rendered assistant text never decides the workflow;
      // only a persisted receipt does that.
      const pending = this.store.nextBrowserEffect(task.taskId);
      const providerTurnAwaitingReceipt = Boolean(this.store.latestAppliedEffectWithoutCompletion(task.taskId));
      if (!pending && !providerTurnAwaitingReceipt) return [];
      // Bootstrap has no exact conversation yet, so it cannot satisfy the
      // normal Work-boundary predicate. Its already-persisted enrollment effect
      // is the narrow authority to acquire one through Computer exactly once.
      if (!task.conversationId.startsWith('bootstrap:')) {
        // Optional lower-layer Work/Requirement compatibility must be task-local.
        // A stale legacy task is allowed to fail closed, but it must never poison
        // the global Supervisor delivery queue and block standalone tasks.
        try { if (!this.browserTaskActive(task)) return []; }
        catch { return []; }
      }
      return [{ task, mode: pending?.mode ?? 'reconcile' }];
    });
    // Fresh effects are bounded work with no prior external mutation. Outcome-
    // unknown reconciliation remains durable and exactly-once, but cannot be
    // allowed to monopolize the single native browser lane indefinitely.
    active.sort((left, right) => {
      const leftPriority = left.mode === 'send' ? 0 : 1;
      const rightPriority = right.mode === 'send' ? 0 : 1;
      return leftPriority - rightPriority;
    });
    return active.map(({ task }) => browserTask(task));
  }
  browserPoll(input: { conversationId: string; conversationUrl: string }): WorkflowSupervisorBrowserPollResult {
    const task = this.requireBrowserTask(input.conversationId, input.conversationUrl);
    const projection = browserTask(task);
    const terminal = this.store.terminalAction(task.taskId);
    // STOPPED is an operator terminal, not a semantic completion. Return it
    // before the normal external-effect activity gate so an already-running
    // browser poll observes the stop and cannot turn it into another command.
    if (terminal === 'STOPPED') return { authorized: true, task: projection, terminal };
    if (!this.browserTaskActiveForExternalEffect(task)) throw new Error('WORKFLOW_SUPERVISOR_BROWSER_TASK_INACTIVE');
    if (terminal) return { authorized: true, task: projection, terminal };
    const pending = this.store.nextBrowserEffect(task.taskId);
    if (!pending) return { authorized: true, task: projection };
    return { authorized: true, task: projection, command: { mode: pending.mode, effectId: pending.effect.effectId, kind: pending.effect.kind, prompt: pending.effect.prompt, dispatchGeneration: pending.generation, conversationId: task.conversationId, conversationUrl: task.conversationUrl } };
  }
  bootstrapPoll(taskId: string): WorkflowSupervisorBrowserPollResult {
    const task = this.requireTask(taskId);
    if (!task.conversationId.startsWith('bootstrap:')) throw new Error('WORKFLOW_SUPERVISOR_BOOTSTRAP_NOT_PENDING');
    const terminal = this.store.terminalAction(task.taskId);
    if (terminal === 'STOPPED') return { authorized: true, task: browserTask(task), terminal };
    const pending = this.store.nextBrowserEffect(task.taskId);
    if (pending) {
      return {
        authorized: true,
        task: browserTask(task),
        command: {
          mode: pending.mode,
          effectId: pending.effect.effectId,
          kind: pending.effect.kind,
          prompt: pending.effect.prompt,
          dispatchGeneration: pending.generation,
          conversationId: task.conversationId,
          conversationUrl: task.conversationUrl,
        },
      };
    }
    // Provider application and bootstrap identity binding are separate facts.
    // A confirmed send may already be applied while ChatGPT has only just
    // canonicalized the new /c/<conversation> route. Keep one read-only
    // reconciliation command for that applied effect so the exact conversation
    // can be bound without manufacturing another provider generation.
    const applied = this.store.latestAppliedEffectWithoutCompletion(task.taskId);
    if (!applied) return { authorized: true, task: browserTask(task) };
    const dispatch = this.store.latestEffectDispatch(applied.effectId);
    return {
      authorized: true,
      task: browserTask(task),
      command: {
        mode: 'reconcile',
        effectId: applied.effectId,
        kind: applied.kind,
        prompt: applied.prompt,
        dispatchGeneration: dispatch?.generation ?? 1,
        conversationId: task.conversationId,
        conversationUrl: task.conversationUrl,
      },
    };
  }
  bootstrapBeginEffect(input: { taskId: string; effectId: string; dispatchId: string; dispatchGeneration: number }): boolean {
    const task = this.requireTask(input.taskId);
    if (!task.conversationId.startsWith('bootstrap:')) throw new Error('WORKFLOW_SUPERVISOR_BOOTSTRAP_NOT_PENDING');
    const pending = this.store.nextBrowserEffect(task.taskId);
    if (!pending || pending.effect.effectId !== validateEffectId(input.effectId) || pending.mode !== 'send') return false;
    return this.store.recordEffectDispatchStarted(input.effectId, input.dispatchGeneration, input.dispatchId, {
      surface: 'computer-bootstrap',
      ...(this.hooks.effectDispatchEvidence?.() ?? {}),
    });
  }
  bootstrapObserveEffect(input: { taskId: string; effectId: string; observationId: string; outcome: 'applied' | 'not_applied' | 'unknown'; evidence?: Record<string, unknown> }): void {
    const task = this.requireTask(input.taskId);
    const effect = this.store.getEffect(validateEffectId(input.effectId));
    if (!effect || effect.taskId !== task.taskId) throw new Error('WORKFLOW_SUPERVISOR_BOOTSTRAP_EFFECT_TASK_MISMATCH');
    if (input.outcome === 'not_applied') {
      // This path is private to the native bootstrap adapter after its exact-tab
      // dispatch function returned without clicking Send. It is therefore a
      // mechanical negative proof, unlike a missing post-send conversation
      // marker, which remains outcome-unknown and must reconcile.
      const pending = this.store.nextBrowserEffect(task.taskId);
      const dispatch = this.store.latestEffectDispatch(effect.effectId);
      if (!pending || pending.effect.effectId !== effect.effectId || pending.mode !== 'reconcile'
        || !dispatch || pending.generation !== dispatch.generation) {
        throw new Error('WORKFLOW_SUPERVISOR_BOOTSTRAP_NOT_APPLIED_PROOF_INVALID');
      }
      this.store.recordEffectNotAppliedProof(effect.effectId, input.observationId, {
        surface: 'computer-bootstrap',
        dispatch_generation: dispatch.generation,
        pre_send_rejection: true,
      });
      return;
    }
    const evidence = { surface: 'computer-bootstrap', ...(input.evidence ?? {}) };
    this.observeEffect({ effectId: effect.effectId, observationId: input.observationId, outcome: input.outcome, evidence });
    if (input.outcome === 'applied') this.hooks.effectApplied?.(task, effect, { observationId: input.observationId, evidence });
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
      ...(this.hooks.effectDispatchEvidence?.() ?? {}),
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
    const current = this.store.currentUnappliedEffect(task.taskId);
    const dispatch = this.store.latestEffectDispatch(effect.effectId);
    const snapshot = browserSnapshot(input.evidence);
    const sourceMatches = snapshot ? this.browserSnapshotMatchesSource(task, effect, snapshot) : false;
    const preservedBaseline = Boolean(snapshot && dispatch
      && browserTextSha256(snapshot.latestUserText) === dispatch.evidence.baseline_user_sha256
      && sha256(snapshot.latestAssistantResponse) === dispatch.evidence.baseline_assistant_sha256);
    const preservedHistoricalBaseline = Boolean(snapshot && dispatch
      && browserUserHistoryContainsBaseline(snapshot.userMessages, dispatch.evidence.baseline_user_sha256)
      && browserAssistantHistoryContainsBaseline(snapshot.assistantMessages, dispatch.evidence.baseline_assistant_sha256, dispatch.evidence.baseline_has_source_completion));
    const targetAbsent = Boolean(snapshot && !browserTextHasEffect(snapshot.latestUserText, effect.effectId));
    const causalBaselinePreserved = (sourceMatches && preservedBaseline) || preservedHistoricalBaseline;
    if (!current || current.effectId !== effect.effectId || !dispatch || !snapshot || !causalBaselinePreserved || !targetAbsent || !browserNotAppliedSurfaceProven(input.evidence)) {
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
    const recoveryId = stableEffectId(`provider-recovery:${sourceEffect.effectId}`);
    const providerFailureCode = input.providerFailureCode?.trim();
    const recoveryReason = providerFailureCode
      ? `Applied Supervisor effect ${sourceEffect.effectId} ended with provider failure ${providerFailureCode} before a committed Supervisor completion. Resume from durable Forge state; the source effect remains applied and must not be replayed.`
      : `Applied Supervisor effect ${sourceEffect.effectId} stopped making observable provider progress without a committed Supervisor completion. Resume from durable Forge state; the source effect remains applied and must not be replayed.`;
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

  /**
   * Prove that a non-empty composer contains only the exact completed causal
   * predecessor prompt for the current effect. This is intentionally much
   * narrower than "looks like a Forge prompt": arbitrary drafts, another task's
   * prompt, an incomplete effect, or a modified stale prompt are never clearable.
   */
  browserStaleComposerPayload(input: {
    conversationId: string;
    conversationUrl: string;
    currentEffectId: string;
    composerText: string;
  }): { stale: false } | { stale: true; effectId: string; prompt: string } {
    const task = this.requireBrowserTask(input.conversationId, input.conversationUrl);
    const currentEffect = this.store.getEffect(validateEffectId(input.currentEffectId));
    if (!currentEffect || currentEffect.taskId !== task.taskId || !currentEffect.sourceCompletionFingerprint) return { stale: false };
    const sourceCompletion = this.store.getCompletion(currentEffect.sourceCompletionFingerprint);
    if (!sourceCompletion || sourceCompletion.taskId !== task.taskId || sourceCompletion.sourceEffectId === currentEffect.effectId) return { stale: false };
    const predecessor = this.store.getEffect(sourceCompletion.sourceEffectId);
    if (!predecessor || predecessor.taskId !== task.taskId || !this.store.effectApplied(predecessor.effectId)) return { stale: false };
    const durableCompletion = this.store.getCompletionBySourceEffectId(task.taskId, predecessor.effectId);
    if (!durableCompletion || durableCompletion.completionFingerprint !== sourceCompletion.completionFingerprint) return { stale: false };
    if (normalizeBrowserText(input.composerText) !== normalizeBrowserText(predecessor.prompt)) return { stale: false };
    return { stale: true, effectId: predecessor.effectId, prompt: predecessor.prompt };
  }

  /**
   * Repair the crash boundary where a CONTINUE completion was durably committed
   * before lower-layer settlement and successor reservation finished. This never
   * replays the provider response; it only settles existing durable evidence and
   * reserves the exactly-once successor effect.
   */
  async reconcileCommittedContinuations(limit = 16): Promise<{ scanned: number; reconciled: number }> {
    const completions = this.store.listContinueCompletionsAwaitingSuccessor(limit);
    let reconciled = 0;
    for (const completion of completions) {
      const task = this.store.getTask(completion.taskId);
      if (!task || this.store.terminalAction(task.taskId)) continue;
      let settlement: WorkflowSupervisorTurnSettlement;
      try {
        settlement = await this.hooks.assistantTurnCommitted?.(task, completion)
          ?? { continuationAllowed: true };
      } catch {
        // Lower-layer compatibility reconciliation is scoped to this task. A
        // stale Work/ControllerRound must not stop successor recovery for other
        // independent Supervisor tasks.
        continue;
      }
      if (!settlement.continuationAllowed) continue;
      const successorOriginKey = `completion:${completion.completionFingerprint}`;
      const nextId = settlement.continuationEffectId
        ? validateEffectId(settlement.continuationEffectId)
        : stableEffectId(successorOriginKey);
      const checkpoint = completion.proposal.reason === 'compact_receipt' ? undefined : completion.proposal.checkpoint;
      const prompt = renderSupervisorPrompt(task, nextId, 'continuation', checkpoint, undefined, settlement.continuationContext);
      const committed = this.store.commitCompletion(completion, { effectId: nextId, kind: 'continuation', prompt });
      if (committed.successorEffect) reconciled += 1;
    }
    return { scanned: completions.length, reconciled };
  }

  async observeAssistantTurn(input: WorkflowAssistantObservation): Promise<WorkflowAssistantObservationResult> {
    const task = this.requireTask(input.taskId);
    if (task.conversationId !== input.conversationId) throw new Error('WORKFLOW_SUPERVISOR_CONVERSATION_MISMATCH');
    const responseSha256 = sha256(input.responseText);
    const expectedEffect = this.store.latestAppliedEffectWithoutCompletion(task.taskId)
      ?? this.store.latestAppliedLeafEffectWithoutCompletion(task.taskId);
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
      const successorOriginKey = `completion:${completionFingerprint}`;
      const nextId = settlement.continuationEffectId
        ? validateEffectId(settlement.continuationEffectId)
        : stableEffectId(successorOriginKey);
      const checkpoint = parsed.proposal.reason === 'compact_receipt' ? undefined : parsed.proposal.checkpoint;
      const prompt = renderSupervisorPrompt(task, nextId, 'continuation', checkpoint, undefined, settlement.continuationContext);
      const withSuccessor = this.store.commitCompletion(completion, { effectId: nextId, kind: 'continuation', prompt });
      return { action: 'CONTINUE', completionFingerprint, terminal: false, successorEffect: withSuccessor.successorEffect!, deduplicated: committed.deduplicated || withSuccessor.deduplicated };
    }

    const validator = parsed.proposal.action === 'DONE' ? this.validators.completionContract : this.validators.userBlockerPolicy;
    const validation = await validator(task, parsed.proposal);
    const correctionId = validation.valid ? undefined : stableEffectId(`completion:${completionFingerprint}`);
    const resolved = this.store.resolveTerminal({ completionFingerprint, taskId: task.taskId, action: parsed.proposal.action, accepted: validation.valid, reason: validation.reason,
      ...(correctionId ? { correction: { effectId: correctionId, prompt: renderSupervisorPrompt(task, correctionId, 'correction', parsed.proposal.reason === 'compact_receipt' ? undefined : parsed.proposal.checkpoint, validation.reason, settlement.continuationContext) } } : {}) });
    return { action: parsed.proposal.action, completionFingerprint, terminal: validation.valid, ...(resolved.successorEffect ? { successorEffect: resolved.successorEffect } : {}), validation, deduplicated: committed.deduplicated || resolved.deduplicated };
  }

  /**
   * The autonomous transport records its final state through the Forge tool
   * call, not through text rendered in the ChatGPT page.  The exact task and
   * applied effect are derived locally; callers cannot select a different
   * conversation or effect by supplying model-authored identifiers.
   */
  async observeAutomationReceipt(input: {
    taskId: string;
    conversationId: string;
    status: WorkflowSupervisorAutomationStatus;
    receiptId: string;
  }): Promise<WorkflowAssistantObservationResult | { recorded: true }> {
    if (input.status === 'working') return { recorded: true };
    const task = this.requireTask(input.taskId);
    if (task.conversationId !== input.conversationId) throw new Error('WORKFLOW_SUPERVISOR_CONVERSATION_MISMATCH');
    const terminal = this.store.terminalAction(task.taskId);
    if (terminal) throw new Error(`WORKFLOW_SUPERVISOR_TASK_TERMINAL:${terminal}`);
    const expectedEffect = this.store.latestAppliedEffectWithoutCompletion(task.taskId)
      ?? this.store.latestAppliedLeafEffectWithoutCompletion(task.taskId);
    // A provider can reuse one tool name/status in successive outer turns.
    // Include the locally selected effect in the durable receipt identity so a
    // later `continue` cannot replay the first effect's completion.
    const replayCompletion = expectedEffect ? undefined : this.store.getLatestCompletion(task.taskId);
    if (!expectedEffect && (!replayCompletion
      || replayCompletion.proposal.checkpoint !== `automation:${input.receiptId}:${replayCompletion.sourceEffectId}`)) {
      throw new Error('WORKFLOW_SUPERVISOR_CAUSAL_EFFECT_NOT_APPLIED');
    }
    const receiptForEffect = `${input.receiptId}:${expectedEffect?.effectId ?? replayCompletion!.sourceEffectId}`;
    const responseText = `automation:${input.status}:${receiptForEffect}`;
    const responseSha256 = sha256(responseText);
    const priorCompletion = expectedEffect ? undefined : this.store.getCompletionByResponseSha256(task.taskId, responseSha256);
    const sourceEffect = expectedEffect ?? (priorCompletion ? this.store.getEffect(priorCompletion.sourceEffectId) : undefined);
    if (!sourceEffect || sourceEffect.taskId !== task.taskId || !this.store.effectApplied(sourceEffect.effectId)) {
      throw new Error('WORKFLOW_SUPERVISOR_CAUSAL_EFFECT_NOT_APPLIED');
    }
    const action = input.status === 'continue' ? 'CONTINUE' : input.status === 'done' ? 'DONE' : 'NEEDS_USER';
    const proposal = {
      action: action as 'CONTINUE' | 'DONE' | 'NEEDS_USER',
      sourceEffectId: sourceEffect.effectId,
      checkpoint: `automation:${receiptForEffect}`,
      reason: 'automation_tool_receipt',
      evidence: [],
      conversationId: task.conversationId,
      taskId: task.taskId,
      supervisorState: action === 'CONTINUE' ? 'running' as const : action === 'DONE' ? 'done' as const : 'needs_user' as const,
    };
    const controlBlockSha256 = sha256(responseText);
    const completionFingerprint = sha256(jsonIdentity(task.taskId, task.conversationId, sourceEffect.effectId, responseSha256, controlBlockSha256));
    const completion: WorkflowSupervisorCompletion = { completionFingerprint, taskId: task.taskId, sourceEffectId: sourceEffect.effectId, action: proposal.action, responseSha256, controlBlockSha256, proposal, committedAt: new Date().toISOString() };
    const committed = this.store.commitCompletion(completion);
    const settlement: WorkflowSupervisorTurnSettlement = await this.hooks.assistantTurnCommitted?.(task, completion) ?? { continuationAllowed: true };
    if (proposal.action === 'CONTINUE') {
      if (!settlement.continuationAllowed) throw new Error(`WORKFLOW_SUPERVISOR_LOWER_LAYER_CONTINUATION_BLOCKED:${settlement.reason ?? 'unspecified'}`);
      const nextId = settlement.continuationEffectId
        ? validateEffectId(settlement.continuationEffectId)
        : stableEffectId(`completion:${completionFingerprint}`);
      const withSuccessor = this.store.commitCompletion(completion, {
        effectId: nextId,
        kind: 'continuation',
        prompt: renderSupervisorPrompt(task, nextId, 'continuation', proposal.checkpoint, undefined, settlement.continuationContext),
      });
      return { action: 'CONTINUE', completionFingerprint, terminal: false, successorEffect: withSuccessor.successorEffect!, deduplicated: committed.deduplicated || withSuccessor.deduplicated };
    }
    const validation = proposal.action === 'DONE'
      ? await this.validators.completionContract(task, proposal)
      : await this.validators.userBlockerPolicy(task, proposal);
    const correctionId = validation.valid ? undefined : stableEffectId(`completion:${completionFingerprint}`);
    const resolved = this.store.resolveTerminal({
      completionFingerprint, taskId: task.taskId, action: proposal.action, accepted: validation.valid, reason: validation.reason,
      ...(correctionId ? { correction: { effectId: correctionId, prompt: renderSupervisorPrompt(task, correctionId, 'correction', proposal.checkpoint, validation.reason, settlement.continuationContext) } } : {}),
    });
    return { action: proposal.action, completionFingerprint, terminal: validation.valid, ...(resolved.successorEffect ? { successorEffect: resolved.successorEffect } : {}), validation, deduplicated: committed.deduplicated || resolved.deduplicated };
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
    // Project routing is presentation metadata. A ChatGPT conversation can move
    // between `/c/<id>` and a Project-prefixed route without becoming a different
    // provider conversation, so the durable id is the only identity fence here.
    if (task.conversationId !== conversationId || registered.conversationId !== conversationId || observed.conversationId !== conversationId) throw new Error('WORKFLOW_SUPERVISOR_BROWSER_CONVERSATION_MISMATCH');
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
function boundedBrowserTextArray(value: unknown, maxBytes: number): string[] | undefined {
  if (!Array.isArray(value) || value.length > 2048) return undefined;
  const items: string[] = [];
  let bytes = 0;
  for (const item of value) {
    if (typeof item !== 'string') return undefined;
    bytes += Buffer.byteLength(item, 'utf8');
    if (bytes > maxBytes) return undefined;
    items.push(item);
  }
  return items;
}
function browserSnapshot(evidence: Record<string, unknown> | undefined): { latestUserText: string; latestAssistantResponse: string; userMessages?: string[]; assistantMessages?: string[] } | undefined {
  const latestUserText = boundedBrowserText(evidence?.latest_user_text, 128 * 1024);
  const latestAssistantResponse = boundedBrowserText(evidence?.latest_assistant_response, 512 * 1024);
  if (latestUserText === undefined || latestAssistantResponse === undefined) return undefined;
  const userMessages = boundedBrowserTextArray(evidence?.user_messages, 128 * 1024);
  const assistantMessages = boundedBrowserTextArray(evidence?.assistant_messages, 512 * 1024);
  return { latestUserText, latestAssistantResponse, ...(userMessages ? { userMessages } : {}), ...(assistantMessages ? { assistantMessages } : {}) };
}
function normalizeBrowserText(value: string): string { return value.replace(/\s+/g, ' ').trim(); }
function browserTextSha256(value: string): string { return sha256(normalizeBrowserText(value)); }
function browserUserHistoryContainsBaseline(messages: readonly string[] | undefined, baselineSha256: unknown): boolean {
  if (!messages || typeof baselineSha256 !== 'string' || !baselineSha256) return false;
  if (browserTextSha256('') === baselineSha256) return true;
  const prefix: string[] = [];
  for (const message of messages) {
    prefix.push(message);
    if (browserTextSha256(prefix.join('\n')) === baselineSha256) return true;
  }
  return false;
}
function browserAssistantHistoryContainsBaseline(messages: readonly string[] | undefined, baselineSha256: unknown, hasSourceCompletion: unknown): boolean {
  if (hasSourceCompletion !== true) return true;
  return Boolean(messages && typeof baselineSha256 === 'string' && baselineSha256
    && messages.some((message) => sha256(message) === baselineSha256));
}
function browserTextHasEffect(value: string, effectId: string): boolean { return value.includes(renderEffectMarker(effectId)); }
/**
 * Reasons that prove a live ChatGPT conversation surface was actually rendered
 * and its composer was readable and empty at observation time.
 */
const BROWSER_NOT_APPLIED_SURFACE_REASONS = new Set([
  'composer_proven_empty',
  'stale_completed_supervisor_composer_cleared',
]);
/**
 * A negative proof claims "this exact send did not reach the conversation".
 * That is only observable on a rendered conversation surface. A missing or
 * still-loading page (no composer, no message history) cannot distinguish
 * "the send never applied" from "nothing has rendered yet", and treating it as
 * proof is what let one stuck effect authorise an unbounded resend chain.
 */
function browserNotAppliedSurfaceProven(evidence: Record<string, unknown> | undefined): boolean {
  if (!evidence || evidence.provider_surface_rendered !== true) return false;
  return typeof evidence.reason === 'string' && BROWSER_NOT_APPLIED_SURFACE_REASONS.has(evidence.reason);
}
const PERSISTED_BROWSER_EVIDENCE_KEYS = new Set(['exact_user_message', 'observation_fingerprint', 'reconciliation', 'reason', 'surface', 'target_marker_present']);
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
