import { useState } from 'react';

export interface GitDiffReceipt {
  stat: string;
  patch: string;
  truncated: boolean;
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
  diff, loading, error, onRefresh, onClose,
}: {
  diff?: GitDiffReceipt;
  loading: boolean;
  error?: string;
  onRefresh: () => void;
  onClose: () => void;
}) {
  const [activePath, setActivePath] = useState<string>();
  const files = splitGitDiffFiles(diff?.patch ?? '');
  const activeFile = files.find((file) => file.path === activePath) ?? files[0];

  return (
    <aside className="local-git-inspector" aria-label="Git 变更审阅">
      <header>
        <strong>Changes</strong>
        <span className="local-diff-file-count">{files.length} 个文件</span>
        <button className="plain-action" type="button" onClick={onRefresh} disabled={loading}>刷新</button>
        <button className="plain-action" type="button" onClick={onClose}>关闭</button>
      </header>
      {loading && <div role="status" className="local-diff-status">从 Forge Git 读取变更…</div>}
      {error && <p role="alert" className="inline-error">读取失败：{error}</p>}
      {!loading && !error && diff && (
        <>
          {diff.truncated && <p className="local-diff-warning">仅展示 Forge 返回的部分 Diff，不代表完整文件变更。</p>}
          {files.length > 0 ? (
            <>
              <nav className="local-diff-file-list" aria-label="已修改文件">
                {files.map((file) => (
                  <button className={file.path === activeFile?.path ? 'active' : ''} key={file.path}
                    type="button" aria-pressed={file.path === activeFile?.path}
                    title={file.path} onClick={() => setActivePath(file.path)}>
                    <span className="local-diff-file-path">{file.path}</span>
                    <span className="local-diff-file-counts">
                      <span>+{file.added}</span><span>−{file.removed}</span>
                    </span>
                  </button>
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
            <div className="local-diff-status">当前没有可审阅的未提交代码变更。</div>
          )}
          {!diff.truncated && !files.length && diff.stat && (
            <pre className="local-diff-stat">{diff.stat}</pre>
          )}
        </>
      )}
    </aside>
  );
}
