import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { ControllerIssue, IssueKind, TaskDraft } from '../../src/cli/controller/types';

let fixtureSequence = 0;

function strings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.map((entry) => String(entry).trim()).filter(Boolean)));
}

function slugify(value: string): string {
  return value.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'issue';
}

export function writeLegacyIssueFixture(
  repoRoot: string,
  input: {
    id?: string;
    title: string;
    kind?: IssueKind;
    summary?: string;
    goals?: string[];
    nonGoals?: string[];
    acceptanceCriteria?: string[];
    relatedArtifacts?: string[];
    tasks?: TaskDraft[];
  },
): ControllerIssue {
  const now = new Date().toISOString();
  fixtureSequence += 1;
  const id = input.id ?? `ISS-FIXTURE-${String(fixtureSequence).padStart(4, '0')}`;
  const tasks = (input.tasks ?? []).map((draft, index) => ({
    id: `T${index + 1}`,
    title: String(draft.title ?? '').trim() || `T${index + 1}`,
    objective: String(draft.objective ?? '').trim() || 'Complete the scoped task.',
    status: (draft.dependsOn?.length ?? 0) > 0 ? 'planned' as const : 'ready' as const,
    dependsOn: strings(draft.dependsOn),
    allowedPaths: strings(draft.allowedPaths),
    forbiddenPaths: strings(draft.forbiddenPaths),
    checks: strings(draft.checks),
    acceptanceCriteria: strings(draft.acceptanceCriteria),
    risk: draft.risk ?? 'medium',
    recommendedAgent: draft.recommendedAgent,
    notes: [],
    runIds: [],
    createdAt: now,
    updatedAt: now,
  }));
  const issue: ControllerIssue = {
    schemaVersion: 5,
    id,
    title: input.title.trim(),
    slug: slugify(input.title),
    kind: input.kind ?? 'feature',
    status: tasks.length > 0 ? 'planned' : 'analysis',
    summary: input.summary?.trim() ?? '',
    goals: strings(input.goals),
    nonGoals: strings(input.nonGoals),
    acceptanceCriteria: strings(input.acceptanceCriteria),
    relatedArtifacts: strings(input.relatedArtifacts),
    tasks,
    createdAt: now,
    updatedAt: now,
  };
  const root = join(repoRoot, 'tasks', 'issues');
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, `${issue.id}-${issue.slug}.issue.json`), `${JSON.stringify(issue, null, 2)}\n`, 'utf8');
  return issue;
}
