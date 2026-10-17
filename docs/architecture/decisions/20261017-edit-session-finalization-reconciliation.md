# Edit-session finalization after integrated commits

**Tracking issue:** [#235](https://github.com/moretea-labs/forge/issues/235)

## Problem

An edit session captures a Git baseline and workspace fingerprint when its edits are applied. After the same tracked after-images are committed, Git HEAD and the workspace fingerprint naturally change. The public finalization path previously rejected this drift before consulting the existing edit-session reconciliation logic, leaving already-integrated changes without a terminal session/receipt.

## Canonical rule

When the baseline or workspace fingerprint has changed, `finalizeEditSession` first invokes the existing `reconcileEditSession` path. Reconciliation may finalize only when all tracked files still match their exact recorded after-images, no tracked session path has uncommitted changes, and configured checks have passed. If the session remains dirty, the original stale-baseline/fingerprint error is preserved. Content drift follows the existing reconciliation behavior and supersedes the session rather than overwriting or rebasing its evidence.

The approval requirement is checked before reconciliation. This does not adopt a new Git baseline, relax ownership checks, bypass validation, or create a completion receipt directly; the canonical finalization and receipt owners remain authoritative.

## Regression coverage

`tests/runtime/edit-session-continuity.test.ts` covers both successful finalization after the edited path is committed and rejection while that path remains uncommitted. The focused suite, runtime architecture check, and TypeScript checks passed on the tested revision.
