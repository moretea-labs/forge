import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import type { RepositoryRecord } from '../../cli/repositories/types';
import { controllerSystemRoot, repositoryControllerRoot } from '../../cli/repositories/controller-home';
import { resolveTrustedNodeExecutable } from '../shared/trusted-node-executable';
import { startLightweightInternalProcess, waitForLightweightProcess } from '../execution/process-runtime/lightweight-managed';
import { getProcessHandle, spawnManagedProcess, waitForProcess } from '../execution/process-runtime/runtime';
import { getProcessRecord, getProcessRequestBinding } from '../execution/process-runtime/store';
import type { ProcessHandle } from '../execution/process-runtime/types';
import { FORGE_INSTANCE_PROCESS_SCOPE_KEY } from '../execution/process-runtime/process-scope';
import type { ResolvedExecutionIdentity } from '../control-plane/execution/execution-identity';
import type { AssistantPluginActionRequest } from './types';

interface LightweightPluginActionEnvelope {
  schemaVersion: 1;
  controllerHome: string;
  /** Legacy repository envelope coordinate; absent for ForgeInstance-scoped controller plugins. */
  repoId?: string;
  scope?: { kind: 'controller' } | { kind: 'repository'; repoId: string };
  request: Omit<AssistantPluginActionRequest, 'signal'>;
}

function privateAtomicWrite(path: string, content: string): void {
  mkdirSync(resolve(path, '..'), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, content, { encoding: 'utf8', mode: 0o600 });
  renameSync(temporary, path);
}

function envelopeBytes(controllerHome: string, repository: RepositoryRecord, request: AssistantPluginActionRequest): string {
  const { signal: _signal, ...serializableRequest } = request;
  const envelope: LightweightPluginActionEnvelope = {
    schemaVersion: 1,
    controllerHome,
    repoId: repository.repoId,
    scope: { kind: 'repository', repoId: repository.repoId },
    request: serializableRequest,
  };
  return `${JSON.stringify(envelope)}\n`;
}

function controllerEnvelopeBytes(controllerHome: string, request: AssistantPluginActionRequest): string {
  const { signal: _signal, ...serializableRequest } = request;
  const envelope: LightweightPluginActionEnvelope = {
    schemaVersion: 1,
    controllerHome,
    scope: { kind: 'controller' },
    request: serializableRequest,
  };
  return `${JSON.stringify(envelope)}\n`;
}

export interface LightweightPluginActionStart {
  handle: ProcessHandle;
  requestSha256: string;
}

export interface LightweightPluginActionRuntimeInvocation {
  executable: string;
  argsPrefix: string[];
  identity: 'compiled_release_sidecar' | 'package_release_node' | 'source_node';
}

function trustedNodeExecutable(explicit?: string): string {
  const executable = explicit?.trim() || resolveTrustedNodeExecutable().executable;
  if (!executable) {
    throw new Error('NODE_EXECUTABLE_UNAVAILABLE: typed plugin sidecar requires a bundled Runtime sidecar or trusted Node executable');
  }
  return executable;
}

