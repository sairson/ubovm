// Independent end-to-end verification for the DSH-style teammate conversation view
// (task-6 / team-verify2). Drives the real rendered webview bundle (renderWebview)
// in headless Edge with a mocked VS Code host bridge and projects realistic
// `execution.team` + `execution.teamWatch` snapshots.
//
// DOM contract verified here (locked by team-ui2, mirrors .tmp-team2/contract.md):
//   section#team-member-view[role=region aria-label=团队成员会话]
//   button#team-member-back[aria-label=返回主对话]
//   span#team-member-view-status[data-status][data-live] > #team-member-view-status-text + #team-member-view-live
//   div#team-member-view-scroll[tabindex=0] > div#team-member-view-history[role=log aria-live=polite]
//   article.team-member-message[data-entry-role][data-entry-id] (live: data-entry-id="live" + data-streaming)
//   #team-member-view-loading / #team-member-view-error(+#team-member-view-retry) /
//   #team-member-view-empty / #team-member-view-omitted / #team-member-view-member-error
// Open/close post {action:'watchTeamMember', name|name:null} through the app request helper.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { renderWebview } from '../../../host/ui/webview.cjs';

const edgePath = process.env.UBOVM_STYLE_EDGE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const origin = 'http://team-member-view-e2e.test/';
const SESSION = 'team-member-view-e2e';
const startedAt = Date.now();
let browser;

test.before(async () => { browser = await chromium.launch({ headless: true, executablePath: edgePath }); });
test.after(async () => { await browser?.close(); });

// ---------------------------------------------------------------------------
// Fixtures: one realistic assist conversation + team roster/task board.
// ---------------------------------------------------------------------------
const lead = () => ({
  name: 'lead', role: 'lead', status: 'running',
  description: '协助会话主 Agent：拆分任务并汇总结果',
  activity: { label: '协调团队成员', status: 'running', at: startedAt - 1000 },
  createdAt: startedAt - 60000, updatedAt: startedAt - 1000
});
const reviewer = () => ({
  name: 'reviewer', role: 'teammate', status: 'running', context: 'fork',
  description: '审查协作模块的执行代码与状态投影',
  activity: { label: '读取执行代码', status: 'running', at: startedAt - 500 },
  createdAt: startedAt - 9000, updatedAt: startedAt - 500
});
const tester = () => ({
  name: 'tester', role: 'teammate', status: 'inactive', context: 'fork',
  description: '编写并运行回归测试，采集截图证据',
  activity: { label: '已完成回归测试报告', status: 'completed', at: startedAt - 30000 },
  createdAt: startedAt - 8000, updatedAt: startedAt - 30000
});
const deployer = () => ({
  name: 'deployer', role: 'teammate', status: 'failed', context: 'fresh',
  description: '部署验证与回滚检查',
  error: '启动失败：模型连接在首次请求时中断（ECONNRESET）。',
  activity: { label: '启动失败', status: 'failed', at: startedAt - 40000 },
  createdAt: startedAt - 20000, updatedAt: startedAt - 40000
});
const task = (id, overrides = {}) => ({
  id, revision: 1, subject: id, description: '任务描述', status: 'pending',
  blockedBy: [], writeScopes: [], ready: true, writeScopeWarnings: [], ...overrides
});
const team = () => ({
  revision: 7,
  roster: [lead(), reviewer(), tester(), deployer()],
  tasks: [
    task('task-1', { subject: '梳理协作模块接口' }),
    task('task-3', { subject: '审查执行代码改动', status: 'in_progress', ownerName: 'reviewer' }),
    task('task-4', { subject: '回归测试与截图验证', status: 'completed', ownerName: 'tester' })
  ]
});

const USER_TEXT = 'Team message from lead: 请审查 team.mjs 的 live 事件转发。\n补充：确认不写审计日志。';
const ASSISTANT_MD = '审查计划：\n\n- **必须**核对 `onLiveEvent` 隔离；\n- 核对 run 事件顺序。';
const ASSISTANT_2 = '已确认 `observe(onEvent, event)`，审计事件不会随流式 tick 增长。';
const STREAM_1 = '正在核对 `team.member.run` 结束事件的 status 映射…';
const STREAM_2 = STREAM_1 + ' 失败路径应携带 status: failed。';
const REVIEWER_ERROR = '启动失败：模型连接在首次请求时中断（ECONNRESET）。';

