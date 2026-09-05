import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { buildReport, writeReport } from './report.ts';
import {
  assertOutsideSource,
  changedFiles,
  cleanupIsolatedSnapshot,
  createEvaluationRepositoryFixture,
  createIsolatedSnapshot,
  inspectSourceState,
  isolatedEvaluationEnvironment,
  resolveSourcePath,
  type IsolatedSnapshot,
} from './sandbox.ts';
import { runValidators } from './validators.ts';
import {
  TRACE_SCHEMA,
  type CommandRecord,
  type EvaluationReport,
  type EvaluationTrace,
  type ForgeCommand,
  type ForgeMcpCall,
  type RunEvaluationInput,
  type SourceState,
  type ValidationResult,
} from './types.ts';

const OUTPUT_LIMIT = 16 * 1024;

function sameSourceState(left: SourceState, right: SourceState): boolean {
  return left.clean === right.clean && left.statusDigest === right.statusDigest;
}

function safeText(value: string): string {
  const redacted = value
    .replace(/(authorization\s*[:=]\s*)(?:bearer|basic)?\s*[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/((?:api[_-]?key|access[_-]?token|token|password|secret)\s*[=:]\s*)[^\s,;]+/gi, '$1[REDACTED]');
  return redacted.length <= OUTPUT_LIMIT ? redacted : `${redacted.slice(0, OUTPUT_LIMIT)}\n…[truncated]`;
}

function stringEnvironment(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
}

function normalizedToolPayload(result: unknown): unknown {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return result;
  const record = result as Record<string, unknown>;
  if (record.structuredContent && typeof record.structuredContent === 'object') return record.structuredContent;
  const content = Array.isArray(record.content) ? record.content : [];
  const text = content.find((entry) => entry && typeof entry === 'object' && (entry as Record<string, unknown>).type === 'text') as Record<string, unknown> | undefined;
  if (typeof text?.text === 'string') {
    try { return JSON.parse(text.text); } catch { return { text: text.text }; }
  }
  return record;
}

function select(value: unknown, selector: string): unknown {
  let cursor: unknown = value;
  for (const segment of selector.split('.').filter(Boolean)) {
    if (Array.isArray(cursor) && /^\d+$/.test(segment)) cursor = cursor[Number(segment)];
    else if (cursor && typeof cursor === 'object') cursor = (cursor as Record<string, unknown>)[segment];
    else cursor = undefined;
    if (cursor === undefined) throw new Error(`EVALUATION_MCP_CAPTURE_SELECTOR_MISSING:${selector}`);
  }
  return cursor;
}

function resolveTemplate(value: unknown, variables: Readonly<Record<string, unknown>>): unknown {
  if (typeof value === 'string') {
    const exact = /^\{\{([A-Za-z0-9_.-]+)\}\}$/.exec(value);
    if (exact) {
      if (!(exact[1] in variables)) throw new Error(`EVALUATION_MCP_VARIABLE_MISSING:${exact[1]}`);
      return structuredClone(variables[exact[1]]);
    }
    return value.replace(/\{\{([A-Za-z0-9_.-]+)\}\}/g, (_match, key: string) => {
      if (!(key in variables)) throw new Error(`EVALUATION_MCP_VARIABLE_MISSING:${key}`);
      return String(variables[key]);
    });
  }
  if (Array.isArray(value)) return value.map((entry) => resolveTemplate(entry, variables));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, nested]) => [key, resolveTemplate(nested, variables)]));
  }
  return value;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`EVALUATION_MCP_TIMEOUT:${label}`)), timeoutMs); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function mcpServerArgs(
  sandbox: IsolatedSnapshot,
  execution: Extract<RunEvaluationInput['scenario']['execution'], { interface: 'forge_mcp' }>,
): string[] {
  return [
    'mcp', 'serve',
    '--repo', sandbox.repository,
    '--controller-home', sandbox.controllerHome,
    '--transport', 'stdio',
    '--profile', execution.profile ?? 'controller',
    '--toolset', execution.toolset ?? 'advanced',
  ];
}

interface PublicMcpConnection {
  client: Client;
  transport: StdioClientTransport;
  stderr: { value: string };
}

async function openConnection(input: {
  forgeCommand: ForgeCommand;
  sandbox: IsolatedSnapshot;
  execution: Extract<RunEvaluationInput['scenario']['execution'], { interface: 'forge_mcp' }>;
  environment: NodeJS.ProcessEnv;
}): Promise<PublicMcpConnection> {
  const serverArguments = [...(input.forgeCommand.prefixArguments ?? []), ...mcpServerArgs(input.sandbox, input.execution)];
  const transport = new StdioClientTransport({
    command: input.forgeCommand.executable,
    args: serverArguments,
    cwd: input.sandbox.repository,
    env: stringEnvironment(input.environment),
    stderr: 'pipe',
  });
  const stderr = { value: '' };
  transport.stderr?.on('data', (chunk) => { stderr.value = safeText(`${stderr.value}${String(chunk)}`); });
  const client = new Client({ name: 'forge-evaluation-public-mcp', version: '1.0.0' });
  try {
    await withTimeout(client.connect(transport), 30_000, 'connect');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`EVALUATION_CANDIDATE_MCP_CONNECT_FAILED:${message}`);
  }
  return { client, transport, stderr };
}

