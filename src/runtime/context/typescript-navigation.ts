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

export interface TypeScriptNavigationAccess {
  /** Stable identity for one read-policy scope. Restricted and unrestricted projects must never share a Language Service. */
  cacheScope: string;
  /** Return true only for repository-relative paths that this navigation call may read. */
  allowRepositoryPath(relativePath: string): boolean;
}

interface CachedProject {
  repoRoot: string;
  configPath: string;
  service: ts.LanguageService;
}

const projects = new Map<string, CachedProject>();

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
  const cacheKey = `${root}\0${configPath}\0${scriptVersion(configPath)}\0${access?.cacheScope ?? 'unrestricted'}`;
  const cached = projects.get(cacheKey);
  if (cached) return cached;

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
    service: ts.createLanguageService(host, ts.createDocumentRegistry()),
  };
  projects.set(cacheKey, project);
  return project;
}

function sourcePosition(project: CachedProject, fileName: string, line: number, column: number): number {
  if (!Number.isInteger(line) || line < 1 || !Number.isInteger(column) || column < 1) {
    throw new Error('TypeScript navigation line and column must be positive 1-based integers.');
  }
  const source = project.service.getProgram()?.getSourceFile(fileName);
  if (!source) throw new Error(`TypeScript project does not include ${normalizePath(relative(project.repoRoot, fileName))}.`);
  if (line > source.getLineAndCharacterOfPosition(source.getEnd()).line + 1) {
    throw new Error(`TypeScript navigation line ${line} is outside ${normalizePath(relative(project.repoRoot, fileName))}.`);
  }
  return source.getPositionOfLineAndCharacter(line - 1, column - 1);
}

function location(
  project: CachedProject,
  fileName: string,
  textSpan: ts.TextSpan,
  name?: string,
  kind?: ts.ScriptElementKind,
): TypeScriptNavigationLocation {
  const source = project.service.getProgram()?.getSourceFile(fileName);
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
  const position = sourcePosition(project, fileName, request.line, request.column);
  let locations: TypeScriptNavigationLocation[] = [];

  if (request.navigation === 'definition') {
    locations = (project.service.getDefinitionAtPosition(fileName, position) ?? [])
      .map((entry) => location(project, entry.fileName, entry.textSpan, entry.name, entry.kind));
  } else if (request.navigation === 'implementations') {
    locations = (project.service.getImplementationAtPosition(fileName, position) ?? [])
      .map((entry) => location(project, entry.fileName, entry.textSpan, undefined, entry.kind));
  } else {
    locations = (project.service.findReferences(fileName, position) ?? []).flatMap((group) =>
      group.references.map((entry) => location(project, entry.fileName, entry.textSpan, group.definition.name, group.definition.kind)),
    );
  }

  return {
    navigation: request.navigation,
    target: { path: normalizePath(request.path), line: request.line, column: request.column },
    locations: dedupe(locations),
  };
}

export function clearTypeScriptNavigationCache(): void {
  for (const project of projects.values()) project.service.dispose();
  projects.clear();
}
