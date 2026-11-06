import { describe, expect, test } from 'bun:test';
import { advanceLocalToolProgress, createThread, findExistingWorkThread, localConversationNavItems, LocalConversationSurface, LocalMessageBody, selectThreadCheckout, selectThreadRepository, shouldSubmitComposerKey, transcriptIsNearBottom } from '../src/local-conversation';
import { ForgeIcon } from '../src/ui-icons';
import { RuntimeView, Sidebar, codexBoundPrompt, sidebarToggleShortcut } from '../src/App';
import { SettingsView } from '../src/settings-view';
import { readFileSync } from 'node:fs';
import { repositoryLabel } from '../src/runtime-client';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ProjectRecordsView } from '../src/project-records-view';
import { disconnectedProjection } from '../src/runtime-projection';

describe('Forge Desktop Work-bound Agent thread identity', () => {
  test('Codex gets exact selected project, checkout and linked Work without claiming checkout authority', () => {
    const thread = createThread('codex', 'repo_forge', 'work_record', 'checkout_forge');
    const prompt = codexBoundPrompt(thread, 'Please implement the plan.');
    expect(prompt).toContain('selected repo_id=repo_forge');
    expect(prompt).toContain('selected checkout_id=checkout_forge');
    expect(prompt).toContain('Attached existing Forge Work: work_record');
    expect(prompt).toContain('verify that the exact repo_id AND checkout_id');
    expect(prompt).toContain('If a tool cannot target the selected checkout, do not mutate');
    expect(prompt).toContain('Please implement the plan.');
    const unbound = createThread('codex');
    expect(codexBoundPrompt(unbound, 'Hello')).toBe('Hello');
  });

  test('independent repository conversations retain their own running status and sidebar groups', () => {
    const first = { ...createThread('codex', 'repo_one', 'work_one', 'checkout_one'),
      title: 'Implement feature A', messages: [{
        id: 'one', role: 'user' as const, content: 'Implement feature A',
        createdAt: '2026-11-06T08:00:00Z',
      }] };
    const second = { ...createThread('codex', 'repo_two', 'work_two', 'checkout_two'),
      title: 'Review feature B', messages: [{
        id: 'two', role: 'user' as const, content: 'Review feature B',
        createdAt: '2026-11-06T08:02:00Z',
      }] };
    const nav = localConversationNavItems([first, second], {}, new Set([first.id]));
    expect(nav).toHaveLength(2);
    expect(nav.find((item) => item.id === first.id)).toMatchObject({
      projectRepoId: 'repo_one', workId: 'work_one', running: true,
    });
    expect(nav.find((item) => item.id === second.id)).toMatchObject({
      projectRepoId: 'repo_two', workId: 'work_two',
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
      'new-thread', 'conversations', 'work', 'requirement', 'plan', 'knowledge',
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
    const empty = createThread('codex', 'repo_forge', undefined, 'checkout_forge');
    const draft = { ...createThread('codex', 'repo_forge', undefined, 'checkout_forge'),
      updatedAt: '2026-11-06T08:10:00Z' };
    const sent = { ...createThread('codex', 'repo_forge', undefined, 'checkout_forge'),
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
    const thread = createThread('codex', 'repo_forge', undefined, 'checkout_forge');
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

  test('Agent transcript is free of permanent project, Work and model toolbars', () => {
    const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    const thread = createThread('api', 'repo_forge', 'work_1', 'checkout_main');
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
        onOpenSettings() {}, onOpenProjects() {}, onOpenKnowledge() {}, onOpenWork() {}, onOpenRecord() {},
        newThreadRequested: false, onNewThreadHandled() {}, onOpenThreadHandled() {}, onThreadsChange() {},
        async onRefreshProvider() {}, async onSend() { return { content: 'ok' }; },
      }));
      expect(html).toContain('class="local-toolbar agent-chat-header"');
      expect(html).toContain('aria-label="查看 Git 变更"');
      expect(html).toContain('aria-label="新建会话"');
      expect(html).toContain('aria-label="更多会话操作"');
      expect((html.match(/name="agent-chat-controls"/g) ?? [])).toHaveLength(4);
      expect(html).toContain('class="local-composer agent-chat-composer"');
      expect(html).toContain('aria-label="Agent 项目上下文"');
      expect(html).toContain('aria-label="Agent 执行的 Git Checkout"');
      expect(html).toContain('aria-label="会话关联的 Forge Work"');
      expect(html).toContain('aria-label="允许本轮编辑文件和执行命令"');
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

  test('failed project read reports the selected project failure rather than showing stale records', () => {
    const html = renderToStaticMarkup(createElement(ProjectRecordsView, {
      mode: 'works',
      projection: {
        ...disconnectedProjection,
        source: 'runtime',
        runtime: { status: 'degraded', label: '项目详情读取失败', detail: 'yaozhunshi：Forge 返回了错误' },
      },
      onSelectWork() {},
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

  test('new threads store only repository/Work/Checkout foreign keys, no semantic duplicates', () => {
    const thread = createThread('api', 'repo_a', 'work_existing_1', 'checkout_a');
    expect(thread.projectRepoId).toBe('repo_a');
    expect(thread.workId).toBe('work_existing_1');
    expect(thread.checkoutId).toBe('checkout_a');
    expect(thread.messages).toEqual([]);
    expect(thread.provider).toBe('api');
    expect('requirement' in thread).toBe(false);
    expect('plan' in thread).toBe(false);
    expect(createThread('api', undefined, 'work_orphan').workId).toBeUndefined();
  });

  test('switching Avela to Forge creates a new Agent identity without rewriting history or resume ID', () => {
    const avela = {
      ...createThread('codex', 'repo_avela', 'work_avela'),
      providerSessionId: 'codex-session-avela',
      messages: [{ id: 'msg1', role: 'user' as const, content: 'build Avela', createdAt: '2026-11-05T00:00:00Z' }],
    };
    const switched = selectThreadRepository(avela, 'codex', 'repo_forge');
    expect(switched.created).toBe(true);
    expect(switched.thread.projectRepoId).toBe('repo_forge');
    expect(switched.thread.messages).toEqual([]);
    expect(switched.thread.workId).toBeUndefined();
    expect(switched.thread.providerSessionId).toBeUndefined();
    expect(switched.thread.id).not.toBe(avela.id);
    expect(avela.projectRepoId).toBe('repo_avela');
    expect(avela.workId).toBe('work_avela');
    expect(avela.providerSessionId).toBe('codex-session-avela');
    expect(avela.messages[0]?.content).toBe('build Avela');
    const bounded = selectThreadRepository(avela, 'codex', 'repo_forge', 'checkout_forge');
    expect(bounded.thread.checkoutId).toBe('checkout_forge');
    expect(avela.checkoutId).toBeUndefined();
  });

  test('checkout switching preserves historical transcript and provider session in its original identity', () => {
    const original = {
      ...createThread('api', 'repo_forge', 'work_a', 'checkout_main'),
      providerSessionId: 'provider-session-1',
      messages: [{ id: 'msg-1', role: 'user' as const, content: 'run tests', createdAt: '2026-11-05T00:00:00Z' }],
    };
    const switchResult = selectThreadCheckout(original, 'api', 'checkout_worktree');
    expect(switchResult.created).toBe(true);
    expect(switchResult.thread.checkoutId).toBe('checkout_worktree');
    expect(switchResult.thread.projectRepoId).toBe('repo_forge');
    expect(switchResult.thread.messages).toHaveLength(0);
    expect(switchResult.thread.workId).toBeUndefined();
    expect(switchResult.thread.providerSessionId).toBeUndefined();
    expect(switchResult.thread.id).not.toBe(original.id);
    expect(original.checkoutId).toBe('checkout_main');
    expect(original.workId).toBe('work_a');
    expect(original.providerSessionId).toBe('provider-session-1');
    expect(original.messages[0]?.content).toBe('run tests');
  });

  test('checkout switching replaces only empty draft and drops stale Work link', () => {
    const draft = createThread('api', 'repo_forge', 'work_a', 'checkout_main');
    const switched = selectThreadCheckout(draft, 'api', 'checkout_worktree');
    expect(switched.created).toBe(false);
    expect(switched.thread.id).toBe(draft.id);
    expect(switched.thread.checkoutId).toBe('checkout_worktree');
    expect(switched.thread.workId).toBeUndefined();
    expect(draft.checkoutId).toBe('checkout_main');
    expect(selectThreadCheckout(switched.thread, 'api', 'checkout_worktree').thread).toBe(switched.thread);
  });

  test('switching an unsent draft reuses it but clears old Work binding', () => {
    const empty = createThread('api', 'repo_avela', 'work_avela');
    const switched = selectThreadRepository(empty, 'api', 'repo_forge');
    expect(switched.created).toBe(false);
    expect(switched.thread.id).toBe(empty.id);
    expect(switched.thread.projectRepoId).toBe('repo_forge');
    expect(switched.thread.workId).toBeUndefined();
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

  test('resumes latest active same-project, same-Work and same-provider thread only', () => {
    const older = { ...createThread('api', 'repo_a', 'work_1'), updatedAt: '2026-11-01T00:00:00Z' };
    const current = { ...createThread('api', 'repo_a', 'work_1'), updatedAt: '2026-11-05T00:00:00Z' };
    const otherProject = createThread('api', 'repo_b', 'work_1');
    const otherWork = createThread('api', 'repo_a', 'work_2');
    const otherProvider = createThread('codex', 'repo_a', 'work_1');
    const archived = { ...createThread('api', 'repo_a', 'work_1'), archived: true, updatedAt: '2026-11-06T00:00:00Z' };
    const threads = [older, otherProject, archived, otherWork, current, otherProvider];
    expect(findExistingWorkThread(threads, 'api', 'repo_a', 'work_1')?.id).toBe(current.id);
    const otherCheckout = createThread('api', 'repo_a', 'work_1', 'checkout_2');
    expect(findExistingWorkThread([...threads, otherCheckout], 'api', 'repo_a', 'work_1', 'checkout_2')?.id)
      .toBe(otherCheckout.id);
    expect(findExistingWorkThread([...threads, otherCheckout], 'api', 'repo_a', 'work_1', 'checkout_1'))
      .toBeUndefined();
    expect(findExistingWorkThread(threads, 'codex', 'repo_a', 'work_1')?.id).toBe(otherProvider.id);
    expect(findExistingWorkThread(threads, 'api', 'repo_c', 'work_1')).toBeUndefined();
    expect(findExistingWorkThread(threads, 'api', 'repo_a', 'work_not_registered')).toBeUndefined();
  });
});
