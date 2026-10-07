# Forge V3 desktop client boundary

Status: accepted
Date: 2026-10-05
Authority: [`../CURRENT.md`](../CURRENT.md)

## Decision

Forge V3 introduces a fresh cross-platform desktop client under `apps/desktop`. The client is a presentation and interaction adapter over the existing Forge Runtime and Controller authorities; it is not a second control plane and does not reuse the retired Local Bridge web frontend as product architecture.

The initial macOS shell exposes two explicit interaction modes without creating a new domain state machine: Local for client-owned conversation interaction, and MCP for Projects/Work plus Runtime/Recovery operations. A lightweight sidebar selects mode, repository scope and Work; the single main surface shows either the Local conversation or the MCP repository/work surface and immediate actions. Plan, evidence, IDs and mechanical Runtime facts are disclosed on demand rather than occupying a permanent inspector. These surfaces are views over canonical Runtime facts rather than independent client state machines.

## Authority boundary

- Requirement, Plan, Work, ControllerSession/ControllerRound, Scheduler, Workflow Supervisor, repository/worktree identity, connections and Runtime/Recovery lifecycle remain authoritative in their existing Forge owners.
- The desktop client may own only transient presentation state such as selected navigation, active inspector tab, draft text, window geometry and replaceable transport handles.
- The client must not persist a mirrored Requirement/Plan/Work database, infer semantic completion from UI state, or create a client-side scheduler/retry authority.
- Runtime reads enter through typed projection/query contracts. Runtime mutations enter through existing typed Runtime/Controller capabilities and preserve their CAS, effect, authorization and outcome-unknown semantics.
- Tauri owns desktop shell mechanics only. Starting or closing the UI must not mint another Forge Runtime, Recovery, Scheduler or Supervisor authority.
- A disconnected UI is an adapter availability state. It does not redefine Work, Scheduler or Runtime semantic state.
- Runtime/Recovery history is projected from the standalone Recovery authority's bounded canonical audit tail. The projection exposes event/time and a bounded outcome bit only, omits arbitrary audit detail and local paths, and is never persisted or reconstructed by the desktop client.

## Foundation layout

`apps/desktop/src/runtime-projection.ts` defines the projection-facing client boundary. Its bootstrap value is presentation-only and intentionally says `Runtime not connected`; no fake Requirement, Plan, Work or connection facts are synthesized before Runtime integration lands.

`apps/desktop/src-tauri` is the fresh Tauri 2 shell. Platform-specific code remains behind this shell/provider boundary so Windows support can be added without changing semantic ownership.

## Runtime transport

The desktop shell reaches Canonical Runtime through its existing loopback MCP HTTP transport. The Tauri process resolves the installed Controller Home and Runtime service configuration, reads the Runtime bearer token only inside the native process, and issues stateless MCP `tools/call` requests. The token is never projected into the webview. Desktop mutations therefore still enter through `capability_execute`; the current automatic-continuation conversation switch calls `controller.workflow_supervisor.switch_to_fresh_conversation` and preserves the Supervisor CAS/effect fences.

The bridge is intentionally typed and narrow. It exposes only the product facts/actions needed by the current macOS surfaces: Repository Registry projection, bounded repository/runtime status, selected Work detail, Requirement detail, Plan detail, pending UserRequest projection, automatic-continuation projection, controller/tunnel connection projection, explicit Work continuation, explicit fresh-conversation migration, and bounded connection repair. Each command forwards to an existing Forge facade/tool; it does not expose Controller Home persistence, a generic database API, or a client-owned retry/session engine.

## Project Workbench projection

