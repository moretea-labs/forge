import { isDeepStrictEqual } from 'node:util';
import { validateEventRuleV1, type EventActionDefinitionV1, type EventRuleV1 } from '../../../packages/kernel/events';
import { readWorkflowRegistryEntry } from '../control-plane/persistence/workflow-registry-store';
import { readModelInstructionTemplate, readModelOutputSchema } from '../models/model-decision-artifact-store';
import { readModelProfile } from '../models/model-profile-store';
import { readEventActionDefinition } from './event-action-registry-store';
import { createEventRule, readEventRule, updateEventRule } from './event-rule-store';

export type EventRuleProposalAuthorKind = 'human' | 'ui' | 'model' | 'import';

export interface EventRuleDraftProposalV1 {
  schemaVersion: 1;
  proposalId: string;
  author: { kind: EventRuleProposalAuthorKind; id: string };
  operation: { kind: 'create' } | { kind: 'update'; ruleId: string; expectedRecordRevision: number };
  rule: EventRuleV1;
}

export interface EventRuleProposalIssue {
  code: string;
  path?: string;
  message: string;
}

export interface EventRuleProposalPreflight {
  schemaVersion: 1;
  proposalId: string;
  author: EventRuleDraftProposalV1['author'];
  operation: EventRuleDraftProposalV1['operation'];
  rule: EventRuleV1;
  valid: boolean;
  issues: EventRuleProposalIssue[];
  actionRefs: string[];
  sensitiveActionRefs: string[];
}

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const AUTHOR_KINDS = new Set<EventRuleProposalAuthorKind>(['human', 'ui', 'model', 'import']);

function boundedIdentifier(value: unknown, code: string): string {
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) throw new Error(code);
  return value;
}

function validateProposal(input: unknown): EventRuleDraftProposalV1 {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('EVENT_RULE_PROPOSAL_INVALID');
  const value = input as Record<string, unknown>;
  const allowed = new Set(['schemaVersion', 'proposalId', 'author', 'operation', 'rule']);
  if (Object.keys(value).some((key) => !allowed.has(key))) throw new Error('EVENT_RULE_PROPOSAL_FIELD_UNSUPPORTED');
  if (value.schemaVersion !== 1) throw new Error('EVENT_RULE_PROPOSAL_SCHEMA_VERSION_UNSUPPORTED');
  const proposalId = boundedIdentifier(value.proposalId, 'EVENT_RULE_PROPOSAL_ID_INVALID');
  if (!value.author || typeof value.author !== 'object' || Array.isArray(value.author))
    throw new Error('EVENT_RULE_PROPOSAL_AUTHOR_INVALID');
  const author = value.author as Record<string, unknown>;
  if (!AUTHOR_KINDS.has(author.kind as EventRuleProposalAuthorKind))
    throw new Error('EVENT_RULE_PROPOSAL_AUTHOR_KIND_INVALID');
  const authorId = boundedIdentifier(author.id, 'EVENT_RULE_PROPOSAL_AUTHOR_ID_INVALID');
  if (!value.operation || typeof value.operation !== 'object' || Array.isArray(value.operation))
    throw new Error('EVENT_RULE_PROPOSAL_OPERATION_INVALID');
  const operation = value.operation as Record<string, unknown>;
  let normalizedOperation: EventRuleDraftProposalV1['operation'];
  if (operation.kind === 'create') {
    if (Object.keys(operation).some((key) => !['kind'].includes(key)))
      throw new Error('EVENT_RULE_PROPOSAL_OPERATION_FIELD_UNSUPPORTED');
    normalizedOperation = { kind: 'create' };
  } else if (operation.kind === 'update') {
    if (Object.keys(operation).some((key) => !['kind', 'ruleId', 'expectedRecordRevision'].includes(key)))
      throw new Error('EVENT_RULE_PROPOSAL_OPERATION_FIELD_UNSUPPORTED');
    const ruleId = boundedIdentifier(operation.ruleId, 'EVENT_RULE_PROPOSAL_RULE_ID_INVALID');
    if (!Number.isSafeInteger(operation.expectedRecordRevision) || Number(operation.expectedRecordRevision) < 1)
      throw new Error('EVENT_RULE_PROPOSAL_RECORD_REVISION_INVALID');
    normalizedOperation = { kind: 'update', ruleId, expectedRecordRevision: Number(operation.expectedRecordRevision) };
  } else {
    throw new Error('EVENT_RULE_PROPOSAL_OPERATION_KIND_INVALID');
  }
  return {
    schemaVersion: 1,
    proposalId,
    author: { kind: author.kind as EventRuleProposalAuthorKind, id: authorId },
    operation: normalizedOperation,
    rule: validateEventRuleV1(value.rule),
  };
}

