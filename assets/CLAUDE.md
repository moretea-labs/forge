# Functional Block Agent Context

Keep this file focused on the local contract for this primary functional block.

<!-- BEGIN CAPABILITY CONTEXT -->
## Capability Context

- Capability ID: `workflow-engine-contract-assets`
- Domain: `workflow-engine`
- Name: `contract-assets`
- Primary prefix: `assets/workflow-contract.v1.json`

## Positioning

Owns packaged workflow/compatibility contract assets. Mutable execution lifecycle is Controller Home authority; assets must not reintroduce repo-local machine workflow state.

## Source Map

- Primary prefix: `assets/workflow-contract.v1.json` (entrypoint)

## Refresh Hints

- `bun test tests/workflow-contract.test.ts tests/scaffold-parity.test.ts`
- `bun scripts/capability-resolver.ts validate --format text`
<!-- END CAPABILITY CONTEXT -->

<!-- BEGIN LOCAL SOURCE CONTRACT -->
## Local Source Contract

- Functional block: `assets/workflow-contract.v1.json`
- Capability ID: `workflow-engine-contract-assets`
- Entrypoint: `assets/workflow-contract.v1.json`
- Authority: current source/public APIs/static checks/tests plus the project Requirement/Issue; no repo-local architecture document or event ledger is required.
- Allowed dependencies: follow root `AGENTS.md` / `CLAUDE.md` and preserve real path, permission, resource, process, Git/CAS, and effect-safety boundaries.
- Verification: `bun test tests/workflow-contract.test.ts tests/scaffold-parity.test.ts`
<!-- END LOCAL SOURCE CONTRACT -->
