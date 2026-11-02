import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { registerRepository } from '../../src/cli/repositories/registry';
import { invalidateRepositoryReadCaches } from '../../src/cli/repository/inspector';
import { forgeWorkflowSupervisorLifecycleHooks } from '../../src/runtime/root/workflow-supervisor-composition';
import { join } from 'node:path';
import { WorkflowSupervisorControlPlane } from '../../supervisor/control-plane';
import { WorkflowSupervisorStore } from '../../supervisor/store';
import { WorkflowSupervisorNativeBrowserAdapter } from '../../supervisor/native-browser-adapter';
import { WorkflowSupervisorEphemeralDiscovery } from '../../supervisor/server';
import { CHATGPT_AUTOMATION_RATE_LIMITED, noteChatgptProviderBackpressure } from '../../adapters/chatgpt/provider-delivery';
import type { ComputerChatgptConversationTargetPort } from '../../packages/plugin-runtime/computer';

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });
const graceMs = 30 * 60_000;
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'forge-progress-deadline-'));
  roots.push(home);
  let now = Date.now();
  let progress = 'commit-a';
  const store = new WorkflowSupervisorStore(home, { now: () => now });
  const control = new WorkflowSupervisorControlPlane(store, {}, { workProgressFingerprint: () => progress });
  const taskId = 'deadline-task';
  const conversationId = '12345678-1234-1234-1234-123456789abc';
  const projectUrl = 'https://chatgpt.com/g/g-p-123456789abc/project';
  control.registerTask({ taskId, conversationId: `bootstrap:${taskId}`,
    conversationUrl: 'https://chatgpt.com/',
    objective: 'Finish the existing GitHub Issue using actual source and receipts.',
    completionContract: {}, continuationPolicy: { kind: 'standalone_supervisor' }, userBlockerPolicy: {},
  });
  store.bindBootstrapProject({ taskId, projectUrl, requestId: 'bind-project', authorizedBy: 'test' });
  const effect = control.reserveEnrollment(taskId);
  control.bindBootstrapConversation({ taskId, conversationId, conversationUrl: `https://chatgpt.com/g/g-p-123456789abc-forge/c/${conversationId}` });
  store.recordEffectDispatchStarted(effect.effectId, 1, 'initial-send', { work_progress_fingerprint: progress });
  store.recordEffectObservation(effect.effectId, 'initial-applied', 'applied');
  return { home, store, control, taskId, effect, projectUrl,
    now: () => now, advance: (ms: number) => { now += ms; }, progress: (value: string) => { progress = value; } };
}

test('generating forever expires without inventing a provider terminal or replaying its send', () => {
  const fx = fixture();
  fx.store.observeProviderTurn({ taskId: fx.taskId, effectId: fx.effect.effectId, generating: true,
    assistantDigest: 'spinner', observedAtMs: fx.now(), graceMs,
    recovery: { effectId: 'fx_unused00000000000000000000', prompt: 'unused' } });
  expect(fx.control.recoverProgressDeadline(fx.taskId, fx.now(), graceMs)).toBeUndefined();
  fx.advance(graceMs + 1_000);
  const recovered = fx.control.recoverProgressDeadline(fx.taskId, fx.now(), graceMs)!;
  expect(recovered.action).toBe('recovery_reserved');
  expect(recovered.effect.effectId).not.toBe(fx.effect.effectId);
  expect(fx.store.effectDispatchBudget(fx.effect.effectId).generations).toBe(1);
  expect(fx.store.getProviderTurnEvent(fx.taskId, fx.effect.effectId)).toBeUndefined();
  expect(fx.store.getLatestCompletion(fx.taskId)).toBeUndefined();
  expect(fx.control.recoverProgressDeadline(fx.taskId, fx.now(), graceMs)).toBeUndefined();
  fx.store.close();
});

test('restart preserves an expired deadline; browser text churn never refreshes it', () => {
  const fx = fixture();
  fx.advance(graceMs + 1_000);
  fx.store.close();
  const store = new WorkflowSupervisorStore(fx.home, { now: fx.now });
  const control = new WorkflowSupervisorControlPlane(store, {}, { workProgressFingerprint: () => 'commit-a' });
  expect(control.recoverProgressDeadline(fx.taskId, fx.now(), graceMs)?.action).toBe('recovery_reserved');
  store.close();
});

test('changed durable progress refreshes the deadline, repeated observations do not', () => {
  const fx = fixture();
  fx.advance(graceMs - 1);
  fx.progress('commit-b');
  expect(fx.control.recoverProgressDeadline(fx.taskId, fx.now(), graceMs)).toBeUndefined();
  fx.advance(graceMs - 1);
  expect(fx.control.recoverProgressDeadline(fx.taskId, fx.now(), graceMs)).toBeUndefined();
  fx.advance(2);
  expect(fx.control.recoverProgressDeadline(fx.taskId, fx.now(), graceMs)?.action).toBe('recovery_reserved');
  fx.store.close();
});

