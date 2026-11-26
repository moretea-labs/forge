import { describe, expect, test } from 'bun:test';
import { materializeWorkflowAsset } from '../../packages/workflow-runtime/domain/workflow-asset';
import { materializeWorkflowGraphAsset } from '../../packages/workflow-runtime/domain/workflow-graph';
import {
  materializeWorkflowPackageManifest,
  validateWorkflowPackageManifest,
  workflowPackageManifestDigest,
} from '../../packages/workflow-runtime/domain/workflow-package';

const sequence = materializeWorkflowAsset({
  schemaVersion: 1,
  workflowId: 'package.sequence',
  version: '1',
  title: 'Sequence package',
  inputContract: { message: { type: 'string', required: true } },
  steps: [{ stepId: 'notify', capabilityId: 'notify.send', input: { message: '{{input.message}}' } }],
});
const graph = materializeWorkflowGraphAsset({
  schemaVersion: 2,
  workflowId: 'package.graph',
  version: '2',
  title: 'Graph package',
  entryNodeId: 'inspect',
  nodes: [
    { kind: 'capability', nodeId: 'inspect', capabilityId: 'case.inspect' },
    { kind: 'workflow', nodeId: 'child', workflowId: 'package.sequence' },
  ],
  edges: [{ edgeId: 'e1', from: 'inspect', to: 'child', on: 'success' }],
});

describe('Workflow Package Manifest', () => {
  test('materializes a deterministic package for sequence workflows', () => {
    const manifest = materializeWorkflowPackageManifest(sequence, {
      tags: ['notification', 'utility'],
      runtimeCompatibility: { minRuntimeVersion: '1.8.0' },
      risk: { level: 'external_write', requiresApproval: true },
      publisher: { kind: 'first_party', id: 'forge' },
    });
    expect(manifest).toMatchObject({
      workflowId: 'package.sequence',
      workflowVersion: '1',
      engine: 'sequence_v1',
      requiredCapabilities: ['notify.send'],
      requiredWorkflows: [],
      risk: { level: 'external_write', requiresApproval: true },
    });
    expect(manifest.packageDigest).toBe(workflowPackageManifestDigest(manifest));
  });

  test('requires every child workflow dependency to be version or digest pinned', () => {
    expect(() =>
      materializeWorkflowPackageManifest(graph, {
        requiredWorkflows: [{ workflowId: 'package.sequence' }],
        risk: { level: 'read', requiresApproval: false },
        publisher: { kind: 'user', id: 'greyson' },
      }),
    ).toThrow('WORKFLOW_PACKAGE_CHILD_PIN_REQUIRED:package.sequence');
    const manifest = materializeWorkflowPackageManifest(graph, {
      requiredWorkflows: [{ workflowId: 'package.sequence', version: '1', contentDigest: sequence.contentDigest }],
      risk: { level: 'read', requiresApproval: false },
      publisher: { kind: 'user', id: 'greyson' },
    });
    expect(manifest.requiredWorkflows).toEqual([
      { workflowId: 'package.sequence', version: '1', contentDigest: sequence.contentDigest },
    ]);
  });

  test('prevents package metadata from drifting from the executable asset', () => {
    const manifest = materializeWorkflowPackageManifest(sequence, {
      risk: { level: 'read', requiresApproval: false },
      publisher: { kind: 'import', id: 'bundle-1' },
    });
    expect(() => validateWorkflowPackageManifest({ ...manifest, workflowVersion: '999' }, sequence)).toThrow(
      'WORKFLOW_PACKAGE_CONTENT_IDENTITY_MISMATCH',
    );
    expect(() => validateWorkflowPackageManifest({ ...manifest, requiredCapabilities: [] }, sequence)).toThrow(
      'WORKFLOW_PACKAGE_CAPABILITY_DEPENDENCY_MISMATCH',
    );
  });

  test('requires explicit approval metadata for sensitive packages', () => {
    expect(() =>
      materializeWorkflowPackageManifest(sequence, {
        risk: { level: 'external_write', requiresApproval: false },
        publisher: { kind: 'model', id: 'author-model' },
      }),
    ).toThrow('WORKFLOW_PACKAGE_SENSITIVE_APPROVAL_REQUIRED');
  });

  test('package digest changes when publisher, risk or compatibility metadata changes', () => {
    const first = materializeWorkflowPackageManifest(sequence, {
      runtimeCompatibility: { minRuntimeVersion: '1.8.0' },
      risk: { level: 'read', requiresApproval: false },
      publisher: { kind: 'user', id: 'user-1' },
    });
    const second = materializeWorkflowPackageManifest(sequence, {
      runtimeCompatibility: { minRuntimeVersion: '1.9.0' },
      risk: { level: 'read', requiresApproval: false },
      publisher: { kind: 'user', id: 'user-1' },
    });
    expect(first.packageDigest).not.toBe(second.packageDigest);
  });
});
