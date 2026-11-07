import { getRepository } from '../../cli/repositories/registry';
import { configuredBrainRoot } from '../../cli/commands/brain-root';
import { getWorkContract } from '../../../packages/kernel/work/api/index';
import { queryExperiences, type ExperienceApplicability } from '../../../packages/kernel/memory/api/index';
import { memoryUnitFromExperience } from '../../../packages/kernel/cognition/api/index';
import { cognitiveScopesForWork, controllerExperienceStore, experienceScopesForWork } from '../control-plane/persistence/experience-store';
import { listControlPlaneRecords } from '../control-plane/persistence/sqlite-store';
import { WORKFLOW_RUN_NAMESPACE, type WorkflowRunRecord } from '../control-plane/persistence/workflow-run-store';
import { loadProjectEngineeringContract } from './project-engineering-contract';
import { fileKnowledgeSourcePort, renderAssistantContext, resolveAssistantContext, type AssistantContextResolution } from './assistant-context';
import { applyCognitiveSkillCanary } from './cognitive-skill-canary';
import { cognitiveUsageFeedbackForContext, resolveCognitiveAttention } from './cognitive-attention';

function cleanApplicability(value: ExperienceApplicability | undefined): ExperienceApplicability | undefined {
  if (!value) return undefined;
  const next: ExperienceApplicability = {};
  for (const key of ['channel', 'account', 'locale'] as const) {
    const item = value[key]?.trim();
    if (item) next[key] = item;
  }
  return Object.keys(next).length > 0 ? next : undefined;
}

function uniqueApplicability(values: Array<ExperienceApplicability | undefined>): { value?: ExperienceApplicability; ambiguous: boolean } {
  const unique = new Map<string, ExperienceApplicability>();
  for (const raw of values) {
    const value = cleanApplicability(raw);
    if (!value) continue;
    unique.set(JSON.stringify(value), value);
  }
  return unique.size === 1 ? { value: [...unique.values()][0], ambiguous: false } : { ambiguous: unique.size > 1 };
}

function publicationApplicability(controllerHome: string, workId: string): { value?: ExperienceApplicability; ambiguous: boolean } {
  const rows = listControlPlaneRecords<WorkflowRunRecord>(controllerHome, { namespace: WORKFLOW_RUN_NAMESPACE, scope: workId, limit: 100 });
  return uniqueApplicability(rows.map(row => row.value.publicationReceipt
    ? { channel: row.value.publicationReceipt.channel, account: row.value.publicationReceipt.account }
    : undefined));
}

function compatibleApplicability(left: ExperienceApplicability, right: ExperienceApplicability): boolean {
  return (['channel', 'account', 'locale'] as const).every(key => !left[key] || !right[key] || left[key] === right[key]);
}

function effectiveApplicability(input: { explicit?: ExperienceApplicability; declared: Array<ExperienceApplicability | undefined>; published: { value?: ExperienceApplicability; ambiguous: boolean } }): { value: ExperienceApplicability; conflict: boolean } {
  const explicit = cleanApplicability(input.explicit);
  if (explicit) return { value: explicit, conflict: false };
  const declared = uniqueApplicability(input.declared);
  if (input.published.ambiguous) return { value: {}, conflict: true };
  if (declared.ambiguous && !input.published.value) return { value: {}, conflict: true };
  if (declared.value && input.published.value && !compatibleApplicability(declared.value, input.published.value)) return { value: {}, conflict: true };
  return { value: { ...(declared.value ?? {}), ...(input.published.value ?? {}) }, conflict: false };
}

/** Explicit historical Work-context retrieval only; never current execution authority. */
export function prepareAssistantWorkContext(input: {
  controllerHome: string; repoId: string; workId: string; query?: string; applicability?: ExperienceApplicability; now?: string;
}): AssistantContextResolution | undefined {
  const work = getWorkContract({ controllerHome: input.controllerHome, repoId: input.repoId }, input.workId);
  if (!work) throw new Error('ASSISTANT_CONTEXT_WORK_NOT_FOUND');
  const repository = getRepository(input.repoId, input.controllerHome);
  const repoRoot = repository.checkouts.find(checkout => checkout.checkoutId === work.checkoutId)?.canonicalRoot ?? repository.canonicalRoot;
  // Semantic Project identity comes from Work lineage/portable placement. The engineering contract is an optional knowledge-source contract, not identity authority.
  const experienceScopes = experienceScopesForWork(work, input.controllerHome);
  const cognitiveScopes = cognitiveScopesForWork(work, input.controllerHome);
  const boundProject = experienceScopes.find(scope => scope.kind === 'project')?.id;
  // Project knowledge is optional enrichment. Generic cognition authority is
  // scoped by Work lineage and must remain available even when no Project is bound.
  const loaded = boundProject
    ? loadProjectEngineeringContract({ repoRoot, sourceRevision: 'working-tree', now: () => input.now ?? new Date().toISOString() })
    : undefined;
  if (loaded?.status === 'ready' && boundProject !== loaded.contract.projectId) throw new Error('ASSISTANT_CONTEXT_PROJECT_BINDING_MISMATCH');
  const now = input.now ?? new Date().toISOString();
  const sources = loaded?.status === 'ready' ? loaded.contract.knowledgeSources ?? [] : [];
  const applicability = effectiveApplicability({
    explicit: input.applicability,
    declared: sources.map(source => source.applicability),
    published: publicationApplicability(input.controllerHome, work.workId),
  });
  const experiences = queryExperiences(controllerExperienceStore({ controllerHome: input.controllerHome, repoId: input.repoId, ...(input.now ? { now: () => input.now! } : {}) }), { scopes: experienceScopes, applicability: applicability.value, now });
  const query = input.query ?? work.objective;
  const usageFeedback = cognitiveUsageFeedbackForContext({
    controllerHome: input.controllerHome,
    repoId: input.repoId,
    scopes: cognitiveScopes,
    ...(boundProject ? { projectId: boundProject } : {}),
  });
  const transientMemories = experiences.records.map(memoryUnitFromExperience);
  const activation = resolveCognitiveAttention({
    controllerHome: input.controllerHome,
    scopes: cognitiveScopes,
    query,
    now,
    maxItems: 6,
    maxBytes: 12 * 1024,
    transientMemories,
    usageFeedback,
  });
  const context = resolveAssistantContext({ ...(boundProject ? { projectId: boundProject } : {}), query,
    sources,
    knowledge: fileKnowledgeSourcePort({ repoRoot, brainRoot: configuredBrainRoot(), sourceRevision: 'working-tree' }),
    experiences: experiences.records, activation, gaps: [...experiences.gaps, ...(applicability.conflict ? ['assistant_context_applicability_conflict'] : [])], applicability: applicability.value, now });
  return applyCognitiveSkillCanary(context);
}

export function renderAssistantWorkContext(input: Parameters<typeof prepareAssistantWorkContext>[0]): string | undefined {
  try {
    const context = prepareAssistantWorkContext(input);
    return context ? renderAssistantContext(context) : undefined;
  } catch (error) {
    return `Assistant context unavailable: ${error instanceof Error ? error.message.split(':')[0] : 'read_failed'}. Do not infer missing project facts or publish without required task constraints.`;
  }
}
