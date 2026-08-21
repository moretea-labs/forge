import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { registerRepository } from '../src/cli/repositories/registry';
import { listHandoffItems } from '../src/runtime/control-plane/facade/handoff-inbox-store';
import { listExecutionJobs } from '../src/runtime/execution/jobs/store';
import { evaluateSchedule } from '../src/runtime/workflow/schedules/engine';
import { createSchedule, getSchedule, getScheduleDecision } from '../src/runtime/workflow/schedules/store';

const root = mkdtempSync(join(tmpdir(), 'forge-schedule-smoke-'));
const repoRoot = join(root, 'repo');
const controllerHome = join(root, 'controller');
const localJobsRoot = join(repoRoot, '.ai/harness/local-jobs');

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function git(...args: string[]): void {
  execFileSync('git', ['-C', repoRoot, ...args], { stdio: 'ignore' });
}

function writeLocalJob(jobId: string, content: Record<string, unknown> | string): string {
  const jobRoot = join(localJobsRoot, jobId);
  mkdirSync(jobRoot, { recursive: true });
  const path = join(jobRoot, 'job.json');
  writeFileSync(path, typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`);
  return path;
}

try {
  mkdirSync(repoRoot, { recursive: true });
  git('init');
  git('config', 'user.email', 'schedule-smoke@example.invalid');
  git('config', 'user.name', 'Schedule Smoke');
  writeFileSync(join(repoRoot, 'README.md'), '# schedule smoke\n', 'utf8');
  git('add', 'README.md');
  git('commit', '-m', 'initial');
  const repository = registerRepository({ path: repoRoot, controllerHome, displayName: 'schedule-smoke' });

  const semanticBase = {
    repoId: repository.repoId,
    enabled: true,
    policy: {
      maxActiveOccurrences: 1,
      maxFailures: 3,
      cooldownMinutes: 0,
      dailyBudgetMinutes: 30,
      shadowMode: true,
      backoffBaseMinutes: 1,
      backoffMaxMinutes: 8,
    },
    action: { operation: 'controller_context', resourceClaims: [] },
    stopConditions: [] as string[],
  };

  const manual = createSchedule(controllerHome, {
    ...semanticBase,
    requestId: 'schedule-manual',
    name: 'manual',
    trigger: { type: 'manual' },
  });
  const manualOccurrence = await evaluateSchedule(
    controllerHome,
    manual,
    true,
    { source: 'manual', eventId: 'manual-1' },
  );
  assert(
    manualOccurrence?.status === 'skipped'
      && manualOccurrence.decision === 'operation_blocked'
      && manualOccurrence.decisionId
      && manualOccurrence.handoffId,
    'manual semantic Schedule did not create an external-controller handoff',
  );
  assert(
    getScheduleDecision(controllerHome, repository.repoId, manualOccurrence.decisionId)?.decision === 'operation_blocked',
    'manual Schedule Decision was not persisted',
  );

  const repositoryEvent = createSchedule(controllerHome, {
    ...semanticBase,
    requestId: 'schedule-event',
    name: 'event',
    trigger: { type: 'repository-event', eventName: 'git.push' },
  });
  const mismatched = await evaluateSchedule(
    controllerHome,
    repositoryEvent,
    true,
    { source: 'repository-event', eventName: 'git.pull', eventId: 'evt-0' },
  );
  assert(mismatched === undefined, 'mismatched repository event was accepted');
  const eventA = await evaluateSchedule(
    controllerHome,
    repositoryEvent,
    true,
    { source: 'repository-event', eventName: 'git.push', eventId: 'evt-1' },
  );
  const eventB = await evaluateSchedule(
    controllerHome,
    repositoryEvent,
    true,
    { source: 'repository-event', eventName: 'git.push', eventId: 'evt-1' },
  );
  assert(eventA?.occurrenceId === eventB?.occurrenceId, 'repository event was not idempotent');
  assert(eventA?.handoffId === eventB?.handoffId, 'repository event created duplicate handoffs');

  const missingDependency = createSchedule(controllerHome, {
    ...semanticBase,
    requestId: 'schedule-dependency-missing',
    name: 'dependency-missing',
    trigger: { type: 'dependency-checkpoint', dependencyJobIds: ['EJOB-historical-missing'] },
  });
  assert(
    await evaluateSchedule(controllerHome, missingDependency) === undefined,
    'missing historical dependency checkpoint fired',
  );

  const conditionSchedule = createSchedule(controllerHome, {
    ...semanticBase,
    requestId: 'schedule-condition',
    name: 'condition',
    trigger: {
      type: 'condition',
      everyMinutes: 1,
      condition: { kind: 'repository_clean' },
    },
  });
  const conditionOccurrence = await evaluateSchedule(controllerHome, conditionSchedule);
  assert(
    conditionOccurrence?.status === 'skipped'
      && conditionOccurrence.decision === 'operation_blocked'
      && conditionOccurrence.handoffId,
    'condition Schedule did not create an external-controller handoff',
  );

  const cron = createSchedule(controllerHome, {
    ...semanticBase,
    requestId: 'schedule-cron',
    name: 'cron',
    trigger: { type: 'cron', cronExpression: '* * * * *' },
  });
  const cronOccurrence = await evaluateSchedule(controllerHome, cron);
  assert(cronOccurrence?.decision === 'operation_blocked' && cronOccurrence.handoffId, 'cron Schedule did not hand off');

  const calendar = createSchedule(controllerHome, {
    ...semanticBase,
    requestId: 'schedule-calendar',
    name: 'calendar',
    trigger: { type: 'calendar', calendarAt: '2000-01-01T00:00:00.000Z' },
  });
  const calendarOccurrence = await evaluateSchedule(controllerHome, calendar);
  assert(
    calendarOccurrence?.decision === 'operation_blocked' && calendarOccurrence.handoffId,
    'calendar Schedule did not hand off',
  );

  const staleJobPath = writeLocalJob('JOB-stale', {
    schemaVersion: 1,
    jobId: 'JOB-stale',
    action: 'repository-command',
    status: 'running',
    createdAt: '2026-07-05T00:00:00.000Z',
    updatedAt: '2026-07-05T00:00:00.000Z',
    workerPid: 99999999,
  });
  const deterministicBase = {
    repoId: repository.repoId,
    enabled: true,
    trigger: { type: 'manual' as const },
    policy: {
      maxActiveOccurrences: 1,
      maxFailures: 3,
      cooldownMinutes: 0,
      dailyBudgetMinutes: 30,
      shadowMode: false,
      backoffBaseMinutes: 1,
      backoffMaxMinutes: 8,
    },
    action: {
      operation: 'runtime_maintenance_apply',
      arguments: {
        action_id: 'local_jobs_reconcile',
        confirm_maintenance: true,
        authorization: 'local_jobs_reconcile',
        min_age_minutes: 0,
        cancel_pending_approvals: false,
      },
      resourceClaims: [{ resourceKey: 'runtime-maintenance', mode: 'write' as const }],
    },
    stopConditions: [] as string[],
  };
  const maintenance = createSchedule(controllerHome, {
    ...deterministicBase,
    requestId: 'schedule-maintenance',
    name: 'maintenance',
  });
  const maintenanceOccurrence = await evaluateSchedule(
    controllerHome,
    maintenance,
    true,
    { source: 'manual', eventId: 'maintenance-1' },
  );
  assert(
    maintenanceOccurrence?.status === 'succeeded'
      && maintenanceOccurrence.decision === 'execute'
      && !maintenanceOccurrence.jobId,
    'deterministic maintenance did not execute inline',
  );
  const staleJob = JSON.parse(readFileSync(staleJobPath, 'utf8')) as { status?: string };
  assert(
    ['orphaned', 'failed', 'cancelled'].includes(staleJob.status ?? ''),
    'deterministic maintenance did not reconcile the stale Local Job',
  );

  const brokenJobPath = writeLocalJob('JOB-broken', '{not-json\n');
  const brokenBefore = readFileSync(brokenJobPath, 'utf8');
  const blockedMaintenance = createSchedule(controllerHome, {
    ...deterministicBase,
    requestId: 'schedule-maintenance-blocked',
    name: 'maintenance-blocked',
  });
  const blockedOccurrence = await evaluateSchedule(
    controllerHome,
    blockedMaintenance,
    true,
    { source: 'manual', eventId: 'maintenance-blocked-1' },
  );
  assert(
    blockedOccurrence?.status === 'skipped'
      && blockedOccurrence.decision === 'maintenance_not_ready'
      && blockedOccurrence.handoffId
      && !blockedOccurrence.jobId,
    'unsafe maintenance candidate did not create a bounded handoff',
  );
  assert(readFileSync(brokenJobPath, 'utf8') === brokenBefore, 'blocked maintenance modified an unreadable candidate');
  const backedOff = getSchedule(controllerHome, repository.repoId, blockedMaintenance.scheduleId);
  assert(
    backedOff.consecutiveFailures === 1 && backedOff.nextEligibleAt,
    'deterministic maintenance backoff was not persisted',
  );

  const handoffs = listHandoffItems({ controllerHome, repoId: repository.repoId, status: 'all' });
  assert(handoffs.length >= 6, 'expected external-controller and maintenance handoffs were not persisted');
  assert(listExecutionJobs(controllerHome, repository.repoId, 100).length === 0, 'Schedule smoke created an ExecutionJob');

  console.log(JSON.stringify({
    status: 'ok',
    manualHandoff: manualOccurrence.handoffId,
    repositoryEventIdempotent: eventA?.occurrenceId === eventB?.occurrenceId,
    missingDependencySuppressed: true,
    conditionHandoff: conditionOccurrence.handoffId,
    cronHandoff: cronOccurrence.handoffId,
    calendarHandoff: calendarOccurrence.handoffId,
    maintenance: maintenanceOccurrence.status,
    maintenanceBackoffUntil: backedOff.nextEligibleAt,
    handoffCount: handoffs.length,
    executionJobCount: 0,
  }, null, 2));
} finally {
  rmSync(root, { recursive: true, force: true });
}
