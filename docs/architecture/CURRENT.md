# Forge Current Architecture

Status: **Runtime Authority**

This file is the sole maintained architecture authority for the current Forge runtime. Executable code and persisted schemas are authoritative for implementation facts; this document defines the architecture contracts they are expected to preserve. Do not hard-code a source commit here: release-specific snapshots belong in [`versions/`](versions/).

## Product model

Forge is an executable AI harness for a semantic controller. The controller owns requirement interpretation, repository understanding, implementation decisions, review, and the decision to keep exploring. Forge supplies fast context retrieval, deterministic local execution, provider actions, bounded verification, evidence, and optional durable continuity. Forge verification and evidence are factual inputs, not semantic acceptance rules: only the semantic Controller decides whether acceptance criteria are satisfied, whether another round is needed, or whether a Goal is complete.

```text
Semantic Controller
  -> Context Engine
  -> Thin Execution Harness
  -> Verification / Evidence
  -> Optional Durable Workflow / External Effect boundary
```

Quality is prioritized over interactive performance; performance is prioritized over durability machinery that does not materially improve ordinary coding.

## Controller efficiency contract

- The optimization unit is a **semantic checkpoint**, not a single low-level operation. GPT may issue one intent that mechanically fans into several bounded reads/searches or one coherent edit-plus-validation transaction when the implied steps require no new semantic judgement.
- Forge may execute deterministic conditionals such as `check failed -> collect bounded diagnostics and failure-site source`; it must stop before semantic actions such as choosing a repair, widening product scope, or deciding that acceptance is satisfied.
- Controller turns should stay continuous through a coherent implementation slice. External Controller relay is for real continuity boundaries such as scheduling, long waits, context/session rollover, or unattended resumption, not a normal inner-loop coding primitive.
- Operational output is aggressively bounded, while source/diagnostic evidence may use a larger information budget when that reduces repeated controller round trips. Every evidence bundle remains source/revision identified and reports truncation or coverage gaps rather than claiming semantic completeness.
- ChatGPT-native perception/compute capabilities are not copied into Forge merely to centralize tools. Web/Vision/one-shot connector perception may stay controller-native; Forge owns the local or durable execution/evidence boundary. A separate ChatGPT sandbox is never repository source or build authority.

## Context engine

- `rh_context` is the primary discovery/read path and may be called repeatedly.
- For exact or selected source paths, `rh_context` resolves applicable repository guidance by walking only that path's bounded directory ancestry from repository root to the nearest directory and returning present `AGENTS.md` / `CLAUDE.md` files in `instructionContext`. These files are guidance-only evidence: they do not consume the source `max_files` budget, define semantic scope, or become lifecycle/architecture authority. Missing optional guidance files are normal; policy denial, read failure, or bounded truncation stays visible as a coverage gap.
- The first request may perform one broad parallel discovery fan-in; natural-language lexical terms are heuristic hints, not completeness obligations. Broad lexical discovery stops after sufficient distinct candidate evidence across multiple hints and reports the remaining coverage gap instead of scanning toward a quota for every guessed term; exact known-file and compiler-semantic retrieval remain strict.
- Once credible paths or symbols are discovered, the semantic controller derives the next retrieval from returned source and prefers exact known paths, compiler-backed symbol navigation, or structural relationships over repeating the same broad lexical scan. Follow-up requests reuse in-process/session caches.
- Exact known paths reserve retrieval budget and current raw source is authoritative.
- Complete small files and complete matched symbols are preferred over arbitrary line windows.
- CodeGraph is discovery/relationship evidence, not semantic-completeness authority. Stale structural evidence must be labeled and current changed files remain raw-source authoritative.
- TypeScript Language Service navigation provides compiler-backed definition/reference/implementation lookup for TypeScript symbols through `rh_context`. Swift uses the same bounded `semantic_navigation` route with SourceKit-LSP, but only on explicit symbol requests and only when SwiftPM, BSP (`buildServer.json`), or compilation-database build settings are already available; Forge never performs an implicit build/index just to answer context. Xcode projects use `xcode-build-server` as the build-settings bridge. Because a present BSP can still return generic inferred flags instead of target settings, explicit Swift navigation verifies xcode-build-server compiler-option quality before starting SourceKit; obviously fallback options are rejected as incomplete. Manual `.compile` data produced from real `xcodebuild` output is validated locally, while automatic xcode-build-server mode uses a short cached BSP probe. SourceKit sessions are started lazily, serialized per repo/workspace, kept for a short two-minute idle TTL, and resynchronize changed open files; the first explicit Xcode semantic request has a bounded cold-start budget while warm requests retain the tighter interactive budget. Ordinary `rh_context` calls do not start either the BSP probe or SourceKit. Missing/stale/fallback build settings degrade explicitly to lexical/CodeGraph evidence rather than returning a false complete closure.
- The default 19-tool MCP schemas are a deployment ABI because approved ChatGPT apps may retain a frozen action/input snapshot. Core quality capabilities therefore need a path through already-stable facade fields. `rh_context` supports precise `@tsnav` and `@swiftnav` directives in `query` as compatibility paths; refreshed clients may use the existing structured `semantic_navigation` field.
- Exact lexical search remains necessary for dynamic registrations, manifests, string capability IDs, persisted aliases, and unrelated same-name implementations, but it is a discovery/fallback mechanism rather than the proof of static symbol completeness.