The V3 Project Workbench remains projection-only. Entering MCP or selecting a Project first establishes a repository/worktree overview from canonical Repository Registry and repository-state facts; it does not implicitly select or create a Work. The primary MCP surface may summarize the already-projected Repository cleanliness/revision, current Work count, active worktree inventory and Runtime/MCP readiness in compact operational cards; once a Work is selected, the same summary layer may surface canonical Work revision/state, linked Plan revision/status, execution-evidence phase/check counts and Repository state before the detailed sections. These summaries are derived only from the projection already in memory and never become a client-owned status model. Project navigation reads the canonical Repository Registry through `repository_list`; active checkout/worktree inventory comes from the existing `repository_get(detail)` authority, then the native bridge strips it to checkout id, local path, branch, worktree kind, lifecycle and active identity and bounds the WebView list rather than copying complete historical Registry records; bounded Git/repository state comes from `rh_status(list)`; the sidebar's current Work collection and bounded recent completed/cancelled history come from canonical `rh_work(list)` rather than a client-invented `rh_status` snapshot shape; once the user selects a Work, its canonical `revisionHistory`, its decomposition/dependency graph, and a bounded execution-evidence projection come from `rh_work(get, detail)`; linked Requirement and Plan authored facts plus canonical Plan `revisionHistory` are read through `rh_work(requirement_get)` and `rh_work(plan_get, detail)`. The Work detail execution projection is sourced from the canonical WorkContract execution fields (`dispatchState`, `evidenceState`, `phase`, `workKind`, `completionOutcome`, declared checks, `phaseEvidence`, verification records and `evidenceRefs`) and strips process-local artifact paths or other unnecessary mechanics before crossing into the webview. Work remains semantic scope only: unless a separate canonical execution-placement fact is supplied, the desktop must not present the Project active checkout as the Work's execution checkout. The desktop must not parse semantic `resultRefs` to infer check outcomes, phase completion, execution placement or execution progress. Pending human-boundary facts come from instance-level `rh_inbox(list)` and are filtered to an exact `targetScope.workId` match before appearing in the selected Work surface, so the client does not turn the main workspace into a global/stale handoff dump. The focused surface may show Work semantic state/revision, repository dirty state, branch/source revision and canonical `nextSafeAction` as a compact fact strip, while Requirement outcome/acceptance criteria, Plan items, Work parent/dependencies, execution/check evidence, semantic revision history and result references remain progressive disclosure. History renders recorded semantic revisions as supplied; the client does not calculate progress, backfill missing revisions, or reinterpret historical state. Selecting a Project or Work changes only transient desktop presentation state. The client does not persist or reconstruct Work, Requirement, Plan, UserRequest, Git or Scheduler authority.

Continuing a selected Work is an explicit user mutation routed through `rh_work(launcher_start)` with the selected repository and Work identities. Automatic-continuation metadata comes from `controller.workflow_supervisor.list`; exact conversation URL, repository/Requirement contract bindings and created time are rendered only when supplied by the Supervisor authority. The desktop does not create its own controller session, retry loop, conversation authority, UserRequest lifecycle, or lifecycle transition.

The shipped desktop UI is Chinese-first. Domain IDs, repository names, user-authored objectives and external product names remain verbatim canonical data, while navigation, labels, states, actions, errors and explanatory copy are rendered in Chinese.

## Local conversation boundary

Local Thread is client-owned interaction data, not a Forge semantic lifecycle record. The desktop may persist a bounded local transcript plus presentation metadata and an optional canonical repository id reference, but it must not copy Requirement, Plan, Work, Runtime or connection records into that store as mutable truth.

Current Kernel `ControllerSession` / `ControllerRound` contracts are intentionally Work-bound. Local conversation therefore must not manufacture a Work merely to obtain a controller binding, and it must not reinterpret Workflow Supervisor or `launcher_start` as a general chat-session authority. Provider status and invocation live behind the typed `controller.local_conversation` capability. The initial provider is the installed Codex CLI and reuses Codex-owned authentication; Forge does not copy provider credentials into Controller Home or the renderer. Each local thread receives an invocation-scoped Forge MCP principal/session, while the provider thread id remains only an opaque resume handle. The provider/controller loop calls the existing Runtime MCP capabilities as tools, so Forge continues to own those capability effects and canonical semantic facts.

