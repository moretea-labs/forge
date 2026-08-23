# ADR: Immediate Controller Relay

- **Status:** Accepted for the Forge 1.6.x stabilization line
- **Date:** 2026-08-23
- **Authority:** [`../CURRENT.md`](../CURRENT.md), [`../../../AGENTS.md`](../../../AGENTS.md)

## Decision

ChatGPT remains the semantic Controller. Forge may persist and execute an explicit end-of-round Controller disposition, but it must never infer that a Requirement, Goal, or Work should continue.

The supported dispositions are:

```text
continue_immediately
wait
wait_for_user
goal_complete
```

`continue_immediately` creates a durable `controller_round_relay` record under the existing Controller Home SQLite authority. It does not create a second scheduler, daemon, lifecycle owner, or autonomous agent. The current ChatGPT controller must own the exact live Work lease when it submits the disposition. Dispatch begins only after that lease is explicitly released.

The relay reuses the existing ChatGPT controller-browser launcher path. The originating Work's durable ChatGPT conversation binding is inherited automatically and then carried forward by stable relay scope, so later rounds and later Works under the same Requirement/Goal can reuse the same ChatGPT conversation without making chat history authoritative. Requirement, Work, Handoff and evidence state remain the source of truth.

A Requirement-bound relay scope is `requirement:<requirementId>`. A Goal without a durable Requirement uses an explicit stable goal scope; the initial fallback is `goal:<originWorkId>`. The next ChatGPT round may select or create a different Work under the same semantic scope.

## Lifecycle authority

- `rh_work controller_disposition` records the Controller's explicit semantic decision.
- `controller_release` is the only transition that may consume a pending immediate relay for that Work.
- the canonical ChatGPT launcher performs the next-round dispatch;
- Controller Session ownership, principal/session/instance fences, Handoff authority and external-effect policy remain unchanged and cannot be bypassed by Relay;
- `wait_for_user` requires an active Handoff bound to the relevant Work or repository decision surface.

## Mechanical anti-spin policy

Forge may block repeated execution mechanically, without making a semantic product decision. The relay records bounded round count, repeated semantic-state fingerprint count and consecutive launch failures. Limits can be tightened by a Controller but cannot be loosened inside an existing relay scope. A blocked relay requires a fresh Controller decision or explicit recovery.

## Failure and cleanup

A failed next-round launch records failure evidence and does not silently retry, fabricate progress, or create an alternate scheduler. If Browser/ChatGPT launch requires a user or host permission, the relay stops at that external blocker.

Terminal dispositions (`wait`, `wait_for_user`, `goal_complete`) leave no runnable immediate relay. Completed or superseded relay records are historical control-plane evidence and are subject to the same bounded Controller Home retention/maintenance policy as other durable control-plane records; they have no independent process or service cleanup lifecycle.

## Verification

- a same-principal but different live MCP session cannot submit a disposition for another session's Work lease;
- `continue_immediately` remains pending until explicit controller release;
- the existing Work-to-ChatGPT conversation binding is inherited when the Controller omits browser/session URL arguments;
- repeated unchanged state and round/failure budgets fail closed;
- Runtime architecture retains one Scheduler and one lifecycle owner;
- a live browser dispatch is required before the stabilization baseline is declared complete.
