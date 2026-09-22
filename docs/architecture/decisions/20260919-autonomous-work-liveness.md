# Autonomous Work liveness invariant

Date: 2026-09-19
Status: accepted

## Problem

Forge could retain a non-terminal Work indefinitely after its execution carrier and
Controller ownership disappeared. A current Plan protected that Work from stale
authority retirement, but nothing materialized the already-existing semantic
decision that the Work was ready to continue. The visible result was an unfinished
conversation/task with no process, no live Controller owner and no next round.

## Decision

Global Scheduler's normal reconciliation cadence owns materialization, not semantic
planning.

For every active runnable Work with no active execution and no live Controller
owner:

1. If the Work is Plan-bound, projectAutonomousGoalProgression() is the sole
   authority deciding whether the current Work is WORK_READY_TO_CONTINUE.
2. If the Work is not Plan-bound, reconciliation may perform only the lower-level
   mechanical liveness wake when Work/Requirement/ControllerRound state contains
   no terminal or explicit wait authority. It never invents Plan authority.
3. Existing retained ControllerSession identity and ControllerBinding are reused.
   A retained session is identity evidence, not a live ownership lease.
4. ControllerRound remains the sole provider-effect fence. The progression
   idempotency key, or a deterministic planless Work occurrence key, becomes the
   occurrence identity, so repeated scheduler ticks converge rather than replay.
5. If Workflow Supervisor owns the outer ChatGPT turn, Scheduler only ensures the
   idempotent Supervisor enrollment effect. It must not dispatch a competing
   provider prompt.
6. Existing semantic wait, wait_for_user, blocked/failed round state, live
   execution, live Controller ownership and terminal Work/Requirement state all
   suppress automatic continuation.

No new lifecycle state, watchdog table, polling daemon, retry authority or
Process-specific continuation path is introduced.

## Baseline boundary

Liveness reconciliation does not re-check the repository integration baseline in
the middle of an already-running isolated Work. For Plan-bound Work it evaluates
Goal Progression against the Plan's frozen source revision. Baseline drift remains
an admission/replan boundary after the independent Work reaches its semantic
boundary; it is not a reason to repeatedly interrupt execution.

## Recovery boundary

The existing periodic stalled-ControllerRound recovery remains responsible for
already-open rounds whose provider dispatch or closure was abandoned. The new
normal reconciliation path handles the previously invisible case where no round
exists at all.

## Acceptance

A runnable ownerless Work converges to exactly one existing Controller continuation
authority within the normal Scheduler reconciliation cadence. Repeated ticks and
runtime re-entry cannot duplicate provider dispatch, and explicit waits remain
stable.
