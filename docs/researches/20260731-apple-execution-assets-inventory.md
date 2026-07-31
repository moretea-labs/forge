# Apple Execution Assets Inventory and Migration Boundary

Status: verified inventory contract for `ISS-20260730-84CE88:T1`  
Audited source revision: `117766591a8d5de2378667e6973832eaddafdb88`  
RC6 prerequisite: released at `2a48486b7b8c3395d05e4f30201e968ee88f9779`  
Public repository: `moretea-labs/matea`  
Audit Work: `work_7418086e28d34f799531fff8e4b320d7`

## 1. Outcome

Repo Harness already has a meaningful Apple execution surface. The next release must extend and bind that surface rather than replace it.

The current reusable foundation is:

- a live App Store Connect typed plugin with secret-safe credential-provider references and typed read/write actions;
- a live Browser plugin with CDP attach, persistent fallback, human handoff, domain restrictions, and profile modes;
- a live iOS plugin with Xcode, Simulator, CoreDevice, optional signed UI-runner, and bounded interaction actions;
- explicit authorization and strong-confirmation gates around remote or production effects.

The missing foundation is durable, repository-specific context:

- no implemented `ContextProfile`, `ContextBinding`, `ContextRequirement`, or `ContextResolution` model exists yet;
- Browser domain access is still one replaceable list rather than named additive grants;
- Browser profiles are plugin configuration, not durable repository bindings;
- iOS project discovery is root-oriented and has no bounded monorepo search contract or ambiguity result;
- Team, bundle, App Store Connect app, project, scheme, Browser profile, device, and release target are not joined into a verified reusable repository context;
- the typed delivery surface does not yet cover capabilities, signing reconciliation, archive/export/upload/processing, assets, or a resumable release orchestrator.

No plugin configuration, Browser grant, Apple account state, project file, device state, or remote App Store Connect state was changed by this audit.

## 2. Security and evidence boundary

This inventory records only bounded non-secret readiness and capability metadata.

It does not record or persist:

- private keys or key contents;
- passwords or verification codes;
- Browser cookies, login databases, or session tokens;
- App Store Connect bearer tokens;
- Apple account credentials;
- physical-device serial numbers or ECIDs;
- raw signing identities or provisioning material;
- personal device names or Apple account identifiers.

The future context system must store opaque provider/profile references and verified claims, never raw secrets.

## 3. App Store Connect assets

### 3.1 Current authority

The App Store Connect plugin is enabled, live-probed, and ready.

Its current authority is derived from:

- repository-local plugin configuration;
- process-environment credential references;
- a configured private-key path outside repository state;
- the live App Store Connect API.

The health model reports only that issuer and key identities are configured. It does not return their values.

Credential material is read from environment or a local path and is explicitly not persisted by Repo Harness.

### 3.2 Existing typed actions

The current plugin already provides typed actions for:

#### Authentication and inventory

- authentication status;
- list apps;
- list App Store versions;
- list version localizations;
- read app information;
- list app information records;
- list builds;
- list TestFlight builds;
- read build details;
- list beta groups;
- list beta testers;
- list review submissions.

#### Metadata

- preview app-information localization changes;
- apply app-information localization changes;
- preview App Store version metadata changes;
- apply App Store version metadata changes.

#### TestFlight and review

- create an App Store version;
- assign a build to a beta group;
- submit beta-app review;
- create a review submission;
- submit for review.

### 3.3 Existing policy behavior

- read-only actions require no confirmation;
- metadata remote writes require authorization;
- version creation, TestFlight assignment/review, and production review actions require strong confirmation;
- credential values are not returned in health or action manifests.

These typed actions and policies must be preserved. Future work must not create renamed duplicate actions merely because the former Campaign record is unavailable.

### 3.4 Missing App Store Connect scope

The plugin does not yet provide the complete target delivery chain:

- Developer capability inspection and reconciliation;
- entitlements cross-checking;
- certificate and provisioning-profile preflight;
- archive/export integration;
- binary upload;
- processing-state wait and resume;
- App Store asset management;
- a cross-stage release orchestrator;
- exact context/evidence linkage across local and remote stages.

## 4. Browser assets

### 4.1 Current runtime readiness

The Browser plugin is enabled and ready.

The active mode prefers Playwright CDP attach and falls back to a managed persistent browser when attach is unavailable.

Current properties include:

- visible browser windows;
- a repository-local profile mode;
- one detected CDP endpoint at inventory time;
- bounded CDP discovery timeout;
- active persistent sessions;
- human handoff support;
- Controller-owned screenshot, download, and diagnostic artifacts.

### 4.2 Existing typed actions

The Browser surface already supports:

- session creation, listing, closing, and clearing;
- page open/navigation/reload/back;
- load-state and selector waits;
- bounded text, HTML, links, tables, forms, and interactive snapshots;
- screenshots and diagnostics;
- click, focus, type, fill, selection, check, key press, and file transfer;
- human handoff request, status, and resolution.

