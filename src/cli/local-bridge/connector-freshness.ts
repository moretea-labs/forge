/**
 * Connector freshness diagnostics for Local Controller GUI and MCP self-test.
 *
 * Distinguishes:
 * - local MCP tool registry / process tool surface
 * - ChatGPT connector tool snapshot (only when connector_tool_names is supplied)
 *
 * Never treat "unable to observe ChatGPT tools" as "missing facade tools".
 * The live MCP /health endpoint is the only schema observation source.
 */

import {
  FORGE_MCP_SCHEMA_VERSION,
  FORGE_TOOL_SURFACE,
  FORGE_VERSION,
  forgeToolSurfaceFingerprint,
} from '../controller/runtime-config';
import {
  loadMcpLocalConfig,
  loadMcpServiceLocalConfig,
} from '../mcp/auth';
import { PREFERRED_FACADE_TOOL_NAMES, DEFAULT_CONTROLLER_TOOL_NAMES } from '../mcp/toolset-names';
import { resolveRepoPreferredControllerHome } from '../repositories/controller-home';
import type { PlainStatusTone } from './console-view-models';

export const EXPECTED_FACADE_TOOLS = [...PREFERRED_FACADE_TOOL_NAMES] as const;

/**
 * Interactive development tools in the bounded default schema. The historical
 * core and advanced labels expose the same bounded default surface; git / issue /
 * campaign atomics live in the `full` compatibility profile.
 */
export const OPTIONAL_INTERACTIVE_DEVELOPMENT_TOOLS = [
  'repository_safe_patch_apply',
  'run_check',
  'process_get',
  'process_wait',
] as const;

/** @deprecated Prefer ADVANCED_CONTROLLER_TOOL_NAMES; kept for import stability. */
export const CORE_SURFACE_INTERACTIVE_TOOLS = OPTIONAL_INTERACTIVE_DEVELOPMENT_TOOLS;

export type ConnectorFreshnessStatus =
  | 'local_mcp_updated'
  | 'local_mcp_missing_facade'
  | 'chatgpt_snapshot_missing_facade'
  | 'unable_to_verify_chatgpt_snapshot'
  | 'stale_fingerprint'
  | 'connector_mismatch'
  | 'unknown';

export type ConnectorFreshnessSeverity = 'ok' | 'info' | 'warning' | 'error';

export interface ConnectorRuntimeObservation {
  healthy?: boolean;
  toolSurface?: string;
  schemaVersion?: number;
  forgeVersion?: string;
  toolSurfaceFingerprint?: string;
  toolCount?: number;
  /** This observation is sourced from live Gateway health. */
  source?: 'live_health';
}

export interface EvaluateConnectorFreshnessInput {
  /** Local MCP tools/list or expected/exposed registry names. */
  localToolNames: readonly string[];
  /** Optional ChatGPT connector snapshot. Only set when truly observed. */
  connectorToolNames?: readonly string[] | null;
  expectedFacadeTools?: readonly string[];
  optionalDevelopmentTools?: readonly string[];
  toolSurface?: string;
  schemaVersion?: number;
  forgeVersion?: string;
  /** Expected fingerprint for the local tool surface (from expectedTools). */
  toolSurfaceFingerprint?: string;
  /** Observed running MCP process surface, if available. */
  runtime?: ConnectorRuntimeObservation | null;
  /** Optional real connector callability probe; a tools/list snapshot is not a callability probe. */
  callabilityProbe?: {
    toolName: string;
    callable: boolean;
    errorCode?: string;
    source?: 'external_probe';
  };
}

export interface ConnectorFreshnessReport {
  status: ConnectorFreshnessStatus;
  severity: ConnectorFreshnessSeverity;
  summary: string;
  missingLocalTools: string[];
  missingConnectorTools: string[];
  expectedFacadeTools: string[];
  observedLocalTools: string[];
  observedConnectorTools?: string[];
  optionalDevelopmentTools: {
    expected: string[];
    present: string[];
    missing: string[];
  };
  toolSurface: string;
  schemaVersion: number;
  forgeVersion: string;
  toolSurfaceFingerprint: string;
  runtimeFingerprint?: string;
  runtimeHealthy?: boolean;
  fingerprintMatches: boolean | null;
  restartRecommended: boolean;
  reconnectRecommended: boolean;
  suggestedActions: string[];
  howToFix: string[];
  warnings: string[];
  /** GUI chrome */
  connectorLabel: string;
  connectorTone: PlainStatusTone;
  sectionStatusLabel: string;
  sectionDetail: string;
  /** User-facing banner warning (amber/error only; empty for ok/info). */
  bannerWarning?: string;
  /** Scope of the evidence: local registry parity is not connector callability. */
  diagnosticScope: 'local_registry';
  localRegistryVerified: boolean;
  connectorCallability: 'unverified' | 'verified' | 'mismatch';
  connectorCallabilitySource?: 'external_probe';
  connectorMismatch?: { toolName: string; errorCode?: string; message: string };
}

