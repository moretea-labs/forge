# External Plugin and Provider Governance

Status: architecture-reviewed for phased implementation  
Source baseline: `9269defb536a79d78d1630d95736eaaf9fa9be56`  
Scope: Forge plugin control plane, external provider integration, sibling repository governance, and open-source release boundaries

## Problem

Forge has a strong first-party plugin contract but still resolves adapters from a static in-process map:

```text
FIRST_PARTY_PLUGIN_ADAPTERS
  -> PLUGIN_ADAPTERS
  -> AssistantPluginManifest
  -> plugin_action_execute
```

That model works for JavaScript/TypeScript adapters shipped with Forge, but it does not support independently released native or product-scale providers without compiling their implementation into Forge.

Two existing sibling repositories make the missing boundary concrete:

- `repo-harness-desktop-operator`: a clean independent Swift/macOS service with Accessibility observation, semantic UI actions, screenshots, batch execution, sessions, and Unix-socket JSONL transport. Its architecture intentionally expects an External Plugin Broker that Forge does not yet implement.
- `repo-harness-design`: an independent design asset/product boundary with deterministic JSON assets, CLI/local API, validation, and an intended future controller adapter.

Keeping these implementations independent is desirable. Keeping `repo-harness-*` product names, incompatible registration descriptors, duplicated static adapters, and disconnected runtime integration is not.

## Goals

1. Keep Forge core responsible for plugin policy, lifecycle, registration, health projection, action risk/confirmation, resource claims, execution receipts, and host-facing facade integration.
2. Allow independently released providers to implement platform-native or product-specific behavior without importing Controller private source.
3. Preserve the current first-party adapter path while introducing a deterministic external-provider path.
4. Make Desktop Operator the first end-to-end external provider acceptance target and Design the second.
5. Standardize product repository naming and public identity before open-source publication.
6. Make legacy Repo Harness/Matea identifiers explicit migration inputs only, never new authorities.
7. Define one measurable completeness standard for every plugin, whether in-process or external.

## Non-goals

- Do not dynamically download arbitrary plugins from ChatGPT requests.
- Do not let a model supply arbitrary executable paths, sockets, shell commands, or registration files.
- Do not create another Forge Runtime, scheduler, daemon authority, or rollout slot.
- Do not move all external provider source into the Forge repository.
- Do not delete legacy runtime/worktree/recovery directories until their authority and unique-state status is proven safe.
- Do not rename the current GitHub `moretea-labs/matea` remote until an authenticated repository-rename operation is available and the target `moretea-labs/forge` identity can be proven.

## Current facts

### Forge plugin contract

`AssistantPluginManifest` already provides the host contract required by the broker:

- stable `pluginId`, provider, display name, and plugin version;
- derived single source-of-truth declaration;
- lifecycle and health;
- permission scopes;
- capabilities;
- typed actions;
- read-only/write/destructive risk;
- confirmation requirements;
- resource claims;
- bounded arguments schema.

The missing piece is adapter discovery/transport, not a replacement manifest model.

### Current authority namespaces

Current source uses Forge authorities for active configuration:

- App Store Connect: `.forge/plugins/app-store-connect.json`, `FORGE_ASC_*`;
- Browser: `.forge/plugins/browser.json`, `.forge/browser/`;
- GitHub: `.forge/plugins/github.json` plus Repository Registry GitHub identity;
- Gmail/Calendar/Tasks: `.forge/plugins/...`, `FORGE_*_ACCESS_TOKEN`;
- iOS: `.forge/plugins/ios.json`, `FORGE_IOS_DEVICE_RUNNER_URL` plus local Xcode/CoreDevice/agent-device facts;
- Desktop Operator: trusted external registration under Controller Home plus the stable signed macOS app identity;
- Local System: Controller Home `system/local-system`.

App Store Connect intentionally retains `.repo-harness/plugins/app-store-connect.json` as a named `legacy-read-fallback`. This is an acceptable migration pattern and must not become a new write authority.

### Runtime integration gap

