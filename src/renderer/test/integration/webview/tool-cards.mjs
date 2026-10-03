import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { renderWebview } from '../../../host/ui/webview.cjs';

const screenshotDirectory = fileURLToPath(new URL('../../../../../.cache', import.meta.url));
let browser;
test.before(async () => {
  await mkdir(screenshotDirectory, { recursive: true });
  browser = await chromium.launch({ headless: true, executablePath: process.env.UBOVM_STYLE_EDGE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' });
});
test.after(async () => browser?.close());

const start = Date.now();

test('same-name activities remain visible until an inline card represents their current status', async t => {
  const f = await fixture(t);
  const parts = [{ id: 'old-build', type: 'tool', name: 'build', status: 'completed', args: '{}', output: '' }];
  const activities = [{ key: 'old', label: 'build', status: 'completed' }, { key: 'new', label: 'build', status: 'running' }, { key: 'failure', label: 'build', status: 'failed' }];
  await f.emit(state(parts, { execution: { status: 'running', parts, activities } }));
  const rows = f.page.locator('#assist-activities .activity-row');
  assert.equal(await rows.count(), 2);
  assert.match(await rows.first().textContent(), /失败/);
  await f.emit(state(parts, { execution: { status: 'running', parts: [...parts, { ...parts[0], id: 'new-build', status: 'running' }], activities } }));
  assert.equal(await rows.count(), 1);
  assert.match(await rows.first().textContent(), /失败/);
});

test('repeated interrupted activity renders remove obsolete rows and do not reuse detached failures', async t => {
  const f = await fixture(t);
  await f.page.evaluate(() => {
    const original = document.createElement.bind(document);
    window.createdActivityElements = [];
    document.createElement = (...args) => { const element = original(...args); if (args[0] === 'div') createdActivityElements.push(element); return element; };
  });
  let activities;
  for (let i = 0; i < 3; i++) {
    await f.page.evaluate(() => {
      const container = document.querySelector('#assist-activities'), original = container.insertBefore;
      let inserts = 0;
      container.insertBefore = function (...args) {
        if (++inserts === 2) { delete this.insertBefore; throw Error('injected second row failure'); }
        return original.apply(this, args);
      };
    });
    activities = [{ key: 'first-' + i, label: '检查 ' + i, status: 'running' }, { key: 'second-' + i, label: '等待 ' + i, status: 'running' }];
    await f.emit(state([], { execution: { status: 'running', activities } }));
    assert.equal(await f.page.locator('#assist-activities .activity-row').count(), 1);
    assert.equal(await f.page.locator('#ui-render-retry').isVisible(), true);
  }
  await f.page.evaluate(() => { window.failedActivityRow = createdActivityElements.filter(element => element.className === 'activity-row').at(-1); });
  await f.emit(state([], { execution: { status: 'running', activities } }));
  assert.equal(await f.page.locator('#assist-activities .activity-row').count(), 2);
  assert.equal(await f.page.locator('#ui-render-retry').isVisible(), false);
  assert.equal(await f.page.evaluate(() => failedActivityRow.isConnected), false);
});

test('activity status bursts format only changed timestamps and bound visible history', async t => {
  const f = await fixture(t);
  await f.page.evaluate(() => {
    window.activityFormats = 0;
    window.activityFormatDescriptor = Object.getOwnPropertyDescriptor(Intl.DateTimeFormat.prototype, 'format');
    Object.defineProperty(Intl.DateTimeFormat.prototype, 'format', { configurable: true, get() {
      const format = activityFormatDescriptor.get.call(this);
      return (...args) => { activityFormats++; return format(...args); };
    } });
  });
  const first = { key: 'first', label: '检查服务', status: 'running', timestamp: 1000 };
  const second = { key: 'second', label: '等待响应', status: 'running', timestamp: 2000 };
  const emit = activities => f.emit(state([], { execution: { status: 'running', activities } }));
  try {
    await emit([first, second]);
    assert.equal(await f.page.evaluate(() => activityFormats), 2);
    for (let i = 0; i < 10; i++) await emit([{ ...first, status: i % 2 ? 'running' : 'completed' }, second]);
    assert.equal(await f.page.evaluate(() => activityFormats), 2);
    await emit([first, { ...second, timestamp: 3000 }]);
    assert.equal(await f.page.evaluate(() => activityFormats), 3);
    const history = Array.from({ length: 1000 }, (_, index) => ({ key: 'history-' + index, label: '活动 ' + index, status: 'completed' }));
    await emit([...history, null, { label: 'skill.loaded', status: 'completed' }]);
    const rows = f.page.locator('#assist-activities .activity-row');
    assert.equal(await rows.count(), 8);
    assert.match(await rows.first().textContent(), /活动 999/);
    assert.match(await rows.last().textContent(), /活动 992/);
  } finally {
    await f.page.evaluate(() => Object.defineProperty(Intl.DateTimeFormat.prototype, 'format', activityFormatDescriptor));
  }
});

test('activity rows reject invalid entries, retain nodes and selection, and recover an interrupted update', async t => {
  const f = await fixture(t);
  const emit = activities => f.emit(state([], { execution: { status: 'running', activities } }));
  const first = { key: 'first', label: '检查服务', status: 'running', timestamp: 1000 };
  await emit([null, {}, { label: 42 }, { label: '   ' }, first]);
  assert.equal(await f.page.locator('#assist-activities .activity-row').count(), 1);
  await f.page.evaluate(() => {
    window.savedActivityRow = document.querySelector('#assist-activities .activity-row');
    const range = document.createRange(); range.setStart(savedActivityRow.querySelector('p').firstChild, 0); range.setEnd(savedActivityRow.querySelector('p').firstChild, 4);
    getSelection().removeAllRanges(); getSelection().addRange(range);
  });
  await emit([{ ...first, incidental: 'ignored metadata' }, { key: 'second', label: '等待响应', status: 'running' }]);
  assert.equal(await f.page.evaluate(() => document.querySelectorAll('#assist-activities .activity-row')[1] === savedActivityRow), true);
  assert.equal(await f.page.evaluate(() => getSelection().toString()), '检查服务');
  assert.equal(await f.page.locator('#assist-activities .activity-row').first().locator('time').getAttribute('datetime'), null);
  await f.page.evaluate(() => {
    const container = document.querySelector('#assist-activities');
    container.insertBefore = function (...args) { delete this.insertBefore; throw Error('injected activity update failure'); };
  });
  const next = [first, { key: 'third', label: '完成检查', status: 'completed', timestamp: 'invalid' }];
  await emit(next);
  assert.equal(await f.page.locator('#ui-render-retry').isVisible(), true);
  await emit(next);
  assert.equal(await f.page.locator('#ui-render-retry').isVisible(), false);
  assert.equal(await f.page.locator('#assist-activities .activity-row').count(), 2);
  assert.match(await f.page.locator('#assist-activities').textContent(), /完成检查/);
  await emit([null, { label: '' }]);
  assert.equal(await f.page.locator('#assist-execution').evaluate(element => element.hidden), true);
  assert.equal(await f.page.locator('#assist-activities .activity-row').count(), 0);
});

test('execution activity visibility renders empty, filtered, error and goal states without reference errors', async t => {
  const f = await fixture(t);
  const hidden = () => f.page.locator('#assist-execution').evaluate(element => element.hidden);
  await f.emit(state([], { busy: false, execution: { status: 'idle', activities: [] } }));
  assert.equal(await hidden(), true);
  await f.emit(state([], { execution: { status: 'running', activities: [{ label: '连接服务', status: 'running' }] } }));
  assert.equal(await hidden(), false);
  await f.emit(state([{ id: 'build', type: 'tool', name: 'build', status: 'completed', args: '{}', output: '' }], {
    execution: { status: 'running', parts: [{ id: 'build', type: 'tool', name: 'build', status: 'completed', args: '{}', output: '' }],
      activities: [{ label: 'build', status: 'completed' }, { label: 'skill.loaded', status: 'completed' }] }
  }));
  assert.equal(await hidden(), true);
  await f.emit(state([], { execution: { status: 'failed', error: { code: 'OPERATION_FAILED', message: '测试错误' }, activities: [] } }));
  assert.equal(await hidden(), false);
  await f.emit(state([], { busy: false, execution: { status: 'interrupted', canResume: true, activities: [] } }));
  assert.equal(await hidden(), true);
  assert.equal(await f.page.locator('#assist-resume-banner').evaluate(element => element.hidden), false);
  assert.equal(await f.page.locator('#compose-dock #assist-resume-banner').count(), 1);
  assert.equal(await f.page.locator('#assist-resume').innerText(), '继续执行');
  assert.match(await f.page.locator('#assist-resume-hint').innerText(), /检查点已保存/);
  await f.emit(state([], { busy: false, execution: {
    status: 'failed', canResume: true, activities: [],
    parts: [{ id: 'ssh', type: 'tool', name: 'run_linux_ssh_command', status: 'failed', args: '{}', output: 'timeout' }]
  } }));
  assert.equal(await f.page.locator('#messages .message.has-resume .resume-turn').count(), 1);
  assert.match(await f.page.locator('#messages .resume-turn').innerText(), /未能完成/);
  assert.equal(await f.page.locator('#assist-resume-title').innerText(), '任务未完成');
  await f.emit(state([], { busy: false, execution: { status: 'completed', canResume: true, activities: [] } }));
  assert.equal(await f.page.locator('#assist-resume').innerText(), '恢复结果');
  assert.match(await f.page.locator('#assist-resume-title').innerText(), /结果待写入/);
  await f.emit(state([], { mode: 'goal', goal: { objective: '测试目标', criteria: [], notes: [] }, execution: { status: 'idle', activities: [] } }));
  assert.equal(await hidden(), true);
});

test('project management opens a centered searchable switcher from the conversation header', async t => {
  const f = await fixture(t);
  await f.emit({ ...state([]), projects: [
    { id: 'p1', name: 'Alpha', workspace: 'C:\\work\\alpha', folder: 'alpha', sessionCount: 2, assistCount: 1, goalCount: 1, running: 0, current: true, updatedAt: 2 },
    { id: 'p2', name: 'Beta', workspace: 'C:\\work\\beta', folder: 'beta', sessionCount: 1, assistCount: 1, goalCount: 0, running: 0, current: false, updatedAt: 1 }
  ] });
  const button = f.page.getByRole('button', { name: '管理与切换项目', exact: true });
  await button.click();
  const dialog = f.page.locator('#project-switcher');
  assert(await dialog.evaluate(node => node.open));
  assert(await f.page.getByRole('heading', { name: '项目', exact: true }).isVisible());
  await f.page.locator('#project-switcher-close').click();
  assert.equal(await dialog.evaluate(node => node.open), false);
  await button.click();
  assert(await dialog.evaluate(node => node.open));
  await f.page.locator('#project-switcher-search').fill('beta');
  assert.equal(await f.page.locator('.project-switcher-row').count(), 1);
  assert.match(await f.page.locator('.project-switcher-row').textContent(), /Beta/);
  await f.page.keyboard.press('Escape');
  assert.equal(await f.page.locator('#project-switcher-search').inputValue(), '');
  assert(await dialog.evaluate(node => node.open));
  await f.page.keyboard.press('Escape');
  assert.equal(await dialog.evaluate(node => node.open), false);
  await button.click();
  await f.page.locator('#project-switcher-search').fill('beta');
  await f.page.locator('.project-switcher-row').click();
  assert.equal((await f.sent('projectSwitcherOpen')).length, 1);
  assert.equal((await f.sent('projectSwitcherOpen'))[0].projectId, 'p2');
  await f.page.setViewportSize({ width: 320, height: 800 }); await f.frames();
  assert(await button.isVisible());
  const bounds = await button.boundingBox(); assert(bounds.x >= 0 && bounds.x + bounds.width <= 320);
  assert(await f.page.evaluate(() => document.documentElement.scrollWidth <= 320));
});

test('background task dock aggregates commands, streams selected logs and stops only the selected command', async t => {
  const f = await fixture(t);
  const first = tool('background-server', { name: 'run_local_shell_command', args: JSON.stringify({ command: 'npm run dev -- --port 3000' }),
    background: true, commandId: '11111111-1111-4111-8111-111111111111', status: 'running', endedAt: undefined, output: 'Ready on http://localhost:3000\n' });
  const second = { ...first, id: 'background-build', commandId: '22222222-2222-4222-8222-222222222222', args: JSON.stringify({ command: 'npm run build -- --watch' }), output: 'Watching for file changes…\n' };
  const snapshot = (server = first, build = second) => state([server], { execution: { status: 'running', busy: true, parts: [server], workers: [{ id: 'worker-1', title: '构建 Worker', status: 'running', parts: [build] }] } });
  await f.emit(snapshot());
  const dock = f.page.locator('#background-tasks');
  assert(await dock.isVisible());
  assert.equal(await f.page.locator('#messages .tool-card').count(), 0);
  assert.equal(await dock.evaluate(element => getComputedStyle(element).position), 'fixed');
  assert.match(await dock.locator('.background-tasks-count').textContent(), /2 运行中/);
  assert.equal(await dock.locator('.background-tasks-body').isVisible(), false);
  await dock.locator('.background-tasks-toggle').click();
  assert.equal(await dock.locator('.background-task-row').count(), 2);
  await dock.locator('.background-task-select').filter({ hasText: 'npm run dev' }).click();
  await f.emit(snapshot({ ...first, output: first.output + 'GET / 200\n' }));
  assert.match(await dock.locator('.background-task-log').textContent(), /GET \/ 200/);
  assert.match(await dock.locator('.background-task-detail-meta').textContent(), /主 Agent/);
  await f.page.screenshot({ path: screenshotDirectory + '/background-tasks-running.png' });
  await dock.getByRole('button', { name: '停止任务', exact: true }).click();
  assert.equal((await f.sent('interruptCommand')).at(-1).commandId, first.commandId);
  assert.equal((await f.sent('cancelRun')).length, 0);
  await f.ack('interruptCommand', false);
  assert.match(await dock.locator('.background-task-notice').textContent(), /未确认/);
  assert.equal(await dock.getByRole('button', { name: '停止任务', exact: true }).isDisabled(), false);
  await dock.getByRole('button', { name: '停止任务', exact: true }).click(); await f.ack('interruptCommand');
  await f.emit(snapshot({ ...first, status: 'interrupted', endedAt: Date.now() }));
  assert.equal(await f.page.locator('#messages .tool-card').count(), 0);
  assert.match(await dock.locator('.background-tasks-count').textContent(), /1 运行中/);
  assert.match(await dock.locator('.background-task-detail-meta').textContent(), /已停止/);
  await dock.getByRole('button', { name: '清除已结束' }).click();
  assert.equal(await dock.locator('.background-task-row').count(), 1);
  assert.match(await dock.locator('.background-task-detail-meta').textContent(), /构建 Worker/);
  await f.page.screenshot({ path: screenshotDirectory + '/background-tasks-light.png' });
  await f.page.setViewportSize({ width: 320, height: 760 });
  await f.page.evaluate(() => document.body.classList.add('vscode-dark'));
  await f.frames();
  const bounds = await dock.boundingBox(); assert(bounds.x >= 0 && bounds.x + bounds.width <= 320);
  assert(await dock.getByRole('button', { name: '停止任务', exact: true }).isVisible());
  assert(await f.page.locator('#prompt-input').isVisible());
  await f.page.screenshot({ path: screenshotDirectory + '/background-tasks-dark-narrow.png' });
  await f.emit(state([], { conversation: { id: 'other' }, execution: { status: 'idle', parts: [] } }));
  assert.equal(await dock.isVisible(), false);
});

test('background task bursts defer folded logs, preserve append selection and avoid unchanged DOM writes', async t => {
  const f = await fixture(t);
  const result = await f.page.evaluate(() => {
    const dock = window.createBackgroundTasks({});
    dock.element.id = 'background-performance'; document.body.append(dock.element);
    const first = { id: 'first', type: 'tool', name: 'run_local_shell_command', args: '{"command":"server"}',
      commandId: 'server', background: true, status: 'running', startedAt: Date.now(), output: 'line 0\n' };
    const second = { ...first, id: 'second', commandId: 'watcher', args: '{"command":"watcher"}' };
    const snapshot = parts => ({ conversation: { id: 'burst' }, execution: { parts } });
    dock.update(snapshot([first, second]));
    const log = dock.element.querySelector('.background-task-log');
    const list = dock.element.querySelector('.background-task-list');
    const observer = new MutationObserver(() => {}); observer.observe(list, { subtree: true, attributes: true, childList: true, characterData: true });
    let latest;
    for (let index = 1; index <= 100; index++) {
      latest = { ...first, output: Array.from({ length: index }, (_, line) => 'line ' + line).join('\n') };
      dock.update(snapshot([latest, second]));
    }
    const foldedWrites = observer.takeRecords().length, foldedOutput = log.textContent;
    dock.element.querySelector('.background-tasks-toggle').click();
    const loaded = log.textContent;
    log.scrollTop = 30; log.dispatchEvent(new Event('scroll'));
    const saved = log.firstChild, range = document.createRange();
    range.setStart(saved, 0); range.setEnd(saved, 6); getSelection().removeAllRanges(); getSelection().addRange(range);
    dock.update(snapshot([{ ...latest, output: latest.output + '\nnext' }, second]));
    const appended = log.firstChild === saved, selection = getSelection().toString(), top = log.scrollTop;
    const all = new MutationObserver(() => {}); all.observe(dock.element, { subtree: true, attributes: true, childList: true, characterData: true });
    for (let index = 0; index < 100; index++) dock.update(snapshot([{ ...latest, output: latest.output + '\nnext' }, second]));
    const unchangedWrites = all.takeRecords().length;
    dock.update(snapshot([{ ...latest, status: 'completed', endedAt: Date.now() }, second]));
    const order = [...list.querySelectorAll('.background-task-name')].map(element => element.textContent);
    observer.disconnect(); all.disconnect(); dock.element.remove(); dock.update(snapshot([]));
    return { foldedWrites, foldedOutput, loaded, appended, selection, top, unchangedWrites, order };
  });
  assert.equal(result.foldedWrites, 0);
  assert.equal(result.foldedOutput, '');
  assert.match(result.loaded, /line 99$/);
  assert.equal(result.appended, true);
  assert.equal(result.selection, 'line 0');
  assert.equal(result.top, 30);
  assert.equal(result.unchangedWrites, 0);
  assert.deepEqual(result.order, ['server', 'watcher']);
});

test('background task switching restores reading positions and ignores receipts for other tasks and sessions', async t => {
  const f = await fixture(t);
  const first = tool('reading-first', { name: 'run_local_shell_command', args: '{"command":"npm run server"}',
    background: true, commandId: '11111111-1111-4111-8111-111111111111', status: 'running', endedAt: undefined,
    output: Array.from({ length: 100 }, (_, index) => 'server log ' + index).join('\n') });
  const second = { ...first, id: 'reading-second', commandId: '22222222-2222-4222-8222-222222222222', args: '{"command":"npm run watcher"}' };
  await f.emit(state([first, second]));
  const dock = f.page.locator('#background-tasks'), log = dock.locator('.background-task-log');
  const choose = name => dock.locator('.background-task-select').filter({ hasText: name }).click();
  await dock.locator('.background-tasks-toggle').click();
  await choose('npm run server');
  await log.evaluate(element => { element.scrollTop = 42; element.dispatchEvent(new Event('scroll')); });
  assert.equal(await dock.getByRole('button', { name: '跟随日志' }).getAttribute('aria-pressed'), 'false');
  await choose('npm run watcher');
  assert.equal(await dock.getByRole('button', { name: '跟随日志' }).getAttribute('aria-pressed'), 'true');
  assert(await log.evaluate(element => element.scrollTop > 42));
  await choose('npm run server');
  assert.equal(await log.evaluate(element => element.scrollTop), 42);
  await dock.getByRole('button', { name: '复制日志' }).click();
  await choose('npm run watcher');
  await f.ack('copyText');
  assert.equal(await dock.locator('.background-task-notice').textContent(), '');
  await dock.getByRole('button', { name: '停止任务', exact: true }).click();
  await choose('npm run server');
  await f.ack('interruptCommand', false);
  assert.equal(await dock.locator('.background-task-notice').textContent(), '');
  await choose('npm run watcher');
  assert.equal(await dock.getByRole('button', { name: '停止任务', exact: true }).isDisabled(), false);
  await dock.getByRole('button', { name: '复制日志' }).click();
  await f.emit(state([second], { conversation: { id: 'new-background-session' } }));
  await dock.locator('.background-tasks-toggle').click();
  await f.ack('copyText');
  assert.equal(await dock.locator('.background-task-notice').textContent(), '');
  assert.equal(await dock.getByRole('button', { name: '复制日志' }).isDisabled(), false);
});

test('background dock retains terminal results in goal mode and clears them without cancelling tasks', async t => {
  const f = await fixture(t);
  const part = tool('failed-background', { name: 'run_linux_ssh_command', args: JSON.stringify({ command: 'npm run dev' }), background: true,
    commandId: '11111111-1111-4111-8111-111111111111', status: 'failed', output: 'Error: port 3000 is already in use' });
  await f.emit(state([], { mode: 'goal', conversation: { id: 'goal-session' }, goal: { objective: '运行预览', criteria: [], notes: [] }, execution: { status: 'running', busy: true, parts: [], workers: [{ id: 'worker-1', status: 'running', parts: [part] }] } }));
  const dock = f.page.locator('#background-tasks');
  assert(await dock.isVisible());
  assert.equal(await dock.evaluate(element => element.parentElement.classList.contains('shell')), true);
  assert.equal(await f.page.locator('#messages .tool-card').count(), 0);
  assert.match(await dock.locator('.background-tasks-count').textContent(), /1 失败/);
  await dock.locator('.background-tasks-toggle').click();
  assert.match(await dock.locator('.background-task-log').textContent(), /already in use/);
  assert.equal(await dock.getByRole('button', { name: '停止任务', exact: true }).isVisible(), false);
  await dock.getByRole('button', { name: '清除已结束' }).click();
  assert.equal(await dock.isVisible(), false);
  assert.equal((await f.sent('cancelRun')).length, 0);
  assert.equal((await f.sent('interruptCommand')).length, 0);
});

test('goal execution log omits background tool parts', async t => {
  const f = await fixture(t);
  const result = await f.page.evaluate(() => {
    const container = document.createElement('div');
    document.body.append(container);
    const log = window.createGoalExecutionLog(container, { actions: {}, statusText: value => value, openWorker() {} });
    const count = log.update('goal', { parts: [
      { id: 'fg', type: 'tool', name: 'read_workspace_file', status: 'completed', args: '{}', output: 'workspace file' },
      { id: 'bg', type: 'tool', name: 'run_local_shell_command', background: true, commandId: 'bg-1', status: 'completed', args: '{"command":"npm run dev"}', output: 'Ready on :3000' }
    ], activities: [{ key: 'bg', label: 'run_local_shell_command', status: 'running' }] });
    const text = container.textContent;
    log.dispose(); container.remove();
    return { count, text };
  });
  assert.equal(result.count, 1);
  assert.match(result.text, /工具调用/);
  assert.doesNotMatch(result.text, /npm run dev|Ready on :3000/);
});

test('putting a command aside does not leave a raw tool activity in the transcript', async t => {
  const f = await fixture(t);
  const commandId = '11111111-1111-4111-8111-111111111111';
  const running = { ...command, commandId, background: true, executionState: 'running', output: 'still running' };
  await f.emit(state([], {
    messages: [user, { role: 'assistant', text: '命令已放在后台继续运行。', parts: [running] }],
    execution: {
      status: 'running', busy: true, parts: [],
      activities: [
        { key: 'reason', label: 'Reason', status: 'running', timestamp: Date.parse('2026-10-03T17:36:30+08:00') },
        { key: 'ssh', label: 'run_linux_ssh_command', status: 'running', timestamp: Date.parse('2026-10-03T17:36:32+08:00') }
      ],
      workers: [{ id: 'w1', title: '构建 Worker', parts: [] }]
    }
  }));
  assert.equal(await f.page.locator('#messages .tool-card').count(), 0);
  assert(await f.page.locator('#background-tasks').isVisible());
  assert.equal(await f.page.locator('#assist-activities .activity-row').count(), 1);
  assert.match(await f.page.locator('#assist-activities').textContent(), /规划/);
  assert.doesNotMatch(await f.page.locator('#conversation').textContent(), /run_linux_ssh_command/);
  await f.emit(state([], {
    busy: false,
    messages: [user, { role: 'assistant', text: '命令已放在后台继续运行。', parts: [running] }],
    execution: {
      status: 'completed', busy: false, parts: [],
      activities: [{ key: 'ssh', label: 'run_linux_ssh_command', status: 'completed', timestamp: Date.parse('2026-10-03T17:36:32+08:00') }]
    }
  }));
  assert.equal(await f.page.locator('#assist-activities .activity-row').count(), 0);
  assert.doesNotMatch(await f.page.locator('#conversation').textContent(), /run_linux_ssh_command|工具调用 · /);
});

test('shell cards put running commands aside into the background dock', async t => {
  const f = await fixture(t);
  const commandId = '11111111-1111-4111-8111-111111111111';
  const running = { ...command, commandId, executionState: 'running' };
  await f.emit(state([running]));
  await f.card(0).getByRole('button', { name: '放在一边', exact: true }).click();
  assert.equal((await f.sent('backgroundCommand'))[0].commandId, commandId);
  await f.ack('backgroundCommand');
  await f.emit(state([{ ...running, background: true, output: 'still running' }]));
  assert.equal(await f.page.locator('#messages .tool-card').count(), 0);
  const dock = f.page.locator('#background-tasks');
  assert(await dock.isVisible());
  assert.match(await dock.locator('.background-tasks-count').textContent(), /1 运行中/);
  await dock.locator('.background-tasks-toggle').click();
  assert.equal(await dock.getByRole('button', { name: '停止任务', exact: true }).isVisible(), true);
  await f.emit(state([{ ...running, background: true, status: 'completed', endedAt: Date.now(), output: 'still running' }]));
  assert.equal(await f.page.locator('#messages .tool-card').count(), 0);
  assert.match(await dock.locator('.background-tasks-count').textContent(), /1 已结束/);
  await f.emit(state([], {
    busy: false,
    messages: [user, { role: 'assistant', text: '命令已放在后台继续运行。', parts: [{ ...running, background: true, status: 'completed', endedAt: Date.now() }] }],
    execution: { status: 'idle', busy: false, parts: [] }
  }));
  assert.match(await f.page.locator('#messages').textContent(), /命令已放在后台继续运行/);
  assert.equal(await f.page.locator('#messages .tool-card').count(), 0);
});

test('running shell cards offer tracked manual interruption while collapsed and can retry rejected requests', async t => {
  const f = await fixture(t);
  const commandId = '11111111-1111-4111-8111-111111111111';
  const running = { ...command, commandId, executionState: 'queued' };
  await f.emit(state([running]));
  assert.equal(await f.card(0).locator('.tool-status-label').textContent(), '排队中');
  assert.equal(await f.card(0).getAttribute('data-streaming'), 'false');
  const stop = f.card(0).getByRole('button', { name: '中断命令', exact: true });
  assert.equal(await stop.isVisible(), true);
  await stop.click();
  assert.equal(await f.card(0).evaluate(element => element.open), false);
  const request = (await f.sent('interruptCommand'))[0];
  assert.equal(request.commandId, commandId);
  assert.equal(request.sessionId, 'inline-tool-cards');
  assert.equal(await f.card(0).getByRole('button', { name: '正在中断…' }).isDisabled(), true);
  await f.ack('interruptCommand', false);
  await f.card(0).getByRole('button', { name: '重试中断' }).click();
  await f.ack('interruptCommand');
  assert.equal((await f.sent('interruptCommand')).length, 2);
  await f.emit(state([{ ...running, status: 'interrupted', endedAt: Date.now(), output: 'before-stop' }]));
  assert.equal(await f.card(0).locator('.tool-stop').isVisible(), false);
  await f.toggle(0);
  assert.equal(await f.card(0).locator('.tool-output').textContent(), 'before-stop');
});
const text = (id, value, status = 'completed') => ({ id, type: 'text', text: value, status });
const tool = (id, overrides = {}) => ({
  id, type: 'tool', name: 'read_workspace_file', args: '{"path":"src/harness/worker/index.mjs","startLine":1}',
  output: 'export function createWorker(options) {\n  return new Worker(options);\n}',
  status: 'completed', startedAt: start, endedAt: start + 1234, ...overrides
});
const intro = text('intro', '我会先检查 **Worker 配置** 和工具注册，再验证流式输出。');
const read = tool('read');
const listing = tool('listing', { name: 'list_workspace_files', args: '{"path":"src/harness"}', output: 'worker/index.mjs\nreason/index.mjs\nblackboard/index.mjs' });
const explanation = text('explanation', '工具已注册，接下来运行相关检查。');
const command = tool('command', { name: 'run_linux_ssh_command', args: '{"command":"node --test test/worker-streaming.test.mjs"}', output: 'TAP version 13\nok 1 - worker streams text and tools\nok 2 - interruption retains history\n# tests 2\n# pass 2', status: 'running', endedAt: undefined });
const user = { role: 'user', text: '检查工具调用与 Worker 的流式输出。' };

test('new project delivery panel shows blockers, preserves drafts and isolates conversations', async t => {
  const f = await fixture(t);
  const record = { projectType: 'new-development', revision: 2, objective: '<img src=x onerror=alert(1)> 新项目', artifact: 'sha256:release1',
    acceptance: { develop: { artifact: 'sha256:release1', summary: '构建与测试通过', evidence: [{ toolCallId: 'build' }] } },
    blocked: { security: { summary: '等待测试环境授权', owner: '项目负责人' } },
    findings: [{ id: 'AUTH-1', severity: 'high', status: 'open', summary: '权限绕过待修复' }] };
  const execution = { status: 'idle', busy: false, parts: [], memory: { delivery: record } };
  await f.emit(state([], { busy: false, execution }));
  const panel = f.page.locator('#delivery-workspace');
  assert(await panel.isVisible());
  assert.match(await panel.locator('.delivery-status').textContent(), /1\/5.*1 项发布阻塞/);
  await panel.locator('summary').click();
  assert.match(await panel.locator('.delivery-body').textContent(), /等待测试环境授权/);
  assert.equal(await panel.locator('img').count(), 0);
  await f.page.locator('#prompt-input').fill('保留我的独立开发任务');
  await f.emit(state([], { busy: false, execution: { ...execution, memory: { delivery: { ...record, revision: 3, artifact: 'sha256:release2' } } } }));
  assert.equal(await f.page.locator('#prompt-input').inputValue(), '保留我的独立开发任务');
  assert.equal(await panel.locator('details').getAttribute('open'), '');
  await panel.locator('.delivery-body').evaluate(element => { window.deliveryFirstNode = element.firstChild; });
  await f.emit(state([], { busy: false, execution: { ...execution, memory: { delivery: { ...record, revision: 3, artifact: 'sha256:release2' } } } }));
  assert(await panel.locator('.delivery-body').evaluate(element => window.deliveryFirstNode === element.firstChild), 'unchanged delivery revision retains its DOM across streamed snapshots');
  for (const width of [1000, 320]) {
    await f.page.setViewportSize({ width, height: 800 }); await f.frames();
    assert(await panel.evaluate((element, width) => element.scrollWidth <= width, width));
    const bounds = await f.page.locator('#prompt-form').boundingBox();
    assert(bounds && bounds.y + bounds.height <= 801, 'delivery panel must retain composer');
    await f.page.screenshot({ path: screenshotDirectory + `/delivery-project-${width}.png` });
  }
  await f.emit(state([], { busy: false, conversation: { id: 'standalone-audit' }, execution: { status: 'idle', busy: false, parts: [] } }));
  assert.equal(await panel.isVisible(), false);
  await f.emit(state([], { busy: false, execution }));
  assert.equal(await panel.locator('details').getAttribute('open'), null);
});

test('independent task entries retain mandatory SSH and only prepare drafts', async t => {
  const f = await fixture(t);
  const idle = { busy: false, messages: [], execution: { status: 'idle', busy: false, parts: [] } };
  await f.emit(state([], { ...idle, ssh: { configured: false } }));
  await f.page.locator('#prompt-input').fill('独立代码审计');
  assert(await f.page.locator('#submit-prompt').isDisabled());
  assert.match(await f.page.locator('#provider-label').textContent(), /SSH/);
  await f.emit(state([], { ...idle, ssh: { configured: true } }));
  assert.equal(await f.page.locator('#submit-prompt').isDisabled(), false);
  const cards = f.page.locator('[data-prompt]'); assert.equal(await cards.count(), 6);
  for (const title of ['做一次渗透测试', '做一次代码审计', '部署项目', '运维与排障', '开发一个新功能', '创建新开发项目']) {
    await cards.filter({ hasText: title }).click();
    assert((await f.page.locator('#prompt-input').inputValue()).length > 10);
    assert.equal((await f.sent('prompt')).length, 0);
  }
});
function state(parts, overrides = {}) {
  return {
    type: 'state', mode: 'assist', conversation: { id: 'inline-tool-cards', title: '工具执行记录' },
    messages: [user], goal: null, context: { workspace: 'UBOVM', file: '' },
    provider: { configured: true, connected: true, label: '测试模型' }, busy: true,
    execution: { status: 'running', busy: true, parts, streamText: '', activities: [] }, ...overrides
  };
}
async function fixture(t, options = {}) {
  const page = await browser.newPage({ viewport: { width: 1000, height: 800 }, ...options });
  page.setDefaultTimeout(7000);
  const errors = [], requests = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (/^https?:/.test(request.url()) && request.url() !== 'http://tool-cards.test/') requests.push(request.url()); });
  await page.addInitScript(() => {
    window.hostMessages = [];
    window.acquireVsCodeApi = () => ({ getState: () => ({}), setState() {}, postMessage: message => hostMessages.push(message) });
  });
  const html = renderWebview({ version: 'test', workspaceName: 'UBOVM', nonce: 'tool-cards-test' });
  await page.route('http://tool-cards.test/', route => route.fulfill({ contentType: 'text/html', body: html }));
  await page.route('https://blocked-preview.invalid/**', route => route.abort());
  await page.goto('http://tool-cards.test/');
  const frames = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const emit = async value => { await page.evaluate(value => window.dispatchEvent(new MessageEvent('message', { data: value })), value); await frames(); };
  const sent = action => page.evaluate(action => window.hostMessages.filter(message => message.action === action), action);
  const ack = async (action, ok = true) => {
    const message = (await sent(action)).at(-1);
    assert(message?.requestId, action + ' must use a tracked host request');
    await emit({ type: 'uiResult', requestId: message.requestId, ok, ...(ok ? {} : { error: 'fixture rejected' }) });
    return message;
  };
  const card = index => page.locator('#messages .tool-card').nth(index);
  const toggle = async index => {
    await card(index).locator(':scope > summary').click(); await frames();
    await card(index).evaluate(async element => {
      const transitions = element.getAnimations({ subtree: true }).filter(animation => animation.effect?.getTiming().iterations !== Infinity);
      await Promise.allSettled(transitions.map(animation => animation.finished));
    });
  };
  t.after(async () => { await page.close(); assert.deepEqual(errors, [], 'the webview must not throw browser errors'); assert.deepEqual(requests, [], 'tool output and HTML preview must not fetch remote resources'); });
  return { page, emit, frames, sent, ack, card, toggle };
}