## Execution lanes

### Ephemeral Direct — default

Ordinary local reads, Git inspection, edits, local scripts, builds, and short checks should execute with minimal controller overhead. No persistent Work is created merely because the task is complex or investigative.

### Lightweight Managed

Commands that outlive the interactive admission window may expose an in-memory/lightweight process handle with bounded logs and wait/cancel/status. This lane does not require durable Process records, recovery membership, or Lease ownership merely to remain queryable during the current Runtime lifetime.

### Durable Workflow / Process

Persistent Work/Process state is reserved for actual continuity requirements: scheduled workflows, multi-session continuation, independent deliverables, explicit recoverability, long asynchronous workflows, release boundaries, or multi-controller coordination.

### External effects

Remote or non-idempotent effects are explicit boundaries. Ambiguous outcomes are reported as `outcome_unknown`; Forge must not silently replay a non-idempotent remote operation.
The low-level repository command facade classifies these operations as `durable` but does not dispatch them: it returns `not_started` with `never_auto_retry`. A typed provider action or explicitly owned Durable Workflow must perform the effect and reconcile remote state before any retry after an ambiguous result.

## Work and Plan

Work is a continuity/orchestration mechanism, not a coding-quality mechanism. File count, changed-line count, protected paths, dirty workspace state, review intent, or investigation alone must not create Work. Complex implementation quality is achieved through better repository understanding and fresh review, not heavier lifecycle state.

Plan is optional intent/coordination state. Initial likely paths are evidence, not a frozen semantic scope. The controller may discover and edit additional policy-allowed files without creating a second lifecycle solely because understanding improved.

### Persistent autonomous continuation

A scheduled unattended workflow is one durable **Work + ChatGPT conversation lineage**, not one browser tab and not one schedule occurrence. The existing authorities compose into one lifecycle:

1. A Schedule occurrence mechanically selects its already-bound active Work and requests `external_controller_wake`; it never invents semantic work.
2. The ChatGPT launcher resolves the Work's durable conversation binding, opens or reattaches only the execution tab/session needed for this round, submits the continuation prompt, and records dispatch evidence. Dispatch is transport evidence only; it is not a Controller claim or semantic completion.
3. The launched ChatGPT Controller claims the exact Work and independently reconstructs current Plan/Work/Schedule/Handoff/source/runtime evidence before deciding what to do. Chat history is useful transport context but is never the durable source of truth.
4. ChatGPT performs semantic reasoning while Forge performs deterministic context, edit, process, provider, verification, and finalize operations. Forge may automatically execute checks or lifecycle mechanics that ChatGPT explicitly requests, but it never infers that acceptance is satisfied.
5. Before a Controller round ends, ChatGPT records exactly one semantic disposition: `continue_immediately`, `wait`, `wait_for_user` with an active Handoff, or `goal_complete`. The exact Controller claim/release lineage fences this transition.
6. Round-owned automation resources are cleaned only after the round reaches its settlement boundary. User-owned browser tabs are preserved; a Forge-owned ephemeral ChatGPT tab may be closed while the Work's conversation id/url binding remains durable for the next wake.
7. `wait` keeps a persistent Work active and schedulable. A later Schedule wake must recover the same Work and same conversation lineage without requiring the user to restate the remaining task. `goal_complete` is the semantic terminal path and terminal Work automatically stops its continuation schedule.

