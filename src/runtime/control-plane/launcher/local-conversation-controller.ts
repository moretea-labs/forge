import { spawn } from 'child_process';
import { mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
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
const LOCAL_CONVERSATION_ID = /^[A-Za-z0-9._:-]{1,160}$/;

export interface LocalConversationProviderStatus {
  provider: 'codex';
  status: 'ready' | 'not_configured' | 'unavailable';
  label: string;
  detail: string;
  streaming: boolean;
  tools: boolean;
}

export interface LocalConversationSendInput {
  controllerHome: string;
  conversationId: string;
  providerSessionId?: string;
  prompt: string;
  repoId?: string;
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

export function readLocalConversationProviderStatus(cwd: string = process.cwd()): LocalConversationProviderStatus {
  try {
    resolveLauncherExecutable({ controllerType: 'codex', cwd });
    return {
      provider: 'codex',
      status: 'ready',
      label: 'Codex 已连接',
      detail: '使用 Codex CLI 的现有登录；Forge 操作通过当前 Runtime MCP capability 执行。',
      streaming: false,
      tools: true,
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
    };
  }
}

function runCodexConversation(
  executable: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
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
    child.stdout?.on('data', (chunk) => { stdout = append(stdout, chunk, 'stdout'); });
    child.stderr?.on('data', (chunk) => { stderr = append(stderr, chunk, 'stderr'); });
    child.once('error', (error) => fail(new Error(`LOCAL_CONVERSATION_PROVIDER_START_FAILED: ${error.message}`)));
    child.once('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
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

export async function sendLocalConversation(input: LocalConversationSendInput): Promise<LocalConversationSendResult> {
  const conversationId = input.conversationId.trim();
  const prompt = input.prompt.trim();
  const providerSessionId = input.providerSessionId?.trim();
  const repoId = input.repoId?.trim();
  if (!LOCAL_CONVERSATION_ID.test(conversationId)) throw new Error('LOCAL_CONVERSATION_ID_INVALID');
  if (!prompt || prompt.length > LOCAL_CONVERSATION_MAX_PROMPT_CHARS) throw new Error('LOCAL_CONVERSATION_PROMPT_INVALID');
  if (providerSessionId && !LOCAL_CONVERSATION_ID.test(providerSessionId)) throw new Error('LOCAL_CONVERSATION_PROVIDER_SESSION_INVALID');
  if (repoId && repoId.length > 256) throw new Error('LOCAL_CONVERSATION_REPOSITORY_INVALID');

  const cwd = localConversationCwd();
  const executable = resolveLauncherExecutable({ controllerType: 'codex', cwd });
  const bootstrap = resolveProviderMcpBootstrap(input.controllerHome, 'codex', `local-${conversationId}`);
  const invocation = buildCodexControllerInvocation({
    executable,
    prompt: conversationPrompt(prompt, repoId),
    mcpBootstrap: bootstrap,
    sandbox: 'read-only',
    resumeSessionId: providerSessionId,
    json: true,
  });
  const completed = await runCodexConversation(
    invocation.executable,
    invocation.args,
    launcherProcessEnvironment(bootstrap.env),
    cwd,
    boundedTimeout(input.timeoutMs),
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
