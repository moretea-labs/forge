# Runtime Directory Map

> Status: **Runtime Authority**

```text
src/runtime/
  root/                        Canonical Runtime root lifecycle, readiness and write fencing
  release/                     Whole-release identity, active/previous selection and rollback metadata
  standalone-recovery/         Independent diagnostics, service repair and offline whole-Runtime rollback
  gateway/mcp/                 Thin command admission, policy and runtime tools
  control-plane/
    global-scheduler/          Global fairness, quotas, process dispatch and reconciliation
    repo-actor/                Repository-local single-owner scheduling
    governance/                External side-effect and requirement-growth policy
  workflow/
    schedules/                 Trigger, bounded Occurrence, persisted Decision and backoff
    portfolio/                 Cross-repository DAG and Saga
    findings/                  Deduplicated Candidate Finding and explicit promotion
  plugins/                     Derived manifests, discovery registry, policy-typed actions and provider adapters
  execution/
    jobs/                      Durable Job schema, indexes, Operation Receipts and compatibility projection
    workers/                   Isolated one-Job process execution
    thin-harness/              Fast Path router, latency trace, receipts, typed batch, lightweight lanes
  resources/
    claims/                    Conflict taxonomy and conservative unknown scope
    leases/                    Lease, renewal, release and fencing
  evidence/                    Unified events, exact-revision evidence and bounded Artifacts
  projections/                 Dirty-marker invalidated materialized read models
  release/                     Release freeze, gate and manifest
  shared/                      Atomic file and portable Node TypeScript-loader utilities
```

`src/cli/` contains the Forge CLI, MCP adapter surface and bounded internal operation implementations. It is not a second lifecycle owner. Gateway handlers admit and route work; the Runtime Root, Process Runtime and bounded Workers own execution.

When Controller Home explicitly enables the Local Bridge without selecting external `standalone` or `remote` mode, `src/runtime/root/local-bridge.ts` starts that HTTP UI/API as an in-process module of the Canonical Runtime and closes it before releasing Runtime ownership. Its compatibility projection may describe the endpoint, but it is not a separate process, launch service, readiness authority, or recovery owner.

New scheduling ownership must be added under `src/runtime/`, never inside MCP transport handlers.

## Runtime Storage Ownership and Quarantine

Each bound directory under Controller Home contains `.forge-owner.json` with `repoId`, binding name, and management identity. Repository-local `.ai/harness/<binding>` paths are links to these owned directories.

Migration tooling may quarantine pre-cutover state for offline inspection under:

```text
<controller-home>/repositories/<repoId>/quarantine/runtime-storage/<binding>/
```

Execution readiness remains false for active/unreadable Run or Local Job state and for non-directory/path conflicts. A non-empty worktree directory by itself is not a reason to perform an unsafe move or to block forever.
