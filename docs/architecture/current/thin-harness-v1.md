# Thin Harness V1

> Status: **Runtime Authority (additive)**  
> Baseline revision: feature branch `grok/thin-harness-v1`  
> Review remediation: round-3 P0.1a/b — ephemeral lease, no write-time repo lock, ownership abort, expanded claim overlap

## Purpose

Reduce fixed middleware latency for everyday repository operations without weakening safety boundaries.

Core principle:

```text
Default to direct Fast Path execution.
Escalate to Durable Work only when recovery, background, isolation,
concurrent writes, or high-risk control is required.
Use durable Goal Workloop plus PlanContract/Work only when multiple independent, long-lived deliverables need resumable coordination.
```

## Current Implementation

### Components

| Component | Path | Responsibility |
| --- | --- | --- |
| Execution Router | `src/runtime/execution/thin-harness/execution-router.ts` | Decide `fast` / `durable` / `reject` |
| Latency Trace | `src/runtime/execution/thin-harness/latency-trace.ts` | Mutually exclusive Fast Path segments |
| Async Process | `src/runtime/execution/thin-harness/async-process.ts` | Bounded async spawn + process-tree kill + AbortSignal |
| Mutation Ownership | `src/runtime/execution/thin-harness/mutation-gate.ts` | Fast/Durable shared ownership via Execution Lease arbiter (`workspace:<checkoutId>`) |
| Request Ledger | `src/runtime/execution/thin-harness/request-ledger.ts` | Atomic create-if-absent idempotency before mutation |
| Fast Executor | `src/runtime/execution/thin-harness/fast-executor.ts` | Async Fast Path execution |
| Fast Receipt | `src/runtime/execution/thin-harness/fast-receipt.ts` | Bounded receipt; failures do not mask mutation success |
| Batch Executor | `src/runtime/execution/thin-harness/batch-executor.ts` | Typed multi-step batch (≤20); one parent receipt; whole-batch write ownership |
| Lightweight Lanes | `src/runtime/execution/thin-harness/lightweight-lanes.ts` | Read lanes (strict readonly effects) + patch_proposal_validate |
| MCP integration | `src/cli/mcp/repository-tools.ts` | Fast path for eligible `repository_command_execute`; optional batch/lanes tools |
| Command executor | `src/cli/repositories/command-executor.ts` | `repositorySnapshotAsync`, bounded non-persistent readonly execution, AbortSignal, process-group kill on async path |

### Execution modes

```ts
interface ExecutionDecision {
  mode: "fast" | "durable" | "reject";
  reasons: string[];
  risk: string;
  estimatedClass: "short" | "long" | "unknown";
  requiresIsolation: boolean;
  requiresRecovery: boolean;
  suggestedOperation?: string;
}
```

### Deterministic task tiers

The sole Route Policy exposes three task-shape tiers. These are routing labels over existing execution primitives, not separate engines:

1. **Direct** — `direct_edit` + `direct_control` + `fast`. Use for small, scope-clear, low-risk work. Readonly work creates no Work; small mutations may retain lightweight Work lineage without Issue, Plan, or isolated worktree by default.
2. **Bounded Work** — `bounded_work` + `goal_workloop` + `durable`. Use for one-owner work that needs investigation, recovery, isolation, protected-path handling, or broader bounded scope. It uses the existing WorkContract / `rh_work` lifecycle and does **not** require an Issue or Plan.
3. **Coordinated durable Work** — `bounded_work` + `goal_workloop` + `durable`. Use when multiple independent deliverables need resumable coordination; decompose them with PlanContract/Work instead of a separate project-level lifecycle.

`quick_agent` and `issue_task` remain executor/delegation-oriented modes when an Agent is explicitly requested. Provider choice never promotes a small task into a heavier lifecycle by itself. An explicit approved Plan may bind dependent Work steps, but Plan is optional for ordinary Bounded Work.

### Fast Path eligibility (default)

