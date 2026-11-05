import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// One-shot direct local adapter: no MCP HTTP, no separate Forge state owner.
const tools = Object.freeze({
  read_file: { name: 'read_repository_file', effect: false },
  git_status: { name: 'repository_git_status', effect: false },
  git_diff: { name: 'repository_git_diff', effect: false },
  patch_plan: { name: 'repository_safe_patch_plan', effect: false },
  apply_patch: { name: 'repository_safe_patch_apply', effect: true },
  run_command: { name: 'execute_command', effect: true },
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
    git_status: ['refresh'],
    git_diff: ['paths','staged','max_bytes'],
    patch_plan: ['operations','chunk_size'],
    apply_patch: ['operations','purpose','allowed_paths','request_id'],
    run_command: ['command','timeout_ms','max_output_bytes','request_id'],
  };
  if (Object.keys(args).some((key) => !keys[input.tool]?.includes(key))) {
    throw Error('LOCAL_FORGE_TOOL_ARGUMENTS_FORBIDDEN');
  }
  if (tool.effect && input.allowEffects !== true) throw Error('LOCAL_FORGE_TOOL_REQUIRES_USER_APPROVAL');
  if (input.tool === 'run_command') {
    if (!Array.isArray(args.command) || args.command.length === 0 || args.command.length > 24
        || args.command.some((part) => typeof part !== 'string' || part.length > 2048)
        || (args.timeout_ms !== undefined && (!Number.isSafeInteger(args.timeout_ms) || args.timeout_ms < 1000 || args.timeout_ms > 60000))
        || (args.max_output_bytes !== undefined && (!Number.isSafeInteger(args.max_output_bytes) || args.max_output_bytes < 1000 || args.max_output_bytes > 12000))) {
      throw Error('LOCAL_FORGE_COMMAND_INVALID');
    }
  }
  const entry = join(sourceRoot, 'adapters/mcp/tool-mapping/repository-tools.ts');
  const { callRepositoryTool } = await import(pathToFileURL(entry).href);
  // Call the existing canonical Repository tool owner directly in this process.
  // Nothing is sent to MCP HTTP and there is no second filesystem writer.
  const result = await callRepositoryTool(controllerHome, tool.name, {
    ...args, repo_id: repoId, ...(checkoutId ? { checkout_id: checkoutId } : {}),
  }, {
    principalId: 'forge-desktop-local-api',
    sessionId: 'desktop-api:' + conversationId,
  });
  if (!result) throw Error('LOCAL_FORGE_TOOL_NOT_SUPPORTED');
  const value = result.structuredContent ?? {
    content: result.content?.filter((part) => part.type === 'text').map((part) => part.text).join('\n') ?? '',
  };
  process.stdout.write(JSON.stringify({ ok: result.isError !== true, result: value }));
}
try {
  await run();
} catch (error) {
  const message = error instanceof Error ? error.message : 'LOCAL_FORGE_TOOL_FAILED';
  process.stdout.write(JSON.stringify({ ok: false, error: message.slice(0, 350) }));
}
