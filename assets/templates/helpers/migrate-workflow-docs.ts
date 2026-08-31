import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";

type Mode = "dry-run" | "apply";

type MigrationRecord = {
  source: string;
  target: string;
  action: "preserve" | "rewrite" | "append" | "skip";
  note: string;
};

type MigrationSummary = {
  repo: string;
  mode: Mode;
  migrated: MigrationRecord[];
  skipped: string[];
  manual_followups: string[];
};

function parseArgs(argv: string[]) {
  let repo = process.cwd();
  let mode: Mode = "dry-run";
  let format: "json" | "text" = "text";

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--repo") {
      repo = argv[i + 1] ? resolve(argv[i + 1]) : repo;
      i += 1;
      continue;
    }
    if (arg === "--apply") {
      mode = "apply";
      continue;
    }
    if (arg === "--dry-run") {
      mode = "dry-run";
      continue;
    }
    if (arg === "--format") {
      format = argv[i + 1] === "json" ? "json" : "text";
      i += 1;
    }
  }

  return { repo, mode, format };
}

function ensureDir(path: string, mode: Mode) {
  if (mode === "apply") {
    mkdirSync(path, { recursive: true });
  }
}

function hasCanonicalTodoHeader(content: string): boolean {
  return /^# Deferred Goal Ledger\s*$/m.test(content) && /^\> \*\*Status\*\*:\s*Backlog\s*$/m.test(content);
}

function writeCanonicalTodo(target: string, mode: Mode) {
  if (existsSync(target)) return;
  const content = [
    "# Deferred Goal Ledger",
    "",
    "> **Status**: Backlog",
    "> **Updated**: (migration)",
    "> **Scope**: Medium/long-term goals deferred from active plan execution",
    "",
    "Current plan tasks live in the active plan's `## Task Breakdown`.",
    "Do not duplicate that execution checklist here. Record only work intentionally deferred beyond this slice, with the tradeoff and revisit trigger.",
    "",
    "## Deferred Goals",
    "",
    "| Goal | Why Deferred | Tradeoff | Revisit Trigger |",
    "|------|--------------|----------|-----------------|",
    "| (none) | No deferred medium/long-term goal recorded yet. | Keep migrated workflow state bounded. | Add a row when a real follow-up is postponed. |",
  ].join("\n");
  if (mode === "apply") {
    ensureDir(dirname(target), mode);
    writeFileSync(target, `${content}\n`);
  }
}

function legacyTodoNeedsManualTriage(target: string): boolean {
  if (!existsSync(target)) return false;
  return !hasCanonicalTodoHeader(readFileSync(target, "utf-8"));
}

function legacyResearchNeedsManualTriage(source: string): boolean {
  if (!existsSync(source)) return false;
  const existing = readFileSync(source, "utf-8");
  return !existing.includes("**Canonical Surface**: `docs/researches/`");
}

function writeResearchReadme(target: string, mode: Mode) {
  if (existsSync(target)) return;
  const content = [
    "# Research Reports",
    "",
    "Durable research reports live in this directory as dated Markdown files.",
    "",
    "Use `YYYYMMDD-topic.md` names for new reports. Keep task-local implementation",
    "decisions in `tasks/notes/`, and keep repeated correction-derived rules in",
    "`tasks/lessons.md`.",
  ].join("\n");
  if (mode === "apply") {
    ensureDir(dirname(target), mode);
    writeFileSync(target, `${content}\n`);
  }
}

