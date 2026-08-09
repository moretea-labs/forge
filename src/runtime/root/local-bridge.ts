import {
  loadMcpServiceLocalConfig,
  loadMcpServiceRuntimeState,
  writeMcpServiceRuntimeState,
} from '../../cli/mcp/auth';
import { startLocalBridgeServer } from '../../cli/local-bridge/server';
import { readRuntimeGeneration } from '../control-plane/runtime-generation';

export interface RuntimeLocalBridgeHandle {
  endpoint: string;
  close(): Promise<void>;
}

/**
 * Start the configured Local Bridge inside the canonical Runtime process.
 * Explicit standalone/remote modes remain externally owned; absent mode is
 * migrated to the canonical embedded topology.
 */
export async function startConfiguredRuntimeLocalBridge(input: {
  controllerHome: string;
  repositoryRoot: string;
}): Promise<RuntimeLocalBridgeHandle | undefined> {
  const config = loadMcpServiceLocalConfig(input.controllerHome);
  const local = config?.localController;
  if (local?.enabled !== true || local.mode === 'disabled' || local.mode === 'remote' || local.mode === 'standalone') {
    return undefined;
  }

  const startedAt = new Date().toISOString();
  const handle = await startLocalBridgeServer({
    repoRoot: input.repositoryRoot,
    controllerHome: input.controllerHome,
    host: local.host ?? '127.0.0.1',
    port: local.port ?? 8766,
    openBrowser: local.autoOpen === true,
    mode: 'embedded',
  });
  const generation = readRuntimeGeneration(input.controllerHome)?.generation;
  const current = loadMcpServiceRuntimeState(input.controllerHome);
  if (current) {
    writeMcpServiceRuntimeState(input.controllerHome, {
      ...current,
      updatedAt: startedAt,
      localController: {
        endpoint: handle.url,
        running: true,
        mode: 'embedded',
        pid: process.pid,
        startedAt,
        generation,
      },
    });
  }

  return {
    endpoint: handle.url,
    close: async () => {
      await handle.close();
      const latest = loadMcpServiceRuntimeState(input.controllerHome);
      if (latest?.localController?.pid === process.pid) {
        writeMcpServiceRuntimeState(input.controllerHome, {
          ...latest,
          updatedAt: new Date().toISOString(),
          localController: {
            ...latest.localController,
            running: false,
          },
        });
      }
    },
  };
}
