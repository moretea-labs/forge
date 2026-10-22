import type { CallToolResult, McpToolDefinition } from '../../../packages/protocols/mcp/tool-contract';
export type { CallToolResult, McpToolDefinition } from '../../../packages/protocols/mcp/tool-contract';
import { createHash } from "crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, appendFileSync } from "fs";
import { dirname, join } from "path";
import { beginEditSession, applyEditOperations, createEditSavepoint, EditSessionPatchError, finalizeEditSession, getEditSession, getEditSessionDiff, listEditSessions, PREFERRED_EDIT_PATCH_BATCH_OPERATIONS, rollbackEditSession } from "../../../src/cli/editing/edit-session";
import { EDIT_OPERATION_INPUT_SCHEMA, normalizeEditOperations } from "../../../src/cli/editing/edit-operation-contract";
import { withRepositoryMutationExclusion } from '../../../src/runtime/resources/leases/store';
import { listAgentJobs } from "../../../src/cli/agent-jobs/job-manager";
import { listControllerChecks } from "../../../src/cli/controller/check-runner";
import { buildExecutionDiagnostics, buildRequirementBoard } from '../../../src/runtime/control-plane/facade/requirement-board';
import { getWorkContract } from '../../../packages/kernel/work/api';
import { listCapabilityDescriptors, summarizeCapabilityGroups } from '../../../src/runtime/control-plane/facade/capability-registry';
import { exportControllerWorklog, listControllerWorklogEvents, parseWorklogCategory } from "../../../src/cli/controller/worklog";
import { FORGE_MCP_SCHEMA_VERSION, FORGE_TOOL_SURFACE, FORGE_VERSION, forgeToolSurfaceFingerprint, formatDurationMs, normalizeAgentTimeoutMs } from "../../../src/cli/controller/runtime-config";
import { PREFERRED_FACADE_TOOL_NAMES } from "../toolset-names";
import { buildLocalConnectorStatusForRepo } from "../../../src/cli/local-bridge/connector-freshness";
import { gitSnapshot } from "../../../src/cli/repository/inspector";
import { listLocalBridgeJobs } from "../../../src/cli/local-bridge/job-store";
import { listSessions, openSession, readSession, runBrowserConsult, runBrowserFollowup } from "../../../src/cli/chatgpt-browser/engine";
import type { BrowserProviderName, NativeBrowserChannel, ThinkingLevel } from "../../../src/cli/chatgpt-browser/types";
import { hashMcpInput, tryWriteMcpAuditEntry } from "../audit";
import { resolveRepoPreferredControllerHome } from "../../../src/effects/controller-home";
import { resolveRepositoryCheckStorage } from '../../../src/runtime/execution/process-runtime/check-storage';
import { resolveRepositorySelection } from '../../../src/cli/repositories/registry';
import { ensureRepositoryRuntimeStorageBinding } from '../../../src/cli/repositories/runtime-storage';
import { resolveMcpPath } from "../paths";
import { currentGitBranch, isForgeAdopted } from "../repo";
import { redactMcpText } from "../redaction";
import type { McpPolicy } from "../types";

export interface McpToolContext {
  repoRoot: string;
  policy: McpPolicy;
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


const EMPTY_SCHEMA = { type: "object", additionalProperties: false };

function textResult(
  value: unknown,
  structuredContent: unknown = typeof value === "string" ? undefined : value,
): CallToolResult {
  const normalizedStructuredContent = structuredContent as Record<string, unknown> | undefined;
  return {
    content: [
      {
        type: "text",
        text:
          typeof value === "string" ? value : JSON.stringify(value, null, 2),
      },
    ],
    structuredContent: normalizedStructuredContent,
  };
}

function errorResult(
  code: string,
  message: string,
  details?: unknown,
): CallToolResult {
  const result = textResult({
    error: { code, message: redactMcpText(message).text, details },
  });
  result.isError = true;
  return result;
}


function audit(
  ctx: McpToolContext,
  tool: string,
  status: "ok" | "blocked" | "failed",
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
  return createHash("sha256").update(value).digest("hex");
}

function editExecutionIdentity(ctx: McpToolContext): {
  repoId: string;
  checkoutId: string;
  principalId: string;
  controllerInstanceId: string;
} {
  const local = sha256(ctx.repoRoot).slice(0, 16);
  return {
    repoId: ctx.repoId?.trim() || `repo-local-${local}`,
    checkoutId: ctx.checkoutId?.trim() || `checkout-local-${local}`,
    principalId: ctx.principalId?.trim() || 'legacy-controller',
    controllerInstanceId: ctx.controllerInstanceId?.trim() || 'legacy-controller',
  };
}

/**
 * Existing repository mutation lock, shared with safe_patch_apply and the
 * Local Bridge editor. Keep the whole synchronous edit primitive under one
 * lock; no nested lock in edit-session.ts, and no second mutation authority.
 */
function withLegacyEditMutation<T>(ctx: McpToolContext, operation: string, mutate: () => T): T {
  const controllerHome = ctx.runtimeControllerHome?.trim() || resolveRepoPreferredControllerHome(ctx.repoRoot);
  const repoId = ctx.repoId?.trim() || resolveRepositorySelection({
    explicitPath: ctx.repoRoot,
    controllerHome,
    allowSoleRepository: true,
  }).repoId;
  return withRepositoryMutationExclusion(controllerHome, repoId, `mcp:${operation}`, mutate);
}

function fileSummary(
  path: string,
  repoRoot: string,
): { path: string; size: number; modifiedAt: string } | null {
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
    if (!from || !from.startsWith("/")) return;
    replacements.set(from, to);
  };
  remember(repoRoot, "<repo>");
  remember(run.executionRoot, "<execution-root>");
  remember(run.worktreePath, "<worktree>");
  remember(run.worktree, run.worktree === repoRoot ? "<repo>" : "<worktree>");
  return [...replacements.entries()]
    .sort((left, right) => right[0].length - left[0].length)
    .map(([from, to]) => ({ from, to }));
}








const PROJECT_BOARD_RECENT_ISSUE_LIMIT = 5;
const PROJECT_BOARD_TASK_LIMIT = 8;





const UPDATE_TASK_SUMMARY_TASK_LIMIT = 12;





function listFilesUnder(
  repoRoot: string,
  root: string,
  maxFiles: number,
  out: string[],
): void {
  if (out.length >= maxFiles) return;
  const absoluteRoot = join(repoRoot, root);
  if (!existsSync(absoluteRoot)) return;
  const rootStat = statSync(absoluteRoot);
  if (rootStat.isFile()) {
    out.push(root);
    return;
  }
  if (!rootStat.isDirectory()) return;
  for (const entry of readdirSync(absoluteRoot, { withFileTypes: true }).sort(
    (a, b) => a.name.localeCompare(b.name),
  )) {
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
    "AGENTS.md",
    "CLAUDE.md",
    "SKILL.md",
    "docs/spec.md",
    "docs/domain-rules.md",
    "docs/project/chatgpt-planning-profile.md",
    "docs/reference-configs",
    "docs/mvp2",
    ".spec-workflow/specs",
    "ios/AGENTS.md",
    "plans",
    "tasks",
    ".ai/context",
    ".ai/harness/session",
    ".ai/harness/controller/packets",
    ".ai/harness/projections",
    ".ai/harness/checks",
  ];
  const files: string[] = [];
  for (const root of roots) {
    const rootFiles: string[] = [];
    listFilesUnder(repoRoot, root, 700, rootFiles);
    files.push(...rootFiles);
  }
  return Array.from(new Set(files)).sort();
}

function slugify(input: string): string {
  return (
    input
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "artifact"
  );
}