test('closed HTML previews reject detached actions and late copy completion', async t => {
  const f = await fixture(t);
  const result = await f.page.evaluate(async () => {
    let resolveCopy, copies = 0;
    UBOVMHtmlPreview.open('<p>old</p>', { onCopy: () => { copies++; return new Promise(resolve => { resolveCopy = resolve; }); } });
    const old = document.querySelector('.html-preview');
    const oldCopy = old.querySelector('[data-preview-action="copy"]');
    oldCopy.click();
    oldCopy.dispatchEvent(new MouseEvent('click'));
    UBOVMHtmlPreview.open('<p>new</p>', { onCopy: () => false });
    const current = document.querySelector('.html-preview');
    old.querySelector('[data-preview-action="close"]').click();
    oldCopy.disabled = false; oldCopy.click();
    resolveCopy(true); await Promise.resolve(); await Promise.resolve();
    const oldStatus = old.querySelector('[role="status"]').textContent;
    const newStatus = current.querySelector('[role="status"]').textContent;
    const retained = current.isConnected && UBOVMHtmlPreview.isOpen;
    current.querySelector('[data-preview-action="copy"]').click();
    await Promise.resolve(); await Promise.resolve();
    const failed = current.querySelector('[role="status"]').textContent;
    dispatchEvent(new Event('blur')); dispatchEvent(new Event('pagehide'));
    const closed = !UBOVMHtmlPreview.isOpen && !current.isConnected;
    const restored = !document.querySelector('.shell').inert;
    dispatchEvent(new Event('pageshow'));
    return { copies, oldStatus, newStatus, retained, failed, closed, restored };
  });
  assert.equal(result.copies, 1);
  assert.equal(result.oldStatus, ''); assert.equal(result.newStatus, '');
  assert.equal(result.retained, true);
  assert.match(result.failed, /复制失败/);
  assert.equal(result.closed, true); assert.equal(result.restored, true);
});