Machine-observable continuation health is derived from existing records rather than a new database: Schedule occurrence, WorkContract, ChatGPT conversation binding, ControllerSession/round relay, verification/finalization receipts, and browser cleanup evidence. Health reporting must distinguish `wake requested`, `prompt dispatched`, `Controller claimed`, `semantic disposition recorded`, `lease released`, `verification/finalize outcome`, `tab cleanup`, and `waiting/next eligible`; none of those states may be substituted for another.

Transient Runtime, connector, or browser-provider unavailability may delay a wake through bounded backoff/re-arm, but must not silently terminalize the Work or permanently freeze a healthy persistent schedule. Repeated-state fencing remains a protection against semantic self-spin; recovery requires new durable evidence or a valid new Controller claim rather than blind retries.

Explicit **Scale** is the opt-in coordination form of this existing model, not a separate runtime tier. `rh_work mode=scale` requires a bound approved Plan step, routes through durable bounded Work with an isolated checkout, and lets the semantic controller decompose independent deliverables across multiple Plan steps. Independent Scale Work may proceed concurrently when existing Process/resource claims permit; conflicting claims still serialize or reject through the same Lease authority. Generic `requires_parallelism` alone does not imply Scale, Plan, Work, or isolation. Scale does not introduce an agent swarm, second scheduler, or second project lifecycle.

## State ownership

- Git/worktree owns repository source truth.
- Edit Session owns one deterministic local patch transaction and reviewable diff evidence.
- Lightweight process handles own only current-runtime attach state.
- Validation results own check evidence for the exact inputs they verified.
- Work owns durable continuity only when continuity is actually required.
- Durable Process owns persisted command/check lifecycle only when the selected lane is durable.
- Runtime release/recovery state owns Forge service availability and immutable release activation; it is separate from ordinary command recovery. The canonical OS service executes an atomic byte-identical mirror of the selected signed Runtime entrypoint from the fixed physical `runtime/service/active-forge-runtime` path, while release resources and identity remain manifest-bound. The stable physical path prevents macOS TCC from treating every immutable release directory as a new responsible-process principal.
- Independent Windows/WSL host rescue is an emergency availability boundary outside both the source checkout and Controller Home. It owns one configuration/lock root and may start or restart only the exact canonical Runtime, loopback-only Secure-Tunnel Connector, its own WSL watchdog unit, and one configured OpenAI Secure Tunnel alias. That connector runs without local MCP auth because OpenAI Secure Tunnel is the external authorization boundary; it must never be reused as a public ingress. The rescue boundary never owns a Runtime release, Controller database, schedule, work execution, secret value, compatibility fallback, or arbitrary shell RPC. Windows is a cold-start client only; the WSL rescue lock serializes every rescue mutation.
- Historical Issue/Task/Local Job and compatibility projections must not become second mutable authorities.
- Work lifecycle policy is separated from persistence: `work-state-machine.ts` owns legal phase/dispatch/evidence/completion transitions, while `work-contract-store.ts` owns locked persistence and applies that policy. Work completion projection is centralized in `work-completion-authority.ts`, and Work verification execution/evidence is centralized in `work-verification-service.ts`. Transports may submit requests and encode results but must not reimplement these rules.
- Work delivery/finalization is also an application service: `work-finalization-service.ts` owns the commit/merge/cleanup/receipt transaction and `work-execution-support.ts` owns shared exact identity/cleanup primitives. MCP `execution-tools.ts` and `rh_work` compatibility glue may prepare arguments or reconcile legacy handles, but they must enter that same finalization authority rather than perform Git delivery themselves.
- Work preparation/adoption is an application service as well: `work-preparation-service.ts` owns managed-workspace selection, WorkContract admission/reuse, exact successor-HEAD adoption and Controller ownership binding. MCP `execution-tools.ts` only decodes `work_prepare` / repository-bind requests and delegates; it must not recreate workspace admission or WorkHandle/WorkContract preparation transitions.
- Work command execution and validation live in `work-operation-service.ts`. Both MCP Gateway and Durable Worker call this application service directly; Workers must never dynamic-import MCP transport to obtain Work semantics. The architecture gate also forbids any `runtime/control-plane` source from depending back on `runtime/gateway`.
- Production Browser session persistence is Controller-home SQLite `BrowserSessionAuthority`. Compatibility JSON may be imported or used only when no Controller authority is available; handoff sidecars return interaction results and never write BrowserSession state directly.