export function resolveLightweightPluginActionRuntimeInvocation(options: {
  releasePath?: string;
  execPath?: string;
  sourceDir?: string;
  nodeExecutable?: string;
} = {}): LightweightPluginActionRuntimeInvocation {
  const releasePath = (options.releasePath ?? process.env.FORGE_RELEASE_PATH)?.trim();
  if (releasePath) {
    const releaseRoot = resolve(releasePath);
    const compiledSidecar = join(releaseRoot, 'forge-plugin-action-sidecar');
    if (existsSync(compiledSidecar)) {
      return { executable: compiledSidecar, argsPrefix: [], identity: 'compiled_release_sidecar' };
    }
    const packageSidecar = join(releaseRoot, 'package', 'src', 'runtime', 'plugins', 'plugin-action-sidecar.ts');
    const packageLoader = join(releaseRoot, 'package', 'src', 'runtime', 'shared', 'node-ts-loader.mjs');
    if (existsSync(packageSidecar) && existsSync(packageLoader)) {
      return {
        executable: trustedNodeExecutable(options.nodeExecutable),
        argsPrefix: ['--loader', packageLoader, packageSidecar],
        identity: 'package_release_node',
      };
    }
    throw new Error(`RUNTIME_PLUGIN_ACTION_SIDECAR_UNAVAILABLE: immutable Runtime release has no plugin action sidecar: ${releaseRoot}`);
  }

  const execPath = options.execPath ?? process.execPath;
  const compiledSidecar = join(dirname(execPath), 'forge-plugin-action-sidecar');
  if (existsSync(compiledSidecar)) {
    return { executable: compiledSidecar, argsPrefix: [], identity: 'compiled_release_sidecar' };
  }

  const sourceDir = options.sourceDir ?? import.meta.dir;
  const sourceSidecar = resolve(sourceDir, 'plugin-action-sidecar.ts');
  const sourceLoader = resolve(sourceDir, '../shared/node-ts-loader.mjs');
  if (existsSync(sourceSidecar) && existsSync(sourceLoader)) {
    return {
      executable: trustedNodeExecutable(options.nodeExecutable),
      argsPrefix: ['--loader', sourceLoader, sourceSidecar],
      identity: 'source_node',
    };
  }
  throw new Error(`RUNTIME_PLUGIN_ACTION_SIDECAR_UNAVAILABLE: no runtime-owned plugin action sidecar or loader is available from ${sourceDir}`);
}

export async function startLightweightPluginAction(input: {
  controllerHome: string;
  repository: RepositoryRecord;
  request: AssistantPluginActionRequest;
  interactiveWaitMs?: number;
  timeoutMs: number;
}): Promise<LightweightPluginActionStart> {
  const requestToken = createHash('sha256')
    .update(`${input.repository.repoId}\u0000${input.request.requestId}`)
    .digest('hex')
    .slice(0, 24);
  const requestRoot = join(repositoryControllerRoot(input.controllerHome, input.repository.repoId), 'plugin-action-processes');
  const requestPath = join(requestRoot, `${requestToken}.request.json`);
  const bytes = envelopeBytes(input.controllerHome, input.repository, input.request);
  const requestSha256 = createHash('sha256').update(bytes).digest('hex');
  if (existsSync(requestPath)) {
    const existing = readFileSync(requestPath, 'utf8');
    const existingSha256 = createHash('sha256').update(existing).digest('hex');
    if (existingSha256 !== requestSha256) {
      throw new Error(`PROCESS_REQUEST_CONFLICT: plugin request ${input.request.requestId} already has different arguments`);
    }
  } else {
    privateAtomicWrite(requestPath, bytes);
  }

  const invocation = resolveLightweightPluginActionRuntimeInvocation();
  const { handle } = await startLightweightInternalProcess({
    controllerHome: input.controllerHome,
    repoId: input.repository.repoId,
    executable: invocation.executable,
    args: [
      ...invocation.argsPrefix,
      '--request', requestPath,
      '--expected-sha256', requestSha256,
    ],
    cwd: input.repository.canonicalRoot,
    interactiveWaitMs: Math.max(0, input.interactiveWaitMs ?? 750),
    timeoutMs: input.timeoutMs,
    workId: input.request.workId,
    commandId: `plugin-action:${input.request.requestId}`,
    maxOutputBytes: 64 * 1024,
    signal: input.request.signal,
  });
  return { handle, requestSha256 };
}

