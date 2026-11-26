import type { EventRuleJson } from '../../../packages/kernel/events';
import { validateEventActionInputs, type EventActionDefinitionV1 } from '../../../packages/kernel/events';
import { prepareWorkflowInvocation } from '../workflows/catalog';
import { readModelProfile } from '../models/model-profile-store';
import { readModelInstructionTemplate, readModelOutputSchema } from '../models/model-decision-artifact-store';
import { readEventActionDefinition } from './event-action-registry-store';
import type { EventRuleMatch } from './event-rule-store';

export interface EventAutomationActionPlanV1 {
  schemaVersion: 1;
  ruleId: string;
  ruleRevision: number;
  routeId: string;
  actionRef: string;
  actionRevision?: number;
  inputs: Record<string, EventRuleJson>;
  readiness: 'ready' | 'blocked';
  blocker?: string;
  handler?:
    | {
        kind: 'workflow';
        workflowId: string;
        version: string;
        contentDigest: string;
        engine: 'sequence_v1' | 'graph_v2';
      }
    | { kind: 'capability'; capabilityId: string }
    | {
        kind: 'model';
        modelProfileId: string;
        modelProfileRevision: number;
        instructionTemplateId: string;
        outputSchemaId: string;
      }
    | { kind: 'emit_event'; source: string; eventType: string };
  authorization: {
    state: 'not_authorized';
    risk?: EventActionDefinitionV1['authorization']['risk'];
    requiresApproval?: boolean;
  };
  execution: 'not_executed';
}

function blocked(
  match: EventRuleMatch,
  routeId: string,
  actionRef: string,
  inputs: Record<string, EventRuleJson>,
  reason: string,
): EventAutomationActionPlanV1 {
  return {
    schemaVersion: 1,
    ruleId: match.ruleId,
    ruleRevision: match.evaluation.revision,
    routeId,
    actionRef,
    inputs,
    readiness: 'blocked',
    blocker: reason,
    authorization: { state: 'not_authorized' },
    execution: 'not_executed',
  };
}

function workflowHandler(
  controllerHome: string,
  definition: EventActionDefinitionV1,
  inputs: Record<string, EventRuleJson>,
): EventAutomationActionPlanV1['handler'] {
  if (definition.handler.kind !== 'workflow') throw new Error('EVENT_AUTOMATION_HANDLER_KIND_MISMATCH');
  const scope =
    definition.handler.registryScope.kind === 'controller'
      ? ({ kind: 'controller' } as const)
      : ({ kind: 'project', projectId: definition.handler.registryScope.projectId } as const);
  let invocation: ReturnType<typeof prepareWorkflowInvocation>;
  try {
    invocation = prepareWorkflowInvocation({
      controllerHome,
      scope,
      workflowId: definition.handler.workflowId,
      origin: { kind: 'event', id: definition.actionRef },
      inputs,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'WORKFLOW_CATALOG_FAILED';
    if (message.startsWith('WORKFLOW_CATALOG_ENTRY_NOT_FOUND:'))
      throw new Error('EVENT_AUTOMATION_WORKFLOW_NOT_FOUND:' + definition.handler.workflowId);
    throw error;
  }
  if (invocation.readiness !== 'ready') {
    throw new Error(`EVENT_AUTOMATION_WORKFLOW_BLOCKED:${invocation.blockers.join('|')}`);
  }
  return {
    kind: 'workflow',
    workflowId: invocation.workflow.workflowId,
    version: invocation.workflow.version,
    contentDigest: invocation.workflow.contentDigest,
    engine: invocation.workflow.engine,
  };
}

function modelHandler(
  controllerHome: string,
  definition: EventActionDefinitionV1,
): EventAutomationActionPlanV1['handler'] {
  if (definition.handler.kind !== 'model') throw new Error('EVENT_AUTOMATION_HANDLER_KIND_MISMATCH');
  const profile = readModelProfile(controllerHome, definition.handler.modelProfileId);
  if (!profile) throw new Error('EVENT_AUTOMATION_MODEL_PROFILE_NOT_FOUND:' + definition.handler.modelProfileId);
  if (!profile.value.enabled)
    throw new Error('EVENT_AUTOMATION_MODEL_PROFILE_DISABLED:' + definition.handler.modelProfileId);
  const templateId = definition.handler.instructionTemplateId ?? profile.value.instructionTemplateId;
  const outputSchemaId = definition.handler.outputSchemaId ?? profile.value.outputSchemaId;
  if (!readModelInstructionTemplate(controllerHome, templateId))
    throw new Error('EVENT_AUTOMATION_MODEL_TEMPLATE_NOT_FOUND:' + templateId);
  if (!readModelOutputSchema(controllerHome, outputSchemaId))
    throw new Error('EVENT_AUTOMATION_MODEL_SCHEMA_NOT_FOUND:' + outputSchemaId);
  return {
    kind: 'model',
    modelProfileId: profile.value.profileId,
    modelProfileRevision: profile.value.revision,
    instructionTemplateId: templateId,
    outputSchemaId,
  };
}

function resolveHandler(
  controllerHome: string,
  definition: EventActionDefinitionV1,
  inputs: Record<string, EventRuleJson>,
): EventAutomationActionPlanV1['handler'] {
  switch (definition.handler.kind) {
    case 'workflow':
      return workflowHandler(controllerHome, definition, inputs);
    case 'model':
      return modelHandler(controllerHome, definition);
    case 'capability':
      return { kind: 'capability', capabilityId: definition.handler.capabilityId };
    case 'emit_event':
      return { kind: 'emit_event', source: definition.handler.source, eventType: definition.handler.eventType };
  }
}

/** Resolve config references only. Authorization and side effects remain with the referenced handler owner. */
export function buildEventAutomationPlans(
  controllerHome: string,
  matches: EventRuleMatch[],
): EventAutomationActionPlanV1[] {
  const plans: EventAutomationActionPlanV1[] = [];
  for (const match of matches) {
    for (const action of match.evaluation.actions) {
      const definitionRecord = readEventActionDefinition(controllerHome, action.actionRef);
      if (!definitionRecord) {
        plans.push(
          blocked(
            match,
            action.routeId,
            action.actionRef,
            action.inputs,
            'EVENT_AUTOMATION_ACTION_NOT_FOUND:' + action.actionRef,
          ),
        );
        continue;
      }
      const definition = definitionRecord.value;
      if (!definition.enabled) {
        plans.push(
          blocked(
            match,
            action.routeId,
            action.actionRef,
            action.inputs,
            'EVENT_AUTOMATION_ACTION_DISABLED:' + action.actionRef,
          ),
        );
        continue;
      }
      try {
        const inputs = validateEventActionInputs(definition, action.inputs);
        const handler = resolveHandler(controllerHome, definition, inputs);
        plans.push({
          schemaVersion: 1,
          ruleId: match.ruleId,
          ruleRevision: match.evaluation.revision,
          routeId: action.routeId,
          actionRef: action.actionRef,
          actionRevision: definition.revision,
          inputs,
          readiness: 'ready',
          handler,
          authorization: {
            state: 'not_authorized',
            risk: definition.authorization.risk,
            requiresApproval: definition.authorization.requiresApproval,
          },
          execution: 'not_executed',
        });
      } catch (error) {
        plans.push(
          blocked(
            match,
            action.routeId,
            action.actionRef,
            action.inputs,
            error instanceof Error ? error.message : 'EVENT_AUTOMATION_RESOLUTION_FAILED',
          ),
        );
      }
    }
  }
  return plans;
}
