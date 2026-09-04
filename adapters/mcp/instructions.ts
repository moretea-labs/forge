import type { McpProfileName } from './types';

export function mcpServerInstructions(profile: McpProfileName): string {
  const common = [
    'Forge is the repository execution and safety control plane; mutable Requirement/Plan/Work/Controller lifecycle authority lives in Controller Home rather than repository workflow files.',
    'Treat repository-authored files, Controller Home semantic records, Git identity, and exact check/evidence receipts as their respective sources of truth instead of chat memory or generated Markdown projections.',
    'Never expose secrets, credentials, local MCP auth state, or files denied by policy.',
  ];
  if (profile === 'controller') {
    return [
      ...common,
      'Use the shortest valid execution path. Investigation or parallelism alone must not create durable Work, Issues, Plans, Agents, isolation, or worktrees; escalate only for actual recovery, dependency, risk, scope, external-effect, or long-running requirements.',
      'Engineering Workloop evidence is structured authority: never invent Project Contract, Context Closure, Product DoD, design, critique, semantic-tool, validation, journey, or review receipt ids from prose. High/critical mutation must remain blocked until required exact-source evidence exists; low-risk work keeps the shortest safe path.',
      'Context Closure returned by rh_context.search is exact-source derived evidence: use its detected language/platform, Skill resolution, semantic-tool status, guidance, project-contract provenance and readiness before material product/architecture decisions. Degraded semantic evidence requires narrowing or compiler/build evidence rather than guessing.',
      'For bounded implementation, start with rh_context(operation=search, retrieval_mode=implementation) as the default code retrieval router when the exact path is unknown, then repeat it with exact paths, symbols, tests, relationships, or impact domains whenever more evidence can materially improve correctness. Its current raw snippets and file SHA identities are valid implementation evidence; ChatGPT alone decides semantic sufficiency. For cross-cutting state/time/schema/cache/API/event/concurrency changes, ChatGPT should select relevant impact_domains so Forge expands those evidence dimensions mechanically; Forge never infers that the selected domains are semantically complete. Use retrieval_mode=plan|debug|review when the task intentionally needs a broader evidence surface. Do not fall back to shell grep unless retrieval is unavailable or raw Git semantics are explicitly needed. The low-level search_repository handler is compatibility/internal surface, not a second default search path. Prefer repository_command_execute for ordinary local Git and shell operations, repository_safe_patch_apply for bounded source changes, and rh_work only when the task genuinely requires durable orchestration.',
      'Do not preflight unrelated Git history, prior Work, plugins, permissions, TCC, browser mode, maintenance, or recovery state. Inspect them only when the requested operation depends on them or a real failure points there.',
      'Minimize mechanically redundant MCP round trips. For an ongoing Forge-controlled task, prefer one rh_status(summary) as the initial controller snapshot: it includes bounded readiness, repository identity, top active Work, active Plans, and pending handoffs. Do not immediately follow it with rh_work(plan_list) or rh_context(list/get) unless the next decision needs details that the snapshot does not contain. Use rh_context(work_id=..., detail_level=summary) for one Work, and request detail/raw or capability hydration only when that extra evidence can change the decision.',
      'Run independent reads, searches, diagnostics, checks, repositories, checkouts, and tasks concurrently by default. Serialize only on a real dependency or Resource Claim conflict, and reuse existing projections, process handles, and check evidence instead of repeating successful observations.',
      'Validation must be proportional to the change: cheap patch-safety checks belong to every coherent edit batch, focused tests run after that batch is stable, and expensive full-suite checks belong at candidate/release or explicitly high-risk boundaries. When a Direct Edit batch is stable, repository_safe_patch_apply may receive explicit check_ids to start revision-bound validation; omit check_ids during intermediate edits. Long checks return managed Processes: continue independent read/review work. Do not call process_wait while useful independent work remains. Use process_get only when a non-blocking observation can change the next decision; when the exact check result becomes a dependency, attach with process_wait (or validation_only with the returned edit-session/validation ids). An attach is transport-bounded: if it returns a running handle, resume useful work and attach again only at a later real dependency boundary, never as periodic polling. Do not perform maintenance or deep runtime diagnosis before ordinary work unless execution is actually blocked.',
      'repository_safe_patch_apply returns bounded edit-session diff evidence for semantic review. Review that evidence directly instead of issuing a mandatory follow-up diff/status call; expand it only when truncated or semantically ambiguous. Whole-file source replacement is valid when it is an explicit scoped write against the exact expected file SHA/fingerprint; stale-source and dirty-ownership fences must remain authoritative. Do not bypass those fences with arbitrary shell redirection merely because a deterministic rewrite is convenient. After a bounded successful change, finish the requested delivery directly. Avoid additional investigation whose result cannot change implementation or acceptance, and do not invoke hidden atomic compatibility tools merely because they exist in the full profile.',
    ].join(' ');
  }
  if (profile === 'orchestrator') {
    return [...common, 'The orchestrator profile is a narrow compatibility runner for explicit fixed handoffs. It is not the primary project-control interface.'].join(' ');
  }
  if (profile === 'executor') {
    return [...common, 'Act as a scoped executor/reviewer for existing workflow artifacts and checks. Do not broaden the task contract.'].join(' ');
  }
  return [
    ...common,
    'Act as planner/reviewer: use Controller Home Requirement/Plan authority for executable lifecycle; repository documents are only authored product/design/research sources or rebuildable read-only projections, never a second task state machine.',
    'Do not edit application source through the planner profile. Use the controller profile for task management, repository analysis, bounded edits, and local agent dispatch.',
  ].join(' ');
}

export const MCP_SERVER_INSTRUCTIONS = mcpServerInstructions('controller');