const DEFAULT_HOW_TO_FIX = [
  '重启 Runtime：forge recovery restart-runtime --controller-home <absolute-controller-home>',
  '检查状态：forge runtime status --controller-home <absolute-controller-home>',
  '在 ChatGPT 中刷新/重连 MCP Connector',
  '重新打开 Local Controller UI',
  '若仍异常，运行 console smoke / connector status 自检',
] as const;

function uniqueSorted(names: readonly string[]): string[] {
  return [...new Set(names.map((name) => String(name).trim()).filter(Boolean))].sort();
}

function missingFrom(expected: readonly string[], observed: readonly string[]): string[] {
  const set = new Set(observed);
  return expected.filter((name) => !set.has(name));
}

function runtimeFingerprintMatches(
  runtime: ConnectorRuntimeObservation | null | undefined,
  expected: {
    toolSurface: string;
    schemaVersion: number;
    forgeVersion: string;
    toolSurfaceFingerprint: string;
  },
): boolean | null {
  if (!runtime) return null;
  // Dead/stale runtime snapshots (healthy=false) must not be treated as "fingerprint mismatch".
  // Only a healthy observation can confirm tool-surface freshness.
  if (runtime.healthy !== true) return null;
  if (
    runtime.toolSurface === undefined
    && runtime.schemaVersion === undefined
    && runtime.forgeVersion === undefined
    && runtime.toolSurfaceFingerprint === undefined
  ) {
    return null;
  }
  return (
    runtime.toolSurface === expected.toolSurface
    && runtime.schemaVersion === expected.schemaVersion
    && runtime.forgeVersion === expected.forgeVersion
    && runtime.toolSurfaceFingerprint === expected.toolSurfaceFingerprint
  );
}

const LIVE_HEALTH_TIMEOUT_MS = 800;

function localMcpHealthUrl(repoRoot: string): string | null {
  const controllerHome = resolveRepoPreferredControllerHome(repoRoot);
  const config = loadMcpServiceLocalConfig(controllerHome, repoRoot) ?? loadMcpLocalConfig(repoRoot);
  const host = (config?.server?.host ?? '127.0.0.1').trim() || '127.0.0.1';
  const port = typeof config?.server?.port === 'number' && config.server.port > 0
    ? config.server.port
    : 8765;
  const normalized = host === '::1' ? '[::1]' : host;
  return `http://${normalized}:${port}/health`;
}

async function fetchJsonHealth(url: string): Promise<Record<string, unknown> | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LIVE_HEALTH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
    });
    if (!response.ok) return null;
    return await response.json() as Record<string, unknown>;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Schema freshness is observable only from the live Gateway. mcp.runtime.json
 * is lifecycle diagnostics, not an MCP schema authority, so an unavailable
 * live endpoint remains unverified instead of reviving an old tool snapshot.
 */
export async function observeLocalMcpRuntime(
  repoRoot: string,
): Promise<ConnectorRuntimeObservation | null> {
  const healthUrl = localMcpHealthUrl(repoRoot);
  if (healthUrl) {
    const live = await fetchJsonHealth(healthUrl);
    if (live && live.status === 'ok') {
      const observation: ConnectorRuntimeObservation = {
        healthy: true,
        toolSurface: typeof live.toolSurface === 'string' ? live.toolSurface : undefined,
        schemaVersion: typeof live.schemaVersion === 'number' ? live.schemaVersion : undefined,
        forgeVersion: typeof live.version === 'string' ? live.version : undefined,
        toolSurfaceFingerprint: typeof live.toolSurfaceFingerprint === 'string' ? live.toolSurfaceFingerprint : undefined,
        toolCount: typeof live.toolCount === 'number' ? live.toolCount : undefined,
        source: 'live_health',
      };
      return observation;
    }
  }
  return null;
}

