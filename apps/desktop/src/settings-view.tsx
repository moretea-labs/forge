import { StorageCleanupPanel } from './storage-cleanup-panel';
import { useEffect, useMemo, useState } from 'react';
import type { ApiProviderProfile, LocalApiSettings, LocalApiProtocol } from './local-api';
import { managedApiCredentialControl } from './local-api';
import type { LocalProviderStatusProjection } from './runtime-client';
import { ForgeIcon } from './ui-icons';

type ProfileDraft = Pick<ApiProviderProfile, 'id' | 'label' | 'endpoint' | 'model' | 'apiProtocol'> & {
  credentialRef?: string | null;
};
export type SettingsSaveInput = {
  defaultProvider: string;
  profiles: ProfileDraft[];
  joyCodeModel?: string;
};

const ZRO_ENDPOINT = 'https://zro.moonmath.ai/v1';

// Same canonical presets as the native SwiftUI settings surface. Models are
// editable defaults, never authority: the provider decides what it serves.
const PROFILE_PRESETS: Array<{ presetKey: string; label: string; endpoint: string; model: string; apiProtocol: LocalApiProtocol }> = [
  { presetKey: 'openai', label: 'OpenAI', endpoint: 'https://api.openai.com/v1', model: 'gpt-5.1-codex', apiProtocol: 'responses' },
  { presetKey: 'anthropic', label: 'Anthropic', endpoint: 'https://api.anthropic.com/v1', model: 'claude-sonnet-4-5', apiProtocol: 'anthropic' },
  { presetKey: 'deepseek', label: 'DeepSeek', endpoint: 'https://api.deepseek.com', model: 'deepseek-chat', apiProtocol: 'openai' },
  { presetKey: 'zro', label: 'DeepSeek · Zro', endpoint: ZRO_ENDPOINT, model: 'deepseek-v4.1-flash', apiProtocol: 'openai' },
  { presetKey: 'custom', label: '自定义 Provider', endpoint: 'https://api.example.com/v1', model: '', apiProtocol: 'openai' },
];

const slug = (value: string) => value.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'profile';

function credentialRowState(profile: ApiProviderProfile | ProfileDraft, hasKey: boolean): 'managed' | 'provider-owned' | 'local' | 'missing' {
  if (profile.credentialRef) return 'managed';
  if (profile.endpoint === ZRO_ENDPOINT) return 'provider-owned';
  const loopback = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])/.test(profile.endpoint);
  if (loopback) return 'local';
  return hasKey ? 'managed' : 'missing';
}

