# Standalone disaster recovery

`forge-recovery` is an independent, fixed-command recovery service family. It is not a second primary Runtime owner and it does not start, stop, restart, repair, or roll out individual core components.

## Authority boundaries

The primary application has three relevant records under Controller Home:

```text
runtime/active-runtime-owner.json       live Canonical Runtime ownership
runtime/status.json                     read-only Runtime status projection
runtime/releases/authority.json         atomic active/previous whole-release authority
runtime/releases/backups/*.sqlite       local pre-upgrade database backups
```

Recovery reads those records and probes the configured Runtime MCP endpoint. It does not connect to a Supervisor socket, select a blue/green slot, submit component operations, or infer authority from a source checkout.

SQLite rows are local project-execution state. Database files and backups remain below Controller Home and are never included in source control, a package, an immutable release, a release manifest, or data distributed to another user. The release manifest carries only SQLite schema compatibility metadata.

## Recovery service state

Recovery-owned configuration, evidence, locks and audit records remain below:

```text
controller-home/recovery/
├── config/
├── releases/
├── state/
├── locks/
├── audit/
├── tmp/
└── launchd/
```

Recovery release binaries may be installed independently so diagnostics remain available when the primary Runtime is down. That independent installation does not grant primary Runtime lifecycle authority.

## Fixed recovery surface

The CLI and Recovery MCP surface expose bounded operations:

```text
runtime_status
verify_stable_runtime
verify_external_runtime
list_releases
attest_known_good
restart_primary_runtime
recover_primary_runtime
rollback_previous
activate_runtime_release
restart_public_tunnel
reconnect_primary_connector
```

`restart_primary_runtime` restarts only the installed canonical Forge Runtime service and requires whole-Runtime verification. `recover_primary_runtime` is the complete failure transaction: stop the canonical service, restore the attested previous whole release and its SQLite backup, restart the service, and require verification.

`activate_runtime_release` is the controlled bootstrap/upgrade escape hatch. It accepts an already staged and validated immutable Runtime release manifest and executes the same bounded transaction without depending on the primary Runtime execution plane: stop the complete canonical service, atomically switch active/previous whole-release authority with a local SQLite backup, start the one Runtime service, require whole-Runtime verification, and on failure restore the previous whole release and its SQLite backup before restarting. The candidate must match its manifest artifact identity and database schema compatibility; a fenced or stale primary Runtime is never required to stage, validate, or activate the release.

`runtime_status` reads canonical Runtime observation. `list_releases` reads the whole-release authority. `attest_known_good` succeeds only after Runtime status, release identity, authenticated MCP initialization, tools/list, and the configured read-only MCP call pass together.

The Recovery Gateway listens on loopback, uses a separate scoped credential, bounds request/output size, and stores no primary MCP credential in logs. External HTTPS verification uses the trusted system curl transport; temporary headers, MCP payloads and session identifiers are written only to bounded mode-0600 files below `recovery/tmp` and are removed after each request.

## Whole-Runtime rollback

The rollback primitive is deliberately offline, while `recover_primary_runtime` owns the complete bounded service transaction:

1. acquire the cross-process Recovery mutation lock;
2. boot out the canonical Forge Runtime launchd service;
3. prove the active Runtime owner is no longer running;
4. require an independently attested previous whole release with a verified local SQLite backup;
5. back up the current local SQLite database;
6. restore the previous local backup;
7. atomically switch active/previous whole-release authority;
8. start the same canonical Forge Runtime service, which reads the newly selected active release;
9. require whole-Runtime verification;
10. if the restored release fails verification, stop the service to prevent an automatic restart loop.

Recovery never rolls back Gateway, Controller Services, Scheduler, MCP Transport, Worker code, configuration, or database independently. They move as one release compatibility set. If the authority commit fails after database restoration, the rollback implementation restores the just-created current backup.

## Watchdog rules

One watchdog tick performs at most one mutation under the cross-process Recovery lock.

Allowed self-repair is narrow and ordered:

1. restart the standalone Recovery Gateway when only its own loopback health fails;
2. restart the explicitly configured Recovery public tunnel when local Runtime and Recovery health are good but that external endpoint fails;
3. after a sustained local whole-Runtime failure, restart the canonical Forge Runtime service with a bounded attempt count and cooldown;
4. only after those restart attempts are exhausted, require sustained multi-signal evidence, an unattested active release, and an independently attested previous release before executing automatic whole-Runtime recovery;
5. stop, roll back, restart, and verify under one Recovery mutation lock.