test('folded commands expose a bounded live tail and retain failures without opening logs', async t => {
  const f = await fixture(t);
  let part = tool('live-tail', { name: 'run_linux_ssh_command', status: 'running', output: 'old\n'.repeat(10000) + '\u001b[32mfirst\u001b[0m\nsecond\n' });
  await f.emit(state([part]));
  const preview = f.card(0).locator('.tool-live-preview');
  assert.equal(await preview.textContent(), 'first\nsecond');
  assert.equal(await preview.isVisible(), true);
  assert.equal(await f.card(0).locator('.tool-output').textContent(), '');
  part = { ...part, output: 'x'.repeat(20000) }; await f.emit(state([part]));
  assert.equal((await preview.textContent()).length, 400);
  await f.toggle(0); assert.equal(await preview.isVisible(), false);
  assert.equal((await f.card(0).locator('.tool-output').textContent()).length, 20000);
  await f.toggle(0);
  part = { ...part, status: 'failed', output: 'connection failed' }; await f.emit(state([part]));
  assert.equal(await preview.textContent(), 'connection failed');
  assert.equal(await f.card(0).evaluate(node => node.open), false);
  part = { ...part, status: 'completed' }; await f.emit(state([part]));
  assert.equal(await preview.isVisible(), false);
  assert.equal(await preview.textContent(), '');
});

