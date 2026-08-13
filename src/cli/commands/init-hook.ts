/**
 * Readiness model behind `forge setup check` and resumable `forge setup`.
 *
 * This command intentionally does not install hooks, write user-owned markdown,
 * or mutate repo-local runtime files. It gathers the existing readiness probes
 * and turns actionable gaps into an Agent-facing checklist with verification
 * commands and risk notes.
 */

import { spawnSync } from 'child_process';
import { randomUUID } from 'crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import * as os from 'os';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { Command } from 'commander';
import { runDoctor, type CheckStatus, type DoctorReport } from './doctor';
import { runStatus, type StatusReport } from './status';
import { runMcpSetupChatgpt } from '../mcp/setup';
import { resolveRepoPreferredControllerHome } from '../repositories/controller-home';
import {
  configureSetupProfile,
  detectSetupPlatform,
  formatSetupProfile,
  readSetupProfile,
  resolveControllerGuidance,
  resolveRuntimeGuidance,
  resolveTunnelGuidance,
  setupHostTarget,
  type SetupHostTarget,
  type SetupPlatformSnapshot,
  type SetupProfile,
} from './setup-profile';

export type InitHookTarget = SetupHostTarget;
export type InitHookStatus = 'ok' | 'attention' | 'blocked';
export type InitHookCheckStatus = CheckStatus | 'needs_agent';
export type InitHookCheckSource =
  | 'status'
  | 'doctor'
  | 'security'
  | 'tooling'
  | 'global-rules'
  | 'legacy';

export interface InitHookCheck {
  id: string;
  title: string;
  status: InitHookCheckStatus;
  detail: string;
  source: InitHookCheckSource;
}

export interface InitHookAction {
  id: string;
  status: 'needs_agent';
  reason: string;
  requires_agent: true;
  risk: string;
  command?: string;
  targets?: string[];
  verification: string;
}

export interface InitHookReport {
  version: 1;
  status: InitHookStatus;
  target: InitHookTarget;
  checkUpdates: boolean;
  summary: { ok: number; warn: number; fail: number; na: number; needs_agent: number };
  checks: InitHookCheck[];
  agent_actions: InitHookAction[];
}

export interface ToolingReport {
  generated_at?: string;
  repo_root?: string;
  hosts?: string[];
  check_updates?: boolean;
  runtime_capabilities?: Record<string, RuntimeCapability>;
  tools?: Record<string, ToolingTool>;
}

export interface RuntimeCapability {
  name?: string;
  status?: string;
  path?: string | null;
  owner?: string;
  required?: boolean;
  required_for?: string;
  reason?: string;
  command?: string;
}

export interface ToolingTool {
  name?: string;
  required?: boolean;
  status?: string;
  reason?: string;
  update_status?: string | null;
  update_reason?: string;
  install_command?: string;
  upgrade_command?: string;
  sync_command?: string;
  ensure_command?: string | null;
  mcp_install_command?: string;
  init_command?: string;
}

export interface InitHookOptions {
  cwd?: string;
  sourceRoot?: string;
  env?: NodeJS.ProcessEnv;
  target?: InitHookTarget;
  checkUpdates?: boolean;
  statusReport?: StatusReport;
  doctorReport?: DoctorReport;
  toolingReport?: ToolingReport;
}

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..', '..', '..');
const UPDATE_CHECK_ENV = 'FORGE_CHECK_UPDATES';
const GLOBAL_RULES_BEGIN = '<!-- BEGIN: forge global-working-rules -->';
const VALID_TARGETS: readonly InitHookTarget[] = ['none', 'codex', 'claude', 'both'];

