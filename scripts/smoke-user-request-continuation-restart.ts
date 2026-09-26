#!/usr/bin/env bun
import { strict as assert } from 'node:assert';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureControllerHome } from '../src/cli/repositories/controller-home';
import { registerRepository } from '../src/cli/repositories/registry';
import {
  beginControllerRoundProviderDispatch,
  beginInitialControllerRoundDispatch,
  finishControllerRoundRelayDispatch,
  getControllerRoundRelay,
} from '../packages/kernel/controller/api/index';
import { claimControllerSession, releaseControllerSession } from '../src/runtime/control-plane/facade/controller-session-store';
import { createWorkContract } from '../src/runtime/control-plane/facade/work-contract-store';
import { createHandoffItem } from '../src/runtime/control-plane/facade/handoff-inbox-store';
import { listUserRequests } from '../packages/kernel/identity/api/index';
import {
  createWorkContinuationSchedule,
  handoffResolvedContinuationEventName,
  resolveHandoffAndTriggerContinuation,
} from '../src/runtime/workflow/schedules/work-continuation';
import { listOccurrences } from '../src/runtime/workflow/schedules/store';

const WORK_ID = 'WORK-USER-REQUEST-PROCESS-RESTART';
const HANDOFF_ID = 'HND-USER-REQUEST-PROCESS-RESTART';
const ORIGINAL_OCCURRENCE_ID = 'occ-user-request-original-lineage';
const META = 'user-request-continuation-meta.json';

interface Meta {
  repoId: string;
  scheduleId: string;
  authorityId: string;
  firstOccurrenceId?: string;
}

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function metaPath(root: string): string {
  return join(root, META);
}

function readMeta(root: string): Meta {
  return JSON.parse(readFileSync(metaPath(root), 'utf8')) as Meta;
}

function writeMeta(root: string, meta: Meta): void {
  writeFileSync(metaPath(root), JSON.stringify(meta, null, 2), 'utf8');
}

function initRepository(root: string): string {
  const repoRoot = join(root, 'repo');
  mkdirSync(repoRoot, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
  execFileSync('git', ['config', 'user.email', 'user-request-smoke@example.test'], { cwd: repoRoot });
  execFileSync('git', ['config', 'user.name', 'UserRequest Smoke'], { cwd: repoRoot });
  writeFileSync(join(repoRoot, 'README.md'), 'user request continuation smoke\n');
  execFileSync('git', ['add', '.'], { cwd: repoRoot });
  execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: repoRoot });
  return repoRoot;
}

