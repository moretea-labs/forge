import { classifyRepositoryCommand } from '../../cli/repositories/command-classifier';
import { getRepository } from '../../cli/repositories/registry';
import { readRequirement, requirementSemanticView } from '../control-plane/persistence/requirement-store';
import { listPlanContracts } from '../control-plane/facade/plan-contract-store';
import { readAutopilotRun, updateAutopilotRun } from './store';
import type { AutopilotDecision, AutopilotModelUsage, AutopilotRun } from './types';

const ALLOWED_REPOSITORY_TOOLS = new Set([
  'read_repository_file',
  'repository_git_status',
  'repository_git_diff',
  'repository_safe_patch_apply',
  'repository_git_commit',
  'execute_command',
]);
const RISK_RANK = { readonly: 0, workspace_write: 1, remote_write: 2, destructive: 3 } as const;

type DeepSeekToolCall = {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
};
type DeepSeekMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | null;
  tool_calls?: DeepSeekToolCall[];
  tool_call_id?: string;
};
type DeepSeekResponse = {
  choices?: Array<{ message?: DeepSeekMessage }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
};

export interface AutopilotToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface AutopilotRunnerDependencies {
  fetchImpl?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  apiKey?: string;
  executeTool?: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  toolDefinitions?: AutopilotToolDefinition[];
  validateAuthorization?: () => { ok: boolean; reason?: string };
}

function toolManifest(dependencies: AutopilotRunnerDependencies) {
  const definitions = dependencies.toolDefinitions;
  if (!definitions) throw new Error('AUTOPILOT_TOOL_DEFINITIONS_REQUIRED');
  const tools = definitions
    .filter((definition) => ALLOWED_REPOSITORY_TOOLS.has(definition.name))
    .map((definition) => ({
      type: 'function',
      function: {
        name: definition.name,
        description: definition.description,
        parameters: definition.inputSchema,
      },
    }));
  tools.push({
    type: 'function',
    function: {
      name: 'forge_autopilot_decision',
      description: 'Record the current autonomous-run decision. This never changes Requirement or Plan lifecycle state.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['action', 'summary'],
        properties: {
          action: { type: 'string', enum: ['continue', 'pause', 'complete', 'blocked'] },
          summary: { type: 'string', maxLength: 2000 },
          current_plan_id: { type: 'string' },
          next_objective: { type: 'string', maxLength: 1000 },
          evidence_refs: { type: 'array', maxItems: 32, items: { type: 'string', maxLength: 512 } },
        },
      },
    },
  });
  return tools;
}

function systemPrompt(run: AutopilotRun, requirement: ReturnType<typeof requirementSemanticView>, plans: ReturnType<typeof listPlanContracts>): string {
  const tree = plans
    .filter((plan) => plan.requirementId === run.requirementId)
    .map((plan) => ({
      planId: plan.planId,
      parentPlanId: plan.parentPlanId,
      goal: plan.goal,
      steps: plan.steps.map((step) => ({ id: step.id, objective: step.objective })),
    }));
  return [
    'You are Forge Autopilot, an autonomous implementation agent operating inside one explicitly authorized repository checkout.',
    'Requirement and Plan are semantic context only. Never invent or mutate their completion/progress state through repository tools.',
    'Git/Process/Repository owners remain authoritative for concrete execution facts.',
    'Use repository tools to inspect, edit, validate, and make local commits when justified.',
    'Never perform remote-write or destructive actions. Never push, publish, delete remotes, deploy, release, install, activate, rollback, or change Runtime.',
    'Prefer coherent small batches and focused validation. Do not create a second task/progress ledger.',
    'When you need a terminal/build/test command, execute_command is allowed only when Forge classifies it readonly or workspace_write.',
    'After meaningful progress or when a stop condition is reached, call forge_autopilot_decision.',
    'action=complete means this autonomous run believes the authorized implementation slice is complete; it does NOT complete the Requirement.',
    JSON.stringify({
      repository: { repoId: run.repoId, checkoutId: run.checkoutId },
      requirement,
      planTree: tree,
      checkpointPlanIds: run.policy.checkpointPlanIds,
      budgets: {
        maxTotalTokens: run.policy.maxTotalTokens,
        maxTurns: run.policy.maxTurns,
        maxToolCalls: run.policy.maxToolCalls,
      },
    }),
  ].join('\n\n');
}

function usageOf(response: DeepSeekResponse): AutopilotModelUsage {
  return {
    promptTokens: Math.max(0, Math.trunc(response.usage?.prompt_tokens ?? 0)),
    completionTokens: Math.max(0, Math.trunc(response.usage?.completion_tokens ?? 0)),
    totalTokens: Math.max(0, Math.trunc(response.usage?.total_tokens ?? 0)),
  };
}

