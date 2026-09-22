import type { McpPolicy } from '../../mcp/types';
import { extractTypeScriptSourceSymbolsInSidecar } from '../../../runtime/context/typescript-navigation-process';
import { redactMcpText } from '../../mcp/redaction';
import { readRepositoryRange, type RepositoryReadSession } from '../../repository/inspector';

const DEFAULT_CONTEXT_BEFORE = 12;
const DEFAULT_CONTEXT_AFTER = 28;
const COMPLETE_FILE_MAX_LINES = 240;

export type SourceMaterializationKind = 'complete_file' | 'symbol' | 'line_window';

export interface MaterializedSourceSnippet {
  path: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  sha256: string;
  content: string;
  truncated: boolean;
  redactions: Array<{ type: string; count: number }>;
  reason: string;
  cacheHit?: boolean;
  materialization: SourceMaterializationKind;
  symbol?: {
    kind: string;
    name?: string;
    enclosing?: string;
  };
}
export interface MaterializeSourceOptions {
  repoRoot: string;
  policy: McpPolicy;
  path: string;
  hitLines: number[];
  reasons: string[];
  maxSnippets: number;
  maxCharsPerSnippet: number;
  session?: RepositoryReadSession;
}

interface SymbolRange {
  startLine: number;
  endLine: number;
  kind: string;
  name?: string;
  enclosing?: string;
}

interface SourceSymbolIndex {
  declarations: SymbolRange[];
}

const SOURCE_SYMBOL_INDEX_CACHE_MAX_ENTRIES = 32;
const sourceSymbolIndexCache = new Map<string, SourceSymbolIndex>();
let sourceSymbolIndexCacheHits = 0;
let sourceSymbolIndexCacheMisses = 0;

export function sourceSymbolIndexCacheSnapshotForTest(): { entries: number; hits: number; misses: number } {
  return {
    entries: sourceSymbolIndexCache.size,
    hits: sourceSymbolIndexCacheHits,
    misses: sourceSymbolIndexCacheMisses,
  };
}

export function clearSourceSymbolIndexCacheForTest(): void {
  sourceSymbolIndexCache.clear();
  sourceSymbolIndexCacheHits = 0;
  sourceSymbolIndexCacheMisses = 0;
}

function boundedContent(content: string, maxChars: number): { content: string; truncated: boolean } {
  if (content.length <= maxChars) return { content, truncated: false };
  return { content: `${content.slice(0, maxChars)}\n... <snippet truncated>`, truncated: true };
}

function plainSource(numbered: string): string {
  return numbered
    .split(/\r?\n/)
    .map((line) => line.replace(/^\d+: /, ''))
    .join('\n');
}

function sliceNumbered(numbered: string, startLine: number, endLine: number): string {
  return numbered
    .split(/\r?\n/)
    .slice(Math.max(0, startLine - 1), Math.max(startLine, endLine))
    .join('\n');
}

function mergeHitLines(lines: number[]): number[] {
  const sorted = Array.from(new Set(lines.filter((line) => line > 0))).sort((left, right) => left - right);
  const merged: number[] = [];
  for (const line of sorted) {
    const previous = merged[merged.length - 1];
    if (previous !== undefined && line - previous <= DEFAULT_CONTEXT_BEFORE + DEFAULT_CONTEXT_AFTER) continue;
    merged.push(line);
  }
  return merged;
}

function sourceSyntaxKind(path: string): string | undefined {
  const match = path.toLowerCase().match(/\.(tsx|jsx|mts|cts|ts|mjs|cjs|js)$/);
  return match?.[1];
}

