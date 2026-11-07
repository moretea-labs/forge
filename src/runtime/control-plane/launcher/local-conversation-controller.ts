import { execFile, spawn, type ChildProcess } from 'child_process';
import { mkdirSync, realpathSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { extname, isAbsolute, join, relative, sep } from 'path';
import { redactProcessOutput } from '../../../effects/process-runner';
import { resolveProviderMcpBootstrap } from './provider-mcp-bootstrap';
import {
  buildCodexControllerInvocation,
  launcherProcessEnvironment,
  resolveLauncherExecutable,
} from './thin-launcher';

const LOCAL_CONVERSATION_TIMEOUT_MS = 5 * 60_000;
const LOCAL_CONVERSATION_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const LOCAL_CONVERSATION_MAX_PROMPT_CHARS = 20_000;
const LOCAL_CONVERSATION_ACTIVITY_EVENT_LIMIT = 30;
const LOCAL_CONVERSATION_MAX_IMAGES = 4;
const LOCAL_CONVERSATION_MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const LOCAL_CONVERSATION_IMAGE_ROOT = 'forge-local-conversation-images';
const LOCAL_CONVERSATION_IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);
const LOCAL_CONVERSATION_ID = /^[A-Za-z0-9._:-]{1,160}$/;

export type LocalConversationActivityPhase = 'starting' | 'thinking' | 'tool' | 'responding' | 'finishing';
export type LocalConversationActivityEventStatus = 'active' | 'completed';

export interface LocalConversationActivityEvent {
  phase: LocalConversationActivityPhase;
  label: string;
  status: LocalConversationActivityEventStatus;
  startedAt: string;
  completedAt?: string;
}

export interface LocalConversationActivitySnapshot {
  conversationId: string;
  status: 'idle' | 'running';
  phase?: LocalConversationActivityPhase;
  toolActivityCount: number;
  lastActivity?: string;
  startedAt?: string;
  updatedAt?: string;
  events: LocalConversationActivityEvent[];
}

interface ActiveLocalTurn {
  child: ChildProcess;
  cancelRequested: boolean;
  lineBuffer: string;
  activity: LocalConversationActivitySnapshot;
}

// Transient process handles and their bounded live observation live only in the
// existing local conversation owner. Nothing here is durable Work/session authority.
const activeLocalTurns = new Map<string, ActiveLocalTurn>();

export function readLocalConversationActivity(conversationId: string): LocalConversationActivitySnapshot {
  if (!LOCAL_CONVERSATION_ID.test(conversationId)) throw Error('LOCAL_CONVERSATION_ID_INVALID');
  const active = activeLocalTurns.get(conversationId);
  return active
    ? { ...active.activity, events: active.activity.events.map((event) => ({ ...event })) }
    : { conversationId, status: 'idle', toolActivityCount: 0, events: [] };
}

export function cancelLocalConversation(conversationId: string): {
  conversationId: string; status: 'requested' | 'not_active';
} {
  if (!LOCAL_CONVERSATION_ID.test(conversationId)) throw Error('LOCAL_CONVERSATION_ID_INVALID');
  const turn = activeLocalTurns.get(conversationId);
  if (!turn) return { conversationId, status: 'not_active' };
  if (!turn.cancelRequested) {
    if (!turn.child.kill('SIGTERM')) return { conversationId, status: 'not_active' };
    turn.cancelRequested = true;
  }
  // Signalling is not proof that a Forge MCP effect was rolled back.
  return { conversationId, status: 'requested' };
}


export interface LocalConversationProviderStatus {
  provider: 'codex';
  status: 'ready' | 'not_configured' | 'unavailable';
  label: string;
  detail: string;
  streaming: boolean;
  tools: boolean;
  cancellable: boolean;
  imageInput: boolean;
}

export interface LocalConversationReasoningOption {
  effort: string;
  description: string;
}

export interface LocalConversationModelOption {
  slug: string;
  displayName: string;
  description: string;
  defaultReasoningLevel: string;
  supportedReasoningLevels: LocalConversationReasoningOption[];
}

