import type { CallToolResult, McpToolDefinition } from '../../../packages/protocols/mcp/tool-contract';
export type { CallToolResult, McpToolDefinition } from '../../../packages/protocols/mcp/tool-contract';
import { createHash } from 'crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { EDIT_OPERATION_INPUT_SCHEMA } from '../../../src/runtime/editing/edit-operation-contract';
import { withRepositoryMutationExclusion } from '../../../src/runtime/resources/leases/store';
import type { ResourceClaimSpec } from '../../../src/runtime/execution/jobs/types';
import { claimPathWrite } from '../../../src/runtime/execution/process-runtime/resource-claims';
import { listControllerChecks } from '../../../src/runtime/execution/process-runtime/check-runner';
import {
  listCapabilityDescriptors,
  summarizeCapabilityGroups,
} from '../../../src/runtime/control-plane/facade/capability-registry';
import {
  FORGE_MCP_SCHEMA_VERSION,
  FORGE_TOOL_SURFACE,
  FORGE_VERSION,
  forgeToolSurfaceFingerprint,
  formatDurationMs,
  normalizeAgentTimeoutMs,
} from '../../../src/runtime/shared/runtime-config';
import { PREFERRED_FACADE_TOOL_NAMES } from '../toolset-names';
import { buildLocalConnectorStatusForRepo } from '../../../src/cli/local-bridge/connector-freshness';
import {
  listSessions,
  openSession,
  readSession,
  runBrowserConsult,
  runBrowserFollowup,
} from '../../../src/cli/chatgpt-browser/engine';
import type { BrowserProviderName, ThinkingLevel } from '../../../src/cli/chatgpt-browser/types';
import type { NativeBrowserChannel } from '../../../src/runtime/platform/browser-product-discovery';
import { hashMcpInput, tryWriteMcpAuditEntry } from '../audit';
import { resolveRepoPreferredControllerHome } from '../../../src/effects/controller-home';
import { resolveRepositoryCheckStorage } from '../../../src/runtime/execution/process-runtime/check-storage';
import { resolveRepositorySelection } from '../../../src/runtime/repositories/registry';
import { resolveMcpPath } from '../../../src/runtime/safe-tooling/path-policy';
import { applySessionlessMutationBatch } from '../../../src/runtime/repositories/safe-patch';
import { extractPatchPaths } from '../../../src/runtime/execution/thin-harness/execution-router';
import { leadingErrorCode } from '../../../src/runtime/shared/response-budget';
import { currentGitBranch, isForgeAdopted } from '../repo';
import { redactMcpText } from '../redaction';
import type { ToolPolicy } from '../../../src/runtime/control-plane/tool-policy';

export interface McpToolContext {
  repoRoot: string;
  policy: ToolPolicy;
  /** Controller Home authority for legacy read-only Runtime projections. */
  runtimeControllerHome?: string;
  enableChatgptBrowser?: boolean;
  /** Controller-issued MCP execution identity; absent on legacy non-controller calls. */
  sessionId?: string;
  /** Authenticated or controller-issued principal used to scope session state. */
  principalId?: string;
  /** Authenticated transport controller/provider type. */
  controllerType?: 'chatgpt' | 'codex' | 'claude' | 'grok' | 'human';
  /** Host-provided ChatGPT session correlation. Never authorization and never a canonical conversation URL. */
  hostConversationSessionId?: string;
  controllerInstanceId?: string;
  /** Bound repository identity for session cache keys. */
  repoId?: string;
  checkoutId?: string;
  /** Canonical tools/list projection supplied by the MCP registry; never authored by the client. */
  publishedToolNames?: readonly string[];
  /** Request-scoped MCP cancellation; never persisted or reused across calls. */
  signal?: AbortSignal;
}

const EMPTY_SCHEMA = { type: 'object', additionalProperties: false };

function textResult(
  value: unknown,
  structuredContent: unknown = typeof value === 'string' ? undefined : value,
): CallToolResult {
  const normalizedStructuredContent = structuredContent as Record<string, unknown> | undefined;
  return {
    content: [
      {
        type: 'text',
        text: typeof value === 'string' ? value : JSON.stringify(value, null, 2),
      },
    ],
    structuredContent: normalizedStructuredContent,
  };
}

function errorResult(code: string, message: string, details?: unknown): CallToolResult {
  const result = textResult({
    error: { code, message: redactMcpText(message).text, details },
  });
  result.isError = true;
  return result;
}

function audit(
  ctx: McpToolContext,
  tool: string,
  status: 'ok' | 'blocked' | 'failed',
  input: unknown,
  targetPath?: string,
  error?: string,
): void {
  tryWriteMcpAuditEntry(ctx.repoRoot, {
    timestamp: new Date().toISOString(),
    tool,
    status,
    targetPath,
    inputHash: hashMcpInput(input),
    error,
  });
}

