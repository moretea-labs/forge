import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  applyDiskCleanup, cleanupCategory, readDiskCleanupPreview,
  type CleanupCategory, type CleanupPreview,
} from './storage-cleanup';

const LABELS: Record<CleanupCategory, string> = {
  temp_dirs: 'Forge 临时文件',
  terminal_local_jobs: '已结束的任务记录',
  legacy_runs: '过期运行记录',
};
const CATEGORY_ORDER: CleanupCategory[] = ['temp_dirs', 'terminal_local_jobs', 'legacy_runs'];

function bytesText(bytes: number | null): string {
  if (bytes === null) return '大小暂不可读取';
  if (bytes < 1024) return bytes + ' B';
  const unit = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), 4);
  return (bytes / 1024 ** unit).toFixed(1) + ' ' + ['B', 'KB', 'MB', 'GB', 'TB'][unit];
}

export function StorageCleanupPanel({ repoId }: { repoId?: string }) {
  const [preview, setPreview] = useState<CleanupPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<CleanupCategory[]>(['temp_dirs']);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!repoId) return;
    setBusy(true); setError(null); setConfirming(false);
    try {
      const result = await readDiskCleanupPreview(repoId);
      setPreview(result);
    } catch (cause) {
      setPreview(null);
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }, [repoId]);

  useEffect(() => { void refresh(); }, [refresh]);

  const groups = useMemo(() => CATEGORY_ORDER.map(key => ({
    key,
    safe: preview?.runtime.candidates.filter(item => item.safe && cleanupCategory(item.kind) === key).length ?? 0,
    blocked: preview?.runtime.candidates.filter(item => !item.safe && cleanupCategory(item.kind) === key).length ?? 0,
  })), [preview]);

  const eligible = groups.filter(group => selected.includes(group.key)).reduce((sum, group) => sum + group.safe, 0);

  const apply = async () => {
    if (!repoId || !confirming || busy || eligible === 0) return;
    setBusy(true); setError(null); setOutcome(null);
    try {
      const result = await applyDiskCleanup(repoId, selected);
      const record = result as { cycle?: { removed?: number; failed?: number }; summary?: { removed?: number } };
      const removed = record.cycle?.removed ?? record.summary?.removed;
      setOutcome(removed === undefined ? '已执行 Runtime 安全清理，结果已刷新。' : `Runtime 已清理 ${removed} 项；实际可用空间可能随后台写入变化。`);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  };

  return <section className="settings-group storage-cleanup" aria-label="存储与清理">
    <div className="settings-group-heading"><strong>存储与清理</strong><span>由 Forge Runtime 执行</span></div>
    <div className="storage-topline">
      <span>只列出受管理的历史文件；活动项目会受到保护。</span>
      <button type="button" className="plain-action" disabled={busy || !repoId} onClick={() => { setOutcome(null); void refresh(); }}>
        {busy ? '正在处理…' : '重新扫描'}
      </button>
    </div>
    {!repoId ? <p className="settings-hint">请选择一个项目，再扫描其对应的 Runtime 历史数据。</p> : null}
    {preview ? <>
      <p className="storage-summary">{preview.runtime.summary.safe} 项可安全清理
        <span> · {preview.runtime.summary.unsafe} 项受保护{preview.runtime.truncated?.candidates ? ' · 仅显示部分候选' : ''}</span>
      </p>
      {groups.map(group => <label className="storage-category" key={group.key}>
        <input type="checkbox" checked={selected.includes(group.key)}
          disabled={busy || group.safe === 0} onChange={event => {
            setConfirming(false);
            setSelected(items => event.target.checked ? [...items, group.key] : items.filter(key => key !== group.key));
          }} />
        <span>{LABELS[group.key]}</span>
        <small>{group.safe} 可回收{group.blocked > 0 ? ` · ${group.blocked} 受保护` : ''}</small>
      </label>)}
      <details className="storage-details">
        <summary>查看候选与保护原因</summary>
        <div className="storage-candidates">{preview.runtime.candidates.map((item, index) =>
          <div className="storage-candidate" key={item.path ?? index}>
            <span title={item.path}>{item.path ?? item.kind}</span>
            <small>{item.safe ? '可回收' : '已保护'} · {item.reason}</small>
          </div>)}</div>
      </details>
      <div className="storage-actions">
        {!confirming ? <button className="settings-save" type="button" disabled={busy || eligible === 0}
          onClick={() => setConfirming(true)}>清理所选类别</button>
        : <><span role="status">确认清理选中类别中的 {eligible} 项？执行前 Runtime 将重新验证。</span>
            <button className="settings-save" type="button" disabled={busy} onClick={() => { void apply(); }}>确认清理</button>
            <button className="plain-action" type="button" onClick={() => setConfirming(false)}>取消</button></>}
      </div>
    </> : null}
    {preview?.projectCaches ? <div className="storage-inventory" aria-label="项目缓存占用">
      <div className="settings-group-heading"><strong>项目构建缓存</strong><span>只读占用统计</span></div>
      {preview.projectCaches.items.length === 0
        ? <p className="settings-hint">当前未发现支持识别的构建缓存。</p>
        : preview.projectCaches.items.slice(0, 15).map(row => <div className="storage-inventory-row" key={row.path}>
          <div className="storage-inventory-label">
            <strong>{row.project} · {row.kind}</strong>
            <small title={row.path}>{row.path}</small>
          </div>
          <span>{row.partial ? '至少 ' : ''}{bytesText(row.logicalBytes)}</span>
        </div>)}
      {preview.projectCaches.items.length > 15
        ? <p className="settings-hint">仅展示占用最大的 15 项。</p> : null}
      <p className="settings-hint">{preview.projectCaches.incomplete
        ? '本次限时扫描未遍历所有文件；显示的是已统计大小，不是可回收空间。'
        : '此处为逻辑占用大小，不等于实际可回收空间。'}
        构建缓存的可清理性由 Forge 原有保留机制决定，目前只提供占用查看。</p>
    </div> : null}
    <div className="storage-managed">
      <span>Forge 数据库</span><strong>{bytesText(preview?.sqlite.bytes ?? null)}</strong>
      <small>历史审计、压缩和保留期限由运行时统一维护；这里不提供直接删除数据库的操作。</small>
    </div>
    <p className="settings-hint">共享 Gradle 与 Xcode 缓存仅显示占用，不执行强制删除。</p>
    {outcome ? <p role="status" className="settings-saved">{outcome}</p> : null}
    {error ? <p role="alert" className="settings-error">{error}</p> : null}
  </section>;
}
