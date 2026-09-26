# Lessons Learned (Self-Improvement Loop)

> Capture correction-derived prevention rules here.
> Promote repeated patterns into durable project rules during spa day.

## Template
- Date:
- Triggered by correction:
- Mistake pattern:
- Prevention rule:
- Where to apply next time:

## Command facade skills must register standalone, not only the umbrella
- Date: 2026-06-18
- Triggered by correction: User reported only the umbrella `repo-harness` skill was discoverable in Claude Code; the 19 `assets/skill-commands/repo-harness-*` facades were invisible.
- Mistake pattern: `sync-codex-installed-copies.sh` linked only the package root as `~/.claude/skills/repo-harness` (and the Codex canonical copy), so facades existed only nested inside that copy and the host never registered them as their own skills.
- Prevention rule: When facades are added/removed under `assets/skill-commands/repo-harness-*`, the installed-copy sync must register each as a standalone host skill in both the Codex and Claude skill roots, for link and copy modes. Drive it off the directory glob (each facade dir has a self-contained `SKILL.md`).
- Where to apply next time: `scripts/sync-codex-installed-copies.sh` (`sync_command_facades`) plus its coverage in `tests/installed-copy-sync.test.ts`; keep both in sync with the facade catalog in `assets/skill-commands/manifest.json`.

## ChatGPT browser engine is Oracle-first; native deprecated, bridge experimental
- Date: 2026-06-18
- Triggered by correction: User rejected the heavy "reliable bridge capture" plan and re-scoped to Oracle-owned browser automation, keeping only two cheap bridge safety patches.
- Mistake pattern: Investing in the bridge DOM-capture path (MAIN-world SSE hook, read-only extraction) as if bridge were a near-product fallback, when the maintained main path should be `oracle --engine browser` and bridge is not yet reliable enough to be a fallback.
- Prevention rule: Treat `oracle` as the default main path (always pass `--engine browser` plus explicit runtime flags that are present in `oracle --help`), `native` as deprecated (diagnostic-only, slated for removal), and `bridge` as experimental/explicit-only with no auto-fallback. Never auto-fall back from Oracle to another provider — Oracle may have already submitted the prompt before a capture drop, so post-submit failures are `recoverable` (return `providerSessionId` to reattach), not retried. Oracle output authority is the `--write-output` answer file plus the terminal exit state; stdout/stderr are logs only. Resolve the oracle binary through a fixed order (`--oracle-bin` → `REPO_HARNESS_ORACLE_BIN` → `node_modules/.bin` → PATH) and never implicitly download/`npx` an unpinned oracle. Doctor must run a `--help`/`--version` capability probe and use a per-provider status taxonomy instead of a single overloaded `partial`.
- Where to apply next time: `src/cli/chatgpt-browser/oracle-provider.ts`, `engine.ts` (`browserDoctor`, `runBrowserConsult`, `runBrowserFollowup`), and `docs/repo-harness-chatgpt-browser-engine.md`; the localhost bridge also requires a per-binding capability token and a server-side `completed`→`failed` backstop for empty/status-only captures.
- Follow-up correction: Oracle doctor readiness must require every flag repo-harness may send at runtime (`--browser-archive`, `--browser-follow-up`, `--followup`, `--browser-model-strategy`, `--browser-cookie-path`, `--browser-thinking-time`, `--chatgpt-url`, etc.), not only the initial consult flags. Hidden Oracle browser flags may be absent from normal `--help`, so probe `--debug-help` and use an isolated no-send parser/dry-run check for `--browser-thinking-time`. Explicit binary configuration (`--oracle-bin` or `REPO_HARNESS_ORACLE_BIN`) must fail closed when invalid and must not silently fall through to PATH. Oracle runs must use a repo-harness-controlled `ORACLE_HOME_DIR`, neutral cwd, absolute attachment paths, and sanitized `ORACLE_*` env so user/repo `.oracle/config.json` cannot append prompt suffixes, flip manual-login, switch model strategy, or route to a remote browser. Oracle must honor the repo-local ChatGPT profile binding; if `Profile 1` is bound, derive that profile's readable regular cookie DB file and do not silently run against the default Chrome/Oracle browser profile. Follow-ups must use the parent session binding; do not inject a changed current binding into an old saved session.

