import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'crypto';
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'fs';
import { connect } from 'net';
import { dirname, join, resolve } from 'path';

/**
 * This module deliberately imports only Node built-ins.  It is compiled into
 * the recovery binary and never follows current/active release symlinks.
 */
export interface RecoveryConfig {
  schemaVersion: 1;
  controllerHome: string;
  stableIngressUrl: string;
  publicMcpUrl?: string;
  mainMcpTokenFile?: string;
  expectedToolFingerprint?: string;
  readOnlyTool?: { name: string; arguments?: Record<string, unknown> };
  gateway?: { host: string; port: number; bearerTokenFile: string };
}

interface SupervisorState {
  observedState?: string;
  activeSlot?: string;
  previousSlot?: string;
  currentOperationId?: string | null;
  ingress?: { activeUpstreamPort?: number; state?: string };
  gatewayHost?: { releasePath?: string; releaseRevision?: string; slot?: string };
  controllerDaemon?: { releasePath?: string; releaseRevision?: string; slot?: string };
}

interface ReleaseEvidence {
  path: string;
  revision: string;
  manifestSha256: string;
}

interface KnownGoodStore {
  schemaVersion: 1;
  releases: ReleaseEvidence[];
  updatedAt: string;
}

interface RecoveryLock {
  pid: number;
  instanceId: string;
  acquiredAt: string;
}

export interface VerifyResult {
  ok: boolean;
  at: string;
  supervisor: { ok: boolean; observedState?: string; activeSlot?: string; previousSlot?: string };
  releases: { active?: ReleaseEvidence; previous?: ReleaseEvidence; knownGood?: ReleaseEvidence; coherent: boolean };
  probes: Record<string, { ok: boolean; detail: string; status?: number; value?: unknown }>;
}

export interface RollbackResult {
  ok: boolean;
  noOp?: boolean;
  operationId?: string;
  detail: string;
  verify?: VerifyResult;
}

export interface WatchdogDecision {
  action: 'healthy' | 'degraded' | 'rollback';
  reason: string;
}

export interface WatchdogState { failures: number; firstFailureAt?: number; rollbackUsed: boolean; }

const DEFAULT_CONFIG: Omit<RecoveryConfig, 'controllerHome'> = {
  schemaVersion: 1,
  stableIngressUrl: 'http://127.0.0.1:8765',
  readOnlyTool: { name: 'controller_context' },
};

function json<T>(path: string): T | undefined {
  try { return JSON.parse(readFileSync(path, 'utf8')) as T; } catch { return undefined; }
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  try { chmodSync(temporary, 0o600); } catch { /* best effort */ }
  renameSync(temporary, path);
}

function recoveryRoot(config: RecoveryConfig): string { return join(resolve(config.controllerHome), 'recovery'); }
function statePath(config: RecoveryConfig): string { return join(recoveryRoot(config), 'state', 'known-good.json'); }
function lockPath(config: RecoveryConfig): string { return join(recoveryRoot(config), 'locks', 'operation.lock'); }
function auditPath(config: RecoveryConfig): string { return join(recoveryRoot(config), 'audit', 'recovery.jsonl'); }
function quarantinePath(config: RecoveryConfig): string { return join(recoveryRoot(config), 'state', 'quarantine.json'); }
function socketPath(config: RecoveryConfig): string { return join(resolve(config.controllerHome), 'supervisor', 'control.sock'); }

export function recoveryConfigPath(controllerHome: string): string {
  return join(resolve(controllerHome), 'recovery', 'config', 'recovery.json');
}

export function loadRecoveryConfig(controllerHome: string, explicit?: string): RecoveryConfig {
  const loaded = json<Partial<RecoveryConfig>>(explicit ?? recoveryConfigPath(controllerHome)) ?? {};
  const config: RecoveryConfig = {
    ...DEFAULT_CONFIG,
    ...loaded,
    schemaVersion: 1,
    controllerHome: resolve(loaded.controllerHome ?? controllerHome),
    gateway: loaded.gateway,
  };
  if (!config.controllerHome) throw new Error('RECOVERY_CONTROLLER_HOME_REQUIRED');
  return config;
}

