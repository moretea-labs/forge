import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import type { RepositoryRecord } from '../../cli/repositories/types';
import { repositoryControllerRoot } from '../../cli/repositories/controller-home';
import { resolveTrustedNodeExecutable } from '../shared/trusted-node-executable';
import { startLightweightInternalProcess, waitForLightweightProcess } from '../execution/process-runtime/lightweight-managed';
import type { ProcessHandle } from '../execution/process-runtime/types';
import type { AssistantPluginActionRequest } from './types';

interface LightweightPluginActionEnvelope {
  schemaVersion: 1;
  controllerHome: string;
  repoId: string;
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
    request: serializableRequest,
  };
  return `${JSON.stringify(envelope)}\n`;
}

export interface LightweightPluginActionStart {
  handle: ProcessHandle;
  requestSha256: string;
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

  const runtimeSidecar = join(dirname(process.execPath), 'forge-plugin-action-sidecar');
  const useBundledSidecar = existsSync(runtimeSidecar);
  const nodeExecutable = useBundledSidecar ? undefined : resolveTrustedNodeExecutable().executable;
  if (!useBundledSidecar && !nodeExecutable) {
    throw new Error('NODE_EXECUTABLE_UNAVAILABLE: typed plugin sidecar requires a bundled Runtime sidecar or trusted Node executable');
  }
  const sourceSidecarPath = resolve(import.meta.dir, 'plugin-action-sidecar.ts');
  const loaderPath = resolve(import.meta.dir, '../shared/node-ts-loader.mjs');
  const { handle } = await startLightweightInternalProcess({
    controllerHome: input.controllerHome,
    repoId: input.repository.repoId,
    executable: useBundledSidecar ? runtimeSidecar : nodeExecutable!,
    args: useBundledSidecar
      ? ['--request', requestPath, '--expected-sha256', requestSha256]
      : [
          '--loader', loaderPath,
          sourceSidecarPath,
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

export async function waitLightweightPluginAction(
  controllerHome: string,
  repoId: string,
  processId: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<ProcessHandle> {
  return waitForLightweightProcess(controllerHome, repoId, processId, { timeoutMs, signal });
}
