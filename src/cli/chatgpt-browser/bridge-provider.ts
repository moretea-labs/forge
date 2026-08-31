import { randomUUID } from 'crypto';
import { spawnSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { writeChatgptBridgeExtension, CHATGPT_BRIDGE_DEFAULT_PORT } from './bridge-extension';
import { DEFAULT_CHATGPT_URL, ensureBridgeToken } from './binding';
import { openNativeBrowserPage } from './native-provider';
import type { BrowserConsultInput, BrowserSessionStatus, PromptBundle } from './types';

export interface BridgeProviderResult {
  status: BrowserSessionStatus;
  output: string;
  conversationUrl?: string;
  error?: {
    code: string;
    message: string;
    recovery?: string;
  };
}

interface ExtensionHeartbeat {
  url?: string;
  title?: string;
  composerVisible?: boolean;
  ts?: string;
  receivedAt: number;
}

interface ExtensionTask {
  id: string;
  kind: 'consult';
  prompt: string;
  timeoutMs: number;
  targetUrl?: string;
  dispatchOnly?: boolean;
}

interface ExtensionDispatchReceipt {
  taskId: string;
  conversationUrl?: string;
}

interface ExtensionResult {
  taskId: string;
  status: BrowserSessionStatus;
  output: string;
  conversationUrl?: string;
  error?: BridgeProviderResult['error'];
}

function corsHeaders(): HeadersInit {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type,accept,x-forge-bridge-token',
    'access-control-allow-private-network': 'true',
    'cache-control': 'no-store',
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      ...corsHeaders(),
      'content-type': 'application/json; charset=utf-8',
    },
  });
}

async function readJson(request: Request): Promise<any> {
  try {
    return await request.json();
  } catch (_error) {
    return {};
  }
}

async function sleep(ms: number): Promise<void> {
  await Bun.sleep(ms);
}

function validStatus(value: unknown): BrowserSessionStatus {
  if (value === 'completed' || value === 'incomplete_capture' || value === 'failed') return value;
  return 'failed';
}

// Status chrome that ChatGPT renders mid-stream and that the DOM-scrape fallback
// can mistake for a final answer. Used by the server-side backstop only.
const STATUS_ONLY_OUTPUTS = new Set(['pro thinking', 'thinking', 'reasoning', 'searching', 'analyzing', 'retry']);

function isStatusOnlyOutput(output: string): boolean {
  return STATUS_ONLY_OUTPUTS.has(output.trim().toLowerCase());
}


function normalizeTargetPage(value: string): { path: string; conversationId?: string } | undefined {
  try {
    const url = new URL(value);
    if (!['chatgpt.com', 'www.chatgpt.com', 'chat.openai.com'].includes(url.hostname)) return undefined;
    const parts = url.pathname.split('/').filter(Boolean);
    const c = parts.lastIndexOf('c');
    const conversationId = c >= 0 ? parts[c + 1] : undefined;
    const path = `/${parts.join('/')}`.replace(/\/$/, '') || '/';
    return { path, conversationId };
  } catch {
    return undefined;
  }
}

export function chatgptBridgeTargetMatchesPage(targetUrl: string | undefined, pageUrl: string | undefined): boolean {
  if (!targetUrl) return true;
  if (!pageUrl) return false;
  const target = normalizeTargetPage(targetUrl);
  const page = normalizeTargetPage(pageUrl);
  if (!target || !page) return false;
  if (target.conversationId) return page.conversationId === target.conversationId;
  return page.path === target.path;
}

function bridgePort(): number {
  const raw = process.env.FORGE_CHATGPT_BRIDGE_PORT;
  if (!raw) return CHATGPT_BRIDGE_DEFAULT_PORT;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535 ? parsed : CHATGPT_BRIDGE_DEFAULT_PORT;
}