The handoff plane is suitable for login, two-factor authentication, captcha, manual review, and sensitive confirmation. It must remain the boundary for secrets and human-only steps.

### 4.3 Current domain boundary

The Browser safety boundary is one plugin-level `allowedDomains` list.

At inventory time it contains non-Apple commerce and development domains. It does not contain Apple developer or App Store Connect domains.

The configure action can:

- replace the entire allowed-domain list;
- clear the list;
- select `repo_local` or explicit `custom` profile mode;
- assign a profile directory for custom mode.

This is not sufficient for durable Apple context because adding Apple access can accidentally replace unrelated grants.

### 4.4 Required Browser migration

Future Browser context work must add:

- named, additive domain grants;
- explicit grant removal;
- deletion impact preview;
- repository-to-Browser-profile binding;
- repository-to-grant binding;
- distinct states for browser unavailable, domain denied, profile unbound, login required, and human handoff pending;
- migration from the current list without removing unrelated domains.

Cookies, passwords, and login databases remain outside repository and ContextProfile state.

## 5. Xcode and Simulator assets

### 5.1 Live action result

A live `xcode_status` action completed successfully during this audit.

The current observed state is:

- macOS platform available;
- Xcode 27 beta selected;
- `xcodebuild` available;
- `simctl` available;
- simulator workflows reported ready;
- optional `agent-device` version 0.20.2 available.

An earlier cached manifest snapshot briefly reported `simctl` unavailable. The subsequent live action reported it available with no problems. This difference proves why future context claims need observation timestamps, provenance, validity, and targeted refresh rather than one unqualified boolean.

### 5.2 Current authority

The iOS plugin derives readiness from:

- local Xcode command-line tools;
- Simulator tooling;
- CoreDevice tooling;
- the pinned optional `agent-device` binary;
- explicit process-environment configuration;
- repository-local plugin configuration.

### 5.3 Current typed actions

Existing Xcode/Simulator actions include:

- Xcode status;
- simulator listing;
- project discovery;
- scheme listing;
- build;
- simulator boot;
- simulator screenshot;
- staged smoke review with build, install, launch, screenshot, and logs.

These actions should receive action-specific ContextRequirements rather than being replaced by a generic Apple task executor.

## 6. Project discovery and binding

### 6.1 Live repository result

A live `discover_project` action completed successfully and returned:

- no workspace;
- no Xcode project;
- no Info.plist;
- `ready = false` for repository project discovery.

This is expected for the controller-runtime repository and is not an Xcode failure.

### 6.2 Current implementation boundary

The current action discovers repository-relative:

- `.xcworkspace` paths;
- `.xcodeproj` paths;
- `Package.swift`;
- Info.plist files.

The action accepts no project root, search roots, or maximum depth arguments. The current implementation therefore does not satisfy the Program target for bounded monorepo discovery and explicit ambiguity handling.

### 6.3 Required migration

Add a bounded discovery contract with:

- optional `project_root`;
- explicit `search_roots`;
- bounded `max_depth`;
- deterministic exclusion rules;
- candidate scoring without silent selection;
- an explicit ambiguity result;
- durable repository-to-project/workspace/scheme binding;
- identity fingerprint and targeted invalidation when the project changes.

A repository with no iOS project must remain cheap to inspect and must not make global iOS plugin health fail.

## 7. Physical-device assets

### 7.1 Live CoreDevice result

A live `physical_device_status` action completed successfully.

Current observed state:

- CoreDevice provider available;
- CoreDevice command support ready;
- bounded physical-device capability available;
- optional localhost UI runner not configured.

The status intentionally omits serial numbers and ECIDs.

### 7.2 Existing capabilities

The plugin already supports typed, bounded operations for:

- paired-device inventory;
- installed-app verification by exact bundle identifier;
- application launch;
- CoreDevice screenshot;
- optional UI snapshot, press, fill, scroll, events, and close through a trusted localhost runner;
- an optional pinned signed `agent-device` XCTest path.

Sensitive input, login, verification, purchase, payment, and biometric steps remain blocked or human-only.

### 7.3 Current missing binding

Physical-device identity and preference are not durably bound to a repository/release context.

The optional UI runner is intentionally fail-closed until an explicit trusted localhost endpoint is configured.

Future context records should store only an opaque device binding and verified bounded metadata, never pairing records, signing secrets, serial numbers, or raw runner credentials.

## 8. Historical App Store Connect Campaign

### 8.1 Projection still listed

`CMP-20260723-0FFA4F`, titled `Ship durable App Store Connect plugin`, still appears in the bounded Campaign listing as a paused/waiting-for-supervisor historical projection.

The listing reports historical task counts and a former worktree reference.

### 8.2 Durable record unavailable

Both the full Campaign read and its review packet failed because the durable Campaign record no longer exists.

Therefore:

- the Campaign cannot be resumed safely;
- its listed worktree path is not an execution authority;
- its task counts cannot prove implementation or completion;
- it must not be used as the sole source for Apple scope;
- it must not be recreated as a duplicate Campaign.

### 8.3 Classification

The correct classification is:

