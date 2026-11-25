import {
  validateEventEnvelopeV1,
  type EventEnvelopeV1,
  type EventPolicyPermission,
} from '../../../packages/kernel/events';
import type { ModelProfileProtocol, ModelProfileTier } from '../../../packages/kernel/models';
import { findMatchingEventPolicies } from './event-policy-store';
import { resolveModelProfile, type ModelProfileFallbackCondition } from '../models/model-profile-store';

export interface EventPolicyPreviewAction {
  actionId: string;
  permission: EventPolicyPermission;
  requiresApproval: boolean;
}

export interface EventPolicyPreviewModelProfile {
  profileId: string;
  revision: number;
  providerId: string;
  modelId: string;
  protocol: ModelProfileProtocol;
  tier: ModelProfileTier;
  instructionTemplateId: string;
  outputSchemaId: string;
  fallbackChains: Array<{
    condition: ModelProfileFallbackCondition;
    profileIds: string[];
  }>;
}

export interface EventPolicyPreviewEntry {
  policyId: string;
  revision: number;
  decisionMode: 'deterministic' | 'model';
  minimumConfidence?: number;
  modelProfile?: EventPolicyPreviewModelProfile;
  actions: EventPolicyPreviewAction[];
  approvalRequired: boolean;
  readiness: 'ready' | 'blocked';
  blocker?: string;
  execution: 'not_executed';
}

export interface EventPolicyPreviewResult {
  schemaVersion: 1;
  event: {
    eventId: string;
    source: string;
    provider: string;
    eventType: string;
    scopeKind: string;
    scopeId: string;
  };
  matchedPolicyCount: number;
  policies: EventPolicyPreviewEntry[];
}

function resolvePreviewProfile(controllerHome: string, profileId: string): EventPolicyPreviewModelProfile {
  const primaryChain = resolveModelProfile(controllerHome, profileId);
  const primary = primaryChain[0];
  if (!primary) throw new Error('MODEL_PROFILE_NOT_FOUND: ' + profileId);
  const fallbackChains = primary.value.fallbackOn.map((condition) => ({
    condition,
    profileIds: resolveModelProfile(controllerHome, profileId, condition).map((record) => record.value.profileId),
  }));
  return {
    profileId: primary.value.profileId,
    revision: primary.value.revision,
    providerId: primary.value.providerId,
    modelId: primary.value.modelId,
    protocol: primary.value.protocol,
    tier: primary.value.tier,
    instructionTemplateId: primary.value.instructionTemplateId,
    outputSchemaId: primary.value.outputSchemaId,
    fallbackChains,
  };
}

function blockedModelPreview(
  policyId: string,
  revision: number,
  minimumConfidence: number | undefined,
  actions: EventPolicyPreviewAction[],
  blocker: string,
): EventPolicyPreviewEntry {
  return {
    policyId,
    revision,
    decisionMode: 'model',
    ...(minimumConfidence === undefined ? {} : { minimumConfidence }),
    actions,
    approvalRequired: actions.some((action) => action.requiresApproval),
    readiness: 'blocked',
    blocker,
    execution: 'not_executed',
  };
}

/**
 * Read-only preview. It never invokes a model, resolves credentials, requests
 * approval, dispatches a Workflow, or executes an Action.
 */
export function previewEventPolicies(controllerHome: string, input: EventEnvelopeV1): EventPolicyPreviewResult {
  const envelope = validateEventEnvelopeV1(input);
  const policies = findMatchingEventPolicies(controllerHome, envelope).map((record): EventPolicyPreviewEntry => {
    const policy = record.value;
    const actions = policy.allowedActions.map((action) => ({ ...action }));
    if (policy.decision.mode === 'deterministic') {
      return {
        policyId: policy.policyId,
        revision: policy.revision,
        decisionMode: 'deterministic',
        actions,
        approvalRequired: actions.some((action) => action.requiresApproval),
        readiness: 'ready',
        execution: 'not_executed',
      };
    }

    try {
      const profileId = policy.decision.modelProfileId;
      if (!profileId) throw new Error('EVENT_POLICY_MODEL_PROFILE_REQUIRED');
      return {
        policyId: policy.policyId,
        revision: policy.revision,
        decisionMode: 'model',
        ...(policy.decision.minimumConfidence === undefined
          ? {}
          : { minimumConfidence: policy.decision.minimumConfidence }),
        modelProfile: resolvePreviewProfile(controllerHome, profileId),
        actions,
        approvalRequired: actions.some((action) => action.requiresApproval),
        readiness: 'ready',
        execution: 'not_executed',
      };
    } catch (error) {
      return blockedModelPreview(
        policy.policyId,
        policy.revision,
        policy.decision.minimumConfidence,
        actions,
        error instanceof Error ? error.message : 'MODEL_PROFILE_RESOLUTION_FAILED',
      );
    }
  });

  return {
    schemaVersion: 1,
    event: {
      eventId: envelope.eventId,
      source: envelope.source,
      provider: envelope.provider,
      eventType: envelope.eventType,
      scopeKind: envelope.scope.kind,
      scopeId: envelope.scope.id,
    },
    matchedPolicyCount: policies.length,
    policies,
  };
}