`src/runtime/plugins/store.ts` currently initializes one static `PLUGIN_ADAPTERS` map from `createFirstPartyPluginAdapterMap()`. External registration descriptors are not loaded.

## Decision: Forge core + independently released providers

Use the following ownership split:

```text
ChatGPT / Local UI
      |
Forge facade + plugin policy
      |
Assistant Plugin Store
      |
Plugin Adapter Resolver
  +---+-----------------------+
  |                           |
Built-in adapters       External Plugin Broker
  |                           |
TS/JS implementation    trusted registration
                              |
                    typed transport adapter
                              |
                  external provider process/service
```

Forge remains the policy and completion authority. External providers only perform the bounded domain operation described by their registered contract.

## Repository naming policy

Current and future product repositories use the Forge namespace:

- core: `forge`
- macOS desktop provider: `forge-desktop-operator`
- design product/provider: `forge-design`
- future independent providers: `forge-<provider>`

`repo-harness-*` names are legacy identities. They may temporarily survive as filesystem symlinks, Git redirects, migration aliases, or historical/legal references, but must not be the canonical name of a newly published Forge product.

Sibling provider repositories remain peers of the Forge repository rather than children of `/forge/projects`:

```text
DevProjects/
  forge/
  forge-desktop-operator/
  forge-design/
```

This gives each provider a clean release/history/dependency boundary and avoids coupling its build system to Forge.

## External registration authority

External providers are not discovered by scanning arbitrary folders.

Canonical registration state lives under Controller Home, for example:

```text
<controller-home>/system/plugins/external/
  registrations/<plugin-id>.json
  index.json
```

A registration is written only by a trusted installation/configuration workflow. ChatGPT can read registered providers and execute declared actions but cannot choose an unregistered executable/socket.

Provider repositories may ship an install-time descriptor template, but that repository file is not runtime authority until installation validates and copies its bounded registration into Controller Home.

## Registration schema v1

A registration must include:

- schema version;
- plugin ID and display name;
- provider ID/version;
- plugin contract version;
- scope: controller or repository;
- transport kind;
- stable installed identity;
- expected protocol version/range;
- manifest acquisition method;
- health method;
- lifecycle ownership;
- state ownership;
- registration revision/fingerprint;
- optional legacy migration identities.

Transport v1 supports:

1. `unix_socket_jsonl` for long-lived native providers such as Desktop Operator;
2. `managed_cli_json` for trusted bounded one-shot product providers such as Forge Design and Personal Knowledge Assistant;
3. `localhost_http_json` remains deferred until a provider genuinely needs it.

Do not add a generic shell transport.

## Broker responsibilities

The External Plugin Broker must:

1. load only trusted Controller Home registrations;
2. validate registration schema and protocol compatibility;
3. derive an `AssistantPluginManifest` from the provider manifest plus Forge policy;
4. verify that provider action IDs/capabilities are stable and internally consistent;
5. map action risk, confirmation, and resource claims into the existing Plugin Store execution path;
6. use bounded request/response sizes and deadlines;
7. support cancellation where the provider protocol supports it;
8. enforce idempotency/request IDs at the Forge layer regardless of provider implementation;
9. redact errors and never return transport secrets/absolute private internals by default;
10. fail closed on missing/mismatched provider identity;
11. project health truthfully as ready/degraded/error rather than silently falling back to a weaker implementation;
12. retain Forge Work/evidence receipts as the canonical execution record.

## Desktop provider decision

The independent Swift Desktop Operator becomes the primary `desktop` capability provider once broker acceptance is complete.

Do not duplicate the full Accessibility/session/screenshot/batch implementation in Forge TypeScript.

The current bundled `desktop` helper remains a bounded bootstrap/fallback implementation during migration. The transition is explicit:

```text
Phase 0: bundled desktop helper is canonical
Phase 1: external Desktop Operator can register and report health/manifests
Phase 2: selected desktop actions route to external provider
Phase 3: full desktop action surface routes externally; bundled helper retained only as documented fallback or retired
```

