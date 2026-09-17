import type { Express } from 'express';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import { createMcpToolContext } from '../server';
import { loadMcpServiceRuntimeState, type McpHttpAuthMode } from '../auth';
import { buildMcpToolDefinitions } from '../tool-mapping/tools';
import { controllerExposureSnapshot } from '../toolset';
import { runtimeIdentitySnapshot } from '../runtime-gateway/runtime-tools';
import { readForgeRuntimeStatus } from '../../../src/runtime/control-plane/runtime-status-client';
import { projectionBlocksReadiness, readRepositoryProjectionSnapshot } from '../../../src/runtime/projections/materialized-view';
import { readRuntimeGeneration } from '../../../src/runtime/control-plane/runtime-generation';
import { getRepository, listRepositories } from '../../../src/cli/repositories/registry';
import { buildControllerTaskLedgerProjection } from '../../../src/cli/controller/task-ledger';
import { legacyIssueAuthorityRetired } from '../../../src/cli/controller/legacy-issue-cutover';
import { reconcileReadinessProjectionSource } from '../readiness-projection';
import {
  FORGE_MCP_SCHEMA_VERSION,
  FORGE_TOOL_SURFACE,
  FORGE_VERSION,
  repositoryIdentity,
} from '../../../src/cli/controller/runtime-config';
import { McpSessionRegistry } from './session-registry';

type McpToolContext = ReturnType<typeof createMcpToolContext>;
type HttpSessionRegistry = McpSessionRegistry<NodeStreamableHTTPServerTransport, McpToolContext>;

interface McpRuntimeStats {
  initializing: number;
  activePosts: number;
  rejectedOverload: number;
}

export interface McpHttpObservationRouteOptions {
  app: Express;
  toolContext: McpToolContext;
  sessionRegistry: HttpSessionRegistry;
  runtimeStats: McpRuntimeStats;
  runtimeControllerHome?: string;
  repoRoot?: string;
  forgeInstanceId: string;
  currentRuntimeToolSurfaceFingerprint: () => string | undefined;
  toolSurface: string;
  toolSurfaceSchemaVersion: number;
  forgeVersion: string;
  authMode: McpHttpAuthMode;
  authTokenConfigured: boolean;
  oauthPassphraseConfigured: boolean;
  oauthAuthorizationCodeDiagnostics?: () => unknown;
  configuredPublicOrigin?: string;
  host: string;
  port: number;
  enableChatgptBrowser: boolean;
  localController: {
    enabled: boolean;
    host: string;
    port: number;
  };
  maxInitializingSessions: number;
  maxActivePosts: number;
}

function localControllerDiagnosticMatchesRuntime(
  payload: Record<string, unknown> | null,
  generation?: string,
): boolean {
  return payload?.status === 'ok'
    && payload.toolSurface === FORGE_TOOL_SURFACE
    && payload.schemaVersion === FORGE_MCP_SCHEMA_VERSION
    && payload.version === FORGE_VERSION
    && (generation === undefined || payload.generation === generation);
}

function localControllerHealthUrl(host: string, port: number): string {
  return `http://${host === '::1' ? '[::1]' : host}:${port}/health`;
}

