# Test governance prune

## Decision

The repository is a developing tool, so the test suite is a bounded safety net
rather than an ever-growing specification archive. The retained suite is 74
files and approximately 33k lines. Historical, duplicate, source-text, and
combinatorial migration tests were removed; process ownership, worktree
fencing, Controller lifecycle, workflow state, and package smoke coverage were
retained.

## Guardrails

- `tests/test-manifest.v1.json` enforces a maximum of 80 files and 40,000 lines.
- Resource budgets prevent process-tree, worktree, port, and singleton lanes
  from expanding without an explicit replacement decision.
- New behavior should extend an existing test file before adding a file.
- `check:task` validates the budget and runs only typecheck, architecture, and
  affected tests. Integration and full suites are explicit diagnostics.

## Scope note

The concurrent T8 issue changes remain user-owned and are not part of this
governance change.
