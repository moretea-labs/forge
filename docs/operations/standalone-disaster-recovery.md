# Standalone disaster recovery

`repo-harness-recovery` is a compiled, fixed-command recovery service family installed as immutable releases below the stable Controller Home. It communicates only with the Stable Supervisor control socket and stores its own lock, known-good evidence, quarantine, audit, release authority, and role runtime identity below `controller-home/recovery/`.

It never accepts a release path or arbitrary command. `rollback-previous` proceeds only when the active release is not already known-good and the Supervisor-registered previous slot exactly matches an independently attested manifest hash. A request against an already known-good active release succeeds as a no-op.

The independent gateway listens only on `127.0.0.1`, exposes a seven-tool MCP surface, requires a separate scoped bearer credential, has bounded mutation rate limiting, and does not use the primary gateway or its ingress proxy. The credential file is mode `0600` and must never be copied into logs or source control. The gateway accepts both `/mcp` and `/recovery/mcp` so a path-scoped Tailscale Funnel can expose recovery without replacing the primary ingress path.

External HTTPS verification uses the platform's trusted system `curl` transport rather than the Recovery binary's Bun TLS stack. On macOS this is fixed to `/usr/bin/curl`; Windows accepts only the verified System32 `curl.exe` path. A missing trusted binary fails closed. TLS and hostname verification remain enabled. Authorization headers, JSON-RPC payloads, and MCP session IDs are written only to short-lived `controller-home/recovery/tmp` files (directory mode `0700`, file mode `0600`) and are removed after every request path, including timeout and cancellation. They are never supplied in process arguments or recovery audit output. Loopback HTTP probes retain the in-process fetch transport.

Build and activate the immutable local Recovery release with:

```sh
bun scripts/install-standalone-recovery.ts --controller-home /absolute/controller-home
```

The installer requires an exact clean Git revision for the Recovery source paths. It compiles into `recovery/releases/.staging-*`, verifies a harmless status canary, writes a manifest with exact source and binary hashes, then atomically renames the complete directory. On the first migration it captures the existing flat binaries as an exact hash-addressed legacy release before changing service authority.

```text
controller-home/recovery/
├── releases/<timestamp>-<revision>/
├── current -> releases/<active>
├── previous -> releases/<rollback>
├── bin/* -> ../current/*
├── state/gateway-runtime.json
├── state/watchdog-runtime.json
├── state/watchdog.json
├── state/agent-repair.json
├── current/pi-recovery.md
└── launchd/*.plist
```

`current` changes only while holding the global Recovery mutation lock. The installer performs a bounded two-service launchd handoff, requires exact runtime identity from the new Gateway and Watchdog, verifies the Recovery health endpoint, and restores and verifies the exact `previous` release on failure. It never overwrites a running executable in place.

To stage and inspect a candidate without changing services:

```sh
bun scripts/install-standalone-recovery.ts --controller-home /absolute/controller-home --stage-only
```

Configure the primary MCP endpoint and the dedicated Recovery endpoint as separate failure domains. The Recovery tunnel service and public URL must be supplied together:

```sh
bun scripts/install-standalone-recovery.ts \
  --controller-home /absolute/controller-home \
  --public-mcp-url https://primary.example.test/mcp \
  --recovery-public-url https://recovery.example.test/recovery/mcp \
  --recovery-tunnel-service-label com.moretea.repo-harness-recovery-tunnel \
  --recovery-tunnel-service-plist "$HOME/Library/LaunchAgents/com.moretea.repo-harness-recovery-tunnel.plist"
```

The old `--public-tunnel-service-label` and `--public-tunnel-service-plist` flags remain compatibility aliases for the dedicated Recovery tunnel only. New automation must use the explicit `--recovery-*` names. The installer rejects a Recovery URL without a service owner, or a service owner without a URL, because an unowned endpoint cannot be repaired safely.

The watchdog evaluates four independent surfaces: Stable Supervisor control, the primary stable ingress/Gateway/MCP lifecycle, the local standalone Recovery Gateway, and the dedicated public Recovery endpoint. A public Recovery outage can restart only its configured tunnel service. A hung local Recovery Gateway can restart only `com.moretea.repo-harness-recovery-gateway`. Neither case is allowed to roll back the primary runtime. Failure counters, first-failure timestamps, prior restart decisions, tunnel-repair failures, rollback use, and the last decision persist across watchdog process restarts.

The installer writes launchd plists that start through `/usr/bin/env -i` with a minimal `PATH`, so the Recovery Gateway and Watchdog do not inherit unrelated session credentials. The installer itself owns user LaunchAgent registration and activation. `scripts/load-standalone-recovery.sh` intentionally refuses direct reloads so no second service-mutation path can bypass publication, identity verification, or rollback.

When Tailscale Funnel is available, expose the recovery gateway under a path that is independent from the primary root mapping:

```sh
tailscale funnel --bg --yes --https=443 --set-path /recovery http://127.0.0.1:8787
```

The resulting ChatGPT Recovery Connector endpoint is:

```text
https://<tailscale-host>.<tailnet>.ts.net/recovery/mcp
```

A ChatGPT Recovery Connector remains a separate provisioning step because creating the Connector may require interactive browser OAuth/MFA and stores a persistent external credential.

## Bounded recovery order

One watchdog tick performs at most one mutation under the global cross-process Recovery lock. The order is deliberately narrow:

1. restart the standalone Recovery Gateway when only its local health endpoint is down;
2. repair the explicitly configured dedicated Recovery tunnel when local Recovery remains healthy;
3. restart the primary Gateway or Stable Supervisor only for their own sustained local failures;
4. roll back only after six sustained observations over at least thirty seconds, two independent primary-runtime evidence classes, no active Supervisor operation, an un-attested active release, and an attested previous release;
5. invoke the optional PI repair agent only after ordinary recovery paths have been attempted or are unavailable and the longer PI threshold and cooldown are satisfied.

A short outage remains `degraded`. The watchdog never runs two recovery mutations in one pass and never resets its failure window merely because the watchdog process restarted.

## Optional PI repair fallback

PI execution is disabled unless `--enable-pi-agent` is provided. Enabling it also requires a resolvable executable and an explicit repository directory. The repository directory should be a dedicated clean clone or disposable worktree, not a developer's active dirty checkout:

```sh
bun scripts/install-standalone-recovery.ts \
  --controller-home /absolute/controller-home \
  --recovery-public-url https://recovery.example.test/recovery/mcp \
  --recovery-tunnel-service-label com.moretea.repo-harness-recovery-tunnel \
  --recovery-tunnel-service-plist "$HOME/Library/LaunchAgents/com.moretea.repo-harness-recovery-tunnel.plist" \
  --enable-pi-agent \
  --pi-command /absolute/path/to/pi \
  --pi-repo-root /absolute/path/to/dedicated-recovery-worktree
```

The prompt is copied into the immutable Recovery release as `pi-recovery.md`, hashed in `manifest.json`, and resolved through the active `recovery/current` authority. Runtime execution fails closed if the prompt path or hash no longer matches the active release. PI runs with a fixed prompt, a bounded evidence appendix, the configured repository as its working directory, a maximum runtime, bounded output, a one-hour default cooldown, the same global mutation lock, and audit records containing hashes rather than model output. It cannot be enabled by a transient watchdog state change. Missing PI, prompt tampering, timeout, non-zero exit, or lock contention is recorded once and does not create a retry storm.
