# ADR: Immediate Controller Relay

- **Status:** Accepted for the Forge 1.6.x stabilization line
- **Date:** 2026-08-23
- **Authority:** [`../CURRENT.md`](../CURRENT.md), [`../../../AGENTS.md`](../../../AGENTS.md)

## Decision

ChatGPT remains the semantic Controller for goal interpretation, completion, waiting, and user-blocking decisions. The original stabilization rule that Forge may continue only after an explicit `continue_immediately` disposition is amended for V2 autonomous session continuation: once the exact Controller turn is provider-observed as settled, a still-nonterminal Work with no explicit stopping disposition has a Kernel-owned continuation obligation. This default is mechanical lifecycle policy, not semantic goal acceptance. Explicit `wait`, `wait_for_user`, `goal_complete`, active user-decision handoff, terminal Work, or bounded failure/budget state always wins and stops automatic continuation.

The supported dispositions are:

```text
continue_immediately
wait
wait_for_user
goal_complete
```

`continue_immediately` creates a durable `controller_round_relay` record under the existing Controller Home SQLite authority. It does not create a second scheduler, daemon, lifecycle owner, or autonomous agent. The current ChatGPT controller must own the exact live Work lease when it submits the disposition. Dispatch begins only after that lease is explicitly released.

A ChatGPT wake is a two-stage mechanical lifecycle: `dispatched -> claimed`. Browser prompt submission proves only transport dispatch. The round becomes `claimed` only when an authenticated ChatGPT Controller acquires the exact Work lease. Neither state is semantic acceptance. A claimed round normally ends with an explicit ChatGPT disposition. If the provider proves the exact assistant turn has settled and no explicit disposition exists, Kernel policy closes that nonterminal round as `continue_immediately`; it never infers `goal_complete`. If an explicit stop state already exists, settled-turn replay is a no-op. Lease disappearance without either a disposition or exact turn-settled evidence remains abandonment/recovery, not implicit progress.

The relay reuses the existing ChatGPT controller-browser launcher path. The originating Work's durable ChatGPT conversation binding is inherited automatically and then carried forward by stable relay scope, so later rounds and later Works under the same Requirement/Goal can reuse the same ChatGPT conversation without making chat history authoritative. Requirement, Work, Handoff and evidence state remain the source of truth.

A Requirement-bound relay scope is `requirement:<requirementId>`. A Goal without a durable Requirement uses an explicit stable goal scope; the initial fallback is `goal:<originWorkId>`. The next ChatGPT round may select or create a different Work under the same semantic scope.

## Lifecycle authority

- `rh_work controller_disposition` records the Controller's explicit semantic decision; explicit stop dispositions override the default autonomous continuation rule.
- exact provider-observed Controller-turn settlement is evidence only; Kernel transition policy alone may convert a still-claimed, nonterminal round with no stop disposition into the existing `continue_immediately` lifecycle.
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