export interface LocalConversationModelCatalog {
  provider: 'codex';
  models: LocalConversationModelOption[];
}

export interface LocalConversationSendInput {
  controllerHome: string;
  conversationId: string;
  providerSessionId?: string;
  prompt: string;
  repoId?: string;
  model?: string;
  reasoningEffort?: string;
  imagePaths?: string[];
  timeoutMs?: number;
}

export interface LocalConversationSendResult {
  provider: 'codex';
  status: 'completed';
  conversationId: string;
  providerSessionId: string;
  output: string;
  toolActivityCount: number;
}

export interface ParsedCodexConversationEvents {
  providerSessionId?: string;
  output?: string;
  toolActivityCount: number;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function boundedTimeout(value: number | undefined): number {
  if (!Number.isFinite(value)) return LOCAL_CONVERSATION_TIMEOUT_MS;
  return Math.max(5_000, Math.min(10 * 60_000, Math.trunc(value!)));
}

function agentMessageText(item: Record<string, unknown>): string | undefined {
  if (typeof item.text === 'string' && item.text.trim()) return item.text.trim();
  if (typeof item.output_text === 'string' && item.output_text.trim()) return item.output_text.trim();
  if (!Array.isArray(item.content)) return undefined;
  const text = item.content.map((entry) => {
    const content = record(entry);
    if (!content) return '';
    if (typeof content.text === 'string') return content.text;
    if (typeof content.output_text === 'string') return content.output_text;
    return '';
  }).filter(Boolean).join('\n').trim();
  return text || undefined;
}

export function parseCodexConversationJsonl(stdout: string): ParsedCodexConversationEvents {
  let providerSessionId: string | undefined;
  let output: string | undefined;
  let toolActivityCount = 0;
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    let event: Record<string, unknown> | undefined;
    try { event = record(JSON.parse(trimmed)); } catch { continue; }
    if (!event) continue;
    const type = typeof event.type === 'string' ? event.type : '';
    if (type === 'thread.started' && typeof event.thread_id === 'string' && event.thread_id.trim()) {
      providerSessionId = event.thread_id.trim();
    }
    if (type !== 'item.completed') continue;
    const item = record(event.item);
    if (!item) continue;
    const itemType = typeof item.type === 'string' ? item.type : '';
    if (itemType === 'agent_message') {
      output = agentMessageText(item) ?? output;
      continue;
    }
    if (['mcp_tool_call', 'command_execution', 'file_change', 'web_search'].includes(itemType)) {
      toolActivityCount += 1;
    }
  }
  return { providerSessionId, output, toolActivityCount };
}

function activityLabel(itemType: string, item: Record<string, unknown>): string {
  const name = typeof item.name === 'string' ? item.name.trim().slice(0, 80) : '';
  if (itemType === 'mcp_tool_call') return name ? `正在使用 ${name}` : '正在使用 Forge 工具';
  if (itemType === 'command_execution') return '正在执行命令';
  if (itemType === 'file_change') return '正在修改文件';
  if (itemType === 'web_search') return '正在搜索';
  return 'Agent 正在工作';
}

function recordActivityEvent(
  active: ActiveLocalTurn,
  phase: LocalConversationActivityPhase,
  label: string,
  status: LocalConversationActivityEventStatus,
  now: string,
): void {
  const events = active.activity.events;
  if (status === 'completed') {
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const existing = events[index]!;
      if (existing.status === 'active' && existing.phase === phase && existing.label === label) {
        existing.status = 'completed';
        existing.completedAt = now;
        return;
      }
    }
  }
  for (const existing of events) {
    if (existing.status === 'active') {
      existing.status = 'completed';
      existing.completedAt = now;
    }
  }
  events.push({
    phase,
    label,
    status,
    startedAt: now,
    ...(status === 'completed' ? { completedAt: now } : {}),
  });
  if (events.length > LOCAL_CONVERSATION_ACTIVITY_EVENT_LIMIT) {
    events.splice(0, events.length - LOCAL_CONVERSATION_ACTIVITY_EVENT_LIMIT);
  }
}

