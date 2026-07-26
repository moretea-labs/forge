# Standalone disaster recovery

`repo-harness-recovery` is a compiled, fixed-command recovery binary installed below the stable Controller Home. It communicates only with the Stable Supervisor control socket and stores its own lock, known-good evidence, quarantine, and audit data below `controller-home/recovery/`.

It never accepts a release path or arbitrary command. `rollback-previous` proceeds only when the active release is not already known-good and the Supervisor-registered previous slot exactly matches an independently attested manifest hash. A request against an already known-good active release succeeds as a no-op.

The independent gateway listens only on `127.0.0.1`, exposes a seven-tool MCP surface, requires a separate scoped bearer credential, has bounded mutation rate limiting, and does not use the primary gateway or its ingress proxy. The credential file is mode `0600` and must never be copied into logs or source control. The gateway accepts both `/mcp` and `/recovery/mcp` so a path-scoped Tailscale Funnel can expose recovery without replacing the primary ingress path.

Install the immutable local artifact with:

```sh
bun scripts/install-standalone-recovery.ts --controller-home /absolute/controller-home
```

The installer writes launchd plists that start through `/usr/bin/env -i` with a minimal `PATH`, so the recovery gateway and watchdog do not inherit unrelated session credentials. They can be loaded as user LaunchAgents for local operation or installed as system LaunchDaemons after an administrator-authorized system operation.

When Tailscale Funnel is available, expose the recovery gateway under a path that is independent from the primary root mapping:

```sh
tailscale funnel --bg --yes --https=443 --set-path /recovery http://127.0.0.1:8787
```

The resulting ChatGPT Recovery Connector endpoint is:

```text
https://<tailscale-host>.<tailnet>.ts.net/recovery/mcp
```

A ChatGPT Recovery Connector remains a separate provisioning step because creating the Connector may require interactive browser OAuth/MFA and stores a persistent external credential.

The watchdog policy requires six failed observations over at least thirty seconds, two independent evidence classes, no ongoing operation, an un-attested active release, and an attested Supervisor-registered previous release. One short outage only enters `degraded`.
