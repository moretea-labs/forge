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

## A running cloud VM is not a healthy Forge execution node
- Date: 2026-08-26
- Triggered by correction: The Google Cloud `forge-cloud` e2-micro remained `RUNNING`, but Forge_Cloud calls alternated between Secure Tunnel HTTP 404/429, direct SSH and IAP SSH failed, and serial logs showed repeated WARP main-loop watchdog hangs, QUIC idle timeout, NTP timeout, and journald watchdog restarts.
- Mistake pattern: Treating provider instance state and an occasionally live proxy tunnel as evidence that remote Forge hosting improves availability or performance.
- Prevention rule: The Google Cloud `forge-cloud` VM is retired and must not be restarted or reused. A future remote Forge maintainer needs an independently benchmarked host/transport, stable management access, stable MCP/tunnel health, and measured latency/reliability that beats the local Forge path before adoption.
- Where to apply next time: Cloud maintainer experiments, Secure Tunnel hosting, VM/provider selection, recovery automation, and any decision to move Forge source maintenance away from the local canonical Runtime.
