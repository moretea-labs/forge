import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs';
import { dirname, join, relative, resolve, sep } from 'path';
import {
  materializeWorkflowAsset,
  validateWorkflowAsset,
  type WorkflowAssetDefinition,
  type WorkflowAssetDraft,
} from '../../../../packages/workflow-runtime/api/index';
import { ensureControllerWorkflowContentRoot } from '../../../cli/repositories/controller-home';

export interface ProjectWorkflowAssetContract {
  schemaVersion: 1;
  projectId: string;
  projectRoot: string;
  /** Project-root-relative human content directory. */
  workflowAssetDirectory: string;
}

export type WorkflowAssetContentLocation =
  | { kind: 'controller'; controllerHome: string }
  | { kind: 'project'; contract: ProjectWorkflowAssetContract };

const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/;

function safeSegment(value: string, label: string): string {
  if (!SAFE_SEGMENT.test(value)) throw new Error(`WORKFLOW_CONTENT_${label.toUpperCase()}_INVALID: ${value}`);
  return value;
}

function projectContentRoot(contract: ProjectWorkflowAssetContract): string {
  if (contract.schemaVersion !== 1 || !SAFE_SEGMENT.test(contract.projectId)) {
    throw new Error('WORKFLOW_PROJECT_CONTRACT_INVALID');
  }
  const projectRoot = resolve(contract.projectRoot);
  if (!contract.workflowAssetDirectory.trim()) throw new Error('WORKFLOW_PROJECT_ASSET_DIRECTORY_REQUIRED');
  const contentRoot = resolve(projectRoot, contract.workflowAssetDirectory);
  const rel = relative(projectRoot, contentRoot);
  if (!rel || rel === '.' || rel.startsWith(`..${sep}`) || rel === '..') {
    throw new Error('WORKFLOW_PROJECT_ASSET_DIRECTORY_OUTSIDE_PROJECT');
  }
  const normalized = rel.split(sep).join('/');
  if (normalized === '.forge' || normalized.startsWith('.forge/')
    || normalized === '_ops' || normalized.startsWith('_ops/')
    || normalized === '.ai/harness' || normalized.startsWith('.ai/harness/')) {
    throw new Error('WORKFLOW_PROJECT_ASSET_DIRECTORY_HIDDEN_RUNTIME_STATE_FORBIDDEN');
  }
  return contentRoot;
}

export function workflowAssetContentRoot(location: WorkflowAssetContentLocation): string {
  return location.kind === 'controller'
    ? ensureControllerWorkflowContentRoot(location.controllerHome)
    : projectContentRoot(location.contract);
}

export function workflowAssetContentPath(
  location: WorkflowAssetContentLocation,
  workflowId: string,
  version: string,
): string {
  return join(workflowAssetContentRoot(location), safeSegment(workflowId, 'workflow_id'), safeSegment(version, 'version'), 'workflow.json');
}

function writeAtomically(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(temporary, content, { encoding: 'utf8', mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    try { rmSync(temporary, { force: true }); } catch { /* best effort */ }
  }
}

export function writeWorkflowAssetContent(
  location: WorkflowAssetContentLocation,
  draft: WorkflowAssetDraft,
): { asset: WorkflowAssetDefinition; path: string } {
  const asset = materializeWorkflowAsset(draft);
  const path = workflowAssetContentPath(location, asset.workflowId, asset.version);
  writeAtomically(path, `${JSON.stringify(asset, null, 2)}\n`);
  return { asset, path };
}

export function readWorkflowAssetContent(
  location: WorkflowAssetContentLocation,
  workflowId: string,
  version: string,
): { asset: WorkflowAssetDefinition; path: string } {
  const path = workflowAssetContentPath(location, workflowId, version);
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as WorkflowAssetDefinition;
  return { asset: validateWorkflowAsset(parsed), path };
}

export function readWorkflowAssetContentFile(path: string): WorkflowAssetDefinition {
  const parsed = JSON.parse(readFileSync(resolve(path), 'utf8')) as WorkflowAssetDefinition;
  return validateWorkflowAsset(parsed);
}
