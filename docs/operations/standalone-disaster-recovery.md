# Standalone disaster recovery

`repo-harness-recovery` is an independent, fixed-command recovery service family. It is not a second primary Runtime owner and it does not start, stop, restart, repair, or roll out individual core components.

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
rollback_previous
restart_public_tunnel
reconnect_primary_connector
```

`runtime_status` reads canonical Runtime observation. `list_releases` reads the whole-release authority. `attest_known_good` succeeds only after Runtime status, release identity, authenticated MCP initialization, tools/list, and the configured read-only MCP call pass together.

The Recovery Gateway listens on loopback, uses a separate scoped credential, bounds request/output size, and stores no primary MCP credential in logs. External HTTPS verification uses the trusted system curl transport; temporary headers, MCP payloads and session identifiers are written only to bounded mode-0600 files below `recovery/tmp` and are removed after each request.

## Whole-Runtime rollback

Rollback is deliberately offline:

1. verify that the primary Runtime is stopped;
2. acquire the Recovery mutation lock;
3. require an attested previous whole release with a verified local SQLite backup;
4. back up the current local SQLite database;
5. restore the previous local backup;
6. atomically switch active/previous whole-release authority;
7. leave startup of the selected Runtime to the single supported Runtime launcher;
8. verify the restarted Runtime before attesting it as known-good.

Recovery never rolls back Gateway, Controller Services, Scheduler, MCP Transport, Worker code, configuration, or database independently. They move as one release compatibility set. If the authority commit fails after database restoration, the rollback implementation restores the just-created current backup.

## Watchdog rules

One watchdog tick performs at most one mutation under the cross-process Recovery lock.

Allowed self-repair is narrow:

1. restart the standalone Recovery Gateway when only its own loopback health fails;
2. restart the explicitly configured Recovery public tunnel when local Runtime and Recovery health are good but that external endpoint fails;
3. request offline whole-Runtime rollback only after a sustained multi-signal failure, an unattested active release, and an attested previous release are proven.

The watchdog cannot restart the primary Runtime, launch an Agent, edit a source checkout, generate repair scripts, or mutate repository files. A brief outage remains diagnostic/degraded evidence and does not trigger rollback.

## Installation

Build the immutable Recovery release with:

```sh
bun scripts/install-standalone-recovery.ts --controller-home /absolute/controller-home
```

A public Recovery endpoint is optional. When configured, its service owner and URL must both be explicit. Direct reload scripts are not a second mutation path; publication and activation remain installer-owned.

No rollout or live service restart is implied by source changes. Activating a new primary Runtime release requires separate explicit authorization and exact release evidence.
