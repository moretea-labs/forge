# Runtime Architecture Guardrails

This document is normative for changes to the repo-harness runtime, deployment, recovery, health, and status models.

## Product constraints

Repo-harness is a local MCP application. A bounded interruption during restart or upgrade is acceptable. The primary objective is deterministic whole-system recovery, not zero-downtime continuity for each internal process.

The default deployment model is:

```text
launchd
  └── repo-harness-runtime
       ├── MCP transport and gateway modules
       ├── controller and scheduler modules
       ├── SQLite control plane
       └── isolated worker process groups
```

A short-lived updater may be used for self-update transactions. It is not a resident service, health owner, or second control plane.

## One application, one deployment unit

- Gateway, MCP transport, Controller, Scheduler, configuration, runtime code, and schema compatibility belong to one Runtime release and one lifecycle.
- Code modules may remain separated internally. They must not become independently deployable, independently versioned, independently restarted, or independently rolled back without a proven isolation requirement.
- Independent processes are reserved for real security, resource, crash, or incompatible-runtime isolation. Workers are the default valid example.
- Component-level rollout, component-level rollback, and cross-release adoption are forbidden by default.
- Prefer `stop -> switch complete release -> start -> verify -> full rollback` over ingress routing, blue/green slots, process adoption, or mixed generations.

## Architecture subtraction before addition

An incident is not sufficient justification for another daemon, proxy, keepalive wrapper, watchdog, recovery owner, state store, compatibility fallback, or status enum.

Before adding a layer or state:

1. Identify the violated system invariant and the root cause.
2. Show why deleting, merging, or correcting an existing layer cannot solve it.
3. Show why an existing fact, event, error reason, metric, or diagnostic check cannot represent it.
4. Define one owner, one source of truth, complete lifecycle, shutdown behavior, rollback behavior, and deletion criterion.
5. Provide failure-injection tests for creation, transition, crash, restart, and cleanup.
6. Record the net complexity change. A change that expands the architecture after an incident requires an explicit architecture decision and a removal plan for superseded paths.

Temporary compatibility behavior must have an owner, expiry condition, removal issue, and test proving the canonical path does not depend on it.

## Readiness is a conclusion, not a family of state machines

Keep these concepts separate:

- **Lifecycle:** whether the Runtime is starting, running, stopping, or stopped. A failure is recorded as evidence and a reason for the terminal lifecycle result; it is not a parallel readiness mode.
- **Readiness:** one derived boolean answering whether the complete MCP system can safely accept its supported work.
- **Liveness:** an ephemeral observation used by the OS or the Runtime to decide whether the one root Runtime process is making progress.
- **Diagnostics:** computed checks, evidence, timestamps, and reason codes explaining readiness or failure.

A readiness response may contain multiple computed checks, for example:

```json
{
  "ready": false,
  "reasonCodes": ["SCHEDULER_STALLED"],
  "checks": {
    "controlPlane": "pass",
    "scheduler": "fail",
    "releaseCoherence": "pass",
    "mcpEndToEnd": "unknown"
  },
  "observedAt": "..."
}
```

The check names are not durable statuses and do not own transitions. Do not create persisted fields such as `transportReady`, `gatewayReady`, `daemonReady`, `schedulerReady`, `workerPlaneReady`, or `publicEndpointReady` as independent state machines.

Additional rules:

- A check is derived from authoritative facts whenever possible; it is not another authority file.
- `unknown` means evidence was not available. It must not silently become success or trigger destructive recovery.
- An idle system with zero Workers can still be ready. Worker capacity is evaluated when work requiring a Worker is accepted.
- Optional tunnels, public endpoints, local UI, and external connectors do not determine core local MCP readiness.
- A temporary probe timeout reports degraded evidence first. It does not directly restart a component.
- Recovery tools may remain available through a bounded local CLI or updater path; do not model `recovery_only` as another long-lived Runtime generation merely to preserve an endpoint.

## State addition gate

A new durable state or enum value is allowed only when all of the following are true:

- It changes externally visible behavior or is required to resume an interrupted durable transaction.
- It cannot be derived from existing authoritative facts.
- Exactly one component owns every transition.
- The transition table, terminal states, invalid transitions, and crash recovery are documented.
- The state has bounded retention and an explicit cleanup path.
- Upgrade and downgrade compatibility are defined.
- Tests cover every transition and interruption point.

Otherwise use an event, reason code, diagnostic check, timestamp, metric, or log entry.

Do not combine lifecycle, health, capability, authorization, release identity, and recovery intent in one overloaded status field. Do not add a boolean beside an enum to create undocumented composite states such as `status=ready` plus `degraded=true`.

## Process and recovery ownership

- There is exactly one side-effecting Runtime lifecycle owner.
- Observers and probes are read-only. They report facts or submit a typed request to the owner; they do not independently start, kill, adopt, switch, or roll back components.
- `launchd` owns restart of the one root Runtime or a minimal stable launcher.
- The Runtime owns Worker process groups and must terminate or fence them on shutdown or owner loss.
- Process identity must not be inferred from a port, process name, current working directory, or protocol compatibility.
- Runtime role, release, Controller Home, configuration, and executable identity must be explicit and fail closed when absent.

## Release and rollback unit

A release transaction covers the complete system identity:

- runtime code and executable artifacts;
- MCP/Gateway/Controller modules;
- configuration manifest;
- startup entrypoint and arguments;
- Controller Home expectations;
- database schema compatibility or paired database backup;
- Worker protocol compatibility.

Rollback restores the whole compatible release. It must not preserve or adopt selected old components. If a schema migration prevents the previous release from reading the database, rollback includes restoring the database backup associated with the same activation transaction.

## Required review questions

Any proposal adding a process, service, persistent status, health mode, projection, authority file, restart path, recovery tool, or compatibility fallback must answer:

1. What user-visible requirement requires it?
2. Why is the current single Runtime unable to satisfy that requirement?
3. What existing layer or state will be removed?
4. Who is the sole lifecycle and transition owner?
5. What is the authoritative source of truth?
6. What happens during crash, machine restart, partial update, and rollback?
7. How is stale state or a stale process fenced and deleted?
8. What test proves whole-system MCP availability rather than local component health?
9. Under what condition will this addition be removed?

If these questions do not have concrete answers, do not add the layer or state.

## Verification focus

Prefer whole-system tests over component-survival tests:

- kill and restart the complete Runtime;
- restart during an MCP request;
- restart with queued and running work;
- force a Worker or child process to refuse termination;
- occupy the MCP port with an unrelated process;
- corrupt or interrupt an update transaction;
- fail startup after a schema migration;
- reboot and recover from persisted state;
- inject intermittent probe timeouts;
- verify full release and database rollback;
- verify no old Gateway, Controller, ingress, keepalive, or recovery owner survives the Runtime generation.

A component reporting healthy is evidence only. Success means the complete supported MCP path works and the system converges to one coherent Runtime release.