function decisionFrom(args: Record<string, unknown>): AutopilotDecision {
  const action = String(args.action ?? '').trim();
  if (!['continue', 'pause', 'complete', 'blocked'].includes(action)) {
    throw new Error('AUTOPILOT_DECISION_ACTION_INVALID');
  }
  const summary = String(args.summary ?? '').trim().slice(0, 2_000);
  if (!summary) throw new Error('AUTOPILOT_DECISION_SUMMARY_REQUIRED');
  return {
    action: action as AutopilotDecision['action'],
    summary,
    ...(typeof args.current_plan_id === 'string' && args.current_plan_id.trim()
      ? { currentPlanId: args.current_plan_id.trim().slice(0, 160) } : {}),
    ...(typeof args.next_objective === 'string' && args.next_objective.trim()
      ? { nextObjective: args.next_objective.trim().slice(0, 1_000) } : {}),
    evidenceRefs: Array.isArray(args.evidence_refs)
      ? args.evidence_refs.map(String).map((value) => value.trim()).filter(Boolean).slice(0, 32)
      : [],
  };
}

function responsesToolManifest(dependencies: AutopilotRunnerDependencies) {
  return toolManifest(dependencies).map((tool) => ({
    type: 'function',
    name: tool.function.name,
    description: tool.function.description,
    parameters: tool.function.parameters,
  }));
}

function responsesInput(messages: DeepSeekMessage[]): { instructions?: string; input: Array<Record<string, unknown>> } {
  const instructions = messages
    .filter((message) => message.role === 'system' && message.content)
    .map((message) => message.content as string)
    .join('\n\n');
  const input: Array<Record<string, unknown>> = [];
  for (const message of messages) {
    if (message.role === 'system') continue;
    if ((message.role === 'user' || message.role === 'assistant') && message.content?.trim()) {
      input.push({ role: message.role, content: message.content });
    }
    if (message.role === 'assistant') {
      for (const call of message.tool_calls ?? []) {
        input.push({
          type: 'function_call',
          call_id: call.id,
          name: call.function.name,
          arguments: call.function.arguments,
        });
      }
    } else if (message.role === 'tool') {
      input.push({
        type: 'function_call_output',
        call_id: message.tool_call_id ?? '',
        output: message.content ?? '',
      });
    }
  }
  return { ...(instructions ? { instructions } : {}), input };
}

function normalizeResponsesResponse(value: unknown): DeepSeekResponse {
  if (!value || typeof value !== 'object') throw new Error('AUTOPILOT_MODEL_RESPONSE_INVALID');
  const response = value as Record<string, unknown>;
  const output = Array.isArray(response.output) ? response.output : [];
  const text: string[] = [];
  const toolCalls: DeepSeekToolCall[] = [];
  for (const raw of output) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Record<string, unknown>;
    if (item.type === 'message' && Array.isArray(item.content)) {
      for (const rawBlock of item.content) {
        if (!rawBlock || typeof rawBlock !== 'object') continue;
        const block = rawBlock as Record<string, unknown>;
        if (block.type === 'output_text' && typeof block.text === 'string' && block.text.trim()) {
          text.push(block.text);
        }
      }
    } else if (item.type === 'function_call') {
      const id = typeof item.call_id === 'string'
        ? item.call_id
        : typeof item.id === 'string'
          ? item.id
          : '';
      const name = typeof item.name === 'string' ? item.name : '';
      const args = typeof item.arguments === 'string' ? item.arguments : '{}';
      if (id && name) {
        toolCalls.push({ id, type: 'function', function: { name, arguments: args } });
      }
    }
  }
  const usage = response.usage && typeof response.usage === 'object'
    ? response.usage as Record<string, unknown>
    : {};
  return {
    choices: [{
      message: {
        role: 'assistant',
        content: text.length > 0 ? text.join('\n') : null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      },
    }],
    usage: {
      prompt_tokens: typeof usage.input_tokens === 'number' ? usage.input_tokens : 0,
      completion_tokens: typeof usage.output_tokens === 'number' ? usage.output_tokens : 0,
      total_tokens: typeof usage.total_tokens === 'number' ? usage.total_tokens : 0,
    },
  };
}

