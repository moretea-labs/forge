import type { MultiRepositoryMcpToolContext } from '../multi-repository';
import { parseControllerLearningSignalDrafts } from '../../../src/runtime/context/automatic-learning';
import { persistDirectControllerLearning, recordDirectControllerLearningFeedback, type DirectControllerLearningFeedbackDraft } from '../../../src/runtime/context/direct-controller-learning';
import { selected } from './shared-adapter';

/** Mechanical settlement shared by ordinary MCP outcome boundaries. */
export function settleCognitionEnvelope(
  ctx: MultiRepositoryMcpToolContext,
  args: Record<string, unknown>,
): void {
  const raw = args.cognition_settlement;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
  const envelope = raw as Record<string, unknown>;
  const repository = selected(ctx, args);
  const workId = typeof envelope.work_id === 'string' && envelope.work_id.trim()
    ? envelope.work_id.trim()
    : typeof args.work_id === 'string' && args.work_id.trim() ? args.work_id.trim() : undefined;
  if (envelope.learning_signals !== undefined) {
    const signals = parseControllerLearningSignalDrafts(envelope.learning_signals);
    if (!signals.length) throw new Error('COGNITION_SETTLEMENT_SIGNALS_REQUIRED');
    persistDirectControllerLearning({
      controllerHome: ctx.controllerHome,
      repository,
      signals,
      principalId: ctx.principalId,
      sessionId: ctx.sessionId,
      controllerInstanceId: ctx.controllerInstanceId,
      controllerType: ctx.controllerType,
      workId,
    });
  }
  if (envelope.learning_feedback !== undefined) {
    if (!Array.isArray(envelope.learning_feedback)) throw new Error('COGNITION_SETTLEMENT_FEEDBACK_INVALID');
    const feedback = envelope.learning_feedback.map((rawItem, index) => {
      if (!rawItem || typeof rawItem !== 'object' || Array.isArray(rawItem)) throw new Error(`COGNITION_SETTLEMENT_FEEDBACK_INVALID:${index}`);
      const item = rawItem as Record<string, unknown>;
      return {
        memoryAddress: String(item.memory_address ?? '').trim(),
        decision: String(item.decision ?? '').trim(),
        reason: String(item.reason ?? '').trim(),
        ...(typeof item.rejection_kind === 'string' ? { rejectionKind: item.rejection_kind.trim() } : {}),
      } as DirectControllerLearningFeedbackDraft;
    });
    recordDirectControllerLearningFeedback({
      controllerHome: ctx.controllerHome,
      repository,
      feedback,
      principalId: ctx.principalId,
      sessionId: ctx.sessionId,
      controllerInstanceId: ctx.controllerInstanceId,
      workId,
    });
  }
}