## Execution gates must follow actual risk, not workflow ceremony
- Date: 2026-06-22
- Triggered by correction: Real Task execution was blocked by sibling Issue readiness, missing named checks, stale focus state, and universal acceptance stages.
- Mistake pattern: Treating planning and governance metadata as authoritative execution locks, then duplicating readiness logic across preview, dispatch, Local UI, and Run reconciliation.
- Prevention rule: Use one Task-local execution policy and one effective-state resolver. Planning, focus, missing optional evidence, runtime directories, and stale recovery context are advisory. Only path escape/sensitivity, active write conflicts, destructive or remote effects, real failed checks, and high-risk data evidence remain hard gates.
- Where to apply next time: Controller readiness/dispatch, Local Bridge, MCP tools, hooks, workflow checks, generated project policy, and Connector health identity.

## Durable execution identity must not depend on transport or read-side refresh
- Date: 2026-07-02
- Triggered by correction: Frequent MCP `Session terminated` errors occurred while durable Jobs continued running, and status reads could create additional refresh Jobs.
- Mistake pattern: Coupling a transport Session, process Supervisor, cached Controller context and execution identity; using high-frequency heartbeats to rewrite global indexes; allowing test cleanup to identify processes by broad command matching.
- Prevention rule: Treat MCP transport as replaceable. Persist execution identity behind repository-scoped `request_id`/`work_id`; make read paths bounded and side-effect free; keep Gateway, Tunnel, daemon and UI restart boundaries independent; use fencing tokens and exact process ancestry for ownership; update global indexes only on lifecycle transitions, never on heartbeats.
- Where to apply next time: MCP Gateway, Execution Job store, Controller projections/context, process cleanup, Local Controller UI and all failure-injection tests.
- Follow-up correction: Transport replaceability does not justify independently deployable Gateway, Tunnel, daemon, or UI generations. For the local MCP product, keep durable Job identity independent from the connection while converging normal runtime modules under one release, one root lifecycle, and whole-system restart/rollback.

## Incidents must reduce runtime states and ownership, not add more
- Date: 2026-08-05
- Triggered by correction: Repeated runtime failures were answered with additional readiness variants, keepalive/recovery paths, Supervisor layers, ingress routing, and component-level rollout logic even though the product accepts several seconds of restart downtime.
- Mistake pattern: Treating every observed failure mode as a new persistent status or architectural layer, then adding recovery code for the added layer. Diagnostic dimensions became authorities, module boundaries became process/deployment boundaries, and local component health displaced whole-system MCP availability.
- Prevention rule: Start from one local MCP Runtime, one active release, one lifecycle owner, and whole-system rollback. Readiness is one derived boolean with computed checks and reason codes; checks are not durable state machines. Before adding a process, daemon, proxy, watchdog, status, boolean, authority file, or fallback, prove it cannot be represented by existing facts and cannot be solved by deleting, merging, or correcting an existing layer. Require an explicit architecture decision, complete transition/cleanup contract, removal criterion, and failure-injection coverage.
- Where to apply next time: Supervisor/Gateway/Daemon topology, `controller_ready`, runtime state schemas, launchd/bootstrap, rollout and rollback, watchdog/recovery tools, process ownership, SQLite migration compatibility, architecture reviews, and all incident fixes.

## Restart budgets are release-scoped and recover only after sustained health
- Date: 2026-08-11
- Triggered by correction: Recovery Watchdog repeatedly logged `restart_primary_runtime` attempt `1/3` for one bad Runtime release because a short successful restart immediately reset the attempt counter.
- Mistake pattern: Treating one healthy probe or a Watchdog binary handoff as proof that a Runtime release earned a fresh recovery budget.
- Prevention rule: Persist recovery accounting against the immutable Runtime release identity; preserve it across Watchdog restart; reset it only on a genuinely new release or a configured continuous-health window. Exhaustion must hand off or perform the single attested recovery path, never loop back to a new first attempt.
- Where to apply next time: `src/runtime/standalone-recovery/**`, release activation, watchdog state migrations, and failure-injection/live-recovery acceptance.

## Runtime restart must reclaim a proven-stale Workflow Supervisor socket
- Date: 2026-09-18
- Triggered by correction: The Canonical Runtime repeatedly exited with `WORKFLOW_SUPERVISOR_WRITER_ALREADY_PRESENT`, while `supervisor/supervisor.sock` accepted no connection and had no open file holder. Recovery retries could not restore the ChatGPT MCP endpoint until that stale Unix socket was removed.
- Mistake pattern: The Supervisor server correctly refuses to unlink an existing socket speculatively, but the bounded Runtime restart/recovery path had no evidence-based stale-socket reclamation step after the prior writer was proven absent.
- Prevention rule: Under the Recovery mutation fence, stop the Canonical Runtime, probe the exact Supervisor socket, confirm refusal/no holder, remove only that stale socket, then start and whole-Runtime verify. Preserve the fail-closed rule for a live or indeterminate socket owner.
- Where to apply next time: `src/runtime/standalone-recovery/**`, the Runtime restart transaction, and failure-injection coverage around `supervisor/server.ts`.