function timestampPrefix(date = new Date()): string {
  const yyyy = String(date.getFullYear());
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const min = String(date.getMinutes()).padStart(2, "0");
  return `${yyyy}${mm}${dd}-${hh}${min}`;
}



function runnerTimeoutMs(ctx: McpToolContext, value: unknown): number {
  return normalizeAgentTimeoutMs(value, {
    defaultMs: ctx.policy.execution.runnerTimeoutMs,
    maxMs: ctx.policy.execution.runnerMaxTimeoutMs,
    label: "timeout_ms",
  });
}

function prdArtifactPath(slug: string): string {
  const normalized = slugify(slug);
  const prefixed = /^\d{8}-\d{4}-/.test(normalized)
    ? normalized
    : `${timestampPrefix()}-${normalized}`;
  return `plans/prds/${prefixed}.prd.md`;
}

function sprintArtifactPath(slug: string): string {
  const normalized = slugify(slug);
  const prefixed = /^\d{8}-\d{4}-/.test(normalized)
    ? normalized
    : `${timestampPrefix()}-${normalized}`;
  return `plans/sprints/${prefixed}.sprint.md`;
}

function frontmatter(title: string, kind: string): string {
  return [
    "---",
    `title: ${JSON.stringify(title)}`,
    `kind: ${JSON.stringify(kind)}`,
    `created_at: ${JSON.stringify(new Date().toISOString())}`,
    `source: "forge-mcp"`,
    "---",
    "",
  ].join("\n");
}

function bodyWithFrontmatter(
  title: string,
  kind: string,
  body: string,
): string {
  return body.trimStart().startsWith("---")
    ? body.trimEnd() + "\n"
    : `${frontmatter(title, kind)}${body.trimEnd()}\n`;
}

function writeMarkdownArtifact(
  ctx: McpToolContext,
  tool: string,
  relativePath: string,
  title: string,
  kind: string,
  body: string,
  overwrite: boolean,
  input: unknown,
  extra?: Record<string, unknown>,
): CallToolResult {
  const decision = resolveMcpPath(
    ctx.repoRoot,
    relativePath,
    ctx.policy,
    "write",
  );
  if (!decision.ok || !decision.absolutePath) {
    audit(ctx, tool, "blocked", input, relativePath, decision.reason);
    return errorResult("POLICY_DENIED", decision.reason ?? "path denied", {
      path: relativePath,
    });
  }
  if (existsSync(decision.absolutePath) && !overwrite) {
    audit(
      ctx,
      tool,
      "blocked",
      input,
      relativePath,
      "target exists and overwrite was not requested",
    );
    return errorResult(
      "WOULD_OVERWRITE",
      `target already exists: ${relativePath}`,
    );
  }
  mkdirSync(dirname(decision.absolutePath), { recursive: true });
  writeFileSync(
    decision.absolutePath,
    bodyWithFrontmatter(title, kind, body),
    "utf-8",
  );
  audit(ctx, tool, "ok", input, relativePath);
  return textResult({
    status: "written",
    path: relativePath,
    ...(extra ?? {}),
  });
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => String(entry).trim())
    .filter((entry) => entry.length > 0);
}

function taskObjects(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is Record<string, unknown> =>
      typeof entry === "object" && entry !== null && !Array.isArray(entry),
  );
}

interface TaskVerificationLeaseConflict {
  message: string;
  resourceKey?: string;
  blockingProcessId?: string;
}




function renderPrdFromIdeaBody(args: Record<string, unknown>): string {
  const title = String(args.title ?? "Untitled PRD").trim() || "Untitled PRD";
  const idea = String(args.idea ?? "").trim();
  const problem =
    String(args.problem ?? "").trim() ||
    "TBD: clarify the concrete user or workflow pain.";
  const users = stringList(args.users);
  const goals = stringList(args.goals);
  const nonGoals = stringList(args.non_goals);
  const success = stringList(args.success_criteria);
  const notes = String(args.notes ?? "").trim();
  return [
    `# ${title}`,
    "",
    "> **Status**: Draft",
    "",
    "## Idea",
    "",
    idea || "TBD: summarize the originating idea.",
    "",
    "## Problem",
    "",
    problem,
    "",
    "## Users",
    "",
    ...(users.length > 0 ? users.map((entry) => `- ${entry}`) : ["- TBD"]),
    "",
    "## Goals",
    "",
    ...(goals.length > 0
      ? goals.map((entry) => `- ${entry}`)
      : ["- Turn the idea into a reviewable forge PRD."]),
    "",
    "## Non-goals",
    "",
    ...(nonGoals.length > 0
      ? nonGoals.map((entry) => `- ${entry}`)
      : ["- Directly executing implementation work from ChatGPT."]),
    "",
    "## Acceptance Criteria",
    "",
    ...(success.length > 0
      ? success.map((entry) => `- [ ] ${entry}`)
      : [
          "- [ ] The PRD can be converted into a checklist Sprint with staged verification gates.",
        ]),
    "",
    "## Workflow Contract",
    "",
    "- PRD is the source of product intent.",
    "- Sprint must be generated as ordered checklist task cards.",
    "- Codex execution must happen through a host-native `/goal` prompt or local Codex session, not through remote MCP execution.",
    "",
    "## Handoff Notes",
    "",
    notes || "- Generated from an idea through forge MCP.",
  ].join("\n");
}

function renderChecklistSprintBody(args: Record<string, unknown>): string {
  const title =
    String(args.title ?? "Checklist Sprint").trim() || "Checklist Sprint";
  const prdPath = String(args.prd_path ?? "").trim();
  const tasks = taskObjects(args.tasks);
  const taskBlocks =
    tasks.length > 0
      ? tasks.map((task, index) => {
          const taskTitle =
            String(task.title ?? `Task ${index + 1}`).trim() ||
            `Task ${index + 1}`;
          const objective =
            String(task.objective ?? "").trim() ||
            "Complete the scoped implementation slice.";
          const files = stringList(task.files);
          const checks = stringList(task.checks);
          const stageGate =
            String(task.stage_gate ?? "").trim() ||
            "Update this checklist, run relevant checks, and stage the completed slice before continuing.";
          return [
            `### Task Card ${index + 1}: ${taskTitle}`,
            "",
            `- [ ] Objective: ${objective}`,
            `- [ ] Files/entrypoints: ${files.length > 0 ? files.map((entry) => `\`${entry}\``).join(", ") : "TBD during execution"}`,
            `- [ ] Verification: ${checks.length > 0 ? checks.map((entry) => `\`${entry}\``).join(", ") : "Focused check for this slice"}`,
            `- [ ] Stage gate: ${stageGate}`,
          ].join("\n");
        })
      : [
          [
            "### Task Card 1: Plan the first implementation slice",
            "",
            "- [ ] Objective: Derive the first concrete implementation slice from the PRD.",
            "- [ ] Files/entrypoints: TBD during execution",
            "- [ ] Verification: Focused check for this slice",
            "- [ ] Stage gate: Update this checklist, run relevant checks, and stage the completed slice before continuing.",
          ].join("\n"),
        ];

  return (
    [
      `# ${title}`,
      "",
      "> **Status**: Draft",
      "",
      "## Source",
      "",
      `- PRD: \`${prdPath || "TBD"}\``,
      "",
      "## Execution Rule",
      "",
      "- Execute task cards in order.",
      "- Keep each task card reviewable as one staged slice.",
      "- After every completed phase, update the checklist and stage the result before continuing.",
      "- Do not treat unstaged work as a completed phase.",
      "",
      "## Checklist",
      "",
      ...taskBlocks.flatMap((block) => [block, ""]),
      "## Final Acceptance",
      "",
      "- [ ] All task cards are checked.",
      "- [ ] Required checks pass.",
      "- [ ] Handoff explains staged state, residual risks, and next bottleneck if any.",
    ]
      .join("\n")
      .trimEnd() + "\n"
  );
}

