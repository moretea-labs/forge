import { statSync } from 'fs';
import { dirname, relative, resolve } from 'path';
import * as ts from 'typescript';

export type TypeScriptNavigationKind = 'definition' | 'references' | 'implementations';

export interface TypeScriptNavigationRequest {
  navigation: TypeScriptNavigationKind;
  path: string;
  line: number;
  column: number;
  tsconfigPath?: string;
}

export interface TypeScriptNavigationLocation {
  path: string;
  line: number;
  column: number;
  name?: string;
  kind?: string;
}

export interface TypeScriptNavigationResult {
  navigation: TypeScriptNavigationKind;
  target: { path: string; line: number; column: number };
  locations: TypeScriptNavigationLocation[];
}

export interface TypeScriptSourceSymbolRange {
  startLine: number;
  endLine: number;
  kind: string;
  name?: string;
  enclosing?: string;
}

export interface TypeScriptNavigationAccess {
  /** Stable identity for one read-policy scope. Restricted and unrestricted projects must never share a Language Service. */
  cacheScope: string;
  /** Source identity observed by the caller. A different identity must not reuse project membership. */
  sourceIdentity?: string;
  /** Return true only for repository-relative paths that this navigation call may read. */
  allowRepositoryPath(relativePath: string): boolean;
}

interface CachedProject {
  repoRoot: string;
  configPath: string;
  configVersion: string;
  sourceIdentity: string;
  service: ts.LanguageService;
}

const projects = new Map<string, CachedProject>();
const MAX_CACHED_TYPESCRIPT_PROJECTS = 1;

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/');
}

function scriptVersion(path: string): string {
  try {
    const stat = statSync(path);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return 'missing';
  }
}

function repositoryRelativePath(repoRoot: string, fileName: string): string | undefined {
  const normalized = normalizePath(relative(repoRoot, resolve(fileName)));
  if (!normalized || normalized === '.' || normalized === '..' || normalized.startsWith('../')) return undefined;
  return normalized;
}

function loadProject(repoRoot: string, tsconfigPath = 'tsconfig.json', access?: TypeScriptNavigationAccess): CachedProject {
  const root = resolve(repoRoot);
  const configPath = resolve(root, tsconfigPath);
  const configRelative = repositoryRelativePath(root, configPath);
  if (!configRelative) throw new Error('TypeScript navigation tsconfig must be inside the repository.');
  if (access && !access.allowRepositoryPath(configRelative)) {
    throw new Error(`TypeScript navigation tsconfig is denied by read policy: ${configRelative}.`);
  }
  const configVersion = scriptVersion(configPath);
  const sourceIdentity = access?.sourceIdentity ?? 'unbound-source';
  const cacheKey = `${root}\0${configPath}\0${access?.cacheScope ?? 'unrestricted'}`;
  const cached = projects.get(cacheKey);
  if (cached && cached.configVersion === configVersion && cached.sourceIdentity === sourceIdentity) {
    projects.delete(cacheKey);
    projects.set(cacheKey, cached);
    return cached;
  }
  if (cached) {
    projects.delete(cacheKey);
    cached.service.dispose();
  }

  const canReadAbsolute = (fileName: string): boolean => {
    if (!access) return true;
    const repoRelative = repositoryRelativePath(root, fileName);
    return repoRelative === undefined || access.allowRepositoryPath(repoRelative);
  };
  const readAllowedFile = (fileName: string): string | undefined => canReadAbsolute(fileName) ? ts.sys.readFile(fileName) : undefined;
  const fileExistsAllowed = (fileName: string): boolean => canReadAbsolute(fileName) && ts.sys.fileExists(fileName);
  const readDirectoryAllowed: typeof ts.sys.readDirectory = (path, extensions, exclude, include, depth) =>
    ts.sys.readDirectory(path, extensions, exclude, include, depth).filter(canReadAbsolute);

  const config = ts.readConfigFile(configPath, readAllowedFile);
  if (config.error) {
    throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
  }
  const parseHost: ts.ParseConfigHost = {
    useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
    readDirectory: readDirectoryAllowed,
    fileExists: fileExistsAllowed,
    readFile: readAllowedFile,
  };
  const parsed = ts.parseJsonConfigFileContent(config.config, parseHost, dirname(configPath), undefined, configPath);
  if (parsed.errors.length > 0) {
    throw new Error(parsed.errors.map((entry) => ts.flattenDiagnosticMessageText(entry.messageText, '\n')).join('\n'));
  }
  const scriptFileNames = parsed.fileNames.filter(canReadAbsolute);

  const host: ts.LanguageServiceHost = {
    getCompilationSettings: () => parsed.options,
    getScriptFileNames: () => scriptFileNames,
    getScriptVersion: scriptVersion,
    getScriptSnapshot: (fileName) => {
      if (!fileExistsAllowed(fileName)) return undefined;
      const content = readAllowedFile(fileName);
      return content === undefined ? undefined : ts.ScriptSnapshot.fromString(content);
    },
    getCurrentDirectory: () => root,
    getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
    fileExists: fileExistsAllowed,
    readFile: readAllowedFile,
    readDirectory: readDirectoryAllowed,
    directoryExists: ts.sys.directoryExists,
    getDirectories: ts.sys.getDirectories,
    realpath: ts.sys.realpath,
    useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
    getNewLine: () => ts.sys.newLine,
  };

  const project = {
    repoRoot: root,
    configPath,
    configVersion,
    sourceIdentity,
    service: ts.createLanguageService(host, ts.createDocumentRegistry()),
  };
  projects.set(cacheKey, project);
  while (projects.size > MAX_CACHED_TYPESCRIPT_PROJECTS) {
    const oldestKey = projects.keys().next().value as string | undefined;
    if (!oldestKey) break;
    const oldest = projects.get(oldestKey);
    projects.delete(oldestKey);
    oldest?.service.dispose();
  }
  return project;
}

