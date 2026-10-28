import { randomUUID } from 'node:crypto';
import { parseChatgptConversationIdentity } from './chatgpt-conversation';
import { parseSupervisorCompletion, renderEffectMarker, renderSupervisorPrompt, sha256, validateEffectId, validateSupervisorObjective } from './protocol';
import { WorkflowSupervisorStore } from './store';
import type { ComputerChatgptPrewriteNoMutationReceipt } from '../packages/plugin-runtime/computer/conversation-target';
import { getWorkContract } from '../packages/kernel/work/api/index';
import { readRequirement } from '../src/runtime/control-plane/persistence/requirement-store';
import { resolveWorkflowSupervisorForgeHome } from './paths';
import type { WorkflowAssistantObservation, WorkflowAssistantObservationResult, WorkflowContractValidation, WorkflowEffectKind, WorkflowSupervisorBrowserPollResult, WorkflowSupervisorBrowserTask, WorkflowSupervisorCompletion, WorkflowSupervisorDiscoveredConversation, WorkflowSupervisorEffect, WorkflowSupervisorLifecycleHooks, WorkflowSupervisorProjectScope, WorkflowSupervisorTask, WorkflowSupervisorTaskInput, WorkflowSupervisorTerminalState, WorkflowSupervisorValidators, WorkflowSupervisorPreflightComposerObservation, WorkflowSupervisorReviewNotice } from './types';

