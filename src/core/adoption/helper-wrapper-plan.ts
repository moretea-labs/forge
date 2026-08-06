import { existsSync, readFileSync } from "fs";
import { basename, resolve } from "path";
import type { AdoptionMode } from "./modes";
import type { WriteFileOperation } from "./operations";
import { makeOperationId } from "./operations";
import { loadWorkflowContractAsset, WORKFLOW_CONTRACT_ASSET_PATH } from "./workflow-contract-asset";

const EXECUTABLE_MODE = 0o755;

interface WorkflowContractForHelperWrappers {
  readonly helpers: {
    readonly compatibilityDirectory?: string;
    readonly scripts: readonly string[];
  };
}

function repoPinsHelperSource(repoRoot: string): boolean {
  if (process.env.FORGE_HELPER_SOURCE === "repo") return true;
  const policyPath = resolve(repoRoot, ".ai/harness/policy.json");
  if (!existsSync(policyPath)) return false;
  try {
    const policy = JSON.parse(readFileSync(policyPath, "utf-8")) as { harness?: { helper_source?: string } };
    return policy.harness?.helper_source === "repo";
  } catch {
    return false;
  }
}

function isSelfHostSourceRepo(repoRoot: string): boolean {
  const targetHelpers = resolve(repoRoot, "assets/templates/helpers");
  const assetHelpers = resolve(WORKFLOW_CONTRACT_ASSET_PATH, "..", "templates", "helpers");
  return existsSync(targetHelpers) && targetHelpers === assetHelpers;
}

function assertHelperName(helperName: string): void {
  if (helperName !== basename(helperName) || helperName.includes("..") || helperName.startsWith(".")) {
    throw new Error(`unsafe helper wrapper name: ${helperName}`);
  }
}

function helperId(helperName: string): string {
  return helperName.replace(/\.[^.]+$/, "");
}

function shellWrapper(helperName: string): string {
  const id = helperId(helperName);
  return [
    "#!/bin/bash",
    "set -euo pipefail",
    "",
    'SOURCE_ROOT="${FORGE_SOURCE_ROOT:-${AGENTIC_DEV_ROOT:-${AGENTIC_DEV_SKILL_ROOT:-}}}"',
    "",
    'if [[ -n "$SOURCE_ROOT" && -f "$SOURCE_ROOT/src/cli/index.ts" ]]; then',
    "  if command -v bun >/dev/null 2>&1; then",
    `    exec bun "$SOURCE_ROOT/src/cli/index.ts" run ${id} "$@"`,
    "  fi",
    "fi",
    "",
    "if command -v forge >/dev/null 2>&1; then",
    `  exec forge run ${id} "$@"`,
    "fi",
    "",
    `echo "Missing forge CLI for helper ${id}" >&2`,
    "exit 1",
    "",
  ].join("\n");
}

function typescriptWrapper(helperName: string): string {
  const id = helperId(helperName);
  return [
    "#!/usr/bin/env bun",
    'import { spawnSync } from "node:child_process";',
    'import { existsSync } from "node:fs";',
    'import { join } from "node:path";',
    "",
    `const helperId = "${id}";`,
    "const DEFAULT_TIMEOUT_MS = 120_000;",
    "const configuredTimeoutMs = Number.parseInt(",
    '  process.env.FORGE_HELPER_TIMEOUT_MS ?? String(DEFAULT_TIMEOUT_MS),',
    "  10,",
    ");",
    "const timeoutMs = Number.isFinite(configuredTimeoutMs) && configuredTimeoutMs > 0",
    "  ? configuredTimeoutMs",
    "  : DEFAULT_TIMEOUT_MS;",
    "",
    "const sourceRoot =",
    "  process.env.FORGE_SOURCE_ROOT ||",
    "  process.env.AGENTIC_DEV_ROOT ||",
    "  process.env.AGENTIC_DEV_SKILL_ROOT;",
    'const command = sourceRoot && existsSync(join(sourceRoot, "src", "cli", "index.ts"))',
    `  ? ["bun", join(sourceRoot, "src", "cli", "index.ts"), "run", "${id}"]`,
    `  : ["forge", "run", "${id}"];`,
    "",
    "const result = spawnSync(command[0], [...command.slice(1), ...process.argv.slice(2)], {",
    "  cwd: process.cwd(),",
    "  env: process.env,",
    '  stdio: "inherit",',
    "  timeout: timeoutMs,",
    "});",
    "",
    "if (result.error) {",
    '  const code = "code" in result.error ? String(result.error.code ?? "") : "";',
    '  const prefix = code === "ETIMEDOUT"',
    "    ? `forge helper ${helperId} timed out after ${timeoutMs}ms`",
    "    : `Missing forge CLI for helper ${helperId}`;",
    "  console.error(`${prefix}: ${result.error.message}`);",
    "  process.exit(1);",
    "}",
    "",
    "process.exit(result.status ?? 1);",
    "",
  ].join("\n");
}

export function helperWrapperContent(helperName: string): string {
  assertHelperName(helperName);
  return helperName.endsWith(".ts") ? typescriptWrapper(helperName) : shellWrapper(helperName);
}

function helperWrapperStatus(repoRoot: string, path: string): WriteFileOperation["status"] {
  return existsSync(resolve(repoRoot, path)) ? "skipped" : "planned";
}

function shouldPlanHelperWrappers(repoRoot: string, mode: AdoptionMode): boolean {
  return mode === "standard" && !isSelfHostSourceRepo(repoRoot) && !repoPinsHelperSource(repoRoot);
}

export function helperWrapperGitignoreContent(repoRoot: string, mode: AdoptionMode): string {
  if (!shouldPlanHelperWrappers(repoRoot, mode)) return "";
  const contract = loadWorkflowContractAsset<WorkflowContractForHelperWrappers>();
  const directory = contract.helpers.compatibilityDirectory ?? "scripts";
  const paths = contract.helpers.scripts.map((helperName) => {
    assertHelperName(helperName);
    return `${directory}/${helperName}`;
  });
  return ["# forge generated helper wrappers", ...paths, `${directory}/forge/`].join("\n");
}

export function helperWrapperOperations(repoRoot: string, mode: AdoptionMode): WriteFileOperation[] {
  if (!shouldPlanHelperWrappers(repoRoot, mode)) return [];
  const contract = loadWorkflowContractAsset<WorkflowContractForHelperWrappers>();
  const directory = contract.helpers.compatibilityDirectory ?? "scripts";
  return contract.helpers.scripts.map((helperName) => {
    assertHelperName(helperName);
    const path = `${directory}/${helperName}`;
    return {
      id: makeOperationId("writeFile", path, "helper-wrapper"),
      kind: "writeFile",
      path,
      content: helperWrapperContent(helperName),
      ifMissing: true,
      mode: EXECUTABLE_MODE,
      reason: "Install forge helper compatibility wrapper",
      risk: "low",
      status: helperWrapperStatus(repoRoot, path),
    };
  });
}