async function closeConnection(connection: PublicMcpConnection | undefined): Promise<void> {
  if (!connection) return;
  await connection.client.close().catch(() => undefined);
}

interface PublicMcpCallResult {
  call: ForgeMcpCall;
  payload: unknown;
  actualOutcome: 'success' | 'error';
  record: CommandRecord;
}

async function executeCall(input: {
  call: ForgeMcpCall;
  connection: PublicMcpConnection;
  variables: Readonly<Record<string, unknown>>;
  cwd: string;
}): Promise<PublicMcpCallResult> {
  const resolvedArguments = resolveTemplate(input.call.arguments, input.variables) as Record<string, unknown>;
  const startedAt = new Date().toISOString();
  const started = performance.now();
  let payload: unknown = {};
  let actualOutcome: 'success' | 'error' = 'success';
  let errorText = '';
  try {
    const result = await withTimeout(
      input.connection.client.callTool({ name: input.call.tool, arguments: resolvedArguments }),
      input.call.timeoutMs ?? 60_000,
      input.call.id,
    );
    actualOutcome = (result as { isError?: boolean }).isError === true ? 'error' : 'success';
    payload = normalizedToolPayload(result);
  } catch (error) {
    actualOutcome = 'error';
    errorText = error instanceof Error ? error.message : String(error);
    payload = { error: errorText };
  }
  return {
    call: input.call,
    payload,
    actualOutcome,
    record: {
      kind: 'forge',
      stepId: input.call.id,
      command: `mcp:${input.call.tool}`,
      arguments: [safeText(JSON.stringify(resolvedArguments))],
      cwd: input.cwd,
      exitCode: actualOutcome === 'success' ? 0 : 1,
      startedAt,
      durationMs: Math.max(0, performance.now() - started),
      stdout: safeText(JSON.stringify(payload)),
      stderr: safeText(errorText || input.connection.stderr.value),
      timedOut: errorText.startsWith('EVALUATION_MCP_TIMEOUT:'),
    },
  };
}

function applyCallResult(input: {
  result: PublicMcpCallResult;
  variables: Record<string, unknown>;
  commands: CommandRecord[];
  executions: CommandRecord[];
}): boolean {
  input.commands.push(input.result.record);
  input.executions.push(input.result.record);
  for (const [name, selector] of Object.entries(input.result.call.capture ?? {})) {
    input.variables[name] = structuredClone(select(input.result.payload, selector));
  }
  return input.result.actualOutcome === (input.result.call.expectedOutcome ?? 'success');
}

function restartCommand(callId: string, cwd: string, startedAt: string, durationMs: number): CommandRecord {
  return {
    kind: 'forge',
    stepId: `restart-before:${callId}`,
    command: 'mcp:restart',
    arguments: [],
    cwd,
    exitCode: 0,
    startedAt,
    durationMs,
    stdout: '',
    stderr: '',
    timedOut: false,
  };
}

