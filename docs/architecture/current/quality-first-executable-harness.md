# Quality-first executable harness

Status: **Runtime Authority**

Source baseline: `8540e85583498ef6a21215788b549db48e28fab7`
Scope: repository context, local command execution, routing, workflow scope evidence, and compatibility boundaries

## Invariants

1. ChatGPT remains the semantic controller. Forge returns bounded evidence and coverage; it does not decide that the first context pack is sufficient.
2. `rh_context.search` is repeatable. A broad first request and cached follow-up requests share session/source identity without creating durable context state.
3. Current raw source is authoritative. Stale structural relationships are hints only, with current changed-file and dirty-worktree overlays.
4. Exact known paths reserve file and snippet budget. Complete small files and complete matched symbols precede fallback windows.
5. Ordinary local commands use Ephemeral Exec. Commands exceeding the interactive admission budget may expose an in-memory Lightweight Managed handle with bounded output and wait/cancel/status.
6. Lightweight handles never create Process records, SQLite recovery membership, Process leases, Local Jobs, Execution Jobs, or replay bindings. Repository state is crash reconciliation evidence.
7. Work-bound verification and explicitly durable workflow commands may use persistent Process Runtime. Whole-Runtime recovery remains separate from ordinary command recovery.
8. Remote/release/destructive commands stop at an explicit external boundary. Ambiguous post-dispatch failures are `outcome_unknown` and have `never_auto_retry` policy.
9. Route Policy never selects Work from predicted file or line counts. Work is selected for explicit continuity, recovery, scheduling, independent deliverables, external effects, or multi-controller coordination.
10. `allowedPaths` is an explicit authorization fence. `scopeEvidence.initialLikelyPaths`, `inspectedPaths`, and `actualChangedPaths` are separate non-authoritative evidence.

## Execution lanes

| Lane | Default use | State/recovery cost |
|---|---|---|
| Ephemeral Direct | Git, inspection, edits, tests, builds, local scripts completing inside admission | command audit and repository snapshots only |
| Lightweight Managed | ordinary local command still running after admission or explicit async handle | in-memory PID/handle and bounded logs; best-effort visibility only |
| Durable Process | Work-bound verification/command with exact durable receipt requirements | Process record, lease, receipts, restart reconciliation |
| External Durable | remote release/publish/destructive effect | explicit controller/workflow; never automatic replay after ambiguity |

## State ownership

- Git/worktree: repository and integration truth.
- Edit Session: deterministic patch revision and savepoints.
- Lightweight handle: live ordinary command observation only; non-durable.
- Validation result: check evidence for an exact observed source identity.
- WorkContract: only durable workflow continuity and orchestration.
- Process Runtime: only durable command/check lifecycle.
- Runtime release/recovery: complete compatible Forge Runtime availability.

The retired public `controller_context_pack` compatibility handler is removed; `rh_context` is the single progressive context contract. Ordinary commands no longer instantiate Work/Process/Lease authorities.

## Decomposition

- Context Pack is split into contract types, query planning, focus selection, exact-path expansion, structural response shaping, and symbol materialization.
- Repository command execution is split into authorization/orchestration, child-process execution, repository snapshotting, and lightweight handle ownership.
- MCP tool schemas are separated from runtime handler implementation.
- The browser adapter remains cohesive for this slice because its physical-browser/session/media invariants require screenshot and sibling-device regression evidence before further decomposition.

## Large-module exceptions and next split points

| Module | Baseline → current | Why it remains above 700 lines | Next responsibility boundary |
|---|---:|---|---|
| `runtime-tools.ts` | 6621 → about 5900 | Handler migration must preserve one stable MCP dispatch surface and shared authenticated repository/controller context; this slice first removed the 700+ line schema responsibility. | Extract `rh_work` schedule/controller/finalization handlers into domain modules, leaving dispatch and shared response shaping only. |
| `legacy-tool-service.ts` | 5520 → about 5470 | It is a versioned full-profile compatibility boundary; deleting or scattering handlers without a client migration would hide breakage. | Remove the full profile as one versioned migration after supported callers move to stable facades. |
| `browser-adapter.ts` | 3726 → unchanged | Physical browser, media, and sibling-device behavior requires real screenshot/session verification that is outside this non-UI slice. | Split session ownership, action execution, and media extraction only with browser screenshot and sibling verification. |
| `recovery-manager.ts` | 2472 → unchanged | It remains the single lifecycle/recovery side-effect owner; casual splitting risks creating a second recovery authority. | Separate pure diagnosis/projection functions from the one mutation owner with failure-injection coverage. |

These are recorded exceptions, not target sizes. New responsibilities must not be
added to them when one of the boundaries above can own the behavior.
