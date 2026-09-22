import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { recordExperience, queryExperiences, retractExperience, supersedeExperience, validateOutcomeObservation, type ExperienceDraft, type ExperienceRecord, type ExperienceStorePort } from '../../packages/kernel/memory/api/index';
import { validateProjectKnowledgeSources } from '../../packages/kernel/work/api/index';
import { memoryAddressKey, type ActivationPack, type MemoryUnit } from '../../packages/kernel/cognition/api/index';
import { fileKnowledgeSourcePort, resolveAssistantContext } from '../../src/runtime/context/assistant-context';
import { controllerExperienceStore, cleanupExpiredExperiences } from '../../src/runtime/control-plane/persistence/experience-store';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function root() { const dir = mkdtempSync(join(tmpdir(), 'forge-assistant-')); roots.push(dir); return dir; }
const scope = { schemaVersion: 1, kind: 'project', id: 'project-a' } as const;
const now = '2026-09-07T00:00:00.000Z';
function draft(id = 'experience-1'): ExperienceDraft {
  return { id, scope, applicability: { channel: 'notes', account: 'account-a', locale: 'zh-CN' }, kind: 'observation',
    statement: '开发故事获得更多互动，尚不能确定因果。', evidenceRefs: ['EVD-1'], counterEvidenceRefs: [], sourceWorkId: 'work-a', sourceRoundId: 'round-a', recordedAt: now };
}
function testStore(home: string) {
  const sqlite = controllerExperienceStore({ controllerHome: home, repoId: 'repo-a' });
  let authorized = true, evidence = true;
  // Exercise actual SQLite transactions/CAS; authority and evidence are explicit domain ports.
  const store: ExperienceStorePort = { ...sqlite,
    assertWriteAuthority() { if (!authorized) throw new Error('not-authorized'); },
    evidenceAvailable() { return evidence; },
  };
  return { store, authorize: (value: boolean) => { authorized = value; }, retain: (value: boolean) => { evidence = value; } };
}

