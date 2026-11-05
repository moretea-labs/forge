import { Component, StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

// A React render error must never turn the entire native window white with
// no diagnosis. This is a display-only fallback, not a second Runtime manager.
class DesktopRenderBoundary extends Component<{ children: ReactNode }, { error: string | null }> {
  state = { error: null as string | null };
  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
  render() {
    if (this.state.error) {
      return (
        <main role="alert" style={{ padding: 32, fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif', color: '#333' }}>
          <h1 style={{ fontSize: 20 }}>Forge 界面加载失败</h1>
          <p style={{ fontSize: 13 }}>前端发生渲染异常；当前 Forge Work 与 Runtime 未被修改。</p>
          <pre style={{ fontSize: 12, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{this.state.error}</pre>
          <button onClick={() => window.location.reload()}>重新加载界面</button>
        </main>
      );
    }
    return this.props.children;
  }
}

const root = document.getElementById('root');
if (!root) throw new Error('FORGE_DESKTOP_ROOT_REQUIRED');

createRoot(root).render(
  <StrictMode>
    <DesktopRenderBoundary><App /></DesktopRenderBoundary>
  </StrictMode>,
);