## Persistent service entrypoints must not depend on an interactive shell PATH
- Date: 2026-08-22
- Triggered by correction: A packaged Runtime launcher used `#!/usr/bin/env node`; launchd exposed only `/usr/bin:/bin:/usr/sbin:/sbin`, so the canonical Runtime exited 127 and the public Gateway returned 502 until Recovery activated a source-built release.
- Mistake pattern: Verifying an executable from an interactive shell and assuming the same interpreter resolution exists for launchd/systemd persistence.
- Prevention rule: Materialized script entrypoints for persistent services must pin the absolute, validated installer/runtime executable or declare an explicit interpreter in the service contract. Regression tests must execute with the service manager's minimal PATH, not the developer shell PATH.
- Where to apply next time: package Runtime/Connector launchers, launchd and systemd service rendering, package install/update cutover, and whole-Runtime activation verification.

## Controller recovery must be a single bounded Work lane
- Date: 2026-08-28
- Triggered by correction: Eight independent `external_controller_wake` schedules retried browser and Desktop Operator failures concurrently, with policies allowing up to 720 daily minutes, while retryable settlement bypassed each schedule's own failure circuit breaker.
- Mistake pattern: Treating every repair hypothesis as an independently recurring controller loop, and giving a Work-originated wake a generic relay prompt that could select or create sibling Work.
- Prevention rule: For `external_controller_wake`, cap the effective lane at 3 counted failures, 60 daily minutes, and a 10-minute cooldown/backoff; retryable failures must honor that circuit breaker and preserve an explicit pause. Scheduled relay prompts must claim only their origin Work, attempt at most one bounded repair/diagnostic, then record evidence and end the round.
- Where to apply next time: schedule policy hydration and settlement, external Controller wake engine, Controller relay prompt construction, and canary acceptance before enabling any additional autonomous lane.

## Release staging must compare physical source roots
- Date: 2026-08-28
- Triggered by correction: `forge runtime service install --repo <workspace alias>` rejected the same checkout because the command resolved the supplied alias differently from the process working directory.
- Mistake pattern: Comparing lexical paths at a deployment boundary even though a source checkout may be reached through a symlink or workspace alias.
- Prevention rule: Preserve the candidate-stager's same-checkout fence, but compare canonical physical paths for both the requested source root and current working directory.
- Where to apply next time: candidate release staging and any deployment command that binds a caller-supplied repository root to a process working directory.

## Controller timeouts must cover the complete browser dispatch
- Date: 2026-08-28
- Triggered by correction: A scheduled ChatGPT controller wake remained `running` past its configured 120-second timeout because navigation, execution-preference selection, and prompt submission each received that timeout independently.
- Mistake pattern: Passing a timeout to nested tool calls while leaving the composite controller operation without a deadline, allowing tool stalls to accumulate indefinitely.
- Prevention rule: Clamp external Controller wake timeouts to 5–120 seconds and race the complete Work-bound dispatch against that one deadline. On expiry, close the relay as failed and let the schedule's bounded retry circuit decide whether to pause; never leave a dispatching relay or running occurrence behind.
- Where to apply next time: external Controller wake engine, browser/desktop composite workflows, and any schedule operation with more than one blocking provider call.

## Connector recovery must gate on canonical Runtime health, not Connector health
- Date: 2026-08-29
- Triggered by correction: A public MCP `502` was traced to an unavailable Connector while the Canonical Runtime was ready. The `restart-connector` recovery action rejected the repair because its generic local verification included the failed Connector probe itself.
- Mistake pattern: Reusing a composite verification result as a recovery precondition, thereby requiring the failed dependency to be healthy before repairing it.
- Prevention rule: Connector repair may proceed only when the Canonical Runtime is live, ready, non-stale, and its active Gateway answers locally. Connector loopback and public probes remain post-repair verification evidence, not gates that prevent the repair.
- Where to apply next time: `src/runtime/standalone-recovery/core.ts` (`restartPrimaryConnector`) and failure-injection coverage in `tests/runtime/standalone-recovery.test.ts`.

