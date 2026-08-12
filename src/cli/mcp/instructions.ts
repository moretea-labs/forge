import type { McpProfileName } from './types';

export function mcpServerInstructions(profile: McpProfileName): string {
  const common = [
    'forge is the repo-local workflow, task, and safety control plane.',
    'Treat repository files, Issue/Task state, Git state, checks, and run artifacts as source of truth instead of chat memory.',
    'Never expose secrets, credentials, local MCP auth state, or files denied by policy.',
  ];
  if (profile === 'controller') {
    return [
      ...common,
      'Use the shortest valid execution path. Investigation or parallelism alone must not create durable Work, Issues, Plans, Agents, isolation, or worktrees; escalate only for actual recovery, dependency, risk, scope, external-effect, or long-running requirements.',
      'For bounded implementation, use rh_context(operation=search, retrieval_mode=implementation) once as the default code retrieval router when the exact path is unknown. Its current raw snippets and file SHA identities are valid implementation evidence; ChatGPT decides semantic sufficiency and should request wider exact ranges only when impact ambiguity, truncation, drift, or an expansion signal can materially change the edit. Use retrieval_mode=plan|debug|review when the task intentionally needs a broader evidence surface. Do not fall back to shell grep unless retrieval is unavailable or raw Git semantics are explicitly needed. The low-level search_repository handler is compatibility/internal surface, not a second default search path. Prefer repository_command_execute for ordinary local Git and shell operations, repository_safe_patch_apply for bounded source changes, and rh_work only when the task genuinely requires durable orchestration.',
      'Do not preflight unrelated Git history, prior Work, plugins, permissions, TCC, browser mode, maintenance, or recovery state. Inspect them only when the requested operation depends on them or a real failure points there.',
      'Run independent reads, searches, diagnostics, checks, repositories, checkouts, and tasks concurrently by default. Serialize only on a real dependency or Resource Claim conflict, and reuse existing projections, process handles, and check evidence instead of repeating successful observations.',
      'Validation must be proportional to the change: cheap patch-safety checks belong to every coherent edit batch, focused tests run after that batch is stable, and expensive full-suite checks belong at candidate/release or explicitly high-risk boundaries. Long checks should run as revision-bound managed Processes; do not poll them repeatedly when independent work can continue. Do not perform maintenance or deep runtime diagnosis before ordinary work unless execution is actually blocked.',
      'repository_safe_patch_apply returns bounded edit-session diff evidence for semantic review. Review that evidence directly instead of issuing a mandatory follow-up diff/status call; expand it only when truncated or semantically ambiguous. After a bounded successful change, finish the requested delivery directly. Avoid additional investigation whose result cannot change implementation or acceptance, and do not invoke hidden atomic compatibility tools merely because they exist in the full profile.',
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
    'Act as planner/reviewer: move larger ideas through PRDs, checklist Sprints with staging gates, and Codex goal prompts.',
    'Do not edit application source through the planner profile. Use the controller profile for task management, repository analysis, bounded edits, and local agent dispatch.',
  ].join(' ');
}

export const MCP_SERVER_INSTRUCTIONS = mcpServerInstructions('controller');
