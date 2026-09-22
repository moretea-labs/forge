# Runtime maintenance diagnosis uses bounded read-side inventory

Status: Accepted and implemented on 2026-09-07.

## Problem

Runtime maintenance diagnosis had three multiplicative costs on repositories with long-lived Controller history:

- stale EditSession discovery called `reconcileEditSession` for every open-like candidate, which hashes tracked after-images, runs Git dirty-path inspection, and may persist reconciliation metadata;
- every stale Work/EditSession independently reloaded active Plans, Schedules, Controller ownership and up to 500 Process history records;
- stale Work repository source inspection ran before the visible `maxCandidates` bound, so expensive Git status/revision/containment checks could exceed the advertised candidate budget.

On the real Forge Controller Home with 637 WorkContracts and 388 EditSessions, the observed maintenance diagnosis path took roughly 25–35 seconds.

## Decision

Maintenance status discovery is inventory, not repair:

1. Resolve the existing repository runtime-storage binding first, then build one bounded authority snapshot for the status pass.
2. Reuse Work, live Controller session, active Plan, Requirement, Schedule and Process ownership facts across all candidates in that pass.
3. Read active Process authority from Process Runtime's recoverable index instead of enumerating terminal Process history.
4. EditSession discovery reads summary/ownership metadata only. Workspace hashing, Git dirty checks, supersession and finalization occur only in explicit maintenance for a selected candidate.
5. Sort and bound stale Work candidates before repository source Git inspection.
6. Destructive stale-Work maintenance re-reads current authority at its mutation boundary; the status snapshot never becomes mutation authority.

The snapshot is a derived in-memory view for one diagnosis call. It is not persisted and is not a second lifecycle authority.

## Verification

After implementation on the same real Controller data set:

- `buildRuntimeMaintenanceStatus`: 563.8 ms for 200 returned candidates;
- legacy `listProcessRecords(..., 500)`: 729.82 ms for 500 historical records;
- `listRecoverableProcessRecords`: 2.82 ms for the active/recoverable index in the same repository;
- targeted maintenance semantic regressions: 5 passed, 0 failed;
- Direct Edit / EditSession continuity consumers: 28 passed, 0 failed;
- `package:check:type`: passed.

The 25–35 second diagnosis regression is therefore removed without lowering lifecycle gates or hiding candidates.