function sourcePosition(project: CachedProject, program: ts.Program, fileName: string, line: number, column: number): number {
  if (!Number.isInteger(line) || line < 1 || !Number.isInteger(column) || column < 1) {
    throw new Error('TypeScript navigation line and column must be positive 1-based integers.');
  }
  const source = program.getSourceFile(fileName);
  if (!source) throw new Error(`TypeScript project does not include ${normalizePath(relative(project.repoRoot, fileName))}.`);
  if (line > source.getLineAndCharacterOfPosition(source.getEnd()).line + 1) {
    throw new Error(`TypeScript navigation line ${line} is outside ${normalizePath(relative(project.repoRoot, fileName))}.`);
  }
  return source.getPositionOfLineAndCharacter(line - 1, column - 1);
}

function location(
  project: CachedProject,
  program: ts.Program,
  fileName: string,
  textSpan: ts.TextSpan,
  name?: string,
  kind?: ts.ScriptElementKind,
): TypeScriptNavigationLocation {
  const source = program.getSourceFile(fileName);
  if (!source) {
    return { path: normalizePath(relative(project.repoRoot, fileName)), line: 1, column: 1, ...(name ? { name } : {}), ...(kind ? { kind } : {}) };
  }
  const point = source.getLineAndCharacterOfPosition(textSpan.start);
  return {
    path: normalizePath(relative(project.repoRoot, fileName)),
    line: point.line + 1,
    column: point.character + 1,
    ...(name ? { name } : {}),
    ...(kind ? { kind } : {}),
  };
}

function sourceScriptKind(path: string): ts.ScriptKind | undefined {
  if (/\.tsx$/i.test(path)) return ts.ScriptKind.TSX;
  if (/\.jsx$/i.test(path)) return ts.ScriptKind.JSX;
  if (/\.(?:mts|cts|ts)$/i.test(path)) return ts.ScriptKind.TS;
  if (/\.(?:mjs|cjs|js)$/i.test(path)) return ts.ScriptKind.JS;
  return undefined;
}

function sourceDeclarationName(node: ts.Node): string | undefined {
  const named = node as ts.Node & { name?: ts.Node };
  return named.name ? named.name.getText().slice(0, 200) : undefined;
}

function sourceDeclarationKind(node: ts.Node): string | undefined {
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

function sourceEnclosingName(node: ts.Node): string | undefined {
  let current = node.parent;
  while (current) {
    if (ts.isClassDeclaration(current) || ts.isClassExpression(current) || ts.isInterfaceDeclaration(current) || ts.isModuleDeclaration(current)) {
      const kind = sourceDeclarationKind(current) ?? 'container';
      const name = sourceDeclarationName(current);
      return name ? `${kind}:${name}` : kind;
    }
    current = current.parent;
  }
  return undefined;
}

export function extractTypeScriptSourceSymbols(path: string, source: string): TypeScriptSourceSymbolRange[] {
  const kind = sourceScriptKind(path);
  if (kind === undefined) return [];
  const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, kind);
  const declarations: TypeScriptSourceSymbolRange[] = [];
  const visit = (node: ts.Node): void => {
    const declarationKind = sourceDeclarationKind(node);
    if (declarationKind) {
      declarations.push({
        startLine: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
        endLine: sourceFile.getLineAndCharacterOfPosition(node.end).line + 1,
        kind: declarationKind,
        ...(sourceDeclarationName(node) ? { name: sourceDeclarationName(node) } : {}),
        ...(sourceEnclosingName(node) ? { enclosing: sourceEnclosingName(node) } : {}),
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return declarations;
}

function dedupe(locations: TypeScriptNavigationLocation[]): TypeScriptNavigationLocation[] {
  const seen = new Set<string>();
  return locations.filter((entry) => {
    const key = `${entry.path}:${entry.line}:${entry.column}:${entry.name ?? ''}:${entry.kind ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function navigateTypeScriptSymbol(
  repoRoot: string,
  request: TypeScriptNavigationRequest,
  access?: TypeScriptNavigationAccess,
): TypeScriptNavigationResult {
  const project = loadProject(repoRoot, request.tsconfigPath, access);
  const fileName = resolve(project.repoRoot, request.path);
  // A references response may materialize hundreds of locations. Acquire the
  // Language Service Program once per navigation so that location formatting
  // does not repeatedly re-enter the service while the result is built.
  const program = project.service.getProgram();
  if (!program) throw new Error('TypeScript Language Service did not produce a Program.');
  const position = sourcePosition(project, program, fileName, request.line, request.column);
  let locations: TypeScriptNavigationLocation[] = [];

  if (request.navigation === 'definition') {
    locations = (project.service.getDefinitionAtPosition(fileName, position) ?? [])
      .map((entry) => location(project, program, entry.fileName, entry.textSpan, entry.name, entry.kind));
  } else if (request.navigation === 'implementations') {
    locations = (project.service.getImplementationAtPosition(fileName, position) ?? [])
      .map((entry) => location(project, program, entry.fileName, entry.textSpan, undefined, entry.kind));
  } else {
    locations = (project.service.findReferences(fileName, position) ?? []).flatMap((group) =>
      group.references.map((entry) => location(project, program, entry.fileName, entry.textSpan, group.definition.name, group.definition.kind)),
    );
  }

  return {
    navigation: request.navigation,
    target: { path: normalizePath(request.path), line: request.line, column: request.column },
    locations: dedupe(locations),
  };
}

export function typeScriptNavigationCachedProjectCount(): number {
  return projects.size;
}

export function clearTypeScriptNavigationCache(): void {
  for (const project of projects.values()) project.service.dispose();
  projects.clear();
}