The provider must expose, at minimum:

- status/doctor;
- session open/close;
- application/window observation;
- semantic element press;
- typed text entry;
- keyboard shortcuts;
- URL opening;
- screenshot capture;
- bounded batch execution.

macOS TCC trust remains attached to the stable installed user-service identity. Forge does not attempt per-click TCC bypasses.

## Design provider decision

`forge-design` remains a separate product/repository. The public `design` provider is installable through the official pinned catalog and uses `managed_cli_json` without becoming Controller source. Its deterministic design assets and CLI/API are product authority.

Forge integration should expose bounded design context/read/validate/edit/render actions through the broker or a thin repository adapter, not duplicate design storage or rendering logic in Forge.

Migration of `.design-harness` to a Forge-branded asset directory is a product compatibility decision and must have an explicit migration/read-fallback strategy; do not mass-rename existing repositories without it.

## Namespace migration rules

### Current authorities

New writes use only Forge namespaces:

- `.forge/...`
- `FORGE_*`
- `~/Library/Application Support/forge/...`
- `~/Library/Caches/forge/...`
- `forge-*` product/repository names.

### Legacy fallbacks

A legacy Repo Harness/Matea identity may remain only when all are true:

1. the code labels it as legacy/migration compatibility;
2. it is read-only unless the migration operation itself is explicitly running;
3. the current Forge authority is preferred;
4. health/status can report its use;
5. tests cover migration precedence;
6. there is a documented retirement condition.

Never add a new compatibility alias without a migration reason.

## Plugin completeness standard

Every first-party or external plugin receives a matrix with these gates:

| Gate | Required evidence |
| --- | --- |
| Identity | Forge-branded stable ID/display name/version |
| Authority | one current source of truth; legacy fallbacks explicitly named |
| Configuration | configure/read-status path; missing external config reported as pending/degraded |
| Health | real probe; ready must mean executable action path is usable |
| Read actions | focused unit/integration tests |
| Write actions | confirmation/risk/resource-claim tests and dry-run/preview where applicable |
| Idempotency | duplicate request ID cannot execute twice |
| Cancellation/timeout | bounded failure behavior |
| Secrets | never returned/persisted in raw form |
| E2E | at least one real local/remote acceptance path when external dependency is available |
| Fault tests | unavailable/malformed/timeout/protocol mismatch paths |
| Documentation | current configuration, permissions, troubleshooting, lifecycle |
| Open-source surface | no personal path, raw credential, stale product identity, or runtime artifact |

A plugin blocked only by credentials/device/service availability is marked `configuration_pending`/degraded with a clear remediation. It is not considered an implementation failure when its code path and tests are complete.

## Test strategy

Add a plugin-governance test layer that checks invariants across all registered first-party adapters and external registrations:

- unique plugin IDs;
- canonical Forge display identities where Forge-branded;
- action IDs unique per plugin;
- capability actions all exist;
- action scopes declared by permissions;
- readOnly/risk consistency;
- destructive actions require strong confirmation;
- no external provider registration uses arbitrary shell execution;
- current authority does not write legacy namespaces;
- manifests remain bounded and serializable.

Add fault/property-style tests for broker registrations and transports:

- malformed registration rejected;
- protocol version mismatch rejected;
- socket absent => degraded/unavailable, not fallback success;
- truncated/oversized response rejected;
- duplicate request ID executes once;
- timeout/cancellation closes transport and leaves no live Work lease;
- provider crash cannot mark Work completed;
- registration replacement is revision/fingerprint checked;
- uninstall/disable is idempotent.

## Repository governance and migration

Do not rename/delete sibling directories directly with unbounded shell commands.

For each provider repository:

1. register it with Forge;
2. inspect Git status, branches, remotes, unique commits, build/test state;
3. commit internal Forge-brand migration first;
4. create/rename remote when available;
5. use a typed local project move/registry migration capability to change the filesystem path;
6. update Controller Registry and any trusted external registration atomically;
7. keep a temporary compatibility symlink only if an installed service/script still needs the old path;
8. remove the alias only after zero-reference verification.