export async function startManagedControllerPluginAction(input: {
  controllerHome: string;
  request: AssistantPluginActionRequest;
  interactiveWaitMs?: number;
  timeoutMs: number;
}): Promise<LightweightPluginActionStart> {
  const scopeKey = FORGE_INSTANCE_PROCESS_SCOPE_KEY;
  const requestToken = createHash('sha256')
    .update(`${scopeKey}\u0000${input.request.requestId}`)
    .digest('hex')
    .slice(0, 24);
  const instanceRoot = controllerSystemRoot(input.controllerHome);
  const requestRoot = join(instanceRoot, 'plugin-action-processes');
  const requestPath = join(requestRoot, `${requestToken}.request.json`);
  const bytes = controllerEnvelopeBytes(input.controllerHome, input.request);
  const requestSha256 = createHash('sha256').update(bytes).digest('hex');
  const existingBinding = getProcessRequestBinding(input.controllerHome, scopeKey, undefined, input.request.requestId);
  if (existingBinding) {
    if (existsSync(requestPath)) {
      const existingBytes = readFileSync(requestPath, 'utf8');
      if (createHash('sha256').update(existingBytes).digest('hex') !== requestSha256) {
        throw new Error(`PROCESS_REQUEST_CONFLICT: plugin request ${input.request.requestId} already has different arguments`);
      }
    }
    const existing = getProcessHandle(input.controllerHome, scopeKey, existingBinding.processId);
    if (!existing) throw new Error(`PROCESS_REQUEST_INCOMPLETE: plugin request ${input.request.requestId} is bound to missing process ${existingBinding.processId}; refusing re-execution`);
    const processRecord = getProcessRecord(input.controllerHome, scopeKey, existingBinding.processId);
    if (processRecord?.origin?.requestSemanticFingerprint && processRecord.origin.requestSemanticFingerprint !== requestSha256) {
      throw new Error(`PROCESS_REQUEST_CONFLICT: plugin request ${input.request.requestId} already has different arguments`);
    }
    return { handle: { ...existing, deduplicated: true, requestId: input.request.requestId }, requestSha256 };
  }
  if (existsSync(requestPath)) {
    const existingBytes = readFileSync(requestPath, 'utf8');
    if (createHash('sha256').update(existingBytes).digest('hex') !== requestSha256) {
      throw new Error(`PROCESS_REQUEST_CONFLICT: plugin request ${input.request.requestId} already has different arguments`);
    }
  } else {
    privateAtomicWrite(requestPath, bytes);
  }
  const invocation = resolveLightweightPluginActionRuntimeInvocation();
  const executionIdentity: ResolvedExecutionIdentity = Object.freeze({
    schemaVersion: 1 as const,
    authority: 'forge_instance' as const,
    repositoryId: scopeKey,
    checkoutId: scopeKey,
    canonicalRoot: instanceRoot,
  });
  const handle = await spawnManagedProcess({
    controllerHome: input.controllerHome,
    repoId: scopeKey,
    principalId: input.request.origin.actor?.trim() || undefined,
    executionIdentity,
    commandId: `plugin-action:${input.request.requestId}`,
    trustedRuntimeChild: 'plugin_action_sidecar',
    command: {
      kind: 'argv',
      executable: invocation.executable,
      args: [...invocation.argsPrefix, '--request', requestPath, '--expected-sha256', requestSha256],
      cwd: instanceRoot,
    },
    interactiveWaitMs: Math.max(0, input.interactiveWaitMs ?? 750),
    timeoutMs: input.timeoutMs,
    maxOutputBytes: 64 * 1024,
    origin: {
      surface: 'mcp',
      toolName: 'plugin_action_execute',
      requestId: input.request.requestId,
      requestSemanticFingerprint: requestSha256,
      correlationId: input.request.workId,
    },
    signal: input.request.signal,
  });
  return { handle, requestSha256 };
}

