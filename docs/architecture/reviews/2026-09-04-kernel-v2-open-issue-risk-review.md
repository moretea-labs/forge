# Kernel V2 open-issue architecture risk review — 2026-09-04

Status: **interim architecture review, not an implementation plan**

Source baseline: `kernel-v2/architecture@734c16cac008d7f56813b8eb2c70a1861f8401c3`

This review re-reads the currently open Forge issues as architecture evidence against the in-progress Kernel V2 design. It intentionally does **not** implement or close the issues. The purpose is to prevent old feature requests, migration plans, and operational bugs from pulling the V2 migration back toward duplicate authority or product-specific code in the core. Re-run this review against the final V2 candidate before deciding which residual issues still need implementation.

## Executive verdict

The current Kernel V2 direction remains sound: domain-first modular monolith, one mutable authority per durable fact/lifecycle, transport sessions as replaceable delivery state, provider-neutral contracts in `packages/plugin-runtime`, concrete mechanisms in adapters, and compatibility paths that must have explicit removal conditions.

The remaining issues should **not** be processed as one FIFO implementation backlog. They fall into four groups:

1. **Must constrain V2 now:** #129.
2. **Must influence V2 contracts/final acceptance, but not trigger broad feature work now:** #125, #55, #141.
3. **Defer implementation until V2 is structurally complete:** #159, #161, #45, #48-#52.
4. **Do not treat as Kernel functionality:** #118 and similar site/application workflows. #118 is functionally present on this source line, but its current hard-coded recipe shape is architecture evidence that workflow data is in the wrong layer.

Issue #162 is a tracking mechanism, not architecture authority. It must not force implementation merely to reduce the open count.

## V2 invariants used by this review

The final V2 should preserve these boundaries:

- `packages/kernel/*`: durable domain semantics only. Work, Controller, Scheduler, Resources, Identity and Execution are not provider implementations.
- `packages/plugin-runtime/*`: provider-neutral capability, dispatch, resource, receipt and provider-selection semantics.
- `packages/protocols/*`: transport/provider-neutral wire contracts.
- `adapters/*`: MCP, Browser/ChatGPT host mechanics, tunnel/OAuth, OS host integration and concrete provider mechanisms.
- Runtime/app composition roots may wire concrete ports, but must not become business-semantic owners.
- A transport session, browser tab, provider process, compatibility record, projection, diagnostic snapshot or baseline receipt cannot become a second durable semantic authority.
- Repository identity is execution placement, not semantic Work/Controller identity.

## Issue-by-issue review

### #129 — P0 controller/recovery commands remain repo-coupled; MCP session loss can strand recovery

**Disposition: MUST SHAPE V2 NOW.**

This issue is not merely an old reliability defect. Current source still proves the boundary violation:

- `runMcpSetupChatgpt({ userLevel: true })` computes `resolveMcpRepoRoot(...)` before selecting Controller Home;
- `runMcpDoctor()` still resolves a repo root and repo-preferred Controller Home;
- MCP session lifetime has explicit close reasons (`idle_ttl`, `stream_lease`, `absolute_lifetime`, capacity eviction, shutdown, etc.), while durable Work/Process identity is intended to survive those transport replacements.

The required V2 correction is architectural, not a retry patch:

1. Controller-global bootstrap/status/setup/recovery/plugin-global operations must have a true controller scope with **zero repository prerequisite**.
2. MCP session identity is a replaceable transport lease. It may cache delivery state but cannot own Work, Process, ControllerRound or recovery authority.
3. A reconnect/reinitialize path must rebind transport to existing durable identities instead of creating new semantic work.
4. Primary connector loss and Recovery reachability must not share the same practical failure domain. Recovery may observe and repair the canonical Runtime, but must not become a second Runtime/Controller authority.
5. Diagnostics should compose independent layers: session, auth, connector/tunnel, gateway, Runtime, repository. A single generic `Session terminated` or `ready` boolean is insufficient.

This should be resolved before declaring V2 structurally complete because later plugin, scheduler and continuation work all depend on this scope boundary.

### #125 — Windows Runtime reports ready while OpenAI Secure MCP Tunnel is disconnected

**Disposition: CONTRACT NOW, IMPLEMENT/VERIFY AT V2 CANDIDATE.**

Current code already has a useful adapter-level `OpenAiSecureTunnelRuntimeObservation` with independent `running`, `healthy`, `ready`, tunnel identity and endpoint matching. Recovery also probes OpenAI Secure Tunnel runtime state. The missing architectural piece is not “teach Kernel how tunnel-client works.” It is the aggregation contract.

V2 should explicitly separate:

- local Runtime readiness;
- local gateway/OAuth readiness;
- external connector readiness;
- Controller delivery readiness.

The OpenAI polling process, profile path, API-key reference and platform lifecycle stay in the MCP/tunnel adapter/Recovery mechanism. Kernel should consume bounded readiness evidence, not own tunnel-client lifecycle semantics.

Do not collapse these layers into a new global `ready` authority. An overall status view may derive a user-facing state from them, but the underlying observations remain independently attributable.