const WSL_WINDOWS_CHROME_EXECUTABLES = [
  '/mnt/c/Program Files/Google/Chrome/Application/chrome.exe',
  '/mnt/c/Program Files (x86)/Google/Chrome/Application/chrome.exe',
] as const;

interface WslWindowsBridgeLaunchOptions {
  platform?: NodeJS.Platform;
  wslDistroName?: string;
  osRelease?: string;
  chromeExecutables?: readonly string[];
  fileExists?: typeof existsSync;
  launch?: typeof spawnSync;
}

export function isWslWindowsRuntime(
  platform: NodeJS.Platform = process.platform,
  wslDistroName?: string,
  osRelease?: string,
): boolean {
  if (platform !== 'linux') return false;
  const observedDistroName = wslDistroName ?? (osRelease === undefined ? process.env.WSL_DISTRO_NAME : undefined);
  if (observedDistroName?.trim()) return true;
  let observedRelease = osRelease;
  if (observedRelease === undefined) {
    try { observedRelease = readFileSync('/proc/sys/kernel/osrelease', 'utf8'); } catch { observedRelease = ''; }
  }
  return /microsoft|wsl/i.test(observedRelease);
}

export function openWslWindowsBridgeTarget(
  targetUrl: string,
  options: WslWindowsBridgeLaunchOptions = {},
): void {
  if (!isWslWindowsRuntime(options.platform, options.wslDistroName, options.osRelease)) return;
  const parsed = new URL(targetUrl);
  if (parsed.protocol !== 'https:' || !['chatgpt.com', 'www.chatgpt.com', 'chat.openai.com'].includes(parsed.hostname)) {
    throw new Error(`CHATGPT_BRIDGE_TARGET_INVALID: ${targetUrl}`);
  }
  const fileExists = options.fileExists ?? existsSync;
  const chrome = (options.chromeExecutables ?? WSL_WINDOWS_CHROME_EXECUTABLES).find((candidate) => fileExists(candidate));
  if (!chrome) {
    throw new Error('CHATGPT_BRIDGE_CHROME_UNAVAILABLE: install Google Chrome for Windows before using the WSL ChatGPT bridge');
  }
  const launch = options.launch ?? spawnSync;
  const launched = launch(chrome, ['--new-tab', parsed.toString()], {
    windowsHide: true,
    stdio: 'ignore',
    timeout: 10_000,
  });
  if (launched.error) throw launched.error;
  if (launched.status !== 0) throw new Error(`CHATGPT_BRIDGE_CHROME_OPEN_FAILED:${launched.status ?? 'unknown'}`);
}