async function jsonHealth(url: string): Promise<Record<string, unknown> | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2_000);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
    });
    if (!response.ok) return null;
    return await response.json() as Record<string, unknown>;
  } catch (_error) {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export function registerMcpHttpObservationRoutes(input: McpHttpObservationRouteOptions): void {
  const {
    app,
    toolContext,
    sessionRegistry,
    runtimeStats,
    runtimeControllerHome,
    repoRoot,
    forgeInstanceId,
    currentRuntimeToolSurfaceFingerprint,
    toolSurface,
    toolSurfaceSchemaVersion,
    forgeVersion,
    authMode,
    authTokenConfigured,
    oauthPassphraseConfigured,
    oauthAuthorizationCodeDiagnostics,
    configuredPublicOrigin,
    host,
    port,
    enableChatgptBrowser,
    localController,
    maxInitializingSessions,
    maxActivePosts,
  } = input;
  const compatibilityToolCount = buildMcpToolDefinitions(toolContext.policy, { enableChatgptBrowser }).length;
  const repoId = toolContext.policy.profile === 'controller' || !repoRoot ? undefined : repositoryIdentity(repoRoot);
  const startedAt = new Date().toISOString();
  const localOrigin = `http://${host === '::' || host === '0.0.0.0' ? '127.0.0.1' : host}:${port}`;
  const advertisedOrigin = configuredPublicOrigin ?? localOrigin;

  const controllerHealth = () => {
    if (!('controllerHome' in toolContext)) return null;
    const runtimeGeneration = runtimeControllerHome ? readRuntimeGeneration(runtimeControllerHome) : undefined;
    const exposure = controllerExposureSnapshot(toolContext);
    const runtimeFingerprint = currentRuntimeToolSurfaceFingerprint();
    return {
      configuredAccessMode: exposure.access.configuredAccessMode,
      effectiveAccessMode: exposure.access.effectiveAccessMode,
      effectiveToolset: exposure.access.effectiveToolset,
      exposureRevision: exposure.access.exposureRevision,
      accessModeSource: exposure.access.source,
      accessModeLastAppliedAt: exposure.access.lastAppliedAt,
      toolset: exposure.access.effectiveToolset,
      toolSurfaceFingerprint: runtimeFingerprint,
      runtimeToolSurfaceFingerprint: runtimeFingerprint,
      toolCount: undefined,
      generation: runtimeGeneration?.generation,
      source: runtimeGeneration?.source,
      runtimeIdentity: runtimeIdentitySnapshot(toolContext),
    };
  };

  app.get('/health', (_req, res) => {
    const health = controllerHealth();
    res.setHeader('x-forge-tool-surface', toolSurface);
    res.setHeader('x-forge-version', String(forgeVersion));
    res.setHeader('x-forge-schema-version', String(toolSurfaceSchemaVersion));
    if (health?.toolset) res.setHeader('x-forge-toolset', health.toolset);
    if (health?.runtimeToolSurfaceFingerprint) res.setHeader('x-forge-runtime-tool-surface-fingerprint', health.runtimeToolSurfaceFingerprint);
    if (health?.toolSurfaceFingerprint) res.setHeader('x-forge-tool-surface-fingerprint', health.toolSurfaceFingerprint);
    const sessionSnapshot = sessionRegistry.snapshot();
    res.json({
      status: 'ok',
      server: 'forge-mcp',
      forgeInstanceId,
      ...(process.env.FORGE_MCP_INSTANCE_ID ? { controllerInstanceId: process.env.FORGE_MCP_INSTANCE_ID } : {}),
      version: forgeVersion,
      profile: toolContext.policy.profile,
      toolSurface,
      schemaVersion: toolSurfaceSchemaVersion,
      toolSurfaceFingerprint: health?.toolSurfaceFingerprint,
      runtimeToolSurfaceFingerprint: health?.runtimeToolSurfaceFingerprint,
      generation: health?.generation,
      source: health?.source,
      toolset: health?.toolset ?? 'full',
      gatewayToolset: health?.toolset ?? 'full',
      toolCount: health?.toolCount,
      compatibilityToolCount,
      runtimeIdentity: health?.runtimeIdentity,
      configuredAccessMode: health?.configuredAccessMode,
      effectiveAccessMode: health?.effectiveAccessMode,
      effectiveToolset: health?.effectiveToolset,
      accessModeSource: health?.accessModeSource,
      accessModeLastAppliedAt: health?.accessModeLastAppliedAt,
      exposureRevision: health?.exposureRevision,
      ...(repoId ? { repoId } : {}),
      startedAt,
      runner: {
        enabled: toolContext.policy.execution.agentRunner,
        defaultTimeoutMs: toolContext.policy.execution.runnerTimeoutMs,
        maxTimeoutMs: toolContext.policy.execution.runnerMaxTimeoutMs,
      },
      auth: authMode === 'oauth'
        ? (oauthPassphraseConfigured ? 'oauth' : 'missing')
        : authMode === 'bearer'
          ? (authTokenConfigured ? 'required' : 'missing')
          : 'none',
      ...(oauthAuthorizationCodeDiagnostics ? { oauthAuthorizationCodes: oauthAuthorizationCodeDiagnostics() } : {}),
      mcpEndpoint: `${advertisedOrigin}/mcp`,
      grokEndpoint: `${advertisedOrigin}/mcp`,
      bearerEndpoint: `${advertisedOrigin}/mcp-bearer`,
      sessions: {
        ...sessionSnapshot,
        initializing: runtimeStats.initializing,
        activePosts: runtimeStats.activePosts,
        maximumActivePosts: maxActivePosts,
        rejectedOverload: runtimeStats.rejectedOverload,
      },
    });
  });

  app.get('/transport-ready', (_req, res) => {
    const sessionSnapshot = sessionRegistry.snapshot();
    const sessionCapacityReady = sessionSnapshot.acceptingNewSessions
      && runtimeStats.initializing < maxInitializingSessions
      && runtimeStats.activePosts < maxActivePosts;
    res.status(sessionCapacityReady ? 200 : 503).json({
      ready: sessionCapacityReady,
      profile: toolContext.policy.profile,
      gateway: sessionCapacityReady ? 'ready' : 'saturated',
      sessionCapacity: sessionSnapshot,
      runtimeCapacity: {
        initializing: runtimeStats.initializing,
        maximumInitializing: maxInitializingSessions,
        activePosts: runtimeStats.activePosts,
        maximumActivePosts: maxActivePosts,
      },
    });
  });

  app.get('/ready', async (_req, res) => {
    const runtimeGeneration = runtimeControllerHome ? readRuntimeGeneration(runtimeControllerHome) : undefined;
    const sessionSnapshot = sessionRegistry.snapshot();
    const sessionCapacityReady = sessionSnapshot.acceptingNewSessions
      && runtimeStats.initializing < maxInitializingSessions
      && runtimeStats.activePosts < maxActivePosts;
    if (!runtimeControllerHome) {
      res.status(sessionCapacityReady ? 200 : 503).json({
        ready: sessionCapacityReady,
        profile: toolContext.policy.profile,
        gateway: sessionCapacityReady ? 'ready' : 'saturated',
        controllerDaemon: 'not-required',
        sessionCapacity: sessionSnapshot,
      });
      return;
    }
    const daemon = readForgeRuntimeStatus(runtimeControllerHome);
    const runtimeState = loadMcpServiceRuntimeState(runtimeControllerHome, repoRoot);
    const repositories = listRepositories(runtimeControllerHome).filter((repository) => repository.enabled && !repository.removedAt);
    const projectionSnapshots = repositories.map((repository) => {
      const snapshot = readRepositoryProjectionSnapshot(runtimeControllerHome, repository.repoId);
      const reconciliation = reconcileReadinessProjectionSource(
        snapshot,
        legacyIssueAuthorityRetired(repository.canonicalRoot)
          ? undefined
          : buildControllerTaskLedgerProjection(repository.canonicalRoot),
      );
      return { repoId: repository.repoId, snapshot, reconciliation };
    });
    const staleRepositories = projectionSnapshots.filter(({ snapshot }) => snapshot.stale).map(({ repoId: id }) => id);
    const blockingStaleRepositories = projectionSnapshots.filter(({ snapshot }) => projectionBlocksReadiness(snapshot)).map(({ repoId: id }) => id);
    const sourceMismatches = projectionSnapshots
      .filter(({ reconciliation }) => reconciliation.status === 'mismatch')
      .map(({ repoId: id, reconciliation }) => ({ repoId: id, ...reconciliation }));
    const localBridgeHealth = localController.enabled
      ? await jsonHealth(localControllerHealthUrl(localController.host, localController.port))
      : null;
    const localBridgeReady = !localController.enabled
      || localControllerDiagnosticMatchesRuntime(localBridgeHealth, runtimeGeneration?.generation);
    const daemonReady = daemon.status === 'ready' && daemon.degraded !== true;
    const projectionReady = blockingStaleRepositories.length === 0;
    const publicConfigured = Boolean(runtimeState?.tunnel?.publicEndpoint);
    const publicReady = !publicConfigured || runtimeState?.tunnel?.healthy === true;
    const connectorReady = !publicConfigured || (publicReady && runtimeState?.tunnel?.connectorNeedsReconnect !== true);
    const ready = daemonReady && projectionReady && localBridgeReady && sessionCapacityReady;
    res.status(ready ? 200 : 503).json({
      ready,
      generation: runtimeGeneration?.generation,
      source: runtimeGeneration?.source,
      gateway: { status: ready ? 'ready' : 'degraded', thin: true, eventLoopIsolatedFromWorkers: true },
      controllerDaemon: daemon,
      localBridge: {
        enabled: localController.enabled,
        ready: localBridgeReady,
        endpoint: `http://${localController.host === '::1' ? '[::1]' : localController.host}:${localController.port}/`,
      },
      projections: {
        ready: projectionReady,
        repositoryCount: repositories.length,
        staleRepositories,
        blockingStaleRepositories,
        sourceMismatches,
      },
      publicReadiness: {
        configured: publicConfigured,
        ready: publicReady,
        endpoint: runtimeState?.tunnel?.publicEndpoint,
      },
      connectorReadiness: {
        configured: publicConfigured,
        ready: connectorReady,
        connectorNeedsReconnect: runtimeState?.tunnel?.connectorNeedsReconnect === true,
      },
      sessionCapacity: sessionSnapshot,
    });
  });

  app.get('/repos/:repoId/health', (req, res) => {
    if (!runtimeControllerHome) {
      res.status(404).json({ error: 'controller profile required' });
      return;
    }
    try {
      const repository = getRepository(req.params.repoId, runtimeControllerHome, { includeRemoved: true });
      const projection = readRepositoryProjectionSnapshot(runtimeControllerHome, repository.repoId);
      res.json({
        status: repository.enabled && !repository.removedAt ? 'ok' : 'disabled',
        repository: {
          repoId: repository.repoId,
          checkoutId: repository.activeCheckoutId,
          enabled: repository.enabled,
          removedAt: repository.removedAt,
        },
        projection,
      });
    } catch (error) {
      res.status(404).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });
}
