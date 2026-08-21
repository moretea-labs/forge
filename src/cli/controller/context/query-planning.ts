import type { ControllerContextImpactDomain, ControllerContextRetrievalMode } from './types';

export const DEFAULT_MAX_FILES = 8;
export const DEFAULT_MAX_SNIPPETS = 20;
export const DEFAULT_MAX_CHARS_PER_SNIPPET = 8000;
export const DEFAULT_SEARCH_EXCLUDE_GLOBS = [
  '.git/**', '_ops/**', '.forge/**', '.ai/harness/**', 'node_modules/**', 'dist/**', 'coverage/**', '**/*.bak',
] as const;
export const MAX_TOTAL_SEARCHED_FILES = 800;

const STOPWORDS = new Set([
  'about', 'after', 'again', 'also', 'and', 'around', 'because', 'before', 'between', 'change', 'code', 'config',
  'context', 'current', 'does', 'file', 'from', 'have', 'into', 'issue', 'make', 'need', 'needs', 'only', 'path',
  'repo', 'repository', 'runtime', 'should', 'task', 'that', 'this', 'through', 'todo', 'update', 'when', 'with',
]);

export const IMPACT_DOMAIN_TERMS: Record<ControllerContextImpactDomain, readonly string[]> = {
  persistence: ['persist', 'database', 'repository'], scheduler: ['scheduler', 'schedule', 'reminder'],
  notification: ['notification', 'notify', 'push'], timeline: ['timeline', 'history', 'activity'],
  events: ['event', 'publish', 'subscribe'], cache: ['cache', 'invalidate', 'memo'],
  api: ['api', 'dto', 'controller'], concurrency: ['transaction', 'lock', 'atomic'],
};

export function cleanList(value: string[] | undefined): string[] {
  return Array.from(new Set((value ?? []).map((entry) => entry.trim()).filter(Boolean)));
}

export function clamp(value: number | undefined, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.trunc(value), min), max);
}

export function pathNoisePenalty(path: string, intent: string, retrievalMode: ControllerContextRetrievalMode): number {
  const normalizedPath = path.toLowerCase();
  const normalizedIntent = intent.toLowerCase();
  let penalty = 0;
  if (/(^|\/)(?:scratch|tmp|fixtures?|examples?)(\/|$)/.test(normalizedPath)
    && !/\b(?:scratch|fixture|example|sample)\b/.test(normalizedIntent)) penalty += 50;
  if (/(^|\/)(?:ios|android|mobile)(\/|$)/.test(normalizedPath)
    && !/\b(?:ios|android|mobile|swift|device|simulator)\b/.test(normalizedIntent)) penalty += 15;
  if (/(^|\/)(?:__tests__|tests?|spec)(\/|$)|\.(?:test|spec)\.[^.]+$/.test(normalizedPath)
    && retrievalMode === 'implementation'
    && !/\b(?:test|spec|verification|regression)\b/.test(normalizedIntent)) penalty += 5;
  return penalty;
}

export function textTokens(value: string): string[] {
  const split = value.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/[^\p{L}\p{N}_./:-]+/u)
    .map((entry) => entry.trim()).filter(Boolean);
  return Array.from(new Set(split
    .map((entry) => entry.replace(/^[\'"`]+|[\'"`]+$/g, ''))
    .filter((entry) => entry.length >= 3)
    .filter((entry) => !STOPWORDS.has(entry.toLowerCase()))
    .filter((entry) => !/^\d+$/.test(entry)))).slice(0, 12);
}

/** A caller-supplied symbol or path is an exact retrieval needle, not a broad hint. */
export function isCodeShapedTerm(value: string): boolean {
  const term = value.trim();
  return term.includes('/')
    || term.includes('_')
    || /[a-z0-9][A-Z]/.test(term)
    || /^[A-Z][A-Za-z0-9]*$/.test(term)
    || /\.[A-Za-z0-9]+$/.test(term);
}

function codeShapedAnchors(value: string): string[] {
  const raw = value.split(/[^\p{L}\p{N}_./:-]+/u)
    .map((entry) => entry.replace(/^[\'"`]+|[\'"`]+$/g, '').trim())
    .filter((entry) => entry.length >= 3)
    .filter((entry) => entry.includes('/')
      || entry.includes('_')
      || /[a-z0-9][A-Z]/.test(entry)
      || /^[A-Z][A-Za-z0-9]*$/.test(entry)
      || /\.[A-Za-z0-9]+$/.test(entry));
  return Array.from(new Set(raw)).slice(0, 8);
}

/**
 * CodeGraph's semantic query cost grows materially with long natural-language
 * prompts. Keep short intents exact, but compact long intents around concrete
 * code anchors plus bounded semantic tokens. This affects only structural
 * discovery; lexical search and raw-source retrieval still consume the full
 * controller description.
 */
export function structuralIntentQuery(
  description: string,
  fallbackTerms: readonly string[] = [],
  impactDomains: readonly string[] = [],
): string {
  const normalized = description.trim();
  const intent = !normalized
    ? cleanList([...fallbackTerms]).slice(0, 16).join(' ')
    : normalized.length <= 160
      ? normalized
      : Array.from(new Set([...codeShapedAnchors(normalized), ...textTokens(normalized)])).slice(0, 16).join(' ');
  return [intent, ...impactDomains].filter(Boolean).join(' ');
}

export function gitStatusChangedPaths(status: string): string[] {
  const paths: string[] = [];
  for (const line of status.split(/\r?\n/)) {
    if (!line.trim() || line.startsWith('##') || line.length < 4) continue;
    let path = line.slice(3).trim();
    if (path.includes(' -> ')) path = path.slice(path.lastIndexOf(' -> ') + 4).trim();
    if (path.startsWith('"') && path.endsWith('"')) path = path.slice(1, -1);
    if (path && !paths.includes(path)) paths.push(path);
  }
  return paths;
}