export function createRecoveryConfig(controllerHome: string, input?: Partial<RecoveryConfig>): RecoveryConfig {
  const config = loadRecoveryConfig(controllerHome);
  const next: RecoveryConfig = { ...config, ...input, schemaVersion: 1, controllerHome: resolve(controllerHome) };
  writeJson(recoveryConfigPath(controllerHome), next);
  return next;
}

function releaseEvidence(path: string | undefined): ReleaseEvidence | undefined {
  if (!path) return undefined;
  try {
    const real = realpathSync(path);
    const manifestPath = join(real, 'manifest.json');
    const manifestBytes = readFileSync(manifestPath);
    const manifest = JSON.parse(manifestBytes.toString('utf8')) as { releaseRevision?: unknown };
    if (typeof manifest.releaseRevision !== 'string' || !/^[A-Za-z0-9._-]{6,128}$/.test(manifest.releaseRevision)) return undefined;
    for (const entry of ['supervisor.js', 'repo-harness.js', 'daemon.js']) if (!existsSync(join(real, entry))) return undefined;
    return { path: real, revision: manifest.releaseRevision, manifestSha256: createHash('sha256').update(manifestBytes).digest('hex') };
  } catch { return undefined; }
}

function slotRelease(config: RecoveryConfig, slot: string | undefined): ReleaseEvidence | undefined {
  if (slot !== 'blue' && slot !== 'green') return undefined;
  const slotState = json<{ releasePath?: unknown }>(join(config.controllerHome, 'runtime-slots', slot, 'slot.json'));
  return releaseEvidence(typeof slotState?.releasePath === 'string' ? slotState.releasePath : undefined);
}

function knownGood(config: RecoveryConfig): KnownGoodStore {
  return json<KnownGoodStore>(statePath(config)) ?? { schemaVersion: 1, releases: [], updatedAt: new Date(0).toISOString() };
}

function matchingKnownGood(config: RecoveryConfig, release: ReleaseEvidence | undefined): ReleaseEvidence | undefined {
  if (!release) return undefined;
  return knownGood(config).releases.find((entry) => entry.revision === release.revision && entry.manifestSha256 === release.manifestSha256 && entry.path === release.path);
}

function audit(config: RecoveryConfig, event: string, detail: Record<string, unknown>): void {
  const line = JSON.stringify({ at: new Date().toISOString(), event, detail });
  mkdirSync(dirname(auditPath(config)), { recursive: true, mode: 0o700 });
  writeFileSync(auditPath(config), `${line}\n`, { encoding: 'utf8', mode: 0o600, flag: 'a' });
}

async function withLock<T>(config: RecoveryConfig, action: () => Promise<T>): Promise<T> {
  const path = lockPath(config);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  let fd: number | undefined;
  try {
    fd = openSync(path, 'wx', 0o600);
  } catch (error) {
    const existing = json<RecoveryLock>(path);
    const age = existing ? Date.now() - Date.parse(existing.acquiredAt) : Number.NaN;
    if (Number.isFinite(age) && age > 10 * 60_000) {
      // The stale lock is retained as evidence before a bounded replacement.
      writeFileSync(`${path}.stale-${Date.now()}`, readFileSync(path));
      rmSync(path, { force: true });
      fd = openSync(path, 'wx', 0o600);
    } else {
      throw new Error('RECOVERY_OPERATION_LOCK_BUSY');
    }
  }
  try {
    const lock: RecoveryLock = { pid: process.pid, instanceId: randomUUID(), acquiredAt: new Date().toISOString() };
    writeFileSync(fd!, JSON.stringify(lock));
    return await action();
  } finally {
    if (fd !== undefined) closeSync(fd);
    rmSync(path, { force: true });
  }
}

function control(config: RecoveryConfig, command: Record<string, unknown>, timeoutMs = 5_000): Promise<Record<string, unknown>> {
  return new Promise((resolveControl, reject) => {
    const socket = connect(socketPath(config));
    let text = '';
    const timeout = setTimeout(() => { socket.destroy(); reject(new Error('RECOVERY_CONTROL_TIMEOUT')); }, timeoutMs);
    socket.setEncoding('utf8');
    socket.once('connect', () => socket.write(`${JSON.stringify(command)}\n`));
    socket.on('data', (chunk: string) => {
      text += chunk;
      const newline = text.indexOf('\n');
      if (newline < 0) return;
      clearTimeout(timeout);
      socket.end();
      try { resolveControl(JSON.parse(text.slice(0, newline)) as Record<string, unknown>); } catch { reject(new Error('RECOVERY_CONTROL_INVALID_RESPONSE')); }
    });
    socket.once('error', (error) => { clearTimeout(timeout); reject(new Error(`RECOVERY_CONTROL_UNAVAILABLE: ${error.message}`)); });
  });
}

