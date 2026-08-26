import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  SemanticProviderRegistry,
  type SemanticNavigationProvider,
} from '../../src/runtime/context/semantic-navigation';
import {
  disposeGenericLspSessions,
  GenericLspSemanticProvider,
  resolveGenericLspWorkspace,
  type GenericLspProviderDescriptor,
} from '../../src/runtime/context/generic-lsp-provider';
import { swiftBuildSettingsFingerprint } from '../../src/runtime/context/swift-navigation';
import { LanguageServerClient } from '../../src/runtime/context/lsp-client';
import {
  clearTypeScriptNavigationCache,
  navigateTypeScriptSymbol,
} from '../../src/runtime/context/typescript-navigation';
import {
  clearAllSessionCachesForTest,
  getOrCreateSessionCache,
  invalidateSessionCachesForRepository,
} from '../../src/cli/repository/session-cache';

const tempRoots: string[] = [];

function tempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  await disposeGenericLspSessions();
  clearTypeScriptNavigationCache();
  clearAllSessionCachesForTest();
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('semantic provider architecture', () => {
  test('registry routes by provider capability without language-specific facade branching', async () => {
    const calls: string[] = [];
    const provider = (id: string, suffix: string): SemanticNavigationProvider => ({
      id,
      languages: [id],
      supports: (request) => request.path.endsWith(suffix),
      navigate: async (_repoRoot, requests) => {
        calls.push(`${id}:${requests.length}`);
        return requests.map((request) => ({
          ok: true as const,
          result: {
            providerId: id,
            language: id,
            navigation: request.navigation,
            target: { path: request.path, line: request.line, column: request.column },
            locations: [],
          },
        }));
      },
    });
    const registry = new SemanticProviderRegistry().register(provider('alpha', '.a')).register(provider('beta', '.b'));
    const outcomes = await registry.navigate('/repo', [
      { index: 7, request: { navigation: 'definition', path: 'x.a', line: 1, column: 1 } },
      { index: 2, request: { navigation: 'references', path: 'y.b', line: 1, column: 1 } },
    ], {
      cacheScope: 'test',
      sourceIdentity: 'source-v1',
      profile: 'controller',
      allowRepositoryPath: () => true,
    });

    expect(outcomes.map((entry) => entry.index)).toEqual([2, 7]);
    expect(calls.sort()).toEqual(['alpha:1', 'beta:1']);
    expect(outcomes.every((entry) => entry.outcome.ok)).toBe(true);
  });

  test('generic LSP provider performs an end-to-end definition request without language-specific routing code', async () => {
    const root = tempRoot('forge-generic-lsp-e2e-');
    const project = join(root, 'project');
    mkdirSync(join(project, 'src'), { recursive: true });
    writeFileSync(join(project, 'project.fake'), 'fake-root\n');
    writeFileSync(join(project, 'src/main.fake'), 'target\n');
    const serverPath = join(root, 'fake-lsp.mjs');
    writeFileSync(serverPath, String.raw`
let buffer = Buffer.alloc(0);
function send(message) {
  const body = JSON.stringify(message);
  process.stdout.write('Content-Length: ' + Buffer.byteLength(body) + '\r\n\r\n' + body);
}
process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const end = buffer.indexOf('\r\n\r\n');
    if (end < 0) return;
    const header = buffer.subarray(0, end).toString('utf8');
    const match = /Content-Length:\s*(\d+)/i.exec(header);
    if (!match) process.exit(2);
    const length = Number(match[1]);
    const start = end + 4;
    if (buffer.length < start + length) return;
    const message = JSON.parse(buffer.subarray(start, start + length).toString('utf8'));
    buffer = buffer.subarray(start + length);
    if (message.method === 'initialize') send({ jsonrpc: '2.0', id: message.id, result: { capabilities: { definitionProvider: true } } });
    else if (message.method === 'textDocument/definition') send({ jsonrpc: '2.0', id: message.id, result: [{ uri: message.params.textDocument.uri, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 6 } } }] });
    else if (message.method === 'shutdown') send({ jsonrpc: '2.0', id: message.id, result: null });
    else if (message.method === 'exit') process.exit(0);
  }
});
`);
    const provider = new GenericLspSemanticProvider({
      id: 'fake-lsp',
      language: 'fake',
      languageId: 'fake',
      command: [process.execPath, serverPath],
      extensions: ['.fake'],
      rootMarkers: ['project.fake'],
    });
    expect(provider.supports({ navigation: 'definition', path: 'project/src/main.fake', line: 1, column: 1, language: 'fake' })).toBe(true);
    expect(provider.supports({ navigation: 'definition', path: 'project/src/main.txt', line: 1, column: 1, language: 'fake' })).toBe(false);
    const [outcome] = await provider.navigate(root, [
      { navigation: 'definition', path: 'project/src/main.fake', line: 1, column: 1 },
    ], {
      cacheScope: 'test',
      sourceIdentity: 'source-v1',
      profile: 'controller',
      allowRepositoryPath: () => true,
    });
    expect(outcome?.ok).toBe(true);
    if (!outcome?.ok) throw new Error(outcome?.message ?? 'missing generic LSP outcome');
    expect(outcome.result.providerId).toBe('lsp:fake-lsp');
    expect(outcome.result.locations).toEqual([{ path: 'project/src/main.fake', line: 1, column: 1 }]);
  });

  test('generic LSP replaces an obsolete source generation instead of accumulating workspace servers', async () => {
    const root = tempRoot('forge-generic-lsp-generation-');
    const project = join(root, 'project');
    mkdirSync(join(project, 'src'), { recursive: true });
    writeFileSync(join(project, 'project.fake'), 'fake-root\n');
    writeFileSync(join(project, 'src/main.fake'), 'target\n');
    const logPath = join(root, 'lifecycle.log');
    const serverPath = join(root, 'generation-lsp.mjs');
    writeFileSync(serverPath, String.raw`
import { appendFileSync } from 'fs';
const logPath = process.argv[2];
appendFileSync(logPath, 'start\n');
let buffer = Buffer.alloc(0);
function send(message) {
  const body = JSON.stringify(message);
  process.stdout.write('Content-Length: ' + Buffer.byteLength(body) + '\r\n\r\n' + body);
}
process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const end = buffer.indexOf('\r\n\r\n');
    if (end < 0) return;
    const header = buffer.subarray(0, end).toString('utf8');
    const match = /Content-Length:\s*(\d+)/i.exec(header);
    if (!match) process.exit(2);
    const length = Number(match[1]);
    const start = end + 4;
    if (buffer.length < start + length) return;
    const message = JSON.parse(buffer.subarray(start, start + length).toString('utf8'));
    buffer = buffer.subarray(start + length);
    if (message.method === 'initialize') send({ jsonrpc: '2.0', id: message.id, result: { capabilities: { definitionProvider: true } } });
    else if (message.method === 'textDocument/definition') send({ jsonrpc: '2.0', id: message.id, result: [] });
    else if (message.method === 'shutdown') { appendFileSync(logPath, 'shutdown\n'); send({ jsonrpc: '2.0', id: message.id, result: null }); }
    else if (message.method === 'exit') process.exit(0);
  }
});
`);
    const provider = new GenericLspSemanticProvider({
      id: 'generation-lsp', language: 'fake', languageId: 'fake',
      command: [process.execPath, serverPath, logPath], extensions: ['.fake'], rootMarkers: ['project.fake'],
    });
    const navigate = (sourceIdentity: string) => provider.navigate(root, [
      { navigation: 'definition', path: 'project/src/main.fake', line: 1, column: 1 },
    ], { cacheScope: 'test', sourceIdentity, profile: 'controller', allowRepositoryPath: () => true });

    expect((await navigate('source-v1'))[0]?.ok).toBe(true);
    expect((await navigate('source-v2'))[0]?.ok).toBe(true);
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    const lifecycle = readFileSync(logPath, 'utf8').trim().split('\n');
    expect(lifecycle.filter((entry) => entry === 'start')).toHaveLength(2);
    expect(lifecycle.filter((entry) => entry === 'shutdown').length).toBeGreaterThanOrEqual(1);
  });

  test('language-server request timeout sends LSP cancellation before rejecting', async () => {
    const root = tempRoot('forge-lsp-cancel-');
    const logPath = join(root, 'cancel.log');
    const serverPath = join(root, 'cancel-lsp.mjs');
    writeFileSync(serverPath, String.raw`
import { appendFileSync } from 'fs';
const logPath = process.argv[2];
let buffer = Buffer.alloc(0);
function send(message) {
  const body = JSON.stringify(message);
  process.stdout.write('Content-Length: ' + Buffer.byteLength(body) + '\r\n\r\n' + body);
}
process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const end = buffer.indexOf('\r\n\r\n');
    if (end < 0) return;
    const header = buffer.subarray(0, end).toString('utf8');
    const match = /Content-Length:\s*(\d+)/i.exec(header);
    if (!match) process.exit(2);
    const length = Number(match[1]);
    const start = end + 4;
    if (buffer.length < start + length) return;
    const message = JSON.parse(buffer.subarray(start, start + length).toString('utf8'));
    buffer = buffer.subarray(start + length);
    if (message.method === 'initialize') send({ jsonrpc: '2.0', id: message.id, result: { capabilities: {} } });
    else if (message.method === '$/cancelRequest') appendFileSync(logPath, 'cancel:' + message.params.id + '\n');
    else if (message.method === 'shutdown') send({ jsonrpc: '2.0', id: message.id, result: null });
    else if (message.method === 'exit') process.exit(0);
  }
});
`);
    const client = new LanguageServerClient({
      repoRoot: root, workspaceRoot: root, command: [process.execPath, serverPath, logPath],
      languageId: 'fake', serverName: 'cancel-lsp',
      errorCodes: { unavailable: 'U', exited: 'E', protocol: 'P', requestFailed: 'R', timeout: 'T' },
    });
    await client.initialize(1_000);
    await expect(client.request('test/slow', {}, 50)).rejects.toThrow(/T: test\/slow exceeded 50ms/);
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    expect(readFileSync(logPath, 'utf8')).toMatch(/cancel:\d+/);
    await client.close();
  });

  test('generic LSP workspace identity follows root-marker configuration bytes', () => {
    const root = tempRoot('forge-lsp-root-');
    const project = join(root, 'project');
    const src = join(project, 'src');
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, 'main.rs'), 'fn main() {}\n');
    writeFileSync(join(project, 'Cargo.toml'), '[package]\nname = "one"\nversion = "0.1.0"\n');
    const descriptor: GenericLspProviderDescriptor = {
      id: 'rust-analyzer',
      language: 'rust',
      languageId: 'rust',
      command: ['rust-analyzer'],
      extensions: ['.rs'],
      rootMarkers: ['Cargo.toml'],
      identityFiles: ['Cargo.lock'],
    };

    const first = resolveGenericLspWorkspace(root, 'project/src/main.rs', descriptor);
    writeFileSync(join(project, 'Cargo.toml'), '[package]\nname = "two"\nversion = "0.1.0"\n');
    const second = resolveGenericLspWorkspace(root, 'project/src/main.rs', descriptor);

    expect(first.relativeRoot).toBe('project');
    expect(first.rootMarker).toBe('Cargo.toml');
    expect(second.configurationFingerprint).not.toBe(first.configurationFingerprint);
  });

  test('Swift build settings fingerprint changes with compiler configuration', () => {
    const root = tempRoot('forge-swift-settings-');
    writeFileSync(join(root, 'Package.swift'), '// swift-tools-version: 6.0\n');
    const first = swiftBuildSettingsFingerprint(root);
    writeFileSync(join(root, 'Package.swift'), '// swift-tools-version: 6.1\n');
    const second = swiftBuildSettingsFingerprint(root);
    expect(second).not.toBe(first);
  });

  test('TypeScript project membership is rebound when source identity changes', () => {
    const root = tempRoot('forge-ts-source-');
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true }, include: ['src/**/*.ts'] }));
    writeFileSync(join(root, 'src/a.ts'), 'export const alpha = 1;\n');
    const access = (sourceIdentity: string) => ({
      cacheScope: 'test',
      sourceIdentity,
      allowRepositoryPath: () => true,
    });

    navigateTypeScriptSymbol(root, { navigation: 'definition', path: 'src/a.ts', line: 1, column: 14 }, access('v1'));
    writeFileSync(join(root, 'src/b.ts'), 'export const beta = 2;\n');

    expect(() => navigateTypeScriptSymbol(root, { navigation: 'definition', path: 'src/b.ts', line: 1, column: 14 }, access('v1'))).toThrow(/does not include/);
    expect(() => navigateTypeScriptSymbol(root, { navigation: 'definition', path: 'src/b.ts', line: 1, column: 14 }, access('v2'))).not.toThrow();
  });

  test('repository-scoped invalidation clears live derived session caches immediately', () => {
    const root = tempRoot('forge-session-cache-');
    const cache = getOrCreateSessionCache('session-1', root, {
      repoId: 'repo-1',
      checkoutId: 'checkout-1',
      branch: 'main',
      head: 'abc',
      workingTreeFingerprint: 'tree-1',
    });
    cache.putSearch({ query: 'needle', includeKey: 'all', result: { hit: true }, scannedFiles: 10 });
    expect(cache.getSearch('needle', 'all')).not.toBeNull();

    expect(invalidateSessionCachesForRepository(root)).toBe(1);
    expect(cache.getSearch('needle', 'all')).toBeNull();
  });
});