test('process cards stream while collapsed and preserve manual expansion and reading position', async t => {
  const f = await fixture(t);
  for (const name of ['run_local_shell_command', 'run_linux_ssh_command', 'run_python', 'manage_python_environment']) {
    let part = tool(name, { name, args: '{}', status: 'running', endedAt: undefined, output: '' });
    await f.emit(state([part]));
    assert.equal(await f.card(0).evaluate(node => node.open), false);
    assert.equal(await f.card(0).locator('.tool-output').isVisible(), false);
    part.output = 'first\n'; await f.emit(state([part]));
    assert.equal(await f.card(0).evaluate(node => node.open), false);
    assert.equal(await f.card(0).locator('.tool-output').textContent(), '', 'folded output is cached without hidden DOM updates');
    await f.toggle(0);
    assert(await f.card(0).locator('.tool-output').isVisible());
    assert.equal(await f.card(0).locator('.tool-output').textContent(), 'first\n');
    await f.card(0).locator('.tool-output').evaluate(node => { window.liveOutputNode = node.firstChild; });
    part.output += 'second\n'; await f.emit(state([part]));
    assert.equal(await f.card(0).locator('.tool-output').textContent(), 'first\nsecond\n');
    assert(await f.card(0).locator('.tool-output').evaluate(node => node.firstChild === window.liveOutputNode));
    part.output += 'line\n'.repeat(100); await f.emit(state([part]));
    const output = f.card(0).locator('.tool-output');
    assert(await output.evaluate(node => node.scrollHeight - node.clientHeight - node.scrollTop <= 3));
    await output.evaluate(node => { node.scrollTop = 0; });
    part.output += 'while reading\n'; await f.emit(state([part]));
    assert.equal(await output.evaluate(node => node.scrollTop), 0);
    await f.toggle(0);
    part.output += 'while collapsed\n'; await f.emit(state([part]));
    assert.equal(await f.card(0).evaluate(node => node.open), false);
    assert.doesNotMatch(await output.textContent(), /while collapsed/);
    await f.toggle(0);
    assert.match(await output.textContent(), /while collapsed/);
    await output.evaluate(node => { node.scrollTop = node.scrollHeight; });
    part = { ...part, output: 'newest\n'.repeat(200), outputTail: true, truncated: true };
    await f.emit(state([part]));
    assert(await output.evaluate(node => node.scrollHeight - node.clientHeight - node.scrollTop <= 3));
    assert.match(await f.card(0).locator('.tool-truncation').textContent(), /最新输出/);
    part = { ...part, status: 'completed', endedAt: Date.now() }; await f.emit(state([part]));
    assert.equal(await f.card(0).getAttribute('data-streaming'), 'false');
    assert.equal(await output.textContent(), part.output);
  }
});

for (const name of ['run_local_shell_command', 'read_workspace_file', 'search_workspace', 'mcp_large_result']) test(`a thousand folded ${name} updates leave hidden DOM untouched and opening renders the latest result`, async t => {
  const f = await fixture(t);
  const result = await f.page.evaluate(name => {
    const target = document.createElement('div'); target.id = 'folded-burst'; document.body.append(target);
    const part = { id: 'burst', type: 'tool', name, args: '{}', status: 'running', output: '' };
    const draw = () => UBOVMMessage.update(target, '', { role: 'assistant', parts: [part] });
    draw();
    const observer = new MutationObserver(() => {});
    observer.observe(target.querySelector('.tool-card-body'), { subtree: true, childList: true, characterData: true, attributes: true });
    for (let i = 0; i < 1000; i++) { part.output = 'x'.repeat(11900) + '\nlatest-' + i; draw(); }
    part.status = 'completed'; draw();
    const mutations = observer.takeRecords().length; observer.disconnect();
    const foldedText = target.querySelector('.tool-output').textContent;
    target.querySelector('.tool-card').open = true;
    return { mutations, foldedText };
  }, name);
  assert.deepEqual(result, { mutations: 0, foldedText: '' });
  await f.frames();
  assert.match(await f.page.locator('#folded-burst .tool-output').textContent(), /latest-999$/);
  assert.equal(await f.page.locator('#folded-burst .tool-card').getAttribute('data-status'), 'completed');
  await f.page.evaluate(() => { const target = document.querySelector('#folded-burst'); UBOVMMessage.release(target); target.remove(); });
});

