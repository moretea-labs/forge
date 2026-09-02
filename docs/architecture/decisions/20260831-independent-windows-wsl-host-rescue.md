# Independent Windows/WSL host rescue

Status: accepted

Date: 2026-08-31

## Decision

Forge has one canonical Runtime, one Controller Home, and one OpenAI Secure
Tunnel authority on the Windows host's WSL distribution. A damaged Forge
checkout, Runtime, Controller, MCP gateway, or normal Recovery deployment must
not prevent the host from starting that canonical set.

The rescue implementation is therefore copied at bootstrap time to:

```text
C:\ProgramData\ForgeRecovery\
/home/<user>/.forge-recovery/
```

It has a Windows PowerShell wrapper and WSL shell agent, both exposing only
named actions. The WSL agent holds the one mutation lock and owns one systemd
user watchdog. The Windows logon task may wake WSL and submit `full_recover`,
but it creates no second watchdog and does not own Runtime state.

## Boundaries

- The rescue configuration stores only exact paths, service units, and tunnel
  identity. It contains no Runtime API key or OAuth token.
- `tunnel-client` remains the credential owner. Its runtime-key reference must
  resolve outside any retired repo-local Controller Home before that home is
  retired.
- The Secure Tunnel Connector is loopback-only and runs with `--auth none`.
  OpenAI Secure Tunnel is the external authorization boundary; an OAuth gateway
  is required only for a separately configured HTTPS/public connector.
- The rescue agent may start/restart only the configured canonical Runtime and
  Connector units, its own unit, and its configured tunnel alias. It cannot
  accept a command string or select an alternate host/release/controller.
- Controller Home migration remains an explicit stop-copy-verify-cutover
  transaction. The rescue agent can recover canonical services after cutover;
  it does not copy databases or make authority decisions.

## Failure handling and removal

The watchdog tolerates a failed reconciliation cycle and retries through its
single systemd unit. Concurrent Windows/manual/service calls serialize through
the external lock and fail with a retryable lock-busy result instead of racing.
If the rescue package itself is compromised or needs retirement, disable
`com.moretea.forge.independent-recovery.service`, unregister `Forge Independent
Recovery WSL`, and remove only the two explicitly named external rescue roots
after a verified replacement is installed. This removal never deletes a
Controller Home, Runtime release, tunnel profile, or source checkout.

## Verification

Focused tests cover canonical unit derivation, safe path/argument validation,
and credential-free generated configuration. Operational acceptance requires
the recoverable Runtime, Connector, tunnel, and WSL-user-service restart drills
documented in `docs/operations/windows-wsl-host-rescue.md`.