function applyActivityLine(active: ActiveLocalTurn, line: string): void {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return;
  let event: Record<string, unknown> | undefined;
  try { event = record(JSON.parse(trimmed)); } catch { return; }
  if (!event) return;
  const type = typeof event.type === 'string' ? event.type : '';
  const now = new Date().toISOString();
  const update = (
    phase: LocalConversationActivityPhase,
    lastActivity: string,
    status: LocalConversationActivityEventStatus,
  ) => {
    active.activity.phase = phase;
    active.activity.lastActivity = lastActivity;
    active.activity.updatedAt = now;
    recordActivityEvent(active, phase, lastActivity, status, now);
  };
  if (type === 'thread.started' && typeof event.thread_id === 'string' && event.thread_id.trim()) {
    update('thinking', '会话已启动', 'completed');
    return;
  }
  if (type === 'turn.started') {
    update('thinking', '正在推理', 'active');
    return;
  }
  if (type === 'turn.completed') {
    update('finishing', '正在完成', 'completed');
    return;
  }
  if (type !== 'item.started' && type !== 'item.completed') return;
  const item = record(event.item);
  if (!item) return;
  const itemType = typeof item.type === 'string' ? item.type : '';
  const status: LocalConversationActivityEventStatus = type === 'item.completed' ? 'completed' : 'active';
  if (itemType === 'agent_message') {
    update('responding', '正在生成回复', status);
    return;
  }
  if (['mcp_tool_call', 'command_execution', 'file_change', 'web_search'].includes(itemType)) {
    if (type === 'item.completed') active.activity.toolActivityCount += 1;
    update('tool', activityLabel(itemType, item), status);
  }
}

function ingestActivityChunk(active: ActiveLocalTurn, text: string): void {
  active.lineBuffer += text;
  const lines = active.lineBuffer.split(/\r?\n/);
  active.lineBuffer = lines.pop() ?? '';
  for (const line of lines) applyActivityLine(active, line);
}

function localConversationCwd(): string {
  const root = join(tmpdir(), 'forge-local-controller');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  return root;
}

function conversationPrompt(prompt: string, repoId?: string): string {
  return [
    'You are the Forge Desktop local controller.',
    'Use the injected Forge MCP capabilities for repository, Runtime, and other Forge operations. Do not create Requirement, Plan, Work, ControllerRound, or a scheduled continuation unless the user explicitly requests that durable lifecycle.',
    repoId
      ? `Attached repository: ${repoId}. Pass repo_id=${repoId} to Forge capabilities that require repository scope.`
      : 'No repository is attached. Do not guess a repository identity.',
    '',
    prompt,
  ].join('\n');
}