function isProbablyBinary(bytes: Buffer): boolean {
  return bytes.subarray(0, Math.min(bytes.length, 8000)).includes(0);
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function mcpRepositoryIdentity(ctx: McpToolContext): { repoId: string; checkoutId: string } {
  const local = sha256(ctx.repoRoot).slice(0, 16);
  return {
    repoId: ctx.repoId?.trim() || 'repo-local-' + local,
    checkoutId: ctx.checkoutId?.trim() || 'checkout-local-' + local,
  };
}

/**
 * Exact source-path claims for the MCP mutation entrypoint. The canonical
 * Semantic Mutation Planner performs atomic CAS; this wrapper coordinates
 * those paths with other repository mutation owners.
 */
export function buildMcpSourceClaims(ctx: McpToolContext, paths: Iterable<string>): ResourceClaimSpec[] {
  const controllerHome = ctx.runtimeControllerHome?.trim() || resolveRepoPreferredControllerHome(ctx.repoRoot);
  const checkoutId =
    ctx.checkoutId?.trim() ||
    resolveRepositorySelection({
      explicitPath: ctx.repoRoot,
      controllerHome,
      allowSoleRepository: true,
    }).activeCheckoutId;
  // Do not fall back to a repository-wide writer lock when exact placement is
  // unknown. This MCP mutation requires a provable checkout and exact paths.
  if (!checkoutId) throw new Error('MCP_SOURCE_CHECKOUT_ID_REQUIRED');
  const claimsByResource = new Map<string, ResourceClaimSpec>();
  for (const rawPath of paths) {
    const path = rawPath.trim();
    if (!path) continue;
    const claim = claimPathWrite(path, checkoutId, ctx.repoId);
    if (!claim) throw new Error('MCP_SOURCE_PATH_UNPROVABLE');
    claimsByResource.set(claim.resourceKey, claim);
  }
  if (claimsByResource.size === 0) throw new Error('MCP_SOURCE_PATHS_REQUIRED');
  return [...claimsByResource.values()];
}

function withMcpRepositoryMutation<T>(
  ctx: McpToolContext,
  operation: string,
  mutate: (leaseOwnerJobId?: string) => T,
  claims: ResourceClaimSpec[],
): T {
  const controllerHome = ctx.runtimeControllerHome?.trim() || resolveRepoPreferredControllerHome(ctx.repoRoot);
  const repoId =
    ctx.repoId?.trim() ||
    resolveRepositorySelection({
      explicitPath: ctx.repoRoot,
      controllerHome,
      allowSoleRepository: true,
    }).repoId;
  return withRepositoryMutationExclusion(controllerHome, repoId, `mcp:${operation}`, mutate, undefined, claims);
}

function fileSummary(path: string, repoRoot: string): { path: string; size: number; modifiedAt: string } | null {
  try {
    const fileStat = statSync(join(repoRoot, path));
    if (!fileStat.isFile()) return null;
    return {
      path,
      size: fileStat.size,
      modifiedAt: fileStat.mtime.toISOString(),
    };
  } catch (_error) {
    return null;
  }
}

function knownRunPathReplacements(
  repoRoot: string,
  run: Partial<{
    executionRoot: string;
    worktree: string;
    worktreePath: string;
  }>,
): Array<{ from: string; to: string }> {
  const replacements = new Map<string, string>();
  const remember = (from: string | undefined, to: string) => {
    if (!from || !from.startsWith('/')) return;
    replacements.set(from, to);
  };
  remember(repoRoot, '<repo>');
  remember(run.executionRoot, '<execution-root>');
  remember(run.worktreePath, '<worktree>');
  remember(run.worktree, run.worktree === repoRoot ? '<repo>' : '<worktree>');
  return [...replacements.entries()]
    .sort((left, right) => right[0].length - left[0].length)
    .map(([from, to]) => ({ from, to }));
}

const PROJECT_BOARD_RECENT_ISSUE_LIMIT = 5;
const PROJECT_BOARD_TASK_LIMIT = 8;

const UPDATE_TASK_SUMMARY_TASK_LIMIT = 12;

function listFilesUnder(repoRoot: string, root: string, maxFiles: number, out: string[]): void {
  if (out.length >= maxFiles) return;
  const absoluteRoot = join(repoRoot, root);
  if (!existsSync(absoluteRoot)) return;
  const rootStat = statSync(absoluteRoot);
  if (rootStat.isFile()) {
    out.push(root);
    return;
  }
  if (!rootStat.isDirectory()) return;
  for (const entry of readdirSync(absoluteRoot, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (out.length >= maxFiles) return;
    const child = `${root}/${entry.name}`;
    if (entry.isDirectory()) {
      listFilesUnder(repoRoot, child, maxFiles, out);
    } else if (entry.isFile() || entry.isSymbolicLink()) {
      out.push(child);
    }
  }
}

function workflowFileCandidates(repoRoot: string): string[] {
  const roots = [
    'AGENTS.md',
    'CLAUDE.md',
    'SKILL.md',
    'docs/domain-rules.md',
    'docs/project/chatgpt-planning-profile.md',
    'docs/mvp2',
    '.spec-workflow/specs',
    'ios/AGENTS.md',
    'plans',
    'tasks',
    '.ai/context',
    '.ai/harness/session',
    '.ai/harness/controller/packets',
    '.ai/harness/projections',
    '.ai/harness/checks',
  ];
  const files: string[] = [];
  for (const root of roots) {
    const rootFiles: string[] = [];
    listFilesUnder(repoRoot, root, 700, rootFiles);
    files.push(...rootFiles);
  }
  return Array.from(new Set(files)).sort();
}

function runnerTimeoutMs(ctx: McpToolContext, value: unknown): number {
  return normalizeAgentTimeoutMs(value, {
    defaultMs: ctx.policy.execution.runnerTimeoutMs,
    maxMs: ctx.policy.execution.runnerMaxTimeoutMs,
    label: 'timeout_ms',
  });
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => String(entry).trim()).filter((entry) => entry.length > 0);
}

interface TaskVerificationLeaseConflict {
  message: string;
  resourceKey?: string;
  blockingProcessId?: string;
}

function parseThinking(value: unknown): ThinkingLevel | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (value === 'light' || value === 'standard' || value === 'extended' || value === 'heavy') return value;
  throw new Error(`invalid thinking level: ${String(value)}`);
}

