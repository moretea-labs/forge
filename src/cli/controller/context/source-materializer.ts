import type { McpPolicy } from '../../../../adapters/mcp/types';
import { extractTypeScriptSourceSymbolsInSidecar } from '../../../runtime/context/typescript-navigation-process';
import { redactMcpText } from '../../../../adapters/mcp/redaction';
import { exactCodeNeedleMatches, readRepositoryRange, type RepositoryReadSession } from '../../repository/inspector';

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
  /** Internal proof: required owner declarations actually present in this emitted snippet. */
  ownerQueries?: string[];
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
  /** Ordinary lexical implementation search must not spawn another TypeScript compiler sidecar. */
  preferSymbolRanges?: boolean;
  /** Required code symbols whose actual declaration lines must be considered before lexical hits. */
  requiredOwnerQueries?: string[];
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

function plainSource(numbered: string): string {
  return numbered
    .split(/\r?\n/)
    .map((line) => line.replace(/^\d+: /, ''))
    .join('\n');
}

const METHOD_CONTROL_KEYWORDS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'with', 'try', 'finally', 'else', 'do',
  'return', 'throw', 'new', 'delete', 'void', 'typeof', 'instanceof', 'in', 'of',
  'yield', 'await', 'function', 'class', 'interface', 'type', 'const', 'let', 'var',
  'case', 'default', 'import', 'export', 'extends', 'implements', 'super', 'this',
]);
const CONTROL_PAREN_KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'with']);

function escapeCodeOwnerNeedle(needle: string): string {
  return needle.replace(/[.*+?^${}()|[\]\\]/g, (match) => '\\' + match);
}

function exactCodeOwnerPatterns(query: string): string {
  const escaped = escapeCodeOwnerNeedle(query);
  const declaration = '^\\s*(?:(?:export|declare|default|async)\\s+)*(?:function|class|interface|type|const|let|enum)\\s+' + escaped + '(?:$|[^\\p{L}\\p{N}_$])';
  const boundedSignature = '(?:[^;{}]{0,99}|\\{[^{}]{0,99}\\}){0,5}?';
  const method = METHOD_CONTROL_KEYWORDS.has(query.toLowerCase()) ? '' : '|^\\s*(?:(?:public|private|protected|static|abstract|override|async|get|set)\\s+)*(?:\\*\\s*)?#?' + escaped + '\\s*(?:<[^>\\n]+>)?\\s*\\(' + boundedSignature + '\\)\\s*(?::\\s*' + boundedSignature + ')?\\s*\\{';
  const arrow = METHOD_CONTROL_KEYWORDS.has(query.toLowerCase()) ? '' : '|^\\s*(?:(?:public|private|protected|static|readonly|declare)\\s+)*#?' + escaped + '\\??\\s*=\\s*(?:async\\s*)?(?:<[^>\\n]+>\\s*)?(?:\\(' + boundedSignature + '\\)|[\\w$]+)\\s*(?::\\s*' + boundedSignature + ')?\\s*=>';
  return declaration + method + arrow;
}

