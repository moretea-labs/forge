import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { listRepositories } from '../repositories/registry';
import { resolveRepoPreferredControllerHome } from '../../effects/controller-home';
import { getWorkContract, listWorkContracts, type WorkContract } from '../../../packages/kernel/work/api/index';
import { getPlanContract, planSemanticView } from '../../runtime/control-plane/facade/plan-contract-store';
import { readRequirement } from '../../runtime/control-plane/persistence/requirement-store';
import type { GitHubIssueLink } from '../controller/types';
import { gh, createGitHubIssue, updateGitHubIssue, addProjectItem, resolveGitHubRepository } from './github';

interface RemoteIssue { number: number; url: string; title: string; body: string }
export interface SemanticReleaseProjectionInput {
  releaseWorkId: string;
  repository?: string;
  projectOwner?: string;
  projectNumber?: number;
}
export interface SemanticReleaseProjectionResult {
  releaseIssue: string;
  children: Array<{ workId: string; issue: string }>;
  created: number;
  updated: number;
  unchanged: number;
}

function safeIdentity(value: string): string {
  if (!/^[A-Za-z0-9_.:-]{1,200}$/.test(value)) throw new Error('GITHUB_SEMANTIC_ID_INVALID');
  return value;
}

function marker(workId: string): string {
  return '<!-- forge-semantic-work:' + safeIdentity(workId) + ' -->';
}

function lines(values: readonly string[] | undefined, prefix = '- '): string {
  return values?.length ? values.map((line) => prefix + line).join('\n') : '- 尚无记录';
}

function workDisplayTitle(work: WorkContract, home: string): string {
  const requirement = work.requirementId
    ? readRequirement({ controllerHome: home }, work.requirementId)?.value
    : undefined;
  return (requirement?.title || work.objective).replace(/\s+/g, ' ').slice(0, 96);
}

function semanticWorkText(work: WorkContract, home: string): string {
  const requirement = work.requirementId
    ? readRequirement({ controllerHome: home }, work.requirementId)?.value
    : undefined;
  const plan = work.planId
    ? getPlanContract({ controllerHome: home, repoId: work.repoId }, work.planId)
    : undefined;
  const planView = plan ? planSemanticView(plan) : undefined;
  const text = [
    marker(work.workId),
    '> Forge 生成视图（单向投影）。Requirement / Plan / Work 的正式状态只由 Forge 持有。GitHub 上的勾选或评论不改变执行授权。',
    '',
    '## 工作目标', work.objective,
    '',
    '## Forge 当前事实',
    '- Work: `' + work.workId + '`',
    '- 语义状态: `' + work.semanticState + '`',
    '- Requirement: `' + (work.requirementId || '未绑定') + '`',
    '- Plan: `' + (work.planId || '未绑定') + '`',
    '- 父 Work: `' + (work.semanticParentWorkId || '无') + '`',
    '- 最近语义更新: ' + (work.semanticUpdatedAt || work.updatedAt),
    '',
    '## 已选择的交付结果引用',
    lines(work.semanticResultRefs),
  ];
  if (requirement) {
    text.push('', '## 原始需求：' + requirement.title, requirement.outcomeStatement, '',
      '### 验收标准', lines(requirement.acceptanceCriteria));
    if (requirement.needsAttention && requirement.attentionSummary) {
      text.push('', '### Forge 记录的需关注事项', requirement.attentionSummary);
    }
  }
  if (planView) {
    text.push('', '## 当前方案', planView.goal, '',
      '### 方案决定', lines(planView.resolvedDecisions), '',
      '### 方案项（描述性工作记忆，不是自动审批状态）',
      lines(planView.items.map((item) => item.id + ' — ' + item.objective)));
  }
  text.push('', '> 未明确记录的用户产品审批、测试、发布均不能推断为通过。');
  return text.join('\n') + '\n';
}

