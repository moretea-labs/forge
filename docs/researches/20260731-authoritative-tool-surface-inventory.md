# Authoritative MCP Tool Surface Inventory and Exposure Contract

Status: verified inventory contract for `ISS-20260730-B55445:T1`  
Audited source revision: `d17d21c4a58fab7c985350f209dec36c1974801e`  
Active runtime release observed during inventory: `4808fc3cd2a4d75d65b427c0d54458366d31c3aa`  
Public repository: `moretea-labs/matea`  
Initial read-only Work: `work_0c41797e873f49d7b0774c44a61eecfd`  
Continuation Work: `work_616708eb6c134fba8e283e2488058119`

## 1. Decision

Repo Harness currently has three accepted MCP toolset labels but only two distinct exposed schemas:

- `core` exposes the 133-tool stable controller surface;
- `advanced` exposes the same 133-tool stable controller surface;
- `full` exposes the complete 262-tool registered compatibility surface.

Core and Advanced have the same ordered-name fingerprint:

```text
1a0c2549e180b9f346b082708142c0fe89a92716c2d0a7fae53afa158bc8042d
```

Full has this ordered-name fingerprint:

```text
91dc1c6ad86179ae2fdba6ee19923b0422faf11252452d708eee045a7bf3f75f
```

All three runtime snapshots were internally coherent:

- no missing expected tools;
- no unexpected tools;
- no duplicate names;
- `ready = true`.

The next release must not treat Core, Advanced, or Full as permission levels.

Request versus Full Access remains an authorization policy choice.

Toolset labels remain schema compatibility labels until the MCP transport can load capability schemas on demand.

The five preferred `rh_*` facade tools are a presentation and orchestration preference, not a separate hidden permission tier and not currently a five-tool `tools/list` profile.

## 2. Scope and evidence boundary

This inventory accounts for the public MCP schema and its source-generation path.

It does not change:

- tool registration;
- tool routing;
- authorization policy;
- plugin manifests;
- Browser or iOS configuration;
- repository access mode;
- runtime state;
- remote services.

The audit used:

- source inspection;
- the live `controller_capabilities` response;
- direct construction of `controllerExposureSnapshot` for Core, Advanced, and Full;
- existing profile contract tests;
- runtime handler inspection for deprecated and retired operations.

No credential, token, cookie, login database, private key, or secret-valued environment state is recorded here.

## 3. Terminology

### 3.1 Registered tool

A registered tool is one `McpToolDefinition` present in the combined Controller definition registry before profile filtering.

### 3.2 Stable tool

A stable tool is a registered tool whose name appears in `STABLE_CONTROLLER_TOOL_NAMES` or is one of the five preferred facade tools from `FACADE_TOOLS`.

The stable set is the current Core and Advanced schema.

### 3.3 Full-only tool

A Full-only tool is a registered tool that is not in the stable set.

Full-only does not automatically mean deprecated.

A Full-only tool may be:

- an active specialist capability;
- an administrative capability;
- an experimental capability;
- a compatibility entrypoint;
- a historical read path;
- a structured rejection endpoint for a retired operation.

### 3.4 Facade tool

A facade tool is one of:

```text
rh_access
rh_status
rh_inbox
rh_context
rh_work
```

These names are authoritative in `src/runtime/control-plane/facade/types.ts`.

### 3.5 Capability descriptor

A capability descriptor is a semantic record in the facade capability registry.

It describes:

- domain;
- capability group;
- operation class;
- risk;
- facade exposure;
- schema exposure mode.

Capability descriptors are not a second tool-name allowlist.

### 3.6 Retired operation

A retired operation is an exposed schema whose handler intentionally returns a structured deprecation or migration error instead of performing the former effect.

Retirement may apply to only some operations in a tool family.

## 4. Exact observed profiles

### 4.1 Core

Observed count:

```text
133
```

Observed fingerprint:

```text
1a0c2549e180b9f346b082708142c0fe89a92716c2d0a7fae53afa158bc8042d
```

Observed semantics:

- identical ordered names to Advanced;
- includes all five facade tools first;
- includes repository, Git, Work, Issue/Task, Campaign, plugin, Browser, iOS, evidence, recovery, maintenance, and Process Runtime typed tools;
- does not represent a minimal facade-only schema.

### 4.2 Advanced

Observed count:

```text
133
```

Observed fingerprint:

```text
1a0c2549e180b9f346b082708142c0fe89a92716c2d0a7fae53afa158bc8042d
```

Observed semantics:

