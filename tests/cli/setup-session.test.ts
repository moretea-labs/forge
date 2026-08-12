import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { closeSetupSession, openSetupSession, readSetupSession, type InitHookReport } from '../../src/cli/commands/init-hook';
import { configureSetupProfile, type SetupPlatformSnapshot } from '../../src/cli/commands/setup-profile';
import { runMcpSetupChatgpt } from '../../src/cli/mcp/setup';

const platform: SetupPlatformSnapshot = { platform: 'linux', arch: 'x64', environment: 'linux', serviceManager: 'systemd-user', commands: { brew: false, cloudflared: false, tailscale: false, tunnelClient: false, systemctl: true, winget: false } };
function report(target: InitHookReport['target'] = 'none', status: InitHookReport['status'] = 'ok', action = false): InitHookReport {
  return { version: 1, status, target, checkUpdates: false, summary: { ok: status === 'ok' ? 1 : 0, warn: status === 'attention' ? 1 : 0, fail: status === 'blocked' ? 1 : 0, na: 0, needs_agent: action ? 1 : 0 }, checks: [], agent_actions: action ? [{ id: 'runtime.install', status: 'needs_agent', reason: 'Install runtime.', requires_agent: true, risk: 'local write', command: 'forge runtime service install', verification: 'forge setup next' }] : [] };
}
function temp(prefix: string): string { return mkdtempSync(join(tmpdir(), prefix)); }

describe('Forge setup session', () => {
  test('starts by choosing one external controller instead of Codex/Claude tooling', () => {
    const root = temp('forge-setup-select-'); try {
      const session = openSetupSession({ setupRoot: root, report: report(), platform, uuid: () => 's1', now: () => new Date('2026-08-12T00:00:00Z') });
      expect(session).toMatchObject({ status: 'open', target: 'none', nextAction: { id: 'controller.select', command: 'forge setup configure --controller chatgpt' } });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('ChatGPT is controller-first and does not require Codex or Claude host tooling', () => {
    const root = temp('forge-setup-chatgpt-'); try {
      const endpoint = 'https://forge.example.com/mcp', controllerHome = join(root, 'controller');
      const profile = configureSetupProfile({ setupRoot: root, controller: 'chatgpt', tunnel: 'existing', endpoint });
      runMcpSetupChatgpt({ controllerHome, userLevel: true, endpoint });
      const localConfig = JSON.parse(require('fs').readFileSync(join(controllerHome, 'mcp', 'mcp.local.json'), 'utf8'));
      expect(localConfig.localController).toMatchObject({ enabled: false, mode: 'disabled' });
      const session = openSetupSession({ setupRoot: root, controllerHome, accountHome: root, profile, report: report('none'), platform, uuid: () => 's2' });
      expect(session).toMatchObject({ status: 'open', target: 'none', profile: { primaryController: 'chatgpt', controllers: ['chatgpt'] }, nextAction: { id: 'runtime.package.install', command: 'forge runtime service install-package' } });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('only explicitly configured local controllers enable their host-tooling checks', () => {
    const root = temp('forge-setup-local-'); try {
      const codex = configureSetupProfile({ setupRoot: root, controller: 'codex' });
      expect(openSetupSession({ setupRoot: root, profile: codex, report: report('codex'), platform }).target).toBe('codex');
      const both = configureSetupProfile({ setupRoot: root, controller: 'codex', addControllers: ['claude'] });
      expect(openSetupSession({ setupRoot: root, profile: both, report: report('both'), platform }).target).toBe('both');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('persists multiple controller entries while keeping one primary controller', () => {
    const root = temp('forge-setup-multi-'); try {
      const profile = configureSetupProfile({ setupRoot: root, controller: 'chatgpt', addControllers: ['codex', 'claude'], tunnel: 'existing', endpoint: 'https://forge.example.com/mcp' });
      const session = openSetupSession({ setupRoot: root, controllerHome: join(root, 'controller'), accountHome: root, profile, report: report('both'), platform, uuid: () => 's3', now: () => new Date('2026-08-12T00:00:00Z') });
      expect(session.profile).toMatchObject({ primaryController: 'chatgpt', controllers: ['chatgpt', 'codex', 'claude'] });
      expect(readSetupSession({ setupRoot: root })?.sessionId).toBe('s3');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });


  test('stores only the non-secret OpenAI tunnel id and never an API key', () => {
    const root = temp('forge-setup-openai-tunnel-'); try {
      const tunnelId = 'tunnel_0123456789abcdef0123456789abcdef';
      const profile = configureSetupProfile({ setupRoot: root, controller: 'chatgpt', tunnel: 'openai', tunnelId });
      expect(profile.tunnel).toEqual({ provider: 'openai', tunnelId });
      expect(JSON.stringify(profile)).not.toContain('API_KEY');
      expect(JSON.stringify(profile)).not.toContain('sk-');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('closes only after the selected controller path is ready', () => {
    const root = temp('forge-setup-close-'); try {
      mkdirSync(join(root, '.codex'), { recursive: true });
      writeFileSync(join(root, '.codex', 'config.toml'), '[mcp_servers.forge]\ncommand = "forge"\nargs = ["mcp", "serve", "--profile", "controller"]\n');
      const profile = configureSetupProfile({ setupRoot: root, controller: 'codex' });
      expect(closeSetupSession({ setupRoot: root, accountHome: root, profile, report: report('codex', 'attention', true), platform }).status).toBe('open');
      expect(closeSetupSession({ setupRoot: root, accountHome: root, profile, report: report('codex'), platform, now: () => new Date('2026-08-12T00:02:00Z') })).toMatchObject({ status: 'closed', closedAt: '2026-08-12T00:02:00.000Z' });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