function parseBrowserProvider(value: unknown): BrowserProviderName | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (value === 'oracle' || value === 'native') return value;
  throw new Error(`invalid browser provider: ${String(value)}`);
}

function parseNativeBrowserChannel(value: unknown): NativeBrowserChannel | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (value === 'chrome' || value === 'chrome-beta' || value === 'chrome-dev' || value === 'chrome-canary')
    return value;
  throw new Error(`invalid browser channel: ${String(value)}`);
}

export function buildMcpToolDefinitions(
  policy: ToolPolicy,
  opts: { enableChatgptBrowser?: boolean } = {},
): McpToolDefinition[] {
  const readOnly = { readOnlyHint: true, openWorldHint: false };
  const write = {
    readOnlyHint: false,
    openWorldHint: false,
    destructiveHint: false,
  };
  const stringPathSchema = {
    type: 'object',
    properties: { path: { type: 'string' } },
    required: ['path'],
    additionalProperties: false,
  };
  const browserRunSchema = {
    type: 'object',
    properties: {
      prompt: { type: 'string' },
      title: { type: 'string' },
      files: { type: 'array', items: { type: 'string' } },
      model: { type: 'string' },
      thinking: {
        type: 'string',
        enum: ['light', 'standard', 'extended', 'heavy'],
      },
      provider: { type: 'string', enum: ['oracle', 'native'] },
      browserChannel: {
        type: 'string',
        enum: ['chrome', 'chrome-beta', 'chrome-dev', 'chrome-canary'],
      },
      followups: { type: 'array', items: { type: 'string' } },
      writeOutput: { type: 'string' },
      overwriteOutput: { type: 'boolean' },
      timeoutMs: { type: 'number' },
      dryRun: { type: 'boolean' },
    },
    required: ['prompt'],
    additionalProperties: false,
  };
  const browserSessionSchema = {
    type: 'object',
    properties: { sessionId: { type: 'string' } },
    required: ['sessionId'],
    additionalProperties: false,
  };
  const tools: McpToolDefinition[] = [
    {
      name: 'harness_status',
      description: 'Return forge adoption and workflow status.',
      inputSchema: EMPTY_SCHEMA,
      annotations: readOnly,
    },
    {
      name: 'harness_doctor',
      description: 'Return compact MCP setup diagnostics.',
      inputSchema: EMPTY_SCHEMA,
      annotations: readOnly,
    },
    {
      name: 'list_workflow_files',
      description: 'List policy-readable workflow files.',
      inputSchema: EMPTY_SCHEMA,
      annotations: readOnly,
    },
    {
      name: 'read_workflow_file',
      description: 'Read one policy-allowed workflow file by repo-relative path.',
      inputSchema: stringPathSchema,
      annotations: readOnly,
    },
    {
      name: 'latest_session_context',
      description: 'Return the latest rebuildable Forge session continuation context.',
      inputSchema: EMPTY_SCHEMA,
      annotations: readOnly,
    },
    {
      name: 'latest_checks',
      description: 'Return latest forge check artifacts.',
      inputSchema: EMPTY_SCHEMA,
      annotations: readOnly,
    },
  ];

  if (policy.profile === 'controller') {
    const taskItemSchema = {
      type: 'object',
      properties: {
        title: { type: 'string' },
        objective: { type: 'string' },
        depends_on: { type: 'array', items: { type: 'string' } },
        allowed_paths: { type: 'array', items: { type: 'string' } },
        forbidden_paths: { type: 'array', items: { type: 'string' } },
        checks: { type: 'array', items: { type: 'string' } },
        acceptance_criteria: { type: 'array', items: { type: 'string' } },
        risk: { type: 'string', enum: ['readonly', 'low', 'medium', 'high', 'destructive'] },
        agent: { type: 'string', enum: ['codex', 'claude', 'github-copilot'] },
      },
      required: ['title', 'objective'],
      additionalProperties: false,
    };
    tools.push(
      {
        name: 'controller_capabilities',
        description:
          'Return the active controller tool-surface version and expected capabilities. Use this to detect a stale ChatGPT connector tool snapshot.',
        inputSchema: EMPTY_SCHEMA,
        annotations: readOnly,
      },
      {
        name: 'local_bridge_status',
        description:
          'Return Local Bridge / Local Controller status. Default is a compact summary (mode, endpoint, health, job counts). Pass detail_level=detail for full recentJobs, reconciliation, and owner evidence.',
        inputSchema: {
          type: 'object',
          properties: {
            detail_level: {
              type: 'string',
              enum: ['summary', 'detail'],
              description: 'Defaults to summary. Use detail for full job lists and diagnostics.',
            },
            detail: {
              type: 'boolean',
              description: 'Legacy alias for detail_level=detail.',
            },
          },
          additionalProperties: false,
        },
        annotations: readOnly,
      },
      {
        name: 'controller_context',
        description:
          'Return a lightweight Context Index by default. Request only named sections through sections[]; legacy detail_level=detail remains available for the full diagnostic payload.',
        inputSchema: {
          type: 'object',
          properties: {
            description: { type: 'string' },
            known_paths: { type: 'array', items: { type: 'string' } },
            detail_level: { type: 'string', enum: ['summary', 'detail'] },
            sections: {
              type: 'array',
              uniqueItems: true,
              items: {
                type: 'string',
                enum: [
                  'git',
                  'focus',
                  'readiness',
                  'activeRuns',
                  'localBridge',
                  'history',
                  'checks',
                  'plugins',
                ],
              },
              description:
                'Omit for the lightweight Context Index. Request only the named sections to read them on demand; multiple sections are batched without loading unrelated sections.',
            },
            needs_dependencies: { type: 'boolean' },
            risk: { type: 'string', enum: ['readonly', 'low', 'medium', 'high', 'destructive'] },
          },
          additionalProperties: false,
        },
        annotations: readOnly,
      },
      {
        name: 'get_local_job',
        description: 'Read one local Job Ticket status and compact metadata.',
        inputSchema: {
          type: 'object',
          properties: {
            job_id: { type: 'string' },
            include_events: { type: 'boolean' },
            include_output: { type: 'boolean' },
            stream: { type: 'string', enum: ['stdout', 'stderr'] },
            max_bytes: { type: 'number' },
          },
          required: ['job_id'],
          additionalProperties: false,
        },
        annotations: readOnly,
      },
      {
        name: 'list_checks',
        description: 'List focused repository checks from safe package scripts and .forge/checks.json.',
        inputSchema: EMPTY_SCHEMA,
        annotations: readOnly,
      },
      {
        name: 'apply_patch',
        description:
          'Apply a sessionless mutation batch through the canonical Semantic Mutation Planner using operations, optional allowed_paths, and optional refresh_fingerprints.',
        inputSchema: {
          type: 'object',
          properties: {
            operations: {
              type: 'array',
              items: EDIT_OPERATION_INPUT_SCHEMA,
            },
            allowed_paths: { type: 'array', items: { type: 'string' } },
            refresh_fingerprints: { type: 'boolean' },
          },
          required: ['operations'],
          additionalProperties: false,
        },
        annotations: {
          readOnlyHint: false,
          openWorldHint: false,
          destructiveHint: false,
        },
      },
    );
  }

  if (opts.enableChatgptBrowser === true) {
    tools.push(
      {
        name: 'run_chatgpt_browser_consult',
        description:
          'Run a local ChatGPT Web browser consult through forge. This may create a real ChatGPT Web conversation unless dryRun is true.',
        inputSchema: browserRunSchema,
        annotations: {
          readOnlyHint: false,
          openWorldHint: true,
          destructiveHint: false,
        },
      },
      {
        name: 'read_chatgpt_browser_session',
        description: 'Read a saved forge ChatGPT browser consult session.',
        inputSchema: browserSessionSchema,
        annotations: readOnly,
      },
      {
        name: 'list_chatgpt_browser_sessions',
        description: 'List saved forge ChatGPT browser consult sessions.',
        inputSchema: {
          type: 'object',
          properties: { limit: { type: 'number' } },
          additionalProperties: false,
        },
        annotations: readOnly,
      },
      {
        name: 'open_chatgpt_browser_session',
        description:
          'Return the ChatGPT conversation URL for a saved browser session. The MCP tool does not launch the local browser.',
        inputSchema: browserSessionSchema,
        annotations: readOnly,
      },
      {
        name: 'continue_chatgpt_browser_session',
        description: 'Create a follow-up ChatGPT browser consult record linked to an existing session.',
        inputSchema: {
          type: 'object',
          properties: {
            sessionId: { type: 'string' },
            prompt: { type: 'string' },
            dryRun: { type: 'boolean' },
          },
          required: ['sessionId', 'prompt'],
          additionalProperties: false,
        },
        annotations: {
          readOnlyHint: false,
          openWorldHint: true,
          destructiveHint: false,
        },
      },
    );
  }
  return tools;
}

