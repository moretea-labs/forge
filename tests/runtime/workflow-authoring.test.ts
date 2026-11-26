import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorkflowAssetDraft, WorkflowGraphAssetDraft } from '../../packages/workflow-runtime/api/index';
import {
  readWorkflowRegistryEntry,
  setWorkflowRegistryStatus,
} from '../../src/runtime/control-plane/persistence/workflow-registry-store';
import { applyWorkflowProposal, preflightWorkflowProposal } from '../../src/runtime/workflows/authoring';

const roots: string[] = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});
function home() {
  const v = mkdtempSync(join(tmpdir(), 'forge-workflow-authoring-'));
  roots.push(v);
  return v;
}
const sequence: WorkflowAssetDraft = {
  schemaVersion: 1,
  workflowId: 'auth.sequence',
  version: '1',
  inputContract: { message: { type: 'string', required: true } },
  steps: [{ stepId: 'run', kind: 'script', scriptRef: 'echo', input: { message: '{{input.message}}' } }],
  scripts: { echo: { runtime: 'node', deterministic: true, body: 'process.stdout.write(process.argv[1]||"")' } },
};
const graph: WorkflowGraphAssetDraft = {
  schemaVersion: 2,
  workflowId: 'auth.graph',
  version: '1',
  entryNodeId: 'start',
  nodes: [
    { kind: 'capability', nodeId: 'start', capabilityId: 'case.inspect', idempotency: 'idempotent' },
    { kind: 'workflow', nodeId: 'child', workflowId: 'auth.sequence' },
  ],
  edges: [{ edgeId: 'e1', from: 'start', to: 'child', on: 'success' }],
};
function proposal(
  author: 'human' | 'ui' | 'model' | 'import' = 'model',
  draft: WorkflowAssetDraft | WorkflowGraphAssetDraft = sequence,
) {
  return {
    schemaVersion: 1 as const,
    proposalId: 'proposal-' + author,
    author: { kind: author, id: author + '-1' },
    scope: { kind: 'controller' as const },
    operation: { kind: 'create' as const },
    draft,
  };
}

describe('Workflow Authoring Proposal', () => {
  test('uses the same deterministic proposal path for human, UI, model and import authors', () => {
    const h = home();
    for (const author of ['human', 'ui', 'model', 'import'] as const) {
      const checked = preflightWorkflowProposal(h, proposal(author));
      expect(checked.valid).toBe(true);
      expect(checked.author.kind).toBe(author);
      expect(checked.descriptor.engine).toBe('sequence_v1');
    }
  });
  test('model-authored workflow can be installed but is never activated by authoring', () => {
    const h = home();
    expect(() =>
      applyWorkflowProposal(
        h,
        proposal('model'),
        { kind: 'controller', controllerHome: h },
        { canInstallWorkflows: false },
      ),
    ).toThrow('WORKFLOW_PROPOSAL_INSTALL_NOT_AUTHORIZED');
    const installed = applyWorkflowProposal(
      h,
      proposal('model'),
      { kind: 'controller', controllerHome: h },
      { canInstallWorkflows: true },
    );
    expect(installed.value.status).toBe('installed');
    expect(readWorkflowRegistryEntry(h, { kind: 'controller' }, 'auth.sequence')?.value.status).toBe('installed');
    setWorkflowRegistryStatus({
      controllerHome: h,
      scope: { kind: 'controller' },
      workflowId: 'auth.sequence',
      status: 'active',
      expectedRevision: installed.revision,
    });
    expect(readWorkflowRegistryEntry(h, { kind: 'controller' }, 'auth.sequence')?.value.status).toBe('active');
  });
  test('preflights graph engine dependencies without executing or activating them', () => {
    const h = home();
    const checked = preflightWorkflowProposal(h, proposal('ui', graph));
    expect(checked.valid).toBe(true);
    expect(checked.descriptor.engine).toBe('graph_v2');
    expect(checked.descriptor.childWorkflowDependencies).toEqual(['auth.sequence']);
    expect(checked.warnings.map((x) => x.code)).toEqual([
      'WORKFLOW_PROPOSAL_CHILD_NOT_INSTALLED',
      'WORKFLOW_PROPOSAL_CAPABILITY_BINDINGS_REQUIRED',
    ]);
  });
  test('create refuses existing IDs and update uses optimistic registry revision', () => {
    const h = home();
    const installed = applyWorkflowProposal(
      h,
      proposal('human'),
      { kind: 'controller', controllerHome: h },
      { canInstallWorkflows: true },
    );
    expect(preflightWorkflowProposal(h, proposal('model')).issues.map((x) => x.code)).toContain(
      'WORKFLOW_PROPOSAL_ALREADY_EXISTS',
    );
    const update = {
      ...proposal('model', { ...sequence, version: '2' }),
      proposalId: 'proposal-update',
      operation: { kind: 'update' as const, expectedRegistryRevision: installed.revision },
    };
    expect(preflightWorkflowProposal(h, update).valid).toBe(true);
    const updated = applyWorkflowProposal(
      h,
      update,
      { kind: 'controller', controllerHome: h },
      { canInstallWorkflows: true },
    );
    expect(updated.value.version).toBe('2');
    expect(updated.value.status).toBe('installed');
    const stale = {
      ...update,
      proposalId: 'proposal-stale',
      operation: { kind: 'update' as const, expectedRegistryRevision: installed.revision },
      draft: { ...sequence, version: '3' },
    };
    expect(preflightWorkflowProposal(h, stale).issues.map((x) => x.code)).toContain(
      'WORKFLOW_PROPOSAL_REVISION_CONFLICT',
    );
  });
  test('proposal cannot smuggle lifecycle activation or arbitrary fields', () => {
    const h = home();
    expect(() => preflightWorkflowProposal(h, { ...proposal(), status: 'active' })).toThrow(
      'WORKFLOW_PROPOSAL_FIELD_UNSUPPORTED',
    );
  });
});