The watchdog cannot launch an Agent, edit a source checkout, generate repair scripts, mutate repository files, restart an individual core module, or select a Runtime slot. A brief outage remains diagnostic evidence and does not trigger rollback. Default policy permits at most three primary Runtime restart attempts before rollback eligibility is evaluated. Failed recovery transactions are independently cooldown-bounded; `rollbackUsed` becomes permanent only after the previous whole-release authority actually commits, so a transient lock or service-stop failure neither causes a retry storm nor suppresses recovery forever.

## Installation

Build, canary, and activate the immutable Recovery release with the public CLI:

```sh
forge recovery install \
  --controller-home /absolute/controller-home \
  --public-mcp-url https://mcp.example.com/mcp \
  --recovery-public-url https://recovery.example.com/recovery/mcp \
  --recovery-tunnel-service-label com.example.forge-recovery-tunnel \
  --recovery-tunnel-service-plist /absolute/path/com.example.forge-recovery-tunnel.plist
```

Use `--stage-only` to build and canary without activating Gateway or Watchdog services. The source-level `bun scripts/install-standalone-recovery.ts` entry remains an internal packaging primitive, not a second operator surface.

A public Recovery endpoint is optional for local-only operations. A ChatGPT Recovery Connector requires an explicit HTTPS Recovery URL and its dedicated tunnel service owner. Print the exact non-secret connector descriptor with:

```sh
forge recovery connector --controller-home /absolute/controller-home
```

The installer owns publication and activation. Before registering `com.moretea.forge-recovery-gateway` and `com.moretea.forge-recovery-watchdog`, it exits and removes stale Recovery services discovered under the Recovery-owned launchd directory. Configuration is rewritten from the current schema and does not preserve retired ingress, agent-repair, or legacy tunnel fields. Direct reload scripts are not a second mutation path.

Forge deliberately has no blue-green Runtime topology. There is one active whole-release authority and one canonical service. Candidate validation happens before activation; activation stops the complete Runtime, switches the atomic active release, starts one Runtime, and gates on whole-Runtime readiness. Failure restores the previous whole release and its bound SQLite backup.

No rollout, service installation, or live restart is implied by source changes. Activating a new primary Runtime release still requires separate explicit authorization and exact release evidence.

## Operator CLI

The `forge recovery` command exposes the same bounded lifecycle surface as the Recovery Gateway tools, so routine maintenance never requires hand-written `launchctl`:

```sh
forge recovery status --controller-home /absolute/controller-home
forge recovery verify --controller-home /absolute/controller-home
forge recovery restart-runtime --controller-home /absolute/controller-home
forge recovery recover --controller-home /absolute/controller-home
forge recovery rollback --controller-home /absolute/controller-home
forge recovery restart --controller-home /absolute/controller-home
forge recovery install --controller-home /absolute/controller-home
forge recovery activate-runtime --controller-home /absolute/controller-home --release-manifest /absolute/staged-release/manifest.json
```

`forge runtime status --controller-home /absolute/controller-home` reads the canonical Runtime status projection. `forge runtime service install --stage-only` builds and validates an immutable Runtime release without publishing it; the staged manifest can then be activated through `forge recovery activate-runtime` when the primary Runtime is fenced or unavailable.

## Windows host wake for WSL

A process inside WSL cannot recover the distro after `wsl --shutdown`, so Windows supplies one deliberately narrow cold-start trigger. It is **not** another watchdog or Runtime owner. `forge recovery install-wsl-host-wake` installs one Windows Scheduled Task owned by the Recovery operator surface. At Windows logon (or when the same task is started explicitly), the task starts the configured WSL distro, asks `systemd --user` to start the already-authoritative Forge Package Runtime and MCP Connector units, verifies both units are active, and then runs read-only `forge recovery status`.

The task never selects a Runtime release, edits authority, performs rollback, creates a second daemon, or recreates the OpenAI Secure Tunnel with credentials. Installation fails closed unless the existing Package Connector authority proves a persistent `systemd-user` service. The official `tunnel-client` remains its own supervised transport and keeps its runtime API key outside Forge state.

```sh
forge recovery install-wsl-host-wake \
  --controller-home /home/user/.forge/controller \
  --distro Ubuntu-24.04
```

For development-network failures inside WSL, use the bounded diagnostic instead of changing proxy settings speculatively:

```sh
forge recovery diagnose-wsl-network \
  --endpoint https://github.com \
  --endpoint https://api.github.com
```

The diagnostic compares the active `wslinfo --networking-mode` result with `%USERPROFILE%\\.wslconfig`, flags NAT plus loopback proxy assumptions, identifies Windows Git Credential Manager helpers configured inside WSL, and reports endpoint-specific timeouts. It returns only proxy host classes, credential-helper classes, and endpoint origins; proxy credentials, URL paths/query strings, and raw credential-helper paths are not emitted.