export async function callMcpTool(
  ctx: McpToolContext,
  name: string,
  args: Record<string, unknown> = {},
): Promise<CallToolResult> {
  try {
    switch (name) {
      case 'harness_status': {
        const roots = [
          'plans',
          'tasks/current.md',
          '.ai/harness/session',
          '.ai/harness/controller/packets',
          '.ai/harness/projections',
          '.ai/harness/checks',
        ];
        audit(ctx, name, 'ok', args);
        return textResult({
          repoRoot: ctx.repoRoot,
          adopted: isForgeAdopted(ctx.repoRoot),
          profile: ctx.policy.profile,
          branch: currentGitBranch(ctx.repoRoot),
          workflowRoots: roots.map((path) => ({
            path,
            exists: existsSync(join(ctx.repoRoot, path)),
          })),
        });
      }
      case 'harness_doctor': {
        const localConfig = existsSync(join(ctx.repoRoot, '.forge', 'mcp.local.json'));
        const codexConfig = existsSync(join(ctx.repoRoot, '.codex', 'config.toml'));
        audit(ctx, name, 'ok', args);
        return textResult({
          status: isForgeAdopted(ctx.repoRoot) ? 'ready_local' : 'not_adopted',
          repo: ctx.repoRoot,
          profile: ctx.policy.profile,
          mcp: {
            localConfig,
            policy: 'builtin',
            profile: ctx.policy.profile,
            toolSurface: ctx.policy.profile === 'controller' ? FORGE_TOOL_SURFACE : `${ctx.policy.profile}-legacy-v1`,
            toolCount: buildMcpToolDefinitions(ctx.policy, {
              enableChatgptBrowser: ctx.enableChatgptBrowser === true,
            }).length,
            repositoryRead:
              ctx.policy.profile === 'controller'
                ? 'ordinary repository source and document files are readable; immutable secret and runtime paths remain denied'
                : 'workflow-scoped',
            deniedPaths: ctx.policy.denyGlobs.length,
            runner: {
              enabled: ctx.policy.execution.agentRunner,
              defaultTimeoutMs: ctx.policy.execution.runnerTimeoutMs,
              maxTimeoutMs: ctx.policy.execution.runnerMaxTimeoutMs,
            },
          },
          codex: {
            configured: codexConfig,
            fix: codexConfig ? null : 'forge mcp setup codex --repo . --scope project',
          },
          chatgpt: {
            localEndpoint: 'http://127.0.0.1:8765/mcp',
            manualStepsRequired: true,
          },
        });
      }
      case 'controller_capabilities': {
        if (ctx.policy.profile !== 'controller')
          return errorResult('TOOL_DISABLED', 'controller_capabilities requires the controller profile');
        const expectedTools = ctx.publishedToolNames;
        if (!expectedTools)
          return errorResult(
            'MCP_TOOL_SURFACE_UNAVAILABLE',
            'Controller capability diagnostics require the authoritative MCP registry projection.',
          );
        const preferredTools: string[] = [...PREFERRED_FACADE_TOOL_NAMES];
        const capabilityDescriptors = listCapabilityDescriptors();
        const connectorSnapshot = Array.isArray(args.connector_tool_names)
          ? args.connector_tool_names.map(String)
          : Array.isArray(args.connectorToolNames)
            ? args.connectorToolNames.map(String)
            : undefined;
        const connectorFreshness = await buildLocalConnectorStatusForRepo({
          repoRoot: ctx.repoRoot,
          expectedTools,
          connectorToolNames: connectorSnapshot,
        });
        // staleConnector only when ChatGPT snapshot is supplied and missing rh_*.
        const missingFacadeTools = connectorFreshness.missingConnectorTools;
        const staleConnector = connectorFreshness.status === 'chatgpt_snapshot_missing_facade';
        const payload = {
          schemaVersion: FORGE_MCP_SCHEMA_VERSION,
          toolSurface: FORGE_TOOL_SURFACE,
          version: FORGE_VERSION,
          toolSurfaceFingerprint: forgeToolSurfaceFingerprint(expectedTools),
          executionModel: 'chatgpt-controller-execution-bridge',
          profile: ctx.policy.profile,
          capabilities: {
            repositoryInspection: true,
            issueLauncher: true,
            githubIssuesAndProjects: true,
            localAgentRuns: ctx.policy.execution.agentRunner,
            githubCopilotSessions: true,
            dynamicTaskGraph: true,
            runtimeAgentSelection: true,
            taskAgentBinding: false,
            structuredRunEvents: true,
            boundedDirectEdits: true,
            multiRevisionDirectEdits: true,
            directEditFirstRouting: true,
            localRunWatch: true,
            localVisualController: true,
            hierarchicalControllerUI: true,
            localApprovalQueue: false,
            localRiskApprovalGate: false,
            quickAgentSessions: true,
            persistentTimeouts: true,
            timeoutProgress: true,
            connectorSchemaDiagnostics: true,
            projectProgressAggregation: true,
            effectiveTaskStatus: true,
            unifiedWorklogTimeline: true,
            exportableWorklogReports: true,
            githubPluginConfiguration: true,
            serverSentEventDashboard: true,
            singleExecutionFocus: false,
            taskLocalReadiness: true,
            riskAdaptiveVerification: true,
            ephemeralQuickAgentSessions: true,
            automaticRunContinuation: true,
            reportedCommandEvidence: true,
            governanceDiagnostics: true,
            safeGovernanceReconciliation: true,
            evidenceGateProgress: true,
            directTaskActions: true,
            issueArchiving: true,
            retryableRunFailures: true,
            issueCreationGuardrails: true,
            persistedCheckEvidence: true,
            persistedCheckReuse: true,
            directVerification: true,
            controllerContextAggregation: true,
            assistantPluginRuntime: true,
            chatgptFacadeTools: true,
            goalWorkloop: true,
            handoffInbox: true,
            codexGrokDelegation: true,
            selfHealingRepair: true,
          },
          runner: {
            enabled: ctx.policy.execution.agentRunner,
            allowedAgents: ctx.policy.execution.allowedAgents,
            defaultTimeoutMs: ctx.policy.execution.runnerTimeoutMs,
            defaultTimeout: formatDurationMs(ctx.policy.execution.runnerTimeoutMs),
            maxTimeoutMs: ctx.policy.execution.runnerMaxTimeoutMs,
            maxTimeout: formatDurationMs(ctx.policy.execution.runnerMaxTimeoutMs),
            note: 'Requested timeout values are validated explicitly and are never silently reduced to the default.',
          },
          preferredTools,
          capabilityGroups: summarizeCapabilityGroups(),
          toolArchitecture: {
            facadeTools: preferredTools,
            atomicTypedToolsRetained: true,
            internalHandlersRetained: true,
            domainSchemaLoading: 'static_stable_surface',
            dynamicDomainSchemaLoadingSupported: false,
            capabilityDescriptorCount: capabilityDescriptors.length,
          },
          toolExposure: {
            preferred: preferredTools,
            note: 'Prefer the five rh_* workflow facades for orchestration. Typed repository, Git, Issue/Task, plugin, browser, iOS, artifact, and recovery tools remain available because the current MCP transport cannot load domain schemas per conversation.',
            exposedToolCount: expectedTools.length,
          },
          expectedTools,
          facadeToolsPresentInExpectedTools: preferredTools.every((tool: string) => expectedTools.includes(tool)),
          staleConnector,
          missingFacadeTools,
          connectorFreshness: {
            status: connectorFreshness.status,
            severity: connectorFreshness.severity,
            summary: connectorFreshness.summary,
            missingLocalTools: connectorFreshness.missingLocalTools,
            missingConnectorTools: connectorFreshness.missingConnectorTools,
            expectedFacadeTools: connectorFreshness.expectedFacadeTools,
            restartRecommended: connectorFreshness.restartRecommended,
            reconnectRecommended: connectorFreshness.reconnectRecommended,
            suggestedActions: connectorFreshness.suggestedActions,
          },
          staleConnectorHint: staleConnector
            ? `Stale ChatGPT connector tool snapshot is missing facade tools: ${missingFacadeTools.join(', ')}. Refresh/reconnect MCP so tools/list reloads rh_status, rh_inbox, rh_context, and rh_project.`
            : connectorFreshness.status === 'unable_to_verify_chatgpt_snapshot'
              ? `Local MCP tool surface includes preferred facade tools. ChatGPT connector snapshot was not supplied, so freshness cannot be verified from this call. If ChatGPT tools/list is missing rh_status/rh_inbox/rh_context/rh_project, reconnect MCP. Pass connector_tool_names for an exact check.`
              : connectorFreshness.status === 'stale_fingerprint'
                ? `Local MCP process fingerprint/version may be stale. Restart controller/MCP, then reconnect ChatGPT if rh_* are still missing.`
                : connectorFreshness.status === 'local_mcp_missing_facade'
                  ? `Local MCP tool surface is missing facade tools: ${connectorFreshness.missingLocalTools.join(', ')}. Restart controller/MCP.`
                  : `Connector clients must match ${FORGE_TOOL_SURFACE} version ${FORGE_VERSION} / schema ${FORGE_MCP_SCHEMA_VERSION}. Prefer rh_status/rh_inbox/rh_context/rh_project. Pass connector_tool_names to detect a stale ChatGPT tool snapshot precisely.`,
        };
        audit(ctx, name, 'ok', args);
        return textResult(payload);
      }
      case 'list_checks': {
        if (ctx.policy.profile !== 'controller')
          return errorResult('TOOL_DISABLED', 'list_checks requires the controller profile');
        const checks = listControllerChecks(ctx.repoRoot);
        audit(ctx, name, 'ok', args);
        return textResult({ checks });
      }
      case 'apply_patch': {
        if (ctx.policy.profile !== 'controller')
          return errorResult('TOOL_DISABLED', 'apply_patch requires the controller profile');
        const supportedArguments = new Set([
          'operations',
          'allowed_paths',
          'refresh_fingerprints',
          // Multi-repository routing resolves these before the legacy tool
          // service and deliberately preserves the selected identity.
          'repo_id',
          'checkout_id',
          // Public Gateway execution metadata is transport/routing context,
          // not part of the Semantic Mutation Planner contract.
          'request_id',
          'apply_mode',
          'wait',
          'wait_ms',
          'admission_timeout_ms',
          'queue_timeout_ms',
          'execution_timeout_ms',
          'interactive_wait_ms',
          'cognition_settlement',
        ]);
        const unsupportedArguments = Object.keys(args).filter((key) => !supportedArguments.has(key));
        if (unsupportedArguments.length > 0) {
          const message = 'unsupported apply_patch arguments: ' + unsupportedArguments.join(', ');
          audit(ctx, name, 'blocked', args, undefined, message);
          return errorResult('SAFE_PATCH_ARGUMENTS_UNSUPPORTED', message, { fields: unsupportedArguments });
        }
        const identity = mcpRepositoryIdentity(ctx);
        const controllerHome = ctx.runtimeControllerHome?.trim() || resolveRepoPreferredControllerHome(ctx.repoRoot);
        const repository = resolveRepositorySelection({
          repoId: identity.repoId,
          checkoutId: identity.checkoutId,
          controllerHome,
        });
        try {
          const applied = withMcpRepositoryMutation(
            ctx,
            name,
            () =>
              applySessionlessMutationBatch(repository, {
                operations: args.operations,
                allowedPaths: stringList(args.allowed_paths),
                refreshFingerprints: args.refresh_fingerprints === true,
              }),
            buildMcpSourceClaims(ctx, extractPatchPaths(args.operations)),
          );
          audit(ctx, name, applied.status === 'failed' ? 'failed' : 'ok', args);
          return textResult(applied);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const code = leadingErrorCode(message, 'SAFE_PATCH_APPLY_FAILED');
          audit(ctx, name, 'failed', args, undefined, message);
          return errorResult(code, message);
        }
      }
      case 'list_workflow_files': {
        const files = workflowFileCandidates(ctx.repoRoot)
          .filter((path) => resolveMcpPath(ctx.repoRoot, path, ctx.policy, 'read').ok)
          .map((path) => fileSummary(path, ctx.repoRoot))
          .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
          .filter((entry) => entry.size <= ctx.policy.maxFileBytes);
        audit(ctx, name, 'ok', args);
        return textResult({ files });
      }
      case 'read_workflow_file': {
        const path = typeof args.path === 'string' ? args.path : '';
        const decision = resolveMcpPath(ctx.repoRoot, path, ctx.policy, 'read');
        if (!decision.ok || !decision.absolutePath || !decision.relativePath) {
          audit(ctx, name, 'blocked', args, path, decision.reason);
          return errorResult('POLICY_DENIED', decision.reason ?? 'path denied', { path });
        }
        const fileStat = statSync(decision.absolutePath);
        if (!fileStat.isFile()) return errorResult('NOT_A_FILE', `path is not a file: ${decision.relativePath}`);
        if (fileStat.size > ctx.policy.maxFileBytes)
          return errorResult('FILE_TOO_LARGE', `file exceeds ${ctx.policy.maxFileBytes} bytes`);
        const bytes = readFileSync(decision.absolutePath);
        if (isProbablyBinary(bytes)) return errorResult('BINARY_FILE', 'binary files are not supported');
        const raw = bytes.toString('utf-8');
        const redacted = redactMcpText(raw);
        audit(ctx, name, 'ok', args, decision.relativePath);
        const payload = {
          path: decision.relativePath,
          size: fileStat.size,
          sha256: sha256(raw),
          redactions: redacted.redactions,
          content: redacted.text,
        };
        return textResult(payload, {
          path: payload.path,
          size: payload.size,
          sha256: payload.sha256,
          redactions: payload.redactions,
        });
      }
      case 'latest_session_context': {
        const paths = ['.ai/harness/session/resume.md', '.ai/harness/session/continuation.md'];
        const handoff = paths.map((path) => {
          const decision = resolveMcpPath(ctx.repoRoot, path, ctx.policy, 'read');
          if (!decision.ok || !decision.absolutePath || !existsSync(decision.absolutePath))
            return { path, exists: false };
          const content = redactMcpText(readFileSync(decision.absolutePath, 'utf-8')).text;
          return {
            path,
            exists: true,
            preview: content.split(/\r?\n/).slice(0, 24).join('\n'),
          };
        });
        audit(ctx, name, 'ok', args);
        return textResult({ sessionContext: handoff });
      }
      case 'latest_checks': {
        const controllerHome = ctx.runtimeControllerHome?.trim() || resolveRepoPreferredControllerHome(ctx.repoRoot);
        const repoId =
          ctx.repoId?.trim() ||
          resolveRepositorySelection({
            explicitPath: ctx.repoRoot,
            controllerHome,
            allowSoleRepository: true,
          }).repoId;
        const storage = resolveRepositoryCheckStorage(ctx.repoRoot, { controllerHome, repoId });
        const relativeFiles: string[] = [];
        listFilesUnder(storage.physicalRoot, '.', 700, relativeFiles);
        const files = relativeFiles
          .map((path) => path.replace(/^\.\//, ''))
          .filter((path) => !path.startsWith('locks/'))
          .map((path) => {
            const summary = fileSummary(path, storage.physicalRoot);
            return summary ? { ...summary, path: `controller-home://checks/${path}` } : null;
          })
          .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
          .sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt))
          .slice(0, 20);
        audit(ctx, name, 'ok', args);
        return textResult({ files });
      }
      case 'run_chatgpt_browser_consult': {
        if (ctx.enableChatgptBrowser !== true)
          return errorResult('TOOL_DISABLED', 'ChatGPT browser tools require forge mcp serve --enable-chatgpt-browser');
        const result = await runBrowserConsult({
          repoRoot: ctx.repoRoot,
          title: typeof args.title === 'string' ? args.title : undefined,
          prompt: String(args.prompt ?? ''),
          files: stringList(args.files).map((path) => ({ path })),
          followups: stringList(args.followups),
          model: typeof args.model === 'string' ? args.model : undefined,
          thinking: parseThinking(args.thinking),
          provider: parseBrowserProvider(args.provider),
          browserChannel: parseNativeBrowserChannel(args.browserChannel),
          writeOutput: typeof args.writeOutput === 'string' ? args.writeOutput : undefined,
          writeOutputPolicy: 'mcp',
          overwriteOutput: args.overwriteOutput === true,
          timeoutMs: typeof args.timeoutMs === 'number' ? args.timeoutMs : undefined,
          dryRun: args.dryRun === true,
        });
        audit(ctx, name, result.error ? 'failed' : 'ok', args, result.meta.output.outputPath, result.error?.message);
        return textResult({
          sessionId: result.sessionId,
          status: result.status,
          output: result.output,
          conversationUrl: result.conversationUrl,
          paths: {
            sessionDir: result.paths.sessionDir,
            output: result.paths.output,
            transcript: result.paths.transcript,
          },
          dryRun: result.dryRun,
          error: result.error,
        });
      }
      case 'read_chatgpt_browser_session': {
        if (ctx.enableChatgptBrowser !== true)
          return errorResult('TOOL_DISABLED', 'ChatGPT browser tools require forge mcp serve --enable-chatgpt-browser');
        const sessionId = String(args.sessionId ?? '').trim();
        const session = readSession(ctx.repoRoot, sessionId);
        audit(ctx, name, 'ok', args);
        return textResult({
          meta: session.meta,
          output: session.output,
          transcript: session.transcript,
        });
      }
      case 'list_chatgpt_browser_sessions': {
        if (ctx.enableChatgptBrowser !== true)
          return errorResult('TOOL_DISABLED', 'ChatGPT browser tools require forge mcp serve --enable-chatgpt-browser');
        const limit =
          typeof args.limit === 'number' && Number.isInteger(args.limit) && args.limit > 0 ? args.limit : 20;
        const sessions = listSessions(ctx.repoRoot, limit);
        audit(ctx, name, 'ok', args);
        return textResult({ sessions });
      }
      case 'open_chatgpt_browser_session': {
        if (ctx.enableChatgptBrowser !== true)
          return errorResult('TOOL_DISABLED', 'ChatGPT browser tools require forge mcp serve --enable-chatgpt-browser');
        const sessionId = String(args.sessionId ?? '').trim();
        const result = openSession(ctx.repoRoot, sessionId, false);
        audit(ctx, name, 'ok', args);
        return textResult({ sessionId, url: result.url, launched: false });
      }
      case 'continue_chatgpt_browser_session': {
        if (ctx.enableChatgptBrowser !== true)
          return errorResult('TOOL_DISABLED', 'ChatGPT browser tools require forge mcp serve --enable-chatgpt-browser');
        const sessionId = String(args.sessionId ?? '').trim();
        const prompt = String(args.prompt ?? '').trim();
        const result = await runBrowserFollowup({
          repoRoot: ctx.repoRoot,
          sessionId,
          title: `followup ${sessionId}`,
          prompt,
          dryRun: args.dryRun === true,
        });
        audit(ctx, name, result.error ? 'failed' : 'ok', args, result.meta.output.outputPath, result.error?.message);
        return textResult({
          sourceSessionId: sessionId,
          sessionId: result.sessionId,
          status: result.status,
          output: result.output,
          paths: {
            output: result.paths.output,
            transcript: result.paths.transcript,
          },
          error: result.error,
        });
      }
      default:
        audit(ctx, name, 'blocked', args);
        return errorResult('UNKNOWN_TOOL', `unknown tool: ${name}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    audit(ctx, name, 'failed', args, undefined, message);
    return errorResult('TOOL_FAILED', message);
  }
}