export async function supervisorStatus(config: RecoveryConfig): Promise<SupervisorState> {
  const response = await control(config, { command: 'status' });
  if (response.ok !== true || !response.state || typeof response.state !== 'object') throw new Error('RECOVERY_SUPERVISOR_STATUS_UNAVAILABLE');
  return response.state as SupervisorState;
}

async function probe(url: string, timeoutMs = 4_000): Promise<{ ok: boolean; detail: string; status?: number }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { headers: { accept: 'application/json' }, signal: controller.signal });
    return { ok: response.ok, detail: `HTTP ${response.status}`, status: response.status };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message.slice(0, 180) : 'request failed' };
  } finally { clearTimeout(timer); }
}

function mainToken(config: RecoveryConfig): string | undefined {
  const candidate = config.mainMcpTokenFile ?? join(config.controllerHome, 'mcp', 'mcp.tokens.json');
  const parsed = json<{ bearerToken?: unknown }>(candidate);
  return typeof parsed?.bearerToken === 'string' && parsed.bearerToken.length >= 24 ? parsed.bearerToken : undefined;
}

async function mcpCall(url: string, token: string, id: number, method: string, params?: Record<string, unknown>): Promise<{ ok: boolean; payload?: Record<string, unknown>; detail: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetch(url, {
      method: 'POST', signal: controller.signal,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) }),
    });
    const payload = await response.json().catch(() => undefined) as Record<string, unknown> | undefined;
    return { ok: response.ok && !payload?.error, payload, detail: `HTTP ${response.status}` };
  } catch (error) { return { ok: false, detail: error instanceof Error ? error.message.slice(0, 180) : 'MCP request failed' }; } finally { clearTimeout(timer); }
}

async function probeMcp(config: RecoveryConfig): Promise<Record<string, { ok: boolean; detail: string; value?: unknown }>> {
  const url = config.publicMcpUrl ?? `${config.stableIngressUrl.replace(/\/$/, '')}/mcp`;
  const token = mainToken(config);
  if (!token) return { mcp_initialize: { ok: false, detail: 'main MCP probe credential is unavailable' } };
  const initialized = await mcpCall(url, token, 1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'standalone-recovery', version: '1' } });
  if (!initialized.ok) return { mcp_initialize: { ok: false, detail: initialized.detail } };
  const listed = await mcpCall(url, token, 2, 'tools/list');
  const tools = Array.isArray((listed.payload?.result as { tools?: unknown } | undefined)?.tools) ? ((listed.payload!.result as { tools: Array<{ name?: unknown }> }).tools) : [];
  const names = tools.map((tool) => typeof tool.name === 'string' ? tool.name : '').filter(Boolean).sort();
  const fingerprint = createHash('sha256').update(names.join('\n')).digest('hex');
  const expected = config.expectedToolFingerprint;
  const expectedMatches = !expected || (expected.length === fingerprint.length && timingSafeEqual(Buffer.from(expected), Buffer.from(fingerprint)));
  const toolListOk = listed.ok && names.length > 0 && expectedMatches;
  const readOnly = config.readOnlyTool ?? { name: 'controller_context' };
  const called = toolListOk ? await mcpCall(url, token, 3, 'tools/call', { name: readOnly.name, arguments: readOnly.arguments ?? {} }) : undefined;
  return {
    mcp_initialize: { ok: initialized.ok, detail: initialized.detail },
    mcp_tools_list: { ok: toolListOk, detail: `${listed.detail}; count=${names.length}; fingerprint=${fingerprint}`, value: { count: names.length, fingerprint } },
    mcp_read_only_call: { ok: Boolean(called?.ok), detail: called?.detail ?? 'tools/list failed' },
  };
}

