import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { ForgeDesktopProjection } from './runtime-projection';
import { ForgeIcon } from './ui-icons';

export type RecordMode = 'requirements' | 'plans';

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

/**
 * Requirement and Plan are durable semantic project records. This view never
 * projects historical Work as project progress or execution authority.
 */
export function ProjectRecordsView({
  mode, projection, onRefresh, requestedRecordId, onNavigateRecord,
}: {
  mode: RecordMode;
  projection: ForgeDesktopProjection;
  onRefresh: () => Promise<void>;
  requestedRecordId?: string;
  onNavigateRecord: (mode: RecordMode, id: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string>();
  const [detail, setDetail] = useState<RecordDetail>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [planIndex, setPlanIndex] = useState<Array<{
    planId: string; goal: string; revision: number; requirementId?: string;
  }>>([]);
  const [planIndexError, setPlanIndexError] = useState<string>();
  const [refreshEpoch, setRefreshEpoch] = useState(0);
  const revision = useRef(0);
  const requestedRef = useRef<string | undefined>(undefined);
  const repoId = projection.project?.repoId;

  useEffect(() => {
    if (!repoId) return;
    let disposed = false;
    setPlanIndex([]);
    setPlanIndexError(undefined);
    void invoke<{ data?: { plans?: Array<{
      planId: string; goal: string; revision: number; requirementId?: string;
    }> } }>('read_project_plan_list', { repoId }).then((response) => {
      if (!disposed) setPlanIndex(response.data?.plans ?? []);
    }).catch((cause: unknown) => {
      if (!disposed) setPlanIndexError(cause instanceof Error ? cause.message : String(cause));
    });
    return () => { disposed = true; };
  }, [repoId, refreshEpoch]);

  const titles = { requirements: 'Requirements', plans: 'Plans' };
  const explanations = {
    requirements: '需求目标与验收条件',
    plans: '可替换的实施方案与计划项',
  };
  const ids = [...new Set([
    ...(requestedRecordId ? [requestedRecordId] : []),
    ...(mode === 'plans'
      ? planIndex.map((plan) => plan.planId)
      : planIndex.flatMap((plan) => plan.requirementId ? [plan.requirementId] : [])),
  ])];
  const filtered = ids.filter((id) =>
    (id + ' ' + (planIndex.find((plan) => plan.planId === id)?.goal ?? ''))
      .toLowerCase().includes(query.toLowerCase().trim()));
  const selected = selectedId && ids.includes(selectedId) ? selectedId : undefined;
  const relatedPlans = mode === 'requirements' && selected
    ? planIndex.filter((plan) => plan.requirementId === selected) : [];

  useEffect(() => {
    if (!requestedRecordId || !repoId) return;
    const key = repoId + ':' + mode + ':' + requestedRecordId;
    if (requestedRef.current === key) return;
    requestedRef.current = key;
    void openRecord(requestedRecordId);
  }, [requestedRecordId, repoId, mode]);

  async function openRecord(id: string) {
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
        <div className="records-empty" role="status">
          {projection.runtime.status === 'degraded' || projection.runtime.status === 'connecting'
            ? projection.runtime.detail
            : '从左侧选择已注册项目，再查看项目资产。'}
        </div>
      ) : (
        <>
          <div className="records-context">
            <strong>{projection.project.name}</strong>
            <span>{projection.project.branch}</span>
            <button className="plain-action" type="button" onClick={() => {
              void onRefresh().then(
                () => setRefreshEpoch((value) => value + 1),
                (cause: unknown) => setPlanIndexError(cause instanceof Error ? cause.message : String(cause)),
              );
            }}>刷新</button>
          </div>
          <p className="records-coverage">
            {mode === 'plans'
              ? 'Plan 来自 Forge 项目查询（最多 100 条）'
              : 'Requirement 由本项目 Plan 的 canonical requirementId 发现；不会从历史 Work 推断。'}
          </p>
          <div className="records-split">
            <section className="records-index" aria-label={titles[mode] + ' 列表'}>
              <input aria-label="筛选项目记录" value={query} placeholder="搜索记录"
                onChange={(event) => setQuery(event.target.value)} />
              {planIndexError && <p role="alert" className="inline-error">Plan 索引读取失败：{planIndexError}</p>}
              {filtered.length === 0 && <p className="records-empty">没有加载到匹配记录；不代表项目中不存在记录。</p>}
              {filtered.map((id) => (
                <button type="button" key={id} onClick={() => void openRecord(id)}
                  className={id === selectedId ? 'record-row active' : 'record-row'}>
                  <strong>{mode === 'plans' ? planIndex.find((plan) => plan.planId === id)?.goal ?? id : id}</strong>
                  <small>{mode === 'plans' ? id : relatedPlans.length && id === selected ? relatedPlans.length + ' 个 Plan' : 'Requirement'}</small>
                </button>
              ))}
            </section>
            <section className="records-detail" aria-label="记录详情">
              {!selected && <div className="records-empty">选择记录查看 canonical 详情。</div>}
              {selected && <>
                <div className="breadcrumb">{mode === 'plans' ? 'Plan' : 'Requirement'}</div>
                <h2>{selected}</h2>
                <code>{selected}</code>
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
                    {detail.value.requirementId && (
                      <button type="button" className="record-deep-link"
                        onClick={() => onNavigateRecord('requirements', detail.value.requirementId!)}>
                        Requirement · {detail.value.requirementId}
                      </button>
                    )}
                    <strong>计划项</strong>
                    <ul>{(detail.value.items ?? []).map((item) =>
                      <li key={item.id}>{item.objective}</li>)}</ul>
                  </div>
                )}
                {relatedPlans.length > 0 && (
                  <div className="record-related-plans">
                    <h3 className="record-related-heading">关联 Plan · {relatedPlans.length}</h3>
                    {relatedPlans.map((plan) => (
                      <button key={plan.planId} type="button" className="record-work-link"
                        onClick={() => onNavigateRecord('plans', plan.planId)}>
                        <span className="record-plan-icon"><ForgeIcon name="plan" size={16} /></span>
                        <span>{plan.goal}</span>
                        <small>r{plan.revision}</small>
                      </button>
                    ))}
                  </div>
                )}
              </>}
            </section>
          </div>
        </>
      )}
    </main>
  );
}
