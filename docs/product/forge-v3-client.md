# Forge V3 Desktop Client

Status: implementation contract for Plan `PLAN-forge-v3-desktop-client-20260930-r1`, revision 8.

## User jobs

Forge V3 has two explicit top-level jobs in one window:

- **MCP workspace**: inspect and act on canonical Forge state. Assistant is the
  Forge-instance scope; Projects are repository/worktree scope. The user can
  see the current Requirement root when one exists, the current Work graph,
  each Work's descriptive Plan and history, evidence, and pending actions.
- **Local conversation**: converse with one configured model provider. A local
  thread is client-owned and may attach a repository for context, but it never
  implicitly creates or changes a Requirement, Plan, or Work.

The shell is day-mode, macOS-first, and has one primary workspace with a
compact global Runtime status control. Runtime health is not a separate
dashboard destination. Deep diagnostics are explicit actions, not part of the
fast bootstrap path.

## State and interaction model

| User-visible fact | States shown by V3 | Authority | Mutation path |
| --- | --- | --- | --- |
| Runtime health | ready, starting, unavailable, stopped, attention | Canonical Runtime observation | Standalone Recovery / existing Runtime lifecycle |
| Repository/worktree | current, available, disabled | Repository registry and checkout projection | Existing repository facade |
| Work | open, completed, cancelled plus mechanical detail | Canonical WorkContract | Existing Work APIs |
| Work decomposition | `semanticParentWorkId` | Canonical WorkContract | Work semantic creation |
| Work dependency | `dependsOnWorkIds` | Canonical WorkContract | Work semantic creation |
| Plan context | descriptive Plan id/revision | Canonical Plan/Work links | Existing Plan/Work APIs |
| Local transcript | thread and message history | Versioned client-local store | Client/Tauri boundary |
| Provider credential | connected/disconnected | macOS Keychain | Typed platform IPC |

`parentWorkId` is never used for decomposition: it remains the execution-child
ownership edge. `predecessorWorkId`, `supersedes`, and `supersededBy` remain
continuation/replacement history. The client renders the graph; it does not
persist a second graph or infer semantic completion.

## Bootstrap contract

The V3 renderer consumes the versioned Local Bridge endpoint
`GET /api/client/v3/bootstrap`. It returns a shallow Runtime observation,
repository projections, and Work projections in one response. It must not read
Controller Home, invoke shell commands, or wait for deep readiness diagnostics.

The endpoint is a projection only. It does not become a second authority and it
does not change Runtime lifecycle. Runtime-down actions remain owned by
Standalone Recovery and are added to the native typed IPC boundary rather than
implemented as renderer-side process management.

## Native shell boundary

The initial macOS shell is Tauri 2. The renderer is loaded from the built V3
bundle and owns presentation plus client-local transcript state. Native commands
are allowlisted and intentionally small; the shell does not own Runtime,
Recovery, Work, Plan, repository, or credential state. `platform_info` is the
initial boundary probe. `recovery_status`, `recovery_restart_runtime`,
`local_bridge_bootstrap`, and `local_bridge_start_work` delegate to the existing
Runtime/Recovery/Work owners; they do not create a second persistence or
lifecycle authority.

## Required empty and failure states

- No repository: Assistant remains usable; Projects explains how to add one.
- No active Work: show the empty state without inventing a Plan or progress.
- Runtime unavailable: keep the shell open, show the concrete next action, and
  do not call Local Bridge as a recovery mechanism.
- Runtime ready but Local Bridge unavailable: show reconnect/diagnose context;
  do not create a duplicate status authority.
- Local provider disconnected: preserve the local thread and offer one
  connection action; credentials never enter Forge Work/Plan state.
