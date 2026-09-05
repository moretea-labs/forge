# Forge Evaluation Framework

This directory is a reproducible engineering-scenario harness for comparing
future Forge versions. It is intentionally separate from `evals/`, which
benchmarks prompt/skill behavior rather than repository-change scenarios.

## Hermetic paired candidate runner

`lib/candidate-runner.ts` executes both candidates through the same declared external
public surface (`public_cli` or `public_mcp`). Candidate artifacts are content-addressed as a complete file or directory tree, verified, and required to contain the artifact entry explicitly bound to the public command. Each trial executes a private materialized copy, so transitive candidate code and candidate-side mutation cannot drift behind a stable identity; the evaluator never imports candidate `src/runtime`,
`src/cli`, or `packages/kernel` modules.

Every measured trial gets a fresh no-local Git clone plus independent HOME,
`FORGE_CONTROLLER_HOME`, XDG state/config/cache, temp, runtime-output, log,
trace, and artifact roots. Cold trials start with no adapter warmup. Warm trials
may run only the adapter's explicitly declared public read-only warmup command
inside that same otherwise-fresh trial root. Candidate order is either balanced
alternating or deterministically seeded per pair. The paired runner also recomputes the canonical scenario digest and rejects content
drift behind a frozen corpus ID. The paired bundle binds the frozen protocol digest,
both immutable candidate identities, and the environment fingerprint; its per-trial legacy reports remain diagnostic-only.

## Authority boundary

`evaluation/` is the candidate-neutral, cross-version evaluation authority.
Only reports produced under a frozen Evaluation Protocol may support a
version-to-version quality verdict. The bounded `scripts/benchmark-*.ts`
runners are candidate-internal diagnostics and profiling tools. They may find
hot paths and regressions inside one Forge revision, but they are not allowed
to produce a cross-version superiority verdict because many of them import the
candidate's private implementation directly.

The existing single-scenario `runEvaluation` / `buildReport` path remains
`candidate_internal_diagnostic` by construction. It cannot issue a version-to-version
verdict merely because it lives under `evaluation/`. A later cross-candidate runner must
bind the frozen protocol digest, candidate artifact identity, and environment identity
before any result may carry `cross_version_evaluation` authority.

The machine-readable protocol lives in `lib/protocol.ts`. A frozen protocol
identifies the evaluator implementation, content-addressed scenario corpus,
trial policy, metric definitions, and failure taxonomy with one protocol
digest. Candidate and environment identities are frozen separately for every
run. Changing any frozen protocol input creates a different digest; results
with different protocol digests are not the same A/B experiment.

The final V2 vs 1.7.2 comparison follows three hard rules:

1. the evaluator and shared corpus are frozen before formal V2 measurements;
2. shared-capability A/B and V2-only capability expansion are reported
   separately;
3. correctness/reliability gates outrank latency or throughput improvements.

### Frozen formal A/B authority

`frozen-cross-version-authority.json` is the Stage S5 freeze authority for the
future formal v1.7.2-vs-V2 comparison. `lib/calibration.ts` recomputes and
fail-closes that manifest against the candidate-neutral evaluator implementation
(and its MCP SDK dependency), the 24-scenario shared corpus, the formal metric
and failure taxonomy, trial policy, exact v1.7.2 baseline artifact, A/A
calibration evidence, and the environment policy. The calibration authority code
itself is part of the evaluator implementation digest.

The durable pre-freeze v1.7.2 A/A run (`proc_mtnxmzmd_fbe1cf2d`) is evidence for arm
symmetry and harness noise on the exact frozen shared-corpus digest only. It used the same immutable artifact on both
arms, passed all 24 shared scenarios / 48 trials with no correctness or
reliability failures, and its scenario-blocked latency interval crosses zero.
It is explicitly **not** a formal v1.7.2-vs-V2 sample and its observed latency
spread is not a regression tolerance.

The frozen formal trial policy is three repetitions per scenario and cache mode,
one declared warmup, both cold and warm modes, deterministic seeded-randomized
arm order, a 60-second candidate timeout, and 95% scenario-blocked confidence.
Each formal run must record a fresh environment identity with `node`, `bun`,
`git`, and `mcpSdk` toolchain versions, and both candidate arms must use the same
environment fingerprint. S6 must call the frozen-authority and environment
assertions before a result may be treated as formal cross-version evidence.

No formal V2 trial may start until Kernel V2 has an immutable release-candidate
artifact. Changing the evaluator, corpus, protocol, baseline identity, A/A
calibration authority, or environment policy after this freeze requires a new
freeze identity; an old result cannot be relabeled as the same A/B experiment.

## Architecture

```text
real Git history -> Scenario v1 -> temporary isolated clone -> Forge CLI -> trace + validators -> report
```

