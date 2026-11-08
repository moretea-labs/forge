import { useEffect, useState } from 'react';
import type { LocalApiSettings, LocalProviderChoice, LocalApiProtocol } from './local-api';
import type { LocalProviderStatusProjection } from './runtime-client';
import { ForgeIcon } from './ui-icons';
type SaveInput = { provider: LocalProviderChoice; endpoint: string; model: string; apiProtocol: LocalApiProtocol; credentialRef?: string; joyCodeModel?: string };
export function SettingsView({
  settings, loading, error, onRefresh, onSave,
  codexStatus, codexError, onRefreshCodex, onOpenMcp, mcpReady,
}: {
  settings: LocalApiSettings | null; loading: boolean; error: string | null;
  onRefresh: () => Promise<void>; onSave: (input: SaveInput) => Promise<void>;
  codexStatus: LocalProviderStatusProjection | null; codexError: string | null;
  onRefreshCodex: () => Promise<void>;
  onOpenMcp: () => void;
  mcpReady: boolean | null;
}) {
  const [provider, setProvider] = useState<LocalProviderChoice>(settings?.provider ?? 'codex');
  const [apiProtocol, setApiProtocol] = useState<LocalApiProtocol>(settings?.apiProtocol ?? 'openai');
  const [endpoint, setEndpoint] = useState(settings?.endpoint ?? 'https://api.openai.com/v1');
  const [model, setModel] = useState(settings?.model ?? '');
  const [joyCodeModel, setJoyCodeModel] = useState(settings?.joyCodeModel ?? 'JoyAI-Code-1.6');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => { if (settings) { setProvider(settings.provider); setEndpoint(settings.endpoint); setModel(settings.model); setJoyCodeModel(settings.joyCodeModel ?? 'JoyAI-Code-1.6'); setApiProtocol(settings.apiProtocol ?? 'openai'); } }, [settings]);
  const isDirty = Boolean(settings && (
    provider !== settings.provider || (provider === 'api' && (
      endpoint.trim() !== settings.endpoint || model.trim() !== settings.model
      || apiProtocol !== settings.apiProtocol
    )) || (provider === 'joycode' && joyCodeModel.trim() !== settings.joyCodeModel)
  ));
  const save = async () => {
    if (saving) return;
    setSaving(true); setSaveError(null); setSaved(false);
    try {
      await onSave({ provider, endpoint: endpoint.trim(), model: model.trim(), apiProtocol, joyCodeModel: joyCodeModel.trim(), ...(settings?.credentialRef ? { credentialRef: settings.credentialRef } : {}) });
      setSaved(true);
    } catch (cause) { setSaveError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setSaving(false); }
  };
  return <main className="main-pane settings-pane"><div className="content-column narrow-column">
    <header className="work-hero settings-hero"><div className="breadcrumb">Forge / 偏好设置</div><h1>Agent 与连接</h1>
      <p>先选择本地 Agent 的模型来源。项目与 Checkout 在会话中选择；历史 Work 仅用于兼容读取，MCP 独立提供外部客户端接入。</p></header>
    <section className="settings-group">
      <div className="settings-group-heading"><strong>本地 Agent</strong><span>新会话默认模型</span></div>
      <p className="settings-hint">更改默认模型仅影响新建会话；已有会话继续使用创建时的 Codex 或 API，不会丢失历史记录和已有项目上下文。</p>
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
        <button type="button" aria-pressed={provider === 'joycode'}
          className={provider === 'joycode' ? 'settings-option selected' : 'settings-option'}
          onClick={() => { setProvider('joycode'); setSaved(false); }}>
          <span className="settings-option-icon"><ForgeIcon name="runtime" size={19} /></span>
          <strong>JoyCode</strong>
          <small>复用本机 JoyCode 登录态；凭据不写入 Forge 配置。</small>
          <span className="settings-option-status">
            <span className={'health-dot ' + (settings?.joyCodeReady ? 'connected' : 'degraded')} />
            {settings?.joyCodeReady ? '已登录' : '未检测到登录'}
          </span>
        </button>
      </div>
      {provider === 'codex' ? <div className="settings-readout settings-provider-status">
        <span className={'health-dot ' + (codexStatus?.status === 'ready' ? 'connected' : 'degraded')} />
        <div><strong>{codexStatus?.label ?? '正在确认 Codex 连接'}</strong>
          <p>{codexError ?? codexStatus?.detail ?? '使用当前 Mac 的 Codex CLI 登录，执行由 Forge Runtime 管理。'}</p>
          <button type="button" className="plain-action" onClick={() => void onRefreshCodex()}>重新检查 Codex</button>
        </div>
      </div> : provider === 'joycode' ?
        <div className="settings-fields">
          <label><span>JoyCode 模型</span><input spellCheck={false} autoComplete="off" value={joyCodeModel}
            onChange={e => { setJoyCodeModel(e.target.value); setSaved(false); }} placeholder="JoyAI-Code-1.6" /></label>
          <p className="settings-hint">Forge 运行时只读取本机 JoyCode 当前登录态并在内存中使用；不会把 JoyCode 凭据复制到 local-api.json 或 Keychain。</p>
          <div className="settings-secret-state">{settings?.joyCodeReady ? 'JoyCode：已检测到登录态' : 'JoyCode：请先在 JoyCode 客户端登录'}</div>
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
            <option value="responses">OpenAI-compatible · Responses</option>
            <option value="anthropic">Claude · Anthropic Messages</option>
          </select></label>
          <label><span>API Endpoint</span><input type="url" spellCheck={false} autoComplete="off" value={endpoint} onChange={e => { setEndpoint(e.target.value); setSaved(false); }} placeholder="https://api.example.com/v1" /></label>
          <label><span>模型 ID</span><input spellCheck={false} autoComplete="off" value={model} onChange={e => { setModel(e.target.value); setSaved(false); }} placeholder="API 提供商的模型名称" /></label>
          <div className="settings-secret-state">Credential：{settings?.credentialRef ?? (endpoint === 'https://zro.moonmath.ai/v1' ? 'zro 管理' : '未选择')}</div>
          <p className="settings-hint">开发面不接收 raw API Key。Forge-managed credential 的导入、轮换、授权和删除由安装版 SwiftUI 设置页完成；这里只保存 opaque credential ref。仓库写权限由持久 Repository AccessPolicy 决定。</p>
        </div>}
      {error && <p className="inline-error" role="alert">{error}</p>}
      {saveError && <p className="inline-error" role="alert">{saveError}</p>}
      <div className="settings-actions"><button type="button" className="plain-action" disabled={loading || saving} onClick={() => void onRefresh()}>重新读取配置</button><button type="button" className="settings-save" disabled={loading || saving || !settings || !isDirty || (provider === 'api' && (!endpoint.trim() || !model.trim())) || (provider === 'joycode' && (!joyCodeModel.trim() || !settings.joyCodeReady))} onClick={() => void save()}>{saving ? '保存中…' : provider === 'codex' ? '使用 Codex CLI' : provider === 'joycode' ? '使用 JoyCode' : '保存 API 配置'}</button>{saved && <span className="settings-saved" role="status">已保存</span>}</div>
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