function withProcessEnv<T>(env: NodeJS.ProcessEnv | undefined, fn: () => T): T {
  if (!env) return fn();
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(env)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function selectedTargets(target: InitHookTarget): Array<'codex' | 'claude'> {
  if (target === 'none') return [];
  if (target === 'both') return ['codex', 'claude'];
  return [target];
}

function targetLabel(target: 'codex' | 'claude'): string {
  return target === 'codex' ? 'Codex' : 'Claude Code';
}

function homeDir(env?: NodeJS.ProcessEnv): string {
  return env?.HOME ?? process.env.HOME ?? os.homedir();
}

function verificationCommand(target: InitHookTarget, checkUpdates: boolean): string {
  return `forge setup check --target ${target}${checkUpdates ? ' --check-updates' : ''} --json`;
}

function addAction(actions: InitHookAction[], action: InitHookAction): void {
  if (actions.some((entry) => entry.id === action.id)) return;
  actions.push(action);
}

function hasGlobalWorkingRules(content: string): boolean {
  return (
    content.includes(GLOBAL_RULES_BEGIN) ||
    /^# Global Working Rules\s*$/m.test(content) ||
    (
      content.includes('## Progressive Due Diligence') &&
      content.includes('### P1: Architecture Map') &&
      content.includes('### P2: Concrete Trace') &&
      content.includes('### P3: Design Decision')
    )
  );
}

function statusChecks(
  report: StatusReport,
  target: InitHookTarget,
  checkUpdates: boolean,
  actions: InitHookAction[],
): InitHookCheck[] {
  const checks: InitHookCheck[] = [];
  for (const id of selectedTargets(target)) {
    const entry = report.targets.find((candidate) => candidate.id === id);
    if (!entry) {
      checks.push({
        id: `status.adapter.${id}`,
        title: `${targetLabel(id)} global hook adapter`,
        status: 'fail',
        source: 'status',
        detail: 'target is not registered in the installer registry',
      });
      continue;
    }

    if (!entry.installed) {
      checks.push({
        id: `status.adapter.${id}`,
        title: `${targetLabel(id)} global hook adapter`,
        status: 'warn',
        source: 'status',
        detail: `${targetLabel(id)} host not detected; no adapter install action was generated`,
      });
      continue;
    }

    const configured = entry.alreadyConfigured && entry.managedEntryCount === entry.expectedEntryCount;
    checks.push({
      id: `status.adapter.${id}`,
      title: `${targetLabel(id)} global hook adapter`,
      status: configured ? 'ok' : 'needs_agent',
      source: 'status',
      detail: configured
        ? `${entry.managedEntryCount}/${entry.expectedEntryCount} managed entries at ${entry.configPath}`
        : `${entry.managedEntryCount}/${entry.expectedEntryCount} managed entries at ${entry.configPath ?? '(unknown config path)'}`,
    });

    if (!configured) {
      addAction(actions, {
        id: `adapter.${id}.install`,
        status: 'needs_agent',
        reason: `${targetLabel(id)} user-level adapter is missing or does not match the route registry.`,
        requires_agent: true,
        risk: 'Writes user-level host hook config; preserve unmanaged user entries and re-check managed count.',
        command: `forge install --target ${id} --location global`,
        targets: entry.configPath ? [entry.configPath] : undefined,
        verification: verificationCommand(target, checkUpdates),
      });
    }
  }
  return checks;
}

function parseActionCommand(detail: string): string | undefined {
  const direct = detail.match(/agent_action=([^;]+)/);
  if (direct) return direct[1].trim();
  const remediation = detail.match(/remediation=([^;]+)/);
  if (remediation) return remediation[1].trim();
  const run = detail.match(/\(run:\s*([^)]+)\)/);
  return run?.[1]?.trim();
}

function doctorEntryRelevant(id: string, target: InitHookTarget): boolean {
  if (id === 'cli-on-path' || id === 'cli-version' || id === 'cli-update' || id === 'security-config') return true;
  if (target === 'none') return false;
  if (id === 'repo-hook-scripts' || id === 'codegraph-readiness' || id === 'codegraph-index') return true;
  if (target === 'codex' || target === 'both') {
    if (id === 'codex-adapter' || id === 'codex-trust-state' || id === 'codex-codegraph-mcp') return true;
  }
  if (target === 'claude' || target === 'both') {
    if (id === 'claude-adapter' || id === 'claude-codegraph-mcp') return true;
  }
  return false;
}

function doctorChecks(
  report: DoctorReport,
  target: InitHookTarget,
  checkUpdates: boolean,
  actions: InitHookAction[],
): InitHookCheck[] {
  const checks: InitHookCheck[] = [];
  for (const entry of report.checks) {
    if (!doctorEntryRelevant(entry.id, target)) continue;
    const source: InitHookCheckSource = entry.id === 'security-config' ? 'security' : 'doctor';
    let checkStatus: InitHookCheckStatus = entry.status;

    if (entry.id === 'cli-update' && entry.status === 'warn') {
      const command = parseActionCommand(entry.detail);
      if (command) {
        checkStatus = 'needs_agent';
        addAction(actions, {
          id: 'cli.update',
          status: 'needs_agent',
          reason: 'The installed Forge CLI is older than the latest package version.',
          requires_agent: true,
          risk: 'Updates global CLI/runtime; Agent should verify adapters and current repo status after install.',
          command,
          verification: verificationCommand(target, checkUpdates),
        });
      }
    } else if (entry.id === 'security-config' && (entry.status === 'warn' || entry.status === 'fail')) {
      if (entry.status === 'warn') checkStatus = 'needs_agent';
      addAction(actions, {
        id: 'security.review-local-config',
        status: 'needs_agent',
        reason: 'Security scan found unmanaged or risky local automation surfaces.',
        requires_agent: true,
        risk: 'Do not blindly delete user-owned config; inspect the reported file and preserve intentional entries.',
        command: 'forge security scan --json',
        verification: 'forge security scan --json',
      });
    } else if (
      (entry.id === 'repo-hook-scripts' || entry.id.startsWith('codegraph-')) &&
      (entry.status === 'warn' || entry.status === 'fail')
    ) {
      const command = parseActionCommand(entry.detail);
      if (command) {
        if (entry.status === 'warn') checkStatus = 'needs_agent';
        addAction(actions, {
          id: `doctor.${entry.id}.repair`,
          status: 'needs_agent',
          reason: `${entry.describe} is not ready.`,
          requires_agent: true,
          risk: 'Repair command may touch repo-local workflow or user-level tool configuration; run from the intended repo root.',
          command,
          verification: verificationCommand(target, checkUpdates),
        });
      }
    }

    checks.push({
      id: `doctor.${entry.id}`,
      title: entry.describe,
      status: checkStatus,
      source,
      detail: entry.detail,
    });
  }
  return checks;
}

