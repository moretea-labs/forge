# Work Lifecycle

## 1. Inspect

Resolve the repository and checkout, read current status, and check whether an Issue, Task, Work, Job, or Run already owns the objective. Avoid duplicate work.

## 2. Plan the smallest safe unit

Use direct edits for bounded changes. Use durable Tasks, isolated worktrees, or campaigns when work is long-running, parallel, dependency-aware, or high risk.

## 3. Execute with ownership

A writer must own the relevant repository or runtime resource. Claims, leases, and fencing prevent two actors from silently mutating the same state.

## 4. Review the actual change

Inspect the localized diff, separate unrelated modifications, and preserve changes whose ownership is not yet known. Never clean a workspace merely to make a check pass.

## 5. Validate

Run focused checks first, then the declared package or release gate. Managed processes may return a durable handle before completion; retrieve the same operation instead of starting a duplicate.

## 6. Integrate

Commit explicit paths, merge through the intended strategy, and record the integrated revision. A validation result from a feature branch is not automatically evidence for a different main revision.

## 7. Finalize and clean

Update task evidence, delete merged branches and temporary worktrees, and verify the target branch is clean. Blocked or failed states remain recoverable; they are not treated as immutable terminal truth.

For detailed lifecycle contracts, see [Job and Run Lifecycle](https://github.com/moretea-labs/forge/blob/main/docs/architecture/current/job-and-run-lifecycle.md).