async function requestDeepSeek(
  run: AutopilotRun,
  messages: DeepSeekMessage[],
  signal: AbortSignal,
  dependencies: AutopilotRunnerDependencies,
): Promise<DeepSeekResponse> {
  const apiKey = dependencies.apiKey ?? process.env.FORGE_DEEPSEEK_API_KEY ?? process.env.DEEPSEEK_API_KEY;
  if (!apiKey?.trim()) throw new Error('AUTOPILOT_DEEPSEEK_API_KEY_MISSING');
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const requestController = new AbortController();
  const forwardAbort = () => requestController.abort();
  signal.addEventListener('abort', forwardAbort, { once: true });
  const timeout = setTimeout(() => requestController.abort(), 90_000);
  const remaining = Math.max(1, run.policy.maxTotalTokens - run.usage.totalTokens);
  try {
    const endpoint = run.policy.endpoint.replace(/\/$/, '');
    const responses = run.policy.protocol === 'responses';
    const responseInput = responsesInput(messages);
    const response = await fetchImpl(`${endpoint}/${responses ? 'responses' : 'chat/completions'}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(responses ? {
        model: run.policy.model,
        ...responseInput,
        tools: responsesToolManifest(dependencies),
        tool_choice: 'auto',
        max_output_tokens: Math.min(65_536, remaining),
      } : {
        model: run.policy.model,
        messages,
        tools: toolManifest(dependencies),
        tool_choice: 'auto',
        temperature: 0.1,
        max_tokens: Math.min(8_192, remaining),
      }),
      signal: requestController.signal,
    });
    if (!response.ok) {
      const body = (await response.text()).slice(0, 500);
      throw new Error(`AUTOPILOT_MODEL_HTTP_${response.status}: ${body}`);
    }
    const payload = await response.json();
    return responses ? normalizeResponsesResponse(payload) : payload as DeepSeekResponse;
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener('abort', forwardAbort);
  }
}

function boundedToolResult(value: unknown): string {
  const text = JSON.stringify(value);
  return text.length <= 24_000 ? text : `${text.slice(0, 23_900)}...<truncated>`;
}

export async function runAutopilotLoop(
  controllerHome: string,
  repoId: string,
  requirementId: string,
  signal: AbortSignal,
  dependencies: AutopilotRunnerDependencies = {},
): Promise<void> {
  const requirementRecord = readRequirement({ controllerHome }, requirementId);
  if (!requirementRecord) throw new Error(`AUTOPILOT_REQUIREMENT_NOT_FOUND: ${requirementId}`);
  const requirement = requirementSemanticView(requirementRecord.value);
  const initialRecord = readAutopilotRun(controllerHome, repoId, requirementId);
  if (!initialRecord) throw new Error(`AUTOPILOT_RUN_NOT_FOUND: ${requirementId}`);
  if (requirement.revision !== initialRecord.value.requirementRevision) {
    throw new Error(`AUTOPILOT_REQUIREMENT_REVISION_CHANGED: approved=${initialRecord.value.requirementRevision},current=${requirement.revision}`);
  }
  const repository = getRepository(repoId, controllerHome);
  if (!repository) throw new Error(`AUTOPILOT_REPOSITORY_NOT_FOUND: ${repoId}`);
  const plans = listPlanContracts({ controllerHome, repoId, status: 'active', limit: 100 });
  const messages: DeepSeekMessage[] = [
    { role: 'system', content: systemPrompt(initialRecord.value, requirement, plans) },
    { role: 'user', content: 'Continue the approved Requirement autonomously. Inspect current repository facts first, choose the highest-value next implementation slice, execute it safely, validate it, and record a structured decision.' },
  ];

  while (!signal.aborted) {
    const currentRecord = readAutopilotRun(controllerHome, repoId, requirementId);
    if (!currentRecord || currentRecord.value.status !== 'running') return;
    const current = currentRecord.value;
    const latestRequirementRecord = readRequirement({ controllerHome }, requirementId);
    if (!latestRequirementRecord) {
      updateAutopilotRun(controllerHome, repoId, requirementId, (run) => ({ ...run, status:'blocked', stopReason:'requirement_missing' }), 'autopilot_requirement_blocked');
      return;
    }
    const latestRequirement = requirementSemanticView(latestRequirementRecord.value);
    if (latestRequirement.revision !== current.requirementRevision) {
      updateAutopilotRun(controllerHome, repoId, requirementId, (run) => ({
        ...run,
        status:'paused',
        stopReason:`requirement_revision_changed:approved=${run.requirementRevision},current=${latestRequirement.revision}`,
      }), 'autopilot_reapproval_required');
      return;
    }
    const authorization = dependencies.validateAuthorization?.() ?? { ok:true };
    if (!authorization.ok) {
      updateAutopilotRun(controllerHome, repoId, requirementId, (run) => ({
        ...run,status:'paused',stopReason:authorization.reason?.slice(0,1000) || 'authorization_invalid',
      }), 'autopilot_authorization_paused');
      return;
    }
    if (current.usage.turns >= current.policy.maxTurns) {
      updateAutopilotRun(controllerHome, repoId, requirementId, (run) => ({ ...run, status: 'paused', stopReason: 'max_turns_reached' }), 'autopilot_budget_paused');
      return;
    }
    if (current.usage.toolCalls >= current.policy.maxToolCalls) {
      updateAutopilotRun(controllerHome, repoId, requirementId, (run) => ({ ...run, status: 'paused', stopReason: 'max_tool_calls_reached' }), 'autopilot_budget_paused');
      return;
    }
    if (current.usage.totalTokens >= current.policy.maxTotalTokens) {
      updateAutopilotRun(controllerHome, repoId, requirementId, (run) => ({ ...run, status: 'paused', stopReason: 'max_total_tokens_reached' }), 'autopilot_budget_paused');
      return;
    }

    const response = await requestDeepSeek(current, messages, signal, dependencies);
    const assistant = response.choices?.[0]?.message;
    if (!assistant) throw new Error('AUTOPILOT_MODEL_RESPONSE_INVALID');
    const usage = usageOf(response);
    updateAutopilotRun(controllerHome, repoId, requirementId, (run) => ({
      ...run,
      usage: {
        promptTokens: run.usage.promptTokens + usage.promptTokens,
        completionTokens: run.usage.completionTokens + usage.completionTokens,
        totalTokens: run.usage.totalTokens + usage.totalTokens,
        turns: run.usage.turns + 1,
        toolCalls: run.usage.toolCalls,
      },
    }), 'autopilot_model_turn_recorded');
    messages.push({ role: 'assistant', content: assistant.content ?? null, tool_calls: assistant.tool_calls });

    const toolCalls = assistant.tool_calls ?? [];
    if (toolCalls.length === 0) {
      messages.push({ role: 'user', content: 'Use repository tools or call forge_autopilot_decision. Do not end with unstructured prose.' });
      continue;
    }

    for (const toolCall of toolCalls) {
      if (signal.aborted) return;
      const latest = readAutopilotRun(controllerHome, repoId, requirementId)?.value;
      if (!latest || latest.status !== 'running') return;
      if (latest.usage.toolCalls >= latest.policy.maxToolCalls) {
        updateAutopilotRun(controllerHome, repoId, requirementId, (run) => ({ ...run, status: 'paused', stopReason: 'max_tool_calls_reached' }), 'autopilot_budget_paused');
        return;
      }

      let args: Record<string, unknown>;
      try {
        args = JSON.parse(toolCall.function.arguments || '{}') as Record<string, unknown>;
      } catch {
        args = {};
      }

      if (toolCall.function.name === 'forge_autopilot_decision') {
        const decision = decisionFrom(args);
        const checkpoint = decision.currentPlanId && latest.policy.checkpointPlanIds.includes(decision.currentPlanId);
        const status = checkpoint || decision.action === 'pause'
          ? 'paused'
          : decision.action === 'complete'
            ? 'completed'
            : decision.action === 'blocked'
              ? 'blocked'
              : 'running';
        updateAutopilotRun(controllerHome, repoId, requirementId, (run) => ({
          ...run,
          status,
          currentPlanId: decision.currentPlanId,
          lastSummary: decision.summary,
          stopReason: checkpoint ? `human_checkpoint:${decision.currentPlanId}` : status === 'running' ? undefined : decision.action,
          evidenceRefs: [...new Set([...run.evidenceRefs, ...(decision.evidenceRefs ?? [])])].slice(-100),
          usage: { ...run.usage, toolCalls: run.usage.toolCalls + 1 },
        }), 'autopilot_decision_recorded');
        messages.push({ role: 'tool', tool_call_id: toolCall.id, content: JSON.stringify({ accepted: true, status, checkpoint: Boolean(checkpoint) }) });
        if (status !== 'running') return;
        continue;
      }

      if (!ALLOWED_REPOSITORY_TOOLS.has(toolCall.function.name)) {
        messages.push({ role: 'tool', tool_call_id: toolCall.id, content: JSON.stringify({ error: 'AUTOPILOT_TOOL_NOT_ALLOWED' }) });
        continue;
      }
      args.repo_id = repoId;
      args.checkout_id = latest.checkoutId;
      if (toolCall.function.name === 'execute_command') {
        args.scope = 'repository';
        const classification = classifyRepositoryCommand(args.command as string | string[], repository.defaultBranch);
        if ((RISK_RANK[classification.risk] ?? 99) > RISK_RANK.workspace_write) {
          messages.push({ role: 'tool', tool_call_id: toolCall.id, content: JSON.stringify({ error: 'AUTOPILOT_COMMAND_RISK_DENIED', classification }) });
          continue;
        }
      }

      if (!dependencies.executeTool) throw new Error('AUTOPILOT_TOOL_EXECUTOR_REQUIRED');
      const toolResult = await dependencies.executeTool(toolCall.function.name, args);
      updateAutopilotRun(controllerHome, repoId, requirementId, (run) => ({
        ...run,
        usage: { ...run.usage, toolCalls: run.usage.toolCalls + 1 },
      }), 'autopilot_tool_call_recorded');
      messages.push({ role: 'tool', tool_call_id: toolCall.id, content: boundedToolResult(toolResult) });
    }
  }
}