- canonical stable Controller schema;
- default normalized Controller toolset;
- schema-stable across Request and Full Access modes;
- identical to Core for compatibility.

### 4.3 Full

Observed count:

```text
262
```

Observed fingerprint:

```text
91dc1c6ad86179ae2fdba6ee19923b0422faf11252452d708eee045a7bf3f75f
```

Observed semantics:

- all registered definitions after duplicate-name normalization;
- contains the entire 133-tool stable set;
- contains 129 additional specialist, compatibility, administrative, experimental, and historical definitions;
- remains callable and testable as a compatibility/debug surface;
- is not suitable as the default static ChatGPT schema because of size and legacy breadth.

### 4.4 Set invariants

The current set equations are:

```text
Core = Stable
Advanced = Stable
Stable ⊂ Full
|Stable| = 133
|Full| = 262
|Full - Stable| = 129
```

The next implementation must preserve these equations until a reviewed migration explicitly changes them.

## 5. Authoritative source hierarchy

The authoritative hierarchy is ordered. Lower layers must not redefine higher-layer meaning.

### 5.1 Facade identity authority

Source:

```text
src/runtime/control-plane/facade/types.ts
```

Authority:

- `FACADE_TOOLS`;
- facade result and suggestion types;
- capability domains;
- capability groups;
- operation classes;
- risk vocabulary;
- schema-exposure vocabulary.

### 5.2 Registered definition authority

Sources:

```text
src/runtime/gateway/mcp/runtime-tools.ts
src/runtime/gateway/mcp/execution-tools.ts
src/runtime/gateway/mcp/process-tools.ts
src/cli/mcp/access-tools.ts
src/cli/mcp/repository-tools.ts
src/cli/mcp/multi-repository.ts
```

Authority:

- actual `McpToolDefinition` objects;
- input schemas;
- descriptions;
- annotations;
- runtime handlers;
- dynamically built multi-repository tools.

The combined definition registry is the authority for Full.

A source grep is not authoritative because several definitions are generated by builders rather than direct literals.

### 5.3 Stable membership authority

Source:

```text
src/cli/mcp/toolset-names.ts
```

Authority:

- `PREFERRED_FACADE_TOOL_NAMES`, derived from `FACADE_TOOLS`;
- `STABLE_CONTROLLER_TOOL_NAMES`;
- `DEFAULT_CONTROLLER_TOOL_NAMES`.

The stable list is currently explicit and ordered.

It is not generated from prefixes.

### 5.4 Profile filtering and fingerprint authority

Source:

```text
src/cli/mcp/toolset.ts
```

Authority:

- Core and Advanced stable aliases;
- Full unfiltered behavior;
- definition deduplication;
- missing/unexpected/duplicate detection;
- ordered-name fingerprint;
- `controllerExposureSnapshot` readiness.

### 5.5 Semantic capability authority

Source:

```text
src/runtime/control-plane/facade/capability-registry.ts
```

Authority:

- semantic capability descriptors;
- facade-to-capability relationships;
- category-level invocation coverage;
- stable static versus plugin-manifest schema exposure.

The observed registry contains 18 capability descriptors.

### 5.6 Routing authority

Sources:

```text
src/runtime/gateway/mcp/router.ts
src/runtime/gateway/mcp/runtime-tools.ts
src/runtime/gateway/mcp/execution-tools.ts
src/runtime/gateway/mcp/process-tools.ts
```

Authority:

- handler ownership;
- resource claims;
- authorization classification;
- active behavior;
- structured deprecation behavior.

A name appearing in `tools/list` is insufficient to infer that every former effect remains active.

## 6. Exhaustive accounting rule

All 262 tools are accounted for by generation, not by maintaining a second prose list.

The accounting algorithm is:

1. Build every definition array and dynamic definition builder.
2. Concatenate the resulting definitions in registry order.
3. Deduplicate by exact tool name, preserving first occurrence.
4. Report duplicate names as a validation failure.
5. For Full, expose every unique registered definition.
6. For Core and Advanced, filter the registry by the stable membership set.
7. Report any stable name without a matching definition as missing.
8. Report any exposed non-stable name in a stable profile as unexpected.
9. Compute the ordered-name fingerprint.
10. Validate category and lifecycle metadata separately from name membership.

This rule accounts for:

- direct definitions;
- builder-generated definitions;
- compatibility aliases;
- active specialist tools;
- historical read tools;
- structured retirement endpoints.

A generated inventory artifact may enumerate every name, but the source of truth remains the definition registry plus stable membership and lifecycle metadata.

