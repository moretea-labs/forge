# Forge V3 desktop client boundary

Status: accepted
Date: 2026-10-05
Authority: [`../CURRENT.md`](../CURRENT.md)

## Decision

Forge V3 introduces a fresh cross-platform desktop client under `apps/desktop`. The client is a presentation and interaction adapter over the existing Forge Runtime and Controller authorities; it is not a second control plane and does not reuse the retired Local Bridge web frontend as product architecture.

The initial shell is conversation-first and exposes the V3 information architecture: New Thread, Search, Projects, Recent Threads, Activity, Schedules, Needs You, Connections, Plugins, Instances and Settings. The thread inspector projects Goal, Plan, Changes, Evidence and Resources. These surfaces are views over canonical Runtime facts rather than independent client state machines.

## Authority boundary

- Requirement, Plan, Work, ControllerSession/ControllerRound, Scheduler, Workflow Supervisor, repository/worktree identity, connections and Runtime/Recovery lifecycle remain authoritative in their existing Forge owners.
- The desktop client may own only transient presentation state such as selected navigation, active inspector tab, draft text, window geometry and replaceable transport handles.
- The client must not persist a mirrored Requirement/Plan/Work database, infer semantic completion from UI state, or create a client-side scheduler/retry authority.
- Runtime reads enter through typed projection/query contracts. Runtime mutations enter through existing typed Runtime/Controller capabilities and preserve their CAS, effect, authorization and outcome-unknown semantics.
- Tauri owns desktop shell mechanics only. Starting or closing the UI must not mint another Forge Runtime, Recovery, Scheduler or Supervisor authority.
- A disconnected UI is an adapter availability state. It does not redefine Work, Scheduler or Runtime semantic state.

## Foundation layout

`apps/desktop/src/runtime-projection.ts` defines the projection-facing client boundary. Its bootstrap value is presentation-only and intentionally says `Runtime not connected`; no fake Requirement, Plan, Work or connection facts are synthesized before Runtime integration lands.

`apps/desktop/src-tauri` is the fresh Tauri 2 shell. Platform-specific code remains behind this shell/provider boundary so Windows support can be added without changing semantic ownership.

## Runtime transport

The desktop shell reaches Canonical Runtime through its existing loopback MCP HTTP transport. The Tauri process resolves the installed Controller Home and Runtime service configuration, reads the Runtime bearer token only inside the native process, and issues stateless MCP `tools/call` requests. The token is never projected into the webview. Desktop mutations therefore still enter through `capability_execute`; the current automatic-continuation conversation switch calls `controller.workflow_supervisor.switch_to_fresh_conversation` and preserves the Supervisor CAS/effect fences.

The bridge is intentionally typed and narrow. It currently exposes automatic-continuation projection and explicit fresh-conversation migration only; it does not expose Controller Home persistence, a generic database API, or a client-owned retry/session engine.

## Project Workbench projection

The V3 Project Workbench remains projection-only. Project navigation reads the canonical Repository Registry through `repository_list`; a selected project's bounded current Work/Plan summary comes from `rh_status(list)`; the selected Work and its decomposition/dependency graph come from `rh_work(get, detail)`. Selecting a Project or Work changes only transient desktop presentation state. The client does not persist or reconstruct Work graph authority.

Continuing a selected Work is an explicit user mutation routed through `rh_work(launcher_start)` with the selected repository and Work identities. The desktop does not create its own controller session, retry loop, conversation authority, or lifecycle transition.

The shipped desktop UI is Chinese-first. Domain IDs, repository names, user-authored objectives and external product names remain verbatim canonical data, while navigation, labels, states, actions, errors and explanatory copy are rendered in Chinese.

## Verification

This foundation is acceptable when:

1. the frontend source and Tauri shell form an independently reviewable application boundary;
2. no desktop source imports Runtime persistence stores or writes Controller Home state directly;
3. the UI can render without manufacturing semantic domain data;
4. project source authority includes `apps/**` so future engineering checks and context retrieval treat the client as first-class source;
5. subsequent Runtime bootstrap work can replace the disconnected projection through a typed client adapter without migrating client-owned semantic data, because none exists.
