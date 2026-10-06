import { invoke } from '@tauri-apps/api/core';
import type { RecoveryProbeProjection, RuntimeRecoveryProjection } from './runtime-projection';

interface RawRecoveryStatus {
  running?: boolean;
  ready?: boolean;
  stale?: boolean;
  reasonCodes?: unknown[];
  observedAt?: string;
  identity?: { host?: string; platform?: string; recovery?: { releaseRevision?: string } };
  snapshot?: { pid?: number; releaseId?: string; endpoint?: string; observedAt?: string };
  recoveryWatchdog?: { lastDecision?: string; updatedAt?: string };
}

interface RawRecoveryVerification {
  ok?: boolean;
  at?: string;
  probes?: Record<string, { ok?: boolean }>;
}

const PROBE_LABELS: Record<string, string> = {
  runtime_status: '运行时状态',
  recovery_known_good_recoverability: '已验证版本可恢复性',
  active_gateway: '活动网关',
  runtime_execution_surface: '运行时执行面',
  primary_tunnel_runtime: '主隧道',
  primary_connector_local: '主连接器',
  recovery_gateway: '恢复网关',
  recovery_watchdog: '恢复看门狗',
  recovery_tunnel_runtime: '恢复隧道',
  mcp_initialize: 'MCP 初始化',
  mcp_initialized_notification: 'MCP 初始化通知',
  mcp_tools_list: 'MCP 工具列表',
  mcp_read_only_call: 'MCP 只读调用',
  mcp_session_close: 'MCP 会话关闭',
};

const WATCHDOG_DECISIONS: Record<string, string> = {
  restart_primary_connector: '重启主连接器',
  restart_primary_runtime: '重启主运行时',
  recover_primary_runtime: '恢复主运行时',
  rollback_previous: '回滚到上一版本',
  none: '无需动作',
};

function localizeRecoveryError(error: unknown): Error {
  const raw = error instanceof Error ? error.message : String(error);
  const exact: Record<string, string> = {
    FORGE_DESKTOP_RECOVERY_CONFIG_UNAVAILABLE: '未找到独立恢复配置。',
    FORGE_DESKTOP_RECOVERY_CONFIG_INVALID: '独立恢复配置无法读取。',
    FORGE_DESKTOP_RECOVERY_GATEWAY_UNAVAILABLE: '独立恢复网关尚未配置。',
    FORGE_DESKTOP_RECOVERY_UNREACHABLE: '独立恢复网关当前不可达。',
    FORGE_DESKTOP_RECOVERY_TOKEN_UNAVAILABLE: '独立恢复认证信息不可用。',
    FORGE_DESKTOP_RECOVERY_TOKEN_INVALID: '独立恢复认证信息无效。',
    FORGE_DESKTOP_RECOVERY_IDENTITY_UNAVAILABLE: '独立恢复无法提供完整机器身份，已阻止变更操作。',
    FORGE_DESKTOP_RECOVERY_TARGET_RUNTIME_UNAVAILABLE: '无法确认目标运行时身份，已阻止变更操作。',
    FORGE_DESKTOP_RECOVERY_ACTION_UNSUPPORTED: '客户端请求了不受支持的恢复操作。',
    FORGE_DESKTOP_RECOVERY_TOOL_FAILED: '独立恢复拒绝了这次操作；运行时状态未被客户端自行改写。',
  };
  if (exact[raw]) return new Error(exact[raw]);
  if (raw.startsWith('FORGE_DESKTOP_RECOVERY_HTTP_')) return new Error('独立恢复网关返回了异常响应。');
  if (raw.startsWith('FORGE_DESKTOP_RECOVERY_RPC_ERROR')) return new Error('独立恢复协议调用失败。');
  if (raw.startsWith('RECOVERY_')) return new Error('恢复操作被权威恢复服务拒绝，请先运行诊断查看当前条件。');
  return new Error(raw);
}

