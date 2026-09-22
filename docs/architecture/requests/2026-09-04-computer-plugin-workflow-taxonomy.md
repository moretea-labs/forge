# Computer / Plugin / Workflow taxonomy convergence

> **Status**: Pending
> **Detected**: 2026-09-04
> **Requirement**: `REQ-forge-v2-durable-agent-harness-foundation-20260902`
> **Predecessor plan**: `PLAN-kernel-v2-module-authority-computer-convergence-20260903-r2`
> **Captured successor draft**: `PLAN-kernel-v2-module-authority-computer-workflow-convergence-20260904-r3`
> **Source revision reviewed**: `18490210a328fac2c4585ee4f2d43771dec19d3d`

## Why this request exists

The existing V2 Computer convergence plan already covers the important Computer-side architecture: `computer` as the single normal public interaction product, Browser/Desktop semantic namespaces, one durable interaction ownership graph, provider-only native Desktop Operator semantics, Process Runtime resource authority, and `outcome_unknown -> observe/reconcile`. It does **not** yet make the higher-level Plugin taxonomy or runtime Workflow model an explicit executable architecture boundary.

Current source proves the gap: `src/runtime/plugins/first-party-registry.ts` registers Computer, Browser, true API integrations and the Xiaohongshu publishing flow through the same `AssistantPluginAdapter` abstraction. `src/runtime/plugins/xiaohongshu-publish.ts` is a compiled Browser workflow: it owns site URLs, selectors, visible-text anchors, publish modes, auth/page-state classification, ordered Browser actions and post-publish verification, then executes the actual steps through the Browser capability. That is workflow content, not an independent plugin/provider authority.

## Required taxonomy

V2 must explicitly distinguish four concepts even if compatibility transport still exposes `plugin_action_execute`:

1. **Capability**: reusable semantic operation Forge can request.
2. **Provider**: replaceable implementation of one or more capabilities.
3. **Integration**: external-system owner justified by an independent protocol/auth/security/persistence/lifecycle boundary. Platform branding alone is insufficient.
4. **Workflow / Recipe**: user-goal composition of capabilities. Site-specific URLs/selectors/visible-text/page-state/verification sequences belong here unless a real Integration boundary exists.

`Plugin` must not remain the only internal taxonomy. A shared tool/manifest transport does not grant equal authority semantics.

## Computer boundary that must be preserved

- `computer` remains the single normal public interaction product.
- Browser and Desktop remain distinct semantic subdomains beneath Computer.
- Browser DOM/CDP/navigation/query/file-input semantics are preferred when stronger than physical input.
- Desktop Operator/native macOS is provider/device-driver only: OS/TCC/socket/handshake/capture/input/live handles. It does not own Forge workflows, policy, durable lifecycle, semantic completion, scheduling or independent retry/reconciliation.
- Browser session/Computer target state converges under one deliberate durable interaction ownership graph in Controller Home. Provider/browser/OS handles remain rebuildable observations.
- Non-idempotent mutations never blind-replay after `outcome_unknown`; existing observe/reconcile authority remains canonical.
- Process Runtime claims/leases remain the only execution concurrency authority.

## Computer hot-path transport contract

The 2026-09-09 #200 latency review proved that the native Desktop Operator is not the dominant warm-path cost, so provider transport optimization must preserve the existing authority boundary rather than introduce another controller or durable provider session. The Computer runtime therefore uses the following transport contract:

- one live Desktop Operator provider binding is scoped to the current trusted registration identity/revision and endpoint contract;
- provider identity/capability negotiation is reused only while the same Unix-socket connection generation remains live;
- sequential Computer requests may reuse that bounded JSONL channel instead of reconnecting and handshaking for every action;
- registration fingerprint/revision or endpoint-contract change disposes the old provider binding before replacement;
- if the Unix connection changes after negotiation, the pending action is rejected before dispatch and the next explicit invocation must renegotiate; non-idempotent effects are never replayed automatically;
- timeout, cancellation, response-size and protocol-error bounds remain per request; transport reuse creates no new durable lifecycle or retry authority.
- Browser semantic mutations do not pay an unconditional fixed post-action sleep: provider primitives and bounded post-action identity/evidence are the normal completion path; `post_action_wait_ms` is explicit compatibility input only, while native foreground activation may retain a provider-specific verification budget because system foreground authority must be observed.
- Desktop target-bound semantic actions dispatch through the current leased provider binding without a `desktop_status(limit: 500)` preflight. Only an explicit provider `SESSION_NOT_FOUND` transported as a failed/pre-effect result may rebuild the binding from stable application identity and retry once; transport, timeout, and outcome-unknown failures are never replayed. Target close likewise calls the bound session close directly instead of enumerating provider sessions first.
- Desktop observe/input/capture product actions use the retained `ComputerProvider` channel instead of re-entering the legacy external-adapter transport for every semantic action. Target open/close remain low-frequency provider lifecycle operations; the hot path owns no parallel durable provider-session authority.
- the external Unix JSONL and `ComputerProviderError` failure contracts preserve `failed` versus `outcome_unknown` across adapter boundaries. A provider-declared failure keeps the negotiated connection alive; transport loss after an effectful request is dispatched invalidates negotiation and is never eligible for implicit replay.

