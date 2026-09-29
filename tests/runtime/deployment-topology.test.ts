import { describe, expect, test } from 'bun:test';
import { deriveRuntimeDeploymentTopology, normalizeRuntimeDeploymentTopology } from '../../src/runtime/root/deployment-topology';

describe('Runtime deployment topology', () => {
  test('enables the Supervisor Computer executor for a ChatGPT Supervisor', () => {
    expect(deriveRuntimeDeploymentTopology({ controllers: ['chatgpt'] })).toMatchObject({
      components: {
        workflowSupervisor: true,
        workflowSupervisorNativeBrowser: true,
      },
    });
  });

  test('normalizes a legacy persisted native-browser flag to the derived executor', () => {
    expect(normalizeRuntimeDeploymentTopology({
      schemaVersion: 1,
      remoteControllers: ['chatgpt'],
      capabilityIntents: [],
      persistentRuntimeRequired: true,
      components: {
        workflowSupervisor: true,
        workflowSupervisorNativeBrowser: true,
      },
    })).toMatchObject({
      components: {
        workflowSupervisor: true,
        workflowSupervisorNativeBrowser: true,
      },
    });
  });
});
