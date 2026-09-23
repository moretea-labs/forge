import type { CallToolResult } from '../../../packages/protocols/mcp/tool-contract';
import { getControllerRoundRelay, getControllerSession } from '../../../packages/kernel/controller/api/index';
import { getWorkContract } from '../../../packages/kernel/work/api/index';
import {
  recordControllerExperience,
  recordControllerOutcome,
  type ControllerExperienceDraft,
  type ControllerOutcomeObservationDraft,
} from '../../../src/runtime/context/assistant-work-context';
import { parseControllerLearningSignalDrafts } from '../../../src/runtime/context/automatic-learning';
import { persistDirectControllerLearning, recordDirectControllerLearningFeedback, type DirectControllerLearningFeedbackDraft } from '../../../src/runtime/context/direct-controller-learning';
import { buildFacadeResult } from '../../../src/runtime/control-plane/facade';
import type { MultiRepositoryMcpToolContext } from '../multi-repository';
import { assertFacadeControllerRoundAuthority } from './controller-authority-adapter';
import { result } from './result-adapter';

type RepositoryIdentity = { repoId: string; activeCheckoutId: string };

/**
 * rh_work learning dispatch has two deliberately different authority shapes:
 * - learning_record / learning_feedback are generic Cognitive mutations and never require Work.
 * - outcome_record / experience_record are Work-specific verified records and retain exact
 *   ControllerRound lineage.
 */
