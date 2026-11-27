import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { readIosWorkflowConfig } from '../../src/runtime/safe-tooling/ios-workflow-config';

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

function repository() {
  const root = mkdtempSync(join(tmpdir(), 'forge-ios-workflow-'));
  roots.push(root);
  return root;
}

function writeConfig(root: string, value: unknown) {
  const directory = join(root, '.forge');
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'ios-workflow.json'), JSON.stringify(value), 'utf8');
}

describe('Forge shared iOS workflow config', () => {
  test('uses automatic discovery defaults when a project has no config', () => {
    const root = repository();
    const result = readIosWorkflowConfig(root);
    expect(result.ready).toBe(true);
    if (!result.ready) throw new Error('unexpected config error');
    expect(result.configured).toBe(false);
    expect(result.config.schemaVersion).toBe(1);
  });

  test('loads project, Simulator preview, physical-device and explicit test defaults', () => {
    const root = repository();
    writeConfig(root, {
      schemaVersion: 1,
      project: {
        workspace: 'App.xcworkspace',
        scheme: 'App',
        configuration: 'Debug',
        bundleId: 'com.example.app',
      },
      preview: {
        target: 'simulator',
        simulator: { name: 'iPhone 17 Pro', udid: 'SIM-1' },
        cleanupPolicy: 'keep',
        launchWaitMs: 0,
        screenshotLabel: 'acceptance',
      },
      tests: {
        scheme: 'AppTests',
        simulator: { udid: 'SIM-1' },
        onlyTesting: ['AppTests/LaunchTests/testLaunch'],
        parallelTesting: false,
        maxParallelTestingWorkers: 1,
      },
    });
    const result = readIosWorkflowConfig(root);
    expect(result.ready).toBe(true);
    if (!result.ready) throw new Error('unexpected config error');
    expect(result.configured).toBe(true);
    expect(result.config.project?.workspace).toBe('App.xcworkspace');
    expect(result.config.preview?.simulator?.udid).toBe('SIM-1');
    expect(result.config.tests?.onlyTesting).toEqual(['AppTests/LaunchTests/testLaunch']);
    expect(result.config.tests?.parallelTesting).toBe(false);
  });

  test('rejects unknown fields and unsupported schema versions', () => {
    const root = repository();
    writeConfig(root, { schemaVersion: 1, preview: { simulatorName: 'not-a-supported-key' } });
    const result = readIosWorkflowConfig(root);
    expect(result.ready).toBe(false);
    if (result.ready) throw new Error('expected invalid config');
    expect(result.error.code).toBe('IOS_WORKFLOW_CONFIG_INVALID');
    expect(result.error.message).toContain('unsupported field');

    writeConfig(root, { schemaVersion: 2 });
    const unsupported = readIosWorkflowConfig(root);
    expect(unsupported.ready).toBe(false);
    if (unsupported.ready) throw new Error('expected invalid config');
    expect(unsupported.error.message).toContain('schemaVersion must be 1');
  });

  test('requires an exact UDID for physical-device build targets', () => {
    const root = repository();
    writeConfig(root, { schemaVersion: 1, preview: { target: 'physical_device', physicalDevice: { selector: 'greyson' } } });
    const missingUdid = readIosWorkflowConfig(root);
    expect(missingUdid.ready).toBe(false);
    if (missingUdid.ready) throw new Error('expected physical-device UDID requirement');
    expect(missingUdid.error.message).toContain('preview.physicalDevice.udid is required');

    writeConfig(root, {
      schemaVersion: 1,
      preview: { target: 'physical_device', physicalDevice: { selector: 'greyson', udid: '00008150-TEST' } },
    });
    const valid = readIosWorkflowConfig(root);
    expect(valid.ready).toBe(true);
    if (!valid.ready) throw new Error('expected valid physical-device config');
    expect(valid.config.preview?.physicalDevice?.udid).toBe('00008150-TEST');
  });

  test('rejects repository path traversal and excessive parallel test workers', () => {
    const root = repository();
    writeConfig(root, { schemaVersion: 1, project: { workspace: '../Other.xcworkspace' } });
    const traversal = readIosWorkflowConfig(root);
    expect(traversal.ready).toBe(false);
    if (traversal.ready) throw new Error('expected path rejection');
    expect(traversal.error.message).toContain('must stay inside the repository');

    writeConfig(root, { schemaVersion: 1, tests: { maxParallelTestingWorkers: 3 } });
    const workers = readIosWorkflowConfig(root);
    expect(workers.ready).toBe(false);
    if (workers.ready) throw new Error('expected worker limit rejection');
    expect(workers.error.message).toContain('must be 1 or 2');
  });
});