- repository file read (size-capped)
- bounded search (async `rg` preferred; inspector fallback after yield)
- Git status / bounded Git diff (async spawn)
- small path-scoped patch (pre-apply path validation + rollback)
- path-scoped stage / commit under Checkout Mutation Gate
- allowlisted typed argv **readonly** commands
- **strict** focused checks only (typed argv + explicit file/filter; bare `bun test` / `npm test` / `pytest` → durable)
- continuous local edits on one checkout

### Repository-free Target execution

An authorized `local_system` Target Grant is a first-class bounded workspace target and does **not** require Repository Registry enrollment. It uses the existing `controllerHome/system/local-system/targets.json` authority and carries a stable `workspaceId`, owner scope, access mode, canonical root, and identity fingerprint.

- file reads/writes remain symlink-safe and root-bounded;
- `execute_command` accepts typed argv only, reuses the repository command classifier/scope policy and bounded process runner, and caps execution at 30 seconds;
- readonly Target commands create no WorkContract;
- Target mutations create one lightweight `direct_control` WorkContract and terminalize it in the same request with a `local_effect` completion receipt;
- physical Target mutations are serialized by canonical filesystem root through existing Controller global resource locks; different roots remain concurrent, and multi-target copy/move acquires roots in deterministic order to avoid deadlock;
- lock identity is the canonical root, not `targetKey`, owner, or `workspaceId`, so two grants pointing at the same physical directory cannot bypass write serialization;
- readonly Target file/command actions remain outside the mutation lock path;
- remote/destructive commands are rejected on Target execution;
- `workspace_write` commands are fail-closed unless they are replay-safe local validation or part of the narrow path-governed filesystem mutation allowlist; unknown/system side effects require Repository promotion;
- Git mutations are rejected until the target is promoted to a registered Repository/Checkout, because Git refs and worktree ownership require repository-scoped fencing;
- long-running, recoverable, release, multi-checkout, or cross-session cache-heavy workflows should promote the target to a registered Repository instead of extending Target execution into a second scheduler/work model.

This preserves repository-free local operation without inventing a fake RepositoryRecord, WorkspaceJob, or parallel route policy.

### Check semantic single-flight and evidence reuse

`run_check` distinguishes **consumer identity** from **physical execution identity**. `requestId`, Session, Work, EditSession, and checkout coordinates remain consumer/audit bindings; they no longer define whether the same Check must run twice.

The authoritative semantic Check identity reuses the existing Controller Check cache vocabulary and binds:

- repository content revision (including dirty/untracked workspace content, excluding harness runtime artifacts);
- immutable Check definition digest (`command`, `cwd`, declared effects, configured timeout/source);
- bounded requested timeout contract;
- non-secret child execution environment/toolchain fingerprint;
- an explicit Check execution identity schema version.

Process Runtime keeps one repo-scoped semantic binding from that identity to the existing persisted Process record. A matching active execution is single-flighted across request/session consumers. A matching successful terminal Process may be reused as completed evidence; failed, timed-out, cancelled, missing-stale, or identity-mismatched Processes are never treated as successful cache hits.

Terminal Process lease cleanup remains a single retryable phase on the Process record. A failed exact-set, scope, or fencing check leaves `leaseReleaseState=pending` and records one redacted structured `leaseReleaseFailure` (code, message, attempt time, and count). Startup recovery retries the same canonical cleanup owner; success clears the diagnostic and moves the existing phase to `released`. The diagnostic does not authorize release, weaken fencing, or create another recovery state machine.

Cross-checkout/worktree reuse is deliberately narrower than same-checkout reuse. It is allowed only when the consumer checkout is clean, the Check declares bounded effects with no workspace writes/network/shared temp, and its toolchain is explicitly fingerprintable. Otherwise the identity is checkout-scoped and a different checkout must execute independently. Dirty workspaces therefore never borrow evidence from another checkout merely because their Git HEAD matches.