export function callRhWorkLearningOperation(
  ctx: MultiRepositoryMcpToolContext,
  repository: RepositoryIdentity,
  operation: string,
  args: Record<string, unknown>,
): CallToolResult | undefined {
  if (!['learning_record', 'learning_feedback', 'outcome_record', 'experience_record'].includes(operation)) return undefined;
  const store = { controllerHome: ctx.controllerHome, repoId: repository.repoId };
  try {
    if (operation === 'learning_feedback') {
      if (!Array.isArray(args.learning_feedback) || args.learning_feedback.length === 0 || args.learning_feedback.length > 32) {
        throw new Error('COGNITION_DIRECT_FEEDBACK_ITEMS_REQUIRED');
      }
      const feedback = args.learning_feedback.map((entry, index) => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`COGNITION_DIRECT_FEEDBACK_ITEM_INVALID: ${index}`);
        const item = entry as Record<string, unknown>;
        const decision = String(item.decision ?? '').trim();
        const memoryAddress = String(item.memory_address ?? '').trim();
        const reason = String(item.reason ?? '').trim();
        const rejectionKind = typeof item.rejection_kind === 'string' ? item.rejection_kind.trim() : undefined;
        if (!memoryAddress || !['used', 'rejected'].includes(decision)) throw new Error(`COGNITION_DIRECT_FEEDBACK_ITEM_INVALID: ${index}`);
        if (decision === 'rejected' && !['irrelevant', 'stale', 'contradicted'].includes(rejectionKind ?? '')) {
          throw new Error(`COGNITION_DIRECT_FEEDBACK_REJECTION_KIND_REQUIRED: ${index}`);
        }
        if (decision === 'used' && rejectionKind) throw new Error(`COGNITION_DIRECT_FEEDBACK_REJECTION_KIND_UNEXPECTED: ${index}`);
        return {
          memoryAddress,
          decision,
          reason,
          ...(rejectionKind ? { rejectionKind } : {}),
        } as DirectControllerLearningFeedbackDraft;
      });
      const recorded = recordDirectControllerLearningFeedback({
        controllerHome: ctx.controllerHome,
        repository,
        feedback,
        principalId: ctx.principalId,
        sessionId: ctx.sessionId,
        controllerInstanceId: ctx.controllerInstanceId,
      });
      return result(buildFacadeResult({
        summary: `Recorded ${recorded.observationIds.length} lifecycle-free Cognitive usage feedback observation(s).`,
        data: {
          recorded: true,
          observationIds: recorded.observationIds,
          scopes: recorded.scopes,
          authorityBoundary: 'Usage feedback adjusts advisory retrieval utility only; it grants no execution, lifecycle, or semantic authority.',
        },
      }) as unknown as Record<string, unknown>);
    }

    if (operation === 'learning_record') {
      const signals = parseControllerLearningSignalDrafts(args.learning_signals);
      if (signals.length === 0) throw new Error('COGNITION_DIRECT_LEARNING_SIGNALS_REQUIRED');
      const learning = persistDirectControllerLearning({
        controllerHome: ctx.controllerHome,
        repository,
        signals,
        principalId: ctx.principalId,
        sessionId: ctx.sessionId,
        controllerInstanceId: ctx.controllerInstanceId,
        controllerType: ctx.controllerType,
      });
      return result(buildFacadeResult({
        summary: `Recorded ${learning.storedMemoryIds.length} model-authored advisory learning item(s) without creating Work lifecycle.`,
        data: {
          recorded: true,
          storedMemoryIds: learning.storedMemoryIds,
          associatedEdgeCount: learning.associatedEdgeCount,
          consolidatedMemoryIds: learning.consolidatedMemoryIds,
          scopes: learning.scopes,
          authorityBoundary: 'Cognitive advisory memory only; it never grants execution or lifecycle authority.',
        },
      }) as unknown as Record<string, unknown>);
    }

    const workId = String(args.work_id ?? '').trim();
    if (!workId) throw new Error('LEARNING_LOOP_WORK_ID_REQUIRED');
    const work = getWorkContract(store, workId);
    if (!work) throw new Error(`WORK_NOT_FOUND: ${workId}`);
    assertFacadeControllerRoundAuthority(ctx, store, workId, args);
    const owner = getControllerSession(store, workId);
    const relay = getControllerRoundRelay(store, workId);
    if (!owner) throw new Error(`WORK_CONTROLLER_OWNER_REQUIRED: ${workId}`);
    const authorityId = relay?.authorityId?.trim()
      || (typeof args.controller_authority_id === 'string' ? args.controller_authority_id.trim() : '');
    if (!authorityId) throw new Error('LEARNING_LOOP_CONTROLLER_AUTHORITY_REQUIRED');
    const identity = { workId, controllerId: owner.controllerId, authorityId };

    if (operation === 'outcome_record') {
      if (!args.outcome_observation || typeof args.outcome_observation !== 'object' || Array.isArray(args.outcome_observation)) {
        throw new Error('OUTCOME_OBSERVATION_REQUIRED');
      }
      const outcome = recordControllerOutcome({
        controllerHome: ctx.controllerHome,
        repoId: repository.repoId,
        identity,
        draft: args.outcome_observation as ControllerOutcomeObservationDraft,
      });
      return result(buildFacadeResult({
        summary: `OutcomeObservation ${outcome.id} recorded from canonical Work/ControllerRound evidence.`,
        data: { outcome },
      }) as unknown as Record<string, unknown>);
    }

    if (!args.experience_draft || typeof args.experience_draft !== 'object' || Array.isArray(args.experience_draft)) {
      throw new Error('EXPERIENCE_DRAFT_REQUIRED');
    }
    const experience = recordControllerExperience({
      controllerHome: ctx.controllerHome,
      repoId: repository.repoId,
      identity,
      draft: args.experience_draft as ControllerExperienceDraft,
      qualityAdjustmentFingerprint: typeof args.quality_adjustment_fingerprint === 'string'
        ? args.quality_adjustment_fingerprint.trim() || undefined
        : undefined,
    });
    return result(buildFacadeResult({
      summary: `Experience ${experience.id} recorded from canonical Work evidence for reuse by later Controller rounds.`,
      data: { experience },
    }) as unknown as Record<string, unknown>);
  } catch (error) {
    return result(buildFacadeResult({
      status: 'blocked',
      summary: error instanceof Error ? error.message : 'Learning record failed.',
      data: { recorded: false },
    }) as unknown as Record<string, unknown>, true);
  }
}
