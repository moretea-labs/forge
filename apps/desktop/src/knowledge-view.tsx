import { useCallback, useEffect, useState } from 'react';
import { readProjectKnowledge, tauriRuntimeAvailable, type KnowledgeAuditProjection } from './runtime-client';

export function KnowledgeView({ repoId, workId, projectName }: { repoId?: string; workId?: string; projectName?: string }) {
  const [query, setQuery] = useState('');
  const [result, setResult] = useState<KnowledgeAuditProjection | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const search = useCallback(async (term: string) => {
    if (!repoId || !tauriRuntimeAvailable()) return;
    setLoading(true); setError(null);
    try { setResult(await readProjectKnowledge({ repoId, workId, query: term })); }
    catch (cause) { setResult(null); setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setLoading(false); }
  }, [repoId, workId]);
  useEffect(() => { void search(''); }, [search]);
  return <main className="main-pane knowledge-pane"><div className="content-column">
    <header className="work-hero"><div className="breadcrumb">Forge / Cognitive</div><h1>记忆与知识</h1>
      <p>读取 Forge 在当前项目与工作空间中的经验记录。知识仅供参考，不更改需求、计划或执行授权。</p></header>
    <form className="knowledge-search" onSubmit={(event) => { event.preventDefault(); void search(query); }}>
      <input aria-label="搜索记忆" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索经验、概念、技术决策…" maxLength={160} />
      <button className="primary-action" type="submit" disabled={loading || !repoId || !tauriRuntimeAvailable()}>{loading ? '搜索中…' : '检索'}</button>
    </form>
    <div className="knowledge-meta"><span>{projectName ? '项目：' + projectName : '未选择项目'}</span>
      <span>{result ? '已检索 ' + result.inspected + ' 条 · 返回 ' + result.items.length + ' 条' : 'Forge Cognitive · 只读'}</span></div>
    {error && <div role="alert" className="inline-error standalone-error">读取失败：{error}</div>}
    {!repoId && <div className="empty-copy inline-empty"><p>先选择已注册的 Forge 项目，以限定知识检索范围。</p></div>}
    {repoId && !tauriRuntimeAvailable() && <div className="empty-copy inline-empty"><p>请在 macOS 原生客户端连接 Forge Runtime 后查看知识库。</p></div>}
    {result && result.items.length === 0 && <div className="empty-copy inline-empty"><p>当前没有匹配的记忆记录。</p></div>}
    {result && <div className="knowledge-results">{result.items.map(({ memory }) =>
      <article className="knowledge-item" key={memory.scope.kind + ':' + memory.scope.id + ':' + memory.id}>
        <div className="knowledge-item-meta"><span className="preference-pill">{memory.scope.kind === 'project' ? '项目' : memory.scope.kind === 'workspace' ? '工作空间' : memory.scope.kind}</span>
          <span>{memory.provenance?.sourceKind ?? 'Cognitive'}</span>
          {memory.provenance?.recordedAt && <span>{new Date(memory.provenance.recordedAt).toLocaleDateString('zh-CN')}</span>}</div>
        <p>{memory.canonicalText}</p>
        {memory.concepts.length > 0 && <div className="knowledge-concepts">{memory.concepts.slice(0,6).map(concept => <span key={concept}>{concept}</span>)}</div>}
        <details className="knowledge-provenance"><summary>来源与标识</summary><code>{memory.id}</code>
          <p>{memory.scope.kind + ' / ' + memory.scope.id + ' · r' + memory.revision}</p></details>
      </article>)}</div>}
    {result?.truncated && <p className="preference-note">只展示单次上限范围内的记录，可输入关键词缩小范围。</p>}
    {result?.gaps && result.gaps.length > 0 && <p className="preference-note">部分范围不可达：{result.gaps.join('、')}</p>}
  </div></main>;
}