Verification receipts preserve the physical `processId` and source checkout while rebinding Session/Work/EditSession/request fields to the current consumer only after recomputing and exactly matching the current semantic Check identity. This prevents the first caller's identity from being attributed to later consumers.

Successful semantic Check Process evidence is retained beyond the ordinary age cutoff so completed reuse survives across sessions, but it remains subject to the existing per-repository terminal Process budget. This is an index over the existing Process/check evidence authority, **not** a second Check cache, scheduler, Job store, or execution engine.

### Must use Durable Path

- background / cross-session recovery
- unfocused or full test suites
- timeouts above Fast Path cap (**15s**)
- remote writes (`git push`, PR merge/delete, publish)
- deploy / release / supervisor switch
- destructive operations
- worker isolation / worktree / durable retry
- Agent Run
- untrusted / unclassified / shell commands
- device / browser long interaction sessions
- human handoff flows
- checkout mutation busy (durable writer or competing fast writer)

### Must reject (or strong confirmation path)

- out-of-scope repository writes
- secret reads
- shell injection / policy bypass
- implicit remote writes
- unsupported system-level mutation

## What Fast Path does **not** create

For short **typed-argv** readonly repository commands, the bounded direct reader additionally creates **no Process record, execution Lease, or Controller audit write**. It performs full repository identity/scope validation and before/after read-only Git observation, but never needs Runtime writer authority. Shell-form reads, mutating commands, and managed/long checks continue to use Process Runtime + Lease fencing.

- ExecutionJob
- Local Job
- Scheduler record
- Worker process
- Issue Task
- Project Board records
- full projection rebuild per step
- per-step Evidence files

## What Fast Path retains

- repository binding + checkout identity
- path validation + command policy
- permission snapshot / authorization for mutating commands
- typed argv, timeout, **AbortSignal** cancellation, output caps (streamed, not unbounded buffer), secret redaction
- before/after Git snapshot for commands
- **Checkout Mutation Gate** shared with durable write leases (plus controller lock for serialization)
- one final Fast Receipt (`receiptMode: standalone`); batch/lanes use parent receipt only (`receiptMode: none` on children)
- optional `requestId` + `inputHash` idempotent replay for mutations

## Async execution model (P0)

```text
Gateway
  ↓
Fast Router
  ↓
async Fast Executor
  ↓
bounded child process (process group) / yielded search
```

- `repository_command_execute` Fast Path uses `executeRepositoryCommandAsync`.
- Git status/diff/stage use `runBoundedGit` (async spawn).
- Timeout/cancel: SIGTERM process group → grace → SIGKILL via `terminateProcessTree`.
- stdout/stderr collectors cap while streaming.

## Process output confidentiality

Process Runtime applies one shared bounded redaction policy before stdout/stderr
is written to durable log files. The same policy is applied defensively to
Process records, MCP responses, large `resultRef` payloads, searches, and error
messages. Command descriptors are mode `0600` and are removed by the independent
Runner immediately after parsing and child spawn.

Terminal historical logs and result payloads are sanitized in place on bounded
read/recovery/maintenance paths. Maintenance reports contain counts and entity
ids only, never the removed contents. Redaction or artifact replacement is not
credential revocation: when a real credential may have appeared in any output,
the credential owner must rotate it at the provider and review downstream use.

## Checkout Mutation Ownership (round-3)

Fast and Durable share the **same** Execution Lease arbiter:

```text
resourceKey = workspace:<checkoutId>
mode = write
visibility = ephemeral (Fast) | durable (Jobs)
ownerJobId = fast:<session>:<op>:<requestId> | JOB-<durable>
fencingToken = per-resource monotonic counter (lease store)
```

Lock model (critical):

```text
repository controller lock  →  ONLY acquire / renew / release lease metadata
mutation lease              →  covers the full real write lifecycle
```

