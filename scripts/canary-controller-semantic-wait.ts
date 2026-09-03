#!/usr/bin/env bun
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ensureControllerHome } from '../src/cli/repositories/controller-home';
import { registerRepository } from '../src/cli/repositories/registry';
import { createRequirement, updateRequirement } from '../src/runtime/control-plane/persistence/requirement-store';
import { createWorkContract, updateWorkContract } from '../src/runtime/control-plane/facade/work-contract-store';
import { claimControllerSession } from '../src/runtime/control-plane/facade/controller-session-store';
import {
  acknowledgeControllerRoundClaim,
  beginInitialControllerRoundDispatch,
  finishControllerRoundRelayDispatch,
  getControllerRoundRelay,
  readControllerRoundSemanticStateFingerprint,
  submitControllerRoundDisposition,
} from '../src/runtime/control-plane/facade/controller-round-relay';
import { bindControllerSessionBinding } from '../packages/kernel/controller/api/index';
import { resumeScheduledControllerContinuation } from '../packages/kernel/scheduler/api/index';
import { upsertChatgptControllerBinding } from '../adapters/chatgpt/controller-binding-store';
import { createWorkContinuationSchedule } from '../src/runtime/workflow/schedules/work-continuation';

const root = mkdtempSync(join(tmpdir(), 'forge-stage3c-semantic-wait-canary-'));
const controllerHome = join(root, 'controller');
const repoRoot = join(root, 'repo');
const workId = 'WORK-STAGE3C-SEMANTIC-WAIT-CANARY';
const requirementId = 'REQ-STAGE3C-SEMANTIC-WAIT-CANARY';

function git(args: string[]): void {
  execFileSync('git', args, { cwd: repoRoot, stdio: 'ignore' });
}

