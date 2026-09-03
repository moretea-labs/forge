import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { observeSetupBootstrap, refreshSetupBootstrap } from '../../src/cli/commands/bootstrap-control';
import type { SetupPlatformSnapshot, SetupProfile } from '../../src/cli/commands/setup-profile';

const platform: SetupPlatformSnapshot = { platform: 'linux', arch: 'x64', environment: 'linux', serviceManager: 'systemd-user', commands: { brew: false, cloudflared: false, tailscale: false, tunnelClient: true, systemctl: true, winget: false } };
const profile: SetupProfile = { schemaVersion: 1, primaryController: 'chatgpt', controllers: ['chatgpt'], tunnel: { provider: 'openai', tunnelId: 'tunnel_0123456789abcdef0123456789abcdef' }, createdAt: '2026-09-03T00:00:00.000Z', updatedAt: '2026-09-03T00:00:00.000Z' };

describe('Stage4 setup bootstrap adapter', () => {
  test('turns a missing setup profile into one Forge-owned resumable action', () => {
    const evaluation = observeSetupBootstrap({ setupRoot: '/definitely/missing/forge-setup', controllerHome: '/tmp/forge-bootstrap-missing', platform, now: () => new Date('2026-09-03T00:00:00.000Z') });
    expect(evaluation.steps.map((entry) => [entry.id, entry.state])).toEqual([['profile', 'blocked'], ['controller', 'pending'], ['runtime', 'pending'], ['connectivity', 'pending']]);
    expect(evaluation.actions[0]?.owner).toBe('forge');
    expect(evaluation.actions[0]?.command).toBe('forge setup configure --controller chatgpt');
  });

  test('classifies OpenAI tunnel creation as explicit user action while keeping controller/runtime repair Forge-owned', () => {
    const withoutTunnel = { ...profile, tunnel: { provider: 'openai' as const } };
    const evaluation = observeSetupBootstrap({
      profile: withoutTunnel, platform, controllerHome: '/tmp/forge-bootstrap-openai',
      dependencies: {
        controller: () => ({ controller: 'chatgpt', ready: false, title: 'Configure controller', detail: 'Refresh OAuth config.', command: 'forge mcp setup chatgpt --user-level' }),
        runtime: () => ({ ready: false, title: 'Install Runtime', detail: 'Runtime missing.', command: 'forge runtime service install-package' }),
        tunnel: () => ({ provider: 'openai', ready: false, title: 'Create an OpenAI Secure MCP Tunnel', detail: 'Create it in OpenAI Platform.', command: 'forge setup configure --tunnel openai --tunnel-id tunnel_...' }),
      },
    });
    expect(evaluation.actions.find((entry) => entry.id.startsWith('controller.'))?.owner).toBe('forge');
    expect(evaluation.actions.find((entry) => entry.id === 'runtime.package.install')?.owner).toBe('forge');
    expect(evaluation.actions.find((entry) => entry.id.startsWith('tunnel.'))?.owner).toBe('user');
    expect(evaluation.blockers.find((entry) => entry.stepId === 'connectivity')?.kind).toBe('user_action');
  });

  test('persists one ready snapshot when controller, Runtime, and transport observations are ready', () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-setup-bootstrap-ready-'));
    try {
      const snapshot = refreshSetupBootstrap({
        profile, platform, controllerHome: root, now: () => new Date('2026-09-03T00:00:00.000Z'),
        dependencies: {
          controller: () => undefined,
          runtime: () => ({ ready: true, title: 'Forge Runtime', detail: 'Canonical Runtime is ready.' }),
          tunnel: () => ({ provider: 'openai', ready: true, title: 'OpenAI Secure MCP Tunnel', detail: 'Tunnel is ready.' }),
        },
      });
      expect(snapshot.status).toBe('ready');
      expect(snapshot.steps.every((entry) => entry.state === 'ready' || entry.state === 'skipped')).toBe(true);
      expect(snapshot.desired.connectivity.preferredTransport).toBe('openai-secure-tunnel');
      expect(JSON.stringify(snapshot)).not.toContain('CONTROL_PLANE_API_KEY');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test('turns capability intent into provider-neutral install and unsupported lifecycle steps', () => {
    const base = {
      profile: { ...profile, capabilityIntents: ['computer.observe.v1', 'knowledge.telepathy.v9'] }, platform, controllerHome: '/tmp/forge-bootstrap-capabilities',
      dependencies: {
        controller: () => undefined,
        runtime: () => ({ ready: true, title: 'Runtime', detail: 'ready' }),
        tunnel: () => ({ provider: 'openai' as const, ready: true, title: 'Tunnel', detail: 'ready' }),
        capabilities: () => [
          { capabilityId: 'computer.observe.v1', status: 'installable' as const, providerId: 'desktop_operator', providerName: 'Desktop Operator', summary: 'Desktop Operator can provide computer.observe.v1.' },
          { capabilityId: 'knowledge.telepathy.v9', status: 'unsupported' as const, summary: 'No provider.' },
        ],
      },
    };
    const evaluation = observeSetupBootstrap(base);
    expect(evaluation.actions.find((entry) => entry.id === 'capability.computer.observe.v1.install')).toMatchObject({ owner: 'forge', command: expect.stringContaining('forge plugin install desktop_operator') });
    expect(evaluation.blockers.find((entry) => entry.stepId === 'capability.knowledge.telepathy.v9')).toMatchObject({ kind: 'unsupported', actionIds: [] });
  });

});