## 7. Capability categories

The semantic capability categories are defined by the facade capability registry, not by profile names.

Current groups are:

```text
controller
repository-core
git
issue-task
campaign
browser
ios
plugin
evidence
runtime-maintenance
```

Each group may contain multiple atomic tools and one or more facade routes.

### 7.1 Controller

Includes Controller status, context, handoff, Work execution, and orchestration behavior.

### 7.2 Repository core

Includes repository selection, inspection, safe read/write, and command execution primitives.

### 7.3 Git

Includes status, diff, branch, commit, merge, and workflow finalization operations.

### 7.4 Issue and Task

Includes Issue planning, readiness, dispatch, verification, acceptance, and change requests.

### 7.5 Campaign

Includes retained Campaign read/control compatibility and migration behavior.

Campaign capability presence does not imply new Campaign creation remains active.

### 7.6 Browser

Includes typed Browser plugin discovery and invocation through plugin capabilities and retained web helper tools.

### 7.7 iOS

Includes typed iOS plugin operations and retained stable simulator/smoke helpers.

### 7.8 Plugin

Includes plugin inventory, manifests, typed action execution, and toolchain summaries.

Plugin actions are loaded from plugin manifests; they must not each become permanent static top-level MCP definitions.

### 7.9 Evidence

Includes results, artifacts, checks, exact-revision evidence, and status digests.

### 7.10 Runtime maintenance

Includes bounded recovery, maintenance, self-healing, watchdog, and runtime verification operations.

## 8. Exposure lifecycle classes

The next release must attach lifecycle metadata to definitions or a generated inventory record.

The required lifecycle classes are:

### 8.1 `facade`

Preferred orchestration entrypoints.

Current members are the five `rh_*` tools.

### 8.2 `stable_typed`

Atomic typed tools intentionally exposed in Core and Advanced.

They remain callable even when a facade can orchestrate them.

### 8.3 `full_extension`

Active specialist or administrative tools exposed only by Full.

They are not deprecated merely because they are omitted from Stable.

### 8.4 `compatibility_active`

Older names or surfaces retained because callers still depend on their active behavior.

They must have an owner and migration target where applicable.

### 8.5 `historical_read`

Tools retained to inspect historical state after write/dispatch paths have been retired.

### 8.6 `deprecated_operation`

A tool family remains present, but one or more operations return a structured deprecation result.

The lifecycle record must name the affected operations.

### 8.7 `retired_rejecting`

The exposed entrypoint intentionally performs no former effect and always returns a bounded structured migration error.

### 8.8 `plugin_manifest`

The top-level static schema exposes plugin inventory and action execution; domain actions are described by plugin manifests.

### 8.9 `internal_only`

Handlers, stores, helpers, and capability implementation units that are not public MCP tools.

Internal entries must never enter Stable or Full inventory merely because their function names resemble tool names.

## 9. Current retirement and compatibility findings

### 9.1 Goal loop

The Full schema still contains Goal and provider definitions.

The following effectful operations are currently intercepted and return `GOAL_LOOP_DEPRECATED`:

```text
goal_create
goal_start
goal_continue
goal_tick_once
executor_dispatch
repair_continue
```

The structured response points callers to PlanContract, WorkContract, Controller claim/launcher, and handoff flows.

Other operations in the same family may still provide bounded historical reads, status, stop/finalize, handoff packet, provider health, configuration status, or route preview.

Therefore the Goal family must not be classified as wholly active or wholly retired.

Lifecycle is operation-specific.

### 9.2 Campaign

Campaign definitions remain visible in Stable and Full for compatibility.

When Campaign automation deprecation is enabled:

- `create_campaign` returns `CAMPAIGN_DEPRECATED`;
- `add_campaign_task` returns a structured retirement result;
- `resume_campaign` is similarly blocked;
- historical listing, reads, review packets, and bounded control paths remain available where supported.

Campaign migration points to PlanContract and WorkContract execution.

Campaign presence in Stable is therefore a compatibility contract, not proof that all creation or automation effects remain active.

### 9.3 Legacy workflow and repository helpers

Full includes legacy workflow-file, PRD, sprint, local-job, repository-admin, project-governance, GitHub, schedule, portfolio, assistant, DeepSeek, and review-packet tools.

These definitions require per-family classification.

They must not be removed solely because a facade or newer Work flow exists.

Removal requires:

- usage evidence;
- an explicit migration target;
- structured deprecation first;
- a compatibility window;
- Full profile E2E proving the remaining surface.

