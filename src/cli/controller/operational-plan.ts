import { runProcess } from "../../effects/process-runner";
import type { TaskLedgerProjection } from "./task-ledger";

const OPERATIONAL_PLAN_SCHEMA_VERSION = 1;

export interface ControllerOperationalPlan {
  schemaVersion: typeof OPERATIONAL_PLAN_SCHEMA_VERSION;
  source: "controller-operational-plan";
  generatedAt: string;
  status: "ready" | "needs_attention" | "blocked";
  completedCapabilities: string[];
  remainingDecisionPoints: string[];
  diffProjection: {
    source: "live-git-diff-projection";
    dirty: boolean;
    changedFiles: Array<{ path: string; status: string }>;
    diffStat: string;
    reviewRequired: boolean;
  };
  validationStrategy: {
    source: "declared-check-projection";
    policy: "minimal" | "task-targeted" | "release-gate";
    checks: string[];
    reason: string;
  };
  recipeSystem: {
    source: "legacy-recipe-projection";
    recipes: Array<{
      id: string;
      label: string;
      when: string;
      steps: string[];
      requiredEvidence: string[];
    }>;
  };
  workerAbstraction: {
    source: "execution-capability-projection";
    workers: Array<{
      id: string;
      role: string;
      preferredFor: string[];
      avoidWhen: string[];
    }>;
    recommendedWorker: string;
  };
  guiInteraction: {
    source: "controller-console-interaction-model";
    primaryPanels: string[];
    primaryActions: string[];
    hiddenByDefault: string[];
  };
  mcpToolSchemaConvergence: {
    source: "mcp-tool-schema-convergence";
    readModels: string[];
    commandModels: string[];
    compatibilityRules: string[];
  };
  runtimeStorage: {
    source: "controller-home-runtime-storage-policy";
    controllerHomeFirst: true;
    legacyFallbackPreserved: true;
    repoLocalMutableRuntimeFilesAvoided: true;
  };
  branchWorktreeCleanup: {
    source: "safe-workspace-cleanup-policy";
    safeToAutoClean: boolean;
    requiredBeforeCleanup: string[];
    protectedCases: string[];
  };
  taskRecovery: {
    source: "task-recovery-loop";
    continuationState: string;
    nextActions: string[];
    recoveryArtifacts: string[];
  };
}

function parseNameStatus(output: string): Array<{ path: string; status: string }> {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 200)
    .map((line) => {
      const [status, ...rest] = line.split(/\s+/);
      return { status: status || "unknown", path: rest.join(" ") || line };
    });
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.filter((value) => value.trim()).map((value) => value.trim())));
}

function checksFromLedger(ledger: TaskLedgerProjection): string[] {
  const focused = ledger.status.taskId
    ? ledger.issues.flatMap((issue) => issue.tasks).find((task) => task.taskId === ledger.status.taskId && task.issueId === ledger.status.issueId)
    : undefined;
  const candidates = focused?.checks.length ? focused.checks : ledger.issues.flatMap((issue) => issue.tasks).flatMap((task) => task.checks);
  return unique(candidates.length ? candidates : ["package:check:type"]);
}

