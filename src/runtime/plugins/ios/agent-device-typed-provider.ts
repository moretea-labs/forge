import { existsSync, readFileSync, realpathSync } from 'fs';
import { dirname, join } from 'path';
import { createRequire } from 'module';
import { AssistantPluginError } from '../errors';
import type {
  AgentDeviceProviderIdentity,
  AgentDeviceReadProvider,
  AgentDeviceSessionContext,
  AgentDeviceSnapshotEnvelope,
  AgentDeviceSnapshotRequest,
} from './agent-device-provider';

interface TypedAgentDeviceClient {
  capture: {
    snapshot(options: Record<string, unknown>): Promise<Record<string, unknown>>;
  };
}

interface TypedAgentDeviceModule {
  createAgentDeviceClient(
    config?: Record<string, unknown>,
    deps?: Record<string, unknown>,
  ): TypedAgentDeviceClient;
  isAgentDeviceError?(error: unknown): boolean;
  normalizeAgentDeviceError?(error: unknown): Record<string, unknown>;
}

interface TypedProviderHooks {
  loadModule: () => Promise<TypedAgentDeviceModule>;
  resolveModule: () => string | undefined;
  runtimeNodeVersion: () => string;
}

const require = createRequire(import.meta.url);
const MIN_TYPED_CLIENT_NODE_VERSION = '22.12.0';

