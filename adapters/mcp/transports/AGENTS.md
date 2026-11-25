# Functional Block Agent Context

Keep this file focused on the local contract for this primary functional block.

<!-- BEGIN LOCAL SOURCE CONTRACT -->
## Local Source Contract

- Functional block: `adapters/mcp/transports`
- Capability ID: `mcp-http-transport-lifecycle`
- Entrypoint: `adapters/mcp/transports`
- Authority: current source/public APIs/static checks/tests plus the project Requirement/Issue; no repo-local architecture document or event ledger is required.
- Allowed dependencies: follow root `AGENTS.md` / `CLAUDE.md` and preserve real path, permission, resource, process, Git/CAS, and effect-safety boundaries.
- Verification: `bun test tests/cli/mcp-http.test.ts`
<!-- END LOCAL SOURCE CONTRACT -->
