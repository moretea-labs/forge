# Forge Plugin Installation

## User model

Forge plugins are installed **through Forge**. Normal users do not clone plugin repositories, download release archives, run package managers, or register provider sockets manually.

Discover available trusted plugins:

```bash
forge plugin catalog
```

Install or update one by its stable plugin id:

```bash
forge plugin install <plugin-id>
```

Inspect installed plugins and refresh controller-scoped health:

```bash
forge plugin list --refresh
```

## What `forge plugin install` does

The official plugin catalog records a trusted package source for each plugin: repository URL, pinned release ref/tag, installer path, version and supported platforms.

For an install/update, Forge currently:

1. resolves the requested plugin id from the built-in trusted catalog;
2. verifies platform compatibility;
3. creates a staging directory under Forge Controller Home plugin storage;
4. performs a shallow Git clone of the **catalog-pinned ref** (`--depth 1 --branch <ref> --single-branch`);
5. verifies the package has `forge-plugin.json` and the declared installer;
6. verifies package id/version match the trusted catalog entry;
7. swaps the staged package into Forge-managed plugin storage while retaining the previous package as rollback backup until installation succeeds;
8. runs the plugin's bundled installer;
9. validates and persists the external provider registration;
10. refreshes the Forge plugin registry;
11. prints bounded plugin-specific next steps.

The Git repository is therefore a **distribution backend**, not a user installation surface. For a public catalog plugin, the user does not need to visit GitHub or prepare a source checkout.

Forge does not dynamically install arbitrary repository URLs supplied by a model or user prompt. Only trusted catalog entries can use this installation path.

## Where packages live

Installed packages are owned by Forge Controller Home under its system plugin package storage. Their exact filesystem path is an implementation detail and may be printed when a plugin needs a first-time integration step.

Users should not edit files inside the installed package directory. Updating is done by running `forge plugin install <plugin-id>` again after Forge's catalog pins a newer version.

## Figma Bridge

Install:

```bash
forge plugin install figma
```

Forge downloads the pinned Forge Figma Bridge release and installs its local provider automatically. No Figma API token, GitHub download, remote MCP service or manual provider configuration is required.

Because Figma Desktop controls its own local-plugin registration, there is one Figma-side first-time step on each Mac:

1. run `forge plugin install figma`;
2. copy/use the `figma/manifest.json` path printed by the installer;
3. in Figma Desktop open **Plugins → Development → Import plugin from manifest…** and select that path;
4. open the Design file Forge should control and run **Forge Figma Bridge**;
5. optionally verify with `forge plugin list --refresh`.

The manifest is already inside the Forge-managed installed package. It does not need to be downloaded separately.

### Daily Figma use

After the one-time manifest import:

1. open the target Figma Design file;
2. run **Forge Figma Bridge** in that file;
3. use ChatGPT/Forge normally.

The macOS provider daemon is persistent, but the Figma plugin session is file-scoped. If Figma ends the plugin session, Forge reports the bridge as disconnected/degraded until the plugin is run again.

### Figma configuration

Normal users do not need configuration. The provider uses a Forge-managed Unix socket and a loopback-only Figma bridge at `http://localhost:38491/figma`.

### Figma updates

When Forge ships a catalog entry pinned to a newer Figma Bridge version, rerun:

```bash
forge plugin install figma
```

Forge downloads and installs the newly pinned release. No `git pull` or manual package replacement is needed. Re-run Forge Figma Bridge in the current Figma file so the active Figma session loads the new plugin code.

## Current uninstall boundary

The general Forge CLI currently exposes catalog/list/install/update-through-install. A first-class generic `forge plugin uninstall <plugin-id>` command is not yet part of this CLI surface. Individual external plugins may provide a bounded uninstall helper for provider lifecycle cleanup; this is currently an administration/development boundary rather than part of the normal install flow.