function historyEntries() {
  return [
    { id: 'h-user-1', role: 'user', text: USER_TEXT },
    {
      id: 'h-assistant-1', role: 'assistant', text: ASSISTANT_MD,
      // Auxiliary cards only: entry.text is the published answer body, which the
      // shared renderer appends as the final markdown text part (worker-panel pattern).
      parts: [
        { id: 'h-think-1', type: 'thinking', text: '先读 drive loop，再核对事件顺序。', status: 'completed', startedAt: startedAt - 90000, endedAt: startedAt - 87000 },
        { id: 'h-tool-1', type: 'tool', name: 'read_file', args: '{"path":"src/harness/agents/collaboration/team.mjs"}', output: '...', status: 'completed', startedAt: startedAt - 86000, endedAt: startedAt - 85000 }
      ]
    },
    { id: 'h-user-2', role: 'user', text: '补充：chat_agent.cjs 里必须是 observe(onEvent, event)。' },
    {
      id: 'h-assistant-2', role: 'assistant', text: ASSISTANT_2,
      parts: [
        { id: 'h-think-2', type: 'thinking', text: '对照 chat_agent.cjs 的 observe 实现。', status: 'completed', startedAt: startedAt - 45000, endedAt: startedAt - 42000 },
        { id: 'h-tool-2', type: 'tool', name: 'exec_command', args: '{"command":"node --test team.test.mjs"}', output: 'ok 71', status: 'completed', startedAt: startedAt - 41000, endedAt: startedAt - 40000 }
      ]
    }
  ];
}
function runningWatch(overrides = {}) {
  return {
    name: 'reviewer', role: 'teammate', status: 'running',
    description: '审查协作模块的执行代码与状态投影',
    activity: { label: '核对 live 事件顺序', status: 'running', at: startedAt - 500 },
    running: true,
    history: { entries: historyEntries(), omitted: 2 },
    live: {
      parts: [
        { id: 'live-think', type: 'thinking', text: '正在核对状态映射与中断路径…', status: 'running', startedAt: startedAt - 3000 },
        { id: 'live-tool', type: 'tool', name: 'exec_command', args: '{}', output: 'ok', status: 'completed', startedAt: startedAt - 2000, endedAt: startedAt - 1500 },
        { id: 'live-text', type: 'text', text: STREAM_1, status: 'streaming' }
      ],
      streamText: STREAM_1
    },
    updatedAt: startedAt - 500,
    ...overrides
  };
}
function testerWatch(overrides = {}) {
  return {
    name: 'tester', role: 'teammate', status: 'inactive',
    description: '编写并运行回归测试，采集截图证据',
    activity: { label: '已完成回归测试报告', status: 'completed', at: startedAt - 30000 },
    running: false,
    history: {
      entries: [
        { id: 't-user-1', role: 'user', text: 'Team message from lead: 运行回归测试并记录计数。' },
        { id: 't-assistant-1', role: 'assistant', text: '回归报告已生成：thinking-cards 9/9 通过。', parts: [
          { id: 't-tool-1', type: 'tool', name: 'exec_command', args: '{}', output: 'ok 9', status: 'completed', startedAt: startedAt - 65000, endedAt: startedAt - 64000 }
        ] }
      ],
      omitted: 0
    },
    live: { parts: [], streamText: '' },
    updatedAt: startedAt - 30000,
    ...overrides
  };
}
function emptyWatch(overrides = {}) {
  return {
    name: 'reviewer', role: 'teammate', status: 'inactive', running: false,
    history: { entries: [], omitted: 0 },
    live: { parts: [], streamText: '' },
    ...overrides
  };
}

function buildState({ teamWatch, conversationId = SESSION, mode = 'assist', execution = {}, teamValue = team() } = {}) {
  const exec = {
    status: 'running', busy: true, parts: [], streamText: '', activities: [],
    team: teamValue,
    ...(teamWatch !== undefined ? { teamWatch } : {}),
    ...execution
  };
  return {
    type: 'state',
    mode,
    conversation: { id: conversationId, title: '协作团队审查' },
    messages: [
      { id: 'm-user-1', role: 'user', text: '请组建一个团队，审查协作模块的实现并补齐回归测试。' },
      { id: 'm-assistant-1', role: 'assistant', text: '已建立团队：**reviewer** 负责审查执行代码，**tester** 负责回归测试。' }
    ],
    goal: null,
    context: { workspace: 'UBOVM', file: '' },
    provider: { configured: true, connected: true, label: '测试模型' },
    busy: true,
    execution: exec
  };
}