async function runPhase(root: string, phase: string): Promise<void> {
  const controllerHome = ensureControllerHome(join(root, 'controller'));

  if (phase === 'setup') {
    const repoRoot = initRepository(root);
    const repository = registerRepository({ path: repoRoot, controllerHome, displayName: 'user-request-continuation-smoke' });
    const store = { controllerHome, repoId: repository.repoId };
    createWorkContract(store, {
      workId: WORK_ID,
      repoId: repository.repoId,
      checkoutId: repository.activeCheckoutId,
      objective: 'Resume the exact continuation lineage after one genuine UserRequest is resolved.',
      acceptanceCriteria: ['One resolution rearms the same occurrence and replay creates no second occurrence.'],
      allowedPaths: [],
      forbiddenPaths: [],
      checks: [],
      constraints: { workspaceMode: 'current', requireWorktree: false, requireHandoffOnAmbiguity: true },
      requestedBy: 'chatgpt',
      status: 'running',
    });
    const owner = claimControllerSession(store, {
      workId: WORK_ID,
      controllerId: 'user-request-smoke-controller',
      controllerType: 'chatgpt',
      sessionId: 'user-request-smoke-session',
      principalId: 'user-request-smoke-controller',
      controllerInstanceId: 'runtime-before-user-resolution',
      leaseMs: 60_000,
    });
    const relay = beginInitialControllerRoundDispatch(store, {
      workId: WORK_ID,
      occurrenceId: ORIGINAL_OCCURRENCE_ID,
      identity: {
        controllerId: owner.controllerId,
        controllerType: owner.controllerType,
        principalId: owner.principalId!,
        controllerInstanceId: owner.controllerInstanceId!,
        sessionId: owner.sessionId,
      },
    });
    const started = beginControllerRoundProviderDispatch(store, {
      workId: WORK_ID,
      authorityId: relay.authorityId!,
      expectedUpdatedAt: relay.updatedAt,
    });
    const eventName = handoffResolvedContinuationEventName(HANDOFF_ID);
    const schedule = createWorkContinuationSchedule(controllerHome, repository.repoId, {
      workId: WORK_ID,
      controllerType: 'chatgpt',
      triggerType: 'repository-event',
      eventName,
      shadowMode: true,
      cooldownMinutes: 0,
    }).schedule;
    createHandoffItem(store, {
      id: HANDOFF_ID,
      repoId: repository.repoId,
      workId: WORK_ID,
      title: 'Resolve one genuine user blocker',
      severity: 'needs_review',
      creationReason: 'missing_authorization',
      reason: 'The provider requires a user-owned authorization step.',
      summary: 'Resume the exact continuation after the user action.',
      currentState: { repoId: repository.repoId, workId: WORK_ID, statusSummary: 'waiting for user authorization' },
      attemptedActions: [],
      evidenceRefs: [],
      recommendedDecision: 'Resolve the authorization blocker.',
      recommendedPrompt: 'Resolve the blocker and resume the exact continuation.',
      suggestedNextActions: [],
    });
    finishControllerRoundRelayDispatch(store, {
      workId: WORK_ID,
      ok: false,
      waitForUser: true,
      handoffId: HANDOFF_ID,
      providerDispatchEffectId: started.providerDispatchEffectId,
      error: 'CHATGPT_AUTOMATION_LOGIN_REQUIRED',
    });
    releaseControllerSession(store, WORK_ID, owner.controllerId);
    const waiting = getControllerRoundRelay(store, WORK_ID);
    assert.equal(waiting?.status, 'waiting_for_user');
    assert.equal(waiting?.occurrenceId, ORIGINAL_OCCURRENCE_ID);
    assert.equal(waiting?.authorityId, relay.authorityId);
    const requests = listUserRequests(controllerHome, 'pending');
    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.presentation?.legacyHandoffId, HANDOFF_ID);
    writeMeta(root, { repoId: repository.repoId, scheduleId: schedule.scheduleId, authorityId: relay.authorityId! });
    return;
  }

  const meta = readMeta(root);
  const store = { controllerHome, repoId: meta.repoId };

  if (phase === 'resolve') {
    const resolved = await resolveHandoffAndTriggerContinuation(controllerHome, meta.repoId, HANDOFF_ID, {
      decision: 'authorization completed',
      resolver: 'user-request-smoke-user',
    });
    assert.equal(resolved.item.status, 'resolved');
    assert.equal(resolved.continuationOccurrences.length, 1);
    assert.equal(resolved.continuationOccurrences[0]?.scheduleId, meta.scheduleId);
    const relay = getControllerRoundRelay(store, WORK_ID);
    assert.equal(relay?.status, 'dispatching');
    assert.equal(relay?.occurrenceId, ORIGINAL_OCCURRENCE_ID);
    assert.equal(relay?.authorityId, meta.authorityId);
    const occurrences = listOccurrences(controllerHome, meta.repoId, meta.scheduleId);
    assert.equal(occurrences.length, 1);
    assert.equal(occurrences[0]?.triggerContext?.data?.controllerRoundOccurrenceId, ORIGINAL_OCCURRENCE_ID);
    const requests = listUserRequests(controllerHome, 'resolved');
    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.resolution?.decision, 'authorization completed');
    writeMeta(root, { ...meta, firstOccurrenceId: occurrences[0]!.occurrenceId });
    return;
  }

  if (phase === 'replay') {
    assert.ok(meta.firstOccurrenceId);
    const replay = await resolveHandoffAndTriggerContinuation(controllerHome, meta.repoId, HANDOFF_ID, {
      decision: 'authorization completed',
      resolver: 'user-request-smoke-user',
    });
    assert.equal(replay.item.status, 'resolved');
    const relay = getControllerRoundRelay(store, WORK_ID);
    assert.equal(relay?.status, 'dispatching');
    assert.equal(relay?.occurrenceId, ORIGINAL_OCCURRENCE_ID);
    assert.equal(relay?.authorityId, meta.authorityId);
    const occurrences = listOccurrences(controllerHome, meta.repoId, meta.scheduleId);
    assert.equal(occurrences.length, 1);
    assert.equal(occurrences[0]?.occurrenceId, meta.firstOccurrenceId);
    assert.equal(listUserRequests(controllerHome, 'resolved').length, 1);
    return;
  }

  throw new Error(`UNKNOWN_PHASE:${phase}`);
}

async function main(): Promise<void> {
  const phase = arg('--phase');
  const rootArg = arg('--root');
  if (phase) {
    if (!rootArg) throw new Error('--root is required with --phase');
    await runPhase(rootArg, phase);
    return;
  }
  const root = mkdtempSync(join(tmpdir(), 'forge-user-request-continuation-restart-'));
  const script = fileURLToPath(import.meta.url);
  try {
    for (const nextPhase of ['setup', 'resolve', 'replay']) {
      const child = spawnSync(process.execPath, [script, '--phase', nextPhase, '--root', root], {
        cwd: process.cwd(),
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      assert.equal(child.status, 0, `phase ${nextPhase} failed\nstdout:\n${child.stdout ?? ''}\nstderr:\n${child.stderr ?? ''}`);
    }
    console.log('[user-request-continuation-process-restart-smoke] OK');
  } finally {
    if (existsSync(root)) rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