function globalRulesChecks(
  target: InitHookTarget,
  env: NodeJS.ProcessEnv | undefined,
  checkUpdates: boolean,
  actions: InitHookAction[],
): InitHookCheck[] {
  const home = homeDir(env);
  const files: Array<{ target: 'codex' | 'claude'; filePath: string }> = [];
  for (const id of selectedTargets(target)) {
    files.push({
      target: id,
      filePath: join(home, id === 'codex' ? '.codex/AGENTS.md' : '.claude/CLAUDE.md'),
    });
  }

  const checks: InitHookCheck[] = [];
  const missing: string[] = [];
  for (const entry of files) {
    let content = '';
    let readError: string | undefined;
    if (existsSync(entry.filePath)) {
      try {
        content = readFileSync(entry.filePath, 'utf-8');
      } catch (error) {
        readError = (error as Error).message;
      }
    }
    const present = content ? hasGlobalWorkingRules(content) : false;
    checks.push({
      id: `global-rules.${entry.target}`,
      title: `${targetLabel(entry.target)} user-level Global Working Rules`,
      status: present ? 'ok' : 'needs_agent',
      source: 'global-rules',
      detail: present
        ? `present at ${entry.filePath}`
        : readError
          ? `unreadable (${readError}): ${entry.filePath}`
          : `${existsSync(entry.filePath) ? 'not found in existing file' : 'file missing'}: ${entry.filePath}`,
    });
    if (!present) missing.push(entry.filePath);
  }

  if (missing.length > 0) {
    addAction(actions, {
      id: 'global-rules.insert',
      status: 'needs_agent',
      reason: 'One or more user-level instruction files do not contain Global Working Rules.',
      requires_agent: true,
      risk: 'User-owned markdown; Agent must inspect first and insert only if absent, preserving existing content.',
      targets: missing,
      verification: verificationCommand(target, checkUpdates),
    });
  }

  return checks;
}

function normalizeToolCommand(command: string | undefined, target: InitHookTarget): string | undefined {
  return command?.replace('<codex|claude|both>', target).trim() || undefined;
}

function toolCheckStatus(toolName: string, status: string | undefined, target: InitHookTarget): InitHookCheckStatus {
  if (toolName === 'codex_automation_profile' && target === 'claude') return 'na';
  const normalized = (status ?? 'unknown').toLowerCase();
  if (['present', 'ok', 'configured', 'ready', 'synced'].includes(normalized)) return 'ok';
  if (['missing', 'not-detected', 'unavailable', 'failed', 'fail', 'missing-local', 'partial'].includes(normalized)) {
    return 'needs_agent';
  }
  if (['warning', 'warn', 'deferred', 'unknown', 'drift', 'stale'].includes(normalized)) return 'warn';
  return 'warn';
}

function updateNeedsAgent(updateStatus: string | null | undefined): boolean {
  const normalized = (updateStatus ?? '').toLowerCase();
  return ['update-available', 'outdated', 'stale'].includes(normalized);
}

function runtimeCapabilityStatus(capability: RuntimeCapability): InitHookCheckStatus {
  const normalized = (capability.status ?? 'unknown').toLowerCase();
  if (['present', 'available', 'supported', 'ok', 'ready'].includes(normalized)) return 'ok';
  if (['missing', 'unavailable', 'unsupported', 'failed', 'fail', 'timed-out'].includes(normalized)) {
    return capability.required ? 'needs_agent' : 'warn';
  }
  return capability.required ? 'needs_agent' : 'warn';
}