// ---------------------------------------------------------------------------
// Page harness: real bundle, mocked host bridge, per-test error/network capture.
// ---------------------------------------------------------------------------
async function fixture(t, { width = 1100, height = 820 } = {}) {
  const page = await browser.newPage({ viewport: { width, height }, reducedMotion: 'reduce' });
  page.setDefaultTimeout(7000);
  const pageErrors = [];
  const consoleErrors = [];
  const remoteRequests = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('console', entry => { if (entry.type() === 'error') consoleErrors.push(entry.text()); });
  page.on('request', request => {
    const url = request.url();
    if (/^https?:/.test(url) && !url.startsWith(origin)) remoteRequests.push(url);
  });
  page.on('requestfailed', request => {
    const url = request.url();
    if (/^https?:/.test(url) && !url.startsWith(origin)) remoteRequests.push(url + ' (failed)');
  });
  await page.addInitScript(({ now }) => {
    window.fixtureNow = now;
    Date.now = () => window.fixtureNow;
    window.hostMessages = [];
    window.acquireVsCodeApi = () => ({
      getState: () => ({}), setState() {},
      postMessage: message => { window.hostMessages.push(message); }
    });
  }, { now: startedAt });
  await page.route(origin, route => route.fulfill({
    contentType: 'text/html',
    body: renderWebview({ version: 'test', workspaceName: 'UBOVM', nonce: 'team-member-view-e2e-test' })
  }));
  await page.route('https://blocked-team.invalid/**', route => route.abort());
  await page.goto(origin);
  const frames = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const emit = async value => {
    await page.evaluate(state => window.dispatchEvent(new MessageEvent('message', { data: state })), value);
    await frames();
  };
  // First paint: the webview stays in its loading shell until a host state arrives.
  await emit(buildState());
  await page.waitForFunction(() => document.body.dataset.loading === 'false', undefined, { timeout: 8000 });
  t.after(async () => {
    await page.close();
    assert.deepEqual(pageErrors, [], 'the teammate conversation view must not throw page errors');
    assert.deepEqual(consoleErrors, [], 'the teammate conversation view must not log console errors');
    assert.deepEqual(remoteRequests, [], 'the teammate conversation view must not request remote resources');
  });
  const toggle = page.locator('#team-toggle');
  const panel = page.locator('#team-panel');
  const view = page.locator('#team-member-view');
  const history = page.locator('#team-member-view-history');
  const memberRow = name => panel.locator('.team-member', {
    has: page.locator('.team-member-name-text', { hasText: new RegExp('^' + name + '$') })
  });
  const hostMessages = () => page.evaluate(() => window.hostMessages.slice());
  const watchMessages = async () => (await hostMessages()).filter(message => message?.action === 'watchTeamMember');
  const api = { page, emit, frames, toggle, panel, view, history, memberRow, hostMessages, watchMessages };
  api.openPanel = async () => {
    if (!(await panel.isVisible().catch(() => false))) {
      await toggle.click();
      await panel.waitFor({ state: 'visible' });
    }
  };
  api.openMember = async name => {
    await api.openPanel();
    await memberRow(name).click();
    await view.waitFor({ state: 'visible' });
    await frames();
  };
  api.openWith = async watch => {
    await api.openMember(watch.name);
    await emit(buildState({ teamWatch: watch }));
    await page.waitForFunction(() => document.querySelectorAll('#team-member-view-history article.team-member-message').length > 0, undefined, { timeout: 5000 });
    await frames();
  };
  api.facts = () => page.evaluate(() => {
    const view = document.getElementById('team-member-view');
    const history = document.getElementById('team-member-view-history');
    const scroll = document.getElementById('team-member-view-scroll');
    const chip = document.getElementById('team-member-view-status');
    const live = document.getElementById('team-member-view-live');
    const visible = element => Boolean(element) && element.getClientRects().length > 0;
    const entries = [...document.querySelectorAll('#team-member-view-history article.team-member-message')];
    const liveEntry = history?.querySelector('[data-entry-id="live"]');
    const messages = document.getElementById('messages');
    const back = document.getElementById('team-member-back');
    return {
      viewHidden: view?.hidden ?? null,
      viewVisible: visible(view),
      role: view?.getAttribute('role') || '',
      ariaLabel: view?.getAttribute('aria-label') || '',
      backLabel: back?.getAttribute('aria-label') || '',
      backVisible: visible(back),
      scrollTabIndex: scroll?.tabIndex ?? null,
      scrollLabel: scroll?.getAttribute('aria-label') || '',
      logRole: history?.getAttribute('role') || '',
      logLive: history?.getAttribute('aria-live') || '',
      logRelevant: history?.getAttribute('aria-relevant') || '',
      name: document.getElementById('team-member-view-name')?.textContent || '',
      breadcrumb: document.querySelector('.team-member-view-breadcrumb')?.innerText || '',
      roleChip: document.getElementById('team-member-view-role')?.textContent || '',
      chipStatus: chip?.getAttribute('data-status') || '',
      chipLive: chip?.getAttribute('data-live') || '',
      chipText: document.getElementById('team-member-view-status-text')?.textContent || '',
      liveDotHidden: live ? live.hidden : null,
      liveDotAriaHidden: live?.getAttribute('aria-hidden') || null,
      hint: document.querySelector('.team-member-view-hint')?.textContent || '',
      description: document.getElementById('team-member-view-description')?.textContent || '',
      activity: document.getElementById('team-member-view-activity')?.textContent || '',
      historyHidden: history?.hidden ?? null,
      historyChildren: history?.children.length ?? 0,
      entries: entries.map(entry => ({
        role: entry.getAttribute('data-entry-role'),
        id: entry.getAttribute('data-entry-id'),
        streaming: entry.getAttribute('data-streaming'),
        text: entry.innerText || '',
        className: entry.className
      })),
      liveEntry: liveEntry ? {
        id: liveEntry.getAttribute('data-entry-id'),
        streaming: liveEntry.getAttribute('data-streaming'),
        text: liveEntry.innerText || ''
      } : null,
      assistantCount: entries.filter(entry => entry.getAttribute('data-entry-role') === 'assistant').length,
      userCount: entries.filter(entry => entry.getAttribute('data-entry-role') === 'user').length,
      thinkingCards: document.querySelectorAll('#team-member-view-history .thinking-card').length,
      toolCards: document.querySelectorAll('#team-member-view-history .tool-card').length,
      firstAssistantMarkdown: (() => {
        const body = document.querySelector('#team-member-view-history article[data-entry-id="h-assistant-1"] .team-member-message-body');
        return body ? { strong: [...body.querySelectorAll('strong')].map(node => node.textContent), code: [...body.querySelectorAll('code')].map(node => node.textContent) } : null;
      })(),
      userBubble: (() => {
        const article = document.querySelector('#team-member-view-history article[data-entry-role="user"]');
        const text = article?.querySelector('.team-member-message-text');
        return article && text ? {
          text: text.textContent,
          whiteSpace: getComputedStyle(text).whiteSpace,
          nestedMarkup: text.querySelector('strong, em, code, p, div') !== null,
          className: article.className
        } : null;
      })(),
      toolPaths: [...document.querySelectorAll('#team-member-view-history .tool-card .tool-path, #team-member-view-history .tool-card .tool-card-summary')].map(node => node.textContent || ''),
      loadingVisible: visible(document.getElementById('team-member-view-loading')),
      loadingText: document.getElementById('team-member-view-loading')?.textContent || '',
      errorVisible: visible(document.getElementById('team-member-view-error')),
      errorText: document.getElementById('team-member-view-error-text')?.textContent || '',
      retryVisible: visible(document.getElementById('team-member-view-retry')),
      retryText: document.getElementById('team-member-view-retry')?.textContent || '',
      emptyVisible: visible(document.getElementById('team-member-view-empty')),
      emptyText: document.getElementById('team-member-view-empty')?.textContent || '',
      omittedVisible: visible(document.getElementById('team-member-view-omitted')),
      omittedText: document.getElementById('team-member-view-omitted')?.textContent || '',
      memberErrorVisible: visible(document.getElementById('team-member-view-member-error')),
      memberErrorText: document.getElementById('team-member-view-member-error')?.textContent || '',
      panelHidden: document.getElementById('team-panel')?.hidden ?? null,
      toggleExpanded: document.getElementById('team-toggle')?.getAttribute('aria-expanded') ?? null,
      teamMemberAttr: document.getElementById('assist-mode')?.getAttribute('data-team-member') ?? null,
      messagesVisible: messages ? messages.getClientRects().length > 0 : null,
      messagesText: messages?.innerText || '',
      mainConversationVisible: Boolean(messages && messages.getClientRects().length > 0),
      activeId: document.activeElement?.id || '',
      innerWidth: window.innerWidth,
      documentScrollWidth: document.documentElement.scrollWidth,
      bodyScrollWidth: document.body.scrollWidth,
      viewRect: view ? { left: view.getBoundingClientRect().left, right: view.getBoundingClientRect().right } : null,
      overflowingChildren: (() => {
        if (!view) return [];
        const limit = window.innerWidth + 1;
        return [...view.querySelectorAll('*')]
          .filter(node => node.getBoundingClientRect && node.getBoundingClientRect().right > limit)
          .slice(0, 5).map(node => (node.className || node.tagName) + ' @' + Math.round(node.getBoundingClientRect().right));
      })()
    };
  });
  return api;
}