## Connector launch bindings must retain the activation interpreter
- Date: 2026-08-29
- Triggered by correction: After a source Runtime release activated successfully, its Connector repeatedly returned public MCP `502`. The Connector launchd plist used `forge-recovery-gateway` as its executable, which exited with `RECOVERY_GATEWAY_ROLE_ONLY` instead of starting MCP on port 8767.
- Mistake pattern: A detached activation already persisted an absolute `nodeExecutable`, but failed to pass it to the Connector install/rollback path. The installer then inherited the current executable, which can be a role-limited Recovery binary.
- Prevention rule: Treat the absolute interpreter as part of the Connector launch binding. Pass the activation request's `nodeExecutable` to candidate and rollback Connector installs; Recovery retains an explicit Connector interpreter, and Connector launch rendering rejects Recovery-role binaries.
- Where to apply next time: `src/runtime/root/package-runtime-service.ts`, `src/runtime/root/package-connector-service.ts`, `src/runtime/standalone-recovery/installer.ts`, and `tests/runtime/forge-runtime-service.test.ts`.

## Connector faults must not spend the Runtime recovery budget
- Date: 2026-08-29
- Triggered by correction: The 8767 Connector outage left the Canonical Runtime ready, but the Watchdog counted the composite verification failure as a Runtime failure and performed three ineffective whole-Runtime restarts.
- Mistake pattern: Using a verification aggregate that includes the Connector itself as the Runtime-health predicate.
- Prevention rule: Define Runtime health from Runtime liveness, readiness, staleness, and the active local Gateway only. Connector failures use their own bounded recovery path and must not clear Runtime health or trigger Runtime rollback accounting.
- Where to apply next time: `src/runtime/standalone-recovery/core.ts` (`watchdogTick`) and `tests/runtime/standalone-recovery.test.ts`.

## Secure Tunnel Connector authentication must match before Runtime verification

- Date: 2026-09-04
- Triggered by correction: A WSL Secure Tunnel Connector persisted an obsolete `--auth oauth` service contract while its local MCP configuration required `auth:none`. The local OAuth challenge appeared as repeated Cloud 401s, and candidate Runtime activation verified before repairing the Connector binding, so it rolled back without correcting the drift.
- Mistake pattern: Treating a Connector's 401 as healthy for an unauthenticated local MCP, and delaying its immutable release binding until after whole-Runtime verification.
- Prevention rule: For `auth:none`, a local OAuth `401` is a failed readiness probe. After publishing Runtime authority, bind the Connector to that candidate release before starting or verifying the candidate; on any failure, roll back the complete Runtime and Connector binding together.
- Where to apply next time: `src/runtime/root/package-connector-service.ts`, `src/runtime/standalone-recovery/core.ts`, and Secure Tunnel recovery/activation tests.

## Immutable package releases must contain every production module root

- Date: 2026-09-04
- Triggered by correction: A staged WSL Runtime snapshot included `src/` but omitted the top-level `adapters/` and `packages/` module roots. The Connector correctly used `auth:none`, then crashed because its production MCP entrypoint could no longer resolve those modules.
- Mistake pattern: Defining a Runtime package surface by directory convention without including all production import roots.
- Prevention rule: Package release snapshots must include `src/`, `adapters/`, `packages/`, and declared launcher/dependency roots. The snapshot test must run after the source tree is removed and exercise imports from each top-level production module root.
- Where to apply next time: `src/runtime/root/package-runtime-release.ts` and `tests/runtime/package-runtime-release.test.ts`.

## Package release identity is materialized Runtime identity

- Date: 2026-09-04
- Triggered by correction: A package Runtime release had the immutable `releaseRevision` form `package:<version>:<fingerprint>` but no source commit. Runtime treated it as development mode, required an unrelated repository overlay, and entered a restart loop after the package installer correctly omitted that overlay.
- Mistake pattern: Recognizing immutable Runtime identity only when it originates from a Git source commit.
- Prevention rule: Treat immutable package revisions and source release revisions as equivalent release identities. Only manifests without either identity require a development `repositoryRoot`.
- Where to apply next time: `src/runtime/root/runtime.ts` and `tests/runtime/canonical-single-runtime.test.ts`.

## A running cloud VM is not a healthy Forge execution node
- Date: 2026-08-26
- Triggered by correction: The Google Cloud `forge-cloud` e2-micro remained `RUNNING`, but Forge_Cloud calls alternated between Secure Tunnel HTTP 404/429, direct SSH and IAP SSH failed, and serial logs showed repeated WARP main-loop watchdog hangs, QUIC idle timeout, NTP timeout, and journald watchdog restarts.
- Mistake pattern: Treating provider instance state and an occasionally live proxy tunnel as evidence that remote Forge hosting improves availability or performance.
- Prevention rule: The Google Cloud `forge-cloud` VM is retired and must not be restarted or reused. A future remote Forge maintainer needs an independently benchmarked host/transport, stable management access, stable MCP/tunnel health, and measured latency/reliability that beats the local Forge path before adoption.
- Where to apply next time: Cloud maintainer experiments, Secure Tunnel hosting, VM/provider selection, recovery automation, and any decision to move Forge source maintenance away from the local canonical Runtime.

