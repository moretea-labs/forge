# Route Policy Authority

Forge has one replayable routing authority: `src/runtime/control-plane/routing/route-policy.ts`.

`decideRoute(RoutePolicyInput)` is a pure function. It applies hard constraints in lexical order: policy and authorization, destructive or remote effects, recovery and isolation, workspace state, explicit provider preference, then efficiency. It does not use dynamic weights.

The decision records execution mode, executor kind, Work requirement, isolation, recovery, approval/handoff state, reasons, a stable input fingerprint, and a policy version. CLI `assessWorkMode`, Facade `selectExecutionMode`, and Goal Loop `routeExecutor` are compatibility adapters only; they may normalize legacy fields but cannot retain thresholds or fallback rules.

Plan is optional reasoning evidence. It is created only for explicit planning, frozen scope, external approval, independent deliverables, or irreversible strategy review. Plan does not gate ordinary complex execution and is not a mutable execution state machine. Work remains the only execution contract for every mutation.

Direct mutation stays on Direct Control but creates lightweight Work lineage. Goal Workloop uses the same Work contract with durable recovery and optional isolation. EditSession stores only a bound execution identity and post-diff assurance; it never owns lifecycle.

Dirty workspaces are never adopted implicitly. A mutation must use a clean/isolated checkout or a separate exact reviewed adoption path. After a real diff exists, assurance is recalculated from changed paths and line count; protected paths can expand checks and require approval before finalization.

Test checkpoint reuse is content-addressed and must expose provenance: checkpoint key, digests, completion time, and evidence path. `--no-cache` remains the deterministic force-execution path.