try {
  ensureControllerHome(controllerHome);
  mkdirSync(repoRoot, { recursive: true });
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 'forge-canary@example.test']);
  git(['config', 'user.name', 'Forge Stage3C Canary']);
  writeFileSync(join(repoRoot, 'README.md'), 'stage3c semantic wait canary\n');
  git(['add', '.']);
  git(['commit', '-qm', 'fixture']);

  const repository = registerRepository({ path: repoRoot, controllerHome, displayName: 'stage3c-semantic-wait-canary' });
  const store = { controllerHome, repoId: repository.repoId };
  createRequirement({ controllerHome }, {
    requirementId,
    title: 'Stage3C semantic wait canary',
    outcomeStatement: 'Unchanged semantic wait does not dispatch a provider; one semantic change wakes one successor.',
    acceptanceCriteria: ['zero provider dispatch while unchanged', 'exactly one provider dispatch after semantic change'],
  });
  updateRequirement({ controllerHome }, {
    requirementId,
    action: 'stage3c_canary_requirement_activate',
    mutate: (current) => ({ ...current, state: 'active' }),
  });
  createWorkContract(store, {
    workId,
    repoId: repository.repoId,
    requirementId,
    checkoutId: repository.activeCheckoutId,
    mode: 'goal_workloop',
    objective: 'Prove semantic wait admission before provider dispatch.',
    acceptanceCriteria: ['Unchanged semantic state stays quiescent.', 'One meaningful state change wakes one successor.'],
    allowedPaths: [],
    forbiddenPaths: [],
    checks: [],
    constraints: { requireHandoffOnAmbiguity: true },
    requestedBy: 'chatgpt',
    status: 'ready',
  });

  const owner = claimControllerSession(store, {
    workId,
    controllerId: 'stage3c-canary-controller',
    controllerType: 'chatgpt',
    sessionId: 'stage3c-canary-session',
    principalId: 'stage3c-canary-controller',
    controllerInstanceId: 'stage3c-canary-runtime',
    leaseMs: 60_000,
  });
  const adapter = upsertChatgptControllerBinding(store, {
    workId,
    sessionId: owner.sessionId,
    title: 'Stage3C canary provider target',
    model: 'gpt-5.6',
    reasoning: 'high',
    tabPolicy: 'auto',
  });
  bindControllerSessionBinding(store, { workId, sessionId: owner.sessionId, binding: adapter.binding });
  const { schedule } = createWorkContinuationSchedule(controllerHome, repository.repoId, {
    workId,
    scheduleMode: 'continuation',
    controllerType: 'chatgpt',
    triggerType: 'manual',
    shadowMode: false,
  });
  const relayScopeId = `requirement:${requirementId}`;
  beginInitialControllerRoundDispatch(store, {
    workId,
    requirementId,
    relayScopeId,
    bindingId: adapter.binding.bindingId,
    identity: {
      controllerId: owner.controllerId,
      controllerType: owner.controllerType,
      principalId: owner.principalId!,
      controllerInstanceId: owner.controllerInstanceId!,
      sessionId: owner.sessionId,
    },
  });
  finishControllerRoundRelayDispatch(store, {
    workId,
    ok: true,
    bindingId: adapter.binding.bindingId,
    providerDispatchReceiptId: 'stage3c-canary-initial-dispatch',
  });
  const claimed = acknowledgeControllerRoundClaim(store, { workId, session: owner });
  if (claimed?.status !== 'claimed') throw new Error(`CANARY_CLAIM_FAILED:${claimed?.status ?? 'missing'}`);
  const waiting = submitControllerRoundDisposition(store, {
    workId,
    relayScopeId,
    identity: {
      controllerId: owner.controllerId,
      controllerType: owner.controllerType,
      principalId: owner.principalId!,
      controllerInstanceId: owner.controllerInstanceId!,
      sessionId: owner.sessionId,
    },
    disposition: 'wait',
  });
  if (waiting.status !== 'waiting') throw new Error(`CANARY_WAIT_FAILED:${waiting.status}`);

  const baselineFingerprint = readControllerRoundSemanticStateFingerprint(store, workId);
  updateWorkContract(store, workId, {}); // updatedAt churn only
  const timestampChurnFingerprint = readControllerRoundSemanticStateFingerprint(store, workId);
  if (!baselineFingerprint || timestampChurnFingerprint !== baselineFingerprint) {
    throw new Error('CANARY_TIMESTAMP_CHURN_CHANGED_SEMANTIC_FINGERPRINT');
  }

  let providerCalls = 0;
  const providerCallCount = (): number => providerCalls;
  const host = {
    resume: async () => {
      providerCalls += 1;
      return { accepted: true, dispatchId: `stage3c-canary-provider-${providerCalls}` };
    },
  };
  const unchanged = await resumeScheduledControllerContinuation(store, {
    scheduleId: schedule.scheduleId,
    occurrenceId: 'stage3c-canary-unchanged',
    workId,
    controllerBindingId: adapter.binding.bindingId,
    relayScopeId,
  }, host);
  if (unchanged.dispatch.status !== 'semantic_wait' || providerCallCount() !== 0) {
    throw new Error(`CANARY_UNCHANGED_WAIT_DISPATCHED:${unchanged.dispatch.status}:calls=${providerCallCount()}`);
  }

  updateWorkContract(store, workId, { evidenceState: 'partial' });
  const changedFingerprint = readControllerRoundSemanticStateFingerprint(store, workId);
  if (!changedFingerprint || changedFingerprint === baselineFingerprint) throw new Error('CANARY_MEANINGFUL_CHANGE_NOT_DETECTED');
  const changed = await resumeScheduledControllerContinuation(store, {
    scheduleId: schedule.scheduleId,
    occurrenceId: 'stage3c-canary-changed',
    workId,
    controllerBindingId: adapter.binding.bindingId,
    relayScopeId,
  }, host);
  if (changed.dispatch.status !== 'dispatched' || providerCallCount() !== 1) {
    throw new Error(`CANARY_CHANGED_STATE_DISPATCH_COUNT:${changed.dispatch.status}:calls=${providerCallCount()}`);
  }
  const finalRelay = getControllerRoundRelay(store, workId);
  if (finalRelay?.providerDispatchReceiptId !== 'stage3c-canary-provider-1') {
    throw new Error('CANARY_PROVIDER_RECEIPT_MISSING');
  }

  console.log(JSON.stringify({
    schemaVersion: 1,
    canary: 'forge-v2-stage3c-semantic-wait',
    status: 'passed',
    requirementId,
    workId,
    relayScopeId,
    baselineFingerprint,
    timestampChurnFingerprint,
    changedFingerprint,
    unchangedDispatchStatus: unchanged.dispatch.status,
    changedDispatchStatus: changed.dispatch.status,
    providerCalls: providerCallCount(),
    providerDispatchReceiptId: finalRelay.providerDispatchReceiptId,
  }, null, 2));
} finally {
  rmSync(root, { recursive: true, force: true });
}
