import ts from 'typescript';
import type { McpPolicy } from '../../mcp/types';
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

function scriptKind(path: string): ts.ScriptKind | undefined {
  if (/\.tsx$/i.test(path)) return ts.ScriptKind.TSX;
  if (/\.jsx$/i.test(path)) return ts.ScriptKind.JSX;
  if (/\.(?:mts|cts|ts)$/i.test(path)) return ts.ScriptKind.TS;
  if (/\.(?:mjs|cjs|js)$/i.test(path)) return ts.ScriptKind.JS;
  return undefined;
}

function declarationName(node: ts.Node): string | undefined {
  const named = node as ts.Node & { name?: ts.Node };
  if (!named.name) return undefined;
  return named.name.getText().slice(0, 200);
}

function declarationKind(node: ts.Node): string | undefined {
  if (ts.isFunctionDeclaration(node)) return 'function';
  if (ts.isMethodDeclaration(node)) return 'method';
  if (ts.isConstructorDeclaration(node)) return 'constructor';
  if (ts.isGetAccessorDeclaration(node)) return 'getter';
  if (ts.isSetAccessorDeclaration(node)) return 'setter';
  if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) return 'class';
  if (ts.isInterfaceDeclaration(node)) return 'interface';
  if (ts.isTypeAliasDeclaration(node)) return 'type';
  if (ts.isEnumDeclaration(node)) return 'enum';
  if (ts.isModuleDeclaration(node)) return 'module';
  if (ts.isVariableStatement(node) && node.declarationList.declarations.some((declaration) =>
    declaration.initializer && (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer)))) return 'function-variable';
  return undefined;
}

function enclosingName(node: ts.Node): string | undefined {
  let current = node.parent;
  while (current) {
    if (ts.isClassDeclaration(current) || ts.isClassExpression(current) || ts.isInterfaceDeclaration(current) || ts.isModuleDeclaration(current)) {
      const kind = declarationKind(current) ?? 'container';
      const name = declarationName(current);
      return name ? `${kind}:${name}` : kind;
    }
    current = current.parent;
  }
  return undefined;
}

function symbolAtLine(path: string, source: string, line: number): SymbolRange | undefined {
  const kind = scriptKind(path);
  if (kind === undefined) return undefined;
  const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, kind);
  const targetLine = Math.min(Math.max(1, line), sourceFile.getLineAndCharacterOfPosition(sourceFile.end).line + 1);
  const position = sourceFile.getPositionOfLineAndCharacter(targetLine - 1, 0);
  const matches: Array<{ node: ts.Node; kind: string }> = [];
  const visit = (node: ts.Node): void => {
    const candidateKind = declarationKind(node);
    if (candidateKind && node.getFullStart() <= position && node.end >= position) matches.push({ node, kind: candidateKind });
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  const selected = matches.sort((left, right) =>
    (left.node.end - left.node.getFullStart()) - (right.node.end - right.node.getFullStart()))[0];
  if (!selected) return undefined;
  return {
    startLine: sourceFile.getLineAndCharacterOfPosition(selected.node.getStart(sourceFile)).line + 1,
    endLine: sourceFile.getLineAndCharacterOfPosition(selected.node.end).line + 1,
    kind: selected.kind,
    name: declarationName(selected.node),
    enclosing: enclosingName(selected.node),
  };
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

  const source = plainSource(full.content);
  const snippets: MaterializedSourceSnippet[] = [];
  const seen = new Set<string>();
  for (const line of mergeHitLines(options.hitLines.length > 0 ? options.hitLines : [1])) {
    if (snippets.length >= options.maxSnippets) break;
    const symbol = symbolAtLine(options.path, source, line);
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

