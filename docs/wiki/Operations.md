# Operations

Use this page to choose the right operational path. Avoid replaying writes merely because a request timed out; first inspect durable Work, Job, Run, and runtime state.

## Normal checks

1. Confirm the selected repository and checkout.
2. Check Controller and repository readiness.
3. Inspect active Work or Jobs before retrying an operation.
4. Run the smallest focused validation first.
5. Record exact evidence before finalizing or releasing.

## Runtime incidents

- Primary MCP unavailable but Recovery reachable: use the independent Recovery channel to verify the Forge Runtime service, local endpoint, authenticated MCP flow, and external tunnel separately.
- External 502/503: distinguish tunnel transport, local Runtime health, and authenticated MCP failures before restarting anything.
- Release drift: stop activation and compare source commit, immutable whole-release manifest, service definition, release authority, SQLite backup binding, and running Runtime revision.
- Stuck work: use watchdog and maintenance diagnostics before deleting state or killing processes.

## Detailed runbooks

- [Controller reliability](https://github.com/moretea-labs/forge/blob/main/docs/operations/controller-reliability-runbook.md)
- [Standalone recovery](https://github.com/moretea-labs/forge/blob/main/docs/operations/standalone-disaster-recovery.md)
- [502 and performance](https://github.com/moretea-labs/forge/blob/main/docs/operations/controller-performance-and-502.md)
- [Troubleshooting](Troubleshooting)
- [Release process](Releases-and-Upgrades)
