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
        +---- Scheduler / WorkflowRun ---- long-lived or dependency-aware execution
        |            |
        |            +---- Process/resource coordination
        |            +---- optional isolated workers where a real boundary requires them
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

The preferred model-routing order is bounded, but it is not the MCP exposure boundary. The current transport cannot load domain schemas per conversation, so distinct typed repository, Git, Issue/Task, plugin, browser, iOS, artifact, and recovery operations remain statically registered. The five preferred facades are `rh_status`, `rh_access`, `rh_inbox`, `rh_context`, and `rh_project`, alongside `capability_execute`; the 19-tool preferred list controls routing order only. Retire duplicate aliases at their source definitions rather than hiding them through ordering or a compatibility profile.

### Repository identity

Every registered-repository execution is bound to a stable `repoId` and an explicit `checkoutId`. The current working directory cannot silently override that identity. Explicit unregistered workspace execution is a separate authority and does not create a repository registration behind the user's back.

### Direct versus scheduled execution

A small, understood action can stay Direct. Long-running or dependency-aware execution uses the Scheduler, WorkflowRun, and Process Runtime; isolated workers or worktrees are mechanisms for real execution or Git boundaries, never a second task/progress authority.

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

## Authority

Current source, public Kernel/domain APIs, static architecture checks, and focused tests define executable behavior. Product requirements, architecture decisions, progress, and acceptance evidence live in GitHub Issues/Project. Git history is the archive; this public page is explanatory, not a second engineering authority.