// ---------------------------------------------------------------------------
// 1. Teammate row click -> view opens, panel closes, watch RPC posted.
// ---------------------------------------------------------------------------
test('clicking a teammate row opens the member view, closes the panel and requests the watch', async t => {
  const f = await fixture(t);
  const row = f.memberRow('reviewer');
  await f.openPanel();
  const rowContract = await row.evaluate(node => ({
    role: node.getAttribute('role'),
    tabIndex: node.getAttribute('tabindex'),
    haspopup: node.getAttribute('aria-haspopup'),
    controls: node.getAttribute('aria-controls'),
    selectable: node.classList.contains('team-member-selectable')
  }));
  assert.deepEqual(rowContract, { role: 'button', tabIndex: '0', haspopup: 'dialog', controls: 'team-member-view', selectable: true },
    'a teammate row must be a keyboard-reachable button that advertises the member view dialog');
  await row.click();
  await f.view.waitFor({ state: 'visible' });
  await f.frames();
  const requests = await f.watchMessages();
  assert.equal(requests.length, 1, 'opening a teammate must post exactly one watchTeamMember request');
  assert.equal(requests[0].name, 'reviewer');
  assert.equal(requests[0].sessionId, SESSION);
  assert.match(requests[0].requestId, /^ui-/, 'the watch request must reuse the app request helper (requestId ui-*)');
  const facts = await f.facts();
  assert.equal(facts.viewVisible, true, '#team-member-view must be visible after selecting the teammate');
  assert.equal(facts.panelHidden, true, 'selecting a teammate must close the Team panel');
  assert.equal(facts.toggleExpanded, 'false', 'the trigger must report the collapsed state');
  assert.equal(facts.teamMemberAttr, 'true', '#assist-mode must carry data-team-member="true"');
  assert.equal(facts.messagesVisible, false, 'the main conversation must be hidden while the member view is open');
});

// ---------------------------------------------------------------------------
// 2. Accessible conversation surface.
// ---------------------------------------------------------------------------
test('the member view exposes the accessible conversation surface', async t => {
  const f = await fixture(t);
  await f.openWith(runningWatch());
  const facts = await f.facts();
  assert.equal(facts.role, 'region', '#team-member-view must be an inline region');
  assert.equal(facts.ariaLabel, '团队成员会话');
  assert.equal(facts.backVisible, true);
  assert.equal(facts.backLabel, '返回主对话', 'the back control needs a stable accessible name');
  assert.equal(facts.scrollTabIndex, 0, 'the scroll container must be keyboard focusable');
  assert.equal(facts.scrollLabel, '成员会话记录');
  assert.equal(facts.logRole, 'log');
  assert.equal(facts.logLive, 'polite', 'the history log must announce live updates politely');
  assert.equal(facts.logRelevant, 'additions text');
  assert.equal(facts.roleChip, '团队成员');
  assert.equal(facts.chipText, '运行中', 'status must be text, never colour-only');
  assert.equal(facts.liveDotAriaHidden, 'true', 'the decorative live dot must be hidden from the accessibility tree');
  assert.match(facts.hint, /消息由主 Agent 协调/);
  assert.equal(facts.name, 'reviewer');
  assert.match(facts.breadcrumb, /团队\s*\/\s*reviewer/);
});

// ---------------------------------------------------------------------------
// 3. Keyboard activation (Enter and Space) mirrors a click.
// ---------------------------------------------------------------------------
test('teammate rows open the view from the keyboard with Enter and Space', async t => {
  const f = await fixture(t);
  await f.openPanel();
  await f.memberRow('reviewer').focus();
  await f.page.keyboard.press('Enter');
  await f.view.waitFor({ state: 'visible' });
  let requests = await f.watchMessages();
  assert.equal(requests.length, 1, 'Enter on a focused teammate row must open the member view');
  assert.equal(requests[0].name, 'reviewer');
  await f.page.keyboard.press('Escape');
  await f.frames();
  assert.equal((await f.facts()).viewHidden, true, 'Escape must close the member view before reopening');
  await f.openPanel();
  await f.memberRow('reviewer').focus();
  await f.page.keyboard.press('Space');
  await f.view.waitFor({ state: 'visible' });
  requests = await f.watchMessages();
  assert.equal(requests.filter(message => message.name === 'reviewer').length, 2,
    'Space on a focused teammate row must open the member view too');
  assert.equal(requests.filter(message => message.name === 'reviewer')[1].name, 'reviewer');
});