function runtimeLabel(status: RawRecoveryStatus): { label: string; detail: string } {
  if (status.stale) return { label: '运行时状态已过期', detail: '独立恢复能够读取状态，但最近的运行时投影已经过期。' };
  if (status.ready) return { label: '运行时正常', detail: '主运行时正在运行并通过就绪检查。' };
  if (status.running) return { label: '运行时未就绪', detail: '主运行时进程存在，但尚未通过完整就绪检查。' };
  return { label: '运行时未运行', detail: '主运行时当前未运行；独立恢复网关仍可用于诊断和恢复。' };
}

function projectStatus(status: RawRecoveryStatus): RuntimeRecoveryProjection {
  const runtime = runtimeLabel(status);
  const decision = status.recoveryWatchdog?.lastDecision;
  const observedAt = status.snapshot?.observedAt ?? status.observedAt;
  return {
    recovery: {
      available: true,
      label: '独立恢复可用',
      detail: '恢复网关独立于主运行时，可以在主运行时不可用时继续执行有界诊断与恢复。',
      ...(status.identity?.host ? { host: status.identity.host } : {}),
      ...(status.identity?.platform ? { platform: status.identity.platform } : {}),
      ...(status.identity?.recovery?.releaseRevision ? { releaseRevision: status.identity.recovery.releaseRevision } : {}),
      ...(decision ? { watchdogDecision: WATCHDOG_DECISIONS[decision] ?? '已执行恢复决策' } : {}),
      ...(status.recoveryWatchdog?.updatedAt ? { watchdogUpdatedAt: status.recoveryWatchdog.updatedAt } : {}),
    },
    runtime: {
      running: Boolean(status.running),
      ready: Boolean(status.ready),
      stale: Boolean(status.stale),
      label: runtime.label,
      detail: runtime.detail,
      ...(typeof status.snapshot?.pid === 'number' ? { pid: status.snapshot.pid } : {}),
      ...(status.snapshot?.releaseId ? { releaseId: status.snapshot.releaseId } : {}),
      ...(status.snapshot?.endpoint ? { endpoint: status.snapshot.endpoint } : {}),
      ...(observedAt ? { observedAt } : {}),
      reasonCount: Array.isArray(status.reasonCodes) ? status.reasonCodes.length : 0,
    },
    diagnostics: null,
  };
}

function projectVerification(raw: RawRecoveryVerification): NonNullable<RuntimeRecoveryProjection['diagnostics']> {
  const probes: RecoveryProbeProjection[] = Object.entries(raw.probes ?? {}).map(([id, probe]) => ({
    id,
    label: PROBE_LABELS[id] ?? '其他检查',
    ok: Boolean(probe.ok),
  }));
  const passed = probes.filter((probe) => probe.ok).length;
  return {
    ...(raw.at ? { checkedAt: raw.at } : {}),
    ok: Boolean(raw.ok),
    passed,
    failed: probes.length - passed,
    probes,
  };
}

export function unavailableRecoveryProjection(detail: string): RuntimeRecoveryProjection {
  return {
    recovery: { available: false, label: '独立恢复不可用', detail },
    runtime: { running: false, ready: false, stale: false, label: '运行时状态未知', detail: '当前无法通过独立恢复确认主运行时状态。', reasonCount: 0 },
    diagnostics: null,
  };
}

export async function readRecoveryStatus(): Promise<RuntimeRecoveryProjection> {
  try {
    return projectStatus(await invoke<RawRecoveryStatus>('read_recovery_status'));
  } catch (error) {
    throw localizeRecoveryError(error);
  }
}

export async function verifyRecoveryRuntime(current: RuntimeRecoveryProjection): Promise<RuntimeRecoveryProjection> {
  try {
    return { ...current, diagnostics: projectVerification(await invoke<RawRecoveryVerification>('verify_recovery_runtime')) };
  } catch (error) {
    throw localizeRecoveryError(error);
  }
}

export async function performRecoveryAction(action: 'restart_runtime' | 'recover_runtime'): Promise<void> {
  try {
    await invoke('perform_recovery_action', { action });
  } catch (error) {
    throw localizeRecoveryError(error);
  }
}
