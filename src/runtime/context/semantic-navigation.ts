import { extname } from 'path';
import { navigateTypeScriptSymbol } from './typescript-navigation';
import { navigateSwiftSymbols } from './swift-navigation';
import { GenericLspSemanticProvider, type GenericLspProviderDescriptor } from './generic-lsp-provider';

export type SemanticNavigationKind = 'definition' | 'references' | 'implementations';

export interface SemanticNavigationRequest {
  navigation: SemanticNavigationKind;
  path: string;
  line: number;
  column: number;
  tsconfigPath?: string;
  language?: string;
}

export interface SemanticNavigationLocation {
  path: string;
  line: number;
  column: number;
  name?: string;
  kind?: string;
}

export interface SemanticNavigationResult {
  providerId: string;
  providerIdentity?: string;
  language: string;
  navigation: SemanticNavigationKind;
  target: { path: string; line: number; column: number };
  locations: SemanticNavigationLocation[];
  policyDeniedReads?: number;
  details?: Record<string, unknown>;
}

export type SemanticNavigationOutcome =
  | { ok: true; result: SemanticNavigationResult }
  | { ok: false; code: string; message: string };

export interface SemanticNavigationAccess {
  cacheScope: string;
  sourceIdentity?: string;
  profile: string;
  allowRepositoryPath(relativePath: string): boolean;
}

export interface SemanticNavigationProvider {
  id: string;
  languages: readonly string[];
  supports(request: SemanticNavigationRequest): boolean;
  navigate(
    repoRoot: string,
    requests: SemanticNavigationRequest[],
    access: SemanticNavigationAccess,
  ): Promise<SemanticNavigationOutcome[]>;
}

export interface IndexedSemanticNavigationRequest {
  index: number;
  request: SemanticNavigationRequest;
}

export interface IndexedSemanticNavigationOutcome {
  index: number;
  outcome: SemanticNavigationOutcome;
}

function extensionMatches(path: string, values: readonly string[]): boolean {
  return values.includes(extname(path).toLowerCase());
}

