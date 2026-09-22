import type { CallToolResult } from '../../../packages/protocols/mcp/tool-contract';
import { getControllerRoundRelay, getControllerSession } from '../../../packages/kernel/controller/api/index';
import { getWorkContract } from '../../../packages/kernel/work/api/index';
import {
  recordControllerExperience,
  recordControllerOutcome,
  type ControllerExperienceDraft,
  type ControllerOutcomeObservationDraft,
} from '../../../src/runtime/context/assistant-work-context';
import { buildFacadeResult } from '../../../src/runtime/control-plane/facade';
import type { MultiRepositoryMcpToolContext } from '../multi-repository';
import { assertFacadeControllerRoundAuthority } from './controller-authority-adapter';
import { result } from './result-adapter';

type RepositoryIdentity = { repoId: string };

/**
 * Dedicated rh_work learning-loop dispatch. It records Outcome/Experience data
 * only after exact Work/Controller authority is proven; Work lifecycle mutation
 * remains owned by the canonical lifecycle adapters.
 */
export function callRhWorkLearningOperation(
  ctx: MultiRepositoryMcpToolContext,
  repository: RepositoryIdentity,
  operation: string,
  args: Record<string, unknown>,
): CallToolResult | undefined {
  if (operation !== 'outcome_record' && operation !== 'experience_record') return undefined;
  const store = { controllerHome: ctx.controllerHome, repoId: repository.repoId };
  try {
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
      summary: `Experience ${experience.id} recorded from canonical evidence for reuse by the next ControllerRound.`,
      data: { experience },
    }) as unknown as Record<string, unknown>);
  } catch (error) {
    return result(buildFacadeResult({
      status: 'blocked',
      summary: error instanceof Error ? error.message : 'Learning-loop record failed.',
      data: { recorded: false },
    }) as unknown as Record<string, unknown>, true);
  }
}
