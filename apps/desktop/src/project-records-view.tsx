import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { ForgeDesktopProjection, WorkGraphNodeProjection, WorkSemanticState } from './runtime-projection';

export type RecordMode = 'requirements' | 'plans' | 'works';

type RequirementRecord = {
  requirementId: string; title: string; outcomeStatement: string; state: string;
  revision: number; acceptanceCriteria?: string[];
};
type PlanRecord = {
  planId: string; goal: string; revision: number; requirementId?: string;
  items?: Array<{ id: string; objective: string }>;
};
type RecordDetail = { kind: 'requirements'; value: RequirementRecord }
  | { kind: 'plans'; value: PlanRecord };

function workState(state: WorkSemanticState): string {
  return state === 'completed' ? '已完成' : state === 'cancelled' ? '已取消' : '进行中';
}

/**
 * Forge records are project assets, not chat messages. This view reads the
 * existing canonical detail commands and never writes semantic lifecycle data.
 * The index is explicitly bounded by the loaded Work inventory until Forge
 * offers a project-wide Requirement/Plan index.
 */
export function ProjectRecordsView({ mode, projection, onSelectWork, onRefresh }: {
  mode: RecordMode;
  projection: ForgeDesktopProjection;
  onSelectWork: (workId: string) => void;
  onRefresh: () => Promise<void>;
}) {
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string>();
  const [detail, setDetail] = useState<RecordDetail>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [planIndex, setPlanIndex] = useState<Array<{ planId: string; goal: string; revision: number }>>([]);
  const [planIndexError, setPlanIndexError] = useState<string>();
  const revision = useRef(0);
  const repoId = projection.project?.repoId;

  useEffect(() => {
    if (mode !== 'plans' || !repoId) return;
    let disposed = false;
    setPlanIndex([]);
    setPlanIndexError(undefined);
    void invoke<{ data?: { plans?: Array<{ planId: string; goal: string; revision: number }> } }>(
      'read_project_plan_list', { repoId },
    ).then((response) => {
      if (!disposed) setPlanIndex(response.data?.plans ?? []);
    }).catch((cause: unknown) => {
      if (!disposed) setPlanIndexError(cause instanceof Error ? cause.message : String(cause));
    });
    return () => { disposed = true; };
  }, [mode, repoId]);
  const titles = { requirements: 'Requirements', plans: 'Plans', works: 'Works' };
  const explanations = {
    requirements: '需求目标、验收条件和关联工作',
    plans: '实施方案、计划项和关联工作',
    works: '执行任务、状态和验证证据',
  };
  const works = [...new Map([...projection.workGraph.nodes, ...projection.recentWorkHistory]
    .map((work) => [work.workId, work] as const)).values()];
  const ids = mode === 'works'
    ? works.map((work) => work.workId)
    : [...new Set([
      ...(mode === 'plans' ? planIndex.map((plan) => plan.planId) : []),
      ...works.flatMap((work) => {
        const id = mode === 'requirements' ? work.requirementId : work.planId;
        return id ? [id] : [];
      }),
    ])];
  const records = ids.map((id) => ({
    id,
    works: works.filter((work) => mode === 'works' ? work.workId === id
      : mode === 'requirements' ? work.requirementId === id : work.planId === id),
  }));
  const filtered = records.filter((record) =>
    (record.id + ' ' + (planIndex.find((plan) => plan.planId === record.id)?.goal ?? '') + ' '
      + record.works.map((work) => work.objective).join(' '))
      .toLowerCase().includes(query.toLowerCase().trim()));
  const selected = records.find((record) => record.id === selectedId);

  async function openRecord(id: string) {
    if (mode === 'works') { onSelectWork(id); return; }
    const repoId = projection.project?.repoId;
    if (!repoId) return;
    const request = ++revision.current;
    setSelectedId(id);
    setDetail(undefined);
    setError(undefined);
    setLoading(true);
    try {
      if (mode === 'requirements') {
        const response = await invoke<{ data?: { requirement?: RequirementRecord } }>('read_requirement_detail', {
          repoId, requirementId: id,
        });
        if (!response.data?.requirement) throw new Error('需求详情未返回');
        if (request === revision.current) setDetail({ kind: 'requirements', value: response.data.requirement });
      } else {
        const response = await invoke<{ data?: { plan?: PlanRecord } }>('read_plan_detail', {
          repoId, planId: id,
        });
        if (!response.data?.plan) throw new Error('计划详情未返回');
        if (request === revision.current) setDetail({ kind: 'plans', value: response.data.plan });
      }
    } catch (cause) {
      if (request === revision.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (request === revision.current) setLoading(false);
    }
  }

  return (
    <main className="main-pane records-pane">
      <header className="records-heading">
        <div className="breadcrumb">项目 / {projection.project?.name ?? '未选择'}</div>
        <h1>{titles[mode]}</h1>
        <p>{explanations[mode]}</p>
      </header>
      {!projection.project ? (
        <div className="records-empty">从左侧选择已注册项目，再查看项目资产。</div>
      ) : (
        <>
          <div className="records-context">
            <strong>{projection.project.name}</strong>
            <span>{projection.project.branch}</span>
            <button className="plain-action" type="button" onClick={() => void onRefresh()}>刷新</button>
          </div>
          <p className="records-coverage">
            {mode === 'works'
              ? '当前及近期 Work · 不是完整历史'
              : mode === 'plans'
                ? '当前 Plan 从 Forge 按项目查询（最多 100 条），并补充已加载 Work 的引用'
                : '目前根据已加载 Work 枚举关联 Requirement，非完整需求目录；详情来自 Forge 原始记录'}
          </p>
          <div className="records-split">
            <section className="records-index" aria-label={titles[mode] + ' 列表'}>
              <input aria-label="筛选项目记录" value={query} placeholder="搜索记录或关联工作"
                onChange={(event) => setQuery(event.target.value)} />
              {planIndexError && <p role="alert" className="inline-error">Plan 列表读取失败：{planIndexError}</p>}
              {filtered.length === 0 && <p className="records-empty">没有加载到匹配记录；不代表项目中不存在记录。</p>}
              {filtered.map((record) => (
                <button type="button" key={record.id} onClick={() => void openRecord(record.id)}
                  className={record.id === selectedId ? 'record-row active' : 'record-row'}>
                  <strong>{mode === 'works' ? record.works[0]?.objective ?? record.id
                    : mode === 'plans' ? planIndex.find((plan) => plan.planId === record.id)?.goal ?? record.id
                    : record.id}</strong>
                  <small>{mode === 'works' ? workState(record.works[0]?.state ?? 'open')
                    : mode === 'plans' ? record.id : record.works.length + ' 个可见关联 Work'}</small>
                </button>
              ))}
            </section>
            <section className="records-detail" aria-label="记录详情">
              {!selected && <div className="records-empty">选择记录查看详情及项目关联。</div>}
              {selected && <>
                <div className="breadcrumb">{mode === 'works' ? 'Work' : mode === 'plans' ? 'Plan' : 'Requirement'}</div>
                <h2>{mode === 'works' ? selected.works[0]?.objective : selected.id}</h2>
                <code>{selected.id}</code>
                {loading && <p role="status">正在读取 Forge 记录…</p>}
                {error && <p role="alert" className="inline-error">详情读取失败：{error}</p>}
                {detail?.kind === 'requirements' && mode === 'requirements' && (
                  <div className="record-fields">
                    <span>状态 · {detail.value.state} · r{detail.value.revision}</span>
                    <h3>{detail.value.title}</h3>
                    <p>{detail.value.outcomeStatement}</p>
                    <strong>验收标准</strong>
                    <ul>{(detail.value.acceptanceCriteria ?? []).map((criterion, index) =>
                      <li key={index}>{criterion}</li>)}</ul>
                  </div>
                )}
                {detail?.kind === 'plans' && mode === 'plans' && (
                  <div className="record-fields">
                    <span>Plan · r{detail.value.revision}</span>
                    <h3>{detail.value.goal}</h3>
                    {detail.value.requirementId && <p>Requirement · <code>{detail.value.requirementId}</code></p>}
                    <strong>计划项</strong>
                    <ul>{(detail.value.items ?? []).map((item) =>
                      <li key={item.id}>{item.objective}</li>)}</ul>
                  </div>
                )}
                <h3 className="record-related-heading">关联 Work · {selected.works.length}</h3>
                {selected.works.map((work: WorkGraphNodeProjection) => (
                  <button key={work.workId} className="record-work-link" type="button"
                    onClick={() => onSelectWork(work.workId)}>
                    <span className={'work-state-dot ' + work.state} />
                    <span>{work.objective}</span>
                    <small>{workState(work.state)}</small>
                  </button>
                ))}
              </>}
            </section>
          </div>
        </>
      )}
    </main>
  );
}
