import { existsSync, readFileSync, statSync } from 'fs';
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

function loadProject(repoRoot: string, tsconfigPath = 'tsconfig.json'): CachedProject {
  const root = resolve(repoRoot);
  const configPath = resolve(root, tsconfigPath);
  const cacheKey = `${root}\0${configPath}`;
  const cached = projects.get(cacheKey);
  if (cached) return cached;

  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error) {
    throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
  }
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, dirname(configPath), undefined, configPath);
  if (parsed.errors.length > 0) {
    throw new Error(parsed.errors.map((entry) => ts.flattenDiagnosticMessageText(entry.messageText, '\n')).join('\n'));
  }

  const host: ts.LanguageServiceHost = {
    getCompilationSettings: () => parsed.options,
    getScriptFileNames: () => parsed.fileNames,
    getScriptVersion: scriptVersion,
    getScriptSnapshot: (fileName) => {
      if (!existsSync(fileName)) return undefined;
      return ts.ScriptSnapshot.fromString(readFileSync(fileName, 'utf8'));
    },
    getCurrentDirectory: () => root,
    getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
    readDirectory: ts.sys.readDirectory,
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

export function navigateTypeScriptSymbol(repoRoot: string, request: TypeScriptNavigationRequest): TypeScriptNavigationResult {
  const project = loadProject(repoRoot, request.tsconfigPath);
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