test('open log updates skip unchanged large parameters and toolbar attributes', async t => {
  const f = await fixture(t);
  const result = await f.page.evaluate(async () => {
    const target = document.createElement('div'); document.body.append(target);
    const part = { id: 'large-args', type: 'tool', name: 'run_local_shell_command', status: 'running', args: JSON.stringify({ command: 'x'.repeat(64000) }), output: 'line\n' };
    const draw = () => UBOVMMessage.update(target, '', { parts: [part] });
    draw(); target.querySelector('.tool-card').open = true; draw();
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const input = target.querySelector('.tool-parameters');
    const descriptor = Object.getOwnPropertyDescriptor(Node.prototype, 'textContent');
    let reads = 0;
    Object.defineProperty(input, 'textContent', { configurable: true, get() { reads++; return descriptor.get.call(this); }, set(value) { descriptor.set.call(this, value); } });
    const observer = new MutationObserver(() => {});
    for (const element of target.querySelectorAll('.tool-result-toolbar button, .tool-truncation')) observer.observe(element, { attributes: true });
    for (let i = 0; i < 50; i++) { part.output += 'next line\n'; draw(); }
    const mutations = observer.takeRecords().length; observer.disconnect();
    const stableReads = reads;
    part.args = '{"command":"changed"}'; draw();
    const updated = input.textContent;
    UBOVMMessage.release(target); target.remove();
    return { stableReads, mutations, updated };
  });
  assert.deepEqual(result, { stableReads: 0, mutations: 0, updated: '{"command":"changed"}' });
});

test('expanded logs defer hidden live previews and folding reveals the latest output', async t => {
  const f = await fixture(t);
  const result = await f.page.evaluate(async () => {
    const target = document.createElement('div'); document.body.append(target);
    let part = { id: 'defer-preview', type: 'tool', name: 'run_linux_ssh_command', args: '{}', status: 'running', output: 'initial' };
    const draw = () => UBOVMMessage.update(target, '', { parts: [part] });
    draw(); const card = target.querySelector('.tool-card'), preview = target.querySelector('.tool-live-preview');
    card.open = true; await new Promise(resolve => setTimeout(resolve, 0));
    const observer = new MutationObserver(() => {});
    observer.observe(preview, { childList: true, characterData: true, attributes: true, subtree: true });
    for (let i = 0; i < 100; i++) { part = { ...part, output: 'update ' + i }; draw(); }
    const mutations = observer.takeRecords().length;
    card.open = false; await new Promise(resolve => setTimeout(resolve, 0));
    const latest = preview.textContent;
    card.open = true; await new Promise(resolve => setTimeout(resolve, 0));
    part = { ...part, status: 'completed' }; draw();
    card.open = false; await new Promise(resolve => setTimeout(resolve, 0));
    const cleared = preview.hidden && !preview.textContent;
    observer.disconnect(); UBOVMMessage.release(target); target.remove();
    return { mutations, latest, cleared };
  });
  assert.deepEqual(result, { mutations: 0, latest: 'update 99', cleared: true });
});

test('return to latest resumes streamed log following without reopening the card', async t => {
  const f = await fixture(t);
  let part = tool('follow-log', { name: 'run_linux_ssh_command', status: 'running', output: 'history\n'.repeat(150) });
  await f.emit(state([part])); await f.toggle(0);
  const output = f.card(0).locator('.tool-output');
  await output.evaluate(node => { node.scrollTop = 35; });
  part = { ...part, output: part.output + 'new output\n'.repeat(20) };
  await f.emit(state([part]));
  assert.equal(await output.evaluate(node => node.scrollTop), 35, 'incoming output must preserve the reading position');
  await f.card(0).getByRole('button', { name: '回到最新', exact: true }).click();
  assert(await output.evaluate(node => node.scrollHeight - node.clientHeight - node.scrollTop <= 3));
  part = { ...part, output: part.output + 'followed output\n'.repeat(20) };
  await f.emit(state([part]));
  assert(await output.evaluate(node => node.scrollHeight - node.clientHeight - node.scrollTop <= 3));
  assert.equal(await f.card(0).evaluate(node => node.open), true);
  const detached = await f.card(0).getByRole('button', { name: '回到最新', exact: true }).elementHandle();
  await output.evaluate(node => { node.scrollTop = 35; window.oldLog = node; });
  await f.emit(state([]));
  await f.page.evaluate(() => {
    window.lateScrollWrites = 0;
    Object.defineProperty(window.oldLog, 'scrollTop', { set() { window.lateScrollWrites++; } });
  });
  await detached.evaluate(button => button.click());
  assert.equal(await f.page.evaluate(() => window.lateScrollWrites), 0, 'released detached logs stay inactive');
});

test('tool output counts survive append and replacement, and identical payload retries a failed card', async t => {
  const f = await fixture(t);
  const result = await f.page.evaluate(() => {
    const body = document.createElement('div'); document.body.append(body);
    const part = { id: 'retry', type: 'tool', name: 'read_workspace_file', args: '{}', status: 'running', output: 'one' };
    const draw = () => UBOVMMessage.update(body, '', { role: 'assistant', parts: [part], onCopy: () => false });
    draw(); body.querySelector('.tool-card').open = true; draw();
    const output = body.querySelector('.tool-output'), counts = [];
    for (const text of ['one\ntwo\n', 'one\ntwo\nthree', 'replacement', '', '\n']) {
      part.output = text; draw(); counts.push(body.querySelector('.tool-result-info').textContent);
    }
    const input = body.querySelector('.tool-parameters');
    Object.defineProperty(input, 'textContent', { configurable: true, get() { return '{}'; }, set() { throw new Error('transient DOM failure'); } });
    part.args = '{"path":"recovered.js"}'; part.output = 'recovered';
    let failed = false; try { draw(); } catch { failed = true; }
    delete input.textContent; draw();
    body.id = 'retry-fixture'; body.querySelector('details').open = true;
    return { counts, failed, retained: output === body.querySelector('.tool-output'), output: output.textContent, args: input.textContent };
  });
  assert.deepEqual(result, { counts: ['接收中 · 2 行', '接收中 · 3 行', '接收中 · 1 行', '接收中', '接收中 · 1 行'], failed: true, retained: true, output: 'recovered', args: '{"path":"recovered.js"}' });
  await f.page.locator('#retry-fixture').getByRole('button', { name: '复制输出' }).click();
  await f.page.locator('#retry-fixture').getByRole('button', { name: '复制失败' }).waitFor();
});

test('thinking and summary retry identical content after formatting errors and contain toggle failures', async t => {
  const f = await fixture(t);
  for (const type of ['thinking', 'summary']) {
    await f.page.evaluate(type => {
      const body = document.createElement('div'); document.body.append(body); body.id = 'thought-retry';
      const part = { id: 'retry', type, status: 'completed', text: '**before**' };
      window.drawRetry = () => UBOVMMessage.update(body, '', { role: 'assistant', parts: [part] });
      drawRetry(); body.querySelector('details').open = true;
      window.retryPart = part;
    }, type);
    await f.frames();
    assert(await f.page.evaluate(() => {
      const original = UBOVMMarkdown; window.originalMarkdown = original;
      window.UBOVMMarkdown = { update() { throw new Error('transient formatter failure'); } };
      retryPart.text = '**recovered**'; let failed = false;
      try { drawRetry(); } catch { failed = true; }
      window.UBOVMMarkdown = original; drawRetry();
      return failed && document.querySelector('#thought-retry strong').textContent === 'recovered';
    }));
    await f.page.locator('#thought-retry > details > summary').click(); await f.frames();
    await f.page.evaluate(() => { window.UBOVMMarkdown = { update() { throw new Error('toggle failure'); } }; });
    await f.page.locator('#thought-retry > details > summary').click(); await f.frames();
    assert.equal(await f.page.locator('#thought-retry .render-plain-fallback').textContent(), '**recovered**');
    await f.page.evaluate(() => { window.UBOVMMarkdown = originalMarkdown; drawRetry(); });
    assert.equal(await f.page.locator('#thought-retry strong').textContent(), 'recovered');
    await f.page.evaluate(() => document.querySelector('#thought-retry').remove());
  }
});

test('history insertion and trimming keep message identity and expanded tool content', async t => {
  const f = await fixture(t);
  const first = { id: 'first', role: 'assistant', text: 'First', parts: [tool('first-tool')] };
  const kept = { role: 'assistant', text: 'Kept', parts: [tool('kept-tool')] };
  const publish = messages => f.emit(state([], { busy: false, execution: { status: 'idle' }, messages }));
  await publish([first, kept]); await f.toggle(1);
  await f.page.evaluate(() => {
    window.keptTool = document.querySelectorAll('#messages .tool-card')[1]; window.keptArticle = keptTool.closest('article');
    const range = document.createRange(); range.selectNodeContents(keptTool.querySelector('.tool-output'));
    getSelection().removeAllRanges(); getSelection().addRange(range); window.keptSelection = getSelection().toString();
  });
  await publish([{ id: 'older', role: 'user', text: 'Older history' }, first, kept]);
  assert(await f.page.evaluate(() => keptTool === document.querySelectorAll('#messages .tool-card')[1] && keptTool.open && keptArticle === keptTool.closest('article')));
  await publish([kept]);
  assert(await f.page.evaluate(() => keptTool === document.querySelector('#messages .tool-card') && keptTool.open && keptArticle === document.querySelector('#messages article')));
  assert(await f.page.evaluate(() => keptSelection.length > 0 && getSelection().toString() === keptSelection));
  await publish([{ ...kept, parts: [tool('kept-tool', { output: 'Refreshed history' })] }]);
  assert.match(await f.card(0).textContent(), /Refreshed history/);
});

test('stream promotion reconciles its position alongside retained historical messages', async t => {
  const f = await fixture(t);
  const old = { id: 'old', role: 'assistant', text: 'Old answer' };
  const later = { id: 'later', role: 'user', text: 'Later request' };
  const live = text('live', 'Restored answer');
  await f.emit(state([live], { messages: [user, old, later] }));
  await f.page.evaluate(() => { window.streamArticle = document.querySelector('#messages .streaming-message'); });
  await f.emit(state([], { busy: false, execution: { status: 'idle' }, messages: [user, { id: 'saved', role: 'assistant', text: live.text, parts: [live] }, later] }));
  assert.deepEqual((await f.page.locator('#messages article .message-text').allTextContents()).map(value => value.trim()), [user.text, live.text, later.text]);
  assert(await f.page.evaluate(() => streamArticle === document.querySelectorAll('#messages article')[1]));
});

