# Troubleshooting

## Start with layer separation

1. Is the repository and checkout correct?
2. Is the canonical Forge Runtime running and ready?
3. Does the in-process Gateway and MCP transport answer locally?
4. Does MCP initialize and list tools with the expected release identity?
5. Is the optional external tunnel reachable?
6. What does standalone Recovery report for restart attempts and release coherence?

A single 502 does not identify which layer failed.

## Request timed out

Check the durable Work, Job, Run, or managed process before retrying. Replaying a write can create duplicate effects even when the original HTTP request failed.

## External 502 or 503

Compare the local Forge Runtime MCP endpoint with external MCP health. A tunnel process can remain alive after all data-plane connections are lost. Confirm local authenticated MCP first, then inspect the configured tunnel and its registered connections.

## Runtime repeatedly restarts

Inspect the immutable active release, service runner, Runtime ownership, release authority, database compatibility, Worker protocol, and Recovery audit. The watchdog performs only bounded whole-Runtime restart attempts. After exhaustion it may restore an independently attested previous release; it never loops indefinitely or restarts individual components.

## Release mismatch

Compare the canonical source commit, manifest hash, active whole-release authority, installed Forge service definition, Runtime instance, database schema compatibility, Worker protocol, and authenticated MCP tool fingerprint. Short hashes are not sufficient release identity.

## Recovery cannot roll back

A previous release must have exact path, release ID, artifact identity, manifest hash, Worker protocol, bound SQLite backup, and independent known-good attestation. Automatic recovery must also prove the current Runtime stopped before restoration. Never weaken matching merely to force a rollback.

Detailed guides:

- [General troubleshooting](https://github.com/moretea-labs/forge/blob/main/docs/operations/troubleshooting.md)
- [Controller reliability](https://github.com/moretea-labs/forge/blob/main/docs/operations/controller-reliability-runbook.md)
- [502 and performance](https://github.com/moretea-labs/forge/blob/main/docs/operations/controller-performance-and-502.md)
