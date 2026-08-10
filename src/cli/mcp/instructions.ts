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
      'For bounded work, gather only task-relevant context once, then act through the exposed surface. When an exact code path is unknown, use rh_context(operation=search) once as the default code retrieval router, then read_repository_file for exact current ranges; do not fall back to shell grep unless retrieval is unavailable or raw Git semantics are explicitly needed. CodeGraph is optional structural augmentation behind rh_context.search for planning/debugging, not a default Direct-edit latency tax. The low-level search_repository handler is compatibility/internal surface, not a second default search path. Prefer repository_command_execute for ordinary local Git and shell operations, repository_safe_patch_apply for bounded source changes, and rh_work only when the task genuinely requires durable orchestration.',
      'Do not preflight unrelated Git history, prior Work, plugins, permissions, TCC, browser mode, maintenance, or recovery state. Inspect them only when the requested operation depends on them or a real failure points there.',
      'Run independent reads, searches, diagnostics, checks, repositories, checkouts, and tasks concurrently by default. Serialize only on a real dependency or Resource Claim conflict, and reuse existing projections, process handles, and check evidence instead of repeating successful observations.',
      'Validation must be proportional to the change: run focused checks first and expand only when risk or failure evidence justifies it. Do not perform maintenance or deep runtime diagnosis before ordinary work unless execution is actually blocked.',
      'After a bounded successful change, finish the requested delivery directly. Avoid additional investigation whose result cannot change implementation or acceptance, and do not invoke hidden atomic compatibility tools merely because they exist in the full profile.',
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