export function SettingsView({
  settings, loading, error, onRefresh, onSave,
  codexStatus, codexError, onRefreshCodex, onOpenMcp, mcpReady, cleanupRepoId,
}: {
  settings: LocalApiSettings | null; loading: boolean; error: string | null;
  onRefresh: () => Promise<void>; onSave: (input: SettingsSaveInput) => Promise<void>;
  codexStatus: LocalProviderStatusProjection | null; codexError: string | null;
  onRefreshCodex: () => Promise<void>;
  onOpenMcp: () => void;
  mcpReady: boolean | null;
  cleanupRepoId?: string;
}) {
  const [defaultProvider, setDefaultProvider] = useState(settings?.defaultProvider ?? 'codex');
  const [profiles, setProfiles] = useState<ProfileDraft[]>(() => (settings?.profiles ?? []).map(toDraft));
  const [joyCodeModel, setJoyCodeModel] = useState(settings?.joyCodeModel ?? 'JoyAI-Code-1.6');
  const [openProfileId, setOpenProfileId] = useState<string | null>(() => {
    const id = settings?.defaultProvider.startsWith('api:') ? settings.defaultProvider.slice(4) : null;
    return id;
  });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busyProfileId, setBusyProfileId] = useState<string | null>(null);
  const [profileNotice, setProfileNotice] = useState<{ id: string; text: string; error?: boolean } | null>(null);

  useEffect(() => {
    if (!settings) return;
    setDefaultProvider(settings.defaultProvider);
    setProfiles(settings.profiles.map(toDraft));
    setJoyCodeModel(settings.joyCodeModel ?? 'JoyAI-Code-1.6');
    setOpenProfileId(current => current && settings.profiles.some(row => row.id === current)
      ? current
      : settings.defaultProvider.startsWith('api:') ? settings.defaultProvider.slice(4) : null);
  }, [settings]);

  const profileHasError = profiles.some(profile => !profile.endpoint.trim() || !profile.model.trim());
  const isDirty = Boolean(settings && (
    defaultProvider !== settings.defaultProvider
    || joyCodeModel.trim() !== (settings.joyCodeModel ?? 'JoyAI-Code-1.6')
    || profiles.length !== settings.profiles.length
    || profiles.some(profile => {
      const current = settings.profiles.find(row => row.id === profile.id);
      return !current
        || current.label !== profile.label
        || current.endpoint !== profile.endpoint
        || current.model !== profile.model
        || current.apiProtocol !== profile.apiProtocol
        || (current.credentialRef ?? null) !== (profile.credentialRef ?? null);
    })
  ));

  const selectedProfile = useMemo(
    () => profiles.find(profile => profile.id === openProfileId) ?? null,
    [openProfileId, profiles],
  );
  const defaultProfile = useMemo(() => {
    const id = defaultProvider.startsWith('api:') ? defaultProvider.slice(4) : null;
    return profiles.find(profile => profile.id === id) ?? null;
  }, [defaultProvider, profiles]);

  const save = async () => {
    if (saving || profileHasError) return;
    setSaving(true); setSaveError(null); setSaved(false);
    try {
      await onSave({ defaultProvider, profiles, joyCodeModel: joyCodeModel.trim() });
      setSaved(true);
    } catch (cause) {
      setSaveError(cause instanceof Error ? cause.message : String(cause));
    } finally { setSaving(false); }
  };

  const addPreset = (preset: typeof PROFILE_PRESETS[number]) => {
    const id = `${slug(preset.presetKey)}-${Date.now().toString(36)}`;
    setProfiles(rows => [...rows, { id, label: preset.label, endpoint: preset.endpoint, model: preset.model, apiProtocol: preset.apiProtocol }]);
    setDefaultProvider(`api:${id}`);
    setOpenProfileId(id);
    setSaved(false); setProfileNotice(null);
  };

  const updateProfile = (id: string, patch: Partial<ProfileDraft>) => {
    setProfiles(rows => rows.map(profile => profile.id === id ? { ...profile, ...patch } : profile));
    setSaved(false);
  };

  const removeProfile = (id: string) => {
    const profile = profiles.find(row => row.id === id);
    if (profile?.credentialRef) {
      setProfileNotice({ id, text: '请先删除此 Provider 的 API Key，再删除 Provider。', error: true });
      return;
    }
    const next = profiles.filter(profile => profile.id !== id);
    setProfiles(next);
    if (defaultProvider === `api:${id}`) setDefaultProvider('codex');
    if (openProfileId === id) setOpenProfileId(null);
    setSaved(false);
  };

  // Managed credential actions never touch raw key material in the UI: the
  // user copies the secret to the system clipboard and Forge moves it straight
  // into the macOS Keychain.
  const importCredential = async (id: string) => {
    const profile = profiles.find(row => row.id === id);
    if (!profile || busyProfileId) return;
    setBusyProfileId(id); setProfileNotice(null);
    try {
      const created = await managedApiCredentialControl({ operation: 'create', endpoint: profile.endpoint, label: profile.label }) as { credentialRef?: string };
      if (!created.credentialRef) throw new Error('FORGE_DESKTOP_CREDENTIAL_REF_MISSING');
      const nextProfiles = profiles.map(row => row.id === id
        ? { ...row, credentialRef: created.credentialRef }
        : row);
      setProfiles(nextProfiles);
      await onSave({ defaultProvider, profiles: nextProfiles, joyCodeModel: joyCodeModel.trim() });
      await managedApiCredentialControl({ operation: 'authorize', credentialRef: created.credentialRef, confirmAuthorization: true });
      setProfileNotice({ id, text: 'API Key 已保存并授权使用' });
      setSaved(true);
      await onRefresh();
    } catch (cause) {
      setProfileNotice({ id, text: credentialErrorText(cause), error: true });
    } finally { setBusyProfileId(null); }
  };

  const rotateCredential = async (id: string, credentialRef: string) => {
    if (busyProfileId) return;
    setBusyProfileId(id); setProfileNotice(null);
    try {
      await managedApiCredentialControl({ operation: 'rotate', credentialRef });
      setProfileNotice({ id, text: '已用剪贴板中的新密钥完成轮换' });
      await onRefresh();
    } catch (cause) {
      setProfileNotice({ id, text: credentialErrorText(cause), error: true });
    } finally { setBusyProfileId(null); }
  };

  const authorizeCredential = async (id: string, credentialRef: string) => {
    if (busyProfileId) return;
    setBusyProfileId(id); setProfileNotice(null);
    try {
      await managedApiCredentialControl({ operation: 'authorize', credentialRef, confirmAuthorization: true });
      setProfileNotice({ id, text: '已授权此凭据用于模型请求' });
      await onRefresh();
    } catch (cause) {
      setProfileNotice({ id, text: credentialErrorText(cause), error: true });
    } finally { setBusyProfileId(null); }
  };

  const deleteCredential = async (id: string, credentialRef: string) => {
    if (busyProfileId) return;
    setBusyProfileId(id); setProfileNotice(null);
    try {
      await managedApiCredentialControl({ operation: 'delete', credentialRef });
      updateProfile(id, { credentialRef: null });
      if (defaultProvider === `api:${id}`) setDefaultProvider('codex');
      setProfileNotice({ id, text: 'API Key 已删除，Provider 配置仍保留' });
      await onRefresh();
    } catch (cause) {
      setProfileNotice({ id, text: credentialErrorText(cause), error: true });
    } finally { setBusyProfileId(null); }
  };

  const profileReadyForDefault = (profile: ProfileDraft) => {
    const live = settings?.profiles.find(row => row.id === profile.id);
    return Boolean(profile.endpoint.trim() && profile.model.trim()
      && (profile.endpoint === ZRO_ENDPOINT || live?.endpointReady || Boolean(profile.credentialRef)));
  };
  const defaultValid = defaultProvider === 'codex' ? true
    : defaultProvider === 'joycode' ? Boolean(settings?.joyCodeReady)
      : Boolean(defaultProfile && profileReadyForDefault(defaultProfile));

  return <main className="main-pane settings-pane"><div className="content-column narrow-column">
    <header className="work-hero settings-hero"><div className="breadcrumb">Forge / 偏好设置</div><h1>Agent 与连接</h1>
      <p>选择新会话使用的模型来源；已有会话保持不变。</p></header>
    <section className="settings-group">
      <div className="settings-group-heading"><strong>本地 Agent</strong><span>新会话默认模型</span></div>
      <p className="settings-hint">此设置只影响新建会话，已有会话保持不变。</p>
      <div className="settings-options" role="group" aria-label="本地助手提供方">
        <button type="button" aria-pressed={defaultProvider === 'codex'}
          className={defaultProvider === 'codex' ? 'settings-option selected' : 'settings-option'}
          onClick={() => { setDefaultProvider('codex'); setOpenProfileId(null); setSaved(false); }}>
          <span className="settings-option-icon"><ForgeIcon name="terminal" size={19} /></span>
          <strong>Codex CLI</strong>
          <small>使用当前 Mac 上已登录的 Codex 帐号。</small>
          <span className="settings-option-status">
            <span className={'health-dot ' + (codexStatus?.status === 'ready' ? 'connected' : 'degraded')} />
            {codexStatus?.status === 'ready' ? '已连接' : '等待连接'}
          </span>
        </button>
        <button type="button" aria-pressed={defaultProvider === 'joycode'}
          className={defaultProvider === 'joycode' ? 'settings-option selected' : 'settings-option'}
          onClick={() => { setDefaultProvider('joycode'); setOpenProfileId(null); setSaved(false); }}>
          <span className="settings-option-icon"><ForgeIcon name="runtime" size={19} /></span>
          <strong>JoyCode</strong>
          <small>使用当前 Mac 上已登录的 JoyCode 帐号。</small>
          <span className="settings-option-status">
            <span className={'health-dot ' + (settings?.joyCodeReady ? 'connected' : 'degraded')} />
            {settings?.joyCodeReady ? '已登录' : '未检测到登录'}
          </span>
        </button>
        {profiles.map(profile => {
          const providerId = `api:${profile.id}`;
          const live = settings?.profiles.find(row => row.id === profile.id);
          return <button key={profile.id} type="button" aria-pressed={defaultProvider === providerId}
            className={defaultProvider === providerId ? 'settings-option selected' : 'settings-option'}
            onClick={() => { setDefaultProvider(providerId); setOpenProfileId(profile.id); setSaved(false); }}>
            <span className="settings-option-icon"><ForgeIcon name="settings" size={19} /></span>
            <strong>{profile.label || 'API Provider'}</strong>
            <small>{live?.endpointReady ? `${profile.model || '未设置模型'} · 就绪` : `${profile.model || '未设置模型'} · 缺少密钥`}</small>
            <span className="settings-option-status">
              <span className={'health-dot ' + (live?.endpointReady ? 'connected' : 'degraded')} />
              {defaultProvider === providerId ? '新会话默认' : live?.endpointReady ? '可用' : '未就绪'}
            </span>
          </button>;
        })}
      </div>
      <div className="settings-preset-row" aria-label="新增 API Provider 预设">
        <span className="settings-preset-label">新增：</span>
        {PROFILE_PRESETS.map(preset =>
          <button key={preset.presetKey} type="button" className="plain-action settings-preset-chip"
            disabled={loading || profiles.length >= 20}
            onClick={() => addPreset(preset)}>{preset.label}</button>)}
      </div>

      {defaultProvider === 'codex' ? <div className="settings-readout settings-provider-status">
        <span className={'health-dot ' + (codexStatus?.status === 'ready' ? 'connected' : 'degraded')} />
        <div><strong>{codexStatus?.label ?? '正在确认 Codex 连接'}</strong>
          <p>{codexError ?? codexStatus?.detail ?? '请先在 Codex CLI 中登录，然后重新检查连接。'}</p>
          <button type="button" className="plain-action" onClick={() => void onRefreshCodex()}>重新检查 Codex</button>
        </div>
      </div> : null}
      {defaultProvider === 'joycode' ? <div className="settings-fields">
        <label><span>JoyCode 模型</span><input spellCheck={false} autoComplete="off" value={joyCodeModel}
          onChange={e => { setJoyCodeModel(e.target.value); setSaved(false); }} placeholder="JoyAI-Code-1.6" /></label>
        <p className="settings-hint">使用本机已有的 JoyCode 登录状态。</p>
        <div className="settings-secret-state">{settings?.joyCodeReady ? 'JoyCode：已检测到登录态' : 'JoyCode：请先在 JoyCode 客户端登录'}</div>
      </div> : null}

      {selectedProfile && openProfileId === selectedProfile.id ?
        <div className="settings-fields settings-profile-editor" aria-label="API Provider 配置">
          <label><span>名称</span><input spellCheck={false} autoComplete="off" value={selectedProfile.label}
            onChange={e => updateProfile(selectedProfile.id, { label: e.target.value })} placeholder="例如 OpenAI / 团队网关" /></label>
          <label><span>API 协议</span><select aria-label="API 协议" value={selectedProfile.apiProtocol}
            onChange={e => updateProfile(selectedProfile.id, { apiProtocol: e.target.value as LocalApiProtocol })}>
            <option value="openai">OpenAI-compatible · Chat Completions</option>
            <option value="responses">OpenAI-compatible · Responses</option>
            <option value="anthropic">Claude · Anthropic Messages</option>
          </select></label>
          <label><span>API Endpoint</span><input type="url" spellCheck={false} autoComplete="off" value={selectedProfile.endpoint}
            onChange={e => updateProfile(selectedProfile.id, { endpoint: e.target.value.trim() })} placeholder="https://api.example.com/v1" /></label>
          <label><span>模型 ID</span><input spellCheck={false} autoComplete="off" value={selectedProfile.model}
            onChange={e => updateProfile(selectedProfile.id, { model: e.target.value.trim() })} placeholder="Provider 的模型名称" /></label>
          <CredentialRow
            profile={selectedProfile}
            live={settings?.profiles.find(row => row.id === selectedProfile.id)}
            busy={busyProfileId === selectedProfile.id}
            notice={profileNotice?.id === selectedProfile.id ? profileNotice : null}
            onImport={() => void importCredential(selectedProfile.id)}
            onRotate={() => selectedProfile.credentialRef && void rotateCredential(selectedProfile.id, selectedProfile.credentialRef)}
            onAuthorize={() => selectedProfile.credentialRef && void authorizeCredential(selectedProfile.id, selectedProfile.credentialRef)}
            onDelete={() => selectedProfile.credentialRef && void deleteCredential(selectedProfile.id, selectedProfile.credentialRef)}
          />
          <div className="settings-profile-footnote">
            <button type="button" className="plain-action settings-danger-action" disabled={busyProfileId !== null}
              onClick={() => removeProfile(selectedProfile.id)}>删除此 Provider</button>
            <p className="settings-hint">{selectedProfile.credentialRef
              ? '请先删除此 Provider 的 API Key，再删除 Provider。'
              : '删除 Provider 不会影响已有会话。'}</p>
          </div>
        </div> : null}

      {error && <p className="inline-error" role="alert">{error}</p>}
      {saveError && <p className="inline-error" role="alert">{saveError}</p>}
      {profileHasError && <p className="inline-error" role="alert">每个 Provider 都需要非空的 Endpoint 和模型 ID。</p>}
      <div className="settings-actions">
        <button type="button" className="plain-action" disabled={loading || saving} onClick={() => void onRefresh()}>重新读取配置</button>
        <button type="button" className="settings-save" disabled={loading || saving || !settings || !isDirty || !defaultValid || profileHasError}
          onClick={() => void save()}>
          {saving ? '保存中…' : defaultProvider === 'codex' ? '使用 Codex CLI'
            : defaultProvider === 'joycode' ? '使用 JoyCode'
              : defaultProfile ? `使用 ${defaultProfile.label || 'API Provider'}` : '保存配置'}
        </button>
        {saved && <span className="settings-saved" role="status">已保存</span>}
      </div>
    </section>
    <StorageCleanupPanel repoId={cleanupRepoId} />
    <section className="settings-group settings-mcp-entry" aria-label="外部 MCP 连接">
      <div className="settings-group-heading"><strong>外部 MCP 服务</strong><span>连接状态</span></div>
      <div className="settings-mcp-card">
        <span className="settings-option-icon"><ForgeIcon name="runtime" size={19} /></span>
        <div><strong>ChatGPT / 外部 MCP 客户端</strong>
          <p>查看 ChatGPT 和其他外部客户端的连接状态。</p>
          <small>{mcpReady === null ? '尚未检查连接' : mcpReady ? 'Forge 控制器连接已就绪' : '连接需要检查或配置'}</small>
        </div>
        <button type="button" className="plain-action" onClick={onOpenMcp}>查看连接 <ForgeIcon name="chevron" size={14} /></button>
      </div>
    </section>
  </div></main>;
}

