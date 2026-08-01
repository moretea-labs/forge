# iOS Semantic Automation Provider v2

Status: implementation in progress  
Issue: `ISS-20260720-66E25D` / `T5`

## Why this redesign exists

The 2026-08-01 physical-device test produced evidence that the current integration is not merely missing a selector. The failure surface crosses executable identity, CLI contract drift, XCTest lifecycle, snapshot policy, semantic targeting, session disposition and fallback routing.

Observed facts:

- The same Mac had Homebrew `agent-device 0.19.3` and Volta `0.20.2`; different processes resolved different executables.
- `snapshot -i` is supported, while `snapshot --interactive` is not supported by the installed 0.19.3/0.20.2 CLI contracts.
- A shallow JD snapshot returned only 18 nodes and missed search. A depth-20 raw snapshot returned 204 nodes, found the SearchField and completed in about 533 ms on the warm Runner.
- Rebooting the physical iPhone restored an XCTest/DTX channel that had failed across two Xcode versions and two agent-device versions.
- CoreDevice open and screenshot remained available while XCTest UI automation was unavailable.
- A semantic fill error was redacted into an opaque generic error and the wrapper destroyed the otherwise healthy session.

## Defect ownership

### Repo Harness adapter defects

1. Exact version pinning instead of capability negotiation.
2. No executable identity or CLI-contract fingerprint in status/evidence.
3. Raw argv construction spread across workflow code.
4. Unsupported `--interactive` emitted by recovery code while the generic snapshot path used `-i`.
5. JD target discovery used a shallow default snapshot despite an App-specific tree shape.
6. Element extraction parsed formatted strings instead of structured snapshot nodes.
7. Every command error invoked `failSession`, conflating semantic misses with transport death.
8. Fill diagnostics removed provider code and all actionable redacted context.
9. App workflow, provider transport, signing, lifecycle, selector logic and MCP descriptors live in one 1,700+ line module.
10. CoreDevice facts and optional WDA UI automation form a second partially overlapping physical-device stack.

### Upstream agent-device candidates

These require upstream-source tests before a fork is justified:

- XCTest/DTX startup recovery and health probing.
- Xcode/devicectl version-specific relaunch or process termination behavior.
- Stable machine-readable fill/press error codes from the iOS Runner.
- Batch support for keyboard Return and richer capability discovery.

Repo Harness must not fork upstream to fix defects that belong in its own adapter.

## Target architecture

```text
MCP iOS actions (stable public IDs)
        |
        v
IOS Plugin Router
        |
        +-- App Adapter Registry
        |     +-- JD search semantics and snapshot policy
        |     +-- future application adapters
        |
        +-- Provider Router
              +-- AgentDeviceProvider
              |     +-- executable identity
              |     +-- capability/help fingerprint
              |     +-- typed/CLI command compiler
              |     +-- session and Runner lifecycle
              |     +-- semantic snapshot and mutation APIs
              |
              +-- CoreDeviceProvider
                    +-- paired-device facts
                    +-- app lifecycle
                    +-- screenshot evidence
                    +-- no implicit mutation fallback
```

The normal trusted path is deterministic:

```text
intent -> App capability -> compiled semantic batch -> minimal assertion -> receipt
```

No model call, screenshot analysis or complete tree dump belongs on a known warm path.

## Capability negotiation

Provider readiness is based on:

- resolved executable/configured path;
- parsed semantic version within a reviewed compatibility range;
- command help or typed contract for snapshot, fill, batch and keyboard;
- runtime compatibility before resolving the optional typed module (`agent-device@0.20.2` requires Node 22.12 or newer while Repo Harness still supports Node 20);
- a stable contract fingerprint cached with a short TTL and bound to executable, backend mode, Node runtime and PATH identity.

A preferred version is useful for support, but it is not authority. Commands are emitted only when their capability is present. Unknown future minor versions fail closed until reviewed.

## App adapters

App adapters own semantic knowledge, not provider mechanics. A search adapter declares:

- bundle ID;
- bounded discovery snapshot policy;
- stable selector candidates;
- structured-node predicates;
- submit and result assertions;
- known interruption handlers in later phases.

JD currently requires a depth-20 structured discovery because the real SearchField is nested around depth 14. Callers that supply a trusted selector skip discovery entirely.

## Session failure disposition

Command failure and session failure are different facts.

| Failure class | Session disposition |
|---|---|
| element/selector not found, stale ref, unsupported semantic action | preserve session |
| Runner/DTX/transport/device disconnect, provider session absent | terminate or reconcile session |
| timeout/cancel/unknown mutation outcome | fence as unknown; do not blindly retry |

Only provider or transport death justifies automatic session teardown. Recoverable semantic failures return redacted diagnostics with `sessionPreserved: true`.

## Evidence and privacy

- Fill text is never returned or persisted.
- Provider error code and sanitized message are retained.
- Normal success stores bounded receipt data, not every full tree.
- Failure fixtures are scrubbed and stored without account, badge or personalized product-history data.
- Screen text is data, never executable instruction.

## CoreDevice fallback

CoreDevice is the source of truth for device inventory, pairing, connection, app installation/launch and screenshot capture. When XCTest is unavailable, Repo Harness may still open an allowlisted app and capture read-only evidence. It must not imply that screenshot-only mode can perform semantic mutations.

## Upstream integration policy

Prefer the official typed `createAgentDeviceClient` surface where package deployment and versioning can be made deterministic. The current integration uses it for read-only snapshots on compatible Node runtimes. Mutations remain on the cancellable CLI process path because the typed client does not currently expose an `AbortSignal`; this preserves the unknown-outcome fence instead of trading reliability for fewer argv calls. `auto` falls back to CLI only when the optional typed module is absent, unloadable, runtime-incompatible, or its package version does not exactly match the active CLI version. Every fallback returns a bounded `backendFallbackReason` plus typed/CLI versions; a real typed provider command failure is surfaced and never hidden by backend switching.

Keep a CLI adapter for compatibility. A fork, if required, is a separate version-pinned provider package with:

- upstream commit reference;
- minimal patch set;
- differential contract tests;
- a documented removal path.

Global installations are never edited in place.

## Migration phases

1. Capability profile, command compiler, structured App adapters and failure disposition.
2. Split the monolith into provider/session/semantic/workflow modules while retaining public action IDs.
3. Introduce optional typed-client backend and differential tests against CLI.
4. Separate interaction resource identity from backend identity and converge CoreDevice fallback routing.
5. Add upstream fork only for proven lower-layer defects.
6. Re-run physical-device cold/warm benchmarks and publish p50/p95 phase evidence locally.