// ---------------------------------------------------------------------------
// 4. The Lead row is not selectable / returns to the main conversation.
// ---------------------------------------------------------------------------
test('the Lead row never opens the member view and returns to the main conversation', async t => {
  const f = await fixture(t);
  await f.openPanel();
  const leadRow = f.memberRow('lead');
  const leadContract = await leadRow.evaluate(node => ({
    current: node.getAttribute('data-current'),
    role: node.getAttribute('role'),
    hasTabIndex: node.hasAttribute('tabindex'),
    haspopup: node.getAttribute('aria-haspopup')
  }));
  assert.deepEqual(leadContract, { current: 'true', role: null, hasTabIndex: false, haspopup: null },
    'the Lead row is the current conversation: not a button, not keyboard-activatable, no dialog affordance');
  await leadRow.click();
  await f.frames();
  assert.equal((await f.facts()).viewHidden, true, 'clicking the Lead row must not open a member view');
  assert.deepEqual(await f.watchMessages(), [], 'clicking the Lead row must not post a watch request when no member view is open');

  await f.openWith(runningWatch());
  assert.equal((await f.facts()).viewVisible, true);
  await f.openPanel();
  await f.memberRow('lead').click();
  await f.frames();
  const facts = await f.facts();
  assert.equal(facts.viewHidden, true, 'clicking the Lead row while a member view is open must return to the main conversation');
  assert.equal(facts.teamMemberAttr, null);
  assert.equal(facts.mainConversationVisible, true);
  const clears = (await f.watchMessages()).filter(message => message.name === null);
  assert.equal(clears.length, 1, 'returning to the Lead conversation must post name:null once');
});

// ---------------------------------------------------------------------------
// 5. Loading state until the watch snapshot arrives.
// ---------------------------------------------------------------------------
test('the loading state is shown until the watch snapshot arrives', async t => {
  const f = await fixture(t);
  await f.openMember('reviewer');
  await f.page.waitForFunction(() => document.getElementById('team-member-view-loading')?.getClientRects().length > 0, undefined, { timeout: 4000 });
  const loading = await f.facts();
  assert.equal(loading.loadingVisible, true);
  assert.match(loading.loadingText, /正在读取 reviewer 的会话/, `loading copy must name the member, got ${JSON.stringify(loading.loadingText)}`);
  assert.equal(loading.historyChildren, 0, 'no history may render before the watch state arrives');
  assert.equal(loading.viewVisible, true, 'the view frame is visible while loading');

  await f.emit(buildState({ teamWatch: runningWatch() }));
  await f.page.waitForFunction(() => document.querySelectorAll('#team-member-view-history article.team-member-message').length === 5, undefined, { timeout: 5000 });
  const loaded = await f.facts();
  assert.equal(loaded.loadingVisible, false, 'loading must disappear once the watch state arrives');
  assert.equal(loaded.historyChildren, 5);
});

// ---------------------------------------------------------------------------
// 6. User history bubble: plain text with preserved newlines.
// ---------------------------------------------------------------------------
test('history renders the user team-message bubble as preserved plain text', async t => {
  const f = await fixture(t);
  await f.openWith(runningWatch());
  const facts = await f.facts();
  assert.equal(facts.userCount, 2, 'both user entries must render');
  assert.ok(facts.userBubble, 'a user bubble must render');
  assert.match(facts.userBubble.className, /team-member-message-user/);
  assert.equal(facts.userBubble.text, USER_TEXT, 'the user bubble must preserve the exact text including newlines');
  assert.equal(facts.userBubble.whiteSpace, 'pre-wrap', 'newlines in user messages must be preserved');
  assert.equal(facts.userBubble.nestedMarkup, false, 'user messages are plain text, not Markdown');
});

// ---------------------------------------------------------------------------
// 7. Assistant history: markdown + thinking cards + tool cards.
// ---------------------------------------------------------------------------
test('assistant history renders markdown, thinking cards and tool cards', async t => {
  const f = await fixture(t);
  await f.openWith(runningWatch());
  const facts = await f.facts();
  assert.equal(facts.assistantCount, 3, 'two assistant history entries plus the live entry must render');
  assert.ok(facts.firstAssistantMarkdown, 'the first assistant entry must use the message body renderer');
  assert.ok(facts.firstAssistantMarkdown.strong.includes('必须'), 'assistant **bold** must render as <strong>');
  assert.ok(facts.firstAssistantMarkdown.code.some(text => /onLiveEvent/.test(text)), 'assistant inline code must render as <code>');
  assert.ok(facts.thinkingCards >= 2, `history thinking cards must render (got ${facts.thinkingCards})`);
  assert.ok(facts.toolCards >= 2, `history tool cards must render (got ${facts.toolCards})`);
  assert.ok(facts.toolPaths.some(text => /team\.mjs/.test(text)), 'the read_file tool card must show its target path');
  assert.match(facts.messagesText, /已建立团队/, 'the main conversation is still rendered behind the hidden pane');
});

