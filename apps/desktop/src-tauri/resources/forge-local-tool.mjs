import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// One-shot direct local adapter: no MCP HTTP, no separate Forge state owner.
const tools = Object.freeze({
  read_file: { name: 'read_repository_file', effect: false },
  search_code: { name: 'execute_command', effect: false },
  git_status: { name: 'repository_git_status', effect: false },
  git_diff: { name: 'repository_git_diff', effect: false },
  process_status: { name: 'process_get', effect: false },
  patch_plan: { name: 'repository_safe_patch_plan', effect: false },
  apply_patch: { name: 'repository_safe_patch_apply', effect: true },
  run_command: { name: 'execute_command', effect: true },
  git_commit: { name: 'repository_git_commit', effect: true },
});
function requireId(value, label) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9._:-]{1,256}$/.test(value)) {
    throw Error('LOCAL_FORGE_' + label + '_INVALID');
  }
  return value;
}
async function run() {
  const raw = readFileSync(0, { encoding: 'utf8' });
  if (Buffer.byteLength(raw) > 96 * 1024) throw Error('LOCAL_FORGE_INPUT_TOO_LARGE');
  const input = JSON.parse(raw);
  if (!Object.hasOwn(tools, input.tool)) throw Error('LOCAL_FORGE_TOOL_NOT_ALLOWED');
  const tool = tools[input.tool];
  if (tool.effect && input.allowEffects !== true) throw Error('LOCAL_FORGE_TOOL_REQUIRES_USER_APPROVAL');
  const repoId = requireId(input.repoId, 'REPOSITORY');
  const checkoutId = input.checkoutId == null ? undefined : requireId(input.checkoutId, 'CHECKOUT');
  if (tool.effect && !checkoutId) throw Error('LOCAL_FORGE_EFFECT_CHECKOUT_REQUIRED');
  const conversationId = requireId(input.conversationId, 'CONVERSATION');
  const controllerHome = resolve(String(input.controllerHome ?? ''));
  const sourceRoot = resolve(String(input.sourceRoot ?? ''));
  if (!sourceRoot.startsWith('/') || !controllerHome.startsWith('/')) throw Error('LOCAL_FORGE_SOURCE_INVALID');
  const args = input.arguments;
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw Error('LOCAL_FORGE_TOOL_ARGUMENTS_INVALID');
  const keys = {
    read_file: ['path','start_line','end_line'],
    search_code: ['query','path'],
    git_status: ['refresh'],
    git_diff: ['paths','staged','max_bytes'],
    process_status: ['process_id'],
    patch_plan: ['operations','chunk_size'],
    apply_patch: ['operations','purpose','allowed_paths','request_id'],
    run_command: ['command','timeout_ms','max_output_bytes','interactive_wait_ms','request_id'],
    git_commit: ['message','paths','request_id'],
  };
  if (Object.keys(args).some((key) => !keys[input.tool]?.includes(key))) {
    throw Error('LOCAL_FORGE_TOOL_ARGUMENTS_FORBIDDEN');
  }
  if (tool.effect && input.allowEffects !== true) throw Error('LOCAL_FORGE_TOOL_REQUIRES_USER_APPROVAL');
  if (input.tool === 'git_commit') {
    if (typeof args.message !== 'string' || !args.message.trim()
        || args.message.length > 500
        || !Array.isArray(args.paths) || args.paths.length === 0 || args.paths.length > 32
        || args.paths.some((part) => typeof part !== 'string' || !part.trim()
          || part.startsWith('/') || part.split('/').includes('..') || part.includes('\\0'))) {
      throw Error('LOCAL_FORGE_GIT_COMMIT_ARGUMENTS_INVALID');
    }
  }
  if (input.tool === 'search_code') {
    if (typeof args.query !== 'string' || !args.query.trim() || args.query.length > 160
        || (args.path !== undefined && (
          typeof args.path !== 'string' || !args.path || args.path.startsWith('/')
          || args.path.split('/').includes('..') || args.path.includes('\\')
        ))) {
      throw Error('LOCAL_FORGE_SEARCH_INVALID');
    }
  }
  if (input.tool === 'run_command') {
    if (!Array.isArray(args.command) || args.command.length === 0 || args.command.length > 24
        || args.command.some((part) => typeof part !== 'string' || part.length > 2048)
        || (args.timeout_ms !== undefined && (!Number.isSafeInteger(args.timeout_ms) || args.timeout_ms < 1000 || args.timeout_ms > 60000))
        || (args.max_output_bytes !== undefined && (!Number.isSafeInteger(args.max_output_bytes) || args.max_output_bytes < 1000 || args.max_output_bytes > 12000))) {
      throw Error('LOCAL_FORGE_COMMAND_INVALID');
    }
  }
  if (input.tool === 'process_status') {
    const processId = requireId(args.process_id, 'PROCESS');
    if (!processId.startsWith('proc_')) throw Error('LOCAL_FORGE_PROCESS_INVALID');
    // The canonical Process Runtime owns state and terminal receipts; this is read-only.
    const entry = join(sourceRoot, 'src/runtime/execution/process-runtime/runtime.ts');
    const { getProcessHandle } = await import(pathToFileURL(entry).href);
    const handle = getProcessHandle(controllerHome, repoId, processId);
    if (!handle) throw Error('LOCAL_FORGE_PROCESS_NOT_FOUND');
    process.stdout.write(JSON.stringify({ ok: true, result: {
      processId: handle.processId, status: handle.status, completed: handle.completed,
      ok: handle.ok ?? null, exitCode: handle.exitCode ?? null,
      timedOut: handle.timedOut ?? false,
      stdoutTail: String(handle.stdoutTail ?? '').slice(-2000),
      stderrTail: String(handle.stderrTail ?? '').slice(-2000),
    }}));
    return;
  }
  const entry = join(sourceRoot, 'adapters/mcp/tool-mapping/repository-tools.ts');
  const { callRepositoryTool } = await import(pathToFileURL(entry).href);
  // Call the existing canonical Repository tool owner directly in this process.
  // Nothing is sent to MCP HTTP and there is no second filesystem writer.
  const toolArgs = input.tool === 'search_code'
    ? { command: ['rg', '-n', '-F', '--no-heading', '--max-count', '20', '--',
        args.query, args.path ?? '.'], timeout_ms: 12_000, max_output_bytes: 10_000 }
    : args;
  const result = await callRepositoryTool(controllerHome, tool.name, {
    ...toolArgs, repo_id: repoId, ...(checkoutId ? { checkout_id: checkoutId } : {}),
  }, {
    principalId: 'forge-desktop-local-api',
    sessionId: 'desktop-api:' + conversationId,
  });
  if (!result) throw Error('LOCAL_FORGE_TOOL_NOT_SUPPORTED');
  const value = result.structuredContent ?? {
    content: result.content?.filter((part) => part.type === 'text').map((part) => part.text).join('\n') ?? '',
  };
  // ripgrep exit 1 means a successful search with zero matches, not a broken
  // tool. Preserve other failures (including permissions and exit 2) as errors.
  if (input.tool === 'search_code' && value.exitCode === 1
      && value.stdout === '' && value.stderr === ''
      && value.error?.code === 'PROCESS_COMMAND_FAILED') {
    process.stdout.write(JSON.stringify({ ok: true, result: {
      query: args.query, path: args.path ?? '.', matches: [], exitCode: 1,
    }}));
    return;
  }
  process.stdout.write(JSON.stringify({ ok: result.isError !== true, result: value }));
}
try {
  await run();
} catch (error) {
  const message = error instanceof Error ? error.message : 'LOCAL_FORGE_TOOL_FAILED';
  process.stdout.write(JSON.stringify({ ok: false, error: message.slice(0, 350) }));
}