## 10. Duplicated membership and drift risks

### 10.1 Stable name list versus definition registry

Sources:

```text
src/cli/mcp/toolset-names.ts
all definition-builder sources
```

Risk:

- a new definition can be omitted from Stable unintentionally;
- a removed definition can remain as a missing stable name;
- manual ordering can drift from expected presentation.

Required control:

- generated diff;
- missing/unexpected/duplicate validation;
- reviewed stable-membership changes.

### 10.2 Facade list duplication

Primary source:

```text
src/runtime/control-plane/facade/types.ts
```

Observed duplicate literals also appear in runtime response construction.

Risk:

- facade order or membership can diverge between capability responses and exposure filtering.

Required control:

- import `FACADE_TOOLS` everywhere;
- prohibit literal five-tool copies in production code.

### 10.3 Capability-cache `CORE_TOOL_NAMES`

Source:

```text
src/cli/mcp/tool-capability-cache.ts
```

Current hard-coded set:

```text
rh_context
rh_access
work_submit
work_get
work_list
controller_ready
```

This set is used for capability grouping, not tools/list filtering.

Risk:

- the word `core` collides with the Core profile label;
- contributors may mistake six cache-group names for the Core schema;
- `rh_status`, `rh_inbox`, and `rh_work` are not in this set even though all are preferred facades.

Required control:

- rename the concept to a semantic group such as `controller-bootstrap` or derive it from capability descriptors;
- never use it for profile membership.

### 10.4 Restart smoke lists

Source:

```text
src/cli/mcp/restart.ts
```

Current lists differ by legacy Core/Advanced label even though the profiles expose identical schemas.

Risk:

- Core and Advanced can pass different smoke tests despite identical exposure;
- Full inherits the Advanced smoke subset and does not prove Full-only availability.

Required control:

- derive restart smoke requirements from capability descriptors and profile invariants;
- add a Full-only sentinel or category probe;
- keep smoke small but semantically representative.

### 10.5 Setup and type comments

Sources:

```text
src/cli/mcp/types.ts
src/cli/mcp/setup.ts
```

Current prose still describes Core as a minimal facade/bootstrap schema.

Actual Core is the same 133-tool schema as Advanced.

Risk:

- users select Core expecting a small schema;
- maintainers implement against obsolete documentation;
- access mode and schema exposure become conflated again.

Required control:

- update prose only after the authoritative generated inventory exists;
- state that Core is a legacy alias unless a future reviewed small schema is implemented.

### 10.6 Access-mode compatibility mapping

Source:

```text
src/cli/mcp/access-mode.ts
```

Current behavior:

- legacy `core` maps to Request mode when no explicit access mode exists;
- legacy `advanced` and `full` map to Full Access;
- persisted access changes normalize the compatibility toolset to `advanced`;
- schema is stable across access modes.

Risk:

- callers may still assume changing toolset changes permissions;
- historical configuration labels can be misread as current security policy.

Required control:

- keep access state and exposure state in separate fields;
- never infer current permissions from a profile fingerprint.

### 10.7 Router operation sets

Source:

```text
src/runtime/gateway/mcp/router.ts
```

Risk:

- routing/resource-claim sets can drift from definition lifecycle classification;
- a retired tool can remain in active dispatch sets;
- an active tool can bypass expected category coverage.

Required control:

- validate every exposed definition has one handler owner and one lifecycle record;
- validate retired-rejecting operations cannot reach former effect handlers.

### 10.8 Tests with copied expectations

Sources include:

```text
tests/cli/mcp-tool-exposure-profiles.test.ts
tests/cli/mcp-controller.test.ts
tests/cli/connector-freshness.test.ts
tests/cli/mcp-setup.test.ts
tests/cli/mcp-restart-process-ownership.test.ts
```

Risk:

- tests can preserve obsolete semantics instead of detecting them.

Required control:

- generate expected profile snapshots from one inventory module;
- keep only independent invariants and high-value sentinels in tests.

## 11. Fingerprint contract

### 11.1 Current fingerprint

The current profile fingerprint hashes ordered exposed tool names joined with newline.

It detects:

- membership changes;
- ordering changes.

It does not detect:

- input-schema changes;
- description changes;
- annotation changes;
- lifecycle changes;
- capability-category changes;
- handler ownership changes.

### 11.2 Required fingerprints

The next implementation must expose at least:

```text
nameFingerprint
schemaFingerprint
lifecycleFingerprint
capabilityFingerprint
sourceRevision
```

