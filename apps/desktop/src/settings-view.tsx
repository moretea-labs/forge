import { useEffect, useState } from 'react';
import type { LocalApiSettings, LocalProviderChoice, LocalApiProtocol } from './local-api';
import type { LocalProviderStatusProjection } from './runtime-client';
import { ForgeIcon } from './ui-icons';
type SaveInput = { provider: LocalProviderChoice; endpoint: string; model: string; apiProtocol: LocalApiProtocol; apiKey?: string };
export function SettingsView({
  settings, loading, error, onRefresh, onSave, onClearKey,
  codexStatus, codexError, onRefreshCodex, onOpenMcp, mcpReady,
}: {
  settings: LocalApiSettings | null; loading: boolean; error: string | null;
  onRefresh: () => Promise<void>; onSave: (input: SaveInput) => Promise<void>; onClearKey: () => Promise<void>;
  codexStatus: LocalProviderStatusProjection | null; codexError: string | null;
  onRefreshCodex: () => Promise<void>;
  onOpenMcp: () => void;
  mcpReady: boolean | null;
}) {
  const [provider, setProvider] = useState<LocalProviderChoice>(settings?.provider ?? 'codex');
  const [apiProtocol, setApiProtocol] = useState<LocalApiProtocol>(settings?.apiProtocol ?? 'openai');
  const [endpoint, setEndpoint] = useState(settings?.endpoint ?? 'https://api.openai.com/v1');
  const [model, setModel] = useState(settings?.model ?? '');
  const [key, setKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => { if (settings) { setProvider(settings.provider); setEndpoint(settings.endpoint); setModel(settings.model); setApiProtocol(settings.apiProtocol ?? 'openai'); } }, [settings]);
  const currentHasKey = Boolean(settings?.hasKey && endpoint.trim() === settings.endpoint);
  const isDirty = Boolean(settings && (
    provider !== settings.provider || (provider === 'api' && (
      endpoint.trim() !== settings.endpoint || model.trim() !== settings.model
      || apiProtocol !== settings.apiProtocol || Boolean(key)
    ))
  ));
  const clearKey = async () => {
    if (!currentHasKey || saving || !window.confirm('从 macOS 钥匙串删除此 Endpoint 的 API Key？')) return;
    setSaving(true); setSaveError(null); setSaved(false);
    try { await onClearKey(); setKey(''); setSaved(true); }
    catch (cause) { setSaveError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setSaving(false); }
  };
  const save = async () => {
    if (saving) return;
    setSaving(true); setSaveError(null); setSaved(false);
    try {
      await onSave({ provider, endpoint: endpoint.trim(), model: model.trim(), apiProtocol, ...(key ? { apiKey: key } : {}) });
      setKey(''); setSaved(true);
    } catch (cause) { setSaveError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setSaving(false); }
  };
  return <main className="main-pane settings-pane"><div className="content-column narrow-column">
    <header className="work-hero settings-hero"><div className="breadcrumb">Forge / 偏好设置</div><h1>Agent 与连接</h1>
      <p>先选择本地 Agent 的模型来源。项目、Checkout 与 Work 在会话中选择；MCP 独立提供外部客户端接入。</p></header>
    <section className="settings-group">
      <div className="settings-group-heading"><strong>本地 Agent</strong><span>选择执行引擎</span></div>
      <div className="settings-options" role="group" aria-label="本地助手提供方">
        <button type="button" aria-pressed={provider === 'codex'}
          className={provider === 'codex' ? 'settings-option selected' : 'settings-option'}
          onClick={() => { setProvider('codex'); setSaved(false); }}>
          <span className="settings-option-icon"><ForgeIcon name="terminal" size={19} /></span>
          <strong>Codex CLI</strong>
          <small>复用本机登录，通过 Forge Runtime 工具执行。无需 API Key。</small>
          <span className="settings-option-status">
            <span className={'health-dot ' + (codexStatus?.status === 'ready' ? 'connected' : 'degraded')} />
            {codexStatus?.status === 'ready' ? '已连接' : '等待连接'}
          </span>
        </button>
        <button type="button" aria-pressed={provider === 'api'}
          className={provider === 'api' ? 'settings-option selected' : 'settings-option'}
          onClick={() => { setProvider('api'); setSaved(false); }}>
          <span className="settings-option-icon"><ForgeIcon name="settings" size={19} /></span>
          <strong>兼容 API</strong>
          <small>自定义 OpenAI / Anthropic 接口、模型与密钥。工具调用使用 Forge 本地执行器。</small>
          <span className="settings-option-status">自定义模型</span>
        </button>
      </div>
      {provider === 'codex' ? <div className="settings-readout settings-provider-status">
        <span className={'health-dot ' + (codexStatus?.status === 'ready' ? 'connected' : 'degraded')} />
        <div><strong>{codexStatus?.label ?? '正在确认 Codex 连接'}</strong>
          <p>{codexError ?? codexStatus?.detail ?? '使用当前 Mac 的 Codex CLI 登录，执行由 Forge Runtime 管理。'}</p>
          <button type="button" className="plain-action" onClick={() => void onRefreshCodex()}>重新检查 Codex</button>
        </div>
      </div> :
        <div className="settings-fields">
          <label><span>API 协议</span><select aria-label="API 协议" value={apiProtocol}
            onChange={(event) => {
              const next = event.target.value as LocalApiProtocol;
              setApiProtocol(next);
              if (endpoint === 'https://api.openai.com/v1' || endpoint === 'https://api.anthropic.com/v1') {
                setEndpoint(next === 'anthropic' ? 'https://api.anthropic.com/v1' : 'https://api.openai.com/v1');
              }
              setSaved(false);
            }}>
            <option value="openai">OpenAI-compatible · Chat Completions</option>
            <option value="anthropic">Claude · Anthropic Messages</option>
          </select></label>
          <label><span>API Endpoint</span><input type="url" spellCheck={false} autoComplete="off" value={endpoint} onChange={e => { setEndpoint(e.target.value); setSaved(false); }} placeholder="https://api.example.com/v1" /></label>
          <label><span>模型 ID</span><input spellCheck={false} autoComplete="off" value={model} onChange={e => { setModel(e.target.value); setSaved(false); }} placeholder="API 提供商的模型名称" /></label>
          <label><span>API Key</span><input type="password" autoComplete="new-password" value={key} onChange={e => { setKey(e.target.value); setSaved(false); }} placeholder={currentHasKey ? '已保存在钥匙串；留空保持' : '填写密钥，本地服务可留空'} /></label>
          <p className="settings-hint">远端接口必须使用 HTTPS，本机服务可用 localhost HTTP。API Key 仅保存在 macOS Keychain。API 模型使用 Forge 本地工具；写文件、运行命令必须逐次授权。</p>
          <div className="settings-secret-state">{currentHasKey ? '钥匙串：已存密钥' : '钥匙串：无密钥'}</div>
          {currentHasKey && <button className="plain-action settings-remove-secret" type="button" disabled={saving} onClick={() => void clearKey()}>删除此 Endpoint 的密钥</button>}
        </div>}
      {error && <p className="inline-error" role="alert">{error}</p>}
      {saveError && <p className="inline-error" role="alert">{saveError}</p>}
      <div className="settings-actions"><button type="button" className="plain-action" disabled={loading || saving} onClick={() => void onRefresh()}>重新读取配置</button><button type="button" className="settings-save" disabled={loading || saving || !settings || !isDirty || (provider === 'api' && (!endpoint.trim() || !model.trim()))} onClick={() => void save()}>{saving ? '保存中…' : provider === 'codex' ? '使用 Codex CLI' : '保存 API 配置'}</button>{saved && <span className="settings-saved" role="status">已保存</span>}</div>
    </section>
    <section className="settings-group settings-mcp-entry" aria-label="外部 MCP 连接">
      <div className="settings-group-heading"><strong>外部 MCP 服务</strong><span>与本地 Agent 分离</span></div>
      <div className="settings-mcp-card">
        <span className="settings-option-icon"><ForgeIcon name="runtime" size={19} /></span>
        <div><strong>ChatGPT / 外部 MCP 客户端</strong>
          <p>由 Forge 现有控制器与连接配置提供，不影响上面的 Codex 或 API 选择。</p>
          <small>{mcpReady === null ? '尚未检查连接' : mcpReady ? 'Forge 控制器连接已就绪' : '连接需要检查或配置'}</small>
        </div>
        <button type="button" className="plain-action" onClick={onOpenMcp}>查看连接 <ForgeIcon name="chevron" size={14} /></button>
      </div>
    </section>
  </div></main>;
}
