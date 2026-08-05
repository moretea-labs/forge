# Requirement portfolio migration map

Status: completed migration input; frozen after cutover 2026-08-05  
Snapshot date: 2026-08-02  
Source revision: `183c490dae39ecbe9db349a58a676570b5fabc71`  
Source role: reviewed repository `tasks/issues/*.issue.{json,md}` snapshot used once before cutover  
Current authority: `<durable-controller-home>/control-plane.sqlite`

## Purpose

This document is the reviewed, revision-stamped input for the one-time Issue/Task to Requirement migration. It is not a runtime projection and must not be updated by the Controller after cutover.

The older planning estimate referred to 31 Issues. The frozen repository snapshot contains **33** Issue records. Every source Issue appears exactly once below. A source record may link evidence to more than one Requirement, but it is imported once under one migration disposition.

## Frozen source counts

| Legacy status | Count |
| --- | ---: |
| `done` | 14 |
| `cancelled` | 10 |
| `launch_blocked` | 4 |
| `review` | 2 |
| `planned` | 3 |
| **Total** | **33** |

Legacy status is evidence, not the target lifecycle. In particular, `done` does not automatically satisfy Requirement acceptance, and `launch_blocked` is not a user-visible state.

## Canonical Requirements

| Requirement ID | User-visible outcome | Initial state rule | Canonical legacy alias |
| --- | --- | --- | --- |
| `REQ-CONTROL-PLANE` | 让 Repo Harness 只展示清晰需求并自动管理执行细节 | `planned` until the SQLite board and cutover are delivered | `ISS-20260802-7E1D69` |
| `REQ-RUNTIME-AVAILABILITY` | 让 Repo Harness 升级和重启时保持可用 | derive from accepted runtime evidence; current plan remains active work | `ISS-20260802-539E7F` |
| `REQ-REMOTE-RECOVERY` | 主服务不可用时仍能远程恢复 | `planned` or `active` plus blocker summary; never `launch_blocked` | `ISS-20260802-27931A` |
| `REQ-TRUSTED-EXECUTION` | 让执行结果可验证、可恢复并可信完成 | `done` only after evidence migration validates acceptance | `ISS-20260730-A1EA53` |
| `REQ-ROUTE-INTEGRITY` | 确保任务只在选定仓库中执行 | `active` while review or verification remains | `ISS-20260731-B66A97` |
| `REQ-PHYSICAL-IOS` | 让 Repo Harness 稳定、快速地操作物理 iPhone | `active` with `needs_attention` while dependencies block delivery | `ISS-20260720-66E25D` |
| `REQ-USER-CHROME` | 让浏览器操作复用用户当前 Chrome | `active` while review or live acceptance remains | `ISS-20260731-6A7BB5` |
| `REQ-APPLE-WORKFLOWS` | 让 Apple 项目配置和发布流程可持续复用 | derive `planned`/`active` from imported Work, with blocker summary | `ISS-20260730-84CE88` |
| `REQ-DEFECT-REVIEW` | 验证自动缺陷复核是否真的能减少 Bug | `planned` until experiment prerequisites are satisfied | `ISS-20260730-CCF211` |
| `REQ-RC6-RELEASE` | 完成 Matea RC6 发布 | `done` only if release and required verification evidence import successfully | `ISS-20260729-BF2F89` |

`ISS-20260802-3EC105` is deliberately **not** another peer user Requirement. It is the active plugin-boundary ExecutionPlan under `REQ-RUNTIME-AVAILABILITY`; capability Requirements such as iOS, Browser and Apple depend on its delivered protocol without cloning that platform plan.

## Legacy status translation

| Legacy status | Target interpretation |
| --- | --- |
| `planned` | Requirement `planned`, or approved/active plan with no Work yet |
| `review`, `verifying`, `in_progress` | Requirement `active`; review details remain Work/Attempt diagnostics |
| `launch_blocked`, `blocked` | Requirement `planned` or `active` based on actual Work evidence, plus blocker and optional `needs_attention` |
| `done` | Historical completion claim; set Requirement `done` only after required acceptance and delivery evidence validate |
| `cancelled` | Requirement `cancelled` only when the user outcome was abandoned; otherwise import as retired/superseded plan or historical alias |

## Complete 33-Issue mapping