export function evaluateConnectorFreshness(input: EvaluateConnectorFreshnessInput): ConnectorFreshnessReport {
  const expectedFacadeTools = [...(input.expectedFacadeTools ?? EXPECTED_FACADE_TOOLS)];
  const optionalExpected = [...(input.optionalDevelopmentTools ?? OPTIONAL_INTERACTIVE_DEVELOPMENT_TOOLS)];
  const observedLocalTools = uniqueSorted(input.localToolNames ?? []);
  const connectorProvided = Array.isArray(input.connectorToolNames);
  const observedConnectorTools = connectorProvided
    ? uniqueSorted(input.connectorToolNames ?? [])
    : undefined;

  const toolSurface = input.toolSurface ?? FORGE_TOOL_SURFACE;
  const schemaVersion = input.schemaVersion ?? FORGE_MCP_SCHEMA_VERSION;
  const forgeVersion = input.forgeVersion ?? FORGE_VERSION;
  const toolSurfaceFingerprint = input.toolSurfaceFingerprint
    ?? forgeToolSurfaceFingerprint(observedLocalTools);
  const runtime = input.runtime ?? null;
  const fingerprintMatches = runtimeFingerprintMatches(runtime, {
    toolSurface,
    schemaVersion,
    forgeVersion,
    toolSurfaceFingerprint,
  });

  const missingLocalTools = missingFrom(expectedFacadeTools, observedLocalTools);
  const missingConnectorTools = observedConnectorTools
    ? missingFrom(expectedFacadeTools, observedConnectorTools)
    : [];
  const optionalPresent = optionalExpected.filter((name) => observedLocalTools.includes(name));
  const optionalMissing = optionalExpected.filter((name) => !observedLocalTools.includes(name));
  const localRegistryVerified = missingLocalTools.length === 0;
  const connectorCallability = input.callabilityProbe
    ? input.callabilityProbe.callable ? 'verified' as const : 'mismatch' as const
    : 'unverified' as const;

  const base = {
    expectedFacadeTools,
    observedLocalTools,
    observedConnectorTools,
    missingLocalTools,
    missingConnectorTools,
    optionalDevelopmentTools: {
      expected: optionalExpected,
      present: optionalPresent,
      missing: optionalMissing,
    },
    toolSurface,
    schemaVersion,
    forgeVersion,
    toolSurfaceFingerprint,
    runtimeFingerprint: runtime?.toolSurfaceFingerprint,
    runtimeHealthy: runtime?.healthy,
    fingerprintMatches,
    diagnosticScope: 'local_registry' as const,
    localRegistryVerified,
    connectorCallability,
    ...(input.callabilityProbe ? { connectorCallabilitySource: input.callabilityProbe.source ?? 'external_probe' as const } : {}),
  };

  if (observedLocalTools.length === 0) {
    return finalize({
      ...base,
      status: 'unknown',
      severity: 'warning',
      summary: '无法读取本地 MCP 工具列表。',
      restartRecommended: true,
      reconnectRecommended: false,
      suggestedActions: [
        '重启 Runtime（forge recovery restart-runtime）后重新打开 Local Controller UI',
        '运行 forge runtime status 确认健康',
      ],
      howToFix: [...DEFAULT_HOW_TO_FIX],
      warnings: ['本地 MCP 工具列表为空或不可用。'],
      connectorLabel: '未知',
      connectorTone: 'gray',
      sectionStatusLabel: '未知',
      sectionDetail: '无法读取本地 MCP 工具面。',
      bannerWarning: '无法读取本地 MCP 工具列表，请检查 Controller/MCP 是否在运行。',
    });
  }

  if (missingLocalTools.length > 0) {
    return finalize({
      ...base,
      status: 'local_mcp_missing_facade',
      severity: 'error',
      summary: '本地 MCP 工具面仍缺少 facade 工具，需要重启 Controller/MCP。',
      restartRecommended: true,
      reconnectRecommended: false,
      suggestedActions: [
        '重启 Runtime：forge recovery restart-runtime',
        '确认 tools/list 包含 rh_status / rh_inbox / rh_context / rh_work',
        '重新运行 connector status / smoke 自检',
      ],
      howToFix: [
        '重启 Runtime：forge recovery restart-runtime',
        '检查状态：forge runtime status',
        '确认本地 tools/list 含 rh_status / rh_inbox / rh_context / rh_work',
        '重新打开 Local Controller UI',
        '运行 connector status 自检',
      ],
      warnings: [`本地 MCP 缺少 facade 工具：${missingLocalTools.join(', ')}`],
      connectorLabel: '本地工具缺失',
      connectorTone: 'red',
      sectionStatusLabel: '需重启',
      sectionDetail: `本地 MCP 工具面仍缺少：${missingLocalTools.join(', ')}。需要重启 Controller/MCP。`,
      bannerWarning: '本地 MCP 工具面仍缺少 facade 工具，需要重启 Controller/MCP。',
    });
  }

  if (input.callabilityProbe && !input.callabilityProbe.callable) {
    const toolName = input.callabilityProbe.toolName.trim() || 'unknown';
    const errorCode = input.callabilityProbe.errorCode?.trim() || undefined;
    return finalize({
      ...base,
      status: 'connector_mismatch',
      severity: 'error',
      summary: `Connector callability mismatch: ${toolName} was exposed locally but the external probe could not call it.`,
      restartRecommended: false,
      reconnectRecommended: true,
      suggestedActions: ['重新连接 MCP Connector', '确认外部 Connector 使用当前 tools/list', '再次运行 connector callability probe'],
      howToFix: [...DEFAULT_HOW_TO_FIX],
      warnings: [errorCode ? `${errorCode}: ${toolName}` : `Connector probe failed for ${toolName}.`],
      connectorLabel: 'Connector 不匹配',
      connectorTone: 'red',
      sectionStatusLabel: '调用不匹配',
      sectionDetail: `本地 registry 已验证包含 ${toolName}，但外部 Connector 返回${errorCode ?? '不可调用'}。`,
      bannerWarning: '本地工具注册表与 Connector 实际可调用性不一致，请重连 Connector。',
      connectorMismatch: {
        toolName,
        errorCode,
        message: errorCode === 'UNKNOWN_TOOL' ? 'Connector reported UNKNOWN_TOOL for an exposed tool.' : 'External connector callability probe failed.',
      },
    });
  }

  if (observedConnectorTools) {
    if (missingConnectorTools.length > 0) {
      return finalize({
        ...base,
        status: 'chatgpt_snapshot_missing_facade',
        severity: 'warning',
        summary: 'ChatGPT 当前连接器快照缺少 facade 工具，请重新连接 MCP。',
        restartRecommended: false,
        reconnectRecommended: true,
        suggestedActions: [
          '在 ChatGPT 中重新连接 / 刷新 MCP Connector',
          '确认 tools/list 重新加载后可见 rh_status / rh_inbox / rh_context / rh_work',
          '可选：向 controller_capabilities 传入 connector_tool_names 复核',
        ],
        howToFix: [
          '确认本地 MCP 已更新（本状态表示本地 facade 已存在）',
          '在 ChatGPT 中刷新/重连 MCP Connector',
          '重新打开对话并检查工具列表是否含 rh_*',
          '重新打开 Local Controller UI',
          '若仍异常，运行 connector check 并传入 connector_tool_names',
        ],
        warnings: [`ChatGPT 连接器快照缺少：${missingConnectorTools.join(', ')}`],
        connectorLabel: '需重连 Connector',
        connectorTone: 'amber',
        sectionStatusLabel: '快照过期',
        sectionDetail: `ChatGPT 当前连接器快照缺少 facade 工具：${missingConnectorTools.join(', ')}。请重新连接 MCP。`,
        bannerWarning: 'ChatGPT 当前连接器快照缺少 facade 工具，请重新连接 MCP。',
      });
    }

    return finalize({
      ...base,
      status: 'local_mcp_updated',
      severity: 'ok',
      summary: input.callabilityProbe?.callable
        ? '本地 registry 与外部 Connector 调用探针均已验证。'
        : '本地 registry 已验证；Facade 工具可用，但 Connector 实际可调用性尚未验证。',
      restartRecommended: false,
      reconnectRecommended: false,
      suggestedActions: [],
      howToFix: [],
      warnings: optionalMissing.length
        ? [`可选交互开发工具未全部暴露：${optionalMissing.join(', ')}`]
        : [],
      connectorLabel: input.callabilityProbe?.callable ? 'Facade 可调用' : '本地 registry 已验证 · Connector 未确认',
      connectorTone: 'green',
      sectionStatusLabel: '正常',
      sectionDetail: input.callabilityProbe?.callable
        ? 'Local registry and external Connector callability are verified for the facade surface.'
        : 'Local registry parity is verified（rh_status / rh_inbox / rh_context / rh_work）；Connector callability remains unverified.',
    });
  }

  // No ChatGPT snapshot. Local facade tools are present.
  if (fingerprintMatches === false) {
    return finalize({
      ...base,
      status: 'stale_fingerprint',
      severity: 'warning',
      summary: '本地 MCP 进程工具面指纹与当前代码期望不一致，建议重启 Controller/MCP。',
      restartRecommended: true,
      reconnectRecommended: true,
      suggestedActions: [
        '重启 Runtime：forge recovery restart-runtime',
        '重启后若 ChatGPT 仍看不到 rh_*，再重连 Connector',
        '运行 forge runtime status 确认健康',
      ],
      howToFix: [...DEFAULT_HOW_TO_FIX],
      warnings: [
        '运行中的 MCP 进程工具面可能过期（指纹/版本不匹配）。这不等于已确认 ChatGPT 缺少工具。',
      ],
      connectorLabel: '需重启 MCP',
      connectorTone: 'amber',
      sectionStatusLabel: '进程可能过期',
      sectionDetail:
        '本地代码已包含 facade 工具，但运行中的 MCP 进程指纹/版本与期望不一致。请重启 Controller/MCP；若 ChatGPT 里仍不可见 rh_*，再重连 Connector。',
      bannerWarning:
        '本地 MCP 进程工具面可能过期，建议重启 Controller/MCP。GUI 无法据此断言 ChatGPT 已缺少 facade 工具。',
    });
  }

  // Local OK, ChatGPT unknown → info, not "missing".
  return finalize({
    ...base,
    status: 'unable_to_verify_chatgpt_snapshot',
    severity: 'info',
    summary: '本地 MCP 已更新，但无法从 GUI 确认 ChatGPT 当前工具快照。',
    restartRecommended: false,
    reconnectRecommended: false,
    suggestedActions: [
      '如果 ChatGPT 对话里看不到 rh_status / rh_inbox / rh_context / rh_work，请重连 MCP Connector',
      '可选：调用 controller_capabilities 并传入 connector_tool_names 做精确核对',
    ],
    howToFix: [
      '本地 MCP 工具面已包含 rh_*（无需仅为“未确认”而重启）',
      '若 ChatGPT 里看不到 rh_status / rh_inbox / rh_context / rh_work，请重连 MCP Connector',
      '重连后重新打开对话并检查工具列表',
      '重新打开 Local Controller UI',
      '可选：向 /api/console/connector/check 传入 connector_tool_names 精确核对',
    ],
    warnings: [],
    connectorLabel: '本地已更新 · 未确认 ChatGPT',
    connectorTone: 'blue',
    sectionStatusLabel: '未确认',
    sectionDetail:
      '本地 MCP 工具面已更新。GUI 无法直接确认 ChatGPT 当前连接器快照；如果你在 ChatGPT 里看不到 rh_access / rh_status / rh_inbox / rh_context / rh_work，说明连接器快照确实陈旧，可重新加载连接器。',
    // No scary banner — this is informational, not a confirmed missing-tools state.
  });
}

