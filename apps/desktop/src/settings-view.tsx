import { useEffect, useState } from 'react';
import type { LocalApiSettings, LocalProviderChoice, LocalApiProtocol } from './local-api';
import type { LocalProviderStatusProjection } from './runtime-client';
type SaveInput = { provider: LocalProviderChoice; endpoint: string; model: string; apiProtocol: LocalApiProtocol; apiKey?: string };
export function SettingsView({ settings, loading, error, onRefresh, onSave, onClearKey, codexStatus, codexError }: {
  settings: LocalApiSettings | null; loading: boolean; error: string | null;
  onRefresh: () => Promise<void>; onSave: (input: SaveInput) => Promise<void>; onClearKey: () => Promise<void>;
  codexStatus: LocalProviderStatusProjection | null; codexError: string | null;
}) {
  const [provider, setProvider] = useState<LocalProviderChoice>('codex');
  const [apiProtocol, setApiProtocol] = useState<LocalApiProtocol>('openai');
  const [endpoint, setEndpoint] = useState('https://api.openai.com/v1');
  const [model, setModel] = useState('');
  const [key, setKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => { if (settings) { setProvider(settings.provider); setEndpoint(settings.endpoint); setModel(settings.model); setApiProtocol(settings.apiProtocol ?? 'openai'); } }, [settings]);
  const currentHasKey = Boolean(settings?.hasKey && endpoint.trim() === settings.endpoint);
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
    <header className="work-hero"><div className="breadcrumb">Forge / 偏好设置</div><h1>设置</h1>
      <p>本地对话可使用 Codex CLI 或兼容 API。Forge 的工作、需求、计划、知识由原有 Runtime 负责。</p></header>
    <section className="settings-group">
      <div className="settings-group-heading"><strong>本地助手</strong><span>对话提供方</span></div>
      <div className="settings-options" role="group" aria-label="本地助手提供方">
        <button type="button" className={provider === 'codex' ? 'settings-option selected' : 'settings-option'} onClick={() => { setProvider('codex'); setSaved(false); }}><strong>Codex CLI</strong><small>使用现有登录，支持 Forge MCP 工具</small></button>
        <button type="button" className={provider === 'api' ? 'settings-option selected' : 'settings-option'} onClick={() => { setProvider('api'); setSaved(false); }}><strong>兼容 API</strong><small>OpenAI / Claude · 通过 Forge 本地工具执行</small></button>
      </div>
      {provider === 'codex' ? <div className="settings-readout"><span className={'health-dot ' + (codexStatus?.status === 'ready' ? 'connected' : 'degraded')} /><div><strong>{codexStatus?.label ?? 'Codex 状态未知'}</strong><p>{codexError ?? codexStatus?.detail ?? '通过 Forge Runtime 访问。'}</p></div></div> :
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
          <p className="settings-hint">允许 HTTPS 或本机 HTTP（localhost/127.0.0.1）。密钥存在 macOS Keychain，不进入 localStorage。API 模型通过本机受控 Forge 工具通道读取仓库和 Git 状态，不走 MCP HTTP；写入或命令执行须每次明确授权，仍遵循 Forge 的原有权限与资源锁。</p>
          <div className="settings-secret-state">{currentHasKey ? '钥匙串：已存密钥' : '钥匙串：无密钥'}</div>
          {currentHasKey && <button className="plain-action settings-remove-secret" type="button" disabled={saving} onClick={() => void clearKey()}>删除此 Endpoint 的密钥</button>}
        </div>}
      {error && <p className="inline-error" role="alert">{error}</p>}
      {saveError && <p className="inline-error" role="alert">{saveError}</p>}
      <div className="settings-actions"><button type="button" className="plain-action" disabled={loading || saving} onClick={() => void onRefresh()}>重新读取</button><button type="button" className="settings-save" disabled={loading || saving || !settings || (provider === 'api' && (!endpoint.trim() || !model.trim()))} onClick={() => void save()}>{saving ? '保存中…' : '保存设置'}</button>{saved && <span className="settings-saved" role="status">已保存</span>}</div>
    </section>
    <section className="settings-group"><div className="settings-group-heading"><strong>执行提供方与 MCP 服务</strong></div><p className="settings-hint">桌面应用是 Forge 的本地工作入口，所有已注册项目、Requirement、Plan、Work、Memory 始终可见，与聊天模型选择无关。Codex CLI 使用已授权的 Forge 工具；OpenAI/Claude API 支持本地工具调用，但不自动创建或完成 Requirement/Plan/Work；所有修改仍由 Forge 既有执行权威管理。MCP 是向 ChatGPT 等外部客户端开放 Forge 能力的服务接口，连接状态可在左下角「MCP 服务与运行时」查看，不属于聊天模式切换。</p></section>
  </div></main>;
}