`nameFingerprint` remains compatible with the current value.

`schemaFingerprint` must hash a deterministic normalization of:

- name;
- input schema;
- annotations;
- stable ordering.

`lifecycleFingerprint` must hash:

- lifecycle class;
- affected operations;
- migration target;
- deprecation state.

`capabilityFingerprint` must hash semantic capability descriptor ownership.

### 11.3 Fingerprint invariants

- Core and Advanced name fingerprints remain equal while they expose the same names.
- Full name fingerprint differs because it is a strict superset.
- Access-mode changes do not change schema fingerprints.
- Plugin health changes do not change static MCP schema fingerprints.
- Adding a plugin action changes the plugin manifest fingerprint, not the static top-level tool fingerprint.
- A profile fingerprint is always recorded with a source revision and inventory schema version.

## 12. Generation contract

The authoritative inventory module introduced in T2 must generate a deterministic record for every registered tool.

Each record must contain:

```text
name
sourceOwner
handlerOwner
profiles
exposureClass
capabilityGroup
operationClass
riskClass
schemaExposure
lifecycleClass
migrationTarget
```

Optional fields include:

```text
deprecatedOperations
replacementTools
compatibilityUntil
notes
```

Generation rules:

1. Definition registry is authoritative for existence.
2. `FACADE_TOOLS` is authoritative for facade identity.
3. Stable membership is explicit and reviewed.
4. Full membership is every unique registered definition.
5. Capability registry is authoritative for semantic group ownership.
6. Lifecycle metadata is explicit; prefixes are fallback diagnostics only.
7. No inventory record may exist without a registered definition unless marked `retired_removed` in a migration manifest outside `tools/list`.
8. No registered definition may lack an inventory record.
9. Duplicate names fail generation.
10. Unknown lifecycle or capability ownership fails strict CI for Stable and warns for newly added Full-only experimental tools until classified within the same change.

## 13. No-capability-loss invariants

### 13.1 Stable preservation

Every Stable tool at the start of a migration must remain:

- present;
- schema-compatible or explicitly versioned;
- routable;
- authorization-classified;
- represented by a capability category;
- covered by at least one invocation or structured-retirement test.

### 13.2 Full preservation

Every Full-only active or compatibility tool must remain callable until one of these occurs:

- it moves into Stable;
- it becomes structured-deprecated;
- its compatibility window expires under an approved removal contract.

A tool must never disappear because a manually copied list was regenerated incorrectly.

### 13.3 Retired behavior preservation

A retired-rejecting tool remains valuable during migration because it gives callers an actionable replacement.

It must not silently become `METHOD_NOT_FOUND` before the compatibility window ends.

### 13.4 Permission independence

Changing Request versus Full Access may change approval behavior.

It must not change:

- tools/list membership;
- profile fingerprint;
- capability inventory.

### 13.5 Plugin independence

A repository without Browser, iOS, or App Store Connect readiness still receives the stable static schema.

Plugin readiness affects action availability and health, not the existence of `list_plugins`, `get_plugin`, or `plugin_action_execute`.

### 13.6 Transport limitation

Until dynamic domain schema loading is supported, Stable must retain typed atomic tools needed for reliable direct invocation.

The project must not fake a five-tool schema by hiding capabilities that the client cannot dynamically reload.

## 14. Validation contract

### 14.1 Build-time validation

CI must prove:

- unique registered names;
- unique stable names;
- every stable name resolves to a definition;
- Core equals Advanced while the alias contract is active;
- Stable is a strict subset of Full;
- facade tools are first and in canonical order;
- every definition has lifecycle and capability ownership;
- every retired effect path returns a structured migration result;
- generated inventory is clean.

### 14.2 Profile snapshot validation

For each profile, record:

- count;
- ordered names;
- name fingerprint;
- schema fingerprint;
- lifecycle fingerprint;
- missing names;
- unexpected names;
- duplicates;
- readiness.

### 14.3 Category-level invocation E2E

Stable category E2E must exercise at least one safe operation from:

- facade/controller;
- repository core;
- Git read;
- Issue/Task read;
- evidence/check read;
- plugin inventory;
- Browser or plugin manifest discovery;
- iOS or plugin manifest discovery;
- recovery/maintenance read.

Full category E2E must additionally exercise:

- one active Full-only specialist operation;
- one historical read path;
- one structured-retirement path;
- one administrative preview/read path.

The E2E target is callability and correct policy behavior, not unrestricted mutation.

### 14.4 Restart smoke