function parseVersion(value: string): [number, number, number] | undefined {
  const match = value.trim().match(/^v?(\d+)\.(\d+)\.(\d+)/);
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function versionAtLeast(value: string, minimum: string): boolean {
  const actual = parseVersion(value);
  const required = parseVersion(minimum);
  if (!actual || !required) return false;
  for (let index = 0; index < 3; index += 1) {
    if (actual[index]! > required[index]!) return true;
    if (actual[index]! < required[index]!) return false;
  }
  return true;
}

function nearestPackageJson(start: string): string | undefined {
  let current = dirname(start);
  for (let index = 0; index < 8; index += 1) {
    const candidate = join(current, 'package.json');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return undefined;
}

function defaultResolveModule(): string | undefined {
  try {
    return realpathSync(require.resolve('agent-device'));
  } catch {
    return undefined;
  }
}

let hooks: TypedProviderHooks = {
  loadModule: async () => import('agent-device') as unknown as TypedAgentDeviceModule,
  resolveModule: defaultResolveModule,
  runtimeNodeVersion: () => process.versions.node,
};

export function setAgentDeviceTypedProviderHooksForTest(
  next: Partial<TypedProviderHooks>,
): void {
  hooks = { ...hooks, ...next };
}

export function resetAgentDeviceTypedProviderHooksForTest(): void {
  hooks = {
    loadModule: async () => import('agent-device') as unknown as TypedAgentDeviceModule,
    resolveModule: defaultResolveModule,
    runtimeNodeVersion: () => process.versions.node,
  };
}

export function typedAgentDeviceIdentity(): AgentDeviceProviderIdentity {
  const runtimeVersion = hooks.runtimeNodeVersion();
  if (!versionAtLeast(runtimeVersion, MIN_TYPED_CLIENT_NODE_VERSION)) {
    return {
      kind: 'typed',
      available: false,
      runtimeVersion,
      minimumRuntimeVersion: MIN_TYPED_CLIENT_NODE_VERSION,
      reason: `The optional agent-device typed client requires Node >=${MIN_TYPED_CLIENT_NODE_VERSION}; current runtime is ${runtimeVersion || 'unknown'}.`,
    };
  }
  const resolvedModule = hooks.resolveModule();
  if (!resolvedModule) {
    return {
      kind: 'typed',
      available: false,
      runtimeVersion,
      minimumRuntimeVersion: MIN_TYPED_CLIENT_NODE_VERSION,
      reason: 'The optional agent-device typed client is not installed.',
    };
  }
  let version: string | undefined;
  const packageJson = nearestPackageJson(resolvedModule);
  if (packageJson) {
    try {
      const parsed = JSON.parse(readFileSync(packageJson, 'utf8')) as { version?: unknown };
      if (typeof parsed.version === 'string') version = parsed.version;
    } catch {
      // Availability is still valid; version remains unknown and is reported.
    }
  }
  return {
    kind: 'typed',
    available: true,
    version,
    resolvedModule,
    runtimeVersion,
    minimumRuntimeVersion: MIN_TYPED_CLIENT_NODE_VERSION,
  };
}

function providerError(error: unknown): AssistantPluginError {
  if (error instanceof AssistantPluginError) return error;
  const record = error && typeof error === 'object' && !Array.isArray(error)
    ? error as Record<string, unknown>
    : {};
  const nested = record.error && typeof record.error === 'object' && !Array.isArray(record.error)
    ? record.error as Record<string, unknown>
    : undefined;
  const providerCode = typeof record.code === 'string'
    ? record.code
    : typeof nested?.code === 'string'
      ? nested.code
      : undefined;
  const message = typeof record.message === 'string'
    ? record.message
    : typeof nested?.message === 'string'
      ? nested.message
      : String(error || 'agent-device typed client failed.');
  return new AssistantPluginError('AGENT_DEVICE_TYPED_COMMAND_FAILED', message, {
    retryable: record.retriable === true || nested?.retriable === true,
    details: {
      providerCode,
      providerBackend: 'typed',
      providerHint: typeof record.hint === 'string'
        ? record.hint
        : typeof nested?.hint === 'string'
          ? nested.hint
          : undefined,
    },
  });
}

function snapshotOptions(
  context: AgentDeviceSessionContext,
  request: AgentDeviceSnapshotRequest,
): Record<string, unknown> {
  return {
    platform: context.platform,
    device: context.device,
    session: context.session,
    requestId: context.requestId,
    interactiveOnly: request.interactiveOnly === true,
    raw: request.raw === true,
    forceFull: request.forceFull === true,
    ...(typeof request.depth === 'number' ? { depth: request.depth } : {}),
    ...(request.scope ? { scope: request.scope } : {}),
    timeoutMs: context.timeoutMs,
    noRecord: true,
  };
}

export class TypedAgentDeviceReadProvider implements AgentDeviceReadProvider {
  readonly identity: AgentDeviceProviderIdentity;

  constructor(identity = typedAgentDeviceIdentity()) {
    this.identity = identity;
  }

  async snapshot(
    context: AgentDeviceSessionContext,
    request: AgentDeviceSnapshotRequest,
  ): Promise<AgentDeviceSnapshotEnvelope> {
    if (!this.identity.available) {
      throw new AssistantPluginError(
        'AGENT_DEVICE_TYPED_PROVIDER_UNAVAILABLE',
        this.identity.reason ?? 'The agent-device typed client is unavailable.',
        { retryable: false, details: { ...this.identity } },
      );
    }
    let module: TypedAgentDeviceModule;
    try {
      module = await hooks.loadModule();
    } catch (error) {
      throw new AssistantPluginError(
        'AGENT_DEVICE_TYPED_PROVIDER_UNAVAILABLE',
        'The optional agent-device typed client could not be loaded.',
        {
          retryable: false,
          details: {
            ...this.identity,
            cause: error instanceof Error ? error.message : String(error),
          },
        },
      );
    }
    try {
      const client = module.createAgentDeviceClient({
        stateDir: context.stateDir,
        session: context.session,
        requestId: context.requestId,
        cwd: context.cwd,
        cost: true,
        responseLevel: 'full',
      });
      const data = await client.capture.snapshot(snapshotOptions(context, request));
      return {
        success: true,
        data,
        provider: 'typed',
      };
    } catch (error) {
      throw providerError(error);
    }
  }
}

export function isTypedProviderUnavailable(error: unknown): boolean {
  return error instanceof AssistantPluginError
    && error.code === 'AGENT_DEVICE_TYPED_PROVIDER_UNAVAILABLE';
}
