import { describe, expect, test } from 'bun:test';
import { materializeWorkflowAsset } from '../../packages/workflow-runtime/domain/workflow-asset';
import {
  materializeWorkflowPackageBundle,
  parseWorkflowPackageBundle,
  serializeWorkflowPackageBundle,
  validateWorkflowPackageBundle,
} from '../../packages/workflow-runtime/domain/workflow-package-bundle';

const asset = materializeWorkflowAsset({
  schemaVersion: 1,
  workflowId: 'bundle.demo',
  version: '3',
  title: 'Bundle demo',
  inputContract: { message: { type: 'string', required: true } },
  steps: [{ stepId: 'notify', capabilityId: 'notify.send', input: { message: '{{input.message}}' } }],
});

function bundle() {
  return materializeWorkflowPackageBundle(asset, {
    tags: ['demo'],
    runtimeCompatibility: { minRuntimeVersion: '1.8.0' },
    risk: { level: 'external_write', requiresApproval: true },
    publisher: { kind: 'plugin', id: 'demo-plugin' },
  });
}

describe('Workflow Package Bundle', () => {
  test('round-trips a stable manifest plus executable asset without lifecycle state', () => {
    const first = bundle();
    const serialized = serializeWorkflowPackageBundle(first);
    const parsed = parseWorkflowPackageBundle(serialized);
    expect(parsed).toEqual(first);
    expect(serialized).toBe(serializeWorkflowPackageBundle(parsed));
    expect(serialized).not.toContain('"status"');
    expect(serialized).not.toContain('"active"');
  });

  test('rejects asset tampering even when manifest itself was previously valid', () => {
    const first = bundle();
    const tampered = {
      ...first,
      asset: { ...first.asset, version: '4' },
    };
    expect(() => validateWorkflowPackageBundle(tampered)).toThrow();
  });

  test('rejects manifest tampering against the embedded executable asset', () => {
    const first = bundle();
    expect(() =>
      validateWorkflowPackageBundle({
        ...first,
        manifest: { ...first.manifest, requiredCapabilities: [] },
      }),
    ).toThrow('WORKFLOW_PACKAGE_CAPABILITY_DEPENDENCY_MISMATCH');
  });

  test('rejects arbitrary top-level fields so imports cannot smuggle install/activation authority', () => {
    expect(() => validateWorkflowPackageBundle({ ...bundle(), activate: true })).toThrow(
      'WORKFLOW_PACKAGE_BUNDLE_FIELD_UNSUPPORTED',
    );
  });

  test('fails closed on malformed JSON import', () => {
    expect(() => parseWorkflowPackageBundle('{bad-json')).toThrow('WORKFLOW_PACKAGE_BUNDLE_JSON_INVALID');
  });
});