describe('assistant experience and context', () => {
  test('reopens SQLite, deduplicates retries, refuses identity conflicts and revoked authority', () => {
    const home = root(), fixture = testStore(home);
    const first = recordExperience(fixture.store, draft(), now);
    expect(first.expiresAt).toBe('2026-10-07T00:00:00.000Z');
    expect(recordExperience(fixture.store, draft(), now)).toEqual(first);
    const reopened = testStore(home);
    expect(reopened.store.read(scope, first.id)).toEqual(first);
    expect(() => recordExperience(reopened.store, { ...draft(), statement: 'changed' }, now)).toThrow('IDENTITY_CONFLICT');
    fixture.authorize(false);
    expect(() => recordExperience(fixture.store, draft('new'), now)).toThrow('not-authorized');
    expect(() => recordExperience(controllerExperienceStore({ controllerHome: home, repoId: 'repo-a' }), draft('no-owner'), now)).toThrow('CONTROLLER_REQUIRED');
  });

  test('scope/account isolation, expiry, missing evidence and counterevidence are enforced', () => {
    const fixture = testStore(root());
    recordExperience(fixture.store, draft(), now);
    const query = { scopes: [scope], applicability: draft().applicability, now };
    expect(queryExperiences(fixture.store, query).records).toHaveLength(1);
    expect(queryExperiences(fixture.store, { ...query, applicability: { channel: 'notes' } }).records).toHaveLength(0);
    expect(queryExperiences(fixture.store, { ...query, scopes: [{ ...scope, id: 'other' }] }).records).toHaveLength(0);
    expect(queryExperiences(fixture.store, { ...query, now: '2026-10-07T00:00:00.000Z' }).records).toHaveLength(0);
    fixture.retain(false);
    expect(queryExperiences(fixture.store, query).gaps).toContain('experience_evidence_unavailable:experience-1');
    expect(() => recordExperience(fixture.store, { ...draft('counter'), counterEvidenceRefs: ['EVD-2'] }, now)).toThrow('EVIDENCE_UNAVAILABLE');
  });

  test('supersession rolls back both writes on failure and retraction cannot overwrite a newer revision', () => {
    const home = root(), fixture = testStore(home);
    recordExperience(fixture.store, draft(), now);
    const failing: ExperienceStorePort = { ...fixture.store, write(record, expected) {
      if (record.retractedAt) throw new Error('injected failure');
      fixture.store.write(record, expected);
    } };
    expect(() => supersedeExperience(failing, { previousId: 'experience-1', expectedRevision: 1, draft: draft('replacement'), now })).toThrow('injected failure');
    expect(fixture.store.read(scope, 'replacement')).toBeUndefined();
    expect(fixture.store.read(scope, 'experience-1')?.retractedAt).toBeUndefined();
    const next = supersedeExperience(fixture.store, { previousId: 'experience-1', expectedRevision: 1, draft: draft('replacement'), now });
    expect(next.supersedesId).toBe('experience-1');
    expect(() => retractExperience(fixture.store, { scope, id: 'experience-1', expectedRevision: 1, sourceWorkId: 'work-a', sourceRoundId: 'round-a', reason: 'old', now })).toThrow('REVISION_CONFLICT');
    expect(cleanupExpiredExperiences(home, '2026-10-08T00:00:00.000Z')).toBe(1);
    expect(fixture.store.read(scope, 'replacement')).toBeDefined();
  });

  test('long-lived lessons require rationale and raw secrets are refused', () => {
    const { store } = testStore(root());
    expect(() => recordExperience(store, { ...draft(), kind: 'lesson' }, now)).toThrow('EXPIRY_REQUIRED');
    expect(() => recordExperience(store, { ...draft(), statement: 'sk-123456789012345678901234567890' }, now)).toThrow('SECRET_REFUSED');
    expect(() => recordExperience(store, { ...draft(), recordedAt: '2027-01-01T00:00:00Z' }, now)).toThrow('FUTURE_OBSERVATION');
  });

  test('projectless cognition preserves scope-qualified identity while project knowledge remains explicitly bound', () => {
    const dir = root();
    const workScope = { schemaVersion: 1 as const, kind: 'work' as const, id: 'work-projectless' };
    const requirementScope = { schemaVersion: 1 as const, kind: 'requirement' as const, id: 'req-projectless' };
    const memory = (memoryScope: typeof workScope | typeof requirementScope, text: string): MemoryUnit => ({
      schemaVersion: 1, id: 'shared-id', revision: 1, scope: memoryScope, facets: ['knowledge'], canonicalText: text, concepts: ['projectless.recall'],
      provenance: { sourceKind: 'system', recordedAt: now, evidenceRefs: [] }, confidence: 0.9, utility: 0.8, tier: 'hot', validFrom: now, counterEvidenceRefs: [],
    });
    const memories = [memory(workScope, 'Work-scoped memory.'), memory(requirementScope, 'Requirement-scoped memory.')];
    const activation: ActivationPack = { schemaVersion: 1, query: 'projectless.recall', generatedAt: now,
      items: memories.map(item => ({ memory: item, score: 1, reasons: [], activationPath: [] })), gaps: [], truncated: false, inspectedCandidates: 2, estimatedBytes: 1 };
    const resolved = resolveAssistantContext({ sources: [], query: 'projectless.recall', now,
      knowledge: fileKnowledgeSourcePort({ repoRoot: dir, sourceRevision: 'test' }), activation });
    expect(resolved.projectId).toBeUndefined();
    expect(new Set(resolved.items.map(item => item.id)).size).toBe(2);
    expect(resolved.items.map(item => item.id)).toEqual(expect.arrayContaining(memories.map(item => memoryAddressKey({ scope: item.scope, id: item.id }))));

    writeFileSync(join(dir, 'project.md'), 'project-only knowledge');
    expect(() => resolveAssistantContext({ sources: [{ id: 'project', kind: 'repository', path: 'project.md', required: true }], query: 'project', now,
      knowledge: fileKnowledgeSourcePort({ repoRoot: dir, sourceRevision: 'test' }) })).toThrow('ASSISTANT_CONTEXT_PROJECT_REQUIRED_FOR_KNOWLEDGE');
  });

  test('Chinese recall survives a fresh reader and source edits invalidate content identity', () => {
    const dir = root(); mkdirSync(join(dir, 'docs'));
    writeFileSync(join(dir, 'docs/product.md'), '产品介绍\n开发故事介绍了产品来历\n禁止承诺疗效');
    const sources = validateProjectKnowledgeSources([{ id: 'product', kind: 'repository', path: 'docs/product.md', required: true }]);
    const resolve = () => resolveAssistantContext({ projectId: scope.id, sources, query: '产品推广开发故事', now,
      knowledge: fileKnowledgeSourcePort({ repoRoot: dir, sourceRevision: 'working-tree' }) });
    const first = resolve();
    expect(first.items[0]?.text).toContain('开发故事');
    expect(resolve()).toEqual(first);
    writeFileSync(join(dir, 'docs/product.md'), '产品介绍\n当前产品版本更新');
    expect(resolve().items[0]?.provenance.digest).not.toBe(first.items[0]?.provenance.digest);
  });

  test('unregistered files, escaped symlinks, expired sources and truncation never become usable required knowledge', () => {
    const dir = root(), outside = root();
    writeFileSync(join(outside, 'secret.md'), '产品私密事实');
    symlinkSync(join(outside, 'secret.md'), join(dir, 'linked.md'));
    const sources = validateProjectKnowledgeSources([{ id: 'link', kind: 'repository', path: 'linked.md', required: true }]);
    const result = resolveAssistantContext({ projectId: scope.id, sources, query: '产品', now, knowledge: fileKnowledgeSourcePort({ repoRoot: dir, sourceRevision: 'test' }) });
    expect(result.items).toHaveLength(0);
    expect(result.missingRequiredSources).toEqual(['link']);
    expect(() => validateProjectKnowledgeSources([{ id: 'escape', kind: 'repository', path: '../secret' }])).toThrow('PATH_INVALID');
    writeFileSync(join(dir, 'product.md'), '产品说明'.repeat(1000));
    const bounded = resolveAssistantContext({ projectId: scope.id, sources: [{ id: 'product', kind: 'repository', path: 'product.md', required: true }], query: '产品', now,
      maxTokens: 10, knowledge: fileKnowledgeSourcePort({ repoRoot: dir, sourceRevision: 'test' }) });
    expect(bounded.truncated).toBe(true); expect(bounded.missingRequiredSources).toEqual(['product']);
  });

  test('numeric zero and unavailable metrics remain distinct; repeated snapshots are not summed', () => {
    const observation = { schemaVersion: 1, id: 'outcome-a', scope, sourceWorkId: 'work-a', sourceRoundId: 'round-a', evidenceRef: 'EVD-1',
      remoteObject: { id: 'post-a', url: 'https://example.test/post-a', account: 'account-a', channel: 'notes' },
      observedAt: now, window: { start: now, end: now },
      metrics: [{ name: 'likes', unit: 'count', value: 0, cumulative: true }, { name: 'views', unit: 'count', value: null, missingReason: 'not visible', cumulative: true }] } as const;
    const valid = validateOutcomeObservation(structuredClone(observation) as unknown as Parameters<typeof validateOutcomeObservation>[0]);
    expect(valid.metrics.map(metric => metric.value)).toEqual([0, null]);
    expect(() => validateOutcomeObservation({ ...valid, metrics: [{ name: 'views', unit: 'count', value: null, cumulative: true }] })).toThrow('MISSING_REASON');
  });
});