function runtimeCapabilityChecks(
  report: ToolingReport | undefined,
  target: InitHookTarget,
  checkUpdates: boolean,
  actions: InitHookAction[],
): InitHookCheck[] {
  const checks: InitHookCheck[] = [];
  for (const [capabilityName, capability] of Object.entries(report?.runtime_capabilities ?? {})) {
    const status = runtimeCapabilityStatus(capability);
    const owner = capability.owner ? `owner=${capability.owner}` : 'owner=unknown';
    const required = capability.required ? 'required' : 'optional';
    const path = capability.path ? `; path=${capability.path}` : '';
    const requiredFor = capability.required_for ? `; required_for=${capability.required_for}` : '';
    const reason = capability.reason ? `; reason=${capability.reason}` : '';
    checks.push({
      id: `runtime.${capabilityName}`,
      title: `Runtime capability: ${capability.name ?? capabilityName}`,
      status,
      source: 'tooling',
      detail: `${capability.status ?? 'unknown'} (${required}); ${owner}${path}${requiredFor}${reason}`,
    });

    if (status === 'needs_agent') {
      addAction(actions, {
        id: `runtime.${capabilityName}.repair`,
        status: 'needs_agent',
        reason: `${capability.name ?? capabilityName} runtime capability is ${capability.status ?? 'unknown'}.`,
        requires_agent: true,
        risk: 'May change host-level runtime tooling; verify setup check after repair.',
        command: normalizeToolCommand(capability.command, target),
        verification: verificationCommand(target, checkUpdates),
      });
    }
  }
  return checks;
}

function commandForToolGap(toolName: string, tool: ToolingTool, target: InitHookTarget): string | undefined {
  const status = (tool.status ?? '').toLowerCase();
  if (status === 'missing') {
    return normalizeToolCommand(tool.install_command, target);
  }
  if (toolName === 'codex_automation_profile') {
    return 'forge install --target codex --no-cli --no-hooks --no-codegraph';
  }
  return normalizeToolCommand(
    tool.sync_command ?? tool.ensure_command ?? tool.mcp_install_command ?? tool.install_command ?? tool.upgrade_command,
    target,
  );
}

function collectToolingReport(sourceRoot: string, cwd: string, target: InitHookTarget, checkUpdates: boolean, env?: NodeJS.ProcessEnv): {
  report?: ToolingReport;
  error?: string;
  command: string[];
} {
  const script = join(sourceRoot, 'scripts', 'check-agent-tooling.sh');
  const args = [script, '--json', '--host', target];
  if (checkUpdates) args.push('--check-updates');
  if (!existsSync(script)) return { command: ['bash', ...args], error: `script not found: ${script}` };

  const result = spawnSync('bash', args, {
    cwd,
    encoding: 'utf-8',
    env: { ...process.env, ...(env ?? {}) },
    timeout: 30000,
  });
  if (result.stdout?.trim()) {
    try {
      return { command: ['bash', ...args], report: JSON.parse(result.stdout) as ToolingReport };
    } catch (error) {
      return { command: ['bash', ...args], error: `could not parse tooling JSON: ${(error as Error).message}` };
    }
  }
  return {
    command: ['bash', ...args],
    error: result.stderr || result.error?.message || `tooling check exited ${result.status ?? 'without status'}`,
  };
}

function toolingChecks(
  report: ToolingReport | undefined,
  target: InitHookTarget,
  checkUpdates: boolean,
  actions: InitHookAction[],
  probeError?: string,
): InitHookCheck[] {
  if (!report) {
    return [{
      id: 'tooling.report',
      title: 'External tooling readiness',
      status: 'warn',
      source: 'tooling',
      detail: probeError ?? 'tooling report unavailable',
    }];
  }

  const checks: InitHookCheck[] = [];
  for (const [toolName, tool] of Object.entries(report.tools ?? {})) {
    const required = tool.required !== false;
    const readinessStatus = required ? toolCheckStatus(toolName, tool.status, target) : 'ok';
    const hasUpdateAction = required && checkUpdates && updateNeedsAgent(tool.update_status);
    const status: InitHookCheckStatus = hasUpdateAction && readinessStatus === 'ok'
      ? 'needs_agent'
      : readinessStatus;
    const update = tool.update_status && tool.update_status !== 'not-checked'
      ? `; update=${tool.update_status}`
      : '';
    const requirement = required ? '' : 'optional; ';
    checks.push({
      id: `tooling.${toolName}`,
      title: `External tooling: ${tool.name ?? toolName}`,
      status,
      source: 'tooling',
      detail: status === 'na'
        ? `skipped for target=${target}`
        : `${tool.status ?? 'unknown'}${update}; ${requirement}${tool.reason ?? 'no detail'}`,
    });

    if (required && readinessStatus === 'needs_agent') {
      const command = commandForToolGap(toolName, tool, target);
      addAction(actions, {
        id: `tooling.${toolName}.repair`,
        status: 'needs_agent',
        reason: `${tool.name ?? toolName} readiness is ${tool.status ?? 'unknown'}.`,
        requires_agent: true,
        risk: 'May install or reconfigure external developer tooling; preserve host-specific paths and verify after the command.',
        command,
        verification: verificationCommand(target, checkUpdates),
      });
    }

    if (hasUpdateAction) {
      const command = normalizeToolCommand(tool.upgrade_command, target);
      addAction(actions, {
        id: `tooling.${toolName}.update`,
        status: 'needs_agent',
        reason: `${tool.name ?? toolName} reports ${tool.update_status}.`,
        requires_agent: true,
        risk: 'Updates external developer tooling; run the tool-specific verification afterward.',
        command,
        verification: verificationCommand(target, checkUpdates),
      });
    }
  }
  return checks;
}