function CredentialRow({ profile, live, busy, notice, onImport, onRotate, onAuthorize, onDelete }: {
  profile: ProfileDraft;
  live?: ApiProviderProfile;
  busy: boolean;
  notice: { text: string; error?: boolean } | null;
  onImport: () => void;
  onRotate: () => void;
  onAuthorize: () => void;
  onDelete: () => void;
}) {
  const hasManagedKey = live?.hasKey ?? Boolean(profile.credentialRef);
  const state = credentialRowState(profile, hasManagedKey);
  if (state === 'provider-owned') {
    return <div className="settings-secret-state">此服务由提供商管理 API Key，无需本地密钥</div>;
  }
  if (state === 'local') {
    return <div className="settings-secret-state">本地服务无需 API Key</div>;
  }
  return <div className="settings-credential-block">
    <div className="settings-secret-state">
      {state === 'managed'
        ? hasManagedKey ? 'API Key 已保存在本机 Keychain' : 'Keychain 中未找到 API Key，请重新导入'
        : '尚未配置 API Key，请先复制 API Key 到系统剪贴板'}
    </div>
    <div className="settings-credential-actions">
      {state === 'managed' && profile.credentialRef ? <>
        {hasManagedKey && <button type="button" className="plain-action" disabled={busy} onClick={onAuthorize}>授权使用</button>}
        <button type="button" className="plain-action" disabled={busy} onClick={onRotate}>
          {hasManagedKey ? '用剪贴板轮换' : '从剪贴板重新导入'}
        </button>
        <button type="button" className="plain-action settings-danger-action" disabled={busy} onClick={onDelete}>删除 API Key</button>
      </> : <button type="button" className="plain-action" disabled={busy} onClick={onImport}>从剪贴板导入并授权</button>}
      {busy && <span className="settings-busy" role="status">处理中…</span>}
    </div>
    {notice && <p className={notice.error ? 'inline-error' : 'settings-saved'} role={notice.error ? 'alert' : 'status'}>{notice.text}</p>}
    <p className="settings-hint">API Key 仅保存在本机 Keychain，不会显示在对话或日志中。</p>
  </div>;
}

function credentialErrorText(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause);
  if (message.includes('CLIPBOARD')) return '未在剪贴板读到 API Key：请先复制密钥再重试';
  if (message.includes('NOT_AUTHORIZED') || message.includes('CONFIRMATION')) return '授权未完成：请重试授权步骤';
  return message;
}

const toDraft = (profile: ApiProviderProfile): ProfileDraft => ({
  id: profile.id, label: profile.label, endpoint: profile.endpoint,
  model: profile.model, apiProtocol: profile.apiProtocol,
  credentialRef: profile.credentialRef ?? null,
});
