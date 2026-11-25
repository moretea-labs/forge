export interface ProjectKnowledgeSource {
  id: string;
  kind: 'repository' | 'brain';
  /** Relative to the repository or the explicitly configured Brain root. */
  path: string;
  required?: boolean;
  expiresAt?: string;
  applicability?: { channel?: string; account?: string; locale?: string };
}

const MAX_KNOWLEDGE_SOURCES = 128;
const MAX_TEXT = 2_000;

function text(value: unknown, code: string): string {
  if (typeof value !== 'string') throw new Error(code);
  const normalized = value.trim();
  if (!normalized || normalized.length > MAX_TEXT) throw new Error(code);
  return normalized;
}

function object(value: unknown, code: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(code);
  return value as Record<string, unknown>;
}

function objectList(value: unknown, code: string): Record<string, unknown>[] {
  if (!Array.isArray(value) || value.length > MAX_KNOWLEDGE_SOURCES) throw new Error(code);
  return value.map((item) => object(item, code));
}

export function validateProjectKnowledgeSources(value: unknown): ProjectKnowledgeSource[] {
  if (value === undefined) return [];
  const sources = objectList(value, 'PROJECT_KNOWLEDGE_SOURCES_INVALID').map((item): ProjectKnowledgeSource => {
    const kind = item.kind;
    if (kind !== 'repository' && kind !== 'brain') throw new Error('PROJECT_KNOWLEDGE_KIND_INVALID');
    const path = text(item.path, 'PROJECT_KNOWLEDGE_PATH_INVALID');
    if (/^(?:[/\\]|[A-Za-z]:)/.test(path) || path.split(/[/\\]/).includes('..'))
      throw new Error('PROJECT_KNOWLEDGE_PATH_INVALID');
    if (item.required !== undefined && typeof item.required !== 'boolean')
      throw new Error('PROJECT_KNOWLEDGE_REQUIRED_INVALID');
    if (
      item.expiresAt !== undefined &&
      (typeof item.expiresAt !== 'string' || !Number.isFinite(Date.parse(item.expiresAt)))
    )
      throw new Error('PROJECT_KNOWLEDGE_EXPIRY_INVALID');
    const applicability: NonNullable<ProjectKnowledgeSource['applicability']> = {};
    if (item.applicability !== undefined) {
      for (const [key, value] of Object.entries(
        object(item.applicability, 'PROJECT_KNOWLEDGE_APPLICABILITY_INVALID'),
      )) {
        if (!['channel', 'account', 'locale'].includes(key)) throw new Error('PROJECT_KNOWLEDGE_APPLICABILITY_INVALID');
        applicability[key as keyof typeof applicability] = text(value, 'PROJECT_KNOWLEDGE_APPLICABILITY_INVALID');
      }
      if (applicability.account && !applicability.channel) throw new Error('PROJECT_KNOWLEDGE_CHANNEL_REQUIRED');
    }
    return {
      id: text(item.id, 'PROJECT_KNOWLEDGE_ID_INVALID'),
      kind,
      path,
      required: item.required as boolean | undefined,
      expiresAt: item.expiresAt as string | undefined,
      applicability,
    };
  });
  if (new Set(sources.map((source) => source.id)).size !== sources.length)
    throw new Error('PROJECT_KNOWLEDGE_ID_DUPLICATE');
  return sources;
}
