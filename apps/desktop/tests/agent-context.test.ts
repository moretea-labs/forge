import { describe, expect, test } from 'bun:test';
import { ContextOptionList, contextOptionIndex, localPendingCopy, advanceLocalToolProgress, createThread, localConversationNavItems, LocalConversationSurface, LocalMessageBody, selectThreadCheckout, selectThreadRepository, shouldSubmitComposerKey, transcriptIsNearBottom } from '../src/local-conversation';
import { ForgeIcon } from '../src/ui-icons';
import { isApiProvider, providerForNewThread } from '../src/local-api';
import { RuntimeView, Sidebar, codexBoundPrompt, sidebarToggleShortcut } from '../src/App';
import { SettingsView } from '../src/settings-view';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordProcessHandleIndexEntry, repositoryExecutionTarget } from '../../../src/runtime/execution/process-runtime/handle-index';
import { createProcessRecord } from '../../../src/runtime/execution/process-runtime/store';
import { callProcessTool } from '../../../src/runtime/execution/process-runtime/tool-dispatch';
import { repositoryLabel } from '../src/runtime-client';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ProjectRecordsView } from '../src/project-records-view';
import { designPreviewProjection, disconnectedProjection } from '../src/runtime-projection';

describe('Forge Desktop Agent thread identity', () => {
  test('context options select directly, close and return focus, with keyboard navigation', () => {
    const selected: string[] = [];
    const list = ContextOptionList({ label: 'Project', value: 'a', options: [
      { value: 'a', label: 'Current' }, { value: 'b', label: 'Other' },
    ], onSelect: (value) => selected.push(value) });
    const html = renderToStaticMarkup(list);
    expect(html).toContain('aria-label="Project"');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('aria-pressed="false"');
    expect(html).not.toContain('<select');
    let focused = false;
    const menu = { open: true, querySelector: () => ({ focus: () => { focused = true; } }) };
    const buttons = list.props.children as Array<{ props: { onClick: (event: unknown) => void } }>;
    buttons[1]!.props.onClick({ currentTarget: { closest: () => menu } });
    expect(selected).toEqual(['b']);
    expect(menu.open).toBe(false);
    expect(focused).toBe(true);
    expect(contextOptionIndex('ArrowDown', 1, 2)).toBe(0);
    expect(contextOptionIndex('ArrowUp', 0, 2)).toBe(1);
    expect(contextOptionIndex('Home', 1, 2)).toBe(0);
    expect(contextOptionIndex('End', 0, 2)).toBe(1);
    expect(contextOptionIndex('Tab', 0, 2)).toBeUndefined();
    expect(contextOptionIndex('End', 0, 0)).toBeUndefined();
  });

  test('Codex pending copy describes absent progress and preserves cancellation status', () => {
    expect(localPendingCopy('codex', false, [])).toContain('不提供工具进度');
    expect(localPendingCopy('codex', false, [])).toContain('停止');
    expect(localPendingCopy('codex', true, [])).toContain('已请求停止');
    expect(localPendingCopy('api', false, [])).toBe('Agent 正在处理请求…');
  });

  test('new API sessions pin exact provider profile while legacy generic API fails closed', () => {
    const deepseek = providerForNewThread({ provider: 'api', defaultProvider: 'api:deepseek' });
    const pinned = createThread(deepseek, 'repo_one', 'checkout_one');
    expect(deepseek).toBe('api:deepseek');
    expect(isApiProvider(pinned.provider)).toBe(true);
    expect(providerForNewThread({ provider: 'api', defaultProvider: 'api:openai' })).toBe('api:openai');
    expect(pinned.provider).toBe('api:deepseek');
    const established = { ...pinned, messages: [{ id: 'one', role: 'user' as const,
      content: 'task', createdAt: '2026-11-11T00:00:00Z' }] };
    expect(selectThreadRepository(established, established.provider!, 'repo_two', 'checkout_two').thread.provider).toBe('api:deepseek');
    expect(providerForNewThread({ provider: 'codex', defaultProvider: 'codex' })).toBe('codex');
    expect(createThread('api', 'repo_one').provider).toBe('api');
    expect(isApiProvider('api')).toBe(true);
    const native = readFileSync(new URL('../src-tauri/src/main.rs', import.meta.url), 'utf8');
    expect(native).toContain('FORGE_DESKTOP_API_THREAD_PROFILE_UNPINNED');
  });

  test('Codex send passes the thread checkout through the Tauri client', () => {
    const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
    const client = readFileSync(new URL('../src/runtime-client.ts', import.meta.url), 'utf8');
    expect(app).toMatch(/sendLocalConversation\(\{[\s\S]*?repoId: thread.projectRepoId,\s*checkoutId: thread.checkoutId/);
    expect(client).toMatch(/'send_local_conversation',[\s\S]*?repoId: input.repoId,\s*checkoutId: input.checkoutId/);
  });

  test('Codex gets exact selected project and checkout without lifecycle binding', () => {
    const thread = createThread('codex', 'repo_forge', 'checkout_forge');
    const prompt = codexBoundPrompt(thread, 'Please implement the plan.');
    expect(prompt).toContain('selected repo_id=repo_forge');
    expect(prompt).toContain('selected checkout_id=checkout_forge');
    expect(prompt).not.toContain('Forge Work');
    expect(prompt).toContain('verify that the exact repo_id AND checkout_id');
    expect(prompt).toContain('If a tool cannot target the selected checkout, do not mutate');
    expect(prompt).toContain('Please implement the plan.');
    const unbound = createThread('codex');
    expect(codexBoundPrompt(unbound, 'Hello')).toBe('Hello');
  });

  test('independent repository conversations retain their own running status and sidebar groups', () => {
    const first = { ...createThread('codex', 'repo_one', 'checkout_one'),
      title: 'Implement feature A', messages: [{
        id: 'one', role: 'user' as const, content: 'Implement feature A',
        createdAt: '2026-11-06T08:00:00Z',
      }] };
    const second = { ...createThread('codex', 'repo_two', 'checkout_two'),
      title: 'Review feature B', messages: [{
        id: 'two', role: 'user' as const, content: 'Review feature B',
        createdAt: '2026-11-06T08:02:00Z',
      }] };
    const nav = localConversationNavItems([first, second], {}, new Set([first.id]));
    expect(nav).toHaveLength(2);
    expect(nav.find((item) => item.id === first.id)).toMatchObject({
      projectRepoId: 'repo_one', running: true,
    });
    expect(nav.find((item) => item.id === second.id)).toMatchObject({
      projectRepoId: 'repo_two',
    });
    expect(nav.find((item) => item.id === second.id)?.running).toBeUndefined();
    const projects = [
      { repoId: 'repo_one', name: 'Project A', repository: 'example/project-a', checkoutId: 'checkout_one' },
      { repoId: 'repo_two', name: 'Project B', repository: 'example/project-b', checkoutId: 'checkout_two' },
    ];
    const html = renderToStaticMarkup(createElement(Sidebar, {
      projects, selectedRepoId: 'repo_one', activeView: 'assistant',
      runtimeLabel: 'Ready', runtimeStatus: 'connected', runtimeDetail: '',
      onRetryProjects() {}, onOpenAssistant() {}, onNewThread() {}, onNewProjectThread() {},
      onOpenProjects() {}, onOpenRequirements() {}, onOpenPlans() {},
      onOpenKnowledge() {}, onOpenSettings() {}, onSelectProject() {},
      localThreads: nav, selectedLocalThreadId: first.id, onSelectLocalThread() {},
    }));
    expect(html).toContain('project-a');
    expect(html).toContain('project-b');
    expect(html).toContain('Implement feature A');
    expect(html).toContain('Review feature B');
    expect(html).toContain('在 project-a 中新建会话');
    expect(html).toContain('在 project-b 中新建会话');
    expect((html.match(/sidebar-project-conversations/g) ?? [])).toHaveLength(2);
    expect((html.match(/sidebar-turn-running/g) ?? [])).toHaveLength(1);
    // Primary semantic destinations stay above the local conversation index.
    expect(html).toContain('sidebar-primary');
    expect(html).toContain('sidebar-conversations');
    expect(html.indexOf('sidebar-new-thread')).toBeLessThan(html.indexOf('sidebar-conversations'));
    expect((html.match(/aria-label="搜索会话"/g) ?? [])).toHaveLength(1);
    expect(html).toContain('aria-current="page"');
  });

  test('new provider defaults never hide older pinned Codex/API conversations', () => {
    const codex = { ...createThread('codex', 'repo_one', 'checkout_one'),
      title: 'Codex task', updatedAt: '2026-11-06T08:00:00Z', messages: [{ id: 'c1', role: 'user' as const,
        content: 'Continue Codex task', createdAt: '2026-11-06T08:00:00Z' }] };
    const api = { ...createThread('api:deepseek', 'repo_two', 'checkout_two'),
      title: 'API task', updatedAt: '2026-11-06T08:01:00Z', messages: [{ id: 'a1', role: 'user' as const,
        content: 'Continue API task', createdAt: '2026-11-06T08:01:00Z' }] };
    const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    const projects = [
      { repoId: 'repo_one', name: 'One', repository: 'example/one', checkoutId: 'checkout_one' },
      { repoId: 'repo_two', name: 'Two', repository: 'example/two', checkoutId: 'checkout_two' },
    ];
    const renderHistory = (threads: typeof codex[], defaultProvider: 'codex' | 'api:openai') => {
      Object.defineProperty(globalThis, 'localStorage', {
        configurable: true, value: {
          getItem(key: string) {
            return key === 'forge.desktop.local-threads.v1' ? JSON.stringify(threads) : '{}';
          }, setItem() {},
        },
      });
      return renderToStaticMarkup(createElement(LocalConversationSurface, {
        projects, defaultProjectRepoId: 'repo_one', newThreadRequested: false,
        provider: { status: 'ready', label: 'Codex', detail: 'Connected', streaming: false, tools: true },
        providerLoading: false, providerError: null,
        apiSettings: {
          schemaVersion: 2, defaultProvider,
          profiles: [
            { id: 'deepseek', providerId: 'api:deepseek', label: 'DeepSeek', endpoint: 'https://api.deepseek.com/v1',
              model: 'deepseek-chat', apiProtocol: 'openai', credentialRef: 'credential-deepseek', hasKey: true, endpointReady: true },
            { id: 'openai', providerId: 'api:openai', label: 'OpenAI', endpoint: 'https://api.openai.com/v1',
              model: 'gpt-test', apiProtocol: 'responses', credentialRef: 'credential-openai', hasKey: true, endpointReady: true },
          ],
          joyCodeModel: 'joycode-test', joyCodeReady: false,
          provider: defaultProvider === 'codex' ? 'codex' : 'api', endpoint: 'https://api.openai.com/v1',
          model: 'gpt-test', apiProtocol: 'responses', credentialRef: 'credential-openai', hasKey: true, endpointReady: true,
        },
        onOpenSettings() {}, onOpenProjects() {}, onOpenKnowledge() {},
        onNewThreadHandled() {}, onOpenThreadHandled() {},
        onThreadsChange() {}, async onRefreshProvider() {},
        async onSend() { return { content: 'confirmed' }; },
      }));
    };
    try {
      const apiDefault = renderHistory([codex, api], 'api:openai');
      expect(apiDefault).toContain('Continue API task');
      expect(apiDefault).toContain('API · deepseek-chat');
      const codexDefault = renderHistory([api, codex], 'codex');
      expect(codexDefault).toContain('Continue API task');
      expect(codexDefault).toContain('API · deepseek-chat');
      expect(codexDefault).not.toContain('gpt-test');
      expect(codexDefault).not.toContain('发送时校验钥匙串');
      expect(codexDefault).toContain('Checkout 未核实，暂时禁止执行');
      expect(codexDefault).not.toContain('允许本轮编辑文件和执行命令');
      const legacyApi = { ...createThread('api', 'repo_two', 'checkout_two'), title: 'Legacy API task',
        updatedAt: '2026-11-06T08:02:00Z', messages: [{ id: 'legacy', role: 'user' as const,
          content: 'Continue legacy API task', createdAt: '2026-11-06T08:02:00Z' }] };
      const legacy = renderHistory([legacyApi], 'api:openai');
      expect(legacy).toContain('历史 API 会话未绑定固定 Provider');
      expect(legacy).not.toContain('API · gpt-test');
      const nav = localConversationNavItems([codex, api], {});
      expect(nav.map((item) => item.provider).sort()).toEqual(['api:deepseek', 'codex']);
      expect(nav.map((item) => item.title).sort()).toEqual(['API task', 'Codex task']);
    } finally {
      if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage);
      else delete (globalThis as { localStorage?: Storage }).localStorage;
    }
  });

  test('Codex setup and MCP connection are separate app settings, without duplicating authority', () => {
    const html = renderToStaticMarkup(createElement(SettingsView, {
      settings: { provider: 'codex', endpoint: 'https://api.openai.com/v1',
        model: '', apiProtocol: 'openai', hasKey: false },
      loading: false, error: null, mcpReady: true,
      codexStatus: { provider: 'codex', status: 'ready', label: 'Codex 已连接',
        detail: 'Logged in', streaming: false, tools: true },
      codexError: null, async onRefresh() {}, async onSave() {},
      async onClearKey() {}, async onRefreshCodex() {}, onOpenMcp() {},
    }));
    expect(html).toContain('Agent 与连接');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('Codex 已连接');
    expect(html).toContain('重新检查 Codex');
    expect(html).toContain('外部 MCP 服务');
    expect(html).toContain('查看连接');
    expect(html).toContain('Forge 控制器连接已就绪');
    expect(html).not.toContain('aria-label="API 协议"');
  });

  test('MCP connection status is first-class and runtime lifecycle is behind disclosure', () => {
    const html = renderToStaticMarkup(createElement(RuntimeView, {
      projection: null, loading: false, error: null, action: null,
      connection: null, connectionLoading: false, connectionError: null,
      connectionAction: null,
      async onRefresh() {}, async onDiagnose() {}, async onRestart() {},
      async onRecover() {}, async onRefreshConnection() {},
      async onRepairConnection() {}, onOpenSettings() {},
    }));
    expect(html).toContain('MCP 服务与连接');
    expect(html).toContain('MCP / 控制器连接');
    expect(html).toContain('高级维护操作');
    expect(html).toContain('<details class="runtime-advanced-actions">');
    expect(html).not.toContain('<details class="runtime-advanced-actions" open');
    expect(html).toContain('Agent 设置');
  });

  test('MCP status distinguishes a ready controller from a failing remote tunnel', () => {
    const html = renderToStaticMarkup(createElement(RuntimeView, {
      projection: null, loading: false, error: null, action: null,
      connection: {
        schemaVersion: 1, configured: true, ready: false,
        controller: {
          ready: true, title: 'Controller configured',
          detail: 'Controller endpoints match the setup profile.',
        },
        tunnel: {
          ready: false, provider: 'cloudflare', title: 'Remote tunnel unavailable',
          detail: 'Configure the remote tunnel to reach ChatGPT.',
        },
        repair: { available: false, action: 'repair_connector', label: 'Refresh Forge Connector' },
      },
      connectionLoading: false, connectionError: null, connectionAction: null,
      async onRefresh() {}, async onDiagnose() {}, async onRestart() {},
      async onRecover() {}, async onRefreshConnection() {},
      async onRepairConnection() {}, onOpenSettings() {},
    }));
    expect(html).toContain('远程传输需要处理');
    expect(html).toContain('Configure the remote tunnel to reach ChatGPT.');
    expect(html).not.toContain('控制器配置需要处理');
  });

  test('sidebar uses Cmd+B without hijacking text input modifiers', () => {
    const press = (values: Partial<KeyboardEvent> = {}) => ({
      key: 'b', metaKey: false, ctrlKey: false, shiftKey: false, altKey: false,
      ...values,
    }) as Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'>;
    expect(sidebarToggleShortcut(press({ metaKey: true }))).toBe(true);
    expect(sidebarToggleShortcut(press({ ctrlKey: true, key: 'B' }))).toBe(false);
    expect(sidebarToggleShortcut(press({ ctrlKey: true, metaKey: true }))).toBe(false);
    expect(sidebarToggleShortcut(press({ shiftKey: true, metaKey: true }))).toBe(false);
    expect(sidebarToggleShortcut(press({ altKey: true, metaKey: true }))).toBe(false);
    expect(sidebarToggleShortcut(press({ key: 'n', metaKey: true }))).toBe(false);
    expect(sidebarToggleShortcut(press())).toBe(false);
    expect(renderToStaticMarkup(createElement(ForgeIcon, { name: 'sidebar-show' })))
      .not.toEqual(renderToStaticMarkup(createElement(ForgeIcon, { name: 'sidebar-hide' })));
  });

  test('fenced code shows language and one copy action without a permanent message toolbar', () => {
    const fenced = ['Before', '', '```typescript', 'const ready = true;', '```', '', 'After'].join('\n');
    const html = renderToStaticMarkup(createElement(LocalMessageBody, { content: fenced }));
    expect(html).toContain('class="local-code-block"');
    expect(html).toContain('aria-label="复制代码"');
    expect(html).toContain('<span>typescript</span>');
    expect(html).toContain('<pre><code class="language-typescript">const ready = true;');
    expect((html.match(/aria-label="复制代码"/g) ?? [])).toHaveLength(1);
    expect(html).not.toContain('local-message-actions');
    const inline = renderToStaticMarkup(createElement(LocalMessageBody, { content: 'Use `npm test`.' }));
    expect(inline).toContain('<code>npm test</code>');
    expect(inline).not.toContain('aria-label="复制代码"');
  });

  test('sidebar, project and Agent actions share purposeful Lucide SVG glyphs', () => {
    for (const name of [
      'new-thread', 'conversations', 'requirement', 'plan', 'knowledge',
      'project', 'conversation', 'draft', 'settings', 'runtime',
      'plus', 'diff', 'more', 'folder', 'branch', 'shield', 'arrow', 'stop',
    ] as const) {
      const markup = renderToStaticMarkup(createElement(ForgeIcon, { name }));
      expect(markup).toContain('class="lucide');
      expect(markup).toContain('aria-hidden="true"');
      expect(markup).toContain('stroke-width="1.75"');
      expect(markup).not.toContain('<text');
    }
    expect(renderToStaticMarkup(createElement(ForgeIcon, { name: 'requirement' })))
      .not.toEqual(renderToStaticMarkup(createElement(ForgeIcon, { name: 'knowledge' })));
  });

  test('native app icon has real source-size PNGs and Finder/Dock icon family', () => {
    const dir = new URL('../src-tauri/icons/', import.meta.url);
    for (const [file, width] of [
      ['icon.png', 1024], ['32x32.png', 32], ['128x128.png', 128], ['128x128@2x.png', 256],
    ] as const) {
      const png = readFileSync(new URL(file, dir));
      expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      expect(png.readUInt32BE(16)).toBe(width);
      expect(png.readUInt32BE(20)).toBe(width);
    }
    expect(readFileSync(new URL('icon.icns', dir)).toString('ascii', 0, 4)).toBe('icns');
  });

  test('unsent drafts remain discoverable without mutating transcript history', () => {
    const empty = createThread('codex', 'repo_forge', 'checkout_forge');
    const draft = { ...createThread('codex', 'repo_forge', 'checkout_forge'),
      updatedAt: '2026-11-06T08:10:00Z' };
    const sent = { ...createThread('codex', 'repo_forge', 'checkout_forge'),
      title: 'Existing result', updatedAt: '2026-11-06T08:00:00Z',
      messages: [{ id: 'message', role: 'user' as const, content: 'Existing result',
        createdAt: '2026-11-06T08:00:00Z' }] };
    const archived = { ...createThread('codex', 'repo_forge'), archived: true };
    const texts = { [empty.id]: '   ', [draft.id]: 'Unsent prompt remains editable',
      [archived.id]: 'Should never appear' };
    const items = localConversationNavItems([empty, sent, draft, archived], texts);
    expect(items.map((item) => item.id)).toEqual([draft.id, sent.id]);
    expect(items[0]).toMatchObject({
      id: draft.id, title: 'Unsent prompt remains editable', provider: 'codex', draft: true,
    });
    expect(items[1]).toMatchObject({ id: sent.id, title: 'Existing result', provider: 'codex' });
    expect(items[1]?.draft).toBeUndefined();
    expect(draft.messages).toEqual([]);
  });

  test('reopening the client restores an unsent conversation draft from its own storage key', () => {
    const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    const thread = createThread('codex', 'repo_forge', 'checkout_forge');
    const unfinished = 'Can we continue from the earlier note?';
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem(key: string) {
          if (key === 'forge.desktop.local-threads.v1') return JSON.stringify([thread]);
          if (key === 'forge.desktop.local-drafts.v1') {
            return JSON.stringify({ [thread.id]: unfinished });
          }
          return null;
        },
        setItem() {},
      },
    });
    try {
      const html = renderToStaticMarkup(createElement(LocalConversationSurface, {
        projects: [{ repoId: 'repo_forge', name: 'Forge',
          repository: 'moretea-labs/forge', checkoutId: 'checkout_forge' }],
        defaultProjectRepoId: 'repo_forge',
        provider: { status: 'ready', label: 'Codex', detail: 'Ready', streaming: false, tools: true },
        providerLoading: false, providerError: null, apiSettings: null,
        onOpenSettings() {}, onOpenProjects() {}, onOpenKnowledge() {},
        newThreadRequested: false, onNewThreadHandled() {}, onOpenThreadHandled() {},
        onThreadsChange() {}, async onRefreshProvider() {}, async onSend() { return { content: 'ok' }; },
      }));
      expect(html).toContain('<textarea');
      expect(html).toContain(unfinished);
      expect(html).not.toContain('class="local-message user"');
    } finally {
      if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage);
      else delete (globalThis as { localStorage?: Storage }).localStorage;
    }
  });

  test('transcript only follows new output while reading the bottom', () => {
    expect(transcriptIsNearBottom(1000, 800, 200)).toBe(true);
    expect(transcriptIsNearBottom(1000, 705, 200)).toBe(true);
    expect(transcriptIsNearBottom(1000, 700, 200)).toBe(false);
    expect(transcriptIsNearBottom(1000, 300, 200)).toBe(false);
    expect(transcriptIsNearBottom(200, 0, 400)).toBe(true);
  });

  test('IME confirmation, newline modifiers and busy Agent turns cannot submit from Enter', () => {
    const press = (values: Partial<KeyboardEvent> = {}) => ({
      key: 'Enter', shiftKey: false, altKey: false, isComposing: false,
      keyCode: 13, ...values,
    }) as Pick<KeyboardEvent, 'key' | 'shiftKey' | 'altKey' | 'isComposing' | 'keyCode'>;
    expect(shouldSubmitComposerKey(press(), false)).toBe(true);
    expect(shouldSubmitComposerKey(press(), true)).toBe(false);
    expect(shouldSubmitComposerKey(press({ shiftKey: true }), false)).toBe(false);
    expect(shouldSubmitComposerKey(press({ altKey: true }), false)).toBe(false);
    expect(shouldSubmitComposerKey(press({ isComposing: true }), false)).toBe(false);
    expect(shouldSubmitComposerKey(press({ keyCode: 229 }), false)).toBe(false);
    expect(shouldSubmitComposerKey(press({ key: 'a' }), false)).toBe(false);
  });

  test('Agent transcript is free of permanent lifecycle and model toolbars', () => {
    const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    const thread = createThread('api', 'repo_forge', 'checkout_main');
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: { getItem: () => JSON.stringify([thread]), setItem() {} },
    });
    try {
      const html = renderToStaticMarkup(createElement(LocalConversationSurface, {
        projects: [{ repoId: 'repo_forge', name: 'Forge', repository: 'moretea-labs/forge', checkoutId: 'checkout_main' }],
        defaultProjectRepoId: 'repo_forge',
        provider: { status: 'ready', label: 'Codex', detail: 'ready', streaming: false, tools: true },
        providerLoading: false, providerError: null,
        apiSettings: { provider: 'api', endpoint: 'http://127.0.0.1:1234', model: 'test-model', apiProtocol: 'openai', hasKey: true },
        onOpenSettings() {}, onOpenProjects() {}, onOpenKnowledge() {},
        newThreadRequested: false, onNewThreadHandled() {}, onOpenThreadHandled() {}, onThreadsChange() {},
        async onRefreshProvider() {}, async onSend() { return { content: 'ok' }; },
      }));
      expect(html).toContain('class="local-toolbar agent-chat-header"');
      expect(html).toContain('aria-label="查看 Git 变更"');
      expect(html).toContain('aria-label="新建会话"');
      expect(html).toContain('aria-label="更多会话操作"');
      expect((html.match(/name="agent-chat-controls"/g) ?? [])).toHaveLength(3);
      expect(html).toContain('class="local-composer agent-chat-composer"');
      expect(html).toContain('aria-label="Agent 项目上下文"');
      expect(html).toContain('aria-label="Agent 执行的 Git Checkout"');
      expect(html).not.toContain('aria-label="会话关联的 Forge Work"');
      expect(html).toContain('Checkout 未核实，暂时禁止执行');
      expect(html).not.toContain('aria-label="允许本轮编辑文件和执行命令"');
      expect(html).toContain('aria-label="发送消息"');
      expect((html.match(/class="local-send-button"/g) ?? [])).toHaveLength(1);
      expect(html).not.toContain('aria-label="请求停止当前 Agent 回复"');
      expect(html).not.toContain('class="local-context-row"');
      expect(html).not.toContain('class="local-work-context"');
      expect(html).not.toContain('class="local-provider ');
      expect(html.indexOf('class="local-transcript"')).toBeLessThan(html.indexOf('class="local-composer agent-chat-composer"'));
    } finally {
      if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage);
      else delete (globalThis as { localStorage?: Storage }).localStorage;
    }
  });

  test('direct Git commit requires approval and explicit paths before loading Forge source', async () => {
    const script = new URL('../src-tauri/resources/forge-local-tool.mjs', import.meta.url).pathname;
    async function runGitCommit(allowEffects: boolean, paths: string[]) {
      const runner = Bun.spawn([process.execPath, script], { stdin: 'pipe', stdout: 'pipe' });
      runner.stdin.write(JSON.stringify({
        tool: 'git_commit', repoId: 'repo_forge', checkoutId: 'checkout_forge',
        conversationId: 'conv_1', controllerHome: '/does-not-exist', sourceRoot: '/does-not-exist',
        allowEffects, arguments: { message: 'fix: test', paths, request_id: 'effect_1' },
      }));
      runner.stdin.end();
      const output = await new Response(runner.stdout).text();
      expect(await runner.exited).toBe(0);
      return JSON.parse(output);
    }
    expect(await runGitCommit(false, ['src/file.ts'])).toEqual({
      ok: false, error: 'LOCAL_FORGE_TOOL_REQUIRES_USER_APPROVAL',
    });
    expect(await runGitCommit(true, [])).toEqual({
      ok: false, error: 'LOCAL_FORGE_GIT_COMMIT_ARGUMENTS_INVALID',
    });
    expect(await runGitCommit(true, ['../outside'])).toEqual({
      ok: false, error: 'LOCAL_FORGE_GIT_COMMIT_ARGUMENTS_INVALID',
    });
  });

  test('direct Process controls are principal-bound and cancellation is effect- and checkout-gated', async () => {
    const script = new URL('../src-tauri/resources/forge-local-tool.mjs', import.meta.url).pathname;
    const sourceRoot = new URL('../../../', import.meta.url).pathname;
    const controllerHome = mkdtempSync(join(tmpdir(), 'desktop-agent-process-control-'));
    try {
      const processId = 'proc_foreign_owner_1';
      const principalId = 'forge-desktop-local-harness';
      recordProcessHandleIndexEntry(controllerHome, {
        processId,
        lane: 'managed',
        target: repositoryExecutionTarget(controllerHome, 'repo_forge', 'checkout_forge'),
        principalId,
      });
      createProcessRecord({
        schemaVersion: 1,
        processId,
        repoId: 'repo_forge',
        checkoutId: 'checkout_forge',
        principalId,
        controllerHome,
        status: 'succeeded',
        route: 'managed',
        command: { kind: 'argv', executable: process.execPath, args: ['--version'], cwd: sourceRoot },
        resourceClaims: [],
        interactiveWaitMs: 0,
        timeoutMs: 10_000,
        maxOutputBytes: 4096,
        startedAt: '2026-11-10T00:00:00.000Z',
        updatedAt: '2026-11-10T00:00:01.000Z',
        finishedAt: '2026-11-10T00:00:01.000Z',
        exitCode: 0,
        terminalFenceToken: 'fence-test',
        terminalWritten: true,
      });
      async function run(tool: string, allowEffects: boolean, conversationId = 'conv_1', checkoutId?: string) {
        const runner = Bun.spawn([process.execPath, script], { stdin: 'pipe', stdout: 'pipe' });
        runner.stdin.write(JSON.stringify({
          tool, repoId: 'repo_forge', checkoutId, conversationId,
          controllerHome, sourceRoot, allowEffects,
          arguments: { process_id: 'proc_foreign_owner_1' },
        }));
        runner.stdin.end();
        const output = await new Response(runner.stdout).text();
        expect(await runner.exited).toBe(0);
        return JSON.parse(output);
      }

      expect(await run('process_cancel', false, 'conv_1', 'checkout_forge')).toEqual({
        ok: false, error: 'LOCAL_FORGE_TOOL_REQUIRES_USER_APPROVAL',
      });
      expect(await run('process_cancel', true)).toEqual({
        ok: false, error: 'LOCAL_FORGE_EFFECT_CHECKOUT_REQUIRED',
      });
      const foreignPrincipal = await callProcessTool({
        controllerHome, repo: sourceRoot, principalId: 'outer-chatgpt-principal', sessionId: 'outer-chatgpt-session',
      }, 'process_cancel', { repo_id: 'repo_forge', process_id: processId });
      expect(foreignPrincipal?.isError).toBe(true);
      expect(foreignPrincipal?.content?.map((part) => part.type === 'text' ? part.text : '').join(' '))
        .toContain('PROCESS_HANDLE_PRINCIPAL_MISMATCH');
      expect(await run('process_cancel', true, 'conv_1', 'checkout_other')).toEqual({
        ok: false, error: 'LOCAL_FORGE_PROCESS_CHECKOUT_MISMATCH',
      });
      expect(await run('process_status', false, 'conv_1', 'checkout_forge')).toMatchObject({
        ok: true, result: { processId, status: 'succeeded', completed: true, exitCode: 0 },
      });
      expect(await run('process_cancel', true, 'conv_1', 'checkout_forge')).toMatchObject({
        ok: true, result: { processId, status: 'succeeded', completed: true, cancelled: false },
      });
    } finally {
      rmSync(controllerHome, { recursive: true, force: true });
    }
  });

  test('direct Forge runner denies mutations without a pinned checkout before touching source', async () => {
    const script = new URL('../src-tauri/resources/forge-local-tool.mjs', import.meta.url).pathname;
    const runner = Bun.spawn([process.execPath, script], { stdin: 'pipe', stdout: 'pipe' });
    runner.stdin.write(JSON.stringify({
      tool: 'run_command', repoId: 'repo_forge', conversationId: 'conv_1',
      controllerHome: '/does-not-exist', sourceRoot: '/does-not-exist',
      allowEffects: true, arguments: { command: ['git', 'status'] },
    }));
    runner.stdin.end();
    const output = await new Response(runner.stdout).text();
    expect(await runner.exited).toBe(0);
    expect(JSON.parse(output)).toEqual({
      ok: false, error: 'LOCAL_FORGE_EFFECT_CHECKOUT_REQUIRED',
    });
  });


  test('local Agent Harness reuses one direct tool session for multiple tool calls', async () => {
    const script = new URL('../src-tauri/resources/forge-local-tool.mjs', import.meta.url).pathname;
    const runner = Bun.spawn([process.execPath, script, '--session'], { stdin: 'pipe', stdout: 'pipe' });
    const requests = [
      {
        tool: 'git_commit', repoId: 'repo_forge', checkoutId: 'checkout_forge',
        conversationId: 'conv_session', controllerHome: '/does-not-exist', sourceRoot: '/does-not-exist',
        allowEffects: false, arguments: { message: 'fix: test', paths: ['src/file.ts'] },
      },
      {
        tool: 'run_command', repoId: 'repo_forge', conversationId: 'conv_session',
        controllerHome: '/does-not-exist', sourceRoot: '/does-not-exist',
        allowEffects: true, arguments: { command: ['git', 'status'] },
      },
    ];
    runner.stdin.write(requests.map((request) => JSON.stringify(request)).join('\n') + '\n');
    runner.stdin.end();
    const output = await new Response(runner.stdout).text();
    expect(await runner.exited).toBe(0);
    const responses = output.trim().split('\n').map((line) => JSON.parse(line));
    expect(responses).toEqual([
      { ok: false, error: 'LOCAL_FORGE_TOOL_REQUIRES_USER_APPROVAL' },
      { ok: false, error: 'LOCAL_FORGE_EFFECT_CHECKOUT_REQUIRED' },
    ]);
  });

  test('failed project read reports the selected project failure rather than showing stale semantic records', () => {
    const html = renderToStaticMarkup(createElement(ProjectRecordsView, {
      mode: 'requirements',
      projection: {
        ...disconnectedProjection,
        source: 'runtime',
        runtime: { status: 'degraded', label: '项目详情读取失败', detail: 'yaozhunshi：Forge 返回了错误' },
      },
      onNavigateRecord() {},
      async onRefresh() {},
    }));
    expect(html).toContain('yaozhunshi：Forge 返回了错误');
    expect(html).not.toContain('从左侧选择已注册项目');
    expect(html).not.toContain('相同 Requirement 下的其他 Work');
  });

  test('disambiguates misleading registry display names using actual repository identity', () => {
    const design = {
      repoId: 'repo_design', displayName: 'Avela',
      localRoot: '/Users/greyson/DevProjects/repo-harness-design',
    };
    expect(repositoryLabel(design)).toBe('repo-harness-design');
    expect(repositoryLabel({
      repoId: 'repo_avela', displayName: 'Avela Yi Fu Yao',
      localRoot: '/Users/greyson/DevProjects/yaozhunshi',
    })).toBe('yaozhunshi');
    expect(repositoryLabel({
      repoId: 'repo_forge', displayName: 'Forge',
      remoteUrl: 'https://github.com/moretea-labs/forge.git',
    })).toBe('moretea-labs/forge');
    expect(repositoryLabel({ repoId: 'repo_unlocated', displayName: 'Legacy' })).toBe('Legacy');
  });

  test('new threads store only repository and checkout foreign keys, no semantic duplicates', () => {
    const thread = createThread('api', 'repo_a', 'checkout_a');
    expect(thread.projectRepoId).toBe('repo_a');
    expect(thread.checkoutId).toBe('checkout_a');
    expect(thread.messages).toEqual([]);
    expect(thread.provider).toBe('api');
    expect('requirement' in thread).toBe(false);
    expect('plan' in thread).toBe(false);
  });

  test('switching Avela to Forge creates a new Agent identity without rewriting history or resume ID', () => {
    const avela = {
      ...createThread('codex', 'repo_avela'),
      providerSessionId: 'codex-session-avela',
      messages: [{ id: 'msg1', role: 'user' as const, content: 'build Avela', createdAt: '2026-11-05T00:00:00Z' }],
    };
    const switched = selectThreadRepository(avela, 'codex', 'repo_forge');
    expect(switched.created).toBe(true);
    expect(switched.thread.projectRepoId).toBe('repo_forge');
    expect(switched.thread.messages).toEqual([]);
    expect(switched.thread.providerSessionId).toBeUndefined();
    expect(switched.thread.id).not.toBe(avela.id);
    expect(avela.projectRepoId).toBe('repo_avela');
    expect(avela.providerSessionId).toBe('codex-session-avela');
    expect(avela.messages[0]?.content).toBe('build Avela');
    const bounded = selectThreadRepository(avela, 'codex', 'repo_forge', 'checkout_forge');
    expect(bounded.thread.checkoutId).toBe('checkout_forge');
    expect(avela.checkoutId).toBeUndefined();
  });

  test('checkout switching preserves historical transcript and provider session in its original identity', () => {
    const original = {
      ...createThread('api', 'repo_forge', 'checkout_main'),
      providerSessionId: 'provider-session-1',
      messages: [{ id: 'msg-1', role: 'user' as const, content: 'run tests', createdAt: '2026-11-05T00:00:00Z' }],
    };
    const switchResult = selectThreadCheckout(original, 'api', 'checkout_worktree');
    expect(switchResult.created).toBe(true);
    expect(switchResult.thread.checkoutId).toBe('checkout_worktree');
    expect(switchResult.thread.projectRepoId).toBe('repo_forge');
    expect(switchResult.thread.messages).toHaveLength(0);
    expect(switchResult.thread.providerSessionId).toBeUndefined();
    expect(switchResult.thread.id).not.toBe(original.id);
    expect(original.checkoutId).toBe('checkout_main');
    expect(original.providerSessionId).toBe('provider-session-1');
    expect(original.messages[0]?.content).toBe('run tests');
  });

  test('checkout switching replaces only the checkout on an empty draft', () => {
    const draft = createThread('api', 'repo_forge', 'checkout_main');
    const switched = selectThreadCheckout(draft, 'api', 'checkout_worktree');
    expect(switched.created).toBe(false);
    expect(switched.thread.id).toBe(draft.id);
    expect(switched.thread.checkoutId).toBe('checkout_worktree');
    expect(draft.checkoutId).toBe('checkout_main');
    expect(selectThreadCheckout(switched.thread, 'api', 'checkout_worktree').thread).toBe(switched.thread);
  });

  test('switching an unsent draft reuses it without carrying stale repository context', () => {
    const empty = createThread('api', 'repo_avela');
    const switched = selectThreadRepository(empty, 'api', 'repo_forge');
    expect(switched.created).toBe(false);
    expect(switched.thread.id).toBe(empty.id);
    expect(switched.thread.projectRepoId).toBe('repo_forge');
    expect(empty.projectRepoId).toBe('repo_avela');
    expect(selectThreadRepository(switched.thread, 'api', 'repo_forge').thread).toBe(switched.thread);
    const ghostResume = { ...empty, providerSessionId: 'old-resume' };
    expect(selectThreadRepository(ghostResume, 'api', 'repo_forge').created).toBe(true);
    const pinned = selectThreadRepository(empty, 'api', 'repo_forge', 'checkout_forge');
    expect(pinned.thread.checkoutId).toBe('checkout_forge');
    expect(empty.checkoutId).toBeUndefined();
  });

  test('keeps one truthful tool row per start and terminal receipt, with a bounded timeline', () => {
    const start = { conversationId: 'thread1', name: 'run_command', phase: 'started' as const, requestId: 'effect-123' };
    const finish = { ...start, phase: 'completed' as const };
    const running = advanceLocalToolProgress([], start);
    expect(running).toHaveLength(1);
    expect(running[0]?.phase).toBe('started');
    const completed = advanceLocalToolProgress(running, finish);
    expect(completed).toHaveLength(1);
    expect(completed[0]).toEqual(finish);
    // Another operation's completion is never attributed to this one.
    const different = { ...finish, requestId: 'effect-456' };
    expect(advanceLocalToolProgress(running, different)).toHaveLength(2);
    const recent = Array.from({ length: 15 }, (_, index) => ({
      conversationId: 'thread1', name: 'read_file', phase: 'started' as const,
      requestId: 'r' + index,
    })).reduce(advanceLocalToolProgress, [] as ReturnType<typeof advanceLocalToolProgress>);
    expect(recent).toHaveLength(12);
    expect(recent[0]?.requestId).toBe('r3');
  });


});