export async function readLocalConversationProviderStatus(
  cwd: string = process.cwd(),
): Promise<LocalConversationProviderStatus> {
  try {
    const executable = resolveLauncherExecutable({ controllerType: 'codex', cwd });
    const loginConfirmed = await new Promise<boolean>((resolve) => {
      execFile(executable, ['login', 'status'], {
        cwd, env: launcherProcessEnvironment(process.env),
        timeout: 4_000, maxBuffer: 8 * 1024,
      }, (error) => resolve(!error));
    });
    if (!loginConfirmed) {
      return {
        provider: 'codex',
        status: 'not_configured',
        label: 'Codex 登录状态未确认',
        detail: 'Codex CLI 已安装，但登录检查未通过。请运行 codex login，再刷新连接状态。',
        streaming: false,
        tools: false,
        cancellable: true,
        imageInput: true,
      };
    }
    return {
      provider: 'codex',
      status: 'ready',
      label: 'Codex 已连接',
      detail: '使用 Codex CLI 的现有登录；Forge 操作通过当前 Runtime MCP capability 执行。',
      streaming: false,
      tools: true,
      cancellable: true,
      imageInput: true,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const missing = message.startsWith('LAUNCHER_EXECUTABLE_UNAVAILABLE');
    return {
      provider: 'codex',
      status: missing ? 'not_configured' : 'unavailable',
      label: missing ? 'Codex CLI 未安装' : 'Codex 暂不可用',
      detail: missing ? '安装并登录 Codex CLI 后即可使用本地会话。' : message,
      streaming: false,
      tools: false,
      cancellable: true,
      imageInput: true,
    };
  }
}

function boundedCatalogText(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value.trim().slice(0, 500) : fallback;
}

export function parseCodexModelCatalog(stdout: string): LocalConversationModelCatalog {
  let parsed: unknown;
  try { parsed = JSON.parse(stdout); } catch { throw new Error('LOCAL_CONVERSATION_MODEL_CATALOG_INVALID'); }
  const root = record(parsed);
  const rows = Array.isArray(root?.models) ? root.models : [];
  const models = rows.flatMap((value, index): Array<LocalConversationModelOption & { priority: number }> => {
    const item = record(value);
    const slug = boundedCatalogText(item?.slug);
    if (!slug || slug.length > 120 || !/^[A-Za-z0-9._:-]+$/.test(slug) || item?.visibility !== 'list') return [];
    const levels = Array.isArray(item.supported_reasoning_levels)
      ? item.supported_reasoning_levels.flatMap((entry): LocalConversationReasoningOption[] => {
          const level = record(entry);
          const effort = boundedCatalogText(level?.effort);
          if (!effort || effort.length > 32 || !/^[A-Za-z0-9_-]+$/.test(effort)) return [];
          return [{ effort, description: boundedCatalogText(level?.description) }];
        })
      : [];
    return [{
      slug,
      displayName: boundedCatalogText(item.display_name, slug),
      description: boundedCatalogText(item.description),
      defaultReasoningLevel: boundedCatalogText(item.default_reasoning_level),
      supportedReasoningLevels: levels,
      priority: typeof item.priority === 'number' && Number.isFinite(item.priority) ? item.priority : 10_000 + index,
    }];
  }).sort((left, right) => left.priority - right.priority)
    .slice(0, 32)
    .map(({ priority: _priority, ...model }) => model);
  if (!models.length) throw new Error('LOCAL_CONVERSATION_MODEL_CATALOG_EMPTY');
  return { provider: 'codex', models };
}

export async function readLocalConversationModelCatalog(
  cwd: string = process.cwd(),
): Promise<LocalConversationModelCatalog> {
  const executable = resolveLauncherExecutable({ controllerType: 'codex', cwd });
  const stdout = await new Promise<string>((resolve, reject) => {
    execFile(executable, ['debug', 'models'], {
      cwd,
      env: launcherProcessEnvironment(process.env),
      timeout: 5_000,
      maxBuffer: 8 * 1024 * 1024,
      encoding: 'utf8',
    }, (error, output) => {
      if (error) {
        reject(new Error(`LOCAL_CONVERSATION_MODEL_CATALOG_FAILED: ${error.message}`));
        return;
      }
      resolve(output);
    });
  });
  return parseCodexModelCatalog(stdout);
}

export function runCodexConversation(
  executable: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
  timeoutMs: number,
  conversationId: string,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    if (activeLocalTurns.has(conversationId)) {
      throw Error('LOCAL_CONVERSATION_ALREADY_RUNNING');
    }
    const child = spawn(executable, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const now = new Date().toISOString();
    const active: ActiveLocalTurn = {
      child,
      cancelRequested: false,
      lineBuffer: '',
      activity: {
        conversationId,
        status: 'running',
        phase: 'starting',
        toolActivityCount: 0,
        lastActivity: '正在启动 Codex',
        startedAt: now,
        updatedAt: now,
        events: [{
          phase: 'starting',
          label: '正在启动 Codex',
          status: 'active',
          startedAt: now,
        }],
      },
    };
    activeLocalTurns.set(conversationId, active);
    let stdout = '';
    let stderr = '';
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    };
    const append = (current: string, chunk: unknown, stream: 'stdout' | 'stderr'): string => {
      const next = `${current}${Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk ?? '')}`;
      if (Buffer.byteLength(next, 'utf8') > LOCAL_CONVERSATION_MAX_OUTPUT_BYTES) {
        child.kill('SIGTERM');
        fail(new Error(`LOCAL_CONVERSATION_${stream.toUpperCase()}_TOO_LARGE`));
        return current;
      }
      return next;
    };
    child.stdout?.on('data', (chunk) => {
      const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk ?? '');
      stdout = append(stdout, text, 'stdout');
      ingestActivityChunk(active, text);
    });
    child.stderr?.on('data', (chunk) => { stderr = append(stderr, chunk, 'stderr'); });
    child.once('error', (error) => fail(new Error(`LOCAL_CONVERSATION_PROVIDER_START_FAILED: ${error.message}`)));
    child.once('close', (code, signal) => {
      if (active.lineBuffer.trim()) applyActivityLine(active, active.lineBuffer);
      if (activeLocalTurns.get(conversationId) === active) activeLocalTurns.delete(conversationId);
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (active.cancelRequested) {
        reject(new Error('LOCAL_CONVERSATION_CANCELLED_RECONCILE: Codex stopped; any in-flight Forge tool needs independent outcome verification.'));
        return;
      }
      if (code !== 0) {
        const detail = redactProcessOutput(stderr.trim() || stdout.trim()).replace(/\s+/g, ' ').slice(0, 1200);
        reject(new Error(`LOCAL_CONVERSATION_PROVIDER_FAILED: code=${String(code ?? 'null')} signal=${signal ?? 'none'}${detail ? `; ${detail}` : ''}`));
        return;
      }
      resolve({ stdout, stderr });
    });
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      fail(new Error('LOCAL_CONVERSATION_PROVIDER_TIMEOUT'));
    }, timeoutMs);
  });
}