// ---------------------------------------------------------------------------
// 8. Tool card expansion stays functional inside the member view.
// ---------------------------------------------------------------------------
test('tool cards expand and collapse inside the member view', async t => {
  const f = await fixture(t);
  await f.openWith(runningWatch());
  // Flat one-line cards (read_file) are intentionally read-only; the expandable
  // exec_command card must keep its disclosure behaviour inside the member view.
  const card = f.page.locator('#team-member-view-history .tool-card[data-readonly="false"]').first();
  assert.equal(await card.count(), 1, 'an expandable tool card must render inside the member view');
  assert.equal(await card.evaluate(node => node.open), false, 'history tool cards start collapsed');
  await card.locator(':scope > .tool-card-summary').click();
  await f.frames();
  assert.equal(await card.evaluate(node => node.open), true, 'clicking the tool card summary must expand it');
  assert.equal(await card.locator(':scope > .tool-card-body').isVisible(), true, 'the expanded tool card body must be visible');
  await card.locator(':scope > .tool-card-summary').click();
  await f.frames();
  assert.equal(await card.evaluate(node => node.open), false, 'a second click collapses the tool card again');
});

// ---------------------------------------------------------------------------
// 9. Live streaming entry + running chip/live dot.
// ---------------------------------------------------------------------------
test('the live assistant entry streams and the chip reports a running member', async t => {
  const f = await fixture(t);
  await f.openWith(runningWatch());
  await f.page.waitForFunction(
    () => document.querySelector('#team-member-view-history [data-entry-id="live"]')?.textContent?.includes('status 映射'),
    undefined, { timeout: 5000 });
  const facts = await f.facts();
  assert.ok(facts.liveEntry, 'a live assistant entry must render');
  assert.equal(facts.liveEntry.id, 'live');
  assert.equal(facts.liveEntry.streaming, 'true', 'a running member marks the live entry data-streaming="true"');
  assert.equal(facts.chipStatus, 'running');
  assert.equal(facts.chipLive, 'true');
  assert.equal(facts.liveDotHidden, false, 'the live dot must be visible while the member runs');
  const last = facts.entries[facts.entries.length - 1];
  assert.equal(last.id, 'live', 'the live entry must be the last history child');
  assert.match(last.text, /正在核对/, 'the streamed text must be rendered in the live entry');
});

// ---------------------------------------------------------------------------
// 10. Second state: same live element grows; status chip/live dot settle.
// ---------------------------------------------------------------------------
test('a second state grows the live text in place and updates the status chip', async t => {
  const f = await fixture(t);
  await f.openWith(runningWatch());
  await f.page.evaluate(() => { window.__live = document.querySelector('#team-member-view-history [data-entry-id="live"]'); });
  const firstText = await f.page.evaluate(() => window.__live?.innerText || '');
  assert.match(firstText, /正在核对/);

  const grew = runningWatch({
    live: {
      parts: [
        { id: 'live-think', type: 'thinking', text: '正在核对状态映射与中断路径…', status: 'completed', startedAt: startedAt - 3000, endedAt: startedAt - 1000 },
        { id: 'live-tool', type: 'tool', name: 'exec_command', args: '{}', output: 'ok', status: 'completed', startedAt: startedAt - 2000, endedAt: startedAt - 1500 },
        { id: 'live-text', type: 'text', text: STREAM_2, status: 'streaming' }
      ],
      streamText: STREAM_2
    }
  });
  await f.emit(buildState({ teamWatch: grew }));
  await f.page.waitForFunction(text => document.querySelector('#team-member-view-history [data-entry-id="live"]')?.textContent?.includes(text), '失败路径应携带', { timeout: 5000 });
  const sameNode = await f.page.evaluate(() => window.__live === document.querySelector('#team-member-view-history [data-entry-id="live"]'));
  assert.equal(sameNode, true, 'live updates must reuse the same [data-entry-id="live"] element instead of rebuilding it');
  assert.match(await f.page.evaluate(() => window.__live.innerText), /失败路径应携带 status: failed/);

  await f.emit(buildState({ teamWatch: runningWatch({
    status: 'inactive', running: false,
    activity: { label: '审查完成', status: 'completed', at: startedAt },
    live: grew.live
  }) }));
  await f.page.waitForFunction(() => document.getElementById('team-member-view-status')?.getAttribute('data-live') === 'false', undefined, { timeout: 5000 });
  const settled = await f.facts();
  assert.equal(settled.chipStatus, 'inactive', 'the chip must follow teamWatch.status');
  assert.equal(settled.chipText, '未运行');
  assert.equal(settled.chipLive, 'false');
  assert.equal(settled.liveDotHidden, true, 'the live dot must hide once the run settles');
  assert.equal(settled.liveEntry.streaming, null, 'data-streaming must be removed when the run is no longer live');
  assert.equal(await f.page.evaluate(() => window.__live === document.querySelector('#team-member-view-history [data-entry-id="live"]')), true,
    'settling must keep the same live element');
});

// ---------------------------------------------------------------------------
// 11. Back button close: name:null + main conversation restored.
// ---------------------------------------------------------------------------
test('the back button closes the view, posts name:null and restores the main conversation', async t => {
  const f = await fixture(t);
  await f.openWith(runningWatch());
  await f.page.locator('#team-member-back').click();
  await f.frames();
  const facts = await f.facts();
  assert.equal(facts.viewHidden, true, 'the back button must hide #team-member-view');
  assert.equal(facts.teamMemberAttr, null, 'closing must remove #assist-mode[data-team-member]');
  assert.equal(facts.mainConversationVisible, true, 'the main conversation must be visible again');
  assert.match(facts.messagesText, /已建立团队/, 'the Lead conversation content must be restored');
  const clears = (await f.watchMessages()).filter(message => message.name === null);
  assert.equal(clears.length, 1, 'closing must post watchTeamMember {name:null}');
  assert.equal(clears[0].sessionId, SESSION);
});

