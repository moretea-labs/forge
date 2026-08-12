# Architecture

Forge is organized around one rule: **the client decides intent; Forge owns deterministic local execution state and safety boundaries.** ChatGPT can choose how much reasoning or planning a task needs, while Forge keeps repository identity, execution, evidence, and Runtime authority coherent.

## System map

```text
ChatGPT / CLI / local UI
        |
        v
Authenticated MCP transport
        |
        v
Gateway + bounded 19-tool controller surface
        |
        +---- Direct reads / Direct Edit / explicit ephemeral workspace
        |
        +---- Managed Process Runtime ---- commands / checks
        |            |
        |            +---- Process record + output + completion receipt
        |            +---- Claims / Leases / exact process identity
        |
        +---- Durable Work / Scheduler ---- long-lived or dependency-aware work
        |            |
        |            +---- repository/check-out ownership
        |            +---- optional isolated worktrees / workers / agents
        |
        v
Controller Home + repository state + evidence

One Canonical Forge Runtime
        |
        +---- whole-release authority
        +---- Runtime ownership / readiness / MCP
        +---- independent standalone Recovery outside the primary failure domain
```

## Major boundaries

### Client and tool surface

The default ChatGPT-facing surface is bounded rather than exposing every internal handler. The five preferred facades are `rh_status`, `rh_access`, `rh_inbox`, `rh_context`, and `rh_work`; repository, patch, check, Process, plugin-dispatch, and result tools complete the current 19-tool connector schema. The exhaustive compatibility profile remains an implementation detail for explicit diagnostic clients.

### Repository identity

Every registered-repository execution is bound to a stable `repoId` and an explicit `checkoutId`. The current working directory cannot silently override that identity. Explicit unregistered workspace execution is a separate authority and does not create a repository registration behind the user's back.

### Direct versus durable work

Investigation is not itself a reason to create Work. A small, understood change can stay Direct. Durable Work, worktrees, or workers are introduced when recovery, dependency tracking, isolation, long-running execution, or real risk requires them.

### Process Runtime

Repository commands and checks have one managed process lifecycle. Starting a command creates one Process identity; later status, wait, log, and cancel calls attach to that same process instead of spawning it again. Resource claims and leases protect conflicting writes without globally serializing unrelated repositories.

### Verification and evidence

Evidence is bound to repository identity, checkout, revision, command/check definition, and environment where applicable. Equivalent checks may coalesce or reuse valid evidence. A content or environment change invalidates stale evidence rather than silently reusing it.

### MCP session lifecycle

A client session is a transport boundary, not a work owner. If the canonical tool schema changes, a stale session receives a bounded `MCP_TOOL_SURFACE_CHANGED` reinitialization signal while its transport remains alive long enough for the host to initialize the replacement session. The replacement initialize then supersedes the old session. A schema fence must not make the entire Forge namespace disappear from the host conversation.

### Runtime and release authority

One Canonical Runtime owns the active local execution authority and one whole-release identity. Runtime source, release manifest, service definition, process ownership, and readiness must agree. Standalone Recovery is intentionally separate so the primary MCP process cannot be its own only recovery mechanism.

## Concurrency model

- Different repositories can run independently under global capacity limits.
- Different checkouts/worktrees of one repository can run independently when their resource claims do not conflict.
- The same checkout remains single-writer.
- Integration and Git-ref mutation stay exclusive even when worktree implementation is parallel.
- Shared checks can single-flight and reuse evidence rather than repeat physical execution for each session.

## Authoritative documents

- [System overview](https://github.com/moretea-labs/forge/blob/main/docs/architecture/current/system-overview.md)
- [Architecture invariants](https://github.com/moretea-labs/forge/blob/main/docs/architecture/current/architecture-invariants.md)
- [Multi-repository execution](https://github.com/moretea-labs/forge/blob/main/docs/architecture/current/multi-repository-execution.md)
- [Verification and release gates](https://github.com/moretea-labs/forge/blob/main/docs/architecture/current/verification-and-release-gates.md)
- [Implementation status](https://github.com/moretea-labs/forge/blob/main/docs/architecture/current/implementation-status.md)
- [Runtime directory map](https://github.com/moretea-labs/forge/blob/main/docs/architecture/current/runtime-directory-map.md)

Historical snapshots explain previous designs but are not current Runtime contracts.