- Fast uses `visibility: ephemeral` — active lease set + fencing only; **no** Runtime Event, **no** Projection dirty, **no** Scheduler wake.
- Durable path remains default (events + projection + wake).
- `workspace:<checkoutId>` overlaps `path:` (same/unscoped checkout), `git-index:<checkoutId>`, `git-head:<checkoutId>`, and `git-ref*` claims.
- Snapshot is taken **after** lease acquire (never before).
- Heartbeat renew every TTL/3; renew failure aborts a dedicated ownership `AbortSignal` (combined with caller signal) and fails closed.
- Write path does **not** hold repository controller lock during `runBody` (so renew cannot `LOCK_HELD`).
- Batch passes real `externalGate` + `externalHelpers` (assert/renew/signal) into each step.
- Request Ledger: O_EXCL begin, CAS complete (never throws over mutation success), stale `in_progress` → `unknown` (reconcile).

## Batch API (typed)

```ts
interface RepositoryBatchRequest {
  repoId: string;
  checkoutId?: string;
  mode?: "auto" | "fast" | "durable";
  steps: RepositoryBatchStep[]; // max 20
  stopOnError?: boolean; // default true
  requestId?: string;
  signal?: AbortSignal;
}
```

Allowed step kinds:

```text
read_file | search | git_status | git_diff | apply_patch
run_short_command | run_focused_check | stage_paths | commit_paths
```

Rules:

- one repository binding and one pre-execution route decision for the whole batch
- never silently upgrade mid-batch; durable steps fail closed before any step runs
- one primary Fast Receipt for the batch (no per-step receipts)
- write batches: single mutation gate for all mutating steps
- commit-containing batches are marked `nonAtomic=true` (no pseudo-transaction rollback)
- large payloads may use existing result references

## Lightweight Lanes

### Read-only Analysis Lane

- max concurrency 4
- shared checkout, no branch / worktree / Issue
- parent receipt only; child lanes use `receiptMode: none`
- real overlap via async primitives; `concurrent` flag reports start/finish overlap
- fail-fast optional (default continue)

### Patch Proposal Validate (not Agent analysis)

- validates caller-supplied proposals for path conflicts only
- returns `proposalId`, `baseRevision`, digests, writePaths
- never writes the main checkout
- Integrator rechecks revision, conflicts, writePaths subset, digests before apply

## Durable coordination boundary

- Fast Path never depends on a project-level orchestration lifecycle.
- Independent deliverables use Goal Workloop plus PlanContract/Work only when durable coordination is needed.
- ordinary Direct Edit must not auto-upgrade merely because parallel analysis is possible.

## Latency measurement

Fast Path local segments (mutually exclusive; not full Gateway fiction):

```text
routingMs policyMs snapshotMs executionMs receiptMs totalMs
```

Compatibility aliases may map:

```text
gatewayValidationMs ← routingMs
authorizationMs ← policyMs
repositorySnapshotMs ← snapshotMs
operationExecutionMs ← executionMs
evidencePersistenceMs ← receiptMs
```

Unmeasured durable pipeline stages stay 0 (not claimed as measured zero cost).

Defaults return only `totalMs`. Full breakdown under `includeLatencyBreakdown`.

Benchmark entrypoint (library path; A/B via real Gateway still recommended before merge claims):

```bash
bun scripts/benchmark-thin-harness.ts
bun scripts/benchmark-thin-harness.ts --json
```

## Public surface note

Thin Harness is primarily a **library execution path** used by eligible repository operations (for example short readonly `repository_command_execute`). Optional batch/lanes/receipt tools exist on the repository tool definition set for `full` toolset / programmatic use. They are intentionally **not** bulk-added to the 128-cap stable ChatGPT schema in this slice.

## Migration Rule

1. Prefer Fast Path for short local work.
2. Escalate explicitly — never silent mid-flight upgrades.
3. Keep Durable Work / Scheduler / Worker unchanged for long and high-risk work.
4. Do not trade safety for speed.
5. Receipt persistence failure never rewrites a successful mutation outcome.