| # | Source Issue | Legacy status | Target | Migration disposition |
| ---: | --- | --- | --- | --- |
| 1 | `ISS-20260712-14BA0C` — 让任务执行可以安全恢复并正确收尾 | `done` | `REQ-TRUSTED-EXECUTION` | Historical ExecutionPlan and accepted Work/evidence aliases; do not create another Requirement |
| 2 | `ISS-20260714-AF7CBF` — 完成 Repo Harness 早期稳定性修复 | `done` | `REQ-RUNTIME-AVAILABILITY` | Historical plan/work evidence for runtime stability |
| 3 | `ISS-20260715-9E34AD` — Isolate Controller Runtime Source Identity from execution repositories | `cancelled` | `REQ-RUNTIME-AVAILABILITY` | Retired plan version; preserve commits and cancellation reason |
| 4 | `ISS-20260716-34A906` — 自动清理 Repo Harness 临时运行资源 | `done` | `REQ-RUNTIME-AVAILABILITY` | Accepted maintenance Work plus `MaintenanceFinding` history for runtime GC; not a new Requirement |
| 5 | `ISS-20260719-65CFF4` — Harden completion evidence and execution ownership | `done` | `REQ-TRUSTED-EXECUTION` | Historical plan and evidence aliases; unresolved receipt gaps become MaintenanceFindings |
| 6 | `ISS-20260719-8A4B9C` — Keep blue-green rollout under one global Supervisor | `done` | `REQ-RUNTIME-AVAILABILITY` | Historical runtime plan/work evidence |
| 7 | `ISS-20260719-F77E4C` — 支持可恢复的人工接管和设备交互 | `done` | `REQ-PHYSICAL-IOS`, `REQ-USER-CHROME` | Import once as shared historical delivery/evidence record with links to both Requirements |
| 8 | `ISS-20260720-66E25D` — 让 Repo Harness 稳定、快速地操作物理 iPhone | `launch_blocked` | `REQ-PHYSICAL-IOS` | Canonical Requirement alias; tasks become plan/work history and remaining steps |
| 9 | `ISS-20260720-E8E871` — 物理 iPhone 自动化能力（已合并） | `cancelled` | `REQ-PHYSICAL-IOS` | Superseded plan and historical delivery aliases; cancellation does not cancel the Requirement |
| 10 | `ISS-20260726-69DA83` — Make V2 production-ready and perform verified cutover | `cancelled` | `REQ-RUNTIME-AVAILABILITY` | Retired cutover plan; preserve completed evidence and abandoned steps |
| 11 | `ISS-20260727-197BBE` — Converge V2 runtime performance and execution routing | `done` | `REQ-RUNTIME-AVAILABILITY` | Historical plan/work evidence; routing-specific acceptance may also be referenced by `REQ-ROUTE-INTEGRITY` |
| 12 | `ISS-20260729-3A88E8` — Complete Matea RC6 release, public documentation, and GitHub Wiki | `cancelled` | `REQ-RC6-RELEASE` | Duplicate/superseded release plan; preserve docs and cancellation evidence |
| 13 | `ISS-20260729-BF2F89` — 完成 Matea RC6 发布 | `done` | `REQ-RC6-RELEASE` | Canonical Requirement alias and delivery evidence source |
| 14 | `ISS-20260730-6444C7` — Fix standalone Recovery HTTPS transport regression | `done` | `REQ-REMOTE-RECOVERY` | Historical Work/evidence under the recovery plan; security or cleanup residue becomes MaintenanceFinding |
| 15 | `ISS-20260730-84CE88` — 让 Apple 项目配置和发布流程可持续复用 | `launch_blocked` | `REQ-APPLE-WORKFLOWS` | Canonical Requirement alias; existing tasks become plan/work records |
| 16 | `ISS-20260730-A1EA53` — 让执行结果可验证、可恢复并可信完成 | `done` | `REQ-TRUSTED-EXECUTION` | Canonical Requirement alias; completion must be revalidated from exact evidence |
| 17 | `ISS-20260730-AE1BCC` — 归档旧的 Repo Harness 可靠性治理计划 | `cancelled` | `REQ-CONTROL-PLANE` | Retired governance plan and archive evidence; no Requirement creation |
| 18 | `ISS-20260730-B55445` — Converge Core, Advanced, and Full tool surfaces without capability loss | `cancelled` | `REQ-RUNTIME-AVAILABILITY` | Retired interface/tool-surface plan; reusable code and tests remain evidence |
| 19 | `ISS-20260730-CCF211` — 验证自动缺陷复核是否真的能减少 Bug | `launch_blocked` | `REQ-DEFECT-REVIEW` | Canonical Requirement alias; blocker becomes user-readable dependency, not lifecycle state |
| 20 | `ISS-20260730-F311FC` — Fence Work preparation idempotency and redact process diagnostics | `done` | `REQ-TRUSTED-EXECUTION` | Historical security/reliability plan and accepted Work evidence |
| 21 | `ISS-20260731-0A6D9E` — 让 Repo Harness 可靠连接用户 Chrome | `done` | `REQ-USER-CHROME` | Historical plan/delivery evidence; merged into the broader current-Chrome outcome |
| 22 | `ISS-20260731-4D2F9E` — Rebaseline downstream work after trusted execution and concurrency gates | `cancelled` | `REQ-CONTROL-PLANE` | Retired portfolio-governance plan superseded by Requirement-centered planning |
| 23 | `ISS-20260731-6A7BB5` — 让浏览器操作复用用户当前 Chrome | `review` | `REQ-USER-CHROME` | Canonical Requirement alias; review remains Work diagnostics and Requirement stays `active` |
| 24 | `ISS-20260731-7BB554` — 归档旧的项目重规划与并发治理方案 | `cancelled` | `REQ-CONTROL-PLANE` | Retired plan/archive evidence; no new Requirement |
| 25 | `ISS-20260731-B28C97` — Complete live Browser Attach reliability and validation recovery | `done` | `REQ-USER-CHROME` | Historical plan and live acceptance evidence |
| 26 | `ISS-20260731-B66A97` — 确保任务只在选定仓库中执行 | `review` | `REQ-ROUTE-INTEGRITY` | Canonical Requirement alias; retain active review Work and exact route evidence |
| 27 | `ISS-20260731-CCF3E3` — 确定 Repo Harness 控制面状态存储方案 | `done` | `REQ-CONTROL-PLANE` | Accepted prior plan/ADR evidence; superseded authority clauses are revised, not erased |
| 28 | `ISS-20260802-27931A` — 主服务不可用时仍能远程恢复 | `launch_blocked` | `REQ-REMOTE-RECOVERY` | Canonical Requirement alias; tasks become recovery plan/work records |
| 29 | `ISS-20260802-3EC105` — 让 Repo Harness 通过独立插件安全接入本机能力 | `planned` | `REQ-RUNTIME-AVAILABILITY` | Active ExecutionPlan `PLAN-RUNTIME-PLUGIN-BOUNDARY`; shared dependency for capability Requirements, not a peer Requirement |
| 30 | `ISS-20260802-539E7F` — 让 Repo Harness 升级和重启时保持可用 | `planned` | `REQ-RUNTIME-AVAILABILITY` | Canonical Requirement alias and current runtime simplification plan root |
| 31 | `ISS-20260802-7E1D69` — 让 Repo Harness 只展示清晰需求并自动管理执行细节 | `planned` | `REQ-CONTROL-PLANE` | Canonical Requirement alias and current control-plane migration plan root |
| 32 | `ISS-20260802-C31FEE` — Restore immutable release execution and converge ChatGPT tool surface | `cancelled` | `REQ-RUNTIME-AVAILABILITY` | Superseded plan; preserve completed immutable-release evidence, discard obsolete activation path |
| 33 | `ISS-20260802-E3F4A7` — Harden standalone recovery lifecycle and dedicated recovery tunnel | `cancelled` | `REQ-REMOTE-RECOVERY` | Duplicate alias of `ISS-20260802-27931A`; import once as retired duplicate plan |