The issue also asks for last successful OpenAI control-plane polling evidence. That is provider telemetry and should be surfaced through the adapter observation/receipt, not persisted as Kernel semantic state.

### #55 — Process admission/start latency above baseline

**Disposition: INSTRUMENTATION CONTRACT NOW; OPTIMIZATION LATER.**

The current Process Runtime already has the right V2 direction: explicit Ephemeral Direct, Lightweight Managed and Durable lanes. The issue reports fixed admission/spawn overhead without a demonstrated concurrency-correctness regression.

V2 should therefore avoid redesigning concurrency or widening locks to chase an old aggregate number. Instead, the final Execution contract should expose bounded phase timing for the parts that already exist conceptually:

`resolve -> route -> admit -> persist(if durable) -> claim/lease -> runner handoff -> spawn -> handshake -> completion/receipt`

Those timings are evidence, not a second scheduler. After the V2 candidate stabilizes, re-run the benchmark with enough iterations and optimize the measured hot phase. If V2 intentionally changed semantics, update the baseline only with phase-level evidence.

### #141 — Stable Baseline gate

**Disposition: FINAL V2 ACCEPTANCE CONCERN, NOT PER-SLICE IMPLEMENTATION.**

A separate self-host operational baseline is architecturally valid. Package release correctness and “this installed Forge instance is safe to use as the next autonomous-development baseline” are different questions.

Current `scripts/check-stable-baseline.ts` is only partial. It checks Runtime readiness/release coherence and Recovery connector verification, then writes a receipt. It does not yet cover the issue's full lifecycle debt, pending-handoff, real controller/connector E2E, restart/crash survival or source-baseline requirements.

The important V2 constraint is that a Stable Baseline receipt remains an **immutable evidence snapshot**, not a new mutable control-plane authority. It must derive from the existing installed-release, Controller Home, Work/Process, Recovery and connector authorities. `latest.json` may be a convenience projection, never the authority for whether old Work or releases exist.

Do not run this heavy operational gate after every V2 slice. Run it at integrated candidate/baseline activation boundaries, consistent with the existing V2 delivery cadence.

### #159 — Windows host wake and WSL network diagnostics

**Disposition: DEFER IMPLEMENTATION.**

The proposed `src/runtime/standalone-recovery/wsl-host.ts` does not exist on this source baseline. More importantly, this is an OS-host integration feature, not a missing Kernel domain.

Retain only these constraints for later:

- Windows host wake may trigger the exact canonical WSL installation but must not become a second Runtime, watchdog, Scheduler or Recovery authority;
- exact distro/Controller Home identity must fail closed;
- diagnostics are bounded/redacted observations, not network/proxy authority;
- host wake belongs in an OS adapter/bootstrap mechanism around the canonical Runtime/Recovery services.

Implement after V2 when the canonical bootstrap/recovery contracts are final, otherwise the feature risks freezing migration-era Runtime/Recovery APIs.

### #161 — bind continuations to ChatGPT Project

**Disposition: DEFER FEATURE; CORRECT THE PROPOSED DOMAIN MODEL BEFORE IMPLEMENTATION.**

Current durable ChatGPT Work binding persists repo/work/binding/conversation/browser-session fields and has no project identity, so the feature is genuinely absent.

However, the issue's proposed chain:

`Requirement/Work -> ChatGPT Project -> Conversation -> Browser Session/Tab -> Controller Round`

should **not** become a Kernel semantic dependency chain. ChatGPT Project is provider-specific placement/provenance, analogous to a provider conversation/container identifier. A better final model is:

`Work/Controller -> ControllerBinding(adapterRef)`

and the ChatGPT adapter's binding payload contains verified placement such as:

`projectId + conversationId + browserSession/tab delivery state`.

Project membership may be durable adapter provenance, but it must not redefine Requirement/Work identity or make the Kernel understand ChatGPT UI organization. The provider adapter must verify stable project identity and fail closed on ambiguous placement.

Revisit after the final ControllerBinding/Identity API is stable.

### #118 — Xiaohongshu live recipe contract smoke

**Disposition: FUNCTIONALLY PRESENT; ARCHITECTURE SMELL TO REVISIT AFTER V2. DO NOT EXPAND THIS PATTERN.**

Current source already contains commit `4a3cab5a` in ancestry and `src/runtime/plugins/xiaohongshu-publish.ts` has recipe version 8, a read-only live contract smoke, Creator success/note-manager verification and fail-closed preflight. So the concrete requested preflight is substantially present even though the issue remains open.

The more important finding is architectural: the Forge source currently contains a large first-party Xiaohongshu plugin with site URLs, selector constants, recipe versions and an application-specific publish state machine. That means ordinary Creator-page drift can require a Forge source patch and Runtime rollout.

That is the wrong long-term default for V2.

The preferred post-V2 layering should be:

