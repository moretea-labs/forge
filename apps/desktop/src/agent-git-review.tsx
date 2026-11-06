import { useState } from 'react';
import { ForgeIcon } from './ui-icons';

export interface GitDiffReceipt {
  stat: string;
  patch: string;
  truncated: boolean;
  head?: string | null;
  branch?: string | null;
  checkoutId?: string;
  nameOnly?: string[];
  staged?: boolean;
}

export interface GitDiffFile {
  path: string;
  patch: string;
  added: number;
  removed: number;
}

/** UI-only parsing of the canonical Forge Git diff receipt; no Git authority here. */
export function splitGitDiffFiles(patch: string): GitDiffFile[] {
  return patch.split(/(?=^diff --git )/m).filter((section) => section.startsWith('diff --git '))
    .map((section) => {
      const lines = section.split('\n');
      const newPath = lines.find((line) => line.startsWith('+++ b/'))?.slice(6);
      const header = lines[0];
      const fallback = header.match(/ b\/(.+)$/)?.[1] ?? '(unidentified file)';
      return {
        path: newPath || fallback,
        patch: section,
        added: lines.filter((line) => line.startsWith('+') && !line.startsWith('+++')).length,
        removed: lines.filter((line) => line.startsWith('-') && !line.startsWith('---')).length,
      };
    });
}

function lineKind(line: string): string {
  if (line.startsWith('@@')) return 'hunk';
  if (line.startsWith('+') && !line.startsWith('+++')) return 'added';
  if (line.startsWith('-') && !line.startsWith('---')) return 'removed';
  if (line.startsWith('diff --git') || line.startsWith('index ') || line.startsWith('--- ') || line.startsWith('+++ ')) return 'meta';
  return 'context';
}

export function AgentGitReview({
  diff, staged, loading, error, canCommit, committing, commitError, commitHead,
  onStagedChange, onRefresh, onClose, onCommit,
}: {
  diff?: GitDiffReceipt;
  staged: boolean;
  loading: boolean;
  error?: string;
  canCommit?: boolean;
  committing?: boolean;
  commitError?: string;
  commitHead?: string;
  onStagedChange: (staged: boolean) => void;
  onRefresh: () => void;
  onClose: () => void;
  onCommit?: (paths: string[], message: string) => void;
}) {
  const [activePath, setActivePath] = useState<string>();
  const [selectedPaths, setSelectedPaths] = useState<string[]>([]);
  const [commitMessage, setCommitMessage] = useState('');
  const files = splitGitDiffFiles(diff?.patch ?? '');
  const reviewedPaths = selectedPaths.filter((path) => files.some((file) => file.path === path));
  const commitAllowed = canCommit === true && Boolean(diff?.head && diff?.branch) && !committing && !loading && !diff?.truncated
    && reviewedPaths.length > 0 && reviewedPaths.length <= 32 && Boolean(commitMessage.trim());
  const activeFile = files.find((file) => file.path === activePath) ?? files[0];

  return (
    <aside className="local-git-inspector" aria-label="Git 变更审阅">
      <header>
        <strong>Git 变更</strong>
        <span className="local-diff-file-count" title={diff?.branch ?? '未知分支'}>
          {diff?.branch ? diff.branch.slice(-24) + ' · ' : ''}{files.length} 个文件
        </span>
        <div className="local-diff-header-actions">
          <button className="agent-icon-button" type="button" onClick={onRefresh}
            aria-label="刷新 Git 变更" title="刷新 Git 变更"
            disabled={loading || committing}><ForgeIcon name="refresh" size={16} /></button>
          <button className="agent-icon-button" type="button" onClick={onClose}
            aria-label="关闭 Git 面板" title="关闭 Git 面板"
            disabled={committing}><ForgeIcon name="close" size={16} /></button>
        </div>
      </header>
      <div className="local-diff-modes" role="group" aria-label="Git 变更类型">
        <button type="button" aria-pressed={!staged} disabled={loading || committing}
          className={!staged ? 'active' : ''} onClick={() => onStagedChange(false)}>未暂存</button>
        <button type="button" aria-pressed={staged} disabled={loading || committing}
          className={staged ? 'active' : ''} onClick={() => onStagedChange(true)}>已暂存</button>
      </div>
      {loading && <div role="status" className="local-diff-status">从 Forge Git 读取变更…</div>}
      {error && <p role="alert" className="inline-error">读取失败：{error}</p>}
      {!loading && !error && diff && (
        <>
          {diff.truncated && <p className="local-diff-warning">仅展示 Forge 返回的部分 Diff，不代表完整文件变更。</p>}
          {files.length > 0 ? (
            <>
              <nav className="local-diff-file-list" aria-label="已修改文件">
                {files.map((file) => (
                  <div className="local-diff-file-entry" key={file.path}>
                    {onCommit && <input type="checkbox" aria-label={`选择提交 ${file.path}`}
                      checked={reviewedPaths.includes(file.path)}
                      disabled={committing || loading || diff?.truncated || !canCommit}
                      onChange={(event) => setSelectedPaths((current) =>
                        event.target.checked ? [...current, file.path] : current.filter((path) => path !== file.path))} />}
                    <button className={file.path === activeFile?.path ? 'active' : ''}
                      type="button" aria-pressed={file.path === activeFile?.path}
                      title={file.path} onClick={() => setActivePath(file.path)}>
                      <span className="local-diff-file-path">{file.path}</span>
                      <span className="local-diff-file-counts">
                        <span>+{file.added}</span><span>−{file.removed}</span>
                      </span>
                    </button>
                  </div>
                ))}
              </nav>
              <div className="local-diff-selected-file" title={activeFile?.path}>{activeFile?.path}</div>
              <div className="local-diff-lines" role="region" aria-label="所选文件的代码变更">
                {activeFile?.patch.split('\n').map((line, index) => (
                  <div className={'local-diff-line ' + lineKind(line)} key={index}>
                    <span className="local-diff-line-text">{line || ' '}</span>
                  </div>
                ))}
              </div>
            </>
          ) : diff.patch ? (
            <pre className="local-diff-patch">{diff.patch}</pre>
          ) : (
            <div className="local-diff-status">{staged ? '当前没有已暂存的代码变更。' : '当前没有未暂存的代码变更。'}</div>
          )}
          {!diff.truncated && !files.length && diff.stat && (
            <pre className="local-diff-stat">{diff.stat}</pre>
          )}
        </>
      )}
      {onCommit && <form className="local-diff-commit" onSubmit={(event) => {
        event.preventDefault();
        if (commitAllowed) onCommit(reviewedPaths, commitMessage.trim());
      }}>
        <label>提交说明
          <input type="text" maxLength={500} value={commitMessage}
            placeholder="fix: 修复交互问题" disabled={committing}
            onChange={(event) => setCommitMessage(event.target.value)} />
        </label>
        <small>只提交勾选的文件，不推送远端；内容变更后需重新审阅。</small>
        <button type="submit" disabled={!commitAllowed}>
          {committing ? '提交中…' : `提交所选文件（${reviewedPaths.length}）`}
        </button>
        {commitError && <small role="alert">{commitError}</small>}
        {commitHead && <small role="status">Forge 已确认提交：<code>{commitHead.slice(0, 12)}</code></small>}
      </form>}
    </aside>
  );
}