export function migrate(repo: string, mode: Mode): MigrationSummary {
  const summary: MigrationSummary = {
    repo,
    mode,
    migrated: [],
    skipped: [],
    manual_followups: [],
  };

  const planDoc = join(repo, "docs", "plan.md");
  const todoDoc = join(repo, "docs", "TODO.md");
  const progressDoc = join(repo, "docs", "PROGRESS.md");
  const tasksTodo = join(repo, "tasks", "todos.md");
  const legacySingularTasksTodo = join(repo, "tasks", "todo.md");
  const tasksResearch = join(repo, "tasks", "research.md");
  const researchDir = join(repo, "docs", "researches");
  const researchReadme = join(researchDir, "README.md");
  const legacyContractDoc = join(repo, "docs", "contract.md");
  const legacyReviewDoc = join(repo, "docs", "review.md");
  const legacyHandoffDoc = join(repo, "docs", "handoff.md");
  const rootHandoffDoc = join(repo, "HANDOFF.md");

  const preserveLegacy = (relativePath: string, note: string) => {
    const sourcePath = join(repo, relativePath);
    if (!existsSync(sourcePath)) return;
    summary.migrated.push({
      source: relativePath,
      target: relativePath,
      action: "preserve",
      note,
    });
    summary.manual_followups.push(`Review ${relativePath} in place and explicitly promote still-current content before removing the legacy file.`);
  };

  const singularTodoExists = existsSync(legacySingularTasksTodo);
  const docsTodoExists = existsSync(todoDoc);

  if (singularTodoExists) {
    preserveLegacy(
      "tasks/todo.md",
      "Preserved the user-authored legacy singular todo in place; migration refuses to guess which checklist items are still current."
    );
  }

  if (!singularTodoExists && !docsTodoExists) {
    writeCanonicalTodo(tasksTodo, mode);
  }

  if (legacyTodoNeedsManualTriage(tasksTodo)) {
    summary.migrated.push({
      source: "tasks/todos.md",
      target: "tasks/todos.md",
      action: "preserve",
      note: "Preserved non-canonical tasks/todos.md in place; migration refuses to overwrite user-authored checklist state without explicit triage.",
    });
    summary.manual_followups.push(
      "Review tasks/todos.md in place, promote still-current work into a current Plan/Work or deferred-goal row, then normalize the file explicitly."
    );
  }

  ensureDir(researchDir, mode);
  writeResearchReadme(researchReadme, mode);
  if (legacyResearchNeedsManualTriage(tasksResearch)) {
    preserveLegacy(
      "tasks/research.md",
      "Preserved legacy singleton research notes in place; migration no longer copies them into a second historical report authority."
    );
  }

  preserveLegacy(
    "docs/plan.md",
    "Preserved uncertain legacy plan content in place; create a canonical plan only after explicit currentness review."
  );
  preserveLegacy(
    "docs/TODO.md",
    "Preserved uncertain legacy checklist content in place; migration does not manufacture a parallel task archive or empty canonical ledger around it."
  );
  preserveLegacy(
    "docs/PROGRESS.md",
    "Preserved legacy progress notes in place; distill still-current durable knowledge explicitly instead of auto-copying execution history into research/archive surfaces."
  );
  preserveLegacy("docs/contract.md", "Preserved legacy contract notes in place for explicit currentness triage.");
  preserveLegacy("docs/review.md", "Preserved legacy review notes in place for explicit currentness triage.");
  preserveLegacy("docs/handoff.md", "Preserved legacy handoff notes in place for explicit currentness triage.");
  preserveLegacy("HANDOFF.md", "Preserved root handoff notes in place for explicit currentness triage.");

  return summary;
}

function renderText(summary: MigrationSummary): string {
  const lines = [
    `[migrate-docs] repo: ${summary.repo}`,
    `[migrate-docs] mode: ${summary.mode}`,
  ];

  for (const item of summary.migrated) {
    lines.push(`[migrate-docs] ${item.source} -> ${item.target} (${item.action})`);
    lines.push(`[migrate-docs] note: ${item.note}`);
  }
  for (const followup of summary.manual_followups) {
    lines.push(`[migrate-docs] follow-up: ${followup}`);
  }
  if (summary.migrated.length === 0) {
    lines.push("[migrate-docs] no legacy documents detected");
  }
  return lines.join("\n");
}

if (import.meta.main) {
  const { repo, mode, format } = parseArgs(process.argv.slice(2));
  const summary = migrate(repo, mode);

  if (format === "json") {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(renderText(summary));
  }
}