function compactProjectIdentity(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

function projectIdentityTokens(value: string): string[] {
  return value.normalize('NFKC').toLocaleLowerCase().split(/[^\p{L}\p{N}]+/gu).filter(Boolean);
}

function boundedProjectIdentityMatch(expected: string, observed: string): boolean {
  const compactExpected = compactProjectIdentity(expected);
  const compactObserved = compactProjectIdentity(observed);
  if (!compactExpected || !compactObserved) return false;
  if (compactExpected === compactObserved) return true;
  if (compactExpected.length < 4) return false;
  const expectedTokens = projectIdentityTokens(expected);
  const observedTokens = projectIdentityTokens(observed);
  if (expectedTokens.length === 0 || expectedTokens.length >= observedTokens.length) return false;
  return expectedTokens.every((token, index) => observedTokens[index] === token);
}

function projectSlugFromUrl(value: string): string | undefined {
  try {
    const parsed = new URL(value);
    const match = /^\/g\/(g-p-[a-z0-9]+)(?:-([^/]+))?\/project\/?$/i.exec(parsed.pathname);
    return match?.[2]?.toLocaleLowerCase();
  } catch {
    return undefined;
  }
}

function projectMatchesScope(conversation: WorkflowSupervisorDiscoveredConversation, scope: WorkflowSupervisorProjectScope): boolean {
  const names = [scope.title, ...(scope.aliases ?? [])]
    .map((value) => value.trim().toLocaleLowerCase())
    .filter(Boolean);
  const projectTitle = conversation.projectTitle?.trim().toLocaleLowerCase();
  if (projectTitle && names.some((name) => boundedProjectIdentityMatch(name, projectTitle))) return true;
  const projectSlug = conversation.projectUrl ? projectSlugFromUrl(conversation.projectUrl) : undefined;
  if (!projectSlug) return false;
  return names.some((name) => boundedProjectIdentityMatch(name, projectSlug));
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
  reviseTaskObjective(input: {
    taskId: string;
    objective: string;
    expectedObjectiveSha256: string;
    requestId: string;
    authorizedBy?: string;
    workId?: string;
    requirementId?: string;
    expectedCompletionContractSha256?: string;
  }): { task: WorkflowSupervisorTask; changed: boolean; deduplicated: boolean; objectiveSha256: string; completionContractSha256: string; semanticBindingChanged: boolean; refreshedEffect?: WorkflowSupervisorEffect } {
    const task = this.requireTask(input.taskId);
    requireNonTerminalTask(this.store, task.taskId);
    const objective = validateSupervisorObjective(input.objective);
    if (!/^[0-9a-f]{64}$/i.test(input.expectedObjectiveSha256)) throw new Error('WORKFLOW_SUPERVISOR_OBJECTIVE_REVISION_EXPECTED_SHA_INVALID');
    if (!input.requestId.trim()) throw new Error('WORKFLOW_SUPERVISOR_OBJECTIVE_REVISION_REQUEST_REQUIRED');
    const workId = input.workId?.trim() || undefined;
    const requirementId = input.requirementId?.trim() || undefined;
    if (workId && requirementId) throw new Error('WORKFLOW_SUPERVISOR_SEMANTIC_BINDING_TARGET_INVALID');
    if ((workId || requirementId) && !input.expectedCompletionContractSha256) {
      throw new Error('WORKFLOW_SUPERVISOR_COMPLETION_CONTRACT_REVISION_EXPECTED_SHA_REQUIRED');
    }
    if (!workId && !requirementId && input.expectedCompletionContractSha256) {
      throw new Error('WORKFLOW_SUPERVISOR_COMPLETION_CONTRACT_REVISION_TARGET_REQUIRED');
    }
    let semanticBinding: { workId?: string; requirementId?: string; expectedCompletionContractSha256: string } | undefined;
    if (workId || requirementId) {
      if (task.completionContract.kind !== 'model_semantic_completion') {
        throw new Error('WORKFLOW_SUPERVISOR_SEMANTIC_BINDING_REVISION_KIND_UNSUPPORTED');
      }
      const controllerHome = typeof task.completionContract.controller_home === 'string' ? task.completionContract.controller_home.trim() : '';
      const repoId = typeof task.completionContract.repo_id === 'string' ? task.completionContract.repo_id.trim() : '';
      if (!controllerHome || !repoId
        || resolveWorkflowSupervisorForgeHome(controllerHome) !== resolveWorkflowSupervisorForgeHome(this.store.forgeHome)) {
        throw new Error('WORKFLOW_SUPERVISOR_SEMANTIC_BINDING_CONTEXT_REQUIRED');
      }
      if (workId && !getWorkContract({ controllerHome, scopeKey: repoId }, workId)) {
        throw new Error('WORKFLOW_SUPERVISOR_SEMANTIC_BINDING_WORK_NOT_FOUND');
      }
      if (requirementId && !readRequirement({ controllerHome }, requirementId)?.value) {
        throw new Error('WORKFLOW_SUPERVISOR_SEMANTIC_BINDING_REQUIREMENT_NOT_FOUND');
      }
      semanticBinding = {
        ...(workId ? { workId } : {}),
        ...(requirementId ? { requirementId } : {}),
        expectedCompletionContractSha256: input.expectedCompletionContractSha256!,
      };
    }
    const pending = this.store.currentUnappliedEffect(task.taskId);
    let refreshEffect: { effectId: string; expectedPrompt: string; prompt: string } | undefined;
    if (pending && !this.store.latestEffectDispatch(pending.effectId)) {
      const source = pending.sourceCompletionFingerprint ? this.store.getCompletion(pending.sourceCompletionFingerprint) : undefined;
      const checkpoint = source?.proposal.checkpoint;
      refreshEffect = {
        effectId: pending.effectId,
        expectedPrompt: pending.prompt,
        prompt: this.renderPrompt({ ...task, objective }, pending.effectId, pending.kind, checkpoint),
      };
    }
    return this.store.reviseTaskObjective({
      taskId: task.taskId,
      objective,
      expectedObjectiveSha256: input.expectedObjectiveSha256.toLowerCase(),
      requestId: input.requestId.trim(),
      authorizedBy: input.authorizedBy?.trim() || 'operator',
      ...(semanticBinding ? { semanticBinding } : {}),
      ...(refreshEffect ? { refreshEffect } : {}),
    });
  }
  /**
   * Explicit operator recovery. It is deliberately evidence-classified rather
   * than a generic "try again": each class names the durable mechanical fact
   * that makes exactly one bounded next step safe, and none of them can replay
   * a submission whose outcome is unknown.
   *
   * - proven-un-applied effect at its retry ceiling -> refund the mechanical
   *   budget once and re-dispatch that same effect;
   * - unknown-outcome effect -> read-only reclassification only, unless the
   *   operator explicitly authorizes retiring it so a *fresh* turn can run;
   * - applied effect whose single provider resume is exhausted -> reserve one
   *   new, separately identified recovery turn on the same conversation.
   */
  recoverTask(input: {
    taskId: string;
    sourceEffectId?: string;
    requestId: string;
    reason: string;
    /** Explicit operator authority required to retire an outcome-unknown effect. */
    supersedeUnknown?: boolean;
    authorizedBy?: string;
  }): { recoveryEffect: WorkflowSupervisorEffect; action: 'retry_authorized' | 'recovery_reserved' | 'unknown_superseded' } {
    const task = this.requireTask(input.taskId);
    requireNonTerminalTask(this.store, task.taskId);
    if (!input.requestId.trim() || !input.reason.trim()) throw new Error('WORKFLOW_SUPERVISOR_RECOVERY_REASON_REQUIRED');
    const authorizedBy = input.authorizedBy?.trim() || 'operator';
    // Identity-stable replay first: an operator recovery already reserved for
    // this exact source effect is the durable answer, whether or not it has
    // since been dispatched.
    const legacyOrigin = input.sourceEffectId ? `provider-recovery:${input.sourceEffectId}` : undefined;
    const existingLegacy = legacyOrigin ? this.store.getEffectByOriginKey(legacyOrigin) : undefined;
    if (existingLegacy?.taskId === task.taskId) return { recoveryEffect: existingLegacy, action: 'recovery_reserved' };
    // The same explicit supersession decision is one durable fact; replaying it
    // returns its replacement instead of failing on the now-retired source.
    const supersedeOrigin = `operator-recovery:${input.sourceEffectId ?? ''}:${input.requestId}`;
    const existingSupersede = this.store.getEffectByOriginKey(supersedeOrigin);
    if (existingSupersede?.taskId === task.taskId) return { recoveryEffect: existingSupersede, action: 'unknown_superseded' };
    const pending = this.store.currentUnappliedEffect(task.taskId);
    if (input.sourceEffectId && pending && pending.effectId !== input.sourceEffectId) {
      throw new Error('WORKFLOW_SUPERVISOR_RECOVERY_SOURCE_CHANGED');
    }
    if (pending) {
      if (this.store.effectDispatchBudget(pending.effectId).generations === 0) {
        // Browser provider was repaired independently of Forge's source release.
        // The old enrollment text and effect identity remain authoritative;
        // rearm a single preparation without manufacturing a provider send.
        this.store.authorizeOperatorPreflightRetry({ effectId: pending.effectId, requestId: input.requestId,
          reason: input.reason, authorizedBy });
        return { recoveryEffect: pending, action: 'retry_authorized' };
      }
      // Read-only reclassification first: a dispatch-owner pre-send return is a
      // stronger fact than any operator decision and makes the effect retryable
      // through the normal mechanical path.
      if (this.store.reconcileNativePreSendFailure(pending.effectId, input.requestId)) {
        return { recoveryEffect: pending, action: 'retry_authorized' };
      }
      try {
        this.store.authorizeOperatorRetry({ effectId: pending.effectId, requestId: input.requestId, reason: input.reason, authorizedBy });
        return { recoveryEffect: pending, action: 'retry_authorized' };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message !== 'WORKFLOW_SUPERVISOR_RECOVERY_OUTCOME_UNKNOWN') throw error;
        if (input.supersedeUnknown !== true) throw error;
      }
      // The operator explicitly decided to stop waiting on an unknown
      // submission. Record that decision durably and reserve one *new* turn in
      // the same transaction; the unknown effect is never resent and never
      // silently discarded.
      const origin = `operator-recovery:${pending.effectId}:${input.requestId}`;
      const supersededId = stableEffectId(origin);
      const prompt = this.renderPrompt(task, supersededId, 'recovery', undefined,
        `The operator explicitly superseded outcome-unknown effect ${pending.effectId} (${input.requestId}): ${input.reason}. That effect is retired and must never be resent; read durable Forge state and continue this same task with one fresh turn.`);
      const superseded = this.store.supersedeUnknownEffect({
        effectId: pending.effectId, requestId: input.requestId, reason: input.reason, authorizedBy,
        replacement: { effectId: supersededId, prompt },
      });
      return { recoveryEffect: superseded.recoveryEffect, action: 'unknown_superseded' };
    }
    const source = this.store.latestAppliedLeafEffectWithoutCompletion(task.taskId);
    if (!source || (input.sourceEffectId && source.effectId !== input.sourceEffectId)) throw new Error('WORKFLOW_SUPERVISOR_RECOVERY_SOURCE_CHANGED');
    const origin = `provider-recovery:${source.effectId}`;
    const id = stableEffectId(origin);
    if (this.store.providerResumeExhausted(source.effectId)) {
      // The automatic resume ceiling is the exact mechanical fact that permits
      // a further operator turn; without it this path must not exist.
      const prompt = this.renderPrompt(task, id, 'recovery', undefined,
        `The operator explicitly requested recovery (${input.requestId}): ${input.reason}. The single bounded provider resume for applied effect ${source.effectId} is exhausted; the source effect remains applied and must not be replayed. Read durable Forge state and continue this same task.`);
      return { recoveryEffect: this.store.reserveOperatorProviderRecovery({
        taskId: task.taskId, sourceEffectId: source.effectId, requestId: input.requestId, reason: input.reason,
        authorizedBy, originKey: origin, effectId: id, prompt,
      }), action: 'recovery_reserved' };
    }
    const prompt = this.renderPrompt(task, id, 'recovery', undefined,
      `The user explicitly requested recovery (${input.requestId}): ${input.reason}. Preserve the prior applied effect and all completed source work; read durable state and continue this same task. This is one operator-authorized recovery, not a reset of automatic recovery or dispatch budgets.`);
    return { recoveryEffect: this.store.reserveOperatorRecovery({
      taskId: task.taskId, sourceEffectId: source.effectId, requestId: input.requestId, reason: input.reason, effectId: id, prompt,
    }), action: 'recovery_reserved' };
  }
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
        effect = this.store.reserveEffect({ taskId, effectId: id, kind: 'enrollment', originKey, prompt: this.renderPrompt(task, id, 'enrollment') });
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
  getTaskByConversationId(conversationId: string): { task: WorkflowSupervisorTask; terminal?: WorkflowSupervisorTerminalState } | undefined {
    const task = this.store.getTaskByConversationId(conversationId);
    if (!task) return undefined;
    const terminal = this.store.terminalAction(task.taskId);
    return { task, ...(terminal ? { terminal } : {}) };
  }
  listTasks(activeOnly = false): WorkflowSupervisorTask[] {
    const tasks = this.store.listTasks();
    return activeOnly ? tasks.filter((task) => !this.store.terminalAction(task.taskId)) : tasks;
  }
  /**
   * Completed/blocked/stopped history is a read-only projection of canonical
   * terminal events. It never archives the ChatGPT conversation or rewrites Work.
   */
  listTerminalTasks(): Array<{ task: WorkflowSupervisorTask; terminal: WorkflowSupervisorTerminalState }> {
    return this.store.listTasks().flatMap((task) => {
      const terminal = this.store.terminalAction(task.taskId);
      return terminal ? [{ task, terminal }] : [];
    });
  }
  /** Reconcile Work-owned task closure after a crash or a direct Work writer.
   * Independent Requirement and standalone Goals are intentionally excluded.
   */
  reconcileTerminalWorkBoundTasks(): string[] {
    if (!this.hooks.terminalWorkStopReasonForTask) return [];
    const stopped: string[] = [];
    for (const task of this.store.listTasks()) {
      if (this.store.terminalAction(task.taskId)) continue;
      const reason = this.hooks.terminalWorkStopReasonForTask(task);
      if (!reason) continue;
      const result = this.store.stopTask(task.taskId, reason);
      if (!result.deduplicated) stopped.push(task.taskId);
    }
    return stopped;
  }
  stopTask(taskId: string, reason = 'Stopped by operator request.'): { taskId: string; terminal: 'STOPPED'; deduplicated: boolean } {
    return this.store.stopTask(taskId, reason);
  }
  bindBootstrapConversation(input: { taskId: string; conversationId: string; conversationUrl: string }): WorkflowSupervisorTask {
    const identity = parseChatgptConversationIdentity(input.conversationUrl);
    if (identity.conversationId !== input.conversationId) throw new Error('WORKFLOW_SUPERVISOR_BOOTSTRAP_CONVERSATION_MISMATCH');
    const pendingMigration = this.store.freshConversationMigrationContext(input.taskId);
    const task = this.store.bindBootstrapConversation(input.taskId, identity.conversationId, identity.canonicalUrl);
    this.hooks.bootstrapConversationBound?.(task, pendingMigration ? {
      migratedFromConversationId: pendingMigration.fromConversationId,
      migrationRequestId: pendingMigration.requestId,
    } : undefined);
    return task;
  }
  getEffect(id: string): WorkflowSupervisorEffect | undefined { return this.store.getEffect(validateEffectId(id)); }
  preSendComposerObservation(effectId: string): WorkflowSupervisorPreflightComposerObservation | undefined {
    return this.store.preSendComposerObservation(validateEffectId(effectId));
  }
  /** Bind the one canonical Scheduler occurrence lane to an exact Work-owned Supervisor task. */
  bindScheduledWake(input: { taskId: string; repoId: string; workId: string; scheduleId: string }) {
    const task = this.requireTask(input.taskId);
    requireNonTerminalTask(this.store, task.taskId);
    const bound = this.store.bindScheduledWake(input);
    const pending = this.store.currentUnappliedEffect(task.taskId);
    if (pending && !this.store.latestEffectDispatch(pending.effectId) && !this.store.effectApplied(pending.effectId)) {
      const source = pending.sourceCompletionFingerprint ? this.store.getCompletion(pending.sourceCompletionFingerprint) : undefined;
      const checkpoint = source?.proposal.checkpoint;
      this.store.refreshUndispatchedEffectPrompt({
        taskId: task.taskId,
        effectId: pending.effectId,
        expectedPrompt: pending.prompt,
        prompt: this.renderPrompt(bound.task, pending.effectId, pending.kind, checkpoint),
      });
    }
    return bound;
  }
  /** Consume a completed WAIT receipt exactly once for one exact Scheduler occurrence. */
  wakeScheduledTask(input: { taskId: string; scheduleId: string; occurrenceId: string }): { effect: WorkflowSupervisorEffect; deduplicated: boolean } {
    const task = this.requireTask(input.taskId);
    if (task.continuationPolicy.scheduled_wake_schedule_id !== input.scheduleId) {
      throw new Error('WORKFLOW_SUPERVISOR_SCHEDULE_BINDING_MISMATCH');
    }
    const originKey = `scheduled-wake:${input.scheduleId}:${input.occurrenceId}`;
    const id = stableEffectId(originKey);
    const prior = this.store.getEffectByOriginKey(originKey);
    if (prior) {
      if (prior.taskId !== task.taskId || prior.effectId !== id || prior.kind !== 'continuation' || !prior.sourceCompletionFingerprint) {
        throw new Error('WORKFLOW_SUPERVISOR_SCHEDULED_WAKE_IDENTITY_CONFLICT');
      }
      return { effect: prior, deduplicated: true };
    }
    requireNonTerminalTask(this.store, task.taskId);
    return this.store.reserveScheduledWake({
      taskId: task.taskId,
      scheduleId: input.scheduleId,
      occurrenceId: input.occurrenceId,
      effectId: id,
      prompt: this.renderPrompt(task, id, 'continuation', `scheduled wake ${input.scheduleId} occurrence ${input.occurrenceId}`),
    });
  }
  /**
   * Notify this already-owned Supervisor of an external reviewer/CI change.
   * A notice is not a verified review verdict, CI gate or merge authorization;
   * the model must re-read the platform and current PR HEAD before deciding.
   */
  bindReviewWatch(input: { taskId: string; repoId: string; githubRepository: string; prNumber: number }): { deduplicated: boolean } {
    const task = this.requireTask(input.taskId);
    if (task.completionContract.repo_id !== input.repoId) throw new Error('WORKFLOW_SUPERVISOR_REVIEW_REPOSITORY_MISMATCH');
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(input.githubRepository)) throw new Error('WORKFLOW_SUPERVISOR_GITHUB_REPOSITORY_INVALID');
    if (!Number.isInteger(input.prNumber) || input.prNumber < 1 || input.prNumber > 1_000_000) throw new Error('WORKFLOW_SUPERVISOR_REVIEW_PR_INVALID');
    return this.store.bindReviewWatch(input);
  }

  observeReviewNotice(notice: WorkflowSupervisorReviewNotice): { eventKey: string; deduplicated: boolean; deferred: boolean } {
    const task = this.requireTask(notice.taskId);
    if (task.completionContract.repo_id !== notice.repoId) throw new Error('WORKFLOW_SUPERVISOR_REVIEW_REPOSITORY_MISMATCH');
    if (!Number.isInteger(notice.prNumber) || notice.prNumber < 1 || notice.prNumber > 1_000_000) throw new Error('WORKFLOW_SUPERVISOR_REVIEW_PR_INVALID');
    if (!/^[0-9a-f]{40}$/i.test(notice.reviewedHeadSha) || !/^[0-9a-f]{40}$/i.test(notice.currentHeadSha)) throw new Error('WORKFLOW_SUPERVISOR_REVIEW_HEAD_INVALID');
    // A stale review may be the very REVISE finding the original Writer must
    // see. Deliver as explicitly unverified context; never as merge approval.
    if (!/^[a-zA-Z0-9_.:-]{1,128}$/.test(notice.reviewId)) throw new Error('WORKFLOW_SUPERVISOR_REVIEW_ID_INVALID');
    if (!['github_review','github_ci','independent_reviewer'].includes(notice.source)
      || !['ACCEPT','REVISE','BLOCK','CI_FAILED','CI_PASSED'].includes(notice.outcome)) throw new Error('WORKFLOW_SUPERVISOR_REVIEW_OUTCOME_INVALID');
    if ((notice.source === 'github_ci') !== notice.outcome.startsWith('CI_')) throw new Error('WORKFLOW_SUPERVISOR_REVIEW_SOURCE_MISMATCH');
    const normalized: WorkflowSupervisorReviewNotice = {
      ...notice, reviewedHeadSha: notice.reviewedHeadSha.toLowerCase(), currentHeadSha: notice.currentHeadSha.toLowerCase(),
    };
    const recorded = this.store.recordReviewNotice(normalized);
    // The original task already owns CONTINUE reservation. Do not synthesize a
    // competing effect or bypass Scheduler-only WAIT eligibility.
    return { ...recorded, deferred: true };
  }

  /** Read-only stall classification for one task; no lifecycle authority. */
  taskStall(taskId: string): ReturnType<WorkflowSupervisorStore['taskStall']> { return this.store.taskStall(this.requireTask(taskId).taskId); }
  /**
   * Explicit operator move of one task's exact conversation. Chatting in a new
   * conversation is never an automatic answer to provider backpressure: a 429 is
   * answered by fewer requests, and only a conversation that is durably unusable
   * is replaced. Requires the caller's expected current conversation so a stale
   * decision cannot silently move a task that already advanced.
   */
  migrateConversation(input: { taskId: string; expectedConversationId: string; conversationId?: string; conversationUrl?: string; fresh?: boolean; requestId: string; reason: string; authorizedBy?: string }): { taskId: string; conversationId: string; conversationUrl: string; migrated: boolean; freshConversation?: boolean } {
    const task = this.requireTask(input.taskId);
    requireNonTerminalTask(this.store, task.taskId);
    if (!input.requestId.trim() || !input.reason.trim()) throw new Error('WORKFLOW_SUPERVISOR_MIGRATION_REASON_REQUIRED');
    if (input.fresh === true) {
      if (input.conversationId?.trim() || input.conversationUrl?.trim()) throw new Error('WORKFLOW_SUPERVISOR_MIGRATION_FRESH_CONVERSATION_CONFLICT');
      const origin = `fresh-conversation:${task.taskId}:${input.requestId}`;
      const effectId = stableEffectId(origin);
      const migrated = this.store.migrateToFreshConversation({
        taskId: task.taskId,
        expectedConversationId: input.expectedConversationId,
        requestId: input.requestId,
        reason: input.reason,
        authorizedBy: input.authorizedBy?.trim() || 'operator',
        // A fresh conversation has no prior turns, so the replacement turn must
        // carry the objective again instead of the bare "继续。" continuation.
        replacement: { effectId, prompt: this.renderPrompt(task, effectId, 'enrollment') },
      });
      return { taskId: migrated.task.taskId, conversationId: migrated.task.conversationId, conversationUrl: migrated.task.conversationUrl, migrated: migrated.migrated, freshConversation: migrated.migrated };
    }
    if (!input.conversationId?.trim() || !input.conversationUrl?.trim()) throw new Error('WORKFLOW_SUPERVISOR_MIGRATION_CONVERSATION_REQUIRED');
    const identity = parseChatgptConversationIdentity(input.conversationUrl);
    if (identity.conversationId !== input.conversationId) throw new Error('WORKFLOW_SUPERVISOR_MIGRATION_CONVERSATION_MISMATCH');
    const migrated = this.store.migrateConversation({
      taskId: task.taskId,
      expectedConversationId: input.expectedConversationId,
      conversationId: identity.conversationId,
      conversationUrl: identity.canonicalUrl,
      requestId: input.requestId,
      reason: input.reason,
      authorizedBy: input.authorizedBy?.trim() || 'operator',
    });
    return {
      taskId: migrated.task.taskId, conversationId: migrated.task.conversationId,
      conversationUrl: migrated.task.conversationUrl, migrated: migrated.migrated,
    };
  }
  /** Mechanical provider re-dispatch budget for one effect, used by recovery to surface exhaustion. */
  effectDispatchBudget(effectId: string): ReturnType<WorkflowSupervisorStore['effectDispatchBudget']> {
    return this.store.effectDispatchBudget(validateEffectId(effectId));
  }
  continuationProof(input: { repoId?: string; activeReleaseId: string; notBefore: string }) { return this.store.continuationProof(input); }
  browserDiscoverySnapshot() { return this.store.discoverySnapshot(); }
  /** Operator authorization for the exact existing Project; never infer one
   * from the standalone task's objective or nearby browser tabs. */
  bindBootstrapProject(input: { taskId: string; projectUrl: string; requestId: string; authorizedBy: string }) {
    const task = this.requireTask(input.taskId);
    requireNonTerminalTask(this.store, task.taskId);
    let parsed: URL;
    try { parsed = new URL(input.projectUrl); }
    catch { throw new Error('WORKFLOW_SUPERVISOR_BOOTSTRAP_PROJECT_URL_INVALID'); }
    const match = /^\/g\/(g-p-[a-z0-9]+)(?:-[^/]+)?\/project\/?$/i.exec(parsed.pathname);
    if (parsed.origin !== 'https://chatgpt.com' || !match || parsed.search || parsed.hash
      || parsed.username || parsed.password) throw new Error('WORKFLOW_SUPERVISOR_BOOTSTRAP_PROJECT_URL_INVALID');
    const canonical = `https://chatgpt.com/g/${match[1]!.toLocaleLowerCase()}/project`;
    if (!this.store.discoverySnapshot().conversations.some((conversation) => {
      try {
        const value = new URL(conversation.projectUrl ?? '');
        return value.origin === parsed.origin
          && /^\/g\/(g-p-[a-z0-9]+)(?:-[^/]+)?\/project\/?$/i.exec(value.pathname)?.[1]?.toLocaleLowerCase() === match[1]!.toLocaleLowerCase();
      } catch { return false; }
    })) throw new Error('WORKFLOW_SUPERVISOR_BOOTSTRAP_PROJECT_NOT_DISCOVERED');
    return this.store.bindBootstrapProject({ taskId: task.taskId, projectUrl: canonical, requestId: input.requestId, authorizedBy: input.authorizedBy });
  }
  bootstrapProjectUrl(taskId: string): string {
    const task = this.requireTask(taskId);
    const explicitlyBound = this.store.boundBootstrapProjectUrl(taskId);
    if (explicitlyBound) return explicitlyBound;
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
      // Any applied effect awaiting its receipt stays observable, including one
      // whose bounded provider resume is already exhausted. Observation is
      // read-only and mints nothing, so keeping it attached is what lets late
      // provider/completion evidence resolve the turn instead of stranding it.
      const providerTurnAwaitingReceipt = this.store.hasAppliedEffectAwaitingCompletion(task.taskId);
      if (!pending && !providerTurnAwaitingReceipt) {
        const stall = this.store.taskStall(task.taskId);
        // Withholding a failed preparation must not remove an established
        // conversation from the read-only observer and safe-rotation path.
        if (task.conversationId.startsWith('bootstrap:') || stall.state !== 'spaced'
          || stall.reason !== 'pre_send_infrastructure_blocked') return [];
      }
      // Bootstrap has no exact conversation yet, so it cannot satisfy the
      // normal Work-boundary predicate. Its already-persisted enrollment effect
      // is the narrow authority to acquire one through Computer exactly once.
      if (!task.conversationId.startsWith('bootstrap:')) {
        // Optional lower-layer Work/Requirement compatibility must be task-local.
        // A stale legacy task is allowed to fail closed, but it must never poison
        // the global Supervisor delivery queue and block standalone tasks.
        try { if (pending?.mode === 'send' && !this.browserTaskActive(task)) return []; }
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
    if (terminal) return { authorized: true, task: projection, terminal };
    const pending = this.store.nextBrowserEffect(task.taskId);
    // Read-only reconciliation belongs to the already-started effect even when
    // its Work/conversation binding was retired. It never authorizes a resend.
    if (pending?.mode === 'send' && !this.browserTaskActive(task)) throw new Error('WORKFLOW_SUPERVISOR_BROWSER_TASK_INACTIVE');
    if (!pending) return { authorized: true, task: projection };
    return { authorized: true, task: projection, command: { mode: pending.mode, effectId: pending.effect.effectId, kind: pending.effect.kind, prompt: pending.effect.prompt, dispatchGeneration: pending.generation, conversationId: task.conversationId, conversationUrl: task.conversationUrl } };
  }
  bootstrapPoll(taskId: string): WorkflowSupervisorBrowserPollResult {
    const task = this.requireTask(taskId);
    if (!task.conversationId.startsWith('bootstrap:')) throw new Error('WORKFLOW_SUPERVISOR_BOOTSTRAP_NOT_PENDING');
    const terminal = this.store.terminalAction(task.taskId);
    if (terminal === 'STOPPED') return { authorized: true, task: browserTask(task), terminal };
    // While identity is still bootstrap, reconcile the latest applied leaf
    // before dispatching any successor. An unstarted recovery child must not
    // send from a Project/new-composer surface while the source conversation
    // is still unbound. The existing effect ledger owns observation cooldown.
    // A deliberate fresh-conversation migration already reserved a new
    // enrollment in the canonical ledger. An applied effect from the retired
    // conversation can no longer be found by scanning the *new* Project tab;
    // do not let its read-only receipt obligation starve the fresh enrollment.
    const freshEnrollment = this.store.freshConversationMigrationContext(task.taskId)
      ? this.store.nextBrowserEffect(task.taskId) : undefined;
    if (freshEnrollment && freshEnrollment.effect.kind === 'enrollment') {
      return { authorized: true, task: browserTask(task), command: {
        mode: freshEnrollment.mode, effectId: freshEnrollment.effect.effectId,
        kind: freshEnrollment.effect.kind, prompt: freshEnrollment.effect.prompt,
        dispatchGeneration: freshEnrollment.generation,
        conversationId: task.conversationId, conversationUrl: task.conversationUrl,
      } };
    }
    const applied = this.store.latestAppliedLeafEffectWithoutCompletion(task.taskId);
    if (applied) {
      if (!this.store.bootstrapAppliedReconcileDue(applied.effectId)) {
        return { authorized: true, task: browserTask(task) };
      }
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
    const pending = this.store.nextBrowserEffect(task.taskId);
    if (!pending) return { authorized: true, task: browserTask(task) };
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
  bootstrapBeginEffect(input: { taskId: string; effectId: string; dispatchId: string; dispatchGeneration: number }): boolean {
    const task = this.requireTask(input.taskId);
    requireNonTerminalTask(this.store, task.taskId);
    if (!task.conversationId.startsWith('bootstrap:')) throw new Error('WORKFLOW_SUPERVISOR_BOOTSTRAP_NOT_PENDING');
    const pending = this.store.nextBrowserEffect(task.taskId);
    if (!pending || pending.effect.effectId !== validateEffectId(input.effectId) || pending.mode !== 'send') return false;
    return this.store.recordEffectDispatchStarted(input.effectId, input.dispatchGeneration, input.dispatchId, {
      surface: 'computer-bootstrap',
      ...(this.hooks.effectDispatchEvidence?.({ task, effectId: input.effectId }) ?? {}),
    });
  }
  bootstrapObserveEffect(input: { taskId: string; effectId: string; observationId: string; outcome: 'applied' | 'not_applied' | 'unknown'; evidence?: Record<string, unknown>; reconciled?: boolean }): boolean {
    const task = this.requireTask(input.taskId);
    // A bootstrap provider turn becomes applied through the canonical adapter
    // only after the exact conversation URL has been promoted and bound. An
    // unbound applied observation is the old alternate writer path: it leaves
    // the task permanently unable to reconcile its source conversation. Only
    // the read-only reconciliation path may record an unbound applied leaf.
    if (input.outcome === 'applied' && task.conversationId.startsWith('bootstrap:') && input.reconciled !== true) {
      throw new Error('WORKFLOW_SUPERVISOR_BOOTSTRAP_APPLIED_REQUIRES_BOUND_CONVERSATION');
    }
    const effect = this.store.getEffect(validateEffectId(input.effectId));
    if (!effect || effect.taskId !== task.taskId) throw new Error('WORKFLOW_SUPERVISOR_BOOTSTRAP_EFFECT_TASK_MISMATCH');
    if (input.outcome === 'not_applied') {
      // This path is private to the provider dispatch adapter after its exact
      // dispatch function returned without clicking Send. It is therefore a
      // mechanical negative proof, unlike a missing post-send conversation
      // marker, which remains outcome-unknown and must reconcile.
      const pending = this.store.nextBrowserEffect(task.taskId);
      const dispatch = this.store.latestEffectDispatch(effect.effectId);
      if (!pending || pending.effect.effectId !== effect.effectId || pending.mode !== 'reconcile'
        || !dispatch || pending.generation !== dispatch.generation
        || dispatch.evidence.surface !== 'computer-bootstrap'
        || input.evidence?.dispatch_mutation !== 'not_attempted'
        || input.evidence?.send_clicked !== false) {
        throw new Error('WORKFLOW_SUPERVISOR_BOOTSTRAP_NOT_APPLIED_PROOF_INVALID');
      }
      // The provider's pre-click result is an observation, not automatic
      // refund authority. The Store validates any retryable no-mutation proof.
      return this.store.recordEffectNotAppliedProof(effect.effectId, input.observationId, {
        surface: 'computer-bootstrap', send_clicked: false,
        dispatch_generation: dispatch.generation,
        pre_send_rejection: true,
        attestation: 'local_computer_dispatch_returned_without_send',
      });
    }
    const evidence = { surface: 'computer-bootstrap', ...(input.evidence ?? {}) };
    this.observeEffect({ effectId: effect.effectId, observationId: input.observationId, outcome: input.outcome, evidence });
    if (input.outcome === 'applied') this.hooks.effectApplied?.(task, effect, { observationId: input.observationId, evidence });
    return false;
  }
  /** Persist a bounded preflight rejection; started generations require an exact no-click proof first. */
  recordProviderPreparationFailure(input: { taskId: string; effectId: string; reasonCode: string; composerObservation?: WorkflowSupervisorPreflightComposerObservation }): void {
    const task = this.requireTask(input.taskId);
    const effect = this.store.getEffect(input.effectId);
    if (effect?.taskId !== task.taskId) throw new Error('WORKFLOW_SUPERVISOR_PRE_SEND_EFFECT_TASK_MISMATCH');
    this.store.recordEffectPreparationFailure(input.effectId, input.reasonCode, input.composerObservation);
  }

  browserBeginEffect(input: { conversationId: string; conversationUrl: string; effectId: string; dispatchId: string; dispatchGeneration: number; evidence?: Record<string, unknown> }): { started: boolean; mode: 'send' | 'reconcile'; generation: number } {
    const task = this.requireBrowserTask(input.conversationId, input.conversationUrl);
    requireNonTerminalTask(this.store, task.taskId);
    const pending = this.store.nextBrowserEffect(task.taskId);
    const effectId = validateEffectId(input.effectId);
    if (!pending || pending.effect.effectId !== effectId) throw new Error('WORKFLOW_SUPERVISOR_BROWSER_EFFECT_NOT_CURRENT');
    if (pending.mode !== 'send' || pending.generation !== input.dispatchGeneration) return { started: false, mode: 'reconcile', generation: pending.generation };
    // Re-check immediately before committing dispatch; a queued browser command
    // must not outlive an explicit conversation rebind.
    if (!this.browserTaskActive(task)) throw new Error('WORKFLOW_SUPERVISOR_BROWSER_TASK_INACTIVE');
    const snapshot = browserSnapshot(input.evidence);
    if (!snapshot || browserTextHasEffect(snapshot.latestUserText, effectId) || !this.browserSnapshotMatchesSource(task, pending.effect, snapshot)) {
      return { started: false, mode: 'reconcile', generation: pending.generation };
    }
    const dispatchEvidence = {
      surface: typeof input.evidence?.surface === 'string' ? input.evidence.surface.slice(0, 128) : 'chrome-extension',
      baseline_user_sha256: browserTextSha256(snapshot.latestUserText),
      baseline_assistant_sha256: sha256(snapshot.latestAssistantResponse),
      baseline_has_source_completion: Boolean(pending.effect.sourceCompletionFingerprint),
      ...(this.hooks.effectDispatchEvidence?.({ task, effectId }) ?? {}),
      ...(typeof input.evidence?.target_id === 'string' && input.evidence.target_id.trim()
        ? { target_id: input.evidence.target_id.trim().slice(0, 256) } : {}),
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
    // A rendered page can still be stale, including an empty composer and the
    // exact pre-send history. Absence in that page is never proof that the
    // provider rejected a submission. Only the dispatch owner can attest a
    // mechanical pre-send failure (bootstrapObserveEffect); browser observers
    // cannot authorize re-dispatch of an outcome-unknown mutation.
    this.store.recordEffectObservation(effect.effectId, input.observationId, 'unknown', {
      ...sanitizeBrowserEvidence(input.evidence), reconciliation: true, reason: 'not_applied_proof_incomplete',
    });
    return { recorded: true };
  }
  /** Dispatch-owner attestation. Only the adapter that reserved this generation may call it. */
  browserObserveDispatchFailure(input: { conversationId: string; conversationUrl: string; effectId: string; observationId: string; dispatchGeneration: number; dispatchId: string; targetId: string; reason: string; surface?: string; prewriteNoMutationReceipt?: ComputerChatgptPrewriteNoMutationReceipt }): void {
    const task = this.requireBrowserTask(input.conversationId, input.conversationUrl);
    const effect = this.store.getEffect(input.effectId);
    if (effect?.taskId !== task.taskId) throw new Error('WORKFLOW_SUPERVISOR_BROWSER_EFFECT_TASK_MISMATCH');
    const dispatch = this.store.latestEffectDispatch(input.effectId);
    if (dispatch?.generation !== input.dispatchGeneration) throw new Error('WORKFLOW_SUPERVISOR_DISPATCH_GENERATION_CHANGED');
    const accepted = this.store.recordEffectNotAppliedProof(input.effectId, input.observationId, {
      ...(input.prewriteNoMutationReceipt ?? {}),
      effect_id: input.effectId, dispatch_generation: input.dispatchGeneration, dispatch_id: input.dispatchId,
      target_id: input.targetId, surface: input.surface?.trim().slice(0, 128) || 'computer-chatgpt-target',
    });
    // A missing/invalid typed receipt is durably UNKNOWN and cannot create retry
    // or refund authority. The original observation loop will reconcile it.
    if (!accepted) return;
    // Recovery readiness refusals happen before composer mutation and are expected
    // to become retryable after bounded spacing; don't convert them into a sticky
    // preflight block or click Stop to make progress.
    if (effect.kind === 'recovery' && ['provider_recovery_stop_pending', 'provider_recovery_turn_unknown', 'provider_recovery_turn_live'].includes(input.reason.trim())) return;
    this.recordProviderPreparationFailure({ taskId: task.taskId, effectId: effect.effectId, reasonCode: input.reason });
  }
  browserObserveProviderTurn(input: { conversationId: string; conversationUrl: string; generating: boolean; latestAssistantResponse: string; providerActivityText?: string; providerFailureCode?: string; receiptMissing?: boolean; observedAtMs: number; graceMs: number }): { state: 'inactive' | 'none' | 'generating' | 'idle_pending' | 'recovery_reserved' | 'exhausted'; recoveryEffect?: WorkflowSupervisorEffect } {
    const task = this.requireBrowserTask(input.conversationId, input.conversationUrl);
    if (!this.browserTaskActiveForExternalEffect(task)) return { state: 'inactive' };
    // Exhaustion stops new recovery mutations, not read-only observation of the exhausted applied leaf.
    let sourceEffect = this.store.latestAppliedEffectWithoutCompletion(task.taskId);
    if (!sourceEffect) {
      const exhaustedLeaf = this.store.latestAppliedLeafEffectWithoutCompletion(task.taskId);
      if (exhaustedLeaf && this.store.providerResumeExhausted(exhaustedLeaf.effectId)) sourceEffect = exhaustedLeaf;
    }
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
      receiptMissing: input.receiptMissing === true,
      assistantDigest: sha256(`${input.latestAssistantResponse}\n${input.providerActivityText ?? ''}`),
      providerFailureCode,
      observedAtMs: input.observedAtMs,
      graceMs: input.graceMs,
      recovery: { effectId: recoveryId, prompt: this.renderPrompt(task, recoveryId, 'recovery', undefined, recoveryReason) },
    });
  }
  async browserObserveAssistant(input: { conversationId: string; conversationUrl: string; responseText: string }): Promise<WorkflowAssistantObservationResult> {
    const task = this.requireBrowserTask(input.conversationId, input.conversationUrl);
    return await this.observeAssistantTurn({ taskId: task.taskId, conversationId: task.conversationId, responseText: input.responseText });
  }

  /**
   * Repair the crash boundary where a CONTINUE completion was durably committed
   * before successor reservation finished in a previous Runtime. This never
   * replays the provider response; it only reads the committed causal receipt and
   * reserves the exactly-once successor effect.
   */
  async reconcileCommittedContinuations(limit = 16): Promise<{ scanned: number; reconciled: number }> {
    const completions = this.store.listContinueCompletionsAwaitingSuccessor(limit);
    let reconciled = 0;
    for (const completion of completions) {
      const task = this.store.getTask(completion.taskId);
      if (!task || this.store.terminalAction(task.taskId)) continue;
      const committed = this.reserveContinuation(task, completion);
      if (committed.successorEffect) reconciled += 1;
    }

    // A non-terminal Supervisor task must always have one derivable causal
    // obligation: an unapplied effect, an applied effect awaiting completion,
    // or a committed completion whose successor/terminal resolution can be
    // reconstructed from durable facts. Registration is intentionally a
    // separate transaction from effect reservation, so a Runtime crash between
    // them must converge here instead of leaving an "active" inert task.
    const inertTasks = this.store.listTasksWithoutCausalObligation(limit);
    for (const task of inertTasks) {
      if (this.store.terminalAction(task.taskId)) continue;
      const latest = this.store.getLatestCompletion(task.taskId);
      if (!latest) {
        this.reserveEnrollment(task.taskId);
        reconciled += 1;
        continue;
      }
      if (latest.action === 'CONTINUE') {
        const committed = this.reserveContinuation(task, latest);
        if (committed.successorEffect) reconciled += 1;
        continue;
      }
      if (latest.action === 'WAIT') continue;
      const validation = await this.validateTerminalProposal(task, latest.proposal);
      const correctionId = validation.valid ? undefined : stableEffectId(`completion:${latest.completionFingerprint}`);
      this.store.resolveTerminal({
        completionFingerprint: latest.completionFingerprint,
        taskId: task.taskId,
        action: latest.action,
        accepted: validation.valid,
        reason: validation.reason,
        ...(correctionId ? {
          correction: {
            effectId: correctionId,
            prompt: this.renderPrompt(task, correctionId, 'correction', latest.proposal.checkpoint, validation.reason),
          },
        } : {}),
      });
      reconciled += 1;
    }
    return { scanned: completions.length + inertTasks.length, reconciled };
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
    const receiptEffect = expectedEffect ?? (expectedEffectId ? this.store.getEffect(expectedEffectId) : undefined);
    const parsed = parseSupervisorCompletion(
      input.responseText,
      expectedEffectId ? { task, effectId: expectedEffectId, prompt: receiptEffect?.prompt } : undefined,
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

    if (parsed.proposal.action === 'CONTINUE') {
      const committed = this.reserveContinuation(task, completion);
      return { action: 'CONTINUE', completionFingerprint, terminal: false, successorEffect: committed.successorEffect!, deduplicated: committed.deduplicated };
    }
    if (parsed.proposal.action === 'WAIT') {
      const committed = this.store.commitCompletion(completion);
      return { action: 'WAIT', completionFingerprint, terminal: false, deduplicated: committed.deduplicated };
    }
    const committed = this.store.commitCompletion(completion);

    const validation = await this.validateTerminalProposal(task, parsed.proposal);
    const correctionId = validation.valid ? undefined : stableEffectId(`completion:${completionFingerprint}`);
    const resolved = this.store.resolveTerminal({ completionFingerprint, taskId: task.taskId, action: parsed.proposal.action, accepted: validation.valid, reason: validation.reason,
      ...(correctionId ? { correction: { effectId: correctionId, prompt: this.renderPrompt(task, correctionId, 'correction', parsed.proposal.checkpoint, validation.reason) } } : {}) });
    return { action: parsed.proposal.action, completionFingerprint, terminal: validation.valid, ...(resolved.successorEffect ? { successorEffect: resolved.successorEffect } : {}), validation, deduplicated: committed.deduplicated || resolved.deduplicated };
  }

  /** Model CONTINUE and its causal successor commit in the same authority transaction. */
  private reserveContinuation(task: WorkflowSupervisorTask, completion: WorkflowSupervisorCompletion) {
    const nextId = stableEffectId(`completion:${completion.completionFingerprint}`);
    const notices = this.store.listPendingReviewNotices(128).filter(({ notice }) => notice.taskId === task.taskId).slice(0, 4);
    const nextContext = notices.length
      ? notices.map(({ notice }) =>
          `PR#${notice.prNumber} receipt ${notice.reviewId} [UNVERIFIED${notice.reviewedHeadSha !== notice.currentHeadSha ? ' STALE_HEAD' : ''}] ${notice.outcome}`
        ).join('; ')
      : undefined;
    return this.store.commitCompletion(completion, {
      effectId: nextId,
      kind: 'continuation',
      ...(notices.length ? { reviewEventKeys: notices.map(({ eventKey }) => eventKey) } : {}),
      prompt: this.renderPrompt(task, nextId, 'continuation', undefined, undefined, nextContext),
      // Rebuild from the same durable goal in a new logical conversation after
      // a confirmed receipt cycle; never migrate an uncompleted mutation.
      ...(task.continuationPolicy.kind === 'standalone_supervisor'
        ? { freshEnrollmentPrompt: this.renderPrompt(task, nextId, 'enrollment', undefined, undefined, nextContext) } : {}),
    });
  }

  private async validateTerminalProposal(
    task: WorkflowSupervisorTask,
    proposal: WorkflowSupervisorCompletion['proposal'],
  ): Promise<WorkflowContractValidation> {
    const validator = proposal.action === 'DONE' ? this.validators.completionContract : this.validators.userBlockerPolicy;
    const validation = await validator(task, proposal);
    if (typeof task.continuationPolicy.scheduled_wake_schedule_id !== 'string') return validation;
    if (proposal.action === 'DONE') {
      return {
        ...validation,
        valid: false,
        reason: validation.valid ? 'scheduled_work_must_wait' : validation.reason,
        evidence: [...(validation.evidence ?? []), 'A Work-bound recurring Schedule owns the next run; use WAIT instead of terminal DONE.'],
      };
    }
    if (proposal.action === 'NEEDS_USER') {
      return {
        ...validation,
        valid: false,
        reason: validation.valid ? 'scheduled_work_must_remain_open' : validation.reason,
        evidence: [...(validation.evidence ?? []), 'Persist the exact user blocker and use WAIT; a recurring scheduled Work must remain open.'],
      };
    }
    return validation;
  }

  private renderPrompt(
    task: WorkflowSupervisorTask,
    effectId: string,
    kind: WorkflowEffectKind,
    _checkpoint?: string,
    correctionReason?: string,
    lowerLayerContext?: string,
  ): string {
    const canonicalObjective = this.hooks.canonicalObjectiveForTask?.(task)?.trim();
    const promptTask = canonicalObjective ? { ...task, objective: canonicalObjective } : task;
    // Historical checkpoints remain in the effect journal, never in the next prompt.
    return renderSupervisorPrompt(promptTask, effectId, kind, undefined, correctionReason, lowerLayerContext);
  }

  private browserTaskActive(task: WorkflowSupervisorTask): boolean { return this.hooks.browserTaskActive?.(task) ?? true; }
  private browserTaskActiveForExternalEffect(task: WorkflowSupervisorTask): boolean {
    return this.store.hasAppliedEffectAwaitingCompletion(task.taskId) || this.browserTaskActive(task);
  }

  /**
   * Progress is a mechanical change in the canonical Work this turn is meant to
   * advance, never the provider's willingness to answer again. Both endpoints of
   * the comparison are durable facts: the Work projection captured in this
   * effect's dispatch evidence and the current projection. A missing signal on
   * either side is unknown, so it proves neither progress nor its absence.
   */
  private automationTurnChangedNothing(task: WorkflowSupervisorTask, effectId: string): boolean {
    const dispatched = boundedBrowserText(this.store.latestEffectDispatch(effectId)?.evidence.work_progress_fingerprint, 256);
    const current = boundedBrowserText(this.hooks.workProgressFingerprint?.(task), 256);
    return Boolean(dispatched && current && dispatched === current);
  }

  private browserSnapshotMatchesSource(task: WorkflowSupervisorTask, effect: WorkflowSupervisorEffect, snapshot: { latestUserText: string; latestAssistantResponse: string }): boolean {
    if (!effect.sourceCompletionFingerprint) return true;
    const completion = this.store.getCompletion(effect.sourceCompletionFingerprint);
    if (!completion || completion.taskId !== task.taskId) return false;
    // A compact completion is committed only after observing the provider's
    // finished assistant reply and checking its causal challenge. ChatGPT may
    // subsequently collapse that historical reply or its original user marker;
    // requiring the bytes to remain in the DOM would strand a valid successor.
    // Persisted legacy tool receipts are read-only migration evidence; the MCP
    // receipt writer has been retired. In both cases the committed completion,
    // not a new heuristic, is the one authority for the successor.
    const durableReceipt = completion.proposal.reason === 'compact_receipt'
      || completion.proposal.reason === 'automation_tool_receipt';
    const sourceEffect = this.store.getEffect(completion.sourceEffectId);
    if (!sourceEffect || sourceEffect.taskId !== task.taskId) return false;
    if (durableReceipt) return true;
    if (sha256(snapshot.latestAssistantResponse) !== completion.responseSha256) return false;
    return normalizeBrowserText(snapshot.latestUserText) === normalizeBrowserText(sourceEffect.prompt)
      || browserTextHasEffect(snapshot.latestUserText, sourceEffect.effectId);
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
function browserSnapshot(evidence: Record<string, unknown> | undefined): { latestUserText: string; latestAssistantResponse: string } | undefined {
  const latestUserText = boundedBrowserText(evidence?.latest_user_text, 128 * 1024);
  const latestAssistantResponse = boundedBrowserText(evidence?.latest_assistant_response, 512 * 1024);
  if (latestUserText === undefined || latestAssistantResponse === undefined) return undefined;
  return { latestUserText, latestAssistantResponse };
}
function normalizeBrowserText(value: string): string { return value.replace(/\s+/g, ' ').trim(); }
function browserTextSha256(value: string): string { return sha256(normalizeBrowserText(value)); }
function browserTextHasEffect(value: string, effectId: string): boolean { return value.includes(renderEffectMarker(effectId)); }
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
