# Operations

Use this page to choose the right operational path. Avoid replaying writes merely because a request timed out; first inspect durable Work, Job, Run, and runtime state.

## Normal checks

1. Confirm the selected repository and checkout.
2. Check Controller and repository readiness.
3. Inspect active Work or Jobs before retrying an operation.
4. Run the smallest focused validation first.
5. Record exact evidence before finalizing or releasing.

## Runtime incidents

- Primary MCP unavailable but recovery reachable: use the independent recovery channel to verify Supervisor, ingress, Gateway, and MCP separately.
- External 502/503: distinguish tunnel transport, stable ingress, Gateway, and MCP failures before restarting anything.
- Release drift: stop rollout and compare source commit, immutable manifest, service definition, active slot, and running process revision.
- Stuck work: use watchdog and maintenance diagnostics before deleting state or killing processes.

## Detailed runbooks

- [Controller reliability](https://github.com/moretea-labs/matea/blob/main/docs/operations/controller-reliability-runbook.md)
- [Stable Supervisor](https://github.com/moretea-labs/matea/blob/main/docs/operations/stable-external-runtime-supervisor.md)
- [Standalone recovery](https://github.com/moretea-labs/matea/blob/main/docs/operations/standalone-disaster-recovery.md)
- [502 and performance](https://github.com/moretea-labs/matea/blob/main/docs/operations/controller-performance-and-502.md)
- [Troubleshooting](Troubleshooting)
- [Release process](Releases-and-Upgrades)
