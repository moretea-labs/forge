# Forge Plugin Management

Forge 1.5 introduces a public installation path for independently released providers while keeping the Controller trust boundary small. Official providers are **separate products** with their own repositories and releases; Forge owns how those providers are selected, installed, registered, authorized, and executed.

## Official catalog

```bash
forge plugin catalog
```

| Plugin ID | Product | Pinned release | Platforms |
| --- | --- | --- | --- |
| `desktop_operator` | [Forge Desktop Operator](https://github.com/moretea-labs/forge-desktop-operator) | `v0.2.0` | macOS |
| `design` | [Forge Design](https://github.com/moretea-labs/forge-design) | `v0.3.0` | macOS, Linux, Windows |
| `personal_knowledge` | [Personal Knowledge Assistant](https://github.com/moretea-labs/personal-knowledge-assistant) | `v0.2.1` | macOS, Linux, Windows |

Investment Decision System remains an independent product and is intentionally not a Forge plugin.

## Install and inspect

```bash
forge plugin install design
forge plugin install personal_knowledge
forge plugin install desktop_operator   # macOS
forge plugin list --refresh
```

Re-running `forge plugin install <id>` installs the version currently pinned by Forge. A catalog version change is a reviewed Forge source change; providers cannot silently self-update through a ChatGPT request.

## Trust boundary

Official installation uses the package-owned [`assets/plugin-registry.v1.json`](../assets/plugin-registry.v1.json). Forge:

1. resolves only catalog entries shipped with the installed Forge package;
2. accepts only the fixed Moretea Labs HTTPS repository declared by that entry;
3. checks out the immutable Git tag declared by the catalog;
4. verifies the provider's `forge-plugin.json` identity and protocol declaration;
5. runs the fixed `forge-plugin-install.mjs` installer entrypoint;
6. validates the returned provider registration;
7. writes it through the existing Controller Home external-registration authority;
8. projects health and actions through the normal typed plugin surface.

Forge does **not** scan sibling directories, accept a model-provided executable path, or provide a generic arbitrary-shell plugin transport.

## Responsibility split

### Forge core owns

- trusted distribution and registration;
- action schema and policy projection;
- authorization and confirmations;
- resource claims and concurrency boundaries;
- idempotency and action receipts;
- health projection and execution evidence.

### External providers own

- domain implementation;
- provider-local data and configuration;
- provider protocol implementation;
- platform-specific installation details;
- independent tests, releases, security policy, and support surface.

This split keeps Forge extensible without moving product-specific implementation into the core repository.

## Provider transports

### `unix_socket_jsonl`

Used by long-lived native providers such as Forge Desktop Operator. Forge connects to a stable local socket after trusted provider installation and lifecycle verification.

### `managed_cli_json`

Used by bounded one-shot providers such as Forge Design and Personal Knowledge Assistant. Forge launches a fixed runtime/helper pair from the installed package, validates the handshake, sends one bounded request, receives one bounded response, and terminates the process.

Both transports resolve to the same `AssistantPluginManifest` and `plugin_action_execute` policy/evidence path.

## Updates and rollback

Provider package directories are versioned and installed transactionally. Trusted registration is replaced only after package identity and installer output validate. If a new provider release fails validation or health checks, the existing registration is not silently replaced with an untrusted or partially installed provider.

Forge's catalog intentionally favors **reviewed pinned releases** over automatic marketplace-style updates. This is slower than an unbounded plugin marketplace and materially easier to audit.

## Provider development

Provider repositories expose their own development/install instructions. A provider release intended for the official catalog should have:

- a public repository and immutable version tag;
- a bounded `forge-plugin.json` contract;
- a deterministic `forge-plugin-install.mjs` entrypoint;
- focused protocol/health/action tests;
- CI, security reporting, support, and contribution documentation;
- no machine-specific paths, credentials, or user data in the public release.

The catalog is updated only after a fresh-install acceptance test proves the provider can be installed without relying on local sibling repositories.