function maskCommentsAndStrings(source: string): string {
  const templateQuote = String.fromCharCode(96);
  if (!source.includes('//') && !source.includes('/*') && !source.includes("'")
    && !source.includes('"') && !source.includes(templateQuote)) return source;

  // Track template interpolation nesting, not a single template toggle:
  // nested literal text must never become executable owner evidence.
  type Mode = 'code' | 'template' | 'line-comment' | 'block-comment' | 'single-string' | 'double-string' | 'regex';
  const frames: Array<{
    mode: Mode;
    braceDepth?: number;
    regexAllowed?: boolean;
    regexClass?: boolean;
    pendingControlParen?: 'for' | 'control';
    parenKinds?: boolean[];
    previousSignificantChar?: string;
  }> = [{ mode: 'code', regexAllowed: true, parenKinds: [] }];
  const masked = source.split('');
  const hide = (index: number): void => {
    if (source[index] !== '\n' && source[index] !== '\r') masked[index] = ' ';
  };
  for (let index = 0; index < source.length; index += 1) {
    const current = source[index]!;
    const next = source[index + 1];
    const frame = frames[frames.length - 1]!;

    if (frame.mode === 'line-comment') {
      if (current === '\n') frames.pop();
      else hide(index);
      continue;
    }
    if (frame.mode === 'block-comment') {
      if (current === '*' && next === '/') {
        hide(index);
        hide(index + 1);
        index += 1;
        frames.pop();
      } else hide(index);
      continue;
    }
    if (frame.mode === 'regex') {
      // Regex braces are literal pattern content, never interpolation braces.
      // Character classes also protect slashes: /[\/}]/ is one regex literal.
      if (current === '\\') {
        hide(index);
        if (index + 1 < source.length) {
          hide(index + 1);
          index += 1;
        }
      } else if (current === '[' && !frame.regexClass) {
        frame.regexClass = true;
        hide(index);
      } else if (current === ']' && frame.regexClass) {
        frame.regexClass = false;
        hide(index);
      } else if (current === '/' && !frame.regexClass) {
        hide(index);
        frames.pop();
        frames[frames.length - 1]!.regexAllowed = false;
      } else hide(index);
      continue;
    }
    if (frame.mode === 'single-string' || frame.mode === 'double-string' || frame.mode === 'template') {
      const quote = frame.mode === 'single-string' ? "'" : frame.mode === 'double-string' ? '"' : templateQuote;
      if (current === '\\') {
        hide(index);
        if (index + 1 < source.length) {
          hide(index + 1);
          index += 1;
        }
      } else if (frame.mode === 'template' && current === '$' && next === '{') {
        hide(index);
        hide(index + 1);
        index += 1;
        frames.push({ mode: 'code', braceDepth: 1, regexAllowed: true, parenKinds: [] });
      } else if (current === quote) {
        hide(index);
        frames.pop();
        frames[frames.length - 1]!.regexAllowed = false;
      } else hide(index);
      continue;
    }

    if (frame.braceDepth !== undefined) {
      if (current === '{') frame.braceDepth += 1;
      if (current === '}') {
        frame.braceDepth -= 1;
        if (frame.braceDepth === 0) {
          hide(index);
          frames.pop();
          continue;
        }
      }
    }
    // A token boundary distinguishes a regex literal from division. Treat a
    // leading regex after an operand-introducing token (or interpolation open)
    // as string-like text. This is deliberately lexically bounded: no parser
    // sidecar is invoked on the context materializer's hot path.
    if (/[$_\p{L}]/u.test(current)) {
      let end = index + 1;
      while (end < source.length && /[$_\p{L}\p{N}]/u.test(source[end]!)) end += 1;
      const token = source.slice(index, end);
      frame.regexAllowed = /^(?:return|throw|case|yield|await|delete|typeof|void|in|of|else|do)$/.test(token);
      frame.pendingControlParen = CONTROL_PAREN_KEYWORDS.has(token) && frame.previousSignificantChar !== '.'
        ? token === 'for' ? 'for' : 'control'
        : frame.pendingControlParen === 'for' && token === 'await' ? 'for' : undefined;
      frame.previousSignificantChar = source[end - 1]!;
      index = end - 1;
      continue;
    }
    if (current === '(') {
      (frame.parenKinds ??= []).push(frame.pendingControlParen !== undefined);
      frame.pendingControlParen = undefined;
      frame.regexAllowed = true;
      frame.previousSignificantChar = current;
      continue;
    }
    if (current === ')') {
      frame.regexAllowed = frame.parenKinds?.pop() ?? false;
      frame.pendingControlParen = undefined;
      frame.previousSignificantChar = current;
      continue;
    }
    if (!/\s/.test(current) && !(current === '/' && (next === '/' || next === '*'))) {
      frame.pendingControlParen = undefined;
    }
    if (current === '/' && next !== '/' && next !== '*' && frame.regexAllowed) {
      hide(index);
      frame.previousSignificantChar = current;
      frames.push({ mode: 'regex', regexClass: false });
      continue;
    }
    if (current === '/' && next === '/') {
      hide(index);
      hide(index + 1);
      index += 1;
      frames.push({ mode: 'line-comment' });
    } else if (current === '/' && next === '*') {
      hide(index);
      hide(index + 1);
      index += 1;
      frames.push({ mode: 'block-comment' });
    } else if (current === "'" || current === '"') {
      hide(index);
      frame.regexAllowed = false;
      frame.previousSignificantChar = current;
      frames.push({ mode: current === "'" ? 'single-string' : 'double-string' });
    } else if (current === templateQuote) {
      hide(index);
      frame.regexAllowed = false;
      frame.previousSignificantChar = current;
      frames.push({ mode: 'template' });
    } else if (!/\s/.test(current)) {
      frame.regexAllowed = !/[\p{N}\])}.]/u.test(current);
      frame.previousSignificantChar = current;
    }
  }
  return masked.join('');
}

