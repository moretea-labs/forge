# Independent Windows/WSL host rescue

This is the emergency availability path for a Forge installation whose normal
Runtime, Connector, Controller, or existing Recovery Gateway cannot be used.
It is a small fixed-command agent installed outside both the Forge source
checkout and Controller Home:

```text
GREYSON-DESKTOP / Windows
  C:\ProgramData\ForgeRecovery\ForgeRecovery.ps1
       |
       | wsl.exe --distribution <exact distro> --exec <exact agent> <fixed action>
       v
WSL /home/<user>/.forge-recovery/
  forge-wsl-rescue + root-owned config + one systemd --user watchdog
       |
       +-- canonical Runtime systemd unit
       +-- canonical OAuth Connector systemd unit
       +-- exact OpenAI Secure Tunnel runtime alias
```

The two scripts are copied as bootstrap artifacts. Their normal operation does
not read a Forge checkout, call Forge MCP, invoke the Controller, use the
Controller database, or execute a supplied shell command. The only mutable
state they own is their configuration and a cross-process lock below
`/home/<user>/.forge-recovery`; Runtime releases, database backups, schedules,
and Controller state remain under the canonical Controller Home.

## Fixed action surface

The Windows wrapper validates one fixed action before it calls WSL. The WSL
agent accepts only these action names:

```text
host_status
wsl_status, wsl_start
forge_source_status, controller_status
runtime_status, runtime_start, runtime_restart
connector_status, connector_start, connector_restart
recovery_status, recovery_start, recovery_restart
tunnel_status, tunnel_start, tunnel_restart
forge_cloud_verify, full_recover
```

There is intentionally no `execute`, `powershell`, `bash`, or arbitrary-command
action. All lifecycle mutations acquire the same rescue-root lock. The Windows
logon task is only a cold-start trigger; it delegates the actual mutation to
that WSL lock owner and holds no release, database, tunnel, or lifecycle state.

`full_recover` starts the one configured independent Recovery service, then the
exact canonical Runtime and Connector units, waits for the local OAuth MCP
endpoint, reconnects the exact tunnel alias when needed, and verifies both
local MCP reachability and tunnel readiness. It never selects a release,
changes Controller Home, edits source, or falls back to another host.

## Bootstrap

Run the installer directly from a clean WSL source checkout. It is a bootstrap
script, not a Forge Runtime command:

```sh
bun scripts/install-independent-windows-wsl-recovery.ts \
  --distro UbuntuDev \
  --controller-home /home/greyson/.forge/controller \
  --tunnel-client /home/greyson/.local/bin/tunnel-client \
  --tunnel-alias forge \
  --tunnel-id tunnel_0123456789abcdef0123456789abcdef \
  --tunnel-profile forge \
  --tunnel-profile-dir /home/greyson/.config/tunnel-client \
  --tunnel-admin-profile default \
  --install-windows-logon-task
```

Use `--stage-only` to write and inspect the external artifacts without enabling
the WSL watchdog. The installer fails closed unless the Controller Home is the
canonical user-level path (`/home/<user>/.forge/controller`) and the rescue
root is exactly `/home/<user>/.forge-recovery`.

Windows Task Scheduler may require elevation to create the optional logon task.
When that happens, the installer still reports the installed WSL rescue and
returns `windowsLogonTask.installed=false` with the exact Scheduler error; the
fixed-action host script is still available for an elevated administrator to
register later. Do not replace it with a second background service.

The agent contains no tunnel credential. Its configuration holds only a
`file:` reference below the independent rescue root; `tunnel-client` reads the
permissioned value only when reconnecting. Before retiring a legacy Controller
Home, move that reference to the rescue root or the canonical Controller Home
and confirm the profile resolves it there.

## Controller Home cutover

For the retired repo-local home, use the separate direct migration bootstrap.
Its default invocation is read-only and fails closed if both legacy and
canonical Runtime/Connector units are active:

```sh
bun scripts/migrate-windows-wsl-controller-home.ts \
  --source-home /home/greyson/src/forge/_ops/controller-home \
  --destination-home /home/greyson/.forge/controller
```

Only after its preflight is correct, repeat the exact command with `--execute`.
The transaction stops the legacy Runtime and Connector, copies the complete
Controller Home into a staged sibling, preserves the prior canonical directory,
rewrites only known service path references, preserves the legacy
Controller-bound release authority as evidence, stages and publishes one fresh
whole Runtime release from the clean WSL checkout, installs the canonical unit
pair, and requires both local MCP endpoints before retiring the legacy unit
files. A failed cutover stops the canonical pair, restores the prior canonical
directory/unit files, and starts the legacy pair again. It never deletes either
Controller Home or performs database cleanup.

## Operational acceptance

After installation, invoke the following fixed actions from Windows PowerShell:

```powershell
& 'C:\ProgramData\ForgeRecovery\ForgeRecovery.ps1' host_status
& 'C:\ProgramData\ForgeRecovery\ForgeRecovery.ps1' full_recover
& 'C:\ProgramData\ForgeRecovery\ForgeRecovery.ps1' forge_cloud_verify
```

Then perform the recoverable drill sequence: restart Runtime, verify; restart
Connector, verify; restart tunnel, verify; restart the WSL user service and
verify all three. A stopped Runtime must be restored by `full_recover` without
depending on Forge's normal execution surface. Do not use this path to delete a
Controller database, source checkout, release, or credential.