## Runtime and MCP boundary

- Canonical Runtime is activated as one immutable whole release with a previous release retained for rollback.
- Runtime availability/recovery keeps Forge itself healthy; it does not imply exactly-once crash recovery for every local shell command.
- The default Controller MCP schema is the stable **19-tool** surface.
- `core` and `advanced` expose that same stable surface.
- `toolset=full` is an explicit compatibility profile and may contain historical definitions; current default schema construction must not depend on those legacy definitions.
- Current schemas/handlers should live with their owning module. Legacy compatibility may delegate but must not independently own current business rules. Shared transport contracts and tool definitions belong in neutral contract/definition modules so the dependency direction remains transport -> application/domain authority rather than transport implementations importing one another.
- Work-attributed verification is an application service, not an MCP/Local Bridge implementation detail: all Work verification resolves the Work checkout/check registry, runs through Process Runtime, validates terminal receipt identity, and records Work evidence through the same `work-verification-service.ts`.

### Controller facade and handoff boundary

- The stable Controller-facing facade is `rh_access`, `rh_status`, `rh_inbox`, `rh_context`, and `rh_work`. Internal repository, controller, evidence, maintenance, and plugin capabilities may grow behind the capability registry without creating another top-level tool for each feature.
- Handoff Inbox state is durable decision state for blocked or review-needed Controller judgement. It is not a log sink and must not become a second Requirement, Plan, Work, or Process lifecycle.
- Facade results are bounded summaries plus evidence references. Forge may report policy, verification, lifecycle, and capability facts; semantic acceptance and the decision to continue remain Controller-owned.

### Host hook boundary

Host hook files are integration surfaces, not lifecycle or architecture authorities. Forge-managed entries are identified so install/uninstall can change only Forge-owned entries while preserving sibling user hooks; legacy adapter entries are migration input rather than a second current identity. The hot host path converges on the minimal `forge-hook` entrypoint and current hook runtime, and CLI absence fails safely instead of turning a host hook into a repository failure. Setup/readiness flows may inspect and report host gaps but must not silently treat user-owned host configuration as current architecture state.

## Provider boundary

Typed provider/plugin actions should use Forge capability/resource semantics directly instead of hiding host/browser/device operations inside arbitrary repository shell commands. Built-in providers may remain inside Forge when they are tightly coupled to Controller policy and lifecycle; independent products/providers retain independent release boundaries and integrate through the Plugin Protocol.

### iOS physical-device boundary

- `ios-device` is the single physical-device resource domain. Backend/engine details may vary, but they must not create independent mutation authority or concurrent ownership for the same phone.
- Agent-device readiness is capability-negotiated from a reviewed version/help contract and a stable contract fingerprint. A preferred version is support guidance rather than authority; unsupported or unreviewed pre-1.0 contracts fail closed instead of guessing flags or semantic support.
- Application adapters own app-specific semantic targeting and assertions; provider code owns transport, device/session lifecycle, and command execution. Semantic action failure is distinct from transport/session death, and unknown mutation outcomes are fenced rather than blindly replayed.
- iOS evidence is bounded and redacted. Read-only lifecycle/screenshot capability must never be represented as proof of semantic mutation capability.

## Browser Runtime V3 contract

Browser Runtime V3 is the current Browser execution authority. Controller-home BrowserSession state is the sole durable browser-session authority; stable provider/resource identity is distinct from mutable observed URL/title, and provider-local live handles are acceleration state only. The accepted Browser Runtime V2 ADR remains historical rationale rather than a competing current authority.

Browser providers are selected by declared capability. Common DOM and typed browser-internal operations must remain background-safe. Native macOS sessions reuse or recover only exact Forge-owned `windowId` + `tabId` identities. Provider-wide tab inventory is an optional optimization: when the installed broker cannot enumerate tabs, Forge may create a new plugin-owned tab or validate a saved exact ref, but it must not scan for or guess an unrelated user tab.