function issue(code: string, message: string, path?: string): EventRuleProposalIssue {
  return { code, ...(path ? { path } : {}), message };
}

function validateStaticInputs(
  definition: EventActionDefinitionV1,
  route: EventRuleV1['routes'][number],
): EventRuleProposalIssue[] {
  const issues: EventRuleProposalIssue[] = [];
  const supplied = new Set(Object.keys(route.action.inputs ?? {}));
  const contract = definition.inputContract ?? {};
  for (const name of supplied) {
    if (!Object.hasOwn(contract, name)) {
      issues.push(
        issue(
          'EVENT_RULE_ACTION_INPUT_UNKNOWN',
          `Action ${definition.actionRef} does not declare input ${name}.`,
          `routes.${route.routeId}.action.inputs.${name}`,
        ),
      );
    }
  }
  for (const [name, spec] of Object.entries(contract)) {
    if (spec.required && spec.default === undefined && !supplied.has(name)) {
      issues.push(
        issue(
          'EVENT_RULE_ACTION_INPUT_REQUIRED',
          `Action ${definition.actionRef} requires input ${name}.`,
          `routes.${route.routeId}.action.inputs.${name}`,
        ),
      );
    }
  }
  return issues;
}

function validateHandlerReferences(
  controllerHome: string,
  definition: EventActionDefinitionV1,
  routeId: string,
): EventRuleProposalIssue[] {
  const handler = definition.handler;
  if (handler.kind === 'workflow') {
    const scope =
      handler.registryScope.kind === 'controller'
        ? ({ kind: 'controller' } as const)
        : ({ kind: 'project', projectId: handler.registryScope.projectId } as const);
    const workflow = readWorkflowRegistryEntry(controllerHome, scope, handler.workflowId);
    if (!workflow)
      return [
        issue(
          'EVENT_RULE_WORKFLOW_NOT_FOUND',
          `Workflow ${handler.workflowId} is not registered.`,
          `routes.${routeId}.action.actionRef`,
        ),
      ];
    if (workflow.value.status !== 'active')
      return [
        issue(
          'EVENT_RULE_WORKFLOW_NOT_ACTIVE',
          `Workflow ${handler.workflowId} is not active.`,
          `routes.${routeId}.action.actionRef`,
        ),
      ];
    return [];
  }
  if (handler.kind !== 'model') return [];
  const profile = readModelProfile(controllerHome, handler.modelProfileId);
  if (!profile)
    return [
      issue(
        'EVENT_RULE_MODEL_PROFILE_NOT_FOUND',
        `Model profile ${handler.modelProfileId} is not registered.`,
        `routes.${routeId}.action.actionRef`,
      ),
    ];
  if (!profile.value.enabled)
    return [
      issue(
        'EVENT_RULE_MODEL_PROFILE_DISABLED',
        `Model profile ${handler.modelProfileId} is disabled.`,
        `routes.${routeId}.action.actionRef`,
      ),
    ];
  const templateId = handler.instructionTemplateId ?? profile.value.instructionTemplateId;
  const schemaId = handler.outputSchemaId ?? profile.value.outputSchemaId;
  const issues: EventRuleProposalIssue[] = [];
  if (!readModelInstructionTemplate(controllerHome, templateId))
    issues.push(
      issue(
        'EVENT_RULE_MODEL_TEMPLATE_NOT_FOUND',
        `Instruction template ${templateId} is not registered.`,
        `routes.${routeId}.action.actionRef`,
      ),
    );
  if (!readModelOutputSchema(controllerHome, schemaId))
    issues.push(
      issue(
        'EVENT_RULE_MODEL_SCHEMA_NOT_FOUND',
        `Output schema ${schemaId} is not registered.`,
        `routes.${routeId}.action.actionRef`,
      ),
    );
  return issues;
}

function validateOperation(controllerHome: string, proposal: EventRuleDraftProposalV1): EventRuleProposalIssue[] {
  const current = readEventRule(controllerHome, proposal.rule.ruleId);
  if (proposal.operation.kind === 'create') {
    const issues: EventRuleProposalIssue[] = [];
    if (proposal.rule.revision !== 1)
      issues.push(
        issue('EVENT_RULE_CREATE_REVISION_INVALID', 'New rules must start at logical revision 1.', 'rule.revision'),
      );
    if (current)
      issues.push(issue('EVENT_RULE_ALREADY_EXISTS', `Rule ${proposal.rule.ruleId} already exists.`, 'rule.ruleId'));
    return issues;
  }
  const issues: EventRuleProposalIssue[] = [];
  if (proposal.operation.ruleId !== proposal.rule.ruleId)
    issues.push(
      issue('EVENT_RULE_UPDATE_ID_MISMATCH', 'Update operation ruleId must match rule.ruleId.', 'operation.ruleId'),
    );
  if (!current) {
    issues.push(issue('EVENT_RULE_NOT_FOUND', `Rule ${proposal.rule.ruleId} does not exist.`, 'rule.ruleId'));
    return issues;
  }
  if (current.revision !== proposal.operation.expectedRecordRevision)
    issues.push(
      issue(
        'EVENT_RULE_REVISION_CONFLICT',
        'Stored record revision changed since this proposal was authored.',
        'operation.expectedRecordRevision',
      ),
    );
  if (proposal.rule.revision !== current.value.revision + 1)
    issues.push(
      issue(
        'EVENT_RULE_LOGICAL_REVISION_INVALID',
        'Updated rule logical revision must increment by exactly one.',
        'rule.revision',
      ),
    );
  return issues;
}

