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

Explicit **Scale** is the opt-in coordination form of this existing model, not a separate runtime tier. `rh_work mode=scale` requires a bound approved Plan step, routes through durable bounded Work with an isolated checkout, and lets the semantic controller decompose independent deliverables across multiple Plan steps. Independent Scale Work may proceed concurrently when existing Process/resource claims permit; conflicting claims still serialize or reject through the same Lease authority. Generic `requires_parallelism` alone does not imply Scale, Plan, Work, or isolation. Scale does not introduce an agent swarm, second scheduler, or second project lifecycle.

## State ownership

- Git/worktree owns repository source truth.
- Edit Session owns one deterministic local patch transaction and reviewable diff evidence.
- Lightweight process handles own only current-runtime attach state.
- Validation results own check evidence for the exact inputs they verified.
- Work owns durable continuity only when continuity is actually required.
- Durable Process owns persisted command/check lifecycle only when the selected lane is durable.
- Runtime release/recovery state owns Forge service availability and immutable release activation; it is separate from ordinary command recovery. The canonical OS service executes an atomic byte-identical mirror of the selected signed Runtime entrypoint from the fixed physical `runtime/service/active-forge-runtime` path, while release resources and identity remain manifest-bound. The stable physical path prevents macOS TCC from treating every immutable release directory as a new responsible-process principal.
- Historical Issue/Task/Local Job and compatibility projections must not become second mutable authorities.

## Runtime and MCP boundary

- Canonical Runtime is activated as one immutable whole release with a previous release retained for rollback.
- Runtime availability/recovery keeps Forge itself healthy; it does not imply exactly-once crash recovery for every local shell command.
- The default Controller MCP schema is the stable **19-tool** surface.
- `core` and `advanced` expose that same stable surface.
- `toolset=full` is an explicit compatibility profile and may contain historical definitions; current default schema construction must not depend on those legacy definitions.
- Current schemas/handlers should live with their owning module. Legacy compatibility may delegate but must not independently own current business rules.

## Provider boundary

Typed provider/plugin actions should use Forge capability/resource semantics directly instead of hiding host/browser/device operations inside arbitrary repository shell commands. Built-in providers may remain inside Forge when they are tightly coupled to Controller policy and lifecycle; independent products/providers retain independent release boundaries and integrate through the Plugin Protocol.

## Browser Runtime V2 transition contract

Browser automation is converging on the accepted [`Browser Runtime V2`](decisions/20260826-browser-runtime-v2.md) architecture. Controller-home BrowserSession state is the sole durable browser-session authority. Stable provider/resource identity is distinct from mutable observed URL/title; providers may retain ephemeral live handles only as acceleration state.

Browser providers are selected by declared capability. Common DOM and typed browser-internal operations must remain background-safe. Foreground presentation is an explicit effect reserved for capabilities that truly require physical pointer/keyboard input or human handoff. Mutating provider actions are complete only when their declared postconditions are verified; transport, Apple Events, Accessibility or CGEvent success alone is not semantic completion.

During migration, the existing Browser public action surface remains compatible while legacy Playwright/CDP/native paths are compiled toward the V2 provider contract. No new Browser durable authority or implicit foreground fallback may be introduced.

## Testing and verification

Tests are verification evidence, not an alternate architecture authority.

- Development/task gate: typecheck + static architecture + manifest validity + affected tests.
- Main candidate: task gate + core regression + Runtime smoke.
- Release candidate: main gate + full regression + release packaging/readiness.
- Test governance validates registration, resource classification, selection and execution isolation; it does not impose arbitrary global test-line or resource-count budgets.
- Prefer a small number of architectural invariants, focused module tests and essential integration/E2E coverage. Delete implementation-coupled or retired-compatibility tests when the underlying obligation is removed.

## Documentation authority

The maintained documentation surface is intentionally small:

- [`../README.md`](../README.md) — documentation entry.
- [`../ROADMAP.md`](../ROADMAP.md) — current/next priorities.
- `CURRENT.md` — current architecture authority.
- [`EVOLUTION.md`](EVOLUTION.md) — append-only architecture change log.
- [`versions/`](versions/) — architecture snapshot created at release/version boundaries.
- [`../../CHANGELOG.md`](../../CHANGELOG.md) — release/user-visible change log.

Research notes, tasks, reviews, old architecture pages, plans and Git history are evidence/history only. They do not need to be synchronized on every source edit.

## Intentionally retained compatibility debt

- Explicit `toolset=full` remains a supported legacy compatibility boundary for now.
- Some large runtime modules still aggregate multiple responsibilities and should be decomposed only when a clear ownership boundary is available.
- CodeGraph may be structurally stale between index refreshes; current raw source and changed-file overlays remain authoritative.

These items belong on the roadmap, not in parallel current-architecture documents.