test('an identical older answer does not consume the new streaming message during promotion', async t => {
  const f = await fixture(t), old = { role: 'assistant', text: 'Repeated answer' };
  await f.emit(state([], { messages: [old], execution: { status: 'running', streamText: old.text, parts: [] } }));
  await f.page.evaluate(() => {
    window.oldArticle = document.querySelector('#messages article');
    window.newArticle = document.querySelector('#messages .streaming-message');
  });
  await f.emit(state([], { busy: false, execution: { status: 'idle' }, messages: [old, { ...old }] }));
  assert(await f.page.evaluate(() => {
    const articles = document.querySelectorAll('#messages article');
    return articles.length === 2 && articles[0] === oldArticle && articles[1] === newArticle;
  }));
});

test('legacy history with only auxiliary parts retains its saved answer without duplicating modern text', async t => {
  const f = await fixture(t);
  const answer = '历史缓存中的 **完整回复**';
  const publish = parts => f.emit(state([], { busy: false, execution: { status: 'idle', parts: [] },
    messages: [user, { role: 'assistant', text: answer, parts }] }));
  await publish([read, text('empty', '')]);
  assert.equal(await f.page.locator('#messages .response-text strong').textContent(), '完整回复');
  assert.equal(await f.page.locator('#messages .tool-card').count(), 1);
  await publish([read, text('answer', answer)]);
  assert.equal(await f.page.locator('#messages .response-text strong').count(), 1);
  await f.emit(state([], { conversation: { id: 'other' }, messages: [], busy: false }));
  await publish([read]);
  assert.equal(await f.page.locator('#messages .response-text strong').textContent(), '完整回复');
});

test('incomplete historical timelines retain their final body and reconcile later recovered parts', async t => {
  const f = await fixture(t), answer = 'Final **saved answer**';
  const publish = parts => f.emit(state([], { busy: false, execution: { status: 'idle' },
    messages: [{ id: 'cached-answer', role: 'assistant', text: answer, parts }] }));
  await publish([intro, read]);
  assert.equal(await f.page.locator('#messages .response-text strong').allTextContents().then(values => values.includes('saved answer')), true);
  await f.toggle(0);
  await f.page.evaluate(() => { window.cachedTool = document.querySelector('#messages .tool-card'); });
  await publish([intro, read, text('final', answer)]);
  assert.equal(await f.page.locator('#messages .response-text strong').allTextContents().then(values => values.filter(value => value === 'saved answer').length), 1);
  assert(await f.page.evaluate(() => cachedTool === document.querySelector('#messages .tool-card') && cachedTool.open));
  await publish([intro, read, text('final', 'Final **saved')]);
  assert.equal(await f.page.locator('#messages .response-text').last().textContent().then(value => value.trim()), 'Final saved answer');
  assert.equal(await f.page.locator('#messages .response-text').count(), 2);
  await publish([text('first', 'Final '), text('second', '**saved answer**')]);
  assert.equal(await f.page.locator('#messages .response-text').count(), 2, 'a body split across text parts must not be appended again');
  await f.emit(state([], { busy: false, execution: { status: 'idle' }, messages: [{ role: 'assistant',
    text: 'Final\n\n[回复超出显示上限；完整输出保存在本地执行记录中。]', parts: [text('full', answer)] }] }));
  assert.equal(await f.page.locator('#messages .response-text').count(), 1, 'a clipped body must not duplicate a more complete timeline');
});

test('tool expansion keeps the trigger stable and reverses rapid toggles with keyboard access', async t => {
  const f = await fixture(t);
  await f.emit(state([read]));
  const card = f.card(0), summary = card.locator(':scope > summary');
  const measure = () => summary.evaluate(element => {
    const bounds = element.getBoundingClientRect();
    const path = element.querySelector('.tool-path').getBoundingClientRect();
    return { height: bounds.height, pathLeft: path.left, pathTop: path.top - bounds.top };
  });
  const before = await measure();
  await summary.click();
  assert.deepEqual(await measure(), before, 'opening must not reflow the title or reveal new metadata');
  await summary.evaluate(element => { element.click(); element.click(); element.click(); element.click(); });
  assert.equal(await card.evaluate(element => element.open), true);
  await f.page.waitForTimeout(220);
  assert(await card.locator('.tool-output').isVisible());
  assert.equal(await card.locator('.tool-output').textContent(), read.output);
  await summary.focus();
  await summary.press('Enter');
  assert.equal(await card.evaluate(element => element.open), false);
  await summary.press('Enter');
  assert.equal(await card.evaluate(element => element.open), true);
  assert.deepEqual(await measure(), before);
  await f.page.screenshot({ path: screenshotDirectory + '/tool-card-interaction.png' });
});

test('long tool batches fold completed history while preserving active, failed and open logs', async t => {
  const f = await fixture(t);
  const calls = Array.from({ length: 12 }, (_, index) => tool('batch-' + index, {
    name: 'run_local_shell_command', args: JSON.stringify({ command: 'npm run check:' + index }),
    output: 'check ' + index + '\npassed',
    ...(index === 1 ? { status: 'running', endedAt: undefined } : index === 2 ? { status: 'failed' } : {})
  }));
  await f.emit(state(calls.slice(0, 3)));
  await f.toggle(0);
  await f.emit(state(calls));
  const batch = f.page.locator('#messages .tool-group'), toggle = batch.locator('.tool-group-toggle');
  assert.equal(await batch.locator('.tool-card:visible').count(), 6);
  assert(await f.card(0).locator('.tool-output').isVisible());
  assert(await f.card(1).isVisible());
  assert(await f.card(2).isVisible());
  assert.match(await toggle.textContent(), /12 个工具调用 · 1 个运行中 · 1 个失败 · 展开 6 条历史/);
  await toggle.click();
  assert.equal(await batch.locator('.tool-card:visible').count(), 12);
  await f.toggle(4);
  await f.page.evaluate(() => { window.batchLog = document.querySelectorAll('#messages .tool-output')[4]; });
  const progressed = calls.map(part => part.id === 'batch-1' ? { ...part, output: part.output + '\nprogress' } : part);
  await f.emit(state(progressed));
  assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
  await toggle.click();
  assert(await f.card(4).locator('.tool-output').isVisible());
  assert(await f.page.evaluate(() => batchLog === document.querySelectorAll('#messages .tool-output')[4]));
  await f.page.setViewportSize({ width: 320, height: 800 });
  await f.page.evaluate(() => document.body.classList.add('vscode-dark'));
  await f.frames();
  assert(await f.page.evaluate(() => document.documentElement.scrollWidth <= 320));
  await f.page.screenshot({ path: screenshotDirectory + '/tool-batch-narrow.png' });
  await f.page.setViewportSize({ width: 1000, height: 1000 });
  await f.page.evaluate(() => document.body.classList.remove('vscode-dark'));
  await f.page.screenshot({ path: screenshotDirectory + '/tool-batch.png' });
});

test('tool groups remain inline with prose and retain expanded nodes through streaming and history promotion', async t => {
  const f = await fixture(t);
  await f.emit(state([intro, read, listing, explanation, command]));
  const timeline = f.page.locator('#messages .message-timeline');
  assert.deepEqual(await timeline.locator(':scope > *').evaluateAll(nodes => nodes.map(node => node.classList.contains('tool-group') ? 'tools' : 'text')), ['text', 'tools', 'text', 'tools']);
  assert.deepEqual(await f.page.locator('#messages .tool-group').evaluateAll(nodes => nodes.map(node => node.querySelectorAll(':scope > .tool-card').length)), [2, 1]);
  assert.equal(await f.page.locator('#messages .tool-kind-icon svg, #messages svg.tool-kind-icon').count(), 3);
  assert.equal(await f.page.locator('#assist-execution').isVisible(), false, 'inline calls must not be repeated in the activity footer');
  await f.toggle(0);
  await f.card(0).locator('.tool-arguments > summary').click();
  await f.page.evaluate(() => {
    window.savedTool = document.querySelector('#messages .tool-card');
    window.savedToolGroup = savedTool.parentElement;
    window.savedArguments = savedTool.querySelector('.tool-arguments');
    window.savedArticle = savedTool.closest('article');
    window.savedProse = document.querySelector('#messages .response-text p').firstChild;
    const range = document.createRange(); range.setStart(savedProse, 0); range.setEnd(savedProse, 5);
    getSelection().removeAllRanges(); getSelection().addRange(range);
  });
  const extra = tool('second-read', { args: '{"path":"src/harness/reason/index.mjs"}', output: 'export function createReason() {}' });
  const progressed = { ...command, output: command.output + '\nok 3 - cards retain their state' };
  const parts = [intro, read, listing, extra, explanation, progressed];
  await f.emit(state(parts));
  assert.deepEqual(await f.page.evaluate(() => ({
    tool: savedTool === document.querySelector('#messages .tool-card'), group: savedToolGroup === savedTool.parentElement,
    arguments: savedArguments === savedTool.querySelector('.tool-arguments'), open: savedTool.open && savedArguments.open,
    prose: savedProse === document.querySelector('#messages .response-text p').firstChild, selection: getSelection().toString()
  })), { tool: true, group: true, arguments: true, open: true, prose: true, selection: '我会先检查' });
  assert.deepEqual(await f.page.locator('#messages .tool-group').evaluateAll(nodes => nodes.map(node => node.querySelectorAll(':scope > .tool-card').length)), [3, 1]);
  const finalParts = [...parts.slice(0, -1), { ...progressed, status: 'completed', endedAt: start + 2500 }, text('answer', '检查通过，流式记录已经保留。')];
  await f.emit(state(finalParts, { busy: false, messages: [user, { role: 'assistant', text: '检查通过，流式记录已经保留。', parts: finalParts }], execution: { busy: false, status: 'completed', parts: finalParts } }));
  assert.equal(await f.page.locator('#messages article.assistant').count(), 1);
  assert.equal(await f.page.locator('#messages article[data-streaming]').count(), 0);
  assert(await f.page.evaluate(() => savedArticle === document.querySelector('#messages article.assistant') && savedTool === document.querySelector('#messages .tool-card') && savedTool.open && savedArguments.open));
  assert.equal(await f.card(3).locator('.tool-time').textContent(), '2.5s');
});