/** Same deterministic preflight for human, UI, model and import rule authors. No side effects. */
export function preflightEventRuleProposal(controllerHome: string, input: unknown): EventRuleProposalPreflight {
  const proposal = validateProposal(input);
  const issues = validateOperation(controllerHome, proposal);
  const actionRefs = new Set<string>();
  const sensitiveActionRefs = new Set<string>();
  // Users must always be able to disable an unchanged active rule even when
  // its old action/provider has become unavailable. Only the enabled bit and
  // required logical revision may change; re-enabling or editing a disabled
  // rule still validates every route and authorization.
  const previous =
    proposal.operation.kind === 'update' ? readEventRule(controllerHome, proposal.operation.ruleId) : undefined;
  const pureDisable =
    previous?.value.enabled === true &&
    proposal.rule.enabled === false &&
    isDeepStrictEqual({ ...previous.value, enabled: false, revision: previous.value.revision + 1 }, proposal.rule);
  for (const route of proposal.rule.routes) {
    if (pureDisable) {
      actionRefs.add(route.action.actionRef);
      continue;
    }
    actionRefs.add(route.action.actionRef);
    const record = readEventActionDefinition(controllerHome, route.action.actionRef);
    if (!record) {
      issues.push(
        issue(
          'EVENT_RULE_ACTION_NOT_FOUND',
          `Action ${route.action.actionRef} is not registered.`,
          `routes.${route.routeId}.action.actionRef`,
        ),
      );
      continue;
    }
    const definition = record.value;
    if (!definition.enabled)
      issues.push(
        issue(
          'EVENT_RULE_ACTION_DISABLED',
          `Action ${definition.actionRef} is disabled.`,
          `routes.${route.routeId}.action.actionRef`,
        ),
      );
    if (definition.authorization.risk === 'external_write' || definition.authorization.risk === 'destructive')
      sensitiveActionRefs.add(definition.actionRef);
    issues.push(...validateStaticInputs(definition, route));
    issues.push(...validateHandlerReferences(controllerHome, definition, route.routeId));
  }
  return {
    schemaVersion: 1,
    proposalId: proposal.proposalId,
    author: proposal.author,
    operation: proposal.operation,
    rule: proposal.rule,
    valid: issues.length === 0,
    issues,
    actionRefs: [...actionRefs].sort(),
    sensitiveActionRefs: [...sensitiveActionRefs].sort(),
  };
}

export interface EventRuleProposalApplyAuthorization {
  canWriteRules: boolean;
  canEnableRules: boolean;
  approvedSensitiveActionRefs?: string[];
}

/** Apply only a clean preflight. Author identity never grants permission by itself. */
export function applyEventRuleProposal(
  controllerHome: string,
  input: unknown,
  authorization: EventRuleProposalApplyAuthorization,
) {
  if (!authorization.canWriteRules) throw new Error('EVENT_RULE_AUTHORING_WRITE_NOT_AUTHORIZED');
  const preflight = preflightEventRuleProposal(controllerHome, input);
  if (!preflight.valid) throw new Error('EVENT_RULE_PROPOSAL_PREFLIGHT_FAILED');
  if (preflight.rule.enabled && !authorization.canEnableRules)
    throw new Error('EVENT_RULE_AUTHORING_ENABLE_NOT_AUTHORIZED');
  const approved = new Set(authorization.approvedSensitiveActionRefs ?? []);
  const unapproved = preflight.sensitiveActionRefs.filter((ref) => !approved.has(ref));
  if (preflight.rule.enabled && unapproved.length > 0)
    throw new Error('EVENT_RULE_AUTHORING_SENSITIVE_ACTION_APPROVAL_REQUIRED:' + unapproved.join(','));
  if (preflight.operation.kind === 'create') return createEventRule(controllerHome, preflight.rule);
  return updateEventRule(controllerHome, preflight.rule.ruleId, preflight.operation.expectedRecordRevision, () =>
    structuredClone(preflight.rule),
  );
}