export async function verifyStableRuntime(config: RecoveryConfig): Promise<VerifyResult> {
  let state: SupervisorState | undefined;
  const probes: VerifyResult['probes'] = {};
  try { state = await supervisorStatus(config); probes.supervisor_socket = { ok: true, detail: 'status received' }; }
  catch (error) { probes.supervisor_socket = { ok: false, detail: error instanceof Error ? error.message : 'status failed' }; }
  const active = releaseEvidence(state?.gatewayHost?.releasePath) ?? slotRelease(config, state?.activeSlot);
  const previous = slotRelease(config, state?.previousSlot);
  const known = matchingKnownGood(config, active);
  const coherent = Boolean(active && state?.gatewayHost?.releaseRevision === active.revision && state?.controllerDaemon?.releaseRevision === active.revision);
  probes.stable_ingress = await probe(`${config.stableIngressUrl.replace(/\/$/, '')}/health`);
  if (state?.ingress?.activeUpstreamPort) probes.active_gateway = await probe(`http://127.0.0.1:${state.ingress.activeUpstreamPort}/health`);
  else probes.active_gateway = { ok: false, detail: 'active upstream port unavailable' };
  if (config.publicMcpUrl) probes.external_mcp_http = await probe(config.publicMcpUrl);
  Object.assign(probes, await probeMcp(config));
  const coreChecks = Object.values(probes).every((entry) => entry.ok);
  const supervisorHealthy = state?.observedState === 'healthy' && state?.ingress?.state === 'running';
  const ok = Boolean(coreChecks && supervisorHealthy && coherent);
  const result: VerifyResult = {
    ok, at: new Date().toISOString(),
    supervisor: { ok: supervisorHealthy, observedState: state?.observedState, activeSlot: state?.activeSlot, previousSlot: state?.previousSlot },
    releases: { active, previous, knownGood: known, coherent }, probes,
  };
  audit(config, 'verify', { ok, activeRevision: active?.revision, previousRevision: previous?.revision, coherent });
  return result;
}

/** Explicitly records evidence only after the full independent verification passed. */
export async function attestKnownGood(config: RecoveryConfig): Promise<ReleaseEvidence> {
  const verified = await verifyStableRuntime(config);
  if (!verified.ok || !verified.releases.active) throw new Error('RECOVERY_KNOWN_GOOD_ATTESTATION_REQUIRES_FULL_VERIFY');
  const store = knownGood(config);
  const releases = [verified.releases.active, ...store.releases.filter((entry) => entry.path !== verified.releases.active!.path)].slice(0, 8);
  writeJson(statePath(config), { schemaVersion: 1, releases, updatedAt: new Date().toISOString() } satisfies KnownGoodStore);
  audit(config, 'known_good_attested', { revision: verified.releases.active.revision, manifestSha256: verified.releases.active.manifestSha256 });
  return verified.releases.active;
}

function quarantine(config: RecoveryConfig, release: ReleaseEvidence | undefined, reason: string): void {
  if (!release) return;
  const current = json<{ schemaVersion: 1; releases: Array<ReleaseEvidence & { reason: string; at: string }> }>(quarantinePath(config)) ?? { schemaVersion: 1, releases: [] };
  const releases = [{ ...release, reason, at: new Date().toISOString() }, ...current.releases.filter((item) => item.path !== release.path)].slice(0, 32);
  writeJson(quarantinePath(config), { schemaVersion: 1, releases });
}

async function operation(config: RecoveryConfig, requestId: string, kind: string, reason: string): Promise<{ operationId?: string; phase?: string; deduplicated?: boolean }> {
  const response = await control(config, { command: 'operation_submit', requestId, kind, actor: 'standalone-recovery', reason });
  if (response.ok !== true || !response.operation || typeof response.operation !== 'object') throw new Error('RECOVERY_OPERATION_REJECTED');
  const accepted = response.operation as { operationId?: unknown; phase?: unknown };
  return { operationId: typeof accepted.operationId === 'string' ? accepted.operationId : undefined, phase: typeof accepted.phase === 'string' ? accepted.phase : undefined, deduplicated: response.deduplicated === true };
}