export function validateLocalConversationImagePaths(conversationId: string, imagePaths?: string[]): string[] {
  if (!imagePaths?.length) return [];
  if (!LOCAL_CONVERSATION_ID.test(conversationId)) throw new Error('LOCAL_CONVERSATION_ID_INVALID');
  if (imagePaths.length > LOCAL_CONVERSATION_MAX_IMAGES) throw new Error('LOCAL_CONVERSATION_IMAGE_COUNT_INVALID');

  let root: string;
  try {
    root = realpathSync(join(tmpdir(), LOCAL_CONVERSATION_IMAGE_ROOT, conversationId));
  } catch {
    throw new Error('LOCAL_CONVERSATION_IMAGE_ROOT_INVALID');
  }

  return imagePaths.map((imagePath) => {
    if (!imagePath || imagePath.length > 4096 || !isAbsolute(imagePath)) {
      throw new Error('LOCAL_CONVERSATION_IMAGE_PATH_INVALID');
    }
    let resolved: string;
    try {
      resolved = realpathSync(imagePath);
    } catch {
      throw new Error('LOCAL_CONVERSATION_IMAGE_PATH_INVALID');
    }
    const scoped = relative(root, resolved);
    if (!scoped || scoped === '..' || scoped.startsWith(`..${sep}`) || isAbsolute(scoped)) {
      throw new Error('LOCAL_CONVERSATION_IMAGE_PATH_OUTSIDE_STAGING');
    }
    if (!LOCAL_CONVERSATION_IMAGE_EXTENSIONS.has(extname(resolved).toLowerCase())) {
      throw new Error('LOCAL_CONVERSATION_IMAGE_TYPE_UNSUPPORTED');
    }
    const stat = statSync(resolved);
    if (!stat.isFile() || stat.size <= 0 || stat.size > LOCAL_CONVERSATION_MAX_IMAGE_BYTES) {
      throw new Error('LOCAL_CONVERSATION_IMAGE_FILE_INVALID');
    }
    return resolved;
  });
}

