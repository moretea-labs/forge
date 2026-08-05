# Controller Desktop Plugin

The `desktop` plugin is a bundled first-party Repo Harness capability for bounded
macOS desktop observation and application launch. It is not downloaded from a
marketplace and it does not require a user-configured socket, executable path, or
registration descriptor.

## Architecture

```text
ChatGPT / CLI / Local UI
  -> list_plugins / get_plugin / plugin_action_execute
     -> existing plugin policy, schema, receipt, and audit layers
        -> Desktop adapter (Controller process)
           -> one-shot managed child process
              -> JSON-lines stdio handshake and action
                 -> bundled repo-harness-desktop-helper.mjs
```

The Controller starts the helper on demand for one action. The child performs a
versioned handshake, executes one bounded request, returns one structured result,
and exits. Repo Harness enforces request and response size limits, timeout,
cancellation, capability negotiation, bounded diagnostics, and process cleanup.
The helper is launched directly without a shell.

This initial implementation deliberately does not provide:

- plugin search, download, installation, or a marketplace;
- arbitrary commands or user-configured helper paths;
- sockets, background registration files, or a second plugin registry;
- screen capture, clicks, coordinates, keyboard input, or text entry;
- dynamic MCP tool loading.

The existing static MCP tools remain the public entry point, while action schemas,
permissions, lifecycle, health, receipts, and audit events remain authoritative in
the existing plugin runtime.

## Actions

| Action | Effect | Policy |
| --- | --- | --- |
| `configure` | Enable or disable the bundled Desktop plugin. | Authorization required. |
| `status` | Run a live helper handshake and return bounded readiness diagnostics. | Read-only. |
| `observe` | Read the frontmost macOS application through `NSWorkspace`; no screen pixels are captured. | Read-only. |
| `open_application` | Open one app by exact `app_name` or `bundle_id`. | Authorization required. |

`open_application` accepts exactly one selector. It invokes `/usr/bin/open` with an
argv array and never interpolates a shell command.

## Enable on this Mac

Use the controller-scoped plugin action without a repository id:

```json
{
  "plugin_id": "desktop",
  "action_id": "configure",
  "request_id": "desktop-enable-1",
  "confirm_authorization": true,
  "arguments": {
    "enabled": true
  }
}
```

Then call `get_plugin` for `desktop`, followed by `status` and `observe`.
No ChatGPT reconnect is required because Repo Harness reuses the existing
`list_plugins`, `get_plugin`, and `plugin_action_execute` tool schemas. A Controller
restart or rollout is required only when loading a newly installed Repo Harness
runtime revision.

Configuration authority is stored under:

```text
<controller-home>/system/desktop/config.json
```

The derived manifest and registry remain Controller projections. The helper path
is resolved from the active Repo Harness installation and is not returned as
user-facing configuration.

## Permissions

The current version does not request Screen Recording permission because it does
not capture screenshots. Read-only observation uses AppKit `NSWorkspace` through
the system JavaScript bridge and does not intentionally trigger Accessibility
consent prompts. Health reports Accessibility as `not_probed` rather than claiming
permission that has not been verified.

Future click, keyboard, screenshot, or accessibility-tree actions must be added as
separate capabilities with explicit permission probes, stronger policy, redaction,
and fault-injection coverage. They must not be inferred from this initial plugin.

## Failure behavior

The plugin fails closed when:

- it is disabled;
- the platform is not macOS;
- the bundled helper is missing;
- the helper handshake or capability set is incompatible;
- a response is malformed or exceeds the output bound;
- the helper crashes, times out, or is cancelled;
- `open_application` receives zero or multiple selectors.

A helper failure is surfaced as a structured `PLUGIN_MANAGED_PROCESS_*` or
`PLUGIN_DESKTOP_*` error through the existing plugin receipt and audit path.