> Historical projection unavailable for execution; target intent is reconstructable from current typed plugins, the Reliability Program Charter, and `ISS-20260730-84CE88`.

The projection may remain for historical audit until a bounded migration/cleanup mechanism explicitly archives it. It should not be revived.

## 9. Context foundation inventory

A source audit found no implemented runtime types or stores named:

- `ContextProfile`;
- `ContextBinding`;
- `ContextRequirement`;
- `ContextResolution`;
- `ContextCapsule`.

Those concepts currently exist only in the Program documentation.

Consequently T2 is a real new foundation, not a migration of a hidden existing context database.

It must still reuse existing authorities:

- plugin configuration and live plugin health;
- explicit action arguments;
- repository project observations;
- Xcode/CoreDevice observations;
- WorkContract and Evidence Plane references;
- Browser human handoff;
- current authorization and resource-claim policies.

## 10. Reuse versus implement matrix

### Reuse unchanged

- App Store Connect credential-provider mechanism;
- App Store Connect typed read actions;
- metadata preview/apply actions;
- TestFlight and review typed actions;
- Browser CDP attach and persistent fallback;
- Browser human handoff;
- Browser typed interaction actions;
- Xcode/Simulator typed actions;
- CoreDevice and optional signed-runner actions;
- existing authorization and strong-confirmation classes;
- Controller-owned bounded artifacts.

### Extend compatibly

- plugin health claims with provenance/freshness;
- repository-to-plugin/profile bindings;
- Browser domains into named additive grants;
- Browser profile selection into durable repository bindings;
- project discovery into bounded monorepo discovery;
- device preference into opaque durable binding;
- action definitions with ContextRequirements;
- Work/evidence records with context fingerprints.

### Implement new

- versioned ContextProfile store;
- versioned ContextBinding store;
- action-level ContextRequirement registry;
- bounded ContextResolution;
- transient redacted Context Capsule;
- claim kind, verification, confidence, timestamps, validity, provenance, and input fingerprints;
- conflict and precedence rules by field/action/risk;
- targeted invalidation and last-known-good preservation;
- capability/signing reconciliation;
- archive/export/upload/processing/assets workflows;
- resumable Apple Release Orchestrator.

### Do not implement

- a second credential store containing raw Apple secrets;
- a generic Apple task that bypasses typed actions;
- automatic production submission without immediate human authorization;
- a revived duplicate of the unavailable Campaign;
- an unbounded repository scan;
- silent conflict resolution for Team, bundle, app, signing, or release identity.

## 11. T2–T9 execution boundary

### T2 — ContextProfile and binding persistence

Start with additive, versioned, atomic records for:

- credential-provider reference;
- Team;
- App Store Connect app;
- Browser profile;
- Browser grant set;
- project/workspace/scheme;
- bundle identity;
- device preference;
- release target.

Failed writes must not replace last-known-good records.

### T3 — Browser grants and profile bindings

Migrate the current list into named grants without changing effective access. Add previewable impact before removal.

### T4 — monorepo project discovery

Implement bounded search and ambiguity. Do not block repositories with no iOS project.

### T5 — ContextRequirements and resolver

Declare only the fields each action needs. Simulator-only actions must remain independent of App Store Connect context.

### T6 — evidence and continuation

Bind context fingerprints and verification to Work, exact-revision evidence, receipts, and handoff without adding a parallel workflow system.

### T7 — capabilities and signing

Add preview, authorization, reconciliation, post-apply verification, and rollback/repair evidence.

### T8 — delivery stages

Add archive, export, upload, processing wait, assets, TestFlight, metadata readiness, and submission preparation as resumable typed actions.

### T9 — orchestrator

Compose the typed stages. Keep irreversible production submission behind a fresh explicit human authorization decision.

## 12. Immediate next safe action

T2 may begin after this inventory is verified.

Its first implementation slice should be limited to:

1. additive schema/types;
2. atomic profile/binding persistence;
3. secret-shape rejection and redaction tests;
4. backward-compatible empty-state behavior;
5. read/preview/write actions for non-secret bindings;
6. no Browser, Xcode project, or App Store Connect remote mutations yet.

This slice establishes durable identity without coupling all Apple actions at once.

## 13. T1 acceptance traceability

- RC6 and the audited source revision are recorded.
- App Store Connect typed actions and credential-provider readiness were inventoried without secret values.
- Browser, Xcode, Simulator, project discovery, CoreDevice, and optional UI-runner states are distinguished.
- `CMP-20260723-0FFA4F` is classified as an unavailable historical projection whose intent is reconstructable, not resumable.
- Reuse, extension, new implementation, and prohibited duplication boundaries are explicit.

## 14. T1 conclusion

The Apple execution substrate is not missing. The missing piece is durable, verified context and the remaining typed delivery chain.

The next-release implementation rule is:

> Bind and verify existing typed capabilities before adding new ones; never rebuild working plugins from stale Campaign intent, never store secrets in context state, and never let a convenient explicit argument silently override conflicting high-risk repository identity.