// ---------------------------------------------------------------------------
// 12. Focus management on open and close.
// ---------------------------------------------------------------------------
test('focus lands on the back button on open and returns to the team trigger on close', async t => {
  const f = await fixture(t);
  await f.openMember('reviewer');
  assert.equal((await f.facts()).activeId, 'team-member-back', 'opening must focus the back button');
  await f.page.locator('#team-member-back').click();
  await f.frames();
  const facts = await f.facts();
  assert.equal(facts.activeId, 'team-toggle', 'closing must restore focus to the stable topbar team trigger');
  assert.equal(facts.viewHidden, true);
});

// ---------------------------------------------------------------------------
// 13. Escape close.
// ---------------------------------------------------------------------------
test('Escape closes the member view without reopening the Team panel', async t => {
  const f = await fixture(t);
  await f.openWith(runningWatch());
  await f.page.keyboard.press('Escape');
  await f.frames();
  const facts = await f.facts();
  assert.equal(facts.viewHidden, true, 'Escape must close the member view');
  assert.equal(facts.panelHidden, true, 'Escape must not reopen the Team panel');
  assert.equal(facts.mainConversationVisible, true);
  const clears = (await f.watchMessages()).filter(message => message.name === null);
  assert.equal(clears.length, 1, 'Escape must post watchTeamMember {name:null}');
});

// ---------------------------------------------------------------------------
// 14. Failed watch RPC -> error + retry.
// ---------------------------------------------------------------------------
test('a failed watch request shows the error state and retry re-requests the member', async t => {
  const f = await fixture(t);
  await f.openMember('reviewer');
  const requests = await f.watchMessages();
  assert.equal(requests.length, 1);
  await f.emit({ type: 'uiResult', requestId: requests[0].requestId, ok: false, failure: '读取失败：会话记录不可用。' });
  await f.page.waitForFunction(() => document.getElementById('team-member-view-error')?.getClientRects().length > 0, undefined, { timeout: 5000 });
  const failed = await f.facts();
  assert.equal(failed.errorVisible, true, 'a failed watch RPC must show the blocking error state');
  assert.match(failed.errorText, /会话记录不可用/, `the failure text must be shown, got ${JSON.stringify(failed.errorText)}`);
  assert.equal(failed.retryVisible, true, 'the error state must offer a retry button');
  assert.equal(failed.loadingVisible, false);

  await f.page.locator('#team-member-view-retry').click();
  await f.frames();
  const afterRetry = await f.watchMessages();
  assert.equal(afterRetry.length, 2, 'retry must post a fresh watchTeamMember request');
  assert.equal(afterRetry[1].name, 'reviewer');
  assert.equal((await f.facts()).loadingVisible, true, 'retry must show the loading state again');

  await f.emit(buildState({ teamWatch: runningWatch() }));
  await f.page.waitForFunction(() => document.querySelectorAll('#team-member-view-history article.team-member-message').length === 5, undefined, { timeout: 5000 });
  const recovered = await f.facts();
  assert.equal(recovered.errorVisible, false, 'a valid watch snapshot must clear the error state');
  assert.equal(recovered.historyChildren, 5);
});

// ---------------------------------------------------------------------------
// 15. History read failure -> blocking error + retry recovery.
// ---------------------------------------------------------------------------
test('a history read failure shows the blocking error and retry recovers the transcript', async t => {
  const f = await fixture(t);
  await f.openMember('reviewer');
  // A failed transcript cannot be read: the member is not reporting a live run.
  await f.emit(buildState({ teamWatch: runningWatch({
    status: 'inactive', running: false,
    history: { entries: [], omitted: 0, error: '会话记录文件损坏，无法读取。' },
    live: { parts: [], streamText: '' }
  }) }));
  await f.page.waitForFunction(() => document.getElementById('team-member-view-error')?.getClientRects().length > 0, undefined, { timeout: 5000 });
  const failed = await f.facts();
  assert.equal(failed.errorVisible, true, 'history.error must render the blocking error state');
  assert.match(failed.errorText, /会话记录文件损坏/);
  assert.equal(failed.liveEntry, null, 'a failed transcript must not render the live entry');
  assert.equal(failed.retryVisible, true);

  await f.page.locator('#team-member-view-retry').click();
  await f.frames();
  assert.equal((await f.watchMessages()).length, 2, 'retry must re-request the watch');
  await f.emit(buildState({ teamWatch: runningWatch() }));
  await f.page.waitForFunction(() => document.querySelectorAll('#team-member-view-history article.team-member-message').length === 5, undefined, { timeout: 5000 });
  const recovered = await f.facts();
  assert.equal(recovered.errorVisible, false);
  assert.equal(recovered.historyChildren, 5);
});

// ---------------------------------------------------------------------------
// 16. Empty states: inactive vs running copy.
// ---------------------------------------------------------------------------
test('empty history renders the inactive and running empty copy', async t => {
  const f = await fixture(t);
  await f.openMember('tester');
  await f.emit(buildState({ teamWatch: emptyWatch({ name: 'tester', role: 'teammate', status: 'inactive', running: false }) }));
  await f.page.waitForFunction(() => document.getElementById('team-member-view-empty')?.getClientRects().length > 0, undefined, { timeout: 5000 });
  let facts = await f.facts();
  assert.equal(facts.emptyVisible, true);
  assert.equal(facts.emptyText, '该成员还没有会话记录。');
  assert.equal(facts.liveEntry, null, 'an idle member with no history has no live entry');

  await f.openMember('reviewer');
  await f.emit(buildState({ teamWatch: emptyWatch({ status: 'running', running: true }) }));
  await f.page.waitForFunction(() => document.getElementById('team-member-view-empty')?.textContent?.includes('等待该成员开始执行'), undefined, { timeout: 5000 });
  facts = await f.facts();
  assert.equal(facts.emptyVisible, true);
  assert.equal(facts.emptyText, '等待该成员开始执行…');
  assert.equal(facts.chipStatus, 'running');
});

