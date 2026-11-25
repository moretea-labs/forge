import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createModelInstructionTemplate,
  createModelOutputSchema,
  listModelInstructionTemplates,
  listModelOutputSchemas,
  readModelInstructionTemplate,
  readModelOutputSchema,
  updateModelInstructionTemplate,
  updateModelOutputSchema,
} from '../../src/runtime/models/model-decision-artifact-store';

const roots: string[] = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});
function home(): string {
  const value = mkdtempSync(join(tmpdir(), 'forge-model-decision-artifacts-'));
  roots.push(value);
  return value;
}
const template = {
  schemaVersion: 1 as const,
  templateId: 'mail-triage-v1',
  revision: 1,
  content: 'Classify the event facts and return only the configured schema.',
};
const output = {
  schemaVersion: 1 as const,
  schemaId: 'event-decision-v1',
  revision: 1,
  jsonSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['outcome'],
    properties: { outcome: { enum: ['act', 'ignore', 'needs_review'] } },
  },
};

describe('Model decision artifact persistence', () => {
  test('creates, reads and lists instruction templates and output schemas independently', () => {
    const controllerHome = home();
    createModelInstructionTemplate(controllerHome, template);
    createModelOutputSchema(controllerHome, output);
    expect(readModelInstructionTemplate(controllerHome, template.templateId)?.value).toEqual(template);
    expect(readModelOutputSchema(controllerHome, output.schemaId)?.value).toEqual(output);
    expect(listModelInstructionTemplates(controllerHome).map((record) => record.value.templateId)).toEqual([
      template.templateId,
    ]);
    expect(listModelOutputSchemas(controllerHome).map((record) => record.value.schemaId)).toEqual([output.schemaId]);
  });

  test('updates artifacts with optimistic record revision and monotonic logical revision', () => {
    const controllerHome = home();
    createModelInstructionTemplate(controllerHome, template);
    createModelOutputSchema(controllerHome, output);
    const updatedTemplate = updateModelInstructionTemplate(controllerHome, template.templateId, 1, (current) => ({
      ...current,
      revision: 2,
      content: 'Updated configured instruction.',
    }));
    const updatedSchema = updateModelOutputSchema(controllerHome, output.schemaId, 1, (current) => ({
      ...current,
      revision: 2,
      jsonSchema: { ...current.jsonSchema, title: 'Event decision v2' },
    }));
    expect(updatedTemplate.revision).toBe(2);
    expect(updatedTemplate.value.revision).toBe(2);
    expect(updatedSchema.revision).toBe(2);
    expect(updatedSchema.value.revision).toBe(2);
    expect(() => updateModelInstructionTemplate(controllerHome, template.templateId, 1, (current) => current)).toThrow(
      'MODEL_INSTRUCTION_TEMPLATE_REVISION_CONFLICT',
    );
    expect(() => updateModelOutputSchema(controllerHome, output.schemaId, 1, (current) => current)).toThrow(
      'MODEL_OUTPUT_SCHEMA_REVISION_CONFLICT',
    );
  });

  test('keeps IDs immutable and rejects unsupported schema references', () => {
    const controllerHome = home();
    createModelInstructionTemplate(controllerHome, template);
    createModelOutputSchema(controllerHome, output);
    expect(() =>
      updateModelInstructionTemplate(controllerHome, template.templateId, 1, (current) => ({
        ...current,
        revision: 2,
        templateId: 'other',
      })),
    ).toThrow('MODEL_INSTRUCTION_TEMPLATE_ID_IMMUTABLE');
    expect(() =>
      updateModelOutputSchema(controllerHome, output.schemaId, 1, (current) => ({
        ...current,
        revision: 2,
        schemaId: 'other',
      })),
    ).toThrow('MODEL_OUTPUT_SCHEMA_ID_IMMUTABLE');
    expect(() =>
      createModelOutputSchema(controllerHome, {
        ...output,
        schemaId: 'remote-ref',
        jsonSchema: { $ref: 'https://example.com/schema.json' },
      }),
    ).toThrow('MODEL_OUTPUT_SCHEMA_REMOTE_REFERENCE_UNSUPPORTED');
  });

  test('requires logical revision 1 for creation', () => {
    const controllerHome = home();
    expect(() => createModelInstructionTemplate(controllerHome, { ...template, revision: 2 })).toThrow(
      'MODEL_INSTRUCTION_TEMPLATE_CREATE_REVISION_INVALID',
    );
    expect(() => createModelOutputSchema(controllerHome, { ...output, revision: 2 })).toThrow(
      'MODEL_OUTPUT_SCHEMA_CREATE_REVISION_INVALID',
    );
  });
});
