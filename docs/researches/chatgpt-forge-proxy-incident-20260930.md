# ChatGPT / Forge proxy incident, 2026-09-30

## Verified local cause and correction

The shell proxy configuration used Shadowrocket at `127.0.0.1:7900`, while
the macOS system/browser proxy used Clash Verge at `127.0.0.1:7897`.
A request to `https://api.openai.com/v1/tunnels` through 7900 failed during
CONNECT with HTTP 503, before establishing TLS to OpenAI. The same request
through 7897 established CONNECT and received the expected unauthenticated
HTTP 401. Direct access failed its TLS handshake on this network.

The existing user-owned `~/.config/proxy/env.sh` was corrected to use 7897
for HTTP, HTTPS, and SOCKS. Uppercase and lowercase launchd proxy variables
were synchronized to that endpoint. No credentials or account identity changed.
Already-running applications may retain their inherited environment.

Authenticated tunnel-client checks then successfully retrieved both the
`forge-current` and `forge-recovery` remote tunnel records. Forge verification
passed local Runtime, Connector, both tunnel-control-plane queries, MCP
initialize, tools-list, read-only call, and session close. The manual Recovery
install profile reports a disabled monitor; a separate watchdog probe warning
does not establish a Runtime outage.

Recovery was verified running source `14b619d55`; the previous Runtime release
session was resolved to `known_good` through the canonical Recovery command.
The next session, `release-1790776411233-4a3e2dcc78c443d8`, passed frozen-source
static and candidate gates and cut over source `4ec763376` on
2026-09-30T13:57:54Z. This includes the empty-project-alias correction and its
existing contract coverage. At initial post-cutover observation `/ready`
returned HTTP 200 with database, scheduler, release coherence, and MCP passing.
The session reached `known_good` at 2026-09-30T13:59:30Z after independent
Runtime/performance verification and recoverable release/SQLite attestation.
The remote Forge Recovery MCP tool itself succeeded at 2026-09-30T14:00:04Z,
reporting the exact new release live, ready, and non-stale.

## Authenticated browser evidence and remaining limit

The screenshot's signed-in browser is Vivaldi, not Chrome. Its existing Forge
conversation was inspected without submitting a prompt. An empty composer and
absence of active generation were checked before one reload.

Fresh page traffic included HTTP 200 for account/model/project endpoints,
the current conversation stream-status endpoint, and the ordinary conversation
list excluding `conversation_origin=tpp`. The list including
`conversation_origin=tpp` still returned HTTP 429.

One authenticated, read-only request in the existing browser identity at
2026-09-30T13:56:32Z confirmed that endpoint's response:

```json
{"detail":"Too many requests"}
```

No `Retry-After` was exposed. Temporary response instrumentation was removed.
The response proves an endpoint rate limit, not an account downgrade. The
cause/scope of this remaining server response is unknown; the successful
other endpoints and local proxy repair do not prove that it has been fixed.
Do not attribute the proxy's CONNECT 503 to an OpenAI service outage or claim
that the separate project-alias contract correction resolves HTTP 429.

## Supervisor successor reservation defect

A later live 30-second log window observed 15 additional
`WORKFLOW_SUPERVISOR_EFFECT_RESERVE_FAILED` errors. One committed CONTINUE had
no successor, while its lower relay was dispatching with a canonical provider
effect ID equal to the already-applied completion source effect ID. Reserving
the same primary key under a different completion origin could not succeed.

The existing round-budget recovery test was extended to perform lower-layer
settlement before successor reconciliation, representing a crash between those
operations. It reproduced the exact reservation error before correction. The
composition now omits the lower-layer ID when it equals the completion source,
allowing Supervisor to derive its stable successor ID from the completion
fingerprint. This preserves effect ownership and idempotency without rewriting
historical records, adding a retry loop, or replaying the applied source.