test('identical required sources retain both provenance records and both truncation gaps', () => {
  const dir = root();
  writeFileSync(join(dir, 'a.md'), '产品边界：不承诺效果');
  writeFileSync(join(dir, 'b.md'), '产品边界：不承诺效果');
  const input = { projectId: scope.id, query: '产品', now,
    sources: validateProjectKnowledgeSources(['a', 'b'].map(id => ({ id, kind: 'repository', path: `${id}.md`, required: true }))),
    knowledge: fileKnowledgeSourcePort({ repoRoot: dir, sourceRevision: 'test' }) };
  const complete = resolveAssistantContext(input);
  expect(complete.items).toHaveLength(1);
  expect(complete.items[0]?.sourceCoverage?.map(source => source.sourceId)).toEqual(['a', 'b']);
  expect(complete.missingRequiredSources).toEqual([]);
  expect(resolveAssistantContext({ ...input, maxTokens: 1 }).missingRequiredSources).toEqual(['a', 'b']);
});

test('supersede and retract retries are idempotent without accepting changed requests', () => {
  const fixture = testStore(root());
  recordExperience(fixture.store, draft(), now);
  const input = { previousId: 'experience-1', expectedRevision: 1, draft: draft('replacement'), now };
  const replacement = supersedeExperience(fixture.store, input);
  expect(supersedeExperience(fixture.store, input)).toEqual(replacement);
  expect(() => supersedeExperience(fixture.store, { ...input, draft: { ...input.draft, statement: 'different' } })).toThrow('IDENTITY_CONFLICT');
  const retract = { scope, id: replacement.id, expectedRevision: replacement.revision, sourceWorkId: 'work-a', sourceRoundId: 'round-a', reason: 'counterevidence', now };
  const retracted = retractExperience(fixture.store, retract);
  expect(retractExperience(fixture.store, retract)).toEqual(retracted);
  expect(() => retractExperience(fixture.store, { ...retract, sourceRoundId: 'other-round' })).toThrow('REVISION_CONFLICT');
  fixture.authorize(false);
  expect(() => retractExperience(fixture.store, retract)).toThrow('not-authorized');
});

test('permanent lessons do not starve bounded expiry cleanup', () => {
  const home = root(), fixture = testStore(home);
  recordExperience(fixture.store, { ...draft('permanent'), kind: 'lesson', durableRationale: 'Applies while the documented product contract remains valid.' }, now);
  recordExperience(fixture.store, draft('expired-a'), now);
  recordExperience(fixture.store, draft('expired-b'), now);
  expect(cleanupExpiredExperiences(home, '2026-11-08T00:00:00.000Z', 1)).toBe(1);
  expect(cleanupExpiredExperiences(home, '2026-11-08T00:00:00.000Z', 1)).toBe(1);
  expect(cleanupExpiredExperiences(home, '2026-11-08T00:00:00.000Z', 1)).toBe(0);
  expect(fixture.store.read(scope, 'permanent')).toBeDefined();
});