interface ExactCodeOwnerLocation {
  query: string;
  line: number;
  exported: boolean;
}

function exactCodeOwnerLocations(source: string, queries: readonly string[]): ExactCodeOwnerLocation[] {
  if (queries.length === 0) return [];
  const code = maskCommentsAndStrings(source);
  const codeLines = code.split('\n');
  const alternatives = queries.map(escapeCodeOwnerNeedle).join('|');
  const declarationStart = new RegExp(
    '^\\s*(?:(?:export|declare|default|async)\\s+)*(?:function|class|interface|type|const|let|enum)\\s+('
      + alternatives + ')(?:$|[^\\p{L}\\p{N}_$])',
    'iu',
  );
  const memberStart = new RegExp(
    '^\\s*(?:(?:public|private|protected|static|abstract|override|async|get|set|readonly|declare)\\s+)*(?:\\*\\s*)?#?('
      + alternatives + ')\\??\\s*(?:<[^>\\n]+>\\s*)?(?:\\(|=)',
    'iu',
  );
  const ownerPatterns = new Map(queries.map((query) => [
    query,
    new RegExp('(?:' + exactCodeOwnerPatterns(query) + ')', 'imsu'),
  ]));
  const queryByLowercase = new Map(queries.map((query) => [query.toLowerCase(), query]));
  const lowerQueries = queries.map((query) => query.toLowerCase());
  const firstByQuery = new Map<string, ExactCodeOwnerLocation>();
  const exportedByQuery = new Map<string, ExactCodeOwnerLocation>();
  let lineOffset = 0;
  for (let index = 0; index < codeLines.length; index += 1) {
    const line = codeLines[index] ?? '';
    const currentOffset = lineOffset;
    lineOffset += line.length + 1;
    if (!queries.some((query) => line.includes(query))) {
      const lowerLine = line.toLowerCase();
      if (!lowerQueries.some((query) => lowerLine.includes(query))) continue;
    }
    const trimmedLine = line.trim();
    // Dense same-line calls are the common saturation case. Skip them before
    // testing declaration patterns; signatures without bodies are not owners.
    if (trimmedLine.endsWith(';') && trimmedLine.includes(')')
      && !trimmedLine.includes('=>') && !trimmedLine.includes('{')) continue;
    const candidate = declarationStart.exec(line) ?? memberStart.exec(line);
    if (!candidate?.[1]) continue;
    const query = queryByLowercase.get(candidate[1].toLowerCase());
    if (!query || exportedByQuery.has(query)) continue;
    const ownerPattern = ownerPatterns.get(query);
    const match = ownerPattern?.exec(code.slice(currentOffset, currentOffset + 700));
    // The bounded signature must start on this candidate line; never accept a
    // later declaration merely because it falls inside the look-ahead window.
    if (!match || match.index !== 0) continue;
    const location = {
      query,
      line: index + 1,
      exported: /^(?:export|declare|default)\b/.test(line.trimStart()),
    };
    if (!firstByQuery.has(query)) firstByQuery.set(query, location);
    if (location.exported) exportedByQuery.set(query, location);
  }
  return queries.flatMap((query) => {
    const selected = exportedByQuery.get(query) ?? firstByQuery.get(query);
    return selected ? [selected] : [];
  });
}

export function exactCodeOwnerEvidence(source: string, query: string): { declared: string | undefined; owner: boolean } {
  const normalized = source.split(/\r?\n/).map((line) => line.replace(/^\s*\d+:\s*/, '')).join('\n');
  const code = maskCommentsAndStrings(normalized);
  const declared = new RegExp('(?:' + exactCodeOwnerPatterns(query) + ')', 'imsu').test(code) ? query : undefined;
  return { declared, owner: declared !== undefined };
}