function legacyChecks(cwd: string, target: InitHookTarget, checkUpdates: boolean, actions: InitHookAction[]): InitHookCheck[] {
  const files = [
    { id: 'legacy.project-claude-settings', filePath: join(cwd, '.claude', 'settings.json') },
    { id: 'legacy.project-codex-hooks', filePath: join(cwd, '.codex', 'hooks.json') },
  ];
  const checks: InitHookCheck[] = [];
  const present: string[] = [];
  for (const entry of files) {
    const exists = existsSync(entry.filePath);
    checks.push({
      id: entry.id,
      title: 'Retired repo-local host adapter config',
      status: exists ? 'needs_agent' : 'ok',
      source: 'legacy',
      detail: exists ? `legacy adapter config exists at ${entry.filePath}` : `not present: ${entry.filePath}`,
    });
    if (exists) present.push(entry.filePath);
  }

  if (present.length > 0) {
    addAction(actions, {
      id: 'legacy.project-adapters.review',
      status: 'needs_agent',
      reason: 'Repo-local host adapter configs are retired; user-level adapters should own runtime routing.',
      requires_agent: true,
      risk: 'These files may contain user-owned historical config; review or migrate before removal.',
      command: 'forge migrate --apply',
      targets: present,
      verification: verificationCommand(target, checkUpdates),
    });
  }
  return checks;
}

function summarize(checks: InitHookCheck[]): InitHookReport['summary'] {
  const summary = { ok: 0, warn: 0, fail: 0, na: 0, needs_agent: 0 };
  for (const check of checks) summary[check.status] += 1;
  return summary;
}

function overallStatus(summary: InitHookReport['summary']): InitHookStatus {
  if (summary.fail > 0) return 'blocked';
  if (summary.warn > 0 || summary.needs_agent > 0) return 'attention';
  return 'ok';
}

export function runInitHook(opts: InitHookOptions = {}): InitHookReport {
  const cwd = resolve(opts.cwd ?? process.cwd());
  const sourceRoot = resolve(opts.sourceRoot ?? REPO_ROOT);
  const target = opts.target ?? 'none';
  const checkUpdates = opts.checkUpdates === true;
  const actions: InitHookAction[] = [];

  const statusReport = opts.statusReport ?? withProcessEnv(opts.env, () => runStatus(cwd));
  const doctorEnv = { ...(opts.env ?? {}), [UPDATE_CHECK_ENV]: checkUpdates ? '1' : undefined };
  const doctorReport = opts.doctorReport ?? withProcessEnv(doctorEnv, () => runDoctor(cwd));
  const toolingProbe = target === 'none'
    ? { report: undefined, error: undefined }
    : opts.toolingReport
      ? { report: opts.toolingReport, error: undefined }
      : collectToolingReport(sourceRoot, cwd, target, checkUpdates, opts.env);

  const checks: InitHookCheck[] = [
    ...(target === 'none' ? [] : statusChecks(statusReport, target, checkUpdates, actions)),
    ...doctorChecks(doctorReport, target, checkUpdates, actions),
    ...(target === 'none' ? [] : globalRulesChecks(target, opts.env, checkUpdates, actions)),
    ...(target === 'none' ? [] : runtimeCapabilityChecks(toolingProbe.report, target, checkUpdates, actions)),
    ...(target === 'none' ? [] : toolingChecks(toolingProbe.report, target, checkUpdates, actions, toolingProbe.error)),
    ...(target === 'none' ? [] : legacyChecks(cwd, target, checkUpdates, actions)),
  ];

  const summary = summarize(checks);
  return {
    version: 1,
    status: overallStatus(summary),
    target,
    checkUpdates,
    summary,
    checks,
    agent_actions: actions,
  };
}

export function formatInitHook(report: InitHookReport, asJson = false): string {
  if (asJson) return JSON.stringify(report, null, 2);
  const lines: string[] = [];
  lines.push(`forge setup check: ${report.status}`);
  lines.push(`target=${report.target}; check-updates=${report.checkUpdates ? 'on' : 'off'}`);
  lines.push(
    `summary: ${report.summary.ok} ok, ${report.summary.warn} warn, ${report.summary.fail} fail, ${report.summary.na} n/a, ${report.summary.needs_agent} needs-action`,
  );
  lines.push('');
  lines.push('Checks:');
  for (const check of report.checks) {
    lines.push(`  [${check.status}] ${check.id}: ${check.detail}`);
  }
  lines.push('');
  lines.push('Actions:');
  if (report.agent_actions.length === 0) {
    lines.push('  none');
  } else {
    for (const action of report.agent_actions) {
      lines.push(`  - ${action.id}: ${action.reason}`);
      if (action.command) lines.push(`    command: ${action.command}`);
      if (action.targets?.length) lines.push(`    targets: ${action.targets.join(', ')}`);
      lines.push(`    risk: ${action.risk}`);
      lines.push(`    verification: ${action.verification}`);
    }
  }
  return lines.join('\n');
}

