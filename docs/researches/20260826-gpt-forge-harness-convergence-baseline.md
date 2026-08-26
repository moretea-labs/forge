# GPT–Forge Harness Convergence Baseline — 2026-08-26

## Purpose

Record the starting point for `PLAN-gpt-forge-harness-convergence-20260826-r1`. This is evidence, not a second architecture authority. `docs/architecture/CURRENT.md` remains the architecture contract and `docs/ROADMAP.md` remains the maintained priority surface.

## Fixed authority boundary

- GPT is the only semantic controller: requirement interpretation, repository understanding, implementation decisions, semantic review, and keep-exploring/accept decisions remain model-owned.
- Forge is deterministic execution infrastructure: context retrieval, repository/provider execution, edit transactions, checks, evidence, ownership, continuity, scheduling, recovery, and release fencing.
- No Codex/Claude/Grok implementation worker is part of the convergence direction.
- Performance work may combine deterministic operations but may not hide a semantic branch inside Forge.

## Controller/runtime snapshot

Observed on the Forge repository at main `fdc760e0aa1699ec7443598e8926ee94a47c8164`:

- stable MCP surface: 19/19 tools;
- source coherence: ready;
- execution readiness: ready;
- release readiness: blocked by active-job attention;
- active primary Work before this convergence step: 11;
- executing primary Work: 4;
- waiting primary Work: 7;
- active child Process count: 0;
- pending semantic handoff at snapshot: 1;
- maintenance candidates: 5.

The 11 pre-existing active Works classify as:

| Class | Count | Work / purpose |
| --- | ---: | --- |
| Intentionally persistent workflows | 2 | Gmail daily organization/digest; Gmail authentication health |
| Browser Runtime V2 | 1 | reviewed contract reapply/verification, subsequently replanned from r6 to r7 after semantic review |
| Release convergence | 2 | public-release scanner false-positive repair; final release-readiness verification |
| Harness/runtime correctness repairs | 5 | iOS lightweight runtime loader identity; Work-bound edit validation receipt identity; PlanContract direct-delivery lifecycle; finalizer target-advancement attribution; iOS physical-device capability manifest exposure |
| External Forge infrastructure | 1 | persistent Google Cloud VM egress/tunnel recovery |

This is not yet a clean closure portfolio: most entries are justified, but multiple independent correctness repairs are simultaneously open and release readiness is therefore not a stable terminal signal.

## Browser V2 handoff review

The prior `PLAN-browser-runtime-v2-20260826-r6` contract step failed `package:check:task` only at test-governance validation. Focused evidence showed:

- `tests/runtime/browser-runtime-contract.test.ts`: 5 pass / 0 fail;
- TypeScript compile: pass;
- old frozen source was missing test-manifest registration for `tests/runtime/semantic-navigation-provider.test.ts`, while current main already contains that registration in commit `26a0db39`;
- the Browser contract's own new test also required governed registration.

The correct semantic decision was **replan, not retry and not roll back Browser V2**. r6 was superseded by `PLAN-browser-runtime-v2-20260826-r7` on current coherent main, preserving reviewed delivery `d7cf3c5a` and adding only the required test-manifest registration before governed verification.

## Preliminary control-plane latency observations

Controller-observed server durations from the review round show the transport/control-plane scale before optimization:

| Operation | Observed server duration |
| --- | ---: |
| `rh_status(detail)` | ~1451 ms |
| `rh_work(plan_list)` | ~83 ms |
| `rh_inbox(list)` | ~74 ms |
| `rh_context(work review)` | ~2491 ms |
| ordinary readonly repository commands | roughly 95–750 ms in sampled calls |
| Plan creation | ~167 ms |
| recoverable Work start | ~699 ms |

The practical performance metric is not any one API latency. The target is the number and total wall-clock cost of controller↔Forge exchanges needed to cross one semantic checkpoint or finish one coherent implementation slice.

## Reproducible repository-facade baseline

A current-source benchmark was executed on revision `fdc760e0aa1699ec7443598e8926ee94a47c8164` with:

```bash
bun scripts/benchmark-thin-harness-gateway-ab.ts --json --label gpt-forge-convergence-baseline
```

The benchmark creates and destroys its own temporary Git repository, performs one warmup plus three measured runs, reports the median, and does not mutate the Forge source checkout. It exercises the existing repository facade/execution kernel rather than a synthetic replacement.

| Baseline scenario | Controller/facade exchanges represented | Median wall clock | Interpretation |
| --- | ---: | ---: | --- |
| simple bounded edit (`bounded_patch`) | 1 | 101.07 ms | one real bounded replace through the current mutation path |
| deterministic feature-context fan-in (`7_step_batch_facade`) | 1 | 67.90 ms | seven mechanical read/search/diff/status/revision steps collapsed into one facade exchange |
| focused post-edit repository command (`focused_command_facade`) | 1 | 29.16 ms | one focused repository command used as a post-edit state observation |

A reproducible feature-like mechanical slice is therefore **3 facade exchanges** — context/impact fan-in → bounded patch → post-edit state observation — with a summed median operation wall time of **198.13 ms** in the disposable fixture. This number intentionally excludes GPT reasoning time, network/client transport outside the in-process facade benchmark, and a real project check; those remain separate costs at semantic/acceptance boundaries. The benchmark reported all cases successful with zero Execution Jobs, zero Local Jobs, zero workers, zero Runtime events, zero projection invalidations, and zero Scheduler wakes.

This is the baseline to improve, not evidence that three exchanges are always sufficient. A real feature may still require an additional selected check and a GPT semantic decision when validation or impact evidence introduces a genuine branch.

## Round-trip target and benchmark shape

Initial targets:

- simple coherent edit: no more than 3 controller↔Forge exchanges absent a genuine semantic surprise;
- ordinary coherent feature slice: no more than 6 exchanges absent a genuine semantic surprise.

A representative benchmark must measure at least:

1. context acquisition fan-in;
2. semantic decision by GPT;
3. coherent patch + selected validation;
4. deterministic structured failure evidence if validation fails;
5. one GPT repair decision if required;
6. final verification + semantic acceptance.

The benchmark must count semantic checkpoints separately from internal deterministic sub-operations. Reducing calls by moving semantic reasoning into Forge is invalid.

## Convergence tracks

1. **Portfolio baseline and closure** — classify/finish existing Work, clear pending semantic handoffs, restore meaningful release readiness.
2. **Context and round-trip convergence** — reliable `rh_context`, richer deterministic fan-in, warm-state reuse, explicit coverage/source identity.
3. **Transaction and structured evidence** — multi-file patch + selected validation, revision-bound diagnostics/failure-site context, no semantic auto-repair.
4. **Visual and native capability routing** — direct GPT-consumable Browser/iOS/device visual evidence; Web/Vision/one-shot connectors stay controller-native when appropriate; sandbox remains specialized compute only.
5. **End-to-end convergence and release** — real GPT-only feature flows, before/after throughput evidence, Browser V2 interoperability, release gate, and second clean review pass.

## Closure rule

The program is not complete merely because individual repairs merge. It is complete only when one coherent revision has green release readiness, no unexplained pending semantic handoff, the active Work portfolio contains only intentionally persistent or explicitly current work, Browser V2 has an accepted state or explicit external blocker, representative GPT-only implementation flows meet the adopted throughput target (or document measured exceptions), and a fresh second review finds no new P0/P1 harness-authority defect.
