# Features and Setup Levels

Forge is useful without coding agents or external plugins. Start with the core workflow, then add integrations only when a task requires them.

## Core features

These features are part of the default local setup:

- repository registration with stable `repoId` and `checkoutId` identities;
- bounded repository inspection and context collection;
- five structured ChatGPT facade capabilities: `rh_status`, `rh_access`, `rh_inbox`, `rh_context`, and `rh_work`, plus a stable repair-capable default MCP schema;
- Direct Edit sessions with path limits, SHA preconditions, revisions, savepoints, diffs, checks, and rollback;
- durable Issue → Task → Run state and resumable evidence;
- named verification checks instead of arbitrary remote shell access;
- local Controller UI and append-only activity/evidence records;
- runtime storage isolation under Controller Home;
- multi-repository routing and explicit target selection;
- release gates, tracked-file hygiene, and public export checks.

## Optional features

| Integration | What it adds | Requirement |
| --- | --- | --- |
| Codex / Claude | Delegated implementation for work too large for Direct Edit | Install and authenticate the corresponding CLI; explicitly enable the dev runner. |
| GitHub | Issue/Project synchronization, PR workflows, cloud-agent sessions | Authenticated `gh` and repository permission. |
| Tailscale / Cloudflare | Stable HTTPS endpoint for ChatGPT MCP | Tunnel client and appropriate account/domain configuration. |
| Browser | Playwright navigation, screenshots, and bounded browser evidence | Browser binaries and HTTP(S) URL scheme validation. |
| CodeGraph | Additional code relationships and impact navigation | CodeGraph CLI; native Windows automatic setup is not yet enabled. |
| Google Workspace | Gmail and Calendar plugin actions | Explicit OAuth setup and plugin permission. The OAuth client ID is non-secret managed configuration; refresh tokens and imported client secrets are stored in the platform credential store. Forge sends `client_secret` when one is stored and otherwise attempts the public-client/PKCE path; the live provider response remains authoritative for whether a specific OAuth client requires the secret. A stored refresh token or configured access token alone is **unverified**, not live-ready. Readiness becomes live-ready only after a successful provider action. If the provider returns `invalid_request: client_secret is missing`, restore the secret matching the configured OAuth client ID in macOS Keychain. If the original secret is irretrievable, configure a dedicated OAuth client ID, store its matching secret in Keychain, and reauthorize: refresh tokens do not transfer between OAuth clients. macOS Keychain is the single credential authority: do not cache refresh tokens or client secrets across external rotations. When the managed OAuth Client ID changes, restart the same running release to reload the environment; a runtime version switch is unnecessary. |
| Schedules | Supervised recurring checks | Canonical Forge Runtime running; live actions remain policy-gated. |

## Tool exposure

Forge exposes one complete MCP tool registry without `facade` / `core` / `advanced` / `full` exposure selectors. The preferred entry points remain the `rh_*` facades, `execute_command` for authorized terminal work, `capability_execute` for typed core actions, and `plugin_action_execute` for provider-owned plugin actions. Other genuinely distinct Git, repository, Process, evidence, browser, iOS, and maintenance capabilities remain public until their callers move to an equivalent canonical action and their duplicate definitions are removed. Tool selection guidance does not hide capability. The MCP transport publishes the full static schema and does not dynamically load domain schemas.

## Execution choices

- The model can choose direct terminal execution with `execute_command`, bounded source edits, structured retrieval, or domain capabilities without any required Work or Plan.
- Durable Tasks, agents, and named checks remain optional capabilities for the model to select when they add value.
- Forge enforces concrete execution authorization, resource isolation and write consistency, but does not choose the model's workflow.

## Authorization boundaries

Reading and local bounded checks can be automatic. Repository mutations, destructive cleanup, external side effects, remote Git operations, GitHub changes, email actions, and publication remain explicitly policy-gated. Connecting ChatGPT does not grant unrestricted shell or filesystem access.