async function waitForOperation(config: RecoveryConfig, operationId: string): Promise<{ phase?: string; error?: string }> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const response = await control(config, { command: 'operation_get', operationId });
    const operationValue = response.operation;
    if (operationValue && typeof operationValue === 'object') {
      const operationState = operationValue as { phase?: unknown; error?: unknown };
      const phase = typeof operationState.phase === 'string' ? operationState.phase : undefined;
      if (phase === 'succeeded' || phase === 'failed' || phase === 'locked_out') return { phase, error: typeof operationState.error === 'string' ? operationState.error : undefined };
    }
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 1_000));
  }
  return { phase: 'timeout', error: 'RECOVERY_OPERATION_TIMEOUT' };
}

export async function rollbackPrevious(config: RecoveryConfig, reason = 'standalone recovery'): Promise<RollbackResult> {
  return withLock(config, async () => {
    const before = await verifyStableRuntime(config);
    const active = before.releases.active;
    const knownActive = matchingKnownGood(config, active);
    if (knownActive) return { ok: true, noOp: true, detail: 'active release is already independently attested known-good', verify: before };
    const target = before.releases.previous;
    const knownTarget = matchingKnownGood(config, target);
    if (!active || !target || !knownTarget || before.supervisor.previousSlot === undefined) {
      return { ok: false, detail: 'rollback refused: Supervisor-registered previous release lacks known-good manifest evidence', verify: before };
    }
    const requestId = `recovery-rollback:${active.revision}:${target.revision}`;
    const accepted = await operation(config, requestId, 'rollback', reason.slice(0, 500));
    if (!accepted.operationId) return { ok: false, detail: 'rollback operation did not return an operation id' };
    const completed = await waitForOperation(config, accepted.operationId);
    if (completed.phase !== 'succeeded') {
      quarantine(config, active, completed.error ?? completed.phase ?? 'rollback failed');
      audit(config, 'rollback_failed', { operationId: accepted.operationId, activeRevision: active.revision, reason: completed.error ?? completed.phase });
      return { ok: false, operationId: accepted.operationId, detail: completed.error ?? 'rollback did not succeed' };
    }
    const after = await verifyStableRuntime(config);
    if (!after.ok || after.releases.active?.revision !== target.revision || !matchingKnownGood(config, after.releases.active)) {
      quarantine(config, active, 'post-rollback verification failed');
      return { ok: false, operationId: accepted.operationId, detail: 'rollback completed but independent verification failed', verify: after };
    }
    quarantine(config, active, 'rollback completed');
    audit(config, 'rollback_succeeded', { operationId: accepted.operationId, activeRevision: active.revision, restoredRevision: target.revision });
    return { ok: true, operationId: accepted.operationId, detail: 'previous known-good release restored and verified', verify: after };
  });
}

export async function reconnectMain(config: RecoveryConfig): Promise<{ ok: boolean; detail: string; verify: VerifyResult }> {
  // A recovery connector must survive a main failure; this action is therefore
  // intentionally a bounded health/reconnect observation, never a rollout.
  const verified = await verifyStableRuntime(config);
  const publicProbe = verified.probes.external_mcp_http;
  const ok = verified.probes.stable_ingress?.ok === true && (publicProbe?.ok === true || publicProbe?.status === 401);
  audit(config, 'reconnect_main', { ok, externalStatus: publicProbe?.status });
  return { ok, detail: ok ? 'stable ingress and primary endpoint are reachable; client session may refresh' : 'primary endpoint remains unavailable; recovery channel remains independent', verify: verified };
}

export function decideWatchdog(input: { failures: number; firstFailureAt?: number; evidenceClasses: string[]; activeKnownGood: boolean; previousKnownGood: boolean; operationInFlight: boolean; rollbackUsed: boolean }): WatchdogDecision {
  if (input.failures === 0) return { action: 'healthy', reason: 'all recovery probes healthy' };
  const sustained = input.firstFailureAt !== undefined && Date.now() - input.firstFailureAt >= 30_000;
  const independentEvidence = new Set(input.evidenceClasses).size >= 2;
  if (input.failures < 6 || !sustained || !independentEvidence) return { action: 'degraded', reason: 'failure threshold, duration, or independent-evidence quorum not met' };
  if (input.activeKnownGood) return { action: 'degraded', reason: 'active release is known-good; do not roll back' };
  if (!input.previousKnownGood || input.operationInFlight || input.rollbackUsed) return { action: 'degraded', reason: 'rollback safety precondition not met' };
  return { action: 'rollback', reason: 'six sustained failures with two independent evidence classes and a verified previous release' };
}