1. **Browser / Computer capability layer, typed code:** stable generic operations such as session/target identity, navigate, query, wait, fill, upload, screenshot, bounded interaction, authorization, receipts and failure semantics.
2. **Provider layer, typed mechanism:** Chrome/CDP/Apple Events/Desktop Operator/etc. Provider quirks and ephemeral handles live here.
3. **Recipe/workflow layer, runtime data:** site/app selectors, navigation steps, prompts, expected page contracts, verification predicates, recipe versions and reusable scripts. These should normally be user/controller runtime data or an independently versioned recipe package, not Forge Kernel source.
4. **Domain adapter code only when justified:** a real product/API semantic boundary may deserve typed code. A sequence of website selectors and button presses generally does not.

A recipe executor still needs hard safety invariants: typed allowed actions, bounded loops/timeouts, explicit remote-write confirmation, sensitive-operation blocks, deterministic receipts and fail-closed verification. Moving recipes out of source must not mean arbitrary shell/JavaScript or ungoverned prompt execution.

This issue is the strongest evidence for the rule: **new site-specific workflows must not automatically become new first-party Forge plugins.**

### #45 and #48-#52 — physical iPhone program

**Disposition: DEFER ALL FEATURE IMPLEMENTATION UNTIL V2 IS COMPLETE.**

The #47 migration baseline is useful architecture evidence and should remain as a constraint, not a signal to continue T10-T14 now.

Retain these principles only:

- `ios-development` build/test/simulator concerns remain separate from physical-device automation;
- a physical-device provider must use generic plugin/provider contracts rather than inventing another protocol;
- one exact physical device must have one resource/mutation authority across CoreDevice/XCTest/other engines;
- signing/WDA/tunnel/session daemons must not become Kernel lifecycle state;
- app-specific JD navigation should not be embedded in Kernel/Controller code simply because the device provider exists;
- the old `package:check:controller-v8` acceptance entries are migration-era stale checks and must not be resurrected merely to satisfy these issues.

After V2, re-evaluate whether `ios-device` should be an independently released provider repository/product, what belongs in generic Computer/Device protocols, and what remains recipe/runtime data.

### #162 — 64-issue convergence supervisor

**Disposition: TRACKER ONLY.**

Do not let the tracker become an architecture or delivery authority. Under the current review policy its useful role is inventory: remember which historical issues still need a final V2-candidate decision.

The new rule should be: once V2 reaches candidate state, re-read each residual issue against the final module/authority implementation and choose `already fixed`, `superseded/not planned`, `still valid`, or `externally blocked`. Open-count reduction is not a reason to implement migration-era features now.

## Browser / Computer specific V2 findings

Browser is one area where issue-driven work may continue during V2 because its architecture is already part of the V2 migration.

### Keep

- Browser session durable authority in Controller Home SQLite through a provider-neutral persistence port.
- Stable provider target identity separated from mutable URL/title/observations.
- One-way legacy import with tombstones/fail-closed behavior instead of two writable session stores.
- Generic Browser actions and bounded provider transactions.
- Computer target authority that owns stable desktop application identity independently of an ephemeral Desktop Operator interaction/session id.

### Change before V2 is final

`src/runtime/plugins/computer-registration.ts` is still a migration-era composition point: non-desktop Computer actions directly call the concrete `browser-adapter`, while desktop actions resolve the external Desktop provider. The behavior is coherent, but final V2 should not leave provider/composition routing as concrete adapter-to-adapter knowledge inside a legacy `src/runtime/plugins` owner.

Final placement should make the relationship explicit through a provider-neutral Computer/Browser port or an app/composition root. The stable public façade may remain `computer`, `browser`, or both for product ergonomics, but one capability must not acquire a second session/target authority simply because another façade delegates to it.

### Do not add

- site-specific publish/search/login workflows as Kernel or generic Browser semantics;
- URL/title matching as durable target identity;
- coordinate-only mutation fallbacks without fresh ref/target evidence;
- provider-specific durable session stores;
- silent fallback that launches/replaces a browser when a bound user/session target is lost.

## Final V2 candidate review checklist

Before resuming the deferred issues, re-run this document against the final V2 source and answer:

1. Can Controller setup/status/recovery execute with no repository selection at all?
2. Can MCP session replacement occur without changing Work/Process/ControllerRound identity?
3. Are Runtime, connector, Recovery and delivery readiness independently observable instead of flattened into one boolean?
4. Does Execution expose phase timings sufficient to diagnose #55 without redesigning locks/scheduling?
5. Is Stable Baseline an immutable derived receipt rather than a new mutable authority?
6. Does Browser have exactly one durable session authority and Computer exactly one durable target authority?
7. Is Browser/Computer provider routing expressed through final V2 ports/composition rather than legacy concrete adapter coupling?
8. Are site/app workflows represented as runtime recipe data by default, with typed capability/safety boundaries in code?
9. Are ChatGPT Project/conversation identifiers adapter placement provenance rather than Kernel semantic identity?
10. Can the iOS issues be re-planned against final generic plugin/device contracts without importing their old migration structure wholesale?

Only after those answers are based on the final V2 implementation should the remaining feature/plugin issues be implemented, superseded, or closed.
