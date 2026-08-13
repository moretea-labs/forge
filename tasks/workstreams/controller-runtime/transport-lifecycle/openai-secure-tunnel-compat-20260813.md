# OpenAI Secure MCP Tunnel compatibility — 2026-08-13

- Evidence: ChatGPT Secure MCP Tunnel probes `server/discover` before legacy initialization; Forge 1.x MCP currently misclassifies that sessionless probe as `MCP_SESSION_REQUIRED` / HTTP 400.
- Decision: keep the existing legacy stateful MCP transport for this bounded slice and return the protocol-compatible HTTP 404 JSON-RPC `-32601 Method not found` response so modern clients can fall back cleanly.
- Performance evidence: isolated Secure Tunnel calls measured ~636 ms for `repository_get` and ~660 ms for the larger `repository_list`; no payload-size regression was reproduced, so response-shape changes are explicitly out of scope.
- Acceptance: authenticated `server/discover` returns 404/-32601 without allocating a session; legacy initialize remains successful; focused MCP HTTP and compatibility/runtime architecture checks pass.
