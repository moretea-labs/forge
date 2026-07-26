# Standalone disaster recovery

`repo-harness-recovery` is a compiled, fixed-command recovery binary installed below the stable Controller Home. It communicates only with the Stable Supervisor control socket and stores its own lock, known-good evidence, quarantine, and audit data below `controller-home/recovery/`.

It never accepts a release path or arbitrary command. `rollback-previous` proceeds only when the active release is not already known-good and the Supervisor-registered previous slot exactly matches an independently attested manifest hash. A request against an already known-good active release succeeds as a no-op.

The independent gateway listens only on `127.0.0.1`, exposes a seven-tool MCP surface, requires a separate scoped bearer credential, has bounded mutation rate limiting, and does not use the primary gateway or its ingress proxy. The credential file is mode `0600` and must never be copied into logs or source control.

Install the immutable local artifact with:

```sh
bun scripts/install-standalone-recovery.ts --controller-home /absolute/controller-home
```

The installer intentionally writes, but does not bootstrap, the system LaunchDaemon plist. Bootstrap requires an administrator-authorized, explicit system operation. A Tailscale Funnel and a ChatGPT Recovery Connector remain separate provisioning steps because a public Funnel requires an independently configured authentication method and the Connector may require interactive MFA.

The watchdog policy requires six failed observations over at least thirty seconds, two independent evidence classes, no ongoing operation, an un-attested active release, and an attested Supervisor-registered previous release. One short outage only enters `degraded`.