function finalize(
  report: Omit<ConnectorFreshnessReport, never>,
): ConnectorFreshnessReport {
  return report;
}

/**
 * Build local tool names from the in-process controller registry (not ChatGPT).
 * Uses expectedTools when provided; otherwise falls back to the stable default exposure.
 */
export function localControllerToolNames(expectedTools?: readonly string[]): string[] {
  if (expectedTools && expectedTools.length > 0) return uniqueSorted(expectedTools);
  return uniqueSorted([...DEFAULT_CONTROLLER_TOOL_NAMES]);
}

export function buildLocalConnectorStatus(input: {
  expectedTools: readonly string[];
  connectorToolNames?: readonly string[] | null;
  runtime?: ConnectorRuntimeObservation | null;
  callabilityProbe?: EvaluateConnectorFreshnessInput['callabilityProbe'];
}): ConnectorFreshnessReport {
  const expectedTools = uniqueSorted(input.expectedTools);
  const fingerprint = forgeToolSurfaceFingerprint(expectedTools);
  return evaluateConnectorFreshness({
    localToolNames: expectedTools,
    connectorToolNames: input.connectorToolNames,
    expectedFacadeTools: EXPECTED_FACADE_TOOLS,
    optionalDevelopmentTools: OPTIONAL_INTERACTIVE_DEVELOPMENT_TOOLS,
    toolSurface: FORGE_TOOL_SURFACE,
    schemaVersion: FORGE_MCP_SCHEMA_VERSION,
    forgeVersion: FORGE_VERSION,
    toolSurfaceFingerprint: fingerprint,
    runtime: input.runtime,
    callabilityProbe: input.callabilityProbe,
  });
}

/**
 * Repo-aware status probes live MCP /health; unavailable discovery stays unverified.
 */
export async function buildLocalConnectorStatusForRepo(input: {
  repoRoot: string;
  expectedTools: readonly string[];
  connectorToolNames?: readonly string[] | null;
  callabilityProbe?: EvaluateConnectorFreshnessInput['callabilityProbe'];
}): Promise<ConnectorFreshnessReport> {
  const runtime = await observeLocalMcpRuntime(input.repoRoot);
  return buildLocalConnectorStatus({
    expectedTools: input.expectedTools,
    connectorToolNames: input.connectorToolNames,
    runtime,
    callabilityProbe: input.callabilityProbe,
  });
}
