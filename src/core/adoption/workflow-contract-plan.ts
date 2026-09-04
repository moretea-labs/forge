import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import type { WriteFileOperation } from "./operations";
import { makeOperationId } from "./operations";

/**
 * Repository opt-in is declarative source configuration. Runtime state belongs
 * in Controller Home; the historical .ai/harness/workflow-contract.json path is
 * migration input only.
 */
export const WORKFLOW_CONTRACT_RUNTIME_PATH = "forge.config.json";
const WORKFLOW_CONTRACT_OPERATION_ID = makeOperationId("writeFile", WORKFLOW_CONTRACT_RUNTIME_PATH, "forge-project-config");
const PROJECT_CONFIG = `${JSON.stringify({
  schemaVersion: 1,
  forge: { enabled: true },
  runtimeState: "controller-home",
}, null, 2)}\n`;

function projectConfigStatus(repoRoot: string): WriteFileOperation["status"] {
  const target = resolve(repoRoot, WORKFLOW_CONTRACT_RUNTIME_PATH);
  if (!existsSync(target)) return "planned";
  return readFileSync(target, "utf-8") === PROJECT_CONFIG ? "skipped" : "planned";
}

export function workflowContractInstallOperation(repoRoot: string): WriteFileOperation {
  return {
    id: WORKFLOW_CONTRACT_OPERATION_ID,
    kind: "writeFile",
    path: WORKFLOW_CONTRACT_RUNTIME_PATH,
    content: PROJECT_CONFIG,
    reason: "Install the declarative Forge project marker; mutable Runtime state stays in Controller Home",
    risk: "low",
    status: projectConfigStatus(repoRoot),
  };
}

export function isWorkflowContractInstallOperation(operation: WriteFileOperation): boolean {
  return operation.id === WORKFLOW_CONTRACT_OPERATION_ID && operation.path === WORKFLOW_CONTRACT_RUNTIME_PATH;
}
