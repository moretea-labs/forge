# Controller Utility Console frontend redesign

Status: Approved
Date: 2026-08-12

## Objective
Replace the monolithic Local Bridge dashboard with a real maintainable frontend aligned with ChatGPT-first Forge usage. The GUI is an auxiliary configuration and state console, not the primary task-execution surface.

## Product decisions
- ChatGPT remains the primary interaction, result-delivery, and decision surface.
- GUI owns durable configuration and coarse state: Overview, Work, Automations, Capabilities, Repositories, Settings, System.
- Do not fabricate execution percentages or mirror verbose run output.
- Automation UI manages configured policies/routines and coarse occurrence state; delivered content stays in ChatGPT/email/provider surfaces.
- Capabilities present plugins, providers, local tools, and integrations by user capability; raw actions are secondary.
- Repository Registry is global. A repository may be selected as an operation scope, but the product has no global "current repository" identity.
- System/runtime diagnostics are low-frequency and live under System.

## Design
Use Google Labs DESIGN.md as the repository-level desktop UI design contract. Visual direction: Quiet Technical Utility — neutral tonal hierarchy, one restrained blue accent, minimal elevation, compact spacing, small status indicators, and progressive disclosure for internals.

## Implementation
1. Add repository-owned `DESIGN.md`.
2. Add modular browser source under `src/cli/local-bridge/ui/`.
3. Bundle browser TypeScript with Bun into `src/cli/local-bridge/ui-dist/`; no new UI framework/runtime dependency.
4. Reduce `dashboard.ts` to a bootstrap document.
5. Serve UI assets separately from the authenticated `/api` surface.
6. Add a first-class aggregate Automations projection over Forge Schedule + Assistant Routine state.
7. Reuse existing plugin/provider/tool/readiness/repository APIs and move them into the new information architecture.
8. Update focused Local Bridge tests and architecture-facing UI wording.
9. Build, lint DESIGN.md, typecheck, run focused tests, review diff, commit, merge, and clean the worktree.

## Acceptance
- No monolithic page implementation remains in `dashboard.ts`.
- Browser source is split by API, types, components, routing/application shell, styles, and page modules.
- Local Bridge serves the new console and its built assets.
- Automations is distinct from provider/model settings.
- Useful plugin/provider/repository/readiness controls remain accessible.
- No fake percentage progress or verbose execution-result dashboard is introduced.
- DESIGN.md passes the Google Labs linter.
- Focused Local Bridge tests and TypeScript checks pass.