const typeScriptProvider: SemanticNavigationProvider = {
  id: 'typescript-language-service',
  languages: ['typescript'],
  supports: (request) => {
    const extensionSupported = extensionMatches(request.path, ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs']);
    return extensionSupported && (!request.language || request.language.toLowerCase() === 'typescript');
  },
  async navigate(repoRoot, requests, access) {
    return requests.map((request) => {
      let policyDeniedReads = 0;
      try {
        const result = navigateTypeScriptSymbol(repoRoot, {
          navigation: request.navigation,
          path: request.path,
          line: request.line,
          column: request.column,
          tsconfigPath: request.tsconfigPath,
        }, {
          cacheScope: access.cacheScope,
          sourceIdentity: access.sourceIdentity,
          allowRepositoryPath: (relativePath) => {
            const allowed = access.allowRepositoryPath(relativePath);
            if (!allowed) policyDeniedReads += 1;
            return allowed;
          },
        });
        return {
          ok: true,
          result: {
            providerId: 'typescript-language-service',
            language: 'typescript',
            navigation: result.navigation,
            target: result.target,
            locations: result.locations,
            policyDeniedReads,
          },
        } satisfies SemanticNavigationOutcome;
      } catch (error) {
        return { ok: false, code: 'SEMANTIC_NAVIGATION_FAILED', message: error instanceof Error ? error.message : String(error) } satisfies SemanticNavigationOutcome;
      }
    });
  },
};

const swiftProvider: SemanticNavigationProvider = {
  id: 'sourcekit-lsp',
  languages: ['swift'],
  supports: (request) => extensionMatches(request.path, ['.swift'])
    && (!request.language || request.language.toLowerCase() === 'swift'),
  async navigate(repoRoot, requests, access) {
    const invalid = new Map<number, SemanticNavigationOutcome>();
    const eligible: Array<{ index: number; request: SemanticNavigationRequest }> = [];
    requests.forEach((request, index) => {
      if (request.tsconfigPath) {
        invalid.set(index, { ok: false, code: 'SWIFT_SEMANTIC_TSCONFIG_UNSUPPORTED', message: 'tsconfig_path applies only to TypeScript semantic navigation.' });
      } else if (access.profile !== 'controller') {
        invalid.set(index, { ok: false, code: 'SWIFT_SEMANTIC_READ_SCOPE_UNSUPPORTED', message: 'External SourceKit-LSP navigation is restricted to the controller read profile; use lexical/CodeGraph evidence under narrower read policies.' });
      } else {
        eligible.push({ index, request });
      }
    });
    const outputs: Array<SemanticNavigationOutcome | undefined> = new Array(requests.length);
    for (const [index, outcome] of invalid) outputs[index] = outcome;
    if (eligible.length > 0) {
      const outcomes = await navigateSwiftSymbols(repoRoot, eligible.map(({ request }) => ({
        navigation: request.navigation,
        path: request.path,
        line: request.line,
        column: request.column,
      })), {
        allowRepositoryPath: access.allowRepositoryPath,
      });
      outcomes.forEach((outcome, offset) => {
        const original = eligible[offset]!;
        outputs[original.index] = outcome.ok
          ? {
              ok: true,
              result: {
                providerId: 'sourcekit-lsp',
                providerIdentity: outcome.result.workspace.buildSettingsFingerprint,
                language: 'swift',
                navigation: outcome.result.navigation,
                target: outcome.result.target,
                locations: outcome.result.locations,
                policyDeniedReads: 0,
                details: { workspace: outcome.result.workspace, timingsMs: outcome.result.timingsMs },
              },
            }
          : outcome;
      });
    }
    return outputs.map((outcome) => outcome ?? ({ ok: false, code: 'SWIFT_SEMANTIC_NAVIGATION_FAILED', message: 'Swift semantic provider produced no outcome.' }));
  },
};

export class SemanticProviderRegistry {
  private readonly providers: SemanticNavigationProvider[] = [];

  register(provider: SemanticNavigationProvider): this {
    if (this.providers.some((candidate) => candidate.id === provider.id)) {
      throw new Error(`SEMANTIC_PROVIDER_DUPLICATE: ${provider.id}`);
    }
    this.providers.push(provider);
    return this;
  }

  list(): Array<{ id: string; languages: readonly string[] }> {
    return this.providers.map((provider) => ({ id: provider.id, languages: provider.languages }));
  }

  resolve(request: SemanticNavigationRequest): SemanticNavigationProvider | undefined {
    return this.providers.find((provider) => provider.supports(request));
  }

  async navigate(
    repoRoot: string,
    requests: IndexedSemanticNavigationRequest[],
    access: SemanticNavigationAccess,
  ): Promise<IndexedSemanticNavigationOutcome[]> {
    const output: IndexedSemanticNavigationOutcome[] = [];
    const groups = new Map<SemanticNavigationProvider, IndexedSemanticNavigationRequest[]>();
    for (const entry of requests) {
      const provider = this.resolve(entry.request);
      if (!provider) {
        output.push({
          index: entry.index,
          outcome: {
            ok: false,
            code: 'SEMANTIC_PROVIDER_UNAVAILABLE',
            message: `No semantic provider is registered for ${entry.request.path}${entry.request.language ? ` (language=${entry.request.language})` : ''}.`,
          },
        });
        continue;
      }
      const group = groups.get(provider) ?? [];
      group.push(entry);
      groups.set(provider, group);
    }
    for (const [provider, group] of groups) {
      let outcomes: SemanticNavigationOutcome[];
      try {
        outcomes = await provider.navigate(repoRoot, group.map((entry) => entry.request), access);
      } catch (error) {
        outcomes = group.map(() => ({ ok: false, code: 'SEMANTIC_PROVIDER_FAILED', message: error instanceof Error ? error.message : String(error) }));
      }
      group.forEach((entry, offset) => {
        output.push({
          index: entry.index,
          outcome: outcomes[offset] ?? { ok: false, code: 'SEMANTIC_PROVIDER_FAILED', message: `${provider.id} returned no outcome.` },
        });
      });
    }
    return output.sort((left, right) => left.index - right.index);
  }
}

export const DEFAULT_GENERIC_LSP_DESCRIPTORS: readonly GenericLspProviderDescriptor[] = [
  {
    id: 'rust-analyzer',
    language: 'rust',
    languageId: 'rust',
    command: ['rust-analyzer'],
    extensions: ['.rs'],
    rootMarkers: ['Cargo.toml'],
    identityFiles: ['Cargo.lock', 'rust-toolchain.toml', 'rust-toolchain'],
  },
  {
    id: 'gopls',
    language: 'go',
    languageId: 'go',
    command: ['gopls'],
    extensions: ['.go'],
    rootMarkers: ['go.work', 'go.mod'],
    identityFiles: ['go.sum'],
  },
  {
    id: 'basedpyright',
    language: 'python',
    languageId: 'python',
    command: ['basedpyright-langserver', '--stdio'],
    extensions: ['.py', '.pyi'],
    rootMarkers: ['pyproject.toml', 'basedpyrightconfig.json', 'pyrightconfig.json'],
    identityFiles: ['uv.lock', 'poetry.lock', 'requirements.txt'],
  },
  {
    id: 'clangd',
    language: 'cpp',
    languageId: 'cpp',
    command: ['clangd'],
    extensions: ['.c', '.cc', '.cpp', '.cxx', '.h', '.hh', '.hpp', '.hxx'],
    rootMarkers: ['compile_commands.json', '.clangd', 'CMakeLists.txt'],
    identityFiles: ['compile_flags.txt'],
  },
];

export function createDefaultSemanticProviderRegistry(): SemanticProviderRegistry {
  const registry = new SemanticProviderRegistry()
    .register(typeScriptProvider)
    .register(swiftProvider);
  for (const descriptor of DEFAULT_GENERIC_LSP_DESCRIPTORS) registry.register(new GenericLspSemanticProvider(descriptor));
  return registry;
}

export const defaultSemanticProviderRegistry = createDefaultSemanticProviderRegistry();