The repeatable `benchmark:computer-hotpath` run on 2026-09-09 used 50 warm semantic samples after five warmups. The isolated real dispatch path measured cold first semantic action `4.398ms`; warm `p50=0.939ms`, `p95=1.511ms`, `max=1.894ms`. Across the 50 warm samples the provider observed exactly 50 semantic RPCs, zero new connections, zero handshakes, zero manifest preflights, zero `desktop_status` preflights, and zero session reopens. This benchmark is comparative evidence, not a machine-specific release threshold.

This is a transport/runtime optimization beneath the existing Computer authority. Browser/OS handles remain ephemeral observations, and Process Runtime plus existing unknown-outcome reconciliation remain authoritative for execution concurrency and effect recovery.

## Workflow Asset Contract

Introduce the smallest generic versioned Workflow Asset model needed to move user-goal automation out of Core. Human-editable assets include:

- workflow definition / step composition;
- prompt guidance for semantic judgement;
- deterministic helper scripts;
- templates/selectors/resources;
- asset version and content digest.

Machine authority is separate and records only what the runtime must trust/decide, including installed/active workflow identity/version/digest, capability grants/bindings, and bounded execution receipts/checkpoints. Prompt/script bodies are not the primary SQLite authority.

Default active user workflow assets belong under Controller Home, not the Forge source repository or arbitrary target repositories. Project-owned workflow assets are allowed only through an explicit project contract and remain project data. Secrets are referenced through existing secret/authorization authority; workflow files must not become a new secret store.

## Workflow Runtime boundary

The Workflow Runtime is a thin interpreter/composer, **not another Kernel**. It may validate inputs, resolve assets and capabilities, order steps, record subordinate checkpoints/receipts, and request reconciliation. It must not create competing authority for:

- Requirement / Work / ControllerRound lifecycle;
- semantic acceptance or goal completion;
- scheduler continuation;
- retry decisions after unknown external outcome;
- process/resource locking.

Durable or external-effect workflow execution is subordinate to an existing Work/run identity. Scripts execute only through existing Process Runtime, policy and resource-claim boundaries.

## Xiaohongshu migration proof

Use Xiaohongshu publishing as the first bounded migration proof after Computer/plugin taxonomy convergence:

- remove compiled first-party workflow authority from `src/runtime/plugins/xiaohongshu-publish.ts`;
- express publish modes, Browser actions, auth markers, selectors, checkpoints and dual verification as versioned workflow data;
- do not recreate the same platform-specific TypeScript under `packages/workflow-runtime`;
- any temporary `xiaohongshu` plugin/action compatibility alias is translation-only, owns no workflow state, has bounded consumers and an explicit removal trigger.

If a future official Xiaohongshu API creates a true protocol/auth/resource boundary, only that protocol-facing owner becomes an Integration. User-goal orchestration remains Workflow.

## Architecture gates

Extend the existing architecture checker with ownership-aware rules so new business/site workflows cannot quietly return to Kernel/Computer/provider/first-party integration code. The gate must reject end-user workflow orchestration embedded in generic layers unless an independent Integration boundary is explicitly justified, while still allowing legitimate endpoint/protocol constants inside a real Integration adapter. Prefer import/manifest/ownership rules over brittle string bans.

Workflow asset digest/version changes must invalidate stale binding/receipt reuse. Compatibility shims must have a named replacement owner, bounded consumers and removal trigger.

## Required execution order

Do **not** start a parallel V2 implementation from this request. Preserve the predecessor plan order and execute only after current overlapping V2 Stage8/final-certification/portability work is reconciled:

1. Stage B: shrink module/legacy ownership debt and strengthen existing architecture gates.
2. Stage C: finish Controller/MCP/composition convergence.
3. Stage D: finish Computer/Browser/Desktop convergence **and** make Capability/Provider/Integration taxonomy explicit.
4. Stage E: add Workflow Asset Contract + thin Workflow Runtime + Xiaohongshu migration + anti-regression gates.

Before implementation starts, refresh exact source revision and active path ownership. Never open a second Computer/Workflow plan merely to bypass an occupied or stale scope.

## Plan metadata blocker discovered while capturing this request

The decision-complete successor was persisted as draft `PLAN-kernel-v2-module-authority-computer-workflow-convergence-20260904-r3`, with the four stages and detailed acceptance criteria above. Forge incorrectly persisted its `scopeKey` as `unknown`, so approval is blocked. Creating a successor with the intended scope `kernel-v2-module-authority-computer-convergence-20260903` is also blocked because the scope index still reports terminal predecessor `...-r1` as owner even though r1 already points to r2 and r2 was superseded during successor creation.

This is a Forge Plan authority/index defect, not permission to create a parallel scope. Future V2 mainline must first repair/reconcile the stale scope owner + draft scope-key persistence, then approve/recreate the captured successor under the original scope. Do not delete this request until an approved successor PlanContract with the correct scope exists.

## Completion criteria for this request

This architecture request may be marked complete only when:

- one approved successor PlanContract under the original Computer-convergence scope contains the taxonomy, Workflow Asset, runtime authority and Xiaohongshu migration decisions above;
- predecessor/draft Plan metadata is reconciled with no duplicate active authority;
- later implementation proves the Stage D/E boundaries and their focused architecture/type/main checks;
- `docs/architecture/CURRENT.md` is updated **after** the implementation is true, not before;
- obsolete public Browser/workflow-plugin compatibility authority is removed or bounded with an explicit removal trigger.