function parseThinking(value: unknown): ThinkingLevel | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (
    value === "light" ||
    value === "standard" ||
    value === "extended" ||
    value === "heavy"
  )
    return value;
  throw new Error(`invalid thinking level: ${String(value)}`);
}

function parseBrowserProvider(value: unknown): BrowserProviderName | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (value === "oracle" || value === "native") return value;
  throw new Error(`invalid browser provider: ${String(value)}`);
}

function parseNativeBrowserChannel(
  value: unknown,
): NativeBrowserChannel | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (
    value === "chrome" ||
    value === "chrome-beta" ||
    value === "chrome-dev" ||
    value === "chrome-canary"
  )
    return value;
  throw new Error(`invalid browser channel: ${String(value)}`);
}

export function buildMcpToolDefinitions(
  policy: McpPolicy,
  opts: { enableChatgptBrowser?: boolean } = {},
): McpToolDefinition[] {
  const readOnly = { readOnlyHint: true, openWorldHint: false };
  const write = {
    readOnlyHint: false,
    openWorldHint: false,
    destructiveHint: false,
  };
  const stringPathSchema = {
    type: "object",
    properties: { path: { type: "string" } },
    required: ["path"],
    additionalProperties: false,
  };
  const markdownWriterSchema = {
    type: "object",
    properties: {
      title: { type: "string" },
      slug: { type: "string" },
      body: { type: "string" },
      overwrite: { type: "boolean" },
    },
    required: ["title", "slug", "body"],
    additionalProperties: false,
  };
  const ideaPrdSchema = {
    type: "object",
    properties: {
      title: { type: "string" },
      slug: { type: "string" },
      idea: { type: "string" },
      problem: { type: "string" },
      users: { type: "array", items: { type: "string" } },
      goals: { type: "array", items: { type: "string" } },
      non_goals: { type: "array", items: { type: "string" } },
      success_criteria: { type: "array", items: { type: "string" } },
      notes: { type: "string" },
      overwrite: { type: "boolean" },
    },
    required: ["title", "slug", "idea"],
    additionalProperties: false,
  };
  const checklistSprintSchema = {
    type: "object",
    properties: {
      title: { type: "string" },
      slug: { type: "string" },
      prd_path: { type: "string" },
      tasks: {
        type: "array",
        items: {
          type: "object",
          properties: {
            title: { type: "string" },
            objective: { type: "string" },
            files: { type: "array", items: { type: "string" } },
            checks: { type: "array", items: { type: "string" } },
            stage_gate: { type: "string" },
          },
          required: ["title", "objective"],
          additionalProperties: false,
        },
      },
      overwrite: { type: "boolean" },
    },
    required: ["title", "slug", "prd_path", "tasks"],
    additionalProperties: false,
  };
  const browserRunSchema = {
    type: "object",
    properties: {
      prompt: { type: "string" },
      title: { type: "string" },
      files: { type: "array", items: { type: "string" } },
      model: { type: "string" },
      thinking: {
        type: "string",
        enum: ["light", "standard", "extended", "heavy"],
      },
      provider: { type: "string", enum: ["oracle", "native"] },
      browserChannel: {
        type: "string",
        enum: ["chrome", "chrome-beta", "chrome-dev", "chrome-canary"],
      },
      followups: { type: "array", items: { type: "string" } },
      writeOutput: { type: "string" },
      overwriteOutput: { type: "boolean" },
      timeoutMs: { type: "number" },
      dryRun: { type: "boolean" },
    },
    required: ["prompt"],
    additionalProperties: false,
  };
  const browserSessionSchema = {
    type: "object",
    properties: { sessionId: { type: "string" } },
    required: ["sessionId"],
    additionalProperties: false,
  };
  const tools: McpToolDefinition[] = [
    {
      name: "harness_status",
      description: "Return forge adoption and workflow status.",
      inputSchema: EMPTY_SCHEMA,
      annotations: readOnly,
    },
    {
      name: "harness_doctor",
      description: "Return compact MCP setup diagnostics.",
      inputSchema: EMPTY_SCHEMA,
      annotations: readOnly,
    },
    {
      name: "list_workflow_files",
      description: "List policy-readable workflow files.",
      inputSchema: EMPTY_SCHEMA,
      annotations: readOnly,
    },
    {
      name: "read_workflow_file",
      description:
        "Read one policy-allowed workflow file by repo-relative path.",
      inputSchema: stringPathSchema,
      annotations: readOnly,
    },
    {
      name: "latest_session_context",
      description: "Return the latest rebuildable Forge session continuation context.",
      inputSchema: EMPTY_SCHEMA,
      annotations: readOnly,
    },
    {
      name: "latest_checks",
      description: "Return latest forge check artifacts.",
      inputSchema: EMPTY_SCHEMA,
      annotations: readOnly,
    },
    {
      name: "list_prds",
      description: "List PRD artifacts under plans/prds.",
      inputSchema: EMPTY_SCHEMA,
      annotations: readOnly,
    },
    {
      name: "list_sprints",
      description: "List sprint artifacts under plans/sprints.",
      inputSchema: EMPTY_SCHEMA,
      annotations: readOnly,
    },
    {
      name: "summarize_forge_state",
      description: "Return a compact planning state summary.",
      inputSchema: EMPTY_SCHEMA,
      annotations: readOnly,
    },
    {
      name: "write_prd",
      description: "Write a PRD under plans/prds/*.prd.md.",
      inputSchema: markdownWriterSchema,
      annotations: write,
    },
    {
      name: "write_prd_from_idea",
      description:
        "Turn a product idea into a strict-compatible draft PRD under plans/prds/*.prd.md.",
      inputSchema: ideaPrdSchema,
      annotations: write,
    },
    {
      name: "write_sprint",
      description: "Write a sprint under plans/sprints/*.sprint.md.",
      inputSchema: markdownWriterSchema,
      annotations: write,
    },
    {
      name: "write_checklist_sprint",
      description:
        "Turn a PRD into an ordered checklist Sprint with per-phase staging gates.",
      inputSchema: checklistSprintSchema,
      annotations: write,
    },
    {
      name: "write_plan",
      description: "Write an implementation plan under plans/plan-*.md.",
      inputSchema: markdownWriterSchema,
      annotations: write,
    },
    {
      name: "append_controller_plan_note",
      description: "Append a timestamped ChatGPT planning note to the controller packet cache.",
      inputSchema: {
        type: "object",
        properties: { actor: { type: "string" }, body: { type: "string" } },
        required: ["body"],
        additionalProperties: false,
      },
      annotations: write,
    },
  ];

  if (policy.profile === "controller") {
    const taskItemSchema = {
      type: "object",
      properties: {
        title: { type: "string" },
        objective: { type: "string" },
        depends_on: { type: "array", items: { type: "string" } },
        allowed_paths: { type: "array", items: { type: "string" } },
        forbidden_paths: { type: "array", items: { type: "string" } },
        checks: { type: "array", items: { type: "string" } },
        acceptance_criteria: { type: "array", items: { type: "string" } },
        risk: { type: "string", enum: ["readonly", "low", "medium", "high", "destructive"] },
        agent: { type: "string", enum: ["codex", "claude", "github-copilot"] },
      },
      required: ["title", "objective"],
      additionalProperties: false,
    };
    tools.push(
      {
        name: "controller_capabilities",
        description:
          "Return the active controller tool-surface version and expected capabilities. Use this to detect a stale ChatGPT connector tool snapshot.",
        inputSchema: EMPTY_SCHEMA,
        annotations: readOnly,
      },
      {
        name: "local_bridge_status",
        description:
          "Return Local Bridge / Local Controller status. Default is a compact summary (mode, endpoint, health, job counts). Pass detail_level=detail for full recentJobs, reconciliation, and owner evidence.",
        inputSchema: {
          type: "object",
          properties: {
            detail_level: {
              type: "string",
              enum: ["summary", "detail"],
              description: "Defaults to summary. Use detail for full job lists and diagnostics.",
            },
            detail: {
              type: "boolean",
              description: "Legacy alias for detail_level=detail.",
            },
          },
          additionalProperties: false,
        },
        annotations: readOnly,
      },
      {
        name: "controller_context",
        description:
          "Return one compact controller start-work context: Git status, current Issue focus, active Runs and Jobs, and available checks.",
        inputSchema: {
          type: "object",
          properties: {
            description: { type: "string" },
            known_paths: { type: "array", items: { type: "string" } },
            needs_dependencies: { type: "boolean" },
            risk: { type: "string", enum: ["readonly", "low", "medium", "high", "destructive"] },
          },
          additionalProperties: false,
        },
        annotations: readOnly,
      },
      {
        name: "list_local_jobs",
        description: "List recent local Job Tickets and execution state.",
        inputSchema: {
          type: "object",
          properties: { limit: { type: "number" } },
          additionalProperties: false,
        },
        annotations: readOnly,
      },
      {
        name: "get_local_job",
        description: "Read one local Job Ticket status and compact metadata.",
        inputSchema: {
          type: "object",
          properties: {
            job_id: { type: "string" },
            include_events: { type: "boolean" },
          },
          required: ["job_id"],
          additionalProperties: false,
        },
        annotations: readOnly,
      },
      {
        name: "get_local_job_output",
        description: "Read bounded stdout or stderr for one local Job Ticket.",
        inputSchema: {
          type: "object",
          properties: {
            job_id: { type: "string" },
            stream: { type: "string", enum: ["stdout", "stderr"] },
            max_bytes: { type: "number" },
          },
          required: ["job_id"],
          additionalProperties: false,
        },
        annotations: readOnly,
      },
      {
        name: "project_snapshot",
        description:
          "Return Git state, controller issue board, active task runs, and workflow markers.",
        inputSchema: EMPTY_SCHEMA,
        annotations: readOnly,
      },
      {
        name: "list_checks",
        description:
          "List focused repository checks from safe package scripts and .forge/checks.json.",
        inputSchema: EMPTY_SCHEMA,
        annotations: readOnly,
      },
      {
        name: "get_worklog_timeline",
        description:
          "Read the unified controller worklog across Issues, Tasks, Runs, Direct Edits, Verification, and GitHub sync.",
        inputSchema: {
          type: "object",
          properties: {
            category: { type: "string", enum: ["issue", "task", "run", "verification", "edit", "github", "local_job", "system"] },
            issue_id: { type: "string" },
            task_id: { type: "string" },
            run_id: { type: "string" },
            edit_session_id: { type: "string" },
            since: { type: "string" },
            until: { type: "string" },
            limit: { type: "number" },
          },
          additionalProperties: false,
        },
        annotations: readOnly,
      },
      {
        name: "export_worklog",
        description:
          "Export the controller worklog to a repository report under tasks/reports or another safe repo-relative path.",
        inputSchema: {
          type: "object",
          properties: {
            format: { type: "string", enum: ["markdown", "json"] },
            output_path: { type: "string" },
            issue_id: { type: "string" },
            task_id: { type: "string" },
            run_id: { type: "string" },
            edit_session_id: { type: "string" },
          },
          additionalProperties: false,
        },
        annotations: write,
      },
      {
        name: "begin_edit_session",
        description:
          "Open a bounded direct-edit session tied to a purpose and optional Issue/Task.",
        inputSchema: {
          type: "object",
          properties: {
            purpose: { type: "string" },
            work_id: { type: "string", description: "Optional existing WorkContract. Omit for a Work-independent direct-edit transaction." },
            issue_id: { type: "string" },
            task_id: { type: "string" },
            allowed_paths: { type: "array", items: { type: "string" } },
            max_files: { type: "number" },
            max_changed_lines: { type: "number" },
            checks: { type: "array", items: { type: "string" }, description: "Named checks to run before finalization." },
          },
          required: ["purpose"],
          additionalProperties: false,
        },
        annotations: write,
      },
      {
        name: "apply_patch",
        description:
          "Append one bounded patch batch to an active edit session. Prefer batches of 100 operations or fewer and pass expected_revision to avoid stale revisions.",
        inputSchema: {
          type: "object",
          properties: {
            session_id: { type: "string" },
            expected_revision: { type: "number", description: "Optional current revision precondition for the edit session." },
            operations: {
              type: "array",
              items: EDIT_OPERATION_INPUT_SCHEMA,
            },
          },
          required: ["session_id", "operations"],
          additionalProperties: false,
        },
        annotations: {
          readOnlyHint: false,
          openWorldHint: false,
          destructiveHint: false,
        },
      },
      {
        name: "get_edit_session",
        description: "Read an edit session, revisions, savepoints, and operation manifest.",
        inputSchema: {
          type: "object",
          properties: { session_id: { type: "string" } },
          required: ["session_id"],
          additionalProperties: false,
        },
        annotations: readOnly,
      },
      {
        name: "list_edit_sessions",
        description: "List recent direct-edit sessions with revision, changed-file, and check summaries.",
        inputSchema: {
          type: "object",
          properties: { limit: { type: "number" } },
          additionalProperties: false,
        },
        annotations: readOnly,
      },
      {
        name: "get_edit_session_diff",
        description: "Read the current aggregate localized diff for one direct-edit session.",
        inputSchema: {
          type: "object",
          properties: { session_id: { type: "string" } },
          required: ["session_id"],
          additionalProperties: false,
        },
        annotations: readOnly,
      },
      {
        name: "create_edit_savepoint",
        description: "Name the current edit revision so later patch batches can be rolled back to it.",
        inputSchema: {
          type: "object",
          properties: {
            session_id: { type: "string" },
            name: { type: "string" },
          },
          required: ["session_id", "name"],
          additionalProperties: false,
        },
        annotations: write,
      },
      {
        name: "verify_edit_session",
        description: "Verify the current edit revision through persisted Process Runtime checks. Retries with the same request_id reuse the original process and terminal receipts are attached to the exact revision.",
        inputSchema: {
          type: "object",
          properties: {
            session_id: { type: "string" },
            check_ids: { type: "array", items: { type: "string" } },
            request_id: { type: "string" },
            reviewer: { type: "string" },
            note: { type: "string" },
          },
          required: ["session_id"],
          additionalProperties: false,
        },
        annotations: write,
      },
      {
        name: "rollback_edit_session",
        description:
          "Rollback an active edit session completely, to a prior revision, or to a named savepoint.",
        inputSchema: {
          type: "object",
          properties: {
            session_id: { type: "string" },
            to_revision: { type: "number", description: "Keep revisions up to this value; omit for full rollback." },
            savepoint: { type: "string", description: "Rollback to a named savepoint." },
          },
          required: ["session_id"],
          additionalProperties: false,
        },
        annotations: {
          readOnlyHint: false,
          openWorldHint: false,
          destructiveHint: false,
        },
      },
      {
        name: "finalize_edit_session",
        description:
          "Close an active edit session. Configured checks must pass; sessions without configured checks finalize directly.",
        inputSchema: {
          type: "object",
          properties: {
            session_id: { type: "string" },
            reviewer: { type: "string" },
            note: { type: "string" },
            confirm_authorization: { type: "boolean", description: "Required when post-diff assurance detects protected paths or high semantic risk." },
          },
          required: ["session_id"],
          additionalProperties: false,
        },
        annotations: write,
      },
    );
  }

  if (opts.enableChatgptBrowser === true) {
    tools.push(
      {
        name: "run_chatgpt_browser_consult",
        description:
          "Run a local ChatGPT Web browser consult through forge. This may create a real ChatGPT Web conversation unless dryRun is true.",
        inputSchema: browserRunSchema,
        annotations: {
          readOnlyHint: false,
          openWorldHint: true,
          destructiveHint: false,
        },
      },
      {
        name: "read_chatgpt_browser_session",
        description:
          "Read a saved forge ChatGPT browser consult session.",
        inputSchema: browserSessionSchema,
        annotations: readOnly,
      },
      {
        name: "list_chatgpt_browser_sessions",
        description:
          "List saved forge ChatGPT browser consult sessions.",
        inputSchema: {
          type: "object",
          properties: { limit: { type: "number" } },
          additionalProperties: false,
        },
        annotations: readOnly,
      },
      {
        name: "open_chatgpt_browser_session",
        description:
          "Return the ChatGPT conversation URL for a saved browser session. The MCP tool does not launch the local browser.",
        inputSchema: browserSessionSchema,
        annotations: readOnly,
      },
      {
        name: "continue_chatgpt_browser_session",
        description:
          "Create a follow-up ChatGPT browser consult record linked to an existing session.",
        inputSchema: {
          type: "object",
          properties: {
            sessionId: { type: "string" },
            prompt: { type: "string" },
            dryRun: { type: "boolean" },
          },
          required: ["sessionId", "prompt"],
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
      case "harness_status": {
        const roots = [
          "docs/spec.md",
          "plans",
          "tasks/current.md",
          ".ai/harness/session",
    ".ai/harness/controller/packets",
    ".ai/harness/projections",
          ".ai/harness/checks",
        ];
        audit(ctx, name, "ok", args);
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
      case "harness_doctor": {
        const localConfig = existsSync(
          join(ctx.repoRoot, ".forge", "mcp.local.json"),
        );
        const codexConfig = existsSync(
          join(ctx.repoRoot, ".codex", "config.toml"),
        );
        audit(ctx, name, "ok", args);
        return textResult({
          status: isForgeAdopted(ctx.repoRoot)
            ? "ready_local"
            : "not_adopted",
          repo: ctx.repoRoot,
          profile: ctx.policy.profile,
          mcp: {
            localConfig,
            policy: "builtin",
            profile: ctx.policy.profile,
            toolSurface:
              ctx.policy.profile === "controller"
                ? FORGE_TOOL_SURFACE
                : `${ctx.policy.profile}-legacy-v1`,
            toolCount: buildMcpToolDefinitions(ctx.policy, {
              enableChatgptBrowser: ctx.enableChatgptBrowser === true,
            }).length,
            repositoryRead:
              ctx.policy.profile === "controller"
                ? "ordinary repository source and document files are readable; immutable secret and runtime paths remain denied"
                : "workflow-scoped",
            deniedPaths: ctx.policy.denyGlobs.length,
            runner: {
              enabled: ctx.policy.execution.agentRunner,
              defaultTimeoutMs: ctx.policy.execution.runnerTimeoutMs,
              maxTimeoutMs: ctx.policy.execution.runnerMaxTimeoutMs,
            },
          },
          codex: {
            configured: codexConfig,
            fix: codexConfig
              ? null
              : "forge mcp setup codex --repo . --scope project",
          },
          chatgpt: {
            localEndpoint: "http://127.0.0.1:8765/mcp",
            manualStepsRequired: true,
            guide: "docs/forge-chatgpt-mcp-setup.md",
          },
        });
      }
      case "controller_capabilities": {
        if (ctx.policy.profile !== "controller")
          return errorResult(
            "TOOL_DISABLED",
            "controller_capabilities requires the controller profile",
          );
        const expectedTools = ctx.publishedToolNames;
        if (!expectedTools) return errorResult(
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
        const staleConnector = connectorFreshness.status === "chatgpt_snapshot_missing_facade";
        const payload = {
          schemaVersion: FORGE_MCP_SCHEMA_VERSION,
          toolSurface: FORGE_TOOL_SURFACE,
          version: FORGE_VERSION,
          toolSurfaceFingerprint: forgeToolSurfaceFingerprint(expectedTools),
          executionModel: "chatgpt-controller-execution-bridge",
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
            editSavepoints: true,
            partialEditRollback: true,
            directEditFirstRouting: true,
            persistedEditDiffs: true,
            verifiedEditFinalization: true,
            verificationGate: true,
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
            taskLedgerProjection: true,
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
            defaultTimeout: formatDurationMs(
              ctx.policy.execution.runnerTimeoutMs,
            ),
            maxTimeoutMs: ctx.policy.execution.runnerMaxTimeoutMs,
            maxTimeout: formatDurationMs(
              ctx.policy.execution.runnerMaxTimeoutMs,
            ),
            note: "Requested timeout values are validated explicitly and are never silently reduced to the default.",
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
            note: "Prefer the five rh_* workflow facades for orchestration. Typed repository, Git, Issue/Task, plugin, browser, iOS, artifact, and recovery tools remain available because the current MCP transport cannot load domain schemas per conversation.",
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
          docs: [
            "docs/architecture/current/README.md",
            "docs/architecture/history.md",
            "docs/operations/controller-reliability-runbook.md",
            "docs/forge-github-issue-launcher.md",
            "docs/forge-chatgpt-mcp-setup.md",
          ],
          staleConnectorHint: staleConnector
            ? `Stale ChatGPT connector tool snapshot is missing facade tools: ${missingFacadeTools.join(", ")}. Refresh/reconnect MCP so tools/list reloads rh_status, rh_inbox, rh_context, and rh_work.`
            : connectorFreshness.status === "unable_to_verify_chatgpt_snapshot"
              ? `Local MCP tool surface includes preferred facade tools. ChatGPT connector snapshot was not supplied, so freshness cannot be verified from this call. If ChatGPT tools/list is missing rh_status/rh_inbox/rh_context/rh_work, reconnect MCP. Pass connector_tool_names for an exact check.`
              : connectorFreshness.status === "stale_fingerprint"
                ? `Local MCP process fingerprint/version may be stale. Restart controller/MCP, then reconnect ChatGPT if rh_* are still missing.`
                : connectorFreshness.status === "local_mcp_missing_facade"
                  ? `Local MCP tool surface is missing facade tools: ${connectorFreshness.missingLocalTools.join(", ")}. Restart controller/MCP.`
                  : `Connector clients must match ${FORGE_TOOL_SURFACE} version ${FORGE_VERSION} / schema ${FORGE_MCP_SCHEMA_VERSION}. Prefer rh_status/rh_inbox/rh_context/rh_work. Pass connector_tool_names to detect a stale ChatGPT tool snapshot precisely.`,
        };
        audit(ctx, name, "ok", args);
        return textResult(payload);
      }
      case "list_local_jobs": {
        if (ctx.policy.profile !== "controller")
          return errorResult(
            "TOOL_DISABLED",
            "list_local_jobs requires the controller profile",
          );
        const limit = typeof args.limit === "number" ? args.limit : 50;
        const jobs = listLocalBridgeJobs(ctx.repoRoot, limit);
        audit(ctx, name, "ok", args);
        return textResult({ jobs });
      }
      case "project_snapshot": {
        if (ctx.policy.profile !== "controller") return errorResult("TOOL_DISABLED", "project_snapshot requires the controller profile");
        const markerPaths = [
          ".ai/harness/active-plan",
          ".ai/harness/active-sprint",
          ".ai/harness/active-worktree",
          "tasks/current.md",
        ];
        const markers = markerPaths.map((path) => {
          const absolute = join(ctx.repoRoot, path);
          if (!existsSync(absolute)) return { path, exists: false };
          const raw = readFileSync(absolute, "utf-8");
          return {
            path,
            exists: true,
            bytes: Buffer.byteLength(raw),
            lines: raw.split(/\r?\n/).length,
            sha256: createHash("sha256").update(raw).digest("hex").slice(0, 16),
            preview: redactMcpText(raw).text.slice(0, 400),
          };
        });
        const controllerHome = resolveRepoPreferredControllerHome(ctx.repoRoot);
        const requirementBoard = buildRequirementBoard({ controllerHome, repoId: ctx.repoId });
        const executionDiagnostics = buildExecutionDiagnostics({
          controllerHome,
          repoId: ctx.repoId,
          detailLevel: "detail",
        });
        const snapshotRuns = listAgentJobs(ctx.repoRoot, 11);
        const runs = snapshotRuns.slice(0, 10).map((run) => ({
          runId: run.runId,
          issueId: run.issueId,
          taskId: run.taskId,
          agent: run.agent,
          provider: run.provider,
          executionMode: run.executionMode,
          status: run.status,
          progress: run.progress,
          createdAt: run.createdAt,
          finishedAt: run.finishedAt,
          error: run.error?.slice(0, 300),
        }));
        const payload = {
          git: gitSnapshot(ctx.repoRoot),
          requirementBoard,
          executionDiagnostics,
          legacyCompatibility: {
            currentIssue: "deprecated_frozen",
            issueTaskBoard: "deprecated_frozen",
            authority: "controller-home-sqlite",
          },
          runs,
          markers,
          truncated: {
            runs: snapshotRuns.length > 10,
          },
        };
        audit(ctx, name, "ok", args);
        return textResult(payload);
      }
      case "list_checks": {
        if (ctx.policy.profile !== "controller")
          return errorResult(
            "TOOL_DISABLED",
            "list_checks requires the controller profile",
          );
        const checks = listControllerChecks(ctx.repoRoot);
        audit(ctx, name, "ok", args);
        return textResult({ checks });
      }
      case "get_worklog_timeline": {
        if (ctx.policy.profile !== "controller")
          return errorResult("TOOL_DISABLED", "get_worklog_timeline requires the controller profile");
        const events = listControllerWorklogEvents(ctx.repoRoot, {
          category: parseWorklogCategory(args.category),
          issueId: typeof args.issue_id === "string" ? args.issue_id : undefined,
          taskId: typeof args.task_id === "string" ? args.task_id : undefined,
          runId: typeof args.run_id === "string" ? args.run_id : undefined,
          editSessionId: typeof args.edit_session_id === "string" ? args.edit_session_id : undefined,
          since: typeof args.since === "string" ? args.since : undefined,
          until: typeof args.until === "string" ? args.until : undefined,
          limit: typeof args.limit === "number" ? Math.trunc(args.limit) : undefined,
        });
        audit(ctx, name, "ok", args);
        return textResult({ events });
      }
      case "export_worklog": {
        if (ctx.policy.profile !== "controller")
          return errorResult("TOOL_DISABLED", "export_worklog requires the controller profile");
        const result = exportControllerWorklog(ctx.repoRoot, {
          format: args.format === "json" ? "json" : "markdown",
          outputPath: typeof args.output_path === "string" ? args.output_path : undefined,
          filter: {
            issueId: typeof args.issue_id === "string" ? args.issue_id : undefined,
            taskId: typeof args.task_id === "string" ? args.task_id : undefined,
            runId: typeof args.run_id === "string" ? args.run_id : undefined,
            editSessionId: typeof args.edit_session_id === "string" ? args.edit_session_id : undefined,
          },
        });
        audit(ctx, name, "ok", args, result.path);
        return textResult(result);
      }
      case "begin_edit_session": {
        if (ctx.policy.profile !== "controller")
          return errorResult(
            "TOOL_DISABLED",
            "begin_edit_session requires the controller profile",
          );
        const purpose = String(args.purpose ?? "").trim();
        const identity = editExecutionIdentity(ctx);
        const repoId = identity.repoId;
        const controllerHome = resolveRepoPreferredControllerHome(ctx.repoRoot);
        const allowedPaths = stringList(args.allowed_paths);
        const checks = stringList(args.checks);
        // An edit transaction is not a semantic objective. Only the Controller
        // can select an existing Work; ordinary Direct Edit needs no Work lifecycle.
        const workId = typeof args.work_id === "string" ? args.work_id.trim() || undefined : undefined;
        if (workId && !getWorkContract({ controllerHome, repoId }, workId)) {
          return errorResult("WORK_NOT_FOUND", `WorkContract ${workId} not found`);
        }
        const editRepository = resolveRepositorySelection({
          repoId,
          checkoutId: identity.checkoutId,
          controllerHome,
        });
        const editStorage = ensureRepositoryRuntimeStorageBinding(editRepository, 'edit-sessions', controllerHome);
        if (editStorage.status === 'legacy-active' || editStorage.status === 'conflict') {
          return errorResult('EDIT_SESSION_STORAGE_NOT_READY', editStorage.message ?? editStorage.status);
        }
        const session = withLegacyEditMutation(ctx, name, () => beginEditSession(ctx.repoRoot, {
          purpose,
          issueId: typeof args.issue_id === "string" ? args.issue_id : undefined,
          taskId: typeof args.task_id === "string" ? args.task_id : undefined,
          allowedPaths,
          maxFiles: typeof args.max_files === "number" ? args.max_files : undefined,
          maxChangedLines: typeof args.max_changed_lines === "number" ? args.max_changed_lines : undefined,
          checks,
          binding: {
            workId,
            repoId,
            checkoutId: identity.checkoutId,
            principalId: identity.principalId,
            controllerInstanceId: workId ? identity.controllerInstanceId : undefined,
          },
        }));
        audit(
          ctx,
          name,
          "ok",
          args,
          `controller-home://repositories/${editExecutionIdentity(ctx).repoId}/edit-sessions/${session.sessionId}`,
        );
        return textResult(session);
      }
      case "apply_patch": {
        if (ctx.policy.profile !== "controller")
          return errorResult(
            "TOOL_DISABLED",
            "apply_patch requires the controller profile",
          );
        let session;
        try {
          const current = getEditSession(ctx.repoRoot, String(args.session_id ?? ""));
          const identity = editExecutionIdentity(ctx);
          session = withLegacyEditMutation(ctx, name, () => applyEditOperations(
            ctx.repoRoot,
            ctx.policy,
            current.sessionId,
            normalizeEditOperations(args.operations),
            {
              expectedRevision:
                typeof args.expected_revision === "number"
                  ? Math.trunc(args.expected_revision)
                  : undefined,
              maxBatchOperations: PREFERRED_EDIT_PATCH_BATCH_OPERATIONS,
              binding: {
                workId: current.workId,
                repoId: identity.repoId,
                checkoutId: identity.checkoutId,
                principalId: identity.principalId,
                controllerInstanceId: identity.controllerInstanceId,
              },
            },
          ));
        } catch (error) {
          if (error instanceof EditSessionPatchError) {
            audit(ctx, name, "failed", args, `controller-home://repositories/${editExecutionIdentity(ctx).repoId}/edit-sessions/${error.details.sessionId}`, error.message);
            return errorResult(error.code, error.message, error.details);
          }
          throw error;
        }
        audit(
          ctx,
          name,
          "ok",
          args,
          `controller-home://repositories/${editExecutionIdentity(ctx).repoId}/edit-sessions/${session.sessionId}`,
        );
        return textResult(session);
      }
      case "get_edit_session": {
        if (ctx.policy.profile !== "controller")
          return errorResult(
            "TOOL_DISABLED",
            "get_edit_session requires the controller profile",
          );
        const session = getEditSession(
          ctx.repoRoot,
          String(args.session_id ?? ""),
        );
        audit(
          ctx,
          name,
          "ok",
          args,
          `controller-home://repositories/${editExecutionIdentity(ctx).repoId}/edit-sessions/${session.sessionId}`,
        );
        return textResult(session);
      }
      case "list_edit_sessions": {
        if (ctx.policy.profile !== "controller")
          return errorResult("TOOL_DISABLED", "list_edit_sessions requires the controller profile");
        const limit = typeof args.limit === "number" ? args.limit : 100;
        audit(ctx, name, "ok", args);
        return textResult({ sessions: listEditSessions(ctx.repoRoot, limit) });
      }
      case "get_edit_session_diff": {
        if (ctx.policy.profile !== "controller")
          return errorResult("TOOL_DISABLED", "get_edit_session_diff requires the controller profile");
        const result = getEditSessionDiff(ctx.repoRoot, String(args.session_id ?? ""));
        audit(ctx, name, "ok", args, result.path);
        return textResult(result);
      }
      case "create_edit_savepoint": {
        if (ctx.policy.profile !== "controller")
          return errorResult("TOOL_DISABLED", "create_edit_savepoint requires the controller profile");
        const session = withLegacyEditMutation(ctx, name, () => createEditSavepoint(
          ctx.repoRoot,
          String(args.session_id ?? ""),
          String(args.name ?? ""),
        ));
        audit(ctx, name, "ok", args, `controller-home://repositories/${editExecutionIdentity(ctx).repoId}/edit-sessions/${session.sessionId}`);
        return textResult(session);
      }
      case "verify_edit_session": {
        if (ctx.policy.profile !== "controller")
          return errorResult("TOOL_DISABLED", "verify_edit_session requires the controller profile");
        const session = getEditSession(ctx.repoRoot, String(args.session_id ?? ""));
        const requestId = typeof args.request_id === "string" ? args.request_id.trim() || undefined : undefined;
        audit(ctx, name, "blocked", args, session.diffPath);
        return errorResult(
          "VERIFY_EDIT_SESSION_LOCAL_JOB_RETIRED",
          "Edit-session verification no longer creates a Local Bridge Job. Run checks through Process Runtime, then finalize with the recorded evidence.",
          { sessionId: session.sessionId, revision: session.currentRevision, requestId },
        );
      }
      case "rollback_edit_session": {
        if (ctx.policy.profile !== "controller")
          return errorResult(
            "TOOL_DISABLED",
            "rollback_edit_session requires the controller profile",
          );
        const session = withLegacyEditMutation(ctx, name, () => rollbackEditSession(
          ctx.repoRoot,
          String(args.session_id ?? ""),
          {
            toRevision: typeof args.to_revision === "number" ? Math.trunc(args.to_revision) : undefined,
            savepoint: typeof args.savepoint === "string" ? args.savepoint : undefined,
          },
        ));
        audit(
          ctx,
          name,
          "ok",
          args,
          `controller-home://repositories/${editExecutionIdentity(ctx).repoId}/edit-sessions/${session.sessionId}`,
        );
        return textResult(session);
      }
      case "finalize_edit_session": {
        if (ctx.policy.profile !== "controller")
          return errorResult(
            "TOOL_DISABLED",
            "finalize_edit_session requires the controller profile",
          );
        const current = getEditSession(ctx.repoRoot, String(args.session_id ?? ""));
        const identity = editExecutionIdentity(ctx);
        const session = withLegacyEditMutation(ctx, name, () => finalizeEditSession(
          ctx.repoRoot,
          current.sessionId,
          {
            reviewer: typeof args.reviewer === "string" ? args.reviewer : undefined,
            note: typeof args.note === "string" ? args.note : undefined,
            approvalConfirmed: args.confirm_authorization === true,
            binding: {
              workId: current.workId,
              repoId: identity.repoId,
              checkoutId: identity.checkoutId,
              principalId: identity.principalId,
              controllerInstanceId: identity.controllerInstanceId,
            },
          },
        ));
        audit(
          ctx,
          name,
          "ok",
          args,
          `controller-home://repositories/${editExecutionIdentity(ctx).repoId}/edit-sessions/${session.sessionId}`,
        );
        return textResult(session);
      }
      case "list_workflow_files": {
        const files = workflowFileCandidates(ctx.repoRoot)
          .filter(
            (path) => resolveMcpPath(ctx.repoRoot, path, ctx.policy, "read").ok,
          )
          .map((path) => fileSummary(path, ctx.repoRoot))
          .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
          .filter((entry) => entry.size <= ctx.policy.maxFileBytes);
        audit(ctx, name, "ok", args);
        return textResult({ files });
      }
      case "read_workflow_file": {
        const path = typeof args.path === "string" ? args.path : "";
        const decision = resolveMcpPath(ctx.repoRoot, path, ctx.policy, "read");
        if (!decision.ok || !decision.absolutePath || !decision.relativePath) {
          audit(ctx, name, "blocked", args, path, decision.reason);
          return errorResult(
            "POLICY_DENIED",
            decision.reason ?? "path denied",
            { path },
          );
        }
        const fileStat = statSync(decision.absolutePath);
        if (!fileStat.isFile())
          return errorResult(
            "NOT_A_FILE",
            `path is not a file: ${decision.relativePath}`,
          );
        if (fileStat.size > ctx.policy.maxFileBytes)
          return errorResult(
            "FILE_TOO_LARGE",
            `file exceeds ${ctx.policy.maxFileBytes} bytes`,
          );
        const bytes = readFileSync(decision.absolutePath);
        if (isProbablyBinary(bytes))
          return errorResult("BINARY_FILE", "binary files are not supported");
        const raw = bytes.toString("utf-8");
        const redacted = redactMcpText(raw);
        audit(ctx, name, "ok", args, decision.relativePath);
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
      case "latest_session_context": {
        const paths = [
          ".ai/harness/session/resume.md",
          ".ai/harness/session/continuation.md",
        ];
        const handoff = paths.map((path) => {
          const decision = resolveMcpPath(
            ctx.repoRoot,
            path,
            ctx.policy,
            "read",
          );
          if (
            !decision.ok ||
            !decision.absolutePath ||
            !existsSync(decision.absolutePath)
          )
            return { path, exists: false };
          const content = redactMcpText(
            readFileSync(decision.absolutePath, "utf-8"),
          ).text;
          return {
            path,
            exists: true,
            preview: content.split(/\r?\n/).slice(0, 24).join("\n"),
          };
        });
        audit(ctx, name, "ok", args);
        return textResult({ sessionContext: handoff });
      }
      case "latest_checks": {
        const controllerHome = ctx.runtimeControllerHome?.trim()
          || resolveRepoPreferredControllerHome(ctx.repoRoot);
        const repoId = ctx.repoId?.trim()
          || resolveRepositorySelection({
            explicitPath: ctx.repoRoot,
            controllerHome,
            allowSoleRepository: true,
          }).repoId;
        const storage = resolveRepositoryCheckStorage(ctx.repoRoot, { controllerHome, repoId });
        const relativeFiles: string[] = [];
        listFilesUnder(storage.physicalRoot, ".", 700, relativeFiles);
        const files = relativeFiles
          .map((path) => path.replace(/^\.\//, ""))
          .filter((path) => !path.startsWith("locks/"))
          .map((path) => {
            const summary = fileSummary(path, storage.physicalRoot);
            return summary ? { ...summary, path: `controller-home://checks/${path}` } : null;
          })
          .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
          .sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt))
          .slice(0, 20);
        audit(ctx, name, "ok", args);
        return textResult({ files });
      }
      case "list_prds":
      case "list_sprints": {
        const root = name === "list_prds" ? "plans/prds" : "plans/sprints";
        const files: string[] = [];
        listFilesUnder(ctx.repoRoot, root, 200, files);
        audit(ctx, name, "ok", args);
        return textResult({
          files: files
            .map((path) => fileSummary(path, ctx.repoRoot))
            .filter(Boolean),
        });
      }
      case "summarize_forge_state": {
        const current = existsSync(join(ctx.repoRoot, "tasks/current.md"))
          ? readFileSync(join(ctx.repoRoot, "tasks/current.md"), "utf-8")
              .split(/\r?\n/)
              .slice(0, 50)
              .join("\n")
          : null;
        audit(ctx, name, "ok", args);
        return textResult({
          status: {
            adopted: isForgeAdopted(ctx.repoRoot),
            branch: currentGitBranch(ctx.repoRoot),
            profile: ctx.policy.profile,
          },
          current: current ? redactMcpText(current).text : null,
        });
      }
      case "write_prd": {
        const title = String(args.title ?? "").trim();
        const slug = slugify(String(args.slug ?? title));
        return writeMarkdownArtifact(
          ctx,
          name,
          prdArtifactPath(slug),
          title,
          "prd",
          String(args.body ?? ""),
          args.overwrite === true,
          args,
        );
      }
      case "write_prd_from_idea": {
        const title = String(args.title ?? "").trim();
        const slug = slugify(String(args.slug ?? title));
        const body = renderPrdFromIdeaBody(args);
        return writeMarkdownArtifact(
          ctx,
          name,
          prdArtifactPath(slug),
          title,
          "prd",
          body,
          args.overwrite === true,
          args,
        );
      }
      case "write_sprint": {
        const title = String(args.title ?? "").trim();
        const slug = slugify(String(args.slug ?? title));
        return writeMarkdownArtifact(
          ctx,
          name,
          sprintArtifactPath(slug),
          title,
          "sprint",
          String(args.body ?? ""),
          args.overwrite === true,
          args,
        );
      }
      case "write_checklist_sprint": {
        const title = String(args.title ?? "").trim();
        const slug = slugify(String(args.slug ?? title));
        const prdPath = String(args.prd_path ?? "").trim();
        const prdDecision = resolveMcpPath(
          ctx.repoRoot,
          prdPath,
          ctx.policy,
          "read",
        );
        if (
          !prdDecision.ok ||
          !prdDecision.absolutePath ||
          !existsSync(prdDecision.absolutePath)
        ) {
          audit(
            ctx,
            name,
            "blocked",
            args,
            prdPath,
            prdDecision.reason ?? "PRD path does not exist or is not readable",
          );
          return errorResult(
            "PRD_NOT_READABLE",
            "PRD path does not exist or is not policy-readable.",
            { path: prdPath },
          );
        }
        const body = renderChecklistSprintBody(args);
        return writeMarkdownArtifact(
          ctx,
          name,
          sprintArtifactPath(slug),
          title,
          "sprint",
          body,
          args.overwrite === true,
          args,
        );
      }
      case "write_plan": {
        const title = String(args.title ?? "").trim();
        const slug = slugify(String(args.slug ?? title));
        return writeMarkdownArtifact(
          ctx,
          name,
          `plans/plan-${slug}.md`,
          title,
          "plan",
          String(args.body ?? ""),
          args.overwrite === true,
          args,
        );
      }
      case "append_controller_plan_note": {
        const path = ".ai/harness/controller/packets/chatgpt-plan.md";
        const decision = resolveMcpPath(
          ctx.repoRoot,
          path,
          ctx.policy,
          "write",
        );
        if (!decision.ok || !decision.absolutePath)
          return errorResult("POLICY_DENIED", decision.reason ?? "path denied");
        mkdirSync(dirname(decision.absolutePath), { recursive: true });
        const actor =
          String(args.actor ?? "chatgpt-planner").trim() || "chatgpt-planner";
        const body = String(args.body ?? "").trim();
        const block = [
          ``,
          `## ${new Date().toISOString()}`,
          ``,
          `Actor: ${actor}`,
          ``,
          body,
          ``,
        ].join("\n");
        appendFileSync(decision.absolutePath, block, "utf-8");
        audit(ctx, name, "ok", args, path);
        return textResult({ status: "appended", path });
      }
      case "run_chatgpt_browser_consult": {
        if (ctx.enableChatgptBrowser !== true)
          return errorResult(
            "TOOL_DISABLED",
            "ChatGPT browser tools require forge mcp serve --enable-chatgpt-browser",
          );
        const result = await runBrowserConsult({
          repoRoot: ctx.repoRoot,
          title: typeof args.title === "string" ? args.title : undefined,
          prompt: String(args.prompt ?? ""),
          files: stringList(args.files).map((path) => ({ path })),
          followups: stringList(args.followups),
          model: typeof args.model === "string" ? args.model : undefined,
          thinking: parseThinking(args.thinking),
          provider: parseBrowserProvider(args.provider),
          browserChannel: parseNativeBrowserChannel(args.browserChannel),
          writeOutput:
            typeof args.writeOutput === "string" ? args.writeOutput : undefined,
          writeOutputPolicy: "mcp",
          overwriteOutput: args.overwriteOutput === true,
          timeoutMs:
            typeof args.timeoutMs === "number" ? args.timeoutMs : undefined,
          dryRun: args.dryRun === true,
        });
        audit(
          ctx,
          name,
          result.error ? "failed" : "ok",
          args,
          result.meta.output.outputPath,
          result.error?.message,
        );
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
      case "read_chatgpt_browser_session": {
        if (ctx.enableChatgptBrowser !== true)
          return errorResult(
            "TOOL_DISABLED",
            "ChatGPT browser tools require forge mcp serve --enable-chatgpt-browser",
          );
        const sessionId = String(args.sessionId ?? "").trim();
        const session = readSession(ctx.repoRoot, sessionId);
        audit(ctx, name, "ok", args);
        return textResult({
          meta: session.meta,
          output: session.output,
          transcript: session.transcript,
        });
      }
      case "list_chatgpt_browser_sessions": {
        if (ctx.enableChatgptBrowser !== true)
          return errorResult(
            "TOOL_DISABLED",
            "ChatGPT browser tools require forge mcp serve --enable-chatgpt-browser",
          );
        const limit =
          typeof args.limit === "number" &&
          Number.isInteger(args.limit) &&
          args.limit > 0
            ? args.limit
            : 20;
        const sessions = listSessions(ctx.repoRoot, limit);
        audit(ctx, name, "ok", args);
        return textResult({ sessions });
      }
      case "open_chatgpt_browser_session": {
        if (ctx.enableChatgptBrowser !== true)
          return errorResult(
            "TOOL_DISABLED",
            "ChatGPT browser tools require forge mcp serve --enable-chatgpt-browser",
          );
        const sessionId = String(args.sessionId ?? "").trim();
        const result = openSession(ctx.repoRoot, sessionId, false);
        audit(ctx, name, "ok", args);
        return textResult({ sessionId, url: result.url, launched: false });
      }
      case "continue_chatgpt_browser_session": {
        if (ctx.enableChatgptBrowser !== true)
          return errorResult(
            "TOOL_DISABLED",
            "ChatGPT browser tools require forge mcp serve --enable-chatgpt-browser",
          );
        const sessionId = String(args.sessionId ?? "").trim();
        const prompt = String(args.prompt ?? "").trim();
        const result = await runBrowserFollowup({
          repoRoot: ctx.repoRoot,
          sessionId,
          title: `followup ${sessionId}`,
          prompt,
          dryRun: args.dryRun === true,
        });
        audit(
          ctx,
          name,
          result.error ? "failed" : "ok",
          args,
          result.meta.output.outputPath,
          result.error?.message,
        );
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
        audit(ctx, name, "blocked", args);
        return errorResult("UNKNOWN_TOOL", `unknown tool: ${name}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    audit(ctx, name, "failed", args, undefined, message);
    return errorResult("TOOL_FAILED", message);
  }
}
