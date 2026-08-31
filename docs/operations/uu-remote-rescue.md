# UU Remote emergency rescue

Forge can install an optional **controller-scoped** `uu_remote_rescue` plugin on the macOS emergency operator. It exists only to recover the already-authoritative Windows/WSL Forge when the primary Forge Connector/Runtime and the WSL Recovery endpoint cannot be reached.

## Authority boundary

- `uuyc-cli` is the device identity and terminal-connection authority. The plugin stores only the exact non-secret device id/name, expected Windows platform, WSL distro, and remote Controller Home path.
- Forge Desktop Operator remains the macOS Accessibility/TCC authority. The helper talks to its stable Unix socket and never gives `forge-runtime` direct Accessibility permissions.
- WSL `systemd --user` remains the service owner. Start/restart actions target only the canonical Runtime/Connector unit names derived from the configured Controller Home and the fixed Recovery gateway/watchdog units.
- `runtime_recover` invokes only the existing `forge recovery recover --controller-home <configured-home>` whole-release recovery transaction. The macOS machine never becomes another Forge Runtime authority.

There is intentionally no action accepting a device selector, service name, path override, command, script, shell fragment, or password/token. A wrong device identity or offline device is rejected before the terminal is opened or a remote mutation is attempted.

## Install

Run from the trusted Forge package/source that contains the helper:

```bash
bun scripts/install-uu-remote-rescue-registration.ts \
  --controller-home "$HOME/.forge/controller" \
  --device-id '<exact uuyc-cli device id>' \
  --device-name '<exact device name>' \
  --wsl-distro '<exact WSL distro>' \
  --remote-controller-home '/home/<user>/.forge/controller'
```

The installer writes a mode-0600 non-secret config below Controller Home and a normal external-plugin registration using the existing `managed_cli_json` transport. It does not persist UU Remote unlock codes, passwords, OAuth material, bearer tokens, or clipboard contents.

## Typed actions

`device_status` performs exact identity/online observation without opening a terminal. `wsl_status` and `forge_health` open the exact configured UU terminal transiently and send built-in observation commands. `runtime_start`, `runtime_restart`, `connector_start`, `connector_restart`, `recovery_start`, and `recovery_restart` operate only the derived/fixed systemd-user units. `runtime_recover` delegates the rollback/restart/verification transaction to canonical standalone Recovery logic.

The helper saves the current macOS clipboard only in process memory, uses it to paste the fixed command into the exact UURemote terminal session, restores the clipboard in `finally`, closes the Desktop Operator session, and clears the transient UU remote shell. Clipboard contents are never returned in plugin results or written to disk.

## Health payload

`forge_health` returns structured data for the configured WSL distro including Controller Home presence, `control-plane.sqlite`, Runtime owner/status files, Connector authority, Recovery config presence, canonical systemd service states, and the latest `controller_home_migration` record when `sqlite3` is available in WSL. Missing `sqlite3` is reported as bounded migration-state unavailability rather than guessed state.

## Operational caveat

UU Remote terminal interaction requires an unlocked macOS GUI session because Desktop Operator deliberately refuses foreground input while the console is locked. This is a fail-closed condition; the rescue plugin does not add coordinate automation, OCR, login-window automation, or a raw remote-shell fallback.
