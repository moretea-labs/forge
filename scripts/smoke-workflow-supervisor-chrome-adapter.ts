import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { WorkflowSupervisorControlPlane } from '../supervisor/control-plane';
import { SUPERVISOR_BLOCK_END, SUPERVISOR_BLOCK_START } from '../supervisor/protocol';
import { WorkflowSupervisorStore } from '../supervisor/store';
import { NativeMessageDecoder, encodeNativeMessage } from '../supervisor/native-messaging/protocol';
import { renderWorkflowSupervisorNativeManifest } from '../supervisor/native-messaging/manifest';
import { ALLOWED_BROWSER_METHODS } from '../supervisor/native-messaging/host';
import { WorkflowSupervisorEphemeralDiscovery } from '../supervisor/server';

const home = mkdtempSync(join(tmpdir(), 'forge-supervisor-chrome-'));
try {
  const control = new WorkflowSupervisorControlPlane(new WorkflowSupervisorStore(home), { completionContract: async () => ({ valid: true, reason: 'ok' }), userBlockerPolicy: async () => ({ valid: true, reason: 'ok' }) });
  const conversationId = 'WEB:11111111-2222-3333-4444-555555555555';
  const conversationUrl = `https://chatgpt.com/c/${conversationId}`;
  control.registerTask({ taskId: 'task-1', conversationId, conversationUrl, objective: 'Keep implementing the original Forge goal.', completionContract: {}, continuationPolicy: {}, userBlockerPolicy: {} });
  const enrollment = control.reserveEnrollment('task-1');
  assert.equal(control.browserTasks().length, 1);
  let poll = control.browserPoll({ conversationId, conversationUrl });
  assert.equal(poll.command?.mode, 'send'); assert.equal(poll.command?.effectId, enrollment.effectId);
  assert.equal(control.browserBeginEffect({ conversationId, conversationUrl, effectId: enrollment.effectId, dispatchId: 'dispatch-1', dispatchGeneration: poll.command!.dispatchGeneration, evidence: { latest_user_text: '', latest_assistant_response: '' } }).started, true);
  poll = control.browserPoll({ conversationId, conversationUrl }); assert.equal(poll.command?.mode, 'reconcile');
  control.browserObserveEffect({ conversationId, conversationUrl, effectId: enrollment.effectId, observationId: 'observed-1', outcome: 'applied', evidence: { exact: true } });
  const response = `Work remains.\n${SUPERVISOR_BLOCK_START}\n${JSON.stringify({ action: 'CONTINUE', source_effect_id: enrollment.effectId, checkpoint: 'step 4', reason: 'more work', evidence: ['receipt'], conversation_id: conversationId, task_id: 'task-1', supervisor_state: 'running', active_scope: 'goal:task-1' })}\n${SUPERVISOR_BLOCK_END}`;
  const observed = await control.browserObserveAssistant({ conversationId, conversationUrl, responseText: response });
  assert.equal(observed.action, 'CONTINUE'); assert.ok(observed.successorEffect);
  poll = control.browserPoll({ conversationId, conversationUrl }); assert.equal(poll.command?.effectId, observed.successorEffect?.effectId); assert.equal(poll.command?.mode, 'send');
  const projectRoutePoll = control.browserPoll({ conversationId, conversationUrl: `https://chatgpt.com/g/not-the-same/c/${conversationId}` });
  assert.equal(projectRoutePoll.command?.effectId, observed.successorEffect?.effectId);
  assert.equal(projectRoutePoll.command?.mode, 'send');

  const doneConversationId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const doneConversationUrl = `https://chatgpt.com/c/${doneConversationId}`;
  control.registerTask({ taskId: 'task-done', conversationId: doneConversationId, conversationUrl: doneConversationUrl, objective: 'Finish once.', completionContract: {}, continuationPolicy: {}, userBlockerPolicy: {} });
  const doneEffect = control.reserveEnrollment('task-done');
  const donePoll = control.browserPoll({ conversationId: doneConversationId, conversationUrl: doneConversationUrl });
  control.browserBeginEffect({ conversationId: doneConversationId, conversationUrl: doneConversationUrl, effectId: doneEffect.effectId, dispatchId: 'dispatch-done', dispatchGeneration: donePoll.command!.dispatchGeneration, evidence: { latest_user_text: '', latest_assistant_response: '' } });
  control.browserObserveEffect({ conversationId: doneConversationId, conversationUrl: doneConversationUrl, effectId: doneEffect.effectId, observationId: 'observed-done', outcome: 'applied' });
  const doneResponse = `${SUPERVISOR_BLOCK_START}\n${JSON.stringify({ action: 'DONE', source_effect_id: doneEffect.effectId, checkpoint: 'done', reason: 'complete', evidence: ['receipt'], conversation_id: doneConversationId, task_id: 'task-done', supervisor_state: 'done', active_scope: 'goal:task-done' })}\n${SUPERVISOR_BLOCK_END}`;
  assert.equal((await control.browserObserveAssistant({ conversationId: doneConversationId, conversationUrl: doneConversationUrl, responseText: doneResponse })).terminal, true);
  assert.equal(control.browserTasks().some((task) => task.taskId === 'task-done'), false);

  const decoder = new NativeMessageDecoder(); const framed = encodeNativeMessage({ id: 'a', method: 'health', params: {} });
  assert.deepEqual(decoder.push(framed.subarray(0, 3)), []); assert.deepEqual(decoder.push(framed.subarray(3)), [{ id: 'a', method: 'health', params: {} }]);
  const manifest = JSON.parse(renderWorkflowSupervisorNativeManifest({ executablePath: '/tmp/forge-workflow-supervisor-host', extensionId: 'a'.repeat(32) }));
  assert.equal(manifest.allowed_origins[0], `chrome-extension://${'a'.repeat(32)}/`);

  const discovery = new WorkflowSupervisorEphemeralDiscovery();
  const discovered = discovery.update([
    { conversation_id: conversationId, canonical_url: conversationUrl, title: ' Avela development ' },
    { conversation_id: conversationId, canonical_url: conversationUrl, title: 'duplicate tab' },
    { conversation_id: doneConversationId, canonical_url: doneConversationUrl },
  ]);
  assert.equal(discovered.conversations.length, 2);
  assert.deepEqual(discovered.conversations[0], { conversationId, canonicalUrl: conversationUrl, title: 'Avela development' });
  assert.equal(discovery.get().conversations[1]?.canonicalUrl, doneConversationUrl);
  assert.equal(control.browserTasks().length, 1);
  assert.equal(ALLOWED_BROWSER_METHODS.has('browser_discovery'), true);
  assert.equal(ALLOWED_BROWSER_METHODS.has('browser_discovery_update'), true);
  assert.equal(ALLOWED_BROWSER_METHODS.has('computer_extension_claim'), true);
  assert.equal(ALLOWED_BROWSER_METHODS.has('browser_poll'), false);
  assert.equal(ALLOWED_BROWSER_METHODS.has('browser_begin_effect'), false);
  assert.throws(() => discovery.update([{ conversation_id: conversationId, canonical_url: 'https://example.com/c/not-chatgpt' }]), /CHATGPT_URL_INVALID/);

  const coreSource = readFileSync(resolve('adapters/computer/chrome-extension/core.js'), 'utf8');
  new Function(coreSource)();
  const browserCore = (globalThis as unknown as { ForgeComputerChatgptCore: { parseConversation(value: string): { conversationId: string; canonicalUrl: string } | null } }).ForgeComputerChatgptCore;
  assert.equal(browserCore.parseConversation(conversationUrl)?.conversationId, conversationId);
  assert.equal(browserCore.parseConversation(`https://example.com/c/${conversationId}`), null);
  const extensionManifest = JSON.parse(readFileSync(resolve('adapters/computer/chrome-extension/manifest.json'), 'utf8')) as { permissions?: string[] };
  assert.equal(extensionManifest.permissions?.includes('storage'), false);
  const backgroundSource = readFileSync(resolve('adapters/computer/chrome-extension/background.js'), 'utf8');
  assert.ok(backgroundSource.includes('const PROVIDER_INSTANCE_ID = randomId()'));
  assert.equal(backgroundSource.includes('chrome.storage'), false);
  assert.ok(backgroundSource.includes("nativeRpc('computer_extension_heartbeat'"));
  assert.ok(backgroundSource.includes('providerInstanceId: instanceId'));
  assert.ok(backgroundSource.includes("nativeRpc('computer_extension_claim', { provider_instance_id: instanceId })"));
  assert.ok(backgroundSource.includes("nativeRpc('computer_extension_complete', { provider_instance_id: instanceId"));
  assert.ok(backgroundSource.includes('chrome.runtime.connectNative'));
  assert.ok(backgroundSource.includes('chrome.tabs.create({ url, active: false }'));
  for (const forbidden of ['browser_begin_effect', 'browser_observe_effect', 'browser_poll', 'browser_tasks', 'browser_observe_assistant', 'task_register', 'reserve_enrollment']) assert.equal(backgroundSource.includes(forbidden), false);
  const contentSource = readFileSync(resolve('adapters/computer/chrome-extension/content.js'), 'utf8');
  assert.ok(contentSource.includes('forge-computer-chatgpt-snapshot'));
  assert.ok(contentSource.includes('forge-computer-chatgpt-dispatch'));
  assert.ok(contentSource.includes('new MutationObserver(notify).observe'));
  console.log('[workflow-supervisor-chrome-smoke] OK');
} finally { rmSync(home, { recursive: true, force: true }); }