// ---------------------------------------------------------------------------
// 17. Omitted-history notice.
// ---------------------------------------------------------------------------
test('the omitted-history notice shows the count and hides when nothing was omitted', async t => {
  const f = await fixture(t);
  await f.openWith(runningWatch());
  let facts = await f.facts();
  assert.equal(facts.omittedVisible, true, 'history.omitted > 0 must show the notice');
  assert.equal(facts.omittedText, '已省略 2 条更早的会话记录。', `omitted copy must include the count, got ${JSON.stringify(facts.omittedText)}`);

  const complete = runningWatch();
  complete.history = { entries: historyEntries(), omitted: 0 };
  await f.emit(buildState({ teamWatch: complete }));
  await f.page.waitForFunction(() => document.getElementById('team-member-view-omitted')?.getClientRects().length === 0, undefined, { timeout: 5000 });
  facts = await f.facts();
  assert.equal(facts.omittedVisible, false, 'omitted=0 must hide the notice');
});

// ---------------------------------------------------------------------------
// 18. Dark theme token parity.
// ---------------------------------------------------------------------------
test('the member view follows the dark theme tokens without closing', async t => {
  const f = await fixture(t);
  await f.openWith(runningWatch());
  const read = () => f.page.evaluate(() => {
    const view = getComputedStyle(document.getElementById('team-member-view'));
    const scroll = getComputedStyle(document.getElementById('team-member-view-scroll'));
    const chip = getComputedStyle(document.getElementById('team-member-view-status'));
    return { background: view.backgroundColor, color: view.color, scrollBackground: scroll.backgroundColor, chipColor: chip.color };
  });
  const light = await read();
  await f.page.evaluate(() => document.body.classList.add('vscode-dark'));
  await f.frames();
  const dark = await read();
  const facts = await f.facts();
  assert.equal(await f.page.evaluate(() => document.body.classList.contains('vscode-dark')), true);
  assert.equal(facts.viewVisible, true, 'a theme change must not close the member view');
  assert.notDeepEqual(dark, light, 'the member view must pick up the dark theme tokens');
  assert.notEqual(dark.background, light.background, 'the canvas token must change in dark mode');
  assert.notEqual(dark.color, light.color, 'the ink token must change in dark mode');
  await f.page.evaluate(() => document.body.classList.remove('vscode-dark'));
});

// ---------------------------------------------------------------------------
// 19. 420px narrow layout.
// ---------------------------------------------------------------------------
test('the member view fits a 420px viewport without horizontal overflow', async t => {
  const f = await fixture(t, { width: 420, height: 820 });
  await f.openWith(runningWatch());
  const facts = await f.facts();
  assert.equal(facts.documentScrollWidth, 420, `document scrollWidth ${facts.documentScrollWidth} must equal the 420px viewport`);
  assert(facts.bodyScrollWidth <= 420, `body scrollWidth ${facts.bodyScrollWidth} must not overflow 420px`);
  assert(facts.viewRect.left >= -1 && facts.viewRect.right <= 421, `view [${facts.viewRect.left}, ${facts.viewRect.right}] must stay inside the viewport`);
  assert.deepEqual(facts.overflowingChildren, [], 'no member-view child may overflow the 420px viewport');
  assert.equal(facts.liveEntry?.streaming, 'true', 'the narrow layout keeps the streaming state');
  assert.equal(facts.chipText, '运行中');
});

// ---------------------------------------------------------------------------
// 20. Session switch closes the view and clears the watch.
// ---------------------------------------------------------------------------
test('switching conversation closes the member view and clears the watch', async t => {
  const f = await fixture(t);
  await f.openWith(runningWatch());
  await f.emit(buildState({ teamWatch: runningWatch(), conversationId: 'team-member-view-other-session' }));
  await f.frames();
  await f.page.waitForFunction(() => document.getElementById('team-member-view')?.hidden === true, undefined, { timeout: 5000 });
  const facts = await f.facts();
  assert.equal(facts.viewHidden, true, 'a session switch must close the member view');
  assert.equal(facts.teamMemberAttr, null, 'a session switch must drop #assist-mode[data-team-member]');
  const clears = (await f.watchMessages()).filter(message => message.name === null);
  assert.equal(clears.length, 1, 'a session switch must post watchTeamMember {name:null} for the previous session');
  assert.equal(clears[0].sessionId, SESSION);
});

// ---------------------------------------------------------------------------
// 21. Mode switch closes the view and clears the watch.
// ---------------------------------------------------------------------------
test('switching to goal mode closes the member view and clears the watch', async t => {
  const f = await fixture(t);
  await f.openWith(runningWatch());
  await f.emit(buildState({ teamWatch: runningWatch(), mode: 'goal' }));
  await f.frames();
  await f.page.waitForFunction(() => document.getElementById('team-member-view')?.hidden === true, undefined, { timeout: 5000 });
  const facts = await f.facts();
  assert.equal(facts.viewHidden, true, 'a mode switch must close the member view');
  assert.equal(facts.teamMemberAttr, null);
  const clears = (await f.watchMessages()).filter(message => message.name === null);
  assert.equal(clears.length, 1, 'a mode switch must post watchTeamMember {name:null}');
});
