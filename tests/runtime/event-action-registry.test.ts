import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  validateEventActionDefinitionV1,
  validateEventActionInputs,
  type EventActionDefinitionV1,
} from '../../packages/kernel/events';
import {
  createEventActionDefinition,
  listEventActionDefinitions,
  readEventActionDefinition,
  updateEventActionDefinition,
} from '../../src/runtime/events/event-action-registry-store';

const roots: string[] = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});
function home() {
  const v = mkdtempSync(join(tmpdir(), 'forge-event-actions-'));
  roots.push(v);
  return v;
}
const workflowAction: EventActionDefinitionV1 = {
  schemaVersion: 1,
  actionRef: 'workflow.asc-followup',
  revision: 1,
  enabled: true,
  title: 'ASC follow-up workflow',
  handler: { kind: 'workflow', workflowId: 'asc.followup', registryScope: { kind: 'controller' } },
  inputContract: { message_id: { type: 'string', required: true }, sender: { type: 'string', required: true } },
  authorization: { risk: 'workspace_write', requiresApproval: false },
};

describe('Event Action Registry', () => {
  test('defines workflow, capability, model and event actions without changing rule engine code', () => {
    expect(validateEventActionDefinitionV1(workflowAction).handler.kind).toBe('workflow');
    expect(
      validateEventActionDefinitionV1({
        ...workflowAction,
        actionRef: 'notification.owner',
        handler: { kind: 'capability', capabilityId: 'owner.notification' },
      }).handler.kind,
    ).toBe('capability');
    expect(
      validateEventActionDefinitionV1({
        ...workflowAction,
        actionRef: 'model.classify',
        handler: {
          kind: 'model',
          modelProfileId: 'fast',
          instructionTemplateId: 'mail-v1',
          outputSchemaId: 'decision-v1',
        },
      }).handler.kind,
    ).toBe('model');
    expect(
      validateEventActionDefinitionV1({
        ...workflowAction,
        actionRef: 'event.followup',
        handler: { kind: 'emit_event', source: 'forge.rule', eventType: 'followup.requested' },
      }).handler.kind,
    ).toBe('emit_event');
  });
  test('persists and versions action definitions', () => {
    const h = home();
    createEventActionDefinition(h, workflowAction);
    expect(readEventActionDefinition(h, workflowAction.actionRef)?.value).toEqual(workflowAction);
    expect(listEventActionDefinitions(h).map((x) => x.value.actionRef)).toEqual(['workflow.asc-followup']);
    const updated = updateEventActionDefinition(h, workflowAction.actionRef, 1, (current) => ({
      ...current,
      revision: 2,
      title: 'ASC workflow v2',
    }));
    expect(updated.value.revision).toBe(2);
    expect(() => updateEventActionDefinition(h, workflowAction.actionRef, 1, (current) => current)).toThrow(
      'EVENT_ACTION_REVISION_CONFLICT',
    );
  });
  test('validates route inputs against configurable action contracts', () => {
    expect(validateEventActionInputs(workflowAction, { message_id: 'm1', sender: 'apple@example.com' })).toEqual({
      message_id: 'm1',
      sender: 'apple@example.com',
    });
    expect(() => validateEventActionInputs(workflowAction, { message_id: 'm1' })).toThrow(
      'EVENT_ACTION_INPUT_REQUIRED:sender',
    );
    expect(() => validateEventActionInputs(workflowAction, { message_id: 'm1', sender: 'a', extra: true })).toThrow(
      'EVENT_ACTION_INPUT_UNKNOWN:extra',
    );
  });
  test('requires approval metadata for sensitive actions', () => {
    expect(() =>
      validateEventActionDefinitionV1({
        ...workflowAction,
        actionRef: 'mail.send',
        handler: { kind: 'capability', capabilityId: 'mail.send' },
        authorization: { risk: 'external_write', requiresApproval: false },
      }),
    ).toThrow('EVENT_ACTION_SENSITIVE_APPROVAL_REQUIRED');
  });
  test('keeps action references immutable', () => {
    const h = home();
    createEventActionDefinition(h, workflowAction);
    expect(() =>
      updateEventActionDefinition(h, workflowAction.actionRef, 1, (current) => ({
        ...current,
        revision: 2,
        actionRef: 'other',
      })),
    ).toThrow('EVENT_ACTION_REF_IMMUTABLE');
  });
});