export function exactCodeOwnerQueries(source: string, queries: readonly string[]): string[] {
  const normalized = source.split(/\r?\n/).map((line) => line.replace(/^\s*\d+:\s*/, '')).join('\n');
  return exactCodeOwnerLocations(normalized, queries).map((location) => location.query);
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
  let low = range.startLine;
  let high = range.endLine;
  let exactEndLine = range.startLine - 1;
  let exactContent = '';
  let exactRedactions: Array<{ type: string; count: number }> = [];
  while (low <= high) {
    const candidateEndLine = Math.floor((low + high) / 2);
    const redacted = redactMcpText(sliceNumbered(full.content, range.startLine, candidateEndLine));
    if (redacted.text.length <= options.maxCharsPerSnippet) {
      exactEndLine = candidateEndLine;
      exactContent = redacted.text;
      exactRedactions = redacted.redactions;
      low = candidateEndLine + 1;
    } else {
      high = candidateEndLine - 1;
    }
  }
  // Source evidence is line-addressed. Never character-cut content while still
  // reporting the original endLine. A single unusually long line stays intact
  // so the reported source range remains truthful; outer response budgets remain
  // the hard transport fence.
  if (exactEndLine < range.startLine) {
    const redacted = redactMcpText(sliceNumbered(full.content, range.startLine, range.startLine));
    exactEndLine = range.startLine;
    exactContent = redacted.text;
    exactRedactions = redacted.redactions;
  }
  return {
    path: full.path,
    startLine: range.startLine,
    endLine: exactEndLine,
    totalLines: full.totalLines,
    sha256: full.sha256,
    content: exactContent,
    truncated: exactEndLine < range.endLine,
    redactions: exactRedactions,
    reason: options.reasons.join(', '),
    cacheHit: full.cacheHit,
    materialization,
    ...(symbol ? { symbol: { kind: symbol.kind, name: symbol.name, enclosing: symbol.enclosing } } : {}),
  };
}

function materializedRange(
  full: ReturnType<typeof readRepositoryRange>,
  range: { startLine: number; endLine: number },
  options: MaterializeSourceOptions,
  materialization: SourceMaterializationKind,
  maxSnippets: number,
  symbol?: SymbolRange,
): MaterializedSourceSnippet[] {
  const snippets: MaterializedSourceSnippet[] = [];
  let startLine = range.startLine;
  while (startLine <= range.endLine && snippets.length < maxSnippets) {
    const snippet = materializedSnippet(
      full,
      { startLine, endLine: range.endLine },
      options,
      materialization,
      symbol,
    );
    snippets.push({ ...snippet, truncated: false });
    startLine = snippet.endLine + 1;
  }
  if (startLine <= range.endLine && snippets.length > 0) {
    snippets[snippets.length - 1] = { ...snippets[snippets.length - 1]!, truncated: true };
  }
  return snippets;
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
    const complete = materializedSnippet(full, { startLine: 1, endLine: full.totalLines }, options, 'complete_file');
    const ownerQueries = (options.requiredOwnerQueries ?? [])
      .filter((query) => exactCodeOwnerEvidence(complete.content, query).owner);
    return ownerQueries.length > 0 ? [{ ...complete, ownerQueries }] : [complete];
  }

  const symbolIndex = options.preferSymbolRanges === false
    ? undefined
    : cachedSourceSymbolIndex(options.path, full.sha256, full.content);
  const ownerLocations = options.requiredOwnerQueries?.length
    ? exactCodeOwnerLocations(plainSource(full.content), options.requiredOwnerQueries)
    : [];
  const ownerLines = ownerLocations.map((owner) => owner.line);
  const fallbackLines = mergeHitLines(options.hitLines.length > 0 ? options.hitLines : [1]);
  const prioritizedLines = [...ownerLines, ...fallbackLines.filter((line) => !ownerLines.includes(line))];
  const snippets: MaterializedSourceSnippet[] = [];
  const seen = new Set<string>();
  for (const line of prioritizedLines) {
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
    snippets.push(...materializedRange(
      full,
      range,
      options,
      symbol ? 'symbol' : 'line_window',
      options.maxSnippets - snippets.length,
      symbol,
    ));
  }
  return snippets.map((snippet) => {
    const ownerQueries = ownerLocations.filter((owner) => {
      if (owner.line < snippet.startLine || owner.line > snippet.endLine) return false;
      const emittedLine = snippet.content.split(/\r?\n/).find((line) => line.startsWith(String(owner.line) + ':'));
      if (!emittedLine) return false;
      return exactCodeNeedleMatches(emittedLine.slice(emittedLine.indexOf(':') + 1).toLowerCase(), owner.query.toLowerCase());
    }).map((owner) => owner.query);
    return ownerQueries.length > 0 ? { ...snippet, ownerQueries } : snippet;
  });
}