## A Work's declared scope must include the architecture-gate files its change invalidates
- Date: 2026-09-26
- Triggered by correction: Composing the two ready Thin Forge source slices on `78d623c11` (Work-contract ABI change `152edad3a` + route/mode deletion) produced `check:runtime-architecture` failures: `adapters/mcp/runtime-gateway/runtime-tool-definitions.ts must contain "review_decision"` and `... "implementation_review_findings"` (fences at `scripts/check-runtime-architecture.mjs:959-960`). That Work's declared `allowedPaths` is only `runtime-tool-definitions.ts` + `tests/runtime/facade-contracts.test.ts`, so it could not retire the fences its own ABI change invalidated.
- Mistake pattern: Declaring the write scope of a compatibility-surface deletion without including the gate/debt-ledger entries that the deletion makes obsolete, which leaves the obligation orphaned between slices and blocks the batched landing that the Thin Forge review loop needs.
- Prevention rule: When a slice narrows or deletes a model-facing contract surface, its scope must also cover every architecture fence/allowlist entry that asserts the removed surface, and that fence must be retired in the same slice. If the fence encodes a capability that must survive, keep the inputs reachable instead of widening scope. Never resolve the conflict by leaving the fence failing or by relaxing it in a different, unrelated slice.
- Where to apply next time: Work admission scope for `adapters/mcp/**` schema/ABI changes, `scripts/check-runtime-architecture.mjs` fence edits, and any batched landing review of simultaneously ready source slices.

## Source-frozen read-only reviews pin the whole repository revision
- Date: 2026-09-26
- Triggered by correction: 8 concurrently open Thin Forge architecture-review Works (`work-thin-forge-architecture-review-r-*`) were admitted as `read_only_review` with `baseRevision = 78d623c11` while several independent source slices were ready to land. Read-only review finalization blocks whenever `work.baseRevision !== observed sourceRevision` (`READ_ONLY_REVIEW_SOURCE_IDENTITY_REQUIRED`, `src/runtime/control-plane/facade/goal-workloop.ts:1994-2013`), so landing any source advance first would have permanently prevented every open review from completing cleanly.
- Mistake pattern: Modeling an architecture/Plan review of authored semantic context as a source-frozen repository review, so the review loop and the implementation loop serialize on the same single fact (repository HEAD) in both directions.
- Prevention rule: `read_only_review` freezes repository source identity by design — keep that for code-content review. A review whose subject is an authored artifact (Plan/Requirement revision) must bind that artifact identity instead of, or in addition to, repository HEAD; that decision needs an explicit architecture decision (new typed distinction) before it is implemented. Operationally, batch all ready source landings into one window between review waves rather than advancing `main` per slice.
- Where to apply next time: `read_only_review` admission/completion contracts, Thin Forge architecture-review round planning, and any release/landing sequencing that has open source-frozen reviews.

## Open Work state is not live writer ownership
- Date: 2026-09-26
- Triggered by correction: While checking whether a Thin Forge slice could safely land, I treated Controller Home `status=running` Works as active writers and nearly deferred to two Works (`work-repair-the-two-live-discovered-g-8f8fa050`, `work-expose-explicit-controller-vs-re-4f122e84`) whose commits (`b14f57b63`, `a40277d52`) were already integrated in `main`. Of the open Forge-repo Works at the time, most were delivered-but-not-semantically-completed rows.
- Mistake pattern: Consuming an active-Work projection as ownership/authority evidence without checking whether the owning work is still in flight. Semantic completion is an explicit model/user action, so a delivered Work legitimately stays `open`/`running` after its commit lands, and the projection also carries no liveness signal (no controller binding, round, or process).
- Prevention rule: Before treating an open Work as a competing writer, resolve its actual delivery state: check whether its commit is already reachable from the integration branch (git ancestry), whether it still has a live controller binding/round/process, and whether it holds a concrete checkout or path claim. Use the projection only as a hint to look for conflicts, never as proof of ownership. Conversely, do not retire another owner's Work rows to clean the projection — that is their terminal lifecycle action.
- Where to apply next time: Any cross-session conflict/ownership check during parallel Forge development, batched landing decisions, and future "active work inventory" consumers that currently read `status=running` as authority.