export function buildLocalConversationProviderArgs(
  model?: string, reasoningEffort?: string, imagePaths: string[] = [],
): string[] {
  const selectedModel = model?.trim();
  const selectedReasoning = reasoningEffort?.trim();
  if (selectedModel && (selectedModel.length > 120 || !/^[A-Za-z0-9._:-]+$/.test(selectedModel))) {
    throw new Error('LOCAL_CONVERSATION_MODEL_INVALID');
  }
  if (selectedReasoning && (selectedReasoning.length > 32 || !/^[A-Za-z0-9_-]+$/.test(selectedReasoning))) {
    throw new Error('LOCAL_CONVERSATION_REASONING_INVALID');
  }
  return [
    '--skip-git-repo-check',
    ...(selectedModel ? ['--model', selectedModel] : []),
    ...(selectedReasoning ? ['-c', `model_reasoning_effort="${selectedReasoning}"`] : []),
    ...imagePaths.flatMap((imagePath) => ['--image', imagePath]),
  ];
}

export async function sendLocalConversation(input: LocalConversationSendInput): Promise<LocalConversationSendResult> {
  const conversationId = input.conversationId.trim();
  const prompt = input.prompt.trim();
  const providerSessionId = input.providerSessionId?.trim();
  const repoId = input.repoId?.trim();
  if (!LOCAL_CONVERSATION_ID.test(conversationId)) throw new Error('LOCAL_CONVERSATION_ID_INVALID');
  if (!prompt || prompt.length > LOCAL_CONVERSATION_MAX_PROMPT_CHARS) throw new Error('LOCAL_CONVERSATION_PROMPT_INVALID');
  if (providerSessionId && !LOCAL_CONVERSATION_ID.test(providerSessionId)) throw new Error('LOCAL_CONVERSATION_PROVIDER_SESSION_INVALID');
  if (repoId && repoId.length > 256) throw new Error('LOCAL_CONVERSATION_REPOSITORY_INVALID');

  const imagePaths = validateLocalConversationImagePaths(conversationId, input.imagePaths);
  const providerArgs = buildLocalConversationProviderArgs(input.model, input.reasoningEffort, imagePaths);
  const cwd = localConversationCwd();
  // The real conversation spawn reports startup failures; status queries still probe.
  const executable = resolveLauncherExecutable({ controllerType: 'codex', cwd }, process.env, false);
  const bootstrap = resolveProviderMcpBootstrap(input.controllerHome, 'codex', `local-${conversationId}`);
  const invocation = buildCodexControllerInvocation({
    executable,
    prompt: conversationPrompt(prompt, repoId),
    mcpBootstrap: bootstrap,
    sandbox: 'read-only',
    // The isolated local-conversation cwd is intentionally not a Git checkout.
    // Only this local Agent entry opts out of Codex's repo presence check.
    // Forge MCP tools still validate the registered repo/checkout independently.
    args: providerArgs,
    resumeSessionId: providerSessionId,
    json: true,
  });
  const completed = await runCodexConversation(
    invocation.executable,
    invocation.args,
    launcherProcessEnvironment(bootstrap.env),
    cwd,
    boundedTimeout(input.timeoutMs),
    conversationId,
  );
  const parsed = parseCodexConversationJsonl(completed.stdout);
  const resolvedProviderSessionId = parsed.providerSessionId ?? providerSessionId;
  if (!resolvedProviderSessionId) throw new Error('LOCAL_CONVERSATION_PROVIDER_SESSION_MISSING');
  if (!parsed.output?.trim()) throw new Error('LOCAL_CONVERSATION_RESPONSE_MISSING');
  return {
    provider: 'codex',
    status: 'completed',
    conversationId,
    providerSessionId: resolvedProviderSessionId,
    output: parsed.output.trim(),
    toolActivityCount: parsed.toolActivityCount,
  };
}