export async function diagnose(config: RecoveryConfig): Promise<Record<string, unknown>> {
  const verified = await verifyStableRuntime(config);
  return { verified, knownGood: knownGood(config), quarantine: json(quarantinePath(config)) ?? { releases: [] } };
}

export async function listSlots(config: RecoveryConfig): Promise<Record<string, unknown>> {
  const state = await supervisorStatus(config);
  return { activeSlot: state.activeSlot, previousSlot: state.previousSlot, active: slotRelease(config, state.activeSlot), previous: slotRelease(config, state.previousSlot), knownGood: knownGood(config).releases };
}

export async function restartSupervisor(config: RecoveryConfig): Promise<{ ok: boolean; operationId?: string; detail: string }> {
  const state = await supervisorStatus(config);
  if (state.currentOperationId) return { ok: false, detail: 'Supervisor already has an operation in flight' };
  const accepted = await operation(config, `recovery-restart-supervisor:${Date.now()}`, 'restart_full', 'bounded standalone recovery restart');
  return { ok: Boolean(accepted.operationId), operationId: accepted.operationId, detail: accepted.operationId ? 'Supervisor restart accepted' : 'Supervisor restart rejected' };
}

export function gatewayToken(config: RecoveryConfig): string | undefined {
  const file = config.gateway?.bearerTokenFile;
  const parsed = file ? json<{ token?: unknown; expiresAt?: unknown }>(file) : undefined;
  if (typeof parsed?.expiresAt === 'string' && Date.parse(parsed.expiresAt) <= Date.now()) return undefined;
  return typeof parsed?.token === 'string' && parsed.token.length >= 32 ? parsed.token : undefined;
}

export function initializeStandaloneRecovery(controllerHome: string, port = 8787): RecoveryConfig {
  const root = resolve(controllerHome);
  const tokenPath = join(root, 'recovery', 'config', 'gateway-token.json');
  if (!existsSync(tokenPath)) {
    mkdirSync(dirname(tokenPath), { recursive: true, mode: 0o700 });
    writeFileSync(tokenPath, `${JSON.stringify({ token: randomBytes(32).toString('base64url'), createdAt: new Date().toISOString() })}\n`, { mode: 0o600 });
    try { chmodSync(tokenPath, 0o600); } catch { /* best effort */ }
  }
  return createRecoveryConfig(root, { gateway: { host: '127.0.0.1', port, bearerTokenFile: tokenPath } });
}

export function secureEqual(left: string, right: string): boolean {
  const a = Buffer.from(left); const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function watchdogTick(config: RecoveryConfig, prior: WatchdogState): Promise<{ state: WatchdogState; decision: WatchdogDecision; verify: VerifyResult; rollback?: RollbackResult }> {
  const verified = await verifyStableRuntime(config);
  if (verified.ok) return { state: { failures: 0, rollbackUsed: prior.rollbackUsed }, decision: { action: 'healthy', reason: 'full verification passed' }, verify: verified };
  const evidenceClasses = Object.entries(verified.probes).filter(([, value]) => !value.ok).map(([name]) => name.startsWith('external') ? 'external' : name.startsWith('mcp') ? 'mcp' : name.startsWith('active') ? 'gateway' : name);
  const activeKnownGood = Boolean(matchingKnownGood(config, verified.releases.active));
  const previousKnownGood = Boolean(matchingKnownGood(config, verified.releases.previous));
  const state: WatchdogState = { failures: prior.failures + 1, firstFailureAt: prior.firstFailureAt ?? Date.now(), rollbackUsed: prior.rollbackUsed };
  const decision = decideWatchdog({ ...state, evidenceClasses, activeKnownGood, previousKnownGood, operationInFlight: Boolean((await supervisorStatus(config)).currentOperationId) });
  if (decision.action !== 'rollback') return { state, decision, verify: verified };
  const rollback = await rollbackPrevious(config, 'watchdog sustained multi-signal failure');
  return { state: { ...state, rollbackUsed: true }, decision, verify: verified, rollback };
}
