import { describe, expect, test } from 'bun:test';
import { deriveRuntimeDeploymentTopology, normalizeRuntimeDeploymentTopology } from '../../src/runtime/root/deployment-topology';

describe('Runtime deployment topology', () => {
  test('retains ChatGPT remote session intent without enabling a Supervisor', () => {
    const topology = deriveRuntimeDeploymentTopology({ controllers: ['chatgpt'] });
    expect(topology).toMatchObject({
      remoteControllers: ['chatgpt'],
      persistentRuntimeRequired: true,
    });
    expect(topology).not.toHaveProperty('components');
  });

  test('normalizes historical persisted Supervisor flags out of the new canonical topology', () => {
    const normalized = normalizeRuntimeDeploymentTopology({
      schemaVersion: 1,
      remoteControllers: ['chatgpt'],
      capabilityIntents: [],
      persistentRuntimeRequired: true,
      components: { workflowSupervisor: true, workflowSupervisorNativeBrowser: true },
    });
    expect(normalized.remoteControllers).toEqual(['chatgpt']);
    expect(normalized).not.toHaveProperty('components');
  });
});