export async function startManagedPluginAction(input: {
  controllerHome: string;
  repository: RepositoryRecord;
  request: AssistantPluginActionRequest;
  interactiveWaitMs?: number;
  timeoutMs: number;
}): Promise<LightweightPluginActionStart> {
  const requestToken = createHash('sha256')
    .update(`${input.repository.repoId}\u0000${input.request.requestId}`)
    .digest('hex')
    .slice(0, 24);
  const requestRoot = join(repositoryControllerRoot(input.controllerHome, input.repository.repoId), 'plugin-action-processes');
  const requestPath = join(requestRoot, `${requestToken}.request.json`);
  const bytes = envelopeBytes(input.controllerHome, input.repository, input.request);
  const requestSha256 = createHash('sha256').update(bytes).digest('hex');

  const existingBinding = getProcessRequestBinding(
    input.controllerHome,
    input.repository.repoId,
    input.repository.activeCheckoutId,
    input.request.requestId,
  );
  if (existingBinding) {
    if (existsSync(requestPath)) {
      const existingBytes = readFileSync(requestPath, 'utf8');
      const existingSha256 = createHash('sha256').update(existingBytes).digest('hex');
      if (existingSha256 !== requestSha256) {
        throw new Error(`PROCESS_REQUEST_CONFLICT: plugin request ${input.request.requestId} already has different arguments`);
      }
    }
    const existing = getProcessHandle(input.controllerHome, input.repository.repoId, existingBinding.processId);
    if (!existing) {
      throw new Error(`PROCESS_REQUEST_INCOMPLETE: plugin request ${input.request.requestId} is bound to missing process ${existingBinding.processId}; refusing re-execution`);
    }
    const processRecord = getProcessRecord(input.controllerHome, input.repository.repoId, existingBinding.processId);
    if (processRecord?.origin?.requestSemanticFingerprint && processRecord.origin.requestSemanticFingerprint !== requestSha256) {
      throw new Error(`PROCESS_REQUEST_CONFLICT: plugin request ${input.request.requestId} already has different arguments`);
    }
    return { handle: { ...existing, deduplicated: true, requestId: input.request.requestId }, requestSha256 };
  }

  if (existsSync(requestPath)) {
    const existingBytes = readFileSync(requestPath, 'utf8');
    const existingSha256 = createHash('sha256').update(existingBytes).digest('hex');
    if (existingSha256 !== requestSha256) {
      throw new Error(`PROCESS_REQUEST_CONFLICT: plugin request ${input.request.requestId} already has different arguments`);
    }
  } else {
    privateAtomicWrite(requestPath, bytes);
  }

  const invocation = resolveLightweightPluginActionRuntimeInvocation();
  const executionIdentity: ResolvedExecutionIdentity = Object.freeze({
    schemaVersion: 1 as const,
    authority: 'ephemeral_workspace' as const,
    repositoryId: input.repository.repoId,
    checkoutId: input.repository.activeCheckoutId,
    canonicalRoot: input.repository.canonicalRoot,
    ...(input.request.workId ? { workId: input.request.workId } : {}),
  });
  const handle = await spawnManagedProcess({
    controllerHome: input.controllerHome,
    repoId: input.repository.repoId,
    checkoutId: input.repository.activeCheckoutId,
    executionIdentity,
    workId: input.request.workId,
    commandId: `plugin-action:${input.request.requestId}`,
    trustedRuntimeChild: 'plugin_action_sidecar',
    command: {
      kind: 'argv',
      executable: invocation.executable,
      args: [
        ...invocation.argsPrefix,
        '--request', requestPath,
        '--expected-sha256', requestSha256,
      ],
      cwd: input.repository.canonicalRoot,
    },
    interactiveWaitMs: Math.max(0, input.interactiveWaitMs ?? 750),
    timeoutMs: input.timeoutMs,
    maxOutputBytes: 64 * 1024,
    origin: {
      surface: 'mcp',
      toolName: 'plugin_action_execute',
      requestId: input.request.requestId,
      requestSemanticFingerprint: requestSha256,
      correlationId: input.request.workId,
    },
    signal: input.request.signal,
  });
  return { handle, requestSha256 };
}

export async function waitManagedControllerPluginAction(
  controllerHome: string,
  processId: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<ProcessHandle> {
  return waitForProcess(controllerHome, FORGE_INSTANCE_PROCESS_SCOPE_KEY, processId, { timeoutMs, signal });
}

export async function waitManagedPluginAction(
  controllerHome: string,
  repoId: string,
  processId: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<ProcessHandle> {
  return waitForProcess(controllerHome, repoId, processId, { timeoutMs, signal });
}

export async function waitLightweightPluginAction(
  controllerHome: string,
  repoId: string,
  processId: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<ProcessHandle> {
  return waitForLightweightProcess(controllerHome, repoId, processId, { timeoutMs, signal });
}