## Import order

1. Persist the frozen snapshot metadata, all 33 aliases and this mapping hash.
2. Create the 10 canonical Requirements without importing legacy lifecycle blindly.
3. Import active and historical ExecutionPlan versions, preserving supersession and cancellation reasons.
4. Materialize PlanSteps only for actionable remaining work; terminal legacy Tasks become historical Work/evidence references.
5. Import Work, Attempt, checks, receipts and artifact references by exact repository/revision identity.
6. Evaluate Requirement state from acceptance and delivery evidence.
7. Convert non-acceptance operational residue into MaintenanceFindings.
8. Validate that every source Issue is consumed exactly once and every source Task is either linked or explicitly archived.
9. Switch the default board to SQLite and retire Issue/Task, `currentIssue`, project-board, task-ledger and reconciliation writers. **Completed 2026-08-05.**

## Validation gates

Cutover must fail closed unless all gates pass:

- source revision and 33-record count match the frozen snapshot;
- all source Issue IDs are unique and all 33 appear in the mapping;
- canonical alias uniqueness holds for the 10 Requirements;
- active plans have one owner Requirement and no overlapping active scope;
- every imported Work preserves exact repository, checkout, branch/base and integrated revision evidence;
- terminal Requirement states are supported by acceptance and delivery evidence;
- duplicate/cancelled Issues do not cancel a still-active canonical Requirement;
- no migration step writes back to repository Issue/Task state;
- one-way exports contain SQLite revision and content fingerprint.

## Post-cutover operation

The migration map and source Issue/Task files are frozen. Operators query the
Requirement Board for user-facing status and Execution Diagnostics for Plan,
PlanStep, Work and historical aliases. Compatibility output must say
`deprecated_frozen_projection`, include the source revision and SQLite
revisions, and remain read-only.

A new or modified Issue/Task file after the marker exists is a late historical
write. It is ignored and must not trigger reconciliation, Requirement changes,
Plan changes, Work changes or completion side effects.

## Rollback

Before a migration transaction commits, an interruption rolls back all imported
Requirement, Plan and marker rows. After cutover, rollback restores only a
verified SQLite backup and compatible artifact indexes. Verification includes
SQLite integrity, supported schema version, record/audit continuity and entity
relationships. Git Issue/Task documents, task-ledger artifacts and offline
exports are never replayed over an existing authoritative record. See
`docs/operations/sqlite-control-plane-recovery.md`.
