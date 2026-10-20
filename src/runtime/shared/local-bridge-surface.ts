/**
 * Authoritative Local Bridge / Local Controller surface resolution.
 *
 * The caller-provided Controller Home is authoritative. Surface resolution
 * never selects a runtime slot or follows a separate traffic authority.
 */

import {
  loadMcpServiceLocalConfig,
  loadMcpServiceRuntimeState,
  type McpRuntimeState,
} from '../../../adapters/mcp/auth';
import { inferLocalControllerProcess } from '../diagnostics/performance';
import type { LocalBridgeMode } from '../health/evaluator';

export type LocalBridgeSurfaceMode = LocalBridgeMode;

export interface LocalBridgeSurface {
  mode: LocalBridgeSurfaceMode;
  /** True when the product intends a Local Controller surface for this repo/runtime. */
  enabled: boolean;
  /** True when readiness must fail closed without a healthy surface. */
  requiredForReadiness: boolean;
  /** Configured or observed endpoint URL (may be undefined when disabled / not applicable). */
  endpoint?: string;
  endpointConfigured: boolean;
  /** Expected surface kind for operators and probes. */
  expectedSurface: 'local-controller' | 'none';
  processRunning?: boolean;
  pid?: number;
  generation?: string;
  error?: string;
  /** Where endpoint/mode were resolved from. */
  source: 'service-runtime' | 'service-config' | 'process-scan' | 'none';
  ownerKind: 'mcp-keepalive' | 'controller-service' | 'external' | 'unknown' | 'none';
}

function normalizeEndpoint(host: string, port: number): string {
  const safeHost = host.trim() || '127.0.0.1';
  const displayHost = safeHost === '0.0.0.0' || safeHost === '::' ? '127.0.0.1' : safeHost;
  return `http://${displayHost}:${port}/`;
}

function modeFromRuntime(runtime: McpRuntimeState | null | undefined): LocalBridgeSurfaceMode | undefined {
  const mode = runtime?.localController?.mode;
  if (mode === 'standalone' || mode === 'embedded' || mode === 'remote' || mode === 'disabled' || mode === 'unknown') {
    return mode;
  }
  return undefined;
}

/**
 * Resolve the Local Bridge capability from the selected Controller Home.
 * Process scanning is observation only, never a configuration authority.
 */
export function resolveLocalBridgeSurface(input: {
  controllerHome: string;
  repoRoot: string;
  /** Optional process scan; when omitted, scan only if runtime state is missing. */
  allowProcessScan?: boolean;
}): LocalBridgeSurface {
  const allowProcessScan = input.allowProcessScan !== false;
  const runtime = loadMcpServiceRuntimeState(input.controllerHome);
  const config = loadMcpServiceLocalConfig(input.controllerHome);

  const configuredEnabled = config?.localController?.enabled;
  const configuredMode = config?.localController?.mode;
  const configuredHost = config?.localController?.host ?? '127.0.0.1';
  const configuredPort = config?.localController?.port;
  const configuredEndpoint = typeof configuredPort === 'number' && Number.isFinite(configuredPort)
    ? normalizeEndpoint(configuredHost, configuredPort)
    : undefined;

  const runtimeLc = runtime?.localController;
  if (runtimeLc) {
    const mode = modeFromRuntime(runtime) ?? configuredMode ?? 'unknown';
    const enabled = mode !== 'disabled' && configuredEnabled !== false;
    // Runtime observation and configured endpoint share the Controller Home owner.
    const endpoint = runtimeLc.endpoint?.trim() || configuredEndpoint;
    const ownerKind = mode === 'embedded'
      ? 'mcp-keepalive'
      : mode === 'remote'
        ? 'external'
        : mode === 'standalone'
          ? 'controller-service'
          : 'unknown';
    return {
      mode: enabled ? mode : 'disabled',
      enabled,
      // Embedded UI is operationally useful but not a hard readiness gate unless
      // standalone mode is configured and required by deployment.
      requiredForReadiness: enabled && mode === 'standalone',
      endpoint,
      endpointConfigured: Boolean(endpoint),
      expectedSurface: enabled ? 'local-controller' : 'none',
      processRunning: runtimeLc.running,
      pid: runtimeLc.pid,
      generation: runtimeLc.generation ?? runtime?.generation,
      error: runtimeLc.error,
      source: 'service-runtime',
      ownerKind,
    };
  }

  if (configuredEnabled === false || configuredMode === 'disabled') {
    return {
      mode: 'disabled',
      enabled: false,
      requiredForReadiness: false,
      endpoint: configuredEndpoint,
      endpointConfigured: Boolean(configuredEndpoint),
      expectedSurface: 'none',
      source: 'service-config',
      ownerKind: 'none',
    };
  }

  if (configuredEndpoint) {
    const mode = configuredMode ?? 'standalone';
    return {
      mode,
      enabled: true,
      requiredForReadiness: mode === 'standalone',
      endpoint: configuredEndpoint,
      endpointConfigured: true,
      expectedSurface: 'local-controller',
      source: 'service-config',
      ownerKind: mode === 'embedded' ? 'mcp-keepalive' : mode === 'standalone' ? 'controller-service' : 'unknown',
    };
  }

  if (allowProcessScan) {
    const inferred = inferLocalControllerProcess(input.repoRoot);
    if (inferred?.running) {
      return {
        mode: 'standalone',
        enabled: true,
        requiredForReadiness: false,
        endpoint: inferred.endpoint,
        endpointConfigured: Boolean(inferred.endpoint),
        expectedSurface: 'local-controller',
        processRunning: true,
        pid: inferred.pid,
        source: 'process-scan',
        ownerKind: 'controller-service',
      };
    }
  }

  // No configured surface: do not invent legacy 8766 as an expected endpoint.
  return {
    mode: 'unknown',
    enabled: false,
    requiredForReadiness: false,
    endpointConfigured: false,
    expectedSurface: 'none',
    source: 'none',
    ownerKind: 'none',
  };
}

export function summarizeRecentJobs(jobs: Array<{ status: string }>): {
  activeJobCount: number;
  recentJobSummary: Record<string, number>;
} {
  const recentJobSummary: Record<string, number> = {};
  let activeJobCount = 0;
  for (const job of jobs) {
    recentJobSummary[job.status] = (recentJobSummary[job.status] ?? 0) + 1;
    if (['approved', 'running', 'dispatched'].includes(job.status)) activeJobCount += 1;
  }
  return { activeJobCount, recentJobSummary };
}