Runtime/recovery/worktree directories are governed separately and are never treated as ordinary provider repositories.

## Phase 1: broker foundation + Desktop Operator

1. Define external registration types and Controller Home store.
2. Add resolver composition: built-in adapter first by explicit provider selection, external registration path without changing host MCP tool count.
3. Implement Unix-socket JSONL broker transport with bounded request/response/deadline semantics.
4. Add external adapter that maps provider manifest/actions into `AssistantPluginManifest`.
5. Add read-only list/get health support before action execution.
6. Register Desktop Operator through a trusted test/installation registration.
7. Route a non-destructive status/observe action end-to-end.
8. Add write action policy tests for press/type/screenshot/batch without bypassing normal Forge confirmation rules.
9. Run real macOS E2E when the registered Desktop Operator build/service is available.
10. Retire the bundled Desktop helper after the external Desktop Operator is healthy; do not retain a second desktop authority.

### Phase 1 acceptance

- External providers appear through existing `list_plugins/get_plugin` surfaces.
- No new top-level MCP tools are required.
- Missing provider service yields truthful degraded health.
- Broker cannot execute an unregistered provider path.
- Desktop status/observe can run through the external transport.
- action policy remains owned by Forge.
- provider request IDs are idempotent and bounded.
- Controller restart rebuilds external provider projection from Controller Home authority.
- no second Forge Runtime is introduced.

## Phase 2: repository/product migration

### Desktop Operator

Target identity:

- repository/directory: `forge-desktop-operator`
- product name: `Forge Desktop Operator`
- current state root: `~/Library/Application Support/forge/desktop-operator`
- current cache/socket root: `~/Library/Caches/forge/...`
- descriptor/schema names: Forge-branded

Legacy state/descriptor paths are migrated explicitly. Installed TCC identity must remain stable across migration; path/signature changes require a reviewed migration plan before changing the live service.

### Design

Target identity:

- repository/directory: `forge-design`
- product name: `Forge Design`

Preserve its independent Git/product boundary. Integrate only through stable contract/API surfaces.

## Phase 3: all-plugin completeness matrix

Audit and close every built-in plugin:

- Browser: Chrome/Vivaldi attach, ownership/reuse, DOM/native capability matrix, failure paths, real E2E.
- Local System/Desktop Operator: unregistered target operations, background-safe application control, external Desktop provider, destructive-path safeguards.
- iOS: simulator, agent-device, CoreDevice, physical runner configuration/E2E.
- App Store Connect: auth/read/preview/write policy and remote-write guarded E2E.
- GitHub: canonical Forge remote identity after repository rename; issue/project read/write acceptance.
- Gmail/Calendar/Tasks: auth/config migration, read/write policy, configuration-pending semantics, connected-account E2E when configured.

## Architecture review

Review result: approved for phased implementation.

Reasons:

- It uses the existing plugin manifest/policy model rather than inventing a second host contract.
- It preserves independent native/product release boundaries where they are valuable.
- It removes static-adapter coupling without enabling arbitrary plugin execution.
- It aligns repository naming and state namespaces with the open-source Forge identity.
- It makes external configuration gaps explicit rather than conflating them with missing functionality.
- It provides a concrete first acceptance target (Desktop Operator) and a second product-scale target (Design).

Rejected alternatives:

1. Move Desktop Operator and Design into the Forge monorepo: rejected because their independent native/product release boundaries are useful and coupling would increase build/release complexity.
2. Keep every external provider as an ad-hoc static adapter: rejected because it recreates Controller-private coupling and prevents independent releases.
3. Scan sibling folders for plugin descriptors: rejected because filesystem discovery is not a trusted runtime authority.
4. Generic command/executable plugin transport: rejected because arbitrary executable control is too broad and weakens policy/audit guarantees.
5. Mechanical global rename of all `.repo-harness`/Repo Harness strings: rejected because legal attribution, historical evidence, and explicit read-only migrations are distinct from current product identity.