export function buildControllerOperationalPlan(repoRoot: string, ledger: TaskLedgerProjection): ControllerOperationalPlan {
  const nameStatus = runProcess("git", ["diff", "--name-status"], { cwd: repoRoot, timeoutMs: 10_000, maxOutputBytes: 64 * 1024 });
  const diffStat = runProcess("git", ["diff", "--stat"], { cwd: repoRoot, timeoutMs: 10_000, maxOutputBytes: 64 * 1024 });
  const changedFiles = nameStatus.ok ? parseNameStatus(nameStatus.stdout) : [];
  const checks = checksFromLedger(ledger);
  const dirty = changedFiles.length > 0;
  const blocked = ledger.status.kind === "blocked" || ledger.status.kind === "needs_retry_decision";
  const needsAttention = blocked || ledger.status.severity === "action" || ledger.status.severity === "warning" || dirty;
  // Compatibility projection only. Declared checks are facts the model may use;
  // this projection does not choose a validation method or release gate.
  const policy = "minimal" as const;

  return {
    schemaVersion: OPERATIONAL_PLAN_SCHEMA_VERSION,
    source: "controller-operational-plan",
    generatedAt: new Date().toISOString(),
    status: blocked ? "blocked" : needsAttention ? "needs_attention" : "ready",
    completedCapabilities: [
      "task-ledger",
      "context-pack",
      "diff-projection",
      "declared-check-projection",
      "legacy-recipe-projection",
      "execution-capability-projection",
      "gui-interaction-model",
      "mcp-tool-schema-convergence",
      "controller-home-runtime-storage-policy",
      "branch-worktree-cleanup-policy",
      "task-recovery-loop",
    ],
    remainingDecisionPoints: [],
    diffProjection: {
      source: "live-git-diff-projection",
      dirty,
      changedFiles,
      diffStat: diffStat.ok ? diffStat.stdout.trim() : diffStat.error || diffStat.stderr.trim(),
      // Legacy field retained for UI ABI only. Dirty state is a fact, not an
      // automatic review lifecycle decision.
      reviewRequired: false,
    },
    validationStrategy: {
      source: "declared-check-projection",
      policy,
      checks,
      reason: checks.length > 0
        ? "These checks are declared context only; the model decides whether, when, and how to validate."
        : "No declared checks were found; Forge does not invent a validation strategy.",
    },
    recipeSystem: {
      source: "legacy-recipe-projection",
      recipes: [],
    },
    workerAbstraction: {
      source: "execution-capability-projection",
      workers: [
        { id: "direct_capability", role: "direct domain capability execution", preferredFor: [], avoidWhen: [] },
        { id: "isolated_process", role: "isolated process/workspace capability when explicitly useful", preferredFor: [], avoidWhen: [] },
        { id: "external_provider", role: "optional external model/provider capability", preferredFor: [], avoidWhen: [] },
      ],
      recommendedWorker: "model_selected",
    },
    guiInteraction: {
      source: "controller-console-interaction-model",
      primaryPanels: ["Needs Attention", "Current Work", "Context Pack", "Diff Review", "Validation", "Recovery"],
      primaryActions: ["Continue", "Review Diff", "Run Targeted Checks", "Accept", "Request Changes", "Retry", "Clean Safe Artifacts"],
      hiddenByDefault: ["raw run ids", "lease internals", "projection fingerprints", "scheduler queues"],
    },
    mcpToolSchemaConvergence: {
      source: "mcp-tool-schema-convergence",
      readModels: ["controller_context", "rh_context", "work_status_digest", "prepare_transfer_artifacts"],
      commandModels: ["rh_work", "run_check", "repository_command_execute", "plugin_action_execute", "repository_safe_patch_apply"],
      compatibilityRules: [
        "compact reads are default",
        "raw code and raw logs require explicit opt-in tools",
        "controller profile exposes recovery projections in core toolset",
        "new projections are additive and must not replace durable Issue/Task/Run state",
      ],
    },
    runtimeStorage: {
      source: "controller-home-runtime-storage-policy",
      controllerHomeFirst: true,
      legacyFallbackPreserved: true,
      repoLocalMutableRuntimeFilesAvoided: true,
    },
    branchWorktreeCleanup: {
      source: "safe-workspace-cleanup-policy",
      safeToAutoClean: !dirty && ledger.status.kind !== "active_work",
      requiredBeforeCleanup: ["clean git status", "no active local worker", "terminal run state", "no unique unmerged commits"],
      protectedCases: ["dirty main workspace", "waiting_for_user runs", "unmerged worktree branch", "unknown ownership metadata"],
    },
    taskRecovery: {
      source: "task-recovery-loop",
      continuationState: ledger.status.kind,
      nextActions: ledger.suggestedNextActions.slice(0, 6),
      recoveryArtifacts: [".ai/harness/controller/task-ledger.json", ".ai/harness/projections/controller-task-ledger.md"],
    },
  };
}