Foreground presentation is an explicit effect reserved for capabilities that truly require physical pointer/keyboard input or human handoff. Browser `trusted_input` never silently activates a background tab or converts CSS viewport coordinates into desktop coordinates. If the native broker lacks the required trusted-input capability, Browser fails with a typed capability error; an explicitly requested Desktop Operator foreground/physical action remains a separate authority boundary. Mutating provider actions are complete only when their declared postconditions are verified; transport, Apple Events, Accessibility, socket, or CGEvent success alone is not semantic completion.

The public Browser action surface remains compatible across Playwright/CDP/native providers. Current native compatibility may omit optional broker methods such as global tab inventory while preserving exact-ref lifecycle safety. DOM automation through Chrome/Vivaldi Apple Events still requires the browser's JavaScript-from-Apple-Events permission; missing permission fails closed instead of weakening the provider contract. Browser replay safety is derived from the Browser Runtime transaction contract rather than an adapter-local action allowlist, and native session liveness/reconciliation is centralized outside the plugin composition root. A human-handoff host may persist its own InteractionSession result, but BrowserSession mutation returns to the canonical Runtime authority.

## Testing and verification

Tests are verification evidence, not an alternate architecture authority.

- Development/task gate: typecheck + static architecture + generated-authority drift + source-duplication classification + controller-UI reproduction + manifest validity + affected tests.
- Main candidate: task gate + core regression + Runtime smoke.
- Release candidate: main gate + full regression + release packaging/readiness.
- Static architecture additionally requires the production `src/**/*.ts` relative-import graph to be acyclic. Neutral contracts may break dependency direction; dynamic imports must not be used merely to conceal a static architecture cycle.
- Source-duplication governance permits only classified distribution/template projections, guidance aliases, and placeholders; unclassified exact duplicates fail the gate. Generated copies may exist for packaging, but manual implementation duplication is not an accepted source-authoring model.
- Test governance validates registration, resource classification, selection and execution isolation; it does not impose arbitrary global test-line or resource-count budgets.
- Prefer a small number of architectural invariants, focused module tests and essential integration/E2E coverage. Delete implementation-coupled or retired-compatibility tests when the underlying obligation is removed.

## Documentation authority

The maintained documentation surface is intentionally small:

- [`../README.md`](../README.md) — documentation entry.
- [`../ROADMAP.md`](../ROADMAP.md) — current/next priorities.
- `CURRENT.md` — sole maintained current architecture authority.
- [`index.md`](index.md) — architecture navigation and lifecycle rules.
- [`EVOLUTION.md`](EVOLUTION.md) — append-only architecture change log.
- [`decisions/`](decisions/) — accepted ADR rationale; once a rule is ordinary current architecture it is folded into `CURRENT.md` and the ADR remains historical rationale.
- [`versions/`](versions/) — architecture snapshot created at release/version boundaries.
- [`history/`](history/) and [`history.md`](history.md) — archived historical evidence and compatibility history, never runtime authority.
- [`../../CHANGELOG.md`](../../CHANGELOG.md) — release/user-visible change log.

Architecture-root Markdown is deliberately restricted to `CURRENT.md`, `EVOLUTION.md`, `history.md`, and `index.md`. A proposed architecture change belongs in a request/ADR or durable Plan/Work evidence until its accepted invariant is folded into `CURRENT.md`; do not create a parallel root-level "current design" page. Execution statuses such as phases, "implementation in progress", pending manual validation, operator-specific paths, and machine-local observations belong in Work/Plan/evidence or the history archive, not in maintained current architecture.

Research notes, tasks, reviews, archived architecture pages, plans and Git history are evidence/history only. They do not need to be synchronized on every source edit.

## Intentionally retained compatibility debt

- Explicit `toolset=full` remains a supported legacy compatibility boundary for now. Issue/Task/project-board writers are migration-only compatibility and are permanently retired after the SQLite requirement-portfolio cutover marker; they must not become a second current control plane.
- Some large runtime modules still aggregate multiple responsibilities and should be decomposed only when a clear ownership boundary is available.
- CodeGraph may be structurally stale between index refreshes; current raw source and changed-file overlays remain authoritative.

These items belong on the roadmap, not in parallel current-architecture documents.
