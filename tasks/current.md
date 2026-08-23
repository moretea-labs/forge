# Current Status Snapshot

<!-- updated_at: 2026-08-22 -->
<!-- stale_after: 24h -->

> **Status**: Architecture convergence source changes integrated on `main`; documentation synchronization is the final local convergence slice.
> **Updated At**: 2026-08-22
> **Source Branch**: main
> **Target Branch**: main
> **Derived From**: Git history, `docs/architecture/CURRENT.md`, focused checks, and current working-tree state
> **Stale After**: 24h

This file is an orientation snapshot, not an execution gate or lifecycle authority.

## Integrated convergence blocks

- `7f699b0d` — retired duplicate Kernel authorities including assistant, autonomous goal-loop, personal-assistant, findings/portfolio/goal-registry, and MCP resource-policy ownership.
- `61ea8971` — converged the thin execution and context hot paths: Ephemeral Direct, Lightweight Managed, and Durable boundaries; process attach does not replay commands.
- `029e0e91` — added the isolated evaluation framework for measurable architecture/behavior regressions without creating a second Runtime.
- `3840435e` — retired legacy harness workflow authority and removed more than four thousand lines of obsolete triage/trace/ceremony code while preserving migration cleanup compatibility.
- `7848f5f1` — aligned test governance and added readonly fast-path coverage for very dirty worktrees.

## Verified evidence

- Runtime architecture: 37/37 contract checks passed during Kernel convergence.
- TypeScript typecheck passed after runtime/controller and evaluation integration.
- Harness bootstrap: 16/16 passed.
- Workflow strict check passed; stale local resume packets were correctly classified as generated-runtime remediation, not source failure.
- Harness/workflow focused regressions: 147/147 passed.
- Evaluation framework: 3/3 passed.
- Test governance manifest: 122 registered test files valid; focused residual regressions 7/7 passed.
- Architecture v2 gate alignment: the redundant Process Runtime case that expected `gh issue comment` to execute through an ordinary Process lane was retired; the remaining focused Process Runtime suite passes 77/77 and the lifecycle regression preserves `durable + not_started + never_auto_retry` without Process or Lease state. Stale exact Scheduler source-text assertions and a duplicate setup-session case whose expectation contradicted the documented `FORGE_CONTROLLER_HOME` override were also retired; direct runtime architecture, Controller Home, and behavior coverage remain authoritative.
- Public documentation check passed again after the final documentation correction.
- Recovery OAuth tunnel interoperability: the Bearer challenge now reports `invalid_token`, and configured public Recovery URLs remain the OAuth resource/issuer origin even when the local probe uses loopback. The focused Recovery suite passes 41/41, the public PKCE/MCP verification passes, and both OpenAI Secure MCP Tunnel runtimes report ready.
- Package Runtime launchd recovery: a package release failed with exit 127 because its generated launcher used `#!/usr/bin/env node` under launchd's system-only PATH. Production was restored by atomically activating a rebuilt immutable `ab6b563d` release; whole-Runtime, public OAuth challenge, and authenticated MCP lifecycle verification passed. The package launcher now pins the absolute installer executable, with a minimal-launchd-PATH regression in `forge-runtime-service.test.ts`.

## Current architecture direction

Current source should preserve one canonical Runtime/release authority, Direct-first ordinary execution, bounded progressive context retrieval, optional Work/Plan for real continuity, typed external-effect boundaries, and tests/reviews as evidence rather than parallel authorities. See `docs/architecture/CURRENT.md` for the maintained contract.
