# Forge Plugin Management

Forge 1.5 adds a public installation path for independently released providers without turning arbitrary local executables into plugins.

## Boundaries

Forge core owns plugin policy, trusted registration, authorization, resource claims, idempotency, health projection and execution evidence. External products own their domain implementation and release lifecycle.

The official catalog currently contains:

| Plugin ID | Product | Distribution | Platforms |
| --- | --- | --- | --- |
| `desktop_operator` | Forge Desktop Operator | Git tag `v0.2.0` | macOS |
| `design` | Forge Design | Git tag `v0.3.0` | macOS, Linux, Windows |
| `personal_knowledge` | Personal Knowledge Assistant | Git tag `v0.2.1` | macOS, Linux, Windows |

Investment Decision System is an independent product and is not a Forge plugin.

## Install

```bash
forge plugin catalog
forge plugin install design
forge plugin install personal_knowledge
forge plugin install desktop_operator
forge plugin list --refresh
```

Official installation uses the package-owned `assets/plugin-registry.v1.json`. Forge accepts only the fixed Moretea Labs HTTPS repositories and immutable version tags declared there, verifies `forge-plugin.json`, runs the fixed `forge-plugin-install.mjs` entrypoint, and writes the resulting provider contract through the existing Controller Home external-plugin registration authority.

Forge does not scan sibling directories, accept a model-provided executable path, or execute a generic shell transport.

## Provider transports

`unix_socket_jsonl` is used by the long-lived native Desktop Operator. `managed_cli_json` is used by product providers such as Forge Design and Personal Knowledge Assistant when a bounded one-shot process is sufficient. Both transports resolve into the same `AssistantPluginManifest` and `plugin_action_execute` policy path.

## Update model

Running `forge plugin install <id>` again installs the catalog's pinned version transactionally at the package-directory level and replaces the trusted registration only after package identity and installer output validate. Catalog version changes are reviewed Forge source changes, so third-party code cannot silently update itself through ChatGPT requests.