Restart smoke must verify:

- five facade tools;
- repository bootstrap/selection;
- Controller capabilities;
- one Process Runtime tool;
- one profile-specific sentinel;
- current profile fingerprint.

Full restart smoke must prove at least one Full-only tool is present.

### 14.5 Connector freshness

Connector freshness must compare:

- current runtime fingerprint;
- Connector-visible names when supplied;
- expected facade names;
- profile label;
- tool-surface version.

A stale Connector is a schema synchronization problem, not evidence that the underlying capability was removed.

## 15. Current contract tests to preserve

`tests/cli/mcp-tool-exposure-profiles.test.ts` currently proves the strongest profile invariants:

- stable uniqueness;
- stable count budget at or below 133;
- presence of Process Runtime tools;
- exact facade order;
- Core equals Advanced;
- Full is larger;
- representative capabilities exist in all profiles;
- snapshot expected and actual names match;
- no missing, unexpected, or duplicate names;
- fingerprint shape;
- legacy labels do not hide tools;
- Controller defaults to Advanced.

These tests remain valuable but should consume a generated inventory rather than remain the only explanation of the product contract.

## 16. Migration sequence

### T2 — Build the generated inventory

Implement one deterministic inventory module from the definition registry, stable membership, facade constants, capability registry, and lifecycle metadata.

Do not change exposed names.

### T3 — Derive profile exposure and fingerprints

Make Core, Advanced, and Full snapshots consume the generated inventory.

Preserve exact observed name sets in the first migration.

### T4 — Remove duplicated membership semantics

- rename or replace capability-cache `CORE_TOOL_NAMES`;
- derive restart sentinels from capability groups;
- remove literal facade copies;
- update obsolete setup/type prose;
- keep access policy separate from schema.

### T5 — Unify execution through `rh_work`

Converge orchestration without deleting atomic typed tools.

Retired paths must return structured migration errors.

### T6 — Add capability-category E2E

Prove Stable and Full callability, restart behavior, Connector freshness, and policy independence.

### T7 — Performance and cold-start closure

Measure:

- tools/list serialization;
- schema payload size;
- capability cache behavior;
- Gateway cold start;
- Connector refresh latency.

Optimization must not remove callable capabilities.

## 17. Explicit non-goals

T1 does not authorize:

- shrinking Stable;
- deleting Full-only tools;
- changing Request or Full Access policy;
- making Core a five-tool schema;
- replacing typed plugin actions with a generic shell tool;
- reviving retired Goal or Campaign automation;
- exposing every plugin action as a top-level static MCP tool;
- treating prefixes as authoritative lifecycle metadata;
- accepting a count-only test as proof of capability preservation.

## 18. Acceptance traceability

### Every registered and compatibility tool is accounted for

The combined definition registry produces 262 unique Full tools.

Stable membership selects 133 of those definitions.

The remaining 129 are Full-only and must receive generated lifecycle/capability records.

Dynamic builders are included by runtime generation, avoiding static-grep omissions.

### Duplicated sources are identified

The contract identifies:

- definition builders;
- stable name list;
- facade constants and literal duplicates;
- capability-cache core set;
- restart smoke lists;
- setup/type prose;
- access compatibility mapping;
- router operation sets;
- copied test expectations.

### Profile invariants are frozen

Core and Advanced remain identical 133-tool stable aliases.

Full remains the complete 262-tool compatibility surface.

Profiles remain independent of authorization mode.

### Advanced and Full remain callable

The contract requires generated inventory validation, profile fingerprints, category-level invocation E2E, structured retirement behavior, and a Full-only restart sentinel.

### Public and secret safety

The document contains public source paths, public repository identity, commit identifiers, Work identifiers, counts, and non-secret fingerprints only.

## 19. Conclusion

Repo Harness does not currently suffer from an unknown tool count.

It suffers from multiple partially overlapping meanings of “Core,” “capability,” “stable,” “compatibility,” and “available.”

The correct convergence is not to hide tools first.

The correct convergence is:

1. generate one authoritative inventory from actual definitions;
2. attach explicit semantic and lifecycle metadata;
3. preserve the exact 133/133/262 schemas during migration;
4. eliminate duplicated membership logic;
5. prove category-level callability;
6. only then consider a reviewed smaller static schema when the transport can load domain capabilities without loss.

The release invariant is:

> Schema convergence may reduce duplication and payload, but it must never silently remove a callable capability, turn a retired migration response into an unexplained missing method, or couple permissions to tool visibility.
