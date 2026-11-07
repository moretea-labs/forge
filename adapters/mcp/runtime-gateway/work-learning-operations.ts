import type { CallToolResult } from '../../../packages/protocols/mcp/tool-contract';

import { parseControllerLearningSignalDrafts } from '../../../src/runtime/context/automatic-learning';
import { persistDirectControllerLearning, recordDirectControllerLearningFeedback, type DirectControllerLearningFeedbackDraft } from '../../../src/runtime/context/direct-controller-learning';
import { buildFacadeResult } from '../../../src/runtime/control-plane/facade';
import type { MultiRepositoryMcpToolContext } from '../multi-repository';
import { result } from './result-adapter';

type RepositoryIdentity = { repoId: string; activeCheckoutId: string };

/**
 * rh_work learning dispatch is advisory. Project/Workspace learning needs no lifecycle;
 * optional Requirement scope is selected by exact requirement_id and validated by the
 * Requirement owner. Historical Work never grants learning write authority.
 */
export function callRhWorkLearningOperation(
  ctx: MultiRepositoryMcpToolContext,
  repository: RepositoryIdentity,
  operation: string,
  args: Record<string, unknown>,
): CallToolResult | undefined {
  if (!['learning_record', 'learning_feedback'].includes(operation)) return undefined;
  try {
    if (typeof args.work_id === 'string' && args.work_id.trim()) throw new Error('COGNITION_WORK_SCOPE_RETIRED');
    const requirementId = typeof args.requirement_id === 'string' && args.requirement_id.trim()
      ? args.requirement_id.trim()
      : undefined;
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
        requirementId,
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
        requirementId,
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

  } catch (error) {
    return result(buildFacadeResult({
      status: 'blocked',
      summary: error instanceof Error ? error.message : 'Learning record failed.',
      data: { recorded: false },
    }) as unknown as Record<string, unknown>, true);
  }
}