export type SetupSessionStatus = 'open' | 'blocked' | 'ready' | 'closed';

export interface SetupSession {
  schemaVersion: 1;
  sessionId: string;
  status: SetupSessionStatus;
  target: InitHookTarget;
  checkUpdates: boolean;
  profile?: SetupProfile;
  platform?: SetupPlatformSnapshot;
  createdAt: string;
  updatedAt: string;
  closedAt?: string;
  lastReport: InitHookReport;
  nextAction?: InitHookAction;
}

export interface SetupSessionOptions extends InitHookOptions {
  setupRoot?: string;
  profile?: SetupProfile;
  platform?: SetupPlatformSnapshot;
  controllerHome?: string;
  accountHome?: string;
  report?: InitHookReport;
  now?: () => Date;
  uuid?: () => string;
}

export function setupSessionPath(options: Pick<SetupSessionOptions, 'setupRoot' | 'env'> = {}): string {
  const root = options.setupRoot
    ? resolve(options.setupRoot)
    : resolve(options.env?.FORGE_SETUP_HOME ?? join(homeDir(options.env), '.forge'));
  return join(root, 'setup', 'session.json');
}

function readSetupSessionAt(path: string): SetupSession | undefined {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as SetupSession;
    return value.schemaVersion === 1 && typeof value.sessionId === 'string' ? value : undefined;
  } catch {
    return undefined;
  }
}

