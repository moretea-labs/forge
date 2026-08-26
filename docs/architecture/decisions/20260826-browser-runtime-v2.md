# Browser Runtime V2: unified authority and provider transactions

Status: accepted migration architecture
Date: 2026-08-26

## Decision

Forge Browser converges on one controller-owned Browser Runtime. The public `browser` plugin action names remain stable during migration, but provider-specific workflows are internal implementation details.

The durable source of truth for Browser sessions is Controller Home SQLite. A provider may keep an ephemeral live handle, cache, socket connection, CDP session, Apple Events reference, or Accessibility element reference, but it must not maintain a second durable Browser-session authority.

A Browser session separates **stable target identity** from **mutable observed state**. The identity names the exact provider resource (for example a Chrome window/tab identity or a managed page identity). URL and title are observations of that resource and may change without invalidating the session. This applies to supported browser-internal resources such as `chrome://bookmarks/`: changing an internal route or query parameter is not a new tab identity.

## Capability ladder

The Runtime selects providers by declared capability rather than by catching one provider failure and falling through a long chain. Capabilities include DOM read, DOM interaction, browser-internal resources, screenshot/vision, trusted physical input, foreground authority, provider transaction execution, and persistent handle reuse.

Preferred order is capability-driven:

1. persistent DOM/CDP/extension/native background capability for normal web work;
2. typed browser-internal-resource capability for bookmarks/tabs/downloads/history-like browser resources where supported;
3. screenshot/vision only when DOM/resource APIs are insufficient;
4. Accessibility/physical input only for operations that cannot be expressed above;
5. foreground physical input only when the selected capability explicitly declares `explicit_required`.

Foreground activation is never a hidden fallback side effect. If a provider cannot satisfy an operation without foreground authority, it returns that capability requirement to the Runtime; the controller then chooses an explicit foreground/handoff path or another provider.

## Provider transaction

Browser interactions use a provider-local transaction:

`precondition -> action -> postcondition -> bounded evidence`

The provider performs these phases in one RPC whenever it declares `browser.transaction`. Transport success, Apple Events success, `AXPress == .success`, or successful CGEvent injection are execution facts only. They do **not** make the Browser action successful unless the configured postcondition is also satisfied.

A transaction binds the stable target identity, required capabilities, replay safety, foreground requirement, timeout, action, and verification predicates. Non-idempotent actions are never retried by the Runtime after an ambiguous result unless the provider supplies a transaction/deduplication identity proving that replay is safe.

## Session and handle lifecycle

Controller Home stores the durable BrowserSession record. Providers return ephemeral handles that may be cached for bounded consecutive actions. The Runtime revalidates the stable target identity when a handle is stale or after provider restart. It does not rediscover every provider on every action when a live compatible handle already exists.

Provider restart may invalidate an ephemeral handle but not the controller session. Rebind uses exact stable resource identity and fails closed if exact-target fencing cannot be restored. User-owned resources are never silently substituted, navigated, closed, or replaced merely to recover a session.

Desktop Operator remains a controller-scoped execution provider. Its generic desktop session store is not Browser session truth.

## Browser-internal resources

Generic top-level navigation may remain HTTP(S)-only for the public web-navigation actions. Browser-internal resources are represented through typed provider capability, not by weakening the generic URL boundary. Native/adopted Chrome or Vivaldi targets can therefore model internal resources without conflating `chrome:`/`vivaldi:` with ordinary network navigation.

## Performance and round-trip budgets

V2 targets the common warm path at one provider call after session resolution:

| Operation | p95 target | Warm provider calls | Cold/rebind calls | Foreground |
| --- | ---: | ---: | ---: | --- |
| Read/extract | 350 ms | 1 | <=2 | forbidden |
| DOM interaction + verify | 600 ms | 1 | <=2 | forbidden |
| Browser-internal resource operation | 700 ms | 1 | <=2 | forbidden |
| Explicit physical-input fallback | 1500 ms | 1 | <=2 | allowed only when explicit |

These are architecture targets and live-gate budgets, not promises about every website or machine. A regression that exceeds them must expose attributable provider timing instead of being hidden behind controller sleeps/retries.

There is no unconditional post-action sleep in the V2 transaction contract. Providers wait on explicit state/postconditions within the action timeout.

## Migration

1. Land this contract and architecture authority.
2. Introduce a Runtime coordinator/provider registry behind the existing Browser action surface.
3. Move macOS existing-browser support to capability-based persistent handles and internal-resource operations.
4. Version the Desktop Operator browser broker with transaction execution and postcondition evidence.
5. Add real-socket live gates and latency reporting, then remove redundant fallback/reconnect paths.

Legacy compatibility remains bounded during migration and must not become an independent source of business rules.
