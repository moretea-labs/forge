import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';

// Local direct adapter: it imports the protocol-neutral canonical dispatchers.
// Neither MCP HTTP nor the MCP adapter is involved in the built-in local Agent
// Harness path; every transport shares the same tool authority below it.
const tools = Object.freeze({
  read_file: { name: 'read_repository_file', effect: false },
  search_code: { name: 'execute_command', effect: false },
  git_status: { name: 'repository_git_status', effect: false },
  git_diff: { name: 'repository_git_diff', effect: false },
  process_status: { name: 'process_get', effect: false },
  process_cancel: { name: 'process_cancel', effect: true },
  patch_plan: { name: 'repository_safe_patch_plan', effect: false },
  apply_patch: { name: 'repository_safe_patch_apply', effect: true },
  run_command: { name: 'execute_command', effect: true },
  git_commit: { name: 'repository_git_commit', effect: true },
  recall_knowledge: { name: 'cognition_recall', effect: false },
  record_learning: { name: 'cognition_learning_record', effect: true },
  memory_feedback: { name: 'cognition_learning_feedback', effect: true },
});

function requireId(value, label) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9._:-]{1,256}$/.test(value)) {
    throw Error('LOCAL_FORGE_' + label + '_INVALID');
  }
  return value;
}

async function execute(raw) {
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
    process_status: ['process_id','wait_ms'],
    process_cancel: ['process_id'],
    patch_plan: ['operations','chunk_size'],
    apply_patch: ['operations','purpose','allowed_paths','request_id'],
    run_command: ['command','timeout_ms','max_output_bytes','interactive_wait_ms','request_id'],
    git_commit: ['message','paths','request_id'],
    recall_knowledge: ['query'],
    record_learning: ['signals','request_id'],
    memory_feedback: ['feedback','request_id'],
  };
  if (Object.keys(args).some((key) => !keys[input.tool]?.includes(key))) {
    throw Error('LOCAL_FORGE_TOOL_ARGUMENTS_FORBIDDEN');
  }

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
        || (args.timeout_ms !== undefined && (!Number.isSafeInteger(args.timeout_ms) || args.timeout_ms < 1000 || args.timeout_ms > 600000))
        || (args.max_output_bytes !== undefined && (!Number.isSafeInteger(args.max_output_bytes) || args.max_output_bytes < 1000 || args.max_output_bytes > 12000))) {
      throw Error('LOCAL_FORGE_COMMAND_INVALID');
    }
  }

  if (input.tool === 'process_status' || input.tool === 'process_cancel') {
    const processId = requireId(args.process_id, 'PROCESS');
    if (!processId.startsWith('proc_')) throw Error('LOCAL_FORGE_PROCESS_INVALID');
    const waitMs = input.tool === 'process_status' ? args.wait_ms : undefined;
    if (waitMs !== undefined && (!Number.isSafeInteger(waitMs) || waitMs < 1 || waitMs > 15000)) {
      throw Error('LOCAL_FORGE_PROCESS_WAIT_INVALID');
    }
    if (!checkoutId) throw Error('LOCAL_FORGE_PROCESS_CHECKOUT_REQUIRED');
    const runtimeEntry = join(sourceRoot, 'src/runtime/execution/process-runtime/runtime.ts');
    const { getManagedProcessExecutionBinding } = await import(pathToFileURL(runtimeEntry).href);
    const binding = getManagedProcessExecutionBinding(controllerHome, repoId, processId);
    if (!binding) throw Error('LOCAL_FORGE_PROCESS_NOT_MANAGED');
    if (binding.checkoutId !== checkoutId) throw Error('LOCAL_FORGE_PROCESS_CHECKOUT_MISMATCH');
    const entry = join(sourceRoot, 'src/runtime/execution/process-runtime/tool-dispatch.ts');
    const { callProcessTool } = await import(pathToFileURL(entry).href);
    const processToolName = input.tool === 'process_cancel'
      ? 'process_cancel'
      : waitMs === undefined ? 'process_get' : 'process_wait';
    const processToolArgs = {
      repo_id: repoId,
      process_id: processId,
      ...(processToolName === 'process_wait' ? { timeout_ms: waitMs } : {}),
    };
    const toolResult = await callProcessTool({
      controllerHome,
      repo: sourceRoot,
      principalId: 'forge-desktop-local-harness',
      sessionId: 'desktop-agent:' + conversationId,
    }, processToolName, processToolArgs);
    if (!toolResult) throw Error('LOCAL_FORGE_PROCESS_TOOL_NOT_SUPPORTED');
    const value = toolResult.structuredContent ?? {
      content: toolResult.content?.filter((part) => part.type === 'text').map((part) => part.text).join('\\n') ?? '',
    };
    if (toolResult.isError) throw Error(value.error?.message ?? 'LOCAL_FORGE_PROCESS_FAILED');
    const handle = value.process;
    if (!handle || typeof handle !== 'object') throw Error('LOCAL_FORGE_PROCESS_NOT_FOUND');
    return { ok: true, result: {
      processId: handle.processId,
      status: handle.status,
      completed: handle.completed === true,
      observationInterrupted: handle.observationInterrupted === true,
      ok: handle.ok ?? null,
      exitCode: handle.exitCode ?? null,
      timedOut: handle.timedOut ?? false,
      cancelled: input.tool === 'process_cancel' ? value.cancelled === true : handle.cancelled ?? false,
      stdoutTail: String(handle.stdoutTail ?? '').slice(-2000),
      stderrTail: String(handle.stderrTail ?? '').slice(-2000),
    }};
  }

  if (input.tool === 'recall_knowledge') {
    if (typeof args.query !== 'string' || !args.query.trim() || args.query.length > 160) {
      throw Error('LOCAL_FORGE_RECALL_QUERY_INVALID');
    }
    const registryEntry = join(sourceRoot, 'src/cli/repositories/registry.ts');
    const { getRepository } = await import(pathToFileURL(registryEntry).href);
    const repository = getRepository(repoId, controllerHome);
    const scopeEntry = join(sourceRoot, 'src/runtime/context/direct-controller-learning.ts');
    const { directLearningScopes } = await import(pathToFileURL(scopeEntry).href);
    const scopes = directLearningScopes(controllerHome, {
      repoId, activeCheckoutId: checkoutId ?? repository.activeCheckoutId,
    });
    const attentionEntry = join(sourceRoot, 'src/runtime/context/cognitive-attention.ts');
    const { resolveCognitiveAttention, cognitiveUsageFeedbackForContext } =
      await import(pathToFileURL(attentionEntry).href);
    const usage = cognitiveUsageFeedbackForContext({ controllerHome, repoId, scopes });
    const pack = resolveCognitiveAttention({
      controllerHome, scopes, query: args.query, now: new Date().toISOString(),
      maxItems: 4, maxBytes: 8 * 1024, usageFeedback: usage,
    });
    const keyEntry = join(sourceRoot, 'packages/kernel/cognition/api/index.ts');
    const { memoryAddressKey } = await import(pathToFileURL(keyEntry).href);
    const feedback = new Map(usage.map(item => [memoryAddressKey(item.address), item]));
    return { ok: true, result: {
      advisoryOnly: true,
      items: pack.items.map(item => {
        const memoryId = memoryAddressKey({ scope: item.memory.scope, id: item.memory.id });
        return {
          memoryId, text: item.memory.canonicalText,
          recordedAt: item.memory.provenance.recordedAt,
          recentUsage: feedback.get(memoryId),
        };
      }),
      gaps: pack.gaps,
    }};
  }

  if (input.tool === 'record_learning' || input.tool === 'memory_feedback') {
    const registryEntry = join(sourceRoot, 'src/cli/repositories/registry.ts');
    const { getRepository } = await import(pathToFileURL(registryEntry).href);
    const repository = getRepository(repoId, controllerHome);
    if (!repository.checkouts.some(checkout => checkout.checkoutId === checkoutId)) {
      throw Error('LOCAL_FORGE_LEARNING_CHECKOUT_MISMATCH');
    }
    const learningEntry = join(sourceRoot, 'src/runtime/context/direct-controller-learning.ts');
    if (input.tool === 'memory_feedback') {
      if (!Array.isArray(args.feedback) || args.feedback.length < 1 || args.feedback.length > 8) {
        throw Error('LOCAL_FORGE_LEARNING_FEEDBACK_INVALID');
      }
      const feedback = args.feedback.map(item => ({
        memoryAddress: item.memory_address,
        decision: item.decision,
        reason: item.reason,
        ...(item.rejection_kind ? { rejectionKind: item.rejection_kind } : {}),
      }));
      const { recordDirectControllerLearningFeedback } = await import(pathToFileURL(learningEntry).href);
      const recorded = recordDirectControllerLearningFeedback({
        controllerHome,
        repository: { repoId, activeCheckoutId: checkoutId },
        feedback,
        principalId: 'forge-desktop-local-harness',
        sessionId: 'desktop-agent:' + conversationId,
      });
      return { ok: true, result: { recorded: true, observationIds: recorded.observationIds } };
    }
    const parserEntry = join(sourceRoot, 'src/runtime/context/automatic-learning.ts');
    const { parseControllerLearningSignalDrafts } = await import(pathToFileURL(parserEntry).href);
    const drafts = parseControllerLearningSignalDrafts(args.signals);
    if (!drafts.length) throw Error('LOCAL_FORGE_LEARNING_EMPTY');
    const { persistDirectControllerLearning } = await import(pathToFileURL(learningEntry).href);
    const stored = persistDirectControllerLearning({
      controllerHome,
      repository: { repoId, activeCheckoutId: checkoutId },
      signals: drafts,
      principalId: 'forge-desktop-local-harness',
      sessionId: 'desktop-agent:' + conversationId,
      controllerType: 'desktop-native',
    });
    return { ok: true, result: {
      recorded: true, storedMemoryIds: stored.storedMemoryIds,
      associatedEdgeCount: stored.associatedEdgeCount,
    }};
  }

  const entry = join(sourceRoot, 'src/runtime/control-plane/facade/repository-tool-dispatch.ts');
  const { callRepositoryTool } = await import(pathToFileURL(entry).href);
  const toolArgs = input.tool === 'search_code'
    ? { command: ['rg', '-n', '-F', '--no-heading', '--max-count', '20', '--',
        args.query, args.path ?? '.'], timeout_ms: 12_000, max_output_bytes: 10_000 }
    : args;
  const result = await callRepositoryTool(controllerHome, tool.name, {
    ...toolArgs, repo_id: repoId, ...(checkoutId ? { checkout_id: checkoutId } : {}),
  }, {
    principalId: 'forge-desktop-local-harness',
    sessionId: 'desktop-agent:' + conversationId,
  });
  if (!result) throw Error('LOCAL_FORGE_TOOL_NOT_SUPPORTED');

  const value = result.structuredContent ?? {
    content: result.content?.filter((part) => part.type === 'text').map((part) => part.text).join('\n') ?? '',
  };
  if (input.tool === 'search_code' && value.exitCode === 1
      && value.stdout === '' && value.stderr === ''
      && value.error?.code === 'PROCESS_COMMAND_FAILED') {
    return { ok: true, result: {
      query: args.query, path: args.path ?? '.', matches: [], exitCode: 1,
    }};
  }
  return { ok: result.isError !== true, result: value };
}

async function responseFor(raw) {
  try {
    return JSON.stringify(await execute(raw));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'LOCAL_FORGE_TOOL_FAILED';
    return JSON.stringify({ ok: false, error: message.slice(0, 350) });
  }
}

if (process.argv.includes('--session')) {
  // A single Agent turn keeps this direct adapter alive and reuses the already
  // loaded canonical tool modules across tool calls.
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    process.stdout.write((await responseFor(line)) + '\n');
  }
} else {
  process.stdout.write(await responseFor(readFileSync(0, { encoding: 'utf8' })));
}