describe('Native macOS app launch surface', () => {
  test('does not overlay WKWebView with an unreparented full-window Liquid Glass view', () => {
    const config = JSON.parse(readFileSync(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8'));
    const window = config.app.windows.find((entry: { label: string }) => entry.label === 'main');
    expect(window).toBeDefined();
    expect(window.transparent).toBe(false);
    expect(window.titleBarStyle).toBe('Visible');
    // CSS owns the sidebar material. A native NSGlassEffectView needs the
    // actual WKWebView as contentView; configuring a separate full-window
    // overlay made the native Forge window render solid gray on macOS.
    expect(window.windowEffects).toBeUndefined();

  });
});


describe('Packaged macOS web resources', () => {
  test('uses relative Vite assets for Tauri custom-protocol WebViews', () => {
    const viteConfig = readFileSync(new URL('../vite.config.ts', import.meta.url), 'utf8');
    expect(viteConfig).toContain("base: './'");
    const entry = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
    expect(entry).not.toContain('forge-native-paint-probe');
  });
});


describe('macOS WebKit first-frame rendering regression', () => {
  test('boots the existing React UI before activating its full stylesheet', () => {
    const entry = readFileSync(new URL('../src/main.tsx', import.meta.url), 'utf8');
    expect(entry).not.toContain("import './styles.css';");
    expect(entry).toContain("import('./styles.css')");
    expect(entry).toContain('requestAnimationFrame(() => requestAnimationFrame(');
    expect(entry).toContain('FORGE_DESKTOP_STYLESHEET_LOAD_FAILED');
  });
});


describe('Forge project picker native interactions', () => {
  test('delegates the single project popup focus and collision handling to Radix', () => {
    const source = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
    expect(source).toContain("from '@radix-ui/react-popover'");
    expect(source).toContain('<Popover.Trigger asChild>');
    expect(source).toContain('<Popover.Content');
    expect(source).toContain('collisionPadding={12}');
    expect(source).not.toContain('projectPickerRef');
    expect(source).not.toContain("document.addEventListener('pointerdown', onPointerDown, true)");
  });
});


describe('Tauri shell boundary', () => {
  test('does not opt into obsolete macOS private UI switches for ordinary window chrome', () => {
    const config = JSON.parse(readFileSync(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8'));
    const cargo = readFileSync(new URL('../src-tauri/Cargo.toml', import.meta.url), 'utf8');
    expect(config.app.macOSPrivateApi).toBeUndefined();
    expect(cargo).not.toContain('features = ["macos-private-api"]');
    expect(config.app.windows[0].titleBarStyle).toBe('Visible');
  });
});

describe('approved A workspace + C rail design contract', () => {
  test('shares one Forge Design palette between app shell and project popup', () => {
    const tokens = JSON.parse(readFileSync(new URL('../../../.design-harness/tokens.json', import.meta.url), 'utf8'));
    const project = JSON.parse(readFileSync(new URL('../../../.design-harness/project.json', import.meta.url), 'utf8'));
    const variables = readFileSync(new URL('../src/design-tokens.ts', import.meta.url), 'utf8');
    const styles = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
    const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
    expect(project.designSystem.version).toBe(tokens.meta.version);
    expect(tokens.color.sidebarGlass).toBe('rgba(240,241,243,.70)');
    expect(tokens.color.canvas).toBe('#FFFFFF');
    expect(tokens.color.composerGlass).toBe('rgba(248,249,251,.85)');
    expect(variables).toContain("'--glass': designTokens.color.sidebarGlass");
    expect(variables).toContain("'--popover': designTokens.color.popoverGlass");
    expect(variables).toContain("'--canvas': designTokens.color.canvas");
    expect(variables).toContain("'--canvas-raised': designTokens.color.canvasRaised");
    expect(variables).toContain("'--border-strong': designTokens.color.borderStrong");
    expect(variables).toContain("'--composer-bg': designTokens.color.composerGlass");
    expect(styles).toContain('background: var(--glass)');
    expect(styles).toContain('background: var(--canvas)');
    expect(app).toContain('className="sidebar-project-picker-panel" style={desktopThemeStyle}');
  });
});


describe('Project semantic browser boundary', () => {
  test('Requirement navigation is Plan-derived and never projects historical Work as progress', () => {
    const html = renderToStaticMarkup(createElement(ProjectRecordsView, {
      mode: 'requirements', projection: designPreviewProjection,
      onNavigateRecord() {}, async onRefresh() {},
    }));
    expect(html).toContain('Requirements');
    expect(html).toContain('Requirement 由本项目 Plan 的 canonical requirementId 发现');
    expect(html).toContain('不会从历史 Work 推断');
    expect(html).not.toContain('打开完整 Work 详情');
    expect(html).not.toContain('Work 状态');
  });
});


describe('Forge native first-frame boot surface', () => {
  test('has visible static content before React then removes it only after existing CSS loads', () => {
    const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
    const entry = readFileSync(new URL('../src/main.tsx', import.meta.url), 'utf8');
    expect(html).toContain('id="forge-first-paint" role="status"');
    expect(html).toContain('Forge 正在启动…');
    expect(entry).toContain("import('./styles.css').then(");
    expect(entry).toContain("getElementById('forge-first-paint')?.remove()");
    expect(entry).toContain('Forge 界面样式加载失败');
    expect(html).not.toContain('setTimeout');
  });
});


describe('Mac Agent navigation and local transcript deletion', () => {
  test('desktop semantic navigation has Requirement and Plan destinations without a Work destination', () => {
    const source = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
    expect(source).toContain('onOpenRequirements');
    expect(source).toContain('onOpenPlans');
    expect(source).not.toContain("activeView === 'works'");
    expect(source).not.toContain('onOpenWork');
  });

  test('deleting a local conversation removes its record and draft instead of retaining a hidden archive', () => {
    const source = readFileSync(new URL('../src/local-conversation.tsx', import.meta.url), 'utf8');
    expect(source).toContain('删除当前会话');
    expect(source).not.toContain('归档当前会话');
    expect(source).toContain('current.filter((thread) => thread.id !== deletedId)');
    expect(source).toContain('delete next[deletedId]');
  });
});


describe('Requirement and Plan master-detail behavior', () => {
  test('keeps semantic detail navigation Work-free and links Plan back to its Requirement', () => {
    const source = readFileSync(new URL('../src/project-records-view.tsx', import.meta.url), 'utf8');
    expect(source).toContain("export type RecordMode = 'requirements' | 'plans'");
    expect(source).toContain("onNavigateRecord('requirements', detail.value.requirementId!)");
    expect(source).toContain("onNavigateRecord('plans', plan.planId)");
    expect(source).not.toContain("mode === 'works'");
    expect(source).not.toContain('onSelectWork');
    expect(source).not.toContain('read_work_detail');
  });
});