function writeSetupSessionAt(path: string, session: SetupSession): SetupSession {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(session, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(temporary, path);
  return session;
}

export function readSetupSession(options: Pick<SetupSessionOptions, 'setupRoot' | 'env'> = {}): SetupSession | undefined {
  return readSetupSessionAt(setupSessionPath(options));
}

function setupStatus(report: InitHookReport, nextAction?: InitHookAction): SetupSessionStatus {
  if (report.status === 'blocked') return 'blocked';
  if (report.status === 'ok' && report.agent_actions.length === 0 && !nextAction) return 'ready';
  return 'open';
}

function profileNextAction(profile: SetupProfile | undefined, platform: SetupPlatformSnapshot, options: { controllerHome?: string; accountHome?: string } = {}): InitHookAction | undefined {
  if (!profile) {
    return {
      id: 'controller.select',
      status: 'needs_agent',
      reason: 'Choose the external controller that will act as Forge’s brain. ChatGPT is recommended; Codex, Claude, or another MCP client can be primary instead.',
      requires_agent: true,
      risk: 'Writes only the local Forge setup profile. It does not install or authenticate third-party software.',
      command: 'forge setup configure --controller chatgpt',
      verification: 'forge setup next',
    };
  }
  const controller = resolveControllerGuidance(profile, { controllerHome: options.controllerHome, home: options.accountHome });
  if (controller && !controller.ready) {
    return {
      id: `controller.${controller.controller}.configure`,
      status: 'needs_agent',
      reason: `${controller.title}: ${controller.detail}`,
      requires_agent: true,
      risk: 'Configures only the explicitly selected external controller entry. Unselected Codex/Claude providers remain untouched.',
      ...(controller.command ? { command: controller.command } : {}),
      verification: 'forge setup next',
    };
  }
  const runtime = resolveRuntimeGuidance(profile, { controllerHome: options.controllerHome });
  if (runtime && !runtime.ready) {
    return {
      id: 'runtime.package.install',
      status: 'needs_agent',
      reason: `${runtime.title}: ${runtime.detail}`,
      requires_agent: true,
      risk: 'Installs or diagnoses the user-level Forge Runtime only. Standalone Recovery and source-release activation are not part of normal setup.',
      ...(runtime.command ? { command: runtime.command } : {}),
      verification: 'forge setup next',
    };
  }
  const tunnel = resolveTunnelGuidance(profile, platform, { controllerHome: options.controllerHome });
  if (!tunnel.ready) {
    return {
      id: `tunnel.${tunnel.provider}.configure`,
      status: 'needs_agent',
      reason: `${tunnel.title}: ${tunnel.detail}`,
      requires_agent: true,
      risk: 'Remote connectivity is provider-owned. Forge keeps its MCP listener on loopback; credentials, authentication, and account changes remain explicit.',
      ...(tunnel.command ? { command: tunnel.command } : {}),
      verification: 'forge setup next',
    };
  }
  return undefined;
}

export function openSetupSession(options: SetupSessionOptions = {}): SetupSession {
  const path = setupSessionPath(options);
  const previous = readSetupSessionAt(path);
  const profile = options.profile ?? readSetupProfile(options);
  const platform = options.platform ?? detectSetupPlatform({ env: options.env });
  const target = options.target ?? setupHostTarget(profile);
  const report = options.report ?? runInitHook({ ...options, target });
  const controllerHome = resolveRepoPreferredControllerHome(options.cwd ?? process.cwd(), options.controllerHome);
  const nextAction = profileNextAction(profile, platform, { controllerHome, accountHome: options.accountHome }) ?? report.agent_actions[0];
  const now = (options.now ?? (() => new Date()))().toISOString();
  const reuse = previous && previous.status !== 'closed';
  return writeSetupSessionAt(path, {
    schemaVersion: 1,
    sessionId: reuse ? previous.sessionId : (options.uuid ?? randomUUID)(),
    status: setupStatus(report, nextAction),
    target: report.target,
    checkUpdates: report.checkUpdates,
    ...(profile ? { profile } : {}),
    platform,
    createdAt: reuse ? previous.createdAt : now,
    updatedAt: now,
    lastReport: report,
    ...(nextAction ? { nextAction } : {}),
  });
}

export function closeSetupSession(options: SetupSessionOptions & { force?: boolean } = {}): SetupSession {
  const current = openSetupSession(options);
  if (current.status !== 'ready' && options.force !== true) return current;
  const now = (options.now ?? (() => new Date()))().toISOString();
  return writeSetupSessionAt(setupSessionPath(options), {
    ...current,
    status: 'closed',
    updatedAt: now,
    closedAt: now,
    nextAction: undefined,
  });
}

export function formatSetupSession(session: SetupSession, asJson = false): string {
  if (asJson) return JSON.stringify(session, null, 2);
  const lines = [
    `forge setup: ${session.status}`,
    `session=${session.sessionId}; controller=${session.profile?.primaryController ?? 'not-selected'}; host-tooling=${session.target}; updated=${session.updatedAt}`,
    `summary: ${session.lastReport.summary.ok} ok, ${session.lastReport.summary.warn} warn, ${session.lastReport.summary.fail} fail, ${session.lastReport.summary.needs_agent} needs-action`,
    ...(session.profile ? ['', formatSetupProfile(session.profile, session.platform)] : []),
  ];
  if (session.nextAction) {
    lines.push('', `Next: ${session.nextAction.reason}`);
    if (session.nextAction.command) lines.push(`command: ${session.nextAction.command}`);
    lines.push(`risk: ${session.nextAction.risk}`, `verify: ${session.nextAction.verification}`, 'After completing it, run: forge setup next');
  } else if (session.status === 'ready') {
    lines.push('', 'All checks are ready. Close the setup session with: forge setup close');
  } else if (session.status === 'closed') {
    lines.push('', 'Setup session is closed. Run forge setup open to start a new verified setup cycle.');
  }
  return lines.join('\n');
}

function setupTarget(value: string | undefined, surface: string): InitHookTarget | undefined {
  if (value === undefined) return undefined;
  if (!VALID_TARGETS.includes(value as InitHookTarget)) {
    throw new Error(`${surface}: invalid --target "${value}" (expected: ${VALID_TARGETS.join(', ')})`);
  }
  return value as InitHookTarget;
}

interface SetupCycleRawOptions {
  target?: string;
  controller?: string;
  addController?: string[];
  tunnel?: string;
  endpoint?: string;
  tunnelId?: string;
  checkUpdates?: boolean;
  json?: boolean;
}

function collectOption(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

function syncExplicitRemoteControllerEndpoint(profile: SetupProfile | undefined, endpoint: string | undefined): void {
  if (!profile || !endpoint || !profile.controllers.some((controller) => controller === 'chatgpt' || controller === 'mcp')) return;
  runMcpSetupChatgpt({ userLevel: true, endpoint });
}

function setupCycle(rawOpts: SetupCycleRawOptions, surface: string): void {
  try {
    let profile = readSetupProfile();
    if (rawOpts.controller || rawOpts.addController?.length || rawOpts.tunnel || rawOpts.endpoint || rawOpts.tunnelId) {
      profile = configureSetupProfile({
        controller: rawOpts.controller,
        addControllers: rawOpts.addController,
        tunnel: rawOpts.tunnel,
        endpoint: rawOpts.endpoint,
        tunnelId: rawOpts.tunnelId,
      });
      syncExplicitRemoteControllerEndpoint(profile, rawOpts.endpoint);
    }
    const session = openSetupSession({
      profile,
      target: setupTarget(rawOpts.target, surface) ?? setupHostTarget(profile),
      checkUpdates: rawOpts.checkUpdates === true,
    });
    console.log(formatSetupSession(session, rawOpts.json === true));
    process.exitCode = session.status === 'blocked' ? 1 : 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}

function addSetupSelectionOptions(command: Command): Command {
  return command
    .option('--controller <controller>', 'Primary external controller: chatgpt|codex|claude|mcp')
    .option('--add-controller <controller>', 'Also configure another external controller entry (repeatable)', collectOption, [])
    .option('--tunnel <provider>', 'Remote connection: auto|openai|cloudflare|tailscale|existing|none')
    .option('--tunnel-id <id>', 'OpenAI Secure MCP Tunnel id (non-secret tunnel_...)')
    .option('--endpoint <url>', 'Existing/stable public HTTPS URL ending in /mcp')
    .option('--target <target>', `Deprecated host-tooling override: ${VALID_TARGETS.join('|')}`)
    .option('--check-updates', 'Include network-backed version update advisories')
    .option('--json', 'Output JSON instead of human-readable text');
}

export function buildSetupCommand(): Command {
  const command = new Command('setup');
  command
    .description('Configure Forge around one external controller brain and optional additional controller entries')
    .option('--check-updates', 'Include network-backed version update advisories')
    .option('--json', 'Output JSON instead of human-readable text')
    .action((rawOpts: SetupCycleRawOptions) => setupCycle(rawOpts, 'forge setup'));

  for (const name of ['open', 'next'] as const) {
    addSetupSelectionOptions(command
      .command(name)
      .description(name === 'open' ? 'Start or resume the guided Forge setup session' : 'Re-check configuration and advance to the next action'))
      .action((rawOpts: SetupCycleRawOptions) => setupCycle(rawOpts, `forge setup ${name}`));
  }

  command
    .command('configure')
    .description('Choose the primary external controller, optional additional controllers, and public access provider')
    .requiredOption('--controller <controller>', 'Primary external controller: chatgpt|codex|claude|mcp')
    .option('--add-controller <controller>', 'Also configure another external controller entry (repeatable)', collectOption, [])
    .option('--tunnel <provider>', 'Remote connection: auto|openai|cloudflare|tailscale|existing|none')
    .option('--tunnel-id <id>', 'OpenAI Secure MCP Tunnel id (non-secret tunnel_...)')
    .option('--endpoint <url>', 'Existing/stable public HTTPS URL ending in /mcp')
    .option('--json', 'Output JSON instead of human-readable text')
    .action((rawOpts: { controller: string; addController?: string[]; tunnel?: string; tunnelId?: string; endpoint?: string; json?: boolean }) => {
      try {
        const profile = configureSetupProfile({
          controller: rawOpts.controller,
          addControllers: rawOpts.addController,
          tunnel: rawOpts.tunnel,
          endpoint: rawOpts.endpoint,
          tunnelId: rawOpts.tunnelId,
        });
        syncExplicitRemoteControllerEndpoint(profile, rawOpts.endpoint);
        console.log(rawOpts.json ? JSON.stringify(profile, null, 2) : `${formatSetupProfile(profile)}\n\nNext: forge setup next`);
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 2;
      }
    });

  command
    .command('status')
    .description('Read the persisted setup session and external-controller profile')
    .option('--json', 'Output JSON instead of human-readable text')
    .action((rawOpts: { json?: boolean }) => {
      const session = readSetupSession();
      const profile = readSetupProfile();
      if (!session) {
        if (rawOpts.json) console.log(JSON.stringify({ status: 'not_started', profile }, null, 2));
        else console.log(profile ? `forge setup: not started\n${formatSetupProfile(profile)}\nRun: forge setup open` : 'forge setup: not started\nRun: forge setup');
        return;
      }
      console.log(formatSetupSession(session, rawOpts.json === true));
    });

  command
    .command('close')
    .description('Close setup after the selected external controller path is ready')
    .option('--check-updates', 'Include network-backed version update advisories')
    .option('--force', 'Close even when checks still need attention')
    .option('--json', 'Output JSON instead of human-readable text')
    .action((rawOpts: { checkUpdates?: boolean; force?: boolean; json?: boolean }) => {
      try {
        const profile = readSetupProfile();
        const session = closeSetupSession({
          profile,
          target: setupHostTarget(profile),
          checkUpdates: rawOpts.checkUpdates === true,
          force: rawOpts.force === true,
        });
        console.log(formatSetupSession(session, rawOpts.json === true));
        process.exitCode = session.status === 'closed' ? 0 : 1;
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 2;
      }
    });

  command
    .command('check')
    .description('Run the read-only readiness checklist for the configured external controller set')
    .option('--target <target>', `Host-tooling override: ${VALID_TARGETS.join('|')}`)
    .option('--check-updates', 'Include network-backed version update advisories')
    .option('--json', 'Output JSON instead of human-readable text')
    .action((rawOpts: { target?: string; checkUpdates?: boolean; json?: boolean }) => {
      try {
        const profile = readSetupProfile();
        const report = runInitHook({
          target: setupTarget(rawOpts.target, 'forge setup check') ?? setupHostTarget(profile),
          checkUpdates: rawOpts.checkUpdates === true,
        });
        console.log(formatInitHook(report, rawOpts.json === true));
        process.exitCode = report.status === 'blocked' ? 1 : 0;
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 2;
      }
    });

  return command;
}