export async function runPublicMcpEvaluationInSnapshot(input: {
  scenario: RunEvaluationInput['scenario'];
  sandbox: IsolatedSnapshot;
  forgeCommand?: ForgeCommand;
  outputDirectory?: string;
  retained?: boolean;
  env?: NodeJS.ProcessEnv;
}): Promise<EvaluationReport> {
  if (input.scenario.execution.interface !== 'forge_mcp') throw new Error(`Evaluation scenario ${input.scenario.id} does not use forge_mcp.`);
  const retained = input.retained === true;
  const forgeCommand = input.forgeCommand ?? { executable: 'forge' };
  const environment = input.env ?? isolatedEvaluationEnvironment(input.sandbox);
  const commands: CommandRecord[] = [...input.sandbox.setupCommands];
  const executions: CommandRecord[] = [];
  const variables: Record<string, unknown> = {
    'sandbox.root': input.sandbox.root,
    'sandbox.repository': input.sandbox.repository,
    'sandbox.controllerHome': input.sandbox.controllerHome,
  };
  let executionPassed = true;

  const fixtureRepositories = new Map<string, string>();
  for (const fixture of input.scenario.fixtures?.repositories ?? []) {
    const materialized = createEvaluationRepositoryFixture(input.sandbox, fixture.id, input.scenario.snapshot.commit);
    commands.push(...materialized.commands);
    variables[`fixture.${fixture.id}.repository`] = materialized.repository;
    fixtureRepositories.set(fixture.id, materialized.repository);
  }

  let connection: PublicMcpConnection | undefined;
  try {
    connection = await openConnection({ forgeCommand, sandbox: input.sandbox, execution: input.scenario.execution, environment });
    for (let index = 0; index < input.scenario.execution.calls.length;) {
      const call = input.scenario.execution.calls[index]!;
      if (call.restartBefore) {
        const restartStartedAt = new Date().toISOString();
        const restartStarted = performance.now();
        await closeConnection(connection);
        connection = await openConnection({ forgeCommand, sandbox: input.sandbox, execution: input.scenario.execution, environment });
        commands.push(restartCommand(call.id, input.sandbox.repository, restartStartedAt, Math.max(0, performance.now() - restartStarted)));
      }

      if (call.parallelGroup) {
        const group: ForgeMcpCall[] = [];
        let cursor = index;
        while (cursor < input.scenario.execution.calls.length && input.scenario.execution.calls[cursor]!.parallelGroup === call.parallelGroup) {
          group.push(input.scenario.execution.calls[cursor]!);
          cursor += 1;
        }
        const variableSnapshot = structuredClone(variables);
        const results = await Promise.all(group.map((entry) => executeCall({
          call: entry,
          connection: connection!,
          variables: variableSnapshot,
          cwd: input.sandbox.repository,
        })));
        for (const result of results) {
          if (!applyCallResult({ result, variables, commands, executions })) executionPassed = false;
        }
        index = cursor;
        continue;
      }

      const result = await executeCall({ call, connection, variables, cwd: input.sandbox.repository });
      if (!applyCallResult({ result, variables, commands, executions })) executionPassed = false;
      index += 1;
    }
  } finally {
    await closeConnection(connection);
  }

  const changes = changedFiles(input.sandbox.repository);
  commands.push(...changes.commands);
  const observedChangedFiles = [...changes.files];
  for (const [fixtureId, repository] of fixtureRepositories) {
    const fixtureChanges = changedFiles(repository);
    commands.push(...fixtureChanges.commands);
    observedChangedFiles.push(...fixtureChanges.files.map((path) => `fixtures/${fixtureId}/${path}`));
  }
  observedChangedFiles.sort();
  const validations = runValidators({
    validators: input.scenario.validators,
    cwd: input.sandbox.repository,
    changedFiles: observedChangedFiles,
    executionCommands: executions,
    env: environment,
  });
  const sourceAfter = inspectSourceState(input.sandbox.source);
  commands.push(sourceAfter.command);
  const isolation: ValidationResult = sameSourceState(input.sandbox.sourceStateBefore, sourceAfter.state)
    ? { id: 'source-repository-unchanged', kind: 'isolation', status: 'passed', summary: 'Source Git status was unchanged before and after the evaluation.' }
    : { id: 'source-repository-unchanged', kind: 'isolation', status: 'failed', summary: 'Source Git status changed during evaluation; do not trust this result.' };
  const validation = [...validations.results, isolation];
  const passed = executionPassed && validation.every((result) => result.status === 'passed');
  const trace: EvaluationTrace = {
    schemaVersion: TRACE_SCHEMA,
    scenarioId: input.scenario.id,
    taskInput: input.scenario.userIntent,
    snapshot: { commit: input.scenario.snapshot.commit, sourceStateBefore: input.sandbox.sourceStateBefore, sourceStateAfter: sourceAfter.state },
    sandbox: { strategy: 'git-clone-no-local', retained, ...(retained ? { path: input.sandbox.root } : {}) },
    contextRetrieval: [],
    inspectedEvidence: [],
    changedFiles: observedChangedFiles,
    commands,
    checks: validations.commands,
    toolInteractions: [
      ...executions.map((execution) => ({
        kind: 'forge_tool' as const,
        name: execution.command.slice('mcp:'.length),
        outcome: execution.exitCode === 0 ? 'success' as const : 'failure' as const,
      })),
      ...validations.commands.map((command) => ({
        kind: 'check' as const,
        name: command.command,
        outcome: command.exitCode === 0 ? 'success' as const : 'failure' as const,
      })),
    ],
    finalResult: {
      status: passed ? 'passed' : 'failed',
      summary: passed
        ? 'Public MCP execution and evaluator-owned validators passed in an isolated snapshot.'
        : 'Public MCP execution or validation failed; inspect the trace and diagnosis.',
    },
    validation,
  };
  const report = buildReport(input.scenario, trace);
  if (input.outputDirectory) writeReport(input.outputDirectory, report);
  return report;
}

export async function runPublicMcpEvaluation(input: RunEvaluationInput): Promise<EvaluationReport> {
  const repositoryRoot = resolve(input.repositoryRoot ?? process.cwd());
  const source = resolveSourcePath(repositoryRoot, input.scenario.snapshot.source);
  if (input.outputDirectory) assertOutsideSource(source, input.outputDirectory);
  const sandbox = createIsolatedSnapshot(source, input.scenario.snapshot.commit);
  const retained = input.keepSandbox === true;
  try {
    return await runPublicMcpEvaluationInSnapshot({
      scenario: input.scenario,
      sandbox,
      forgeCommand: input.forgeCommand,
      outputDirectory: input.outputDirectory,
      retained,
      env: isolatedEvaluationEnvironment(sandbox),
    });
  } finally {
    if (!retained) cleanupIsolatedSnapshot(sandbox.root);
  }
}