The runner does not contain an agent loop, a database, a scheduler, or a second
Forge Runtime. Its built-in adapter runs Forge through its normal CLI from a
clone checked out at the Scenario's immutable commit. An adapter can write a
small `execution.traceFile` JSON handoff inside that clone with retrieved
context, inspected evidence, tool calls, and its final result; the runner adds
those to the canonical trace. This lets a future desktop, controller, or agent
adapter integrate without changing Scenario or report formats.

## Layout

- `scenarios/` — small Golden Scenario dataset; each JSON file is a behavior-level task with an immutable snapshot reference.
- `lib/scenario.ts` — Scenario v1 parsing and guardrails.
- `lib/sandbox.ts` — source-status guard plus `git clone --no-local` isolation.
- `lib/trace.ts`, `lib/validators.ts`, `lib/metrics.ts`, and `lib/report.ts` — explainable evidence, checks, metrics, diagnosis, and JSON/Markdown output.
- `run.ts` — explicit-output CLI runner.

## Scenario format

```json
{
  "schemaVersion": "forge-evaluation-scenario/v1",
  "id": "short-stable-id",
  "userIntent": "Behavior-level request",
  "snapshot": { "source": ".", "commit": "immutable-git-sha" },
  "groundTruth": {
    "intendedBehavior": ["observable outcome"],
    "affectedDomains": ["domain, not a file name"],
    "behavioralInvariants": ["must remain true"],
    "regressionRisks": ["what could regress"]
  },
  "execution": { "interface": "forge_cli", "arguments": ["status", "--json"], "traceFile": ".forge/evaluation-trace.json" },
  "validators": [{ "id": "observable-check", "kind": "invariant", "type": "command", "command": "bun", "arguments": ["test", "..."] }]
}
```

Ground truth intentionally names behavior and domains, never files that an
executor must edit. Validators may run focused behavioral checks or protect a
broad unrelated path boundary; they are not an implementation prescription.

## Isolation strategy

For every run, the framework:

1. hashes the source repository's Git status;
2. verifies the requested commit exists;
3. uses `git clone --no-local --no-checkout` in an OS temporary directory, then checks out that commit detached and removes its `origin` remote;
4. invokes Forge and validators only with that clone as their working directory;
5. compares the source status after the run and fails the result if it changed;
6. requires the report directory to be outside the source repository.

No `git worktree` is created in the source repository, and no report is written
unless `--output` is explicitly supplied. The CLI sets `FORGE_EVALUATION=1` for
adapter-aware future integrations; it does not grant extra authority.

## Metrics

The first version implements only the requested explainable measures:

- task success rate — the scenario invocation and every validator passed;
- impact coverage — affected domains with retrieved or inspected evidence;
- behavioral invariant success — passed invariant validators;
- regression reintroduction rate — failed regression validators;
- change precision — passed change-boundary validators;
- execution latency — wall-clock duration of the Forge invocation;
- tool interaction count — recorded Forge CLI and validator interactions.

Metrics whose trace evidence is absent are `null`/“not measured”, never a
synthetic pass. The current CLI adapter can only record its own invocation;
future task executors must provide retrieved-context and tool evidence to make
impact coverage diagnostic.

## Example flow

Use a Forge binary/version under evaluation and place reports outside the
source checkout:

```bash
bun evaluation/run.ts \
  --scenario evaluation/scenarios/forge-lightweight-terminal-receipt.json \
  --output /tmp/forge-eval-terminal-receipt \
  --forge-command bun \
  --forge-command-arg /absolute/path/to/forge/bin/forge.mjs
```

The output contains `report.json` for comparison tooling and `report.md` for a
human review. `--keep-sandbox` preserves the temporary clone for diagnosis;
otherwise it is removed after the report is written.

The included lightweight-terminal-receipt Scenario is a safe historical seed:
its source snapshot is the pre-fix commit and its provenance identifies the
subsequent fix. It validates dataset shape and isolation plumbing; it does not
pretend that `forge docs list` is an autonomous code-writing executor.

## Future extension points and open questions

- Add a user-facing Controller or desktop execution adapter that reports
  `contextRetrieval`, `inspectedEvidence`, and individual tool interactions.
- Add a small number of verified Forge regressions and public Avela references
  without copying private source into this repository.
- Decide how evaluator versions and executor versions should be pinned for
  longitudinal comparisons.
- Add explicit remote-snapshot support only with a content-addressed clone and
  a no-network-after-clone policy.

## Legacy benchmark retirement

The retired root `evals/` prompt/skill benchmark and `scripts/run-skill-evals.ts` are not part of Kernel V2.
Kernel behavior evaluation belongs in this directory and in the bounded `scripts/benchmark-*.ts` runners. Historical benchmark reports remain available from Git history rather than as a second live evaluation authority.