function cachedSourceSymbolIndex(path: string, fileSha: string, numberedSource: string): SourceSymbolIndex | undefined {
  const kind = sourceSyntaxKind(path);
  if (kind === undefined) return undefined;
  const key = `${kind}:${fileSha}`;
  const cached = sourceSymbolIndexCache.get(key);
  if (cached) {
    sourceSymbolIndexCache.delete(key);
    sourceSymbolIndexCache.set(key, cached);
    sourceSymbolIndexCacheHits += 1;
    return cached;
  }

  sourceSymbolIndexCacheMisses += 1;
  const built: SourceSymbolIndex = {
    declarations: extractTypeScriptSourceSymbolsInSidecar(path, plainSource(numberedSource)),
  };
  sourceSymbolIndexCache.set(key, built);
  while (sourceSymbolIndexCache.size > SOURCE_SYMBOL_INDEX_CACHE_MAX_ENTRIES) {
    const oldest = sourceSymbolIndexCache.keys().next().value as string | undefined;
    if (!oldest) break;
    sourceSymbolIndexCache.delete(oldest);
  }
  return built;
}

function symbolAtLine(index: SourceSymbolIndex | undefined, line: number): SymbolRange | undefined {
  if (!index) return undefined;
  const targetLine = Math.max(1, line);
  let selected: SymbolRange | undefined;
  for (const candidate of index.declarations) {
    if (candidate.startLine > targetLine || candidate.endLine < targetLine) continue;
    if (!selected || (candidate.endLine - candidate.startLine) < (selected.endLine - selected.startLine)) selected = candidate;
  }
  return selected;
}

function materializedSnippet(
  full: ReturnType<typeof readRepositoryRange>,
  range: { startLine: number; endLine: number },
  options: MaterializeSourceOptions,
  materialization: SourceMaterializationKind,
  symbol?: SymbolRange,
): MaterializedSourceSnippet {
  const numbered = sliceNumbered(full.content, range.startLine, range.endLine);
  const redacted = redactMcpText(numbered);
  const bounded = boundedContent(redacted.text, options.maxCharsPerSnippet);
  return {
    path: full.path,
    startLine: range.startLine,
    endLine: range.endLine,
    totalLines: full.totalLines,
    sha256: full.sha256,
    content: bounded.content,
    truncated: bounded.truncated,
    redactions: redacted.redactions,
    reason: options.reasons.join(', '),
    cacheHit: full.cacheHit,
    materialization,
    ...(symbol ? { symbol: { kind: symbol.kind, name: symbol.name, enclosing: symbol.enclosing } } : {}),
  };
}

/**
 * Materialize current source in semantic units. Complete small files and
 * complete TypeScript/JavaScript declarations win; a fixed line window is the
 * bounded fallback for unsupported languages or unmatched top-level text.
 */
export function materializeSource(options: MaterializeSourceOptions): MaterializedSourceSnippet[] {
  if (options.maxSnippets <= 0) return [];
  const full = readRepositoryRange(
    options.repoRoot,
    options.policy,
    options.path,
    1,
    Number.MAX_SAFE_INTEGER,
    options.session,
  );
  if (full.totalLines <= COMPLETE_FILE_MAX_LINES && full.content.length <= options.maxCharsPerSnippet) {
    return [materializedSnippet(full, { startLine: 1, endLine: full.totalLines }, options, 'complete_file')];
  }

  const symbolIndex = cachedSourceSymbolIndex(options.path, full.sha256, full.content);
  const snippets: MaterializedSourceSnippet[] = [];
  const seen = new Set<string>();
  for (const line of mergeHitLines(options.hitLines.length > 0 ? options.hitLines : [1])) {
    if (snippets.length >= options.maxSnippets) break;
    const symbol = symbolAtLine(symbolIndex, line);
    const range = symbol
      ? { startLine: symbol.startLine, endLine: symbol.endLine }
      : {
          startLine: Math.max(1, line - DEFAULT_CONTEXT_BEFORE),
          endLine: Math.min(full.totalLines, line + DEFAULT_CONTEXT_AFTER),
        };
    const key = `${range.startLine}:${range.endLine}`;
    if (seen.has(key)) continue;
    seen.add(key);
    snippets.push(materializedSnippet(full, range, options, symbol ? 'symbol' : 'line_window', symbol));
  }
  return snippets;
}
