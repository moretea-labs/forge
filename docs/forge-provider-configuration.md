# Forge Provider Configuration

Forge keeps provider selection separate from Runtime ownership. Codex, Claude, GitHub, browser, Google Workspace, Apple, iOS, Desktop, and other adapters execute bounded contracts through stable Forge policy, Process, receipt, and audit layers.

Provider credentials are supplied through supported environment or OS credential mechanisms and are never copied into repository state or chat output. Provider availability does not change the one-Runtime topology.

See [Provider configuration](operations/provider-configuration.md), [Plugin baseline](architecture/current/personal-assistant-plugin-baseline.md), and [Security Model](wiki/Security-Model.md).