test('running, completed, failed and interrupted calls expose real state without automatic expansion', async t => {
  const f = await fixture(t);
  let parts = [tool('changing', { status: 'running', endedAt: undefined, output: '' }), tool('done'), tool('stopped', { status: 'interrupted', output: '', endedAt: start + 800 })];
  await f.emit(state(parts));
  assert.deepEqual(await f.page.locator('#messages .tool-card').evaluateAll(nodes => nodes.map(node => node.dataset.status)), ['running', 'completed', 'interrupted']);
  const spinner = await f.card(0).evaluate(card => {
    const icon = card.querySelector('.tool-kind-icon');
    const mark = card.querySelector('.tool-indicator');
    return {
      dx: Math.abs(icon.clientWidth / 2 - (mark.offsetLeft + mark.offsetWidth / 2)),
      dy: Math.abs(icon.clientHeight / 2 - (mark.offsetTop + mark.offsetHeight / 2)),
      icon: icon.clientWidth, mark: mark.offsetWidth,
    };
  });
  assert.ok(spinner.dx < 1 && spinner.dy < 1, 'running spinner stays concentric with the kind icon: ' + JSON.stringify(spinner));
  assert.ok(spinner.mark >= 11 && spinner.mark <= 13 && spinner.mark < spinner.icon);
  assert.equal(await f.card(0).evaluate(node => node.open), false);
  assert.equal(await f.card(1).evaluate(node => node.open), false);
  assert.equal(await f.card(2).locator('.tool-status').textContent(), '已停止');
  parts = [{ ...parts[0], status: 'failed', endedAt: start + 700, output: 'ENOENT: file not found' }, ...parts.slice(1)];
  await f.emit(state(parts));
  assert.equal(await f.card(0).getAttribute('data-status'), 'failed');
  assert.equal(await f.card(0).evaluate(node => node.open), false, 'failure must not automatically expand the card');
  assert.equal(await f.card(0).locator('.tool-output').isVisible(), false);
  await f.toggle(0);
  assert.equal(await f.card(0).locator('.tool-output').isVisible(), true, 'failure details can still be expanded manually');
  await f.emit(state(parts));
  assert.equal(await f.card(0).evaluate(node => node.open), true, 'updates preserve manual expansion');
  await f.toggle(0);
  await f.card(0).locator(':scope > summary').focus();
  await f.emit(state([{ ...parts[0], output: parts[0].output + '\nThe path is unavailable.' }, ...parts.slice(1)]));
  assert.equal(await f.card(0).evaluate(node => node.open), false, 'a later failure update respects a manually collapsed card');
  assert.equal(await f.card(0).locator(':scope > summary').evaluate(node => document.activeElement === node), true, 'stream updates retain keyboard focus');
  await f.card(2).locator(':scope > summary').focus();
  await f.page.keyboard.press('Enter');
  await f.frames(); // Native toggle delivers the deferred detail render asynchronously.
  assert.match(await f.card(2).locator('.tool-output').textContent(), /停止/);
  assert.equal(await f.card(2).locator('.tool-output').isVisible(), true, 'native summaries support keyboard expansion');
  await f.page.keyboard.press('Space');
  assert.equal(await f.card(2).evaluate(node => node.open), false, 'Space collapses the focused summary');
});

test('streamed output appends preserve its text selection and only follow a reader already at the bottom', async t => {
  const f = await fixture(t);
  let streamed = { ...command, output: Array.from({ length: 80 }, (_, index) => 'line ' + index + ': output content').join('\n') };
  await f.emit(state([streamed]));
  await f.toggle(0);
  const output = f.card(0).locator('.tool-output');
  assert(await output.evaluate(node => node.scrollHeight > node.clientHeight), 'large output must have its own scroll area');
  await output.evaluate(node => {
    window.outputNode = node; window.outputText = node.firstChild;
    node.scrollTop = 40; window.outputScroll = node.scrollTop;
    const range = document.createRange(); range.setStart(outputText, 0); range.setEnd(outputText, 6);
    getSelection().removeAllRanges(); getSelection().addRange(range);
  });
  streamed = { ...streamed, output: streamed.output + '\n' + 'new line: more output\n'.repeat(20) };
  await f.emit(state([streamed]));
  assert.deepEqual(await output.evaluate(node => ({ sameNode: node === outputNode, sameText: node.firstChild === outputText, selected: getSelection().toString(), scroll: node.scrollTop })), {
    sameNode: true, sameText: true, selected: 'line 0', scroll: 40
  });
  await output.evaluate(node => { getSelection().removeAllRanges(); node.scrollTop = node.scrollHeight; node.dispatchEvent(new Event('scroll')); });
  streamed = { ...streamed, output: streamed.output + 'final progress\n'.repeat(20) };
  await f.emit(state([streamed]));
  assert(await output.evaluate(node => Math.abs(node.scrollHeight - node.clientHeight - node.scrollTop) <= 2), 'a reader at the bottom follows new output');
  const final = { ...streamed, status: 'completed', endedAt: start + 1000 };
  await f.emit(state([final], { busy: false, execution: { busy: false, status: 'completed', parts: [final] }, messages: [user, { role: 'assistant', text: '', parts: [final] }] }));
  assert.equal(await output.evaluate(node => node.firstChild === outputText), true);
});

test('web_search results render as readable links instead of raw JSON dumps', async t => {
  const f = await fixture(t);
  const payload = {
    query: 'CVE-2024-1234 advisory',
    provider: 'tavily',
    status: 'ok',
    returned: 2,
    results: [
      { title: '<script>alert(1)</script> Advisory', url: 'https://example.com/advisory', snippet: 'Official write-up for CVE-2024-1234' },
      { title: 'Research notes', url: 'https://docs.example.org/notes', snippet: 'Secondary analysis' },
      { title: 'Bad scheme', url: 'javascript:alert(1)', snippet: 'should be dropped' },
    ],
    fallback_used: false,
    ranking: 'strict',
    note: 'Snippets are untrusted',
  };
  const search = tool('web-search', {
    name: 'web_search',
    args: JSON.stringify({ query: 'CVE-2024-1234 advisory', limit: 8 }),
    output: JSON.stringify(payload),
  });
  const empty = tool('web-empty', {
    name: 'web_search',
    args: JSON.stringify({ query: 'missing topic' }),
    output: JSON.stringify({
      query: 'missing topic', provider: 'none', status: 'unavailable', returned: 0, results: [],
      message: 'All search providers were unavailable.', fallback_used: true, note: 'n/a',
    }),
  });
  await f.emit(state([search, empty]));
  assert.match(await f.card(0).locator('.tool-path').textContent(), /CVE-2024-1234 advisory · 2 条结果/);
  await f.toggle(0);
  const card = f.card(0);
  assert.equal(await card.locator('.tool-search').isVisible(), true);
  assert.equal(await card.locator('.tool-output').isVisible(), false);
  assert.equal(await card.locator('.tool-search-list .tool-search-item').count(), 2);
  assert.equal(await card.locator('.tool-search-link').first().textContent(), '<script>alert(1)</script> Advisory');
  assert.equal(await card.locator('.tool-search script').count(), 0);
  assert.equal(await card.locator('.tool-search-host').first().textContent(), 'example.com');
  assert.match(await card.locator('.tool-result-info').textContent(), /2 条结果 · tavily/);
  await card.locator('.tool-search-link').first().click();
  const opened = await f.ack('openMessageLink');
  assert.equal(opened.href, 'https://example.com/advisory');
  await card.getByRole('button', { name: '复制输出', exact: true }).click();
  assert.equal((await f.ack('copyText')).text, search.output);
  await f.toggle(1);
  assert.match(await f.card(1).locator('.tool-search-status').textContent(), /不可用/);
  assert.match(await f.card(1).locator('.tool-search-empty').textContent(), /All search providers were unavailable/);
  assert.equal(await f.page.evaluate(() => document.querySelectorAll('#messages .tool-search-link[href^="javascript:"]').length), 0);
});

test('tool actions await copy receipts, open explicit file paths and isolate HTML preview from the chat', async t => {
  const f = await fixture(t);
  const rawHtml = '<!doctype html><html><head><style>body{background:#123456;color:#fff}h1{font-size:23px}</style></head><body><h1>工具预览</h1><script>parent.previewExecuted=true</script><img src="https://blocked-preview.invalid/image.png" onerror="parent.previewExecuted=true"></body></html>';
  const htmlTool = tool('html', { name: 'mcp_fixture_render', args: '{}', output: rawHtml });
  const accidentalPath = tool('terminal-path', { ...command, id: 'terminal-path', args: '{"command":"echo safe","path":"/etc/passwd"}', status: 'completed', endedAt: start + 1000 });
  const malformedFile = tool('partial-file', { args: '{"path":"incomplete', output: 'partial arguments' });
  const secondRoot = tool('second-root', { args: '{"path":"src/special%file#draft?.mjs","root":1}', output: 'file from the second workspace' });
  await f.emit(state([read, accidentalPath, malformedFile, htmlTool, secondRoot]));
  await f.page.locator('#messages .tool-group-toggle').click();
  await f.page.locator('#review-code-changes').click();
  const review = (await f.sent('reviewCodeChanges')).at(-1);
  assert(review?.sessionId, 'diff review must carry the originating conversation');
  await f.page.locator('#validate-code-changes').click();
  assert.equal((await f.sent('validateCodeChanges')).at(-1).sessionId, review.sessionId);
  await f.toggle(0);
  const copy = f.card(0).getByRole('button', { name: '复制输出', exact: true });
  await copy.click();
  assert.equal(await copy.isDisabled(), true, 'copy remains pending until the host responds');
  assert.equal((await f.ack('copyText')).text, read.output);
  assert.equal(await f.card(0).getByRole('button', { name: '已复制', exact: true }).count(), 1);
  await f.card(0).getByRole('button', { name: '打开文件', exact: true }).click();
  const openedFile = await f.ack('openMessageLink');
  assert.equal(openedFile.href, 'src/harness/worker/index.mjs');
  assert.equal(openedFile.rootIndex, 0);
  assert.equal(f.page.url(), 'http://tool-cards.test/');
  await f.toggle(1);
  assert.equal(await f.card(1).getByRole('button', { name: '打开文件', exact: true }).count(), 0, 'a command containing a path never becomes a file action');
  assert.equal((await f.sent('runCommand')).length, 0);
  await f.toggle(2);
  assert.equal(await f.card(2).getByRole('button', { name: '打开文件', exact: true }).count(), 0, 'truncated JSON must not invent a file action');
  await f.toggle(3);
  assert.equal(await f.card(3).locator('.tool-output').textContent(), rawHtml);
  assert.equal(await f.card(3).locator('.tool-output img, .tool-output script').count(), 0);
  await f.card(3).getByRole('button', { name: '预览 HTML', exact: true }).click();
  const iframe = f.page.locator('.html-preview iframe');
  await f.page.frameLocator('.html-preview iframe').getByRole('heading', { name: '工具预览' }).waitFor();
  assert.equal(await iframe.getAttribute('sandbox'), '');
  assert.equal(await f.page.frameLocator('.html-preview iframe').locator('body').evaluate(node => getComputedStyle(node).backgroundColor), 'rgb(18, 52, 86)');
  assert.equal(await f.page.evaluate(() => window.previewExecuted), undefined);
  await f.page.keyboard.press('Escape');
  assert.equal(await f.page.locator('.html-preview').count(), 0);
  assert.equal(await f.page.evaluate(() => document.activeElement.textContent), '预览 HTML');
  await f.card(3).getByRole('button', { name: '复制输出', exact: true }).click();
  assert.equal((await f.ack('copyText', false)).text, rawHtml);
  assert.equal(await f.card(3).getByRole('button', { name: '复制失败', exact: true }).count(), 1);
  await f.toggle(4);
  await f.card(4).getByRole('button', { name: '打开文件', exact: true }).click();
  const rootedFile = await f.ack('openMessageLink');
  assert.equal(rootedFile.rootIndex, 1, 'file actions retain the selected workspace root');
  assert.equal(rootedFile.href, 'src/special%25file%23draft%3F.mjs', 'path punctuation remains a literal filename at the host boundary');
});

