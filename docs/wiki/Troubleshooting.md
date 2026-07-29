# Troubleshooting

## Start with layer separation

1. Is the repository and checkout correct?
2. Is the Controller healthy?
3. Is the stable ingress healthy?
4. Is the active Gateway healthy?
5. Does MCP initialize and list tools?
6. Is the external tunnel reachable?

A single 502 does not identify which layer failed.

## Request timed out

Check the durable Work, Job, Run, or managed process before retrying. Replaying a write can create duplicate effects even when the original HTTP request failed.

## External 502 or 503

Compare local ingress health with external MCP health. A tunnel process can remain alive after all data-plane connections are lost. Confirm the active transport and registered HA connections, then verify the authenticated MCP flow.

## Gateway repeatedly restarts

Inspect immutable release contents, entrypoints, process liveness, and revision coherence. Do not keep restarting a release that cannot cold-start; preserve evidence and switch only through the Supervisor's bounded rollout or rollback path.

## Release mismatch

Compare the canonical source commit, manifest revision, active slot, installed service definition, Supervisor, Controller Daemon, and Gateway. Short hashes are not sufficient release identity.

## Recovery cannot roll back

A previous release must have exact path, revision, and manifest evidence recorded as known-good. Never weaken matching merely to force a rollback.

Detailed guides:

- [General troubleshooting](https://github.com/moretea-labs/matea/blob/main/docs/operations/troubleshooting.md)
- [Controller reliability](https://github.com/moretea-labs/matea/blob/main/docs/operations/controller-reliability-runbook.md)
- [502 and performance](https://github.com/moretea-labs/matea/blob/main/docs/operations/controller-performance-and-502.md)