export function syncGitHubSemanticRelease(
  repoRoot: string,
  input: SemanticReleaseProjectionInput,
): SemanticReleaseProjectionResult {
  const home = resolveRepoPreferredControllerHome(repoRoot);
  const repositoryRecord = listRepositories(home).find((record) =>
    record.canonicalRoot === repoRoot || record.localRoot === repoRoot ||
    record.checkouts.some((checkout) => checkout.canonicalRoot === repoRoot || checkout.localRoot === repoRoot));
  if (!repositoryRecord) throw new Error('GITHUB_SEMANTIC_REPOSITORY_NOT_REGISTERED');
  const repoId = repositoryRecord.repoId;
  const store = { controllerHome: home, repoId };
  const releaseWorkId = safeIdentity(input.releaseWorkId);
  const parent = getWorkContract(store, releaseWorkId);
  if (!parent || parent.lifecycleRole === 'execution_child') throw new Error('GITHUB_SEMANTIC_RELEASE_WORK_NOT_FOUND');
  if (parent.semanticParentWorkId) throw new Error('GITHUB_SEMANTIC_RELEASE_MUST_BE_ROOT');
  const all: WorkContract[] = [];
  for (let offset = 0; offset < 10_000; offset += 100) {
    const page = listWorkContracts({ ...store, state: 'all', limit: 100, offset });
    all.push(...page);
    if (page.length < 100) break;
    if (offset + 100 >= 10_000) throw new Error('GITHUB_SEMANTIC_WORK_INVENTORY_TOO_LARGE');
  }
  const children = all.filter((work) => work.semanticParentWorkId === releaseWorkId &&
    work.lifecycleRole !== 'execution_child').sort((a, b) => a.workId.localeCompare(b.workId));

  // The GitHub Issue is a projection; never import remote status back into Work.
  if (Boolean(input.projectOwner) !== Boolean(input.projectNumber)) throw new Error('GITHUB_SEMANTIC_PROJECT_CONFIG_INCOMPLETE');
  const repo = resolveGitHubRepository(repoRoot, input.repository);
  const inventory = gh(repoRoot,
    ['issue', 'list', '--repo', repo.nameWithOwner, '--state', 'all', '--limit', '1000',
      '--json', 'number,url,title,body'], undefined, 4 * 1024 * 1024);
  if (!inventory.ok) throw new Error('GITHUB_SEMANTIC_ISSUE_INVENTORY_FAILED: ' + (inventory.error || inventory.stderr));
  const remote = JSON.parse(inventory.stdout) as RemoteIssue[];
  if (!Array.isArray(remote) || remote.length === 1000) {
    throw new Error('GITHUB_SEMANTIC_ISSUE_INVENTORY_UNBOUNDED');
  }
  let created = 0;
  let updated = 0;
  let unchanged = 0;
  const tmp = mkdtempSync(join(tmpdir(), 'forge-semantic-github-'));
  function ensureIssue(workId: string, title: string, body: string): string {
    const matches = remote.filter((issue) => issue.body?.includes(marker(workId)));
    if (matches.length > 1) throw new Error('GITHUB_SEMANTIC_DUPLICATE_REMOTE_IDENTITY: ' + workId);
    const file = join(tmp, 'issue.md');
    writeFileSync(file, body, 'utf8');
    let link: GitHubIssueLink;
    if (matches.length === 1) {
      const current = matches[0]!;
      link = { owner: repo.owner, repo: repo.repo, number: current.number, url: current.url, syncedAt: '' };
      if (current.title === title && current.body === body) unchanged++;
      else { link = updateGitHubIssue(repoRoot, repo, link, title, file); updated++; }
    } else {
      link = createGitHubIssue(repoRoot, repo, title, file, []);
      remote.push({ number: link.number, title, body, url: link.url });
      created++;
    }
    if (input.projectOwner && input.projectNumber) {
      addProjectItem(repoRoot, link, input.projectOwner, input.projectNumber);
    }
    return link.url;
  }
  try {
    const linked = children.map((work) => ({
      workId: work.workId,
      title: workDisplayTitle(work, home),
      issue: ensureIssue(work.workId, workDisplayTitle(work, home),
        semanticWorkText(work, home)),
    }));
    const counts = {
      open: children.filter((work) => work.semanticState === 'open').length,
      completed: children.filter((work) => work.semanticState === 'completed').length,
      cancelled: children.filter((work) => work.semanticState === 'cancelled').length,
    };
    const releaseBody = semanticWorkText(parent, home) + '\n## 版本关联工作\n' +
      (linked.length
        ? linked.map((child) => '- [' + child.title + '](' + child.issue + ') — \`' + child.workId + '\`').join('\n')
        : '- 暂无已关联子 Work') +
      '\n\n## 版本进度（真实 Work 事实，不是提交/发布证明）\n' +
      '- 关联：' + linked.length + '\n- Open：' + counts.open +
      '\n- Completed：' + counts.completed + '\n- Cancelled：' + counts.cancelled + '\n';
    const releaseIssue = ensureIssue(releaseWorkId, workDisplayTitle(parent, home), releaseBody);
    return { releaseIssue, children: linked, created, updated, unchanged };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