test('blocked same-chat recovery escalates atomically to the same Project and fences late old replies', () => {
  const fx = fixture();
  fx.advance(graceMs + 1_000);
  const recovery = fx.control.recoverProgressDeadline(fx.taskId, fx.now(), graceMs)!;
  fx.advance(graceMs + 1_000);
  const migrated = fx.control.recoverProgressDeadline(fx.taskId, fx.now(), graceMs)!;
  expect(migrated.action).toBe('conversation_migrated');
  expect(fx.control.getTask(fx.taskId)?.conversationId).toBe(`bootstrap:${fx.taskId}`);
  expect(fx.control.bootstrapProjectUrl(fx.taskId)).toBe(fx.projectUrl);
  expect(fx.store.hasAppliedEffectAwaitingCompletion(fx.taskId)).toBe(false);
  expect(fx.store.latestAppliedLeafEffectWithoutCompletion(fx.taskId)).toBeUndefined();
  expect(fx.store.currentUnappliedEffect(fx.taskId)?.effectId).toBe(migrated.effect.effectId);
  expect(fx.store.recordEffectDispatchStarted(recovery.effect.effectId, 1, 'late-command')).toBe(false);
  expect(fx.store.effectApplied(fx.effect.effectId)).toBe(true);
  fx.store.close();
});

test('deadline reconciliation happens before even a failed browser inventory', async () => {
  const fx = fixture();
  fx.advance(graceMs + 1_000);
  const targetPort = { inventory: async () => { throw new Error('network offline'); }, close: async () => {} } as unknown as ComputerChatgptConversationTargetPort;
  const adapter = new WorkflowSupervisorNativeBrowserAdapter(fx.control, new WorkflowSupervisorEphemeralDiscovery(), {
    targetPort, nowMs: fx.now, providerIdleGraceMs: graceMs, providerScopeKey: fx.home,
    sleep: async () => {}, setInterval: () => 0 as unknown as ReturnType<typeof setInterval>, clearInterval: () => {}, onError: () => {},
  });
  await expect(adapter.runOnce()).rejects.toThrow('network offline');
  expect(fx.store.currentUnappliedEffect(fx.taskId)?.kind).toBe('recovery');
  await adapter.close(); fx.store.close();
});


test('stopped tasks never recover merely because their deadline expires', () => {
  const fx = fixture();
  fx.store.stopTask(fx.taskId, 'user stopped');
  fx.advance(10 * graceMs);
  expect(fx.control.recoverProgressDeadline(fx.taskId, fx.now(), graceMs)).toBeUndefined();
  fx.store.close();
});

test('429 defers expired recovery and automatically resumes after cooldown', async () => {
  const fx = fixture();
  fx.advance(graceMs + 1_000);
  noteChatgptProviderBackpressure(fx.home, CHATGPT_AUTOMATION_RATE_LIMITED, fx.now());
  const targetPort = { inventory: async () => { throw new Error('offline'); }, close: async () => {} } as unknown as ComputerChatgptConversationTargetPort;
  const adapter = new WorkflowSupervisorNativeBrowserAdapter(fx.control, new WorkflowSupervisorEphemeralDiscovery(), {
    targetPort, nowMs: fx.now, providerIdleGraceMs: graceMs, providerScopeKey: fx.home,
    sleep: async () => {}, setInterval: () => 0 as unknown as ReturnType<typeof setInterval>, clearInterval: () => {}, onError: () => {},
  });
  await expect(adapter.runOnce()).rejects.toThrow('offline');
  expect(fx.store.currentUnappliedEffect(fx.taskId)).toBeUndefined();
  fx.advance(24 * 60 * 60_000);
  await expect(adapter.runOnce()).rejects.toThrow('offline');
  expect(fx.store.currentUnappliedEffect(fx.taskId)?.kind).toBe('recovery');
  await adapter.close(); fx.store.close();
});

test('late old completion cannot create another successor after deadline migration', () => {
  const fx = fixture();
  fx.advance(graceMs + 1_000);
  fx.control.recoverProgressDeadline(fx.taskId, fx.now(), graceMs);
  fx.advance(graceMs + 1_000);
  const migrated = fx.control.recoverProgressDeadline(fx.taskId, fx.now(), graceMs)!;
  expect(() => fx.store.commitCompletion({ taskId: fx.taskId, sourceEffectId: fx.effect.effectId,
    action: 'CONTINUE', completionFingerprint: 'late', responseSha256: 'late', controlBlockSha256: 'late',
    proposal: { action: 'CONTINUE', sourceEffectId: fx.effect.effectId, checkpoint: '', reason: '', evidence: [] },
    committedAt: new Date(fx.now()).toISOString() })).toThrow('WORKFLOW_SUPERVISOR_SOURCE_EFFECT_RETIRED');
  expect(fx.store.currentUnappliedEffect(fx.taskId)?.effectId).toBe(migrated.effect.effectId);
  fx.store.close();
});


test('GitHub-only tasks expose real Git content progress without creating Work', () => {
  const fx = fixture();
  const root = join(fx.home, 'source');
  mkdirSync(root);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.test');
  writeFileSync(join(root, 'code.ts'), 'export const value = 1;');
  git('add', '.'); git('commit', '-qm', 'initial');
  const repository = registerRepository({ path: root, controllerHome: fx.home, displayName: 'deadline-source' });
  const task = { ...fx.control.getTask(fx.taskId)!, completionContract: { repo_id: repository.repoId } };
  const hooks = forgeWorkflowSupervisorLifecycleHooks(fx.home);
  const before = hooks.workProgressFingerprint!(task);
  expect(before).toBeTruthy();
  writeFileSync(join(root, 'code.ts'), 'export const value = 2;');
  invalidateRepositoryReadCaches(repository.canonicalRoot);
  expect(hooks.workProgressFingerprint!(task)).not.toBe(before);
  fx.store.close();
});