export async function runBridgeProvider(input: BrowserConsultInput, bundle: PromptBundle): Promise<BridgeProviderResult> {
  if (input.model || input.thinking) {
    return {
      status: 'failed',
      output: 'ChatGPT bridge provider uses the current web UI model and thinking settings; --model and --thinking are not supported yet.',
      error: {
        code: 'BRIDGE_MODEL_SELECTION_UNSUPPORTED',
        message: 'bridge provider cannot select model or thinking level',
        recovery: 'Omit --model/--thinking for bridge runs, or use the Oracle provider when model selection is required.',
      },
    };
  }

  const timeoutMs = input.timeoutMs ?? 180_000;
  const host = '127.0.0.1';
  const port = bridgePort();
  const bridgeUrl = `http://${host}:${port}`;
  // Stable controller/repository binding token; bridge-only bindings are created lazily.
  const token = ensureBridgeToken(input.repoRoot);
  const extension = writeChatgptBridgeExtension(input.repoRoot, bridgeUrl, token);
  const task: ExtensionTask = {
    id: randomUUID(),
    kind: 'consult',
    prompt: bundle.rendered,
    timeoutMs,
    targetUrl: input.chatgptUrl,
    dispatchOnly: input.dispatchOnly === true,
  };
  const state: {
    heartbeat?: ExtensionHeartbeat;
    claimed: boolean;
    started: boolean;
    dispatched?: ExtensionDispatchReceipt;
    result?: ExtensionResult;
  } = {
    claimed: false,
    started: false,
  };

  let server: ReturnType<typeof Bun.serve> | undefined;
  try {
    server = Bun.serve({
      hostname: host,
      port,
      async fetch(request) {
        if (request.method === 'OPTIONS') {
          return new Response(null, { status: 204, headers: corsHeaders() });
        }
        // Capability-token gate: only the extension we generated knows the token,
        // so any other local process/page is rejected before it can read the
        // queued prompt or submit a forged result.
        if (request.headers.get('x-forge-bridge-token') !== token) {
          return jsonResponse({ error: { code: 'CHATGPT_BRIDGE_UNAUTHORIZED', message: 'missing or invalid bridge token' } }, 401);
        }
        const url = new URL(request.url);
        if (request.method === 'POST' && url.pathname === '/api/extension/heartbeat') {
          const body = await readJson(request);
          state.heartbeat = {
            url: typeof body.url === 'string' ? body.url : undefined,
            title: typeof body.title === 'string' ? body.title : undefined,
            composerVisible: body.composerVisible === true,
            ts: typeof body.ts === 'string' ? body.ts : undefined,
            receivedAt: Date.now(),
          };
          if (body.lastDispatch && typeof body.lastDispatch === 'object' && body.lastDispatch.taskId === task.id) {
            state.dispatched = {
              taskId: task.id,
              conversationUrl: typeof body.lastDispatch.conversationUrl === 'string' ? body.lastDispatch.conversationUrl : undefined,
            };
          }
          return jsonResponse({ ok: true });
        }
        if (request.method === 'GET' && url.pathname === '/api/extension/task') {
          if (state.result || state.claimed) return jsonResponse({ kind: 'idle' });
          const pageUrl = url.searchParams.get('pageUrl') ?? undefined;
          if (!chatgptBridgeTargetMatchesPage(task.targetUrl, pageUrl)) return jsonResponse({ kind: 'idle' });
          state.claimed = true;
          return jsonResponse(task);
        }
        if (request.method === 'POST' && url.pathname === '/api/extension/task-started') {
          const body = await readJson(request);
          if (body.taskId === task.id) state.started = true;
          return jsonResponse({ ok: true });
        }
        if (request.method === 'POST' && url.pathname === '/api/extension/dispatched') {
          const body = await readJson(request);
          if (body.taskId === task.id) {
            state.dispatched = {
              taskId: task.id,
              conversationUrl: typeof body.conversationUrl === 'string' ? body.conversationUrl : undefined,
            };
          }
          return jsonResponse({ ok: true });
        }
        if (request.method === 'POST' && url.pathname === '/api/extension/result') {
          const body = await readJson(request);
          if (body.taskId === task.id) {
            const status = validStatus(body.status);
            const output = typeof body.output === 'string' ? body.output : '';
            // Server-side backstop: a `completed` with an empty or status-only
            // body can never be a real answer (the "Pro thinking"/"" capture bug).
            // Coerce it to a failure so it can never persist as success.
            if (status === 'completed' && (output.trim().length === 0 || isStatusOnlyOutput(output))) {
              state.result = {
                taskId: task.id,
                status: 'failed',
                output: output.trim().length === 0 ? 'ChatGPT bridge captured no final assistant message.' : output,
                conversationUrl: typeof body.conversationUrl === 'string' ? body.conversationUrl : undefined,
                error: {
                  code: 'CHATGPT_BRIDGE_NO_FINAL_MESSAGE',
                  message: 'bridge reported completion without a final assistant message',
                  recovery: 'Keep the ChatGPT tab active until the response finishes, then retry; the DOM-scrape fallback cannot confirm completion.',
                },
              };
            } else {
              state.result = {
                taskId: task.id,
                status,
                output,
                conversationUrl: typeof body.conversationUrl === 'string' ? body.conversationUrl : undefined,
                error: body.error && typeof body.error === 'object' ? {
                  code: typeof body.error.code === 'string' ? body.error.code : 'CHATGPT_BRIDGE_TASK_FAILED',
                  message: typeof body.error.message === 'string' ? body.error.message : 'ChatGPT bridge task failed',
                  recovery: typeof body.error.recovery === 'string' ? body.error.recovery : undefined,
                } : undefined,
              };
            }
          }
          return jsonResponse({ ok: true });
        }
        return jsonResponse({ error: { code: 'NOT_FOUND', message: 'not found' } }, 404);
      },
    });
  } catch (error) {
    return {
      status: 'failed',
      output: error instanceof Error ? error.message : String(error),
      error: {
        code: 'CHATGPT_BRIDGE_PORT_UNAVAILABLE',
        message: `ChatGPT bridge could not listen on ${bridgeUrl}`,
        recovery: `Stop any other forge ChatGPT bridge using ${bridgeUrl}, then retry.`,
      },
    };
  }

  try {
    if (input.profileDir) {
      openNativeBrowserPage(input.browserChannel ?? 'chrome', input.profileDir, input.chatgptUrl ?? DEFAULT_CHATGPT_URL, input.profileDirectory);
    } else {
      openWslWindowsBridgeTarget(input.chatgptUrl ?? DEFAULT_CHATGPT_URL);
    }

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (input.dispatchOnly === true && state.dispatched) {
        return {
          status: 'completed',
          output: 'ChatGPT bridge prompt dispatch confirmed.',
          conversationUrl: state.dispatched.conversationUrl ?? state.heartbeat?.url,
        };
      }
      if (state.result) {
        return {
          status: state.result.status,
          output: state.result.output,
          conversationUrl: state.result.conversationUrl,
          error: state.result.error,
        };
      }
      await sleep(500);
    }

    const heartbeatFresh = state.heartbeat && Date.now() - state.heartbeat.receivedAt < 15_000;
    if (!heartbeatFresh) {
      return {
        status: 'failed',
        output: [
          'ChatGPT bridge extension is not connected.',
          `Extension directory: ${extension.extensionDir}`,
          `Bridge URL: ${bridgeUrl}`,
        ].join('\n'),
        error: {
          code: 'CHATGPT_BRIDGE_EXTENSION_NOT_CONNECTED',
          message: 'ChatGPT bridge extension did not connect before timeout',
          recovery: `Load the unpacked extension from ${extension.extensionDir} in the selected Chrome profile, open ChatGPT, verify the composer is visible, then retry.`,
        },
      };
    }

    return {
      status: 'failed',
      output: [
        'ChatGPT bridge extension connected, but no result was returned before timeout.',
        `Last extension URL: ${state.heartbeat?.url ?? 'unknown'}`,
        `Composer visible: ${state.heartbeat?.composerVisible === true ? 'yes' : 'no'}`,
      ].join('\n'),
      error: {
        code: input.dispatchOnly === true && state.started
          ? 'CHATGPT_BRIDGE_MUTATION_OUTCOME_UNKNOWN'
          : state.started
            ? 'CHATGPT_BRIDGE_RESULT_TIMEOUT'
            : 'CHATGPT_BRIDGE_TASK_NOT_CLAIMED',
        message: input.dispatchOnly === true && state.started
          ? 'ChatGPT bridge started the dispatch task but did not prove the submission postcondition before timeout'
          : state.started
            ? 'ChatGPT bridge task did not finish before timeout'
            : 'ChatGPT bridge extension did not claim the task before timeout',
        recovery: input.dispatchOnly === true && state.started
          ? 'Do not replay blindly; inspect the target ChatGPT conversation before retrying.'
          : 'Keep the ChatGPT tab active with the composer visible, then retry with a longer --timeout-ms.',
      },
    };
  } finally {
    server.stop(true);
  }
}
