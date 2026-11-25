import {
  listControlPlaneRecords,
  readControlPlaneRecord,
  writeControlPlaneRecord,
  type ControlPlaneRecord,
} from '../control-plane/persistence/sqlite-store';
import {
  validateModelInstructionTemplateV1,
  validateModelOutputSchemaV1,
  type ModelInstructionTemplateV1,
  type ModelOutputSchemaV1,
} from '../../../packages/kernel/models';

const TEMPLATE_NAMESPACE = 'model_instruction_template';
const SCHEMA_NAMESPACE = 'model_output_schema';
const SCOPE = 'global';

function validateRecord<T extends { revision: number }>(
  record: ControlPlaneRecord<unknown>,
  id: string,
  validate: (value: unknown) => T,
  identity: (value: T) => string,
  mismatchCode: string,
): ControlPlaneRecord<T> {
  const value = validate(record.value);
  if (record.key !== id || identity(value) !== id) throw new Error(mismatchCode);
  return { ...record, value };
}

export function createModelInstructionTemplate(
  controllerHome: string,
  input: unknown,
): ControlPlaneRecord<ModelInstructionTemplateV1> {
  const value = validateModelInstructionTemplateV1(input);
  if (value.revision !== 1) throw new Error('MODEL_INSTRUCTION_TEMPLATE_CREATE_REVISION_INVALID');
  return writeControlPlaneRecord(controllerHome, {
    namespace: TEMPLATE_NAMESPACE,
    scope: SCOPE,
    key: value.templateId,
    schemaVersion: 1,
    value,
    action: 'model_instruction_template_created',
    expectedRevision: null,
  });
}

export function readModelInstructionTemplate(
  controllerHome: string,
  templateId: string,
): ControlPlaneRecord<ModelInstructionTemplateV1> | undefined {
  const record = readControlPlaneRecord<unknown>(controllerHome, TEMPLATE_NAMESPACE, SCOPE, templateId);
  return record
    ? validateRecord(
        record,
        templateId,
        validateModelInstructionTemplateV1,
        (value) => value.templateId,
        'MODEL_INSTRUCTION_TEMPLATE_KEY_MISMATCH',
      )
    : undefined;
}

export function listModelInstructionTemplates(
  controllerHome: string,
  limit = 256,
): ControlPlaneRecord<ModelInstructionTemplateV1>[] {
  return listControlPlaneRecords<unknown>(controllerHome, {
    namespace: TEMPLATE_NAMESPACE,
    scope: SCOPE,
    limit: Math.max(1, Math.min(Math.trunc(limit), 1_000)),
  }).map((record) =>
    validateRecord(
      record,
      record.key,
      validateModelInstructionTemplateV1,
      (value) => value.templateId,
      'MODEL_INSTRUCTION_TEMPLATE_KEY_MISMATCH',
    ),
  );
}

export function updateModelInstructionTemplate(
  controllerHome: string,
  templateId: string,
  expectedRecordRevision: number,
  mutate: (current: ModelInstructionTemplateV1) => ModelInstructionTemplateV1,
): ControlPlaneRecord<ModelInstructionTemplateV1> {
  const current = readModelInstructionTemplate(controllerHome, templateId);
  if (!current) throw new Error('MODEL_INSTRUCTION_TEMPLATE_NOT_FOUND: ' + templateId);
  if (current.revision !== expectedRecordRevision) throw new Error('MODEL_INSTRUCTION_TEMPLATE_REVISION_CONFLICT');
  const next = validateModelInstructionTemplateV1(mutate(structuredClone(current.value)));
  if (next.templateId !== templateId) throw new Error('MODEL_INSTRUCTION_TEMPLATE_ID_IMMUTABLE');
  if (next.revision !== current.value.revision + 1)
    throw new Error('MODEL_INSTRUCTION_TEMPLATE_LOGICAL_REVISION_INVALID');
  return writeControlPlaneRecord(controllerHome, {
    namespace: TEMPLATE_NAMESPACE,
    scope: SCOPE,
    key: templateId,
    schemaVersion: 1,
    value: next,
    action: 'model_instruction_template_updated',
    expectedRevision: current.revision,
  });
}

export function createModelOutputSchema(
  controllerHome: string,
  input: unknown,
): ControlPlaneRecord<ModelOutputSchemaV1> {
  const value = validateModelOutputSchemaV1(input);
  if (value.revision !== 1) throw new Error('MODEL_OUTPUT_SCHEMA_CREATE_REVISION_INVALID');
  return writeControlPlaneRecord(controllerHome, {
    namespace: SCHEMA_NAMESPACE,
    scope: SCOPE,
    key: value.schemaId,
    schemaVersion: 1,
    value,
    action: 'model_output_schema_created',
    expectedRevision: null,
  });
}

export function readModelOutputSchema(
  controllerHome: string,
  schemaId: string,
): ControlPlaneRecord<ModelOutputSchemaV1> | undefined {
  const record = readControlPlaneRecord<unknown>(controllerHome, SCHEMA_NAMESPACE, SCOPE, schemaId);
  return record
    ? validateRecord(
        record,
        schemaId,
        validateModelOutputSchemaV1,
        (value) => value.schemaId,
        'MODEL_OUTPUT_SCHEMA_KEY_MISMATCH',
      )
    : undefined;
}

export function listModelOutputSchemas(controllerHome: string, limit = 256): ControlPlaneRecord<ModelOutputSchemaV1>[] {
  return listControlPlaneRecords<unknown>(controllerHome, {
    namespace: SCHEMA_NAMESPACE,
    scope: SCOPE,
    limit: Math.max(1, Math.min(Math.trunc(limit), 1_000)),
  }).map((record) =>
    validateRecord(
      record,
      record.key,
      validateModelOutputSchemaV1,
      (value) => value.schemaId,
      'MODEL_OUTPUT_SCHEMA_KEY_MISMATCH',
    ),
  );
}

export function updateModelOutputSchema(
  controllerHome: string,
  schemaId: string,
  expectedRecordRevision: number,
  mutate: (current: ModelOutputSchemaV1) => ModelOutputSchemaV1,
): ControlPlaneRecord<ModelOutputSchemaV1> {
  const current = readModelOutputSchema(controllerHome, schemaId);
  if (!current) throw new Error('MODEL_OUTPUT_SCHEMA_NOT_FOUND: ' + schemaId);
  if (current.revision !== expectedRecordRevision) throw new Error('MODEL_OUTPUT_SCHEMA_REVISION_CONFLICT');
  const next = validateModelOutputSchemaV1(mutate(structuredClone(current.value)));
  if (next.schemaId !== schemaId) throw new Error('MODEL_OUTPUT_SCHEMA_ID_IMMUTABLE');
  if (next.revision !== current.value.revision + 1) throw new Error('MODEL_OUTPUT_SCHEMA_LOGICAL_REVISION_INVALID');
  return writeControlPlaneRecord(controllerHome, {
    namespace: SCHEMA_NAMESPACE,
    scope: SCOPE,
    key: schemaId,
    schemaVersion: 1,
    value: next,
    action: 'model_output_schema_updated',
    expectedRevision: current.revision,
  });
}
