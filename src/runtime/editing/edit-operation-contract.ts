export const EDIT_OPERATION_TYPES = [
  'create',
  'write',
  'replace',
  'insert_before',
  'insert_after',
  'prepend',
  'append',
  'delete',
] as const;

export type EditOperation =
  | { type: 'create'; path: string; content: string }
  | { type: 'write'; path: string; expectedSha256: string; content: string }
  | { type: 'replace'; path: string; expectedSha256: string; replacements: Array<{ oldText: string; newText: string; replaceAll?: boolean }> }
  | { type: 'insert_before' | 'insert_after'; path: string; expectedSha256: string; anchor: string; content: string; occurrence?: number }
  | { type: 'prepend' | 'append'; path: string; expectedSha256: string; content: string }
  | { type: 'delete'; path: string; expectedSha256: string };

export const EDIT_OPERATION_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    type: { type: 'string', enum: [...EDIT_OPERATION_TYPES] },
    path: { type: 'string' },
    content: { type: 'string' },
    expected_sha256: { type: 'string' },
    anchor: { type: 'string', description: 'Anchor text for insert_before or insert_after.' },
    occurrence: { type: 'number', description: '1-based anchor occurrence; defaults to 1.' },
    replacements: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          old_text: { type: 'string' },
          new_text: { type: 'string' },
          replace_all: { type: 'boolean' },
        },
        required: ['old_text', 'new_text'],
        additionalProperties: false,
      },
    },
  },
  required: ['type', 'path'],
  additionalProperties: false,
} as const;

function objectEntries(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null && !Array.isArray(entry));
}

function normalizeReplacements(value: unknown): Array<{ oldText: string; newText: string; replaceAll?: boolean }> {
  return objectEntries(value).map((replacement) => ({
    oldText: String(replacement.old_text ?? replacement.oldText ?? ''),
    newText: String(replacement.new_text ?? replacement.newText ?? ''),
    replaceAll: replacement.replace_all === true || replacement.replaceAll === true,
  }));
}

export function normalizeEditOperation(entry: Record<string, unknown>): EditOperation {
  const type = String(entry.type ?? '');
  const path = String(entry.path ?? '');
  const expectedSha256 = String(entry.expected_sha256 ?? entry.expectedSha256 ?? '');
  if (type === 'create') return { type, path, content: String(entry.content ?? '') };
  if (type === 'delete') return { type, path, expectedSha256 };
  if (type === 'write') return { type, path, expectedSha256, content: String(entry.content ?? '') };
  if (type === 'replace') {
    const replacements = Array.isArray(entry.replacements)
      ? normalizeReplacements(entry.replacements)
      : (entry.old_text !== undefined || entry.oldText !== undefined)
        ? normalizeReplacements([entry])
        : [];
    if (replacements.length === 0) throw new Error('replace requires replacements[] or old_text/new_text');
    return { type, path, expectedSha256, replacements };
  }
  if (type === 'insert_before' || type === 'insert_after') {
    return {
      type,
      path,
      expectedSha256,
      anchor: String(entry.anchor ?? ''),
      content: String(entry.content ?? ''),
      occurrence: typeof entry.occurrence === 'number' ? Math.trunc(entry.occurrence) : undefined,
    };
  }
  if (type === 'prepend' || type === 'append') return { type, path, expectedSha256, content: String(entry.content ?? '') };
  throw new Error(`invalid edit operation type: ${type}`);
}

export function normalizeEditOperations(value: unknown): EditOperation[] {
  return objectEntries(value).map(normalizeEditOperation);
}