Local Codex sessions start in a read-only provider sandbox. Repository and Runtime mutations therefore go through the injected Forge MCP capability surface rather than direct provider filesystem writes. Client-local thread create/select/archive, optional Project attachment, provider resume, and final assistant responses are functional without implicit Requirement/Plan/Work/ControllerRound creation. If Codex or Runtime is unavailable the UI reports that failure directly; there is no synthetic assistant output and no fallback to the retired Local Bridge/browser-profile path.

## Runtime and Recovery surface

The Runtime screen must remain usable when Canonical Runtime is unavailable. The native Tauri adapter therefore has a second narrow transport path to the already-authoritative Standalone Recovery Gateway at its configured loopback MCP endpoint. It reads the Recovery configuration and bearer token only inside the native process; Recovery credentials are never projected into the webview.

This is not a fallback Runtime and does not start, stop, repair, or roll back any process directly. Readiness and diagnostics call Recovery's `runtime_status` and `verify_stable_runtime`. Explicit user mutations are limited to named Recovery tools such as `restart_primary_runtime` and `recover_primary_runtime`. Before a mutation, the adapter re-reads `runtime_status` and hydrates the exact host/platform/ControllerHome/Recovery-release/target-Runtime fencing identity exposed by Recovery itself; Standalone Recovery remains the authority that validates or rejects the operation.

No client retry loop or inferred recovery lifecycle is introduced. The UI may own only transient loading/error/confirmation state around one explicit command, then it re-reads Recovery authority after completion. `restart_primary_runtime` already stops/quiesces as needed, starts the configured launchd/systemd service and verifies the whole Runtime, so the desktop may label that same Recovery-owned mutation `Start Runtime` when `runtime_status.running=false` and `Restart Runtime` otherwise; this creates no second start authority. `recover_primary_runtime` remains a distinct deeper recovery transaction that can enter release recovery/rollback and is exposed only as an explicitly warned action while Runtime is not ready.

Controller and remote-transport setup is projected separately through the typed `controller.connection` capability. That facade derives product-safe status from the existing setup-profile authority (`readSetupProfile`, `resolveControllerGuidance`, and `resolveTunnelGuidance`) and does not persist a second connection model. Its only automatic mutation, `repair_connector`, delegates to the existing `runMcpSetupChatgpt` owner for the Forge-managed loopback Connector. OpenAI Secure Tunnel, Cloudflare, Tailscale, client installation, login, tunnel identity, and other external prerequisites remain explicit setup requirements rather than being silently repaired by the desktop client. Tauri and the webview never read or write setup files directly.

## macOS presentation model

The macOS client uses the system-owned decorated window. The webview must not draw duplicate traffic-light controls or treat an application toolbar as a synthetic title bar. Window close/minimize/zoom chrome remains owned by macOS/Tauri.

The primary V3 layout is intentionally sparse: one lightweight navigation sidebar and one main work surface. A compact Local/MCP switch changes presentation scope only. In MCP mode, Project selection opens a repository/worktree overview and Work inventory; Work selection then focuses the same main surface on the selected Work and its immediate actions. Repository/Work/Plan/Evidence readiness may appear as a compact summary band on that main surface so MCP operation does not require opening several disclosure sections merely to understand current state. IDs, revision history, raw evidence references, runtime mechanics, and other secondary facts remain progressive disclosure rather than a permanent inspector column. Runtime/Recovery is a dedicated MCP main surface rather than a dashboard side panel.

This follows the desktop-agent interaction model of task/session navigation plus a focused work area. It explicitly rejects a three-column web-dashboard composition as the default macOS product architecture.

## Verification

This foundation is acceptable when:

1. the frontend source and Tauri shell form an independently reviewable application boundary;
2. no desktop source imports Runtime persistence stores or writes Controller Home state directly;
3. the UI can render without manufacturing semantic domain data;
4. project source authority includes `apps/**` so future engineering checks and context retrieval treat the client as first-class source;
5. subsequent Runtime bootstrap work can replace the disconnected projection through a typed client adapter without migrating client-owned semantic data, because none exists.
