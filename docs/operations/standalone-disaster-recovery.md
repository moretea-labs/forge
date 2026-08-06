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
restart_public_tunnel
reconnect_primary_connector
```

`restart_primary_runtime` restarts only the installed canonical Forge Runtime service and requires whole-Runtime verification. `recover_primary_runtime` is the complete failure transaction: stop the canonical service, restore the attested previous whole release and its SQLite backup, restart the service, and require verification.

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

Build the immutable Recovery release with:

```sh
bun scripts/install-standalone-recovery.ts --controller-home /absolute/controller-home
```

A public Recovery endpoint is optional. When configured, its service owner and URL must both be explicit. Direct reload scripts are not a second mutation path; publication and activation remain installer-owned.

Forge deliberately has no blue-green Runtime topology. There is one active whole-release authority and one canonical service. Candidate validation happens before activation; activation stops the complete Runtime, switches the atomic active release, starts one Runtime, and gates on whole-Runtime readiness. Failure restores the previous whole release and its bound SQLite backup.

No rollout, service installation, or live restart is implied by source changes. Activating a new primary Runtime release still requires separate explicit authorization and exact release evidence.
