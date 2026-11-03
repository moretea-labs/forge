# Bounded Recovery tool execution

Recovery HTTP/MCP must remain responsive while a tool hashes release artifacts,
verifies a backup, or runs a build. These synchronous operations previously ran
inside the Gateway event loop. Recovery remains one persistent service and one
mutation authority; no new daemon, watchdog, queue or durable state is introduced.

The Gateway extends its existing bounded-child execution boundary with the
internal `__execute-recovery-tool` command in the same attested Recovery release.
Each invocation carries one UTF-8 JSON `{name,args}` request through stdin
(64 KiB maximum), accepts only an advertised Recovery tool, and returns one
versioned `{schemaVersion:1,ok,value|error}` JSON envelope. Tool arguments never
enter argv. The Gateway pins its validated release path at startup, so a later
`current` link change cannot mix the serving Gateway with another worker version.

Admission allows one heavy tool plus two status/history reads, with no waiting
queue. Excess work fails before spawn. Status workers have a 10-second wall
budget, heavy workers 15 minutes, and output is bounded to 1 MiB. Existing child
supervision cleans owned process groups. HTTP health and discovery remain in the
Gateway and do not consume a tool slot.

Children execute through the unchanged Recovery dispatch, request identities,
operation lock, effect journals and release CAS fences. A broken/truncated worker
response or timeout is an unknown outcome, never permission to replay a mutation.
No request is automatically retried. A Gateway restart does not invalidate a live
child's operation lock; a new Gateway still consults the same existing authority.
Only transient admission counters are local to the Gateway; no second progress or
recovery store is written.

Packaging must compile Gateway and internal worker command into the same immutable
Recovery executable. Activation and rollback use the existing whole Recovery
release owner, drain and verification path. Source validation alone does not prove
that an installed service is using these limits. The focused Recovery regressions
prove saturation, reserved status capacity, unknown-outcome no-replay, and HTTP
health response during a real CPU-heavy child.