test('embedded cards stay compact and readable at 320px, including dark mode and reduced motion', async t => {
  const f = await fixture(t, { reducedMotion: 'reduce' });
  await f.emit(state([intro, read, listing, explanation, command]));
  await f.toggle(2);
  await f.page.locator('#conversation').evaluate(node => { node.scrollTop = 0; });
  await f.page.screenshot({ path: screenshotDirectory + '/embedded-tool-cards.png' });
  await f.page.setViewportSize({ width: 320, height: 800 });
  await f.page.evaluate(() => {
    document.body.classList.add('vscode-dark');
    const style = document.createElement('style'); style.nonce = 'tool-cards-test';
    style.textContent = ':root{--vscode-foreground:#ddd;--vscode-descriptionForeground:#a5a5a5;--vscode-editor-background:#181818;--vscode-panel-border:#363636;--vscode-button-background:#52715f}';
    document.head.append(style);
  });
  const narrowRead = { ...read, name: 'mcp_project_with_a_very_long_namespace_inspect_worker_configuration', args: '{"path":"src/harness/very-long-nested-directory-without-spaces/worker-with-an-extremely-long-file-name.mjs"}' };
  await f.emit(state([intro, narrowRead, listing, explanation, command]));
  await f.frames();
  assert(await f.page.evaluate(() => document.documentElement.scrollWidth <= 320 && document.body.scrollWidth <= 320 && document.querySelector('#messages').scrollWidth <= 320), 'long names and paths cannot widen the page');
  assert(await f.page.locator('#messages .tool-card-summary').evaluateAll(nodes => nodes.every(node => node.getBoundingClientRect().width <= 320 && node.getBoundingClientRect().height < 64)), 'tool summaries remain compact at narrow widths');
  assert.equal(await f.page.locator('#messages .tool-card[data-status="running"] .tool-indicator').evaluate(node => getComputedStyle(node).animationName), 'none');
  assert(await f.card(2).locator('.tool-output').isVisible());
  await f.page.locator('#conversation').evaluate(node => { node.scrollTop = 0; });
  await f.page.screenshot({ path: screenshotDirectory + '/embedded-tool-cards-narrow-dark.png' });
});

test('approval cards preview commands, retry failures and disappear after a completed decision', async t => {
  const f = await fixture(t);
  const record = { id: 'approval-one', workerId: 'worker-1', toolName: 'run_local_shell_command',
    args: JSON.stringify({ command: 'npm test -- --runInBand', cwd: '/workspace/project' }, null, 2), status: 'pending' };
  const publish = records => f.emit(state([], { toolApprovals: records }));
  await publish([record]);
  const card = f.page.locator('.approval-card');
  assert.equal(await card.locator('.approval-preview').textContent(), 'npm test -- --runInBand');
  assert.equal(await card.locator('.approval-parameters').getAttribute('open'), null);
  await card.screenshot({ path: screenshotDirectory + '/approval-card-pending.png' });
  await card.getByRole('button', { name: '允许一次', exact: true }).click();
  assert(await card.getByRole('button', { name: '拒绝', exact: true }).isDisabled());
  assert.equal((await f.sent('toolApproval')).length, 1);
  assert.equal((await f.sent('toolApproval'))[0].decision, 'approve');
  await f.ack('toolApproval', false);
  assert(await card.locator('.approval-feedback').isVisible());
  assert(!(await card.getByRole('button', { name: '允许一次', exact: true }).isDisabled()));
  await card.getByRole('button', { name: '拒绝', exact: true }).click();
  assert.equal((await f.sent('toolApproval')).at(-1).decision, 'deny');
  await f.ack('toolApproval');
  assert.equal(await card.count(), 1, 'retain the card until the host confirms its final status');
  await publish([{ ...record, status: 'denied' }]);
  assert.equal(await card.count(), 0);
  await publish([{ ...record, status: 'denied' }]);
  assert.equal(await card.count(), 0, 'completed records must not reappear on refresh');
  await publish([{ ...record, id: 'cancel-me' }]);
  assert.equal(await card.count(), 1);
  await publish([{ ...record, id: 'cancel-me', status: 'cancelled' }]);
  assert.equal(await card.count(), 0);
});

test('approval cards remain safe and usable on narrow dark surfaces with independent requests', async t => {
  const f = await fixture(t, { viewport: { width: 320, height: 800 }, reducedMotion: 'reduce' });
  await f.page.evaluate(() => document.body.classList.add('vscode-dark'));
  const args = JSON.stringify({ command: 'echo "</pre><script>alert(1)</script>"\n' + 'long-path/'.repeat(24) });
  const records = [{ id: 'a', toolName: 'run_local_shell_command', args, status: 'pending' },
    { id: 'b', workerId: 'worker-2', toolName: 'mcp_project_inspect', args: '{"path":"src/app.js"}', status: 'pending' }];
  await f.emit(state([], { toolApprovals: records }));
  const cards = f.page.locator('.approval-card');
  assert.equal(await cards.first().locator('script').count(), 0);
  assert(await cards.first().locator('.approval-preview').textContent().then(value => value.includes('<script>')));
  assert(await f.page.evaluate(() => document.documentElement.scrollWidth <= 320));
  await cards.first().screenshot({ path: screenshotDirectory + '/approval-card-narrow-dark.png' });
  await cards.nth(1).getByRole('button', { name: '允许一次', exact: true }).click();
  assert.equal((await f.sent('toolApproval')).at(-1).approvalId, 'b');
  assert(!(await cards.first().getByRole('button', { name: '允许一次', exact: true }).isDisabled()));
  await f.ack('toolApproval');
  await f.emit(state([], { toolApprovals: [records[0], { ...records[1], status: 'approved' }] }));
  assert.equal(await cards.count(), 1);
  assert.equal(await cards.first().locator('.approval-preview').textContent(), JSON.parse(args).command);
});

test('unreviewed approvals persist through missing snapshots and idle empty history until explicitly resolved', async t => {
  const f = await fixture(t);
  const record = { id: 'keep-pending', toolName: 'read_file', args: '{"path":"src/app.js"}', status: 'pending' };
  const idle = { messages: [], busy: false, execution: { status: 'idle', parts: [] } };
  await f.emit(state([], { ...idle, toolApprovals: [record] }));
  const card = f.page.locator('.approval-card');
  assert(await card.isVisible());
  await card.locator('.approval-parameters > summary').click();
  await f.emit(state([], idle));
  assert(await card.isVisible());
  assert.notEqual(await card.locator('.approval-parameters').getAttribute('open'), null);
  await f.emit(state([], { ...idle, toolApprovals: [] }));
  assert(await card.isVisible());
  assert(!(await card.getByRole('button', { name: '允许一次', exact: true }).isDisabled()));
  await f.emit({ type: 'executionState', conversationId: 'inline-tool-cards', busy: false, execution: { status: 'idle' } });
  assert(await card.isVisible());
  await f.emit(state([], { ...idle, toolApprovals: [{ ...record, status: 'approved' }] }));
  assert.equal(await card.count(), 0);
  await f.emit(state([], { ...idle, toolApprovals: [record] }));
  await f.emit(state([], { ...idle, conversation: { id: 'other-session' }, toolApprovals: [] }));
  assert.equal(await card.count(), 0, 'pending cards must not leak into another conversation');
});

test('switching modes preserves assist approvals and restores its live output without sending cancellation', async t => {
  const f = await fixture(t);
  const record = { id: 'assist-pending', toolName: 'read_file', args: '{}', status: 'pending' };
  const assist = state([text('progress', 'Assist continues')], { toolApprovals: [record] });
  await f.emit(assist);
  await f.emit(state([], { mode: 'goal', conversation: { id: 'goal-session' }, goal: { objective: 'Goal continues', criteria: [], notes: [] }, toolApprovals: [] }));
  assert(!(await f.page.locator('.approval-card').isVisible()));
  await f.emit({ type: 'executionState', conversationId: 'inline-tool-cards', busy: true,
    execution: { status: 'running', parts: [text('progress', 'Background progress')] } });
  await f.emit({ ...assist, execution: { status: 'running', busy: true, parts: [text('progress', 'Background progress')] } });
  assert(await f.page.locator('.approval-card').isVisible());
  assert.match(await f.page.locator('#messages').textContent(), /Background progress/);
  assert.equal((await f.sent('cancelRun')).length, 0);
  assert.equal((await f.sent('toolApproval')).length, 0);
});

test('composer selects automatic or manual approval per conversation and sends the chosen mode', async t => {
  const f = await fixture(t);
  const idle = { busy: false, execution: { status: 'idle', busy: false, parts: [], activities: [] } };
  await f.emit(state([], { ...idle, requireToolApproval: true }));
  const select = f.page.locator('#tool-approval-mode');
  const selected = () => select.locator('input:checked').inputValue();
  assert.equal(await selected(), 'manual');
  await select.locator('label').filter({ hasText: '自动' }).click();
  await f.page.locator('#prompt-input').fill('test automatic');
  await f.page.locator('#submit-prompt').click();
  assert.equal((await f.ack('prompt')).approvalMode, 'auto');
  await f.emit(state([], { ...idle, conversation: { id: 'another', title: 'Another session' }, requireToolApproval: true }));
  assert.equal(await selected(), 'manual');
  await f.emit(state([], { ...idle, requireToolApproval: true }));
  assert.equal(await selected(), 'auto');
  await select.locator('label').filter({ hasText: '人工' }).click();
  await f.page.locator('#prompt-input').fill('test manual');
  await f.page.locator('#submit-prompt').click();
  assert.equal((await f.ack('prompt')).approvalMode, 'manual');
  await f.emit(state([], { requireToolApproval: false }));
  assert.equal(await select.locator('input').first().isDisabled(), true);
  assert.equal(await selected(), 'manual');
  await f.page.setViewportSize({ width: 320, height: 760 });
  await f.frames();
  const bounds = await select.boundingBox();
  assert(bounds.x >= 0 && bounds.x + bounds.width <= 320);
  await f.page.screenshot({ path: screenshotDirectory + '/composer-approval.png' });
});
