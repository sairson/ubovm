const test = require('node:test');
const assert = require('node:assert/strict');
const { createBlackboardSidebar } = require('../../../host/ui/blackboard-sidebar.cjs');

test('detail requests bound timers, release failed sends and ignore obsolete rejections', async () => {
  const vm = require('node:vm');
  const { renderSidebar } = require('../../../host/ui/blackboard-sidebar.cjs');
  const script = renderSidebar().match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)[1];
  const timers = new Set(); let mode = 'hold', rejectLate, sent = 0;
  const context = vm.createContext({
    window: { addEventListener() {} },
    setTimeout: () => { const id = {}; timers.add(id); return id; }, clearTimeout: id => timers.delete(id),
    acquireVsCodeApi: () => ({ postMessage() {
      sent++;
      if (mode === 'false') return false;
      if (mode === 'reject') return Promise.reject(Error('rejected'));
      if (mode === 'empty') return Promise.reject(undefined);
      if (mode === 'hostile') return Promise.reject({ get message() { throw Error('unreadable'); } });
      if (mode === 'late') return new Promise((_, reject) => { rejectLate = reject; });
    } })
  });
  vm.runInContext(script.slice(0, script.indexOf('  const element=')), context);
  const request = () => vm.runInContext("request('copyText',{text:'data'})", context);
  for (mode of ['false', 'reject']) {
    await assert.rejects(request()); assert.equal(timers.size, 0);
  }
  for (mode of ['empty', 'hostile']) {
    vm.runInContext("meta={textContent:''}", context);
    await vm.runInContext("openLink('https://example.com')", context);
    assert.match(vm.runInContext('meta.textContent', context), /发送失败/);
    assert.equal(timers.size, 0);
  }
  mode = 'hold';
  const pending = Array.from({ length: 32 }, request);
  const count = sent;
  await assert.rejects(request(), /待处理操作过多/);
  assert.equal(sent, count); assert.equal(timers.size, 32);
  const settled = Promise.all(pending.map(value => value.catch(error => error.message)));
  vm.runInContext('cancelRequests()', context); await settled; assert.equal(timers.size, 0);
  mode = 'late'; const done = request();
  vm.runInContext('const entry=pending.values().next().value;clearTimeout(entry.timer);pending.clear();entry.resolve();', context);
  await done; rejectLate(Error('late')); await new Promise(resolve => setImmediate(resolve));
  assert.equal(timers.size, 0);
});

test('malformed nested detail records cannot replace the readable current projection', async () => {
  const messages = [], selected = []; let receive;
  const sidebar = createBlackboardSidebar({ commands: {} }, { onSelect: id => selected.push(id), onClose() {} });
  sidebar.resolveWebviewView({ webview: { onDidReceiveMessage(fn) { receive = fn; }, postMessage(value) { messages.push(value); } }, onDidDispose() {} });
  sidebar.setSession('one');
  const valid = { sessionId: 'one', id: 'a', title: 'A', sections: [{ label: '正文', text: '保留内容' }], links: [{ id: 'b', label: 'B' }] };
  await sidebar.update(valid);
  const count = messages.length;
  for (const extra of [{ sections: [null] }, { sections: [{ label: '正文', text: {} }] }, { links: [null] }, { links: [{ id: 1 }] }, { links: [{ id: 'b', label: {} }] }]) {
    await sidebar.update({ ...valid, ...extra });
  }
  assert.equal(messages.length, count);
  await receive({ action: 'select', sessionId: 'one', id: 'b' });
  assert.deepEqual(selected, ['b']); sidebar.dispose();
});

test('structured fact views are validated before reaching the panel', async () => {
  const messages = [];
  const sidebar = createBlackboardSidebar({ commands: {} }, { onSelect() {}, onClose() {} });
  sidebar.resolveWebviewView({ webview: { onDidReceiveMessage() { return { dispose() {} }; }, postMessage(value) { messages.push(value); } }, onDidDispose() {} });
  sidebar.setSession('s');
  const base = { sessionId: 's', id: 'f', title: '事实详情', meta: '', sections: [{ label: '结论', text: '结论' }], links: [] };
  const fact = { outcome: 'partial', statement: '结论', coverage: [{ status: 'confirmed', statusLabel: '已确认', point: '检查配置', result: '已读取' }],
    counts: { confirmed: 1, evidence: 1 }, evidence: [{ observation: '读取配置', ref: 'call-1' }],
    failedChecks: [], limitations: ['未验证运行时'], nextSteps: [], truncated: true, omitted: { coverage: 0, evidence: 2 } };
  await sidebar.update({ ...base, fact });
  assert.deepEqual(messages.at(-1).detail.fact, fact);
  for (const bad of [{}, { statement: 'x' }, { statement: 'x', coverage: [{}], evidence: [] },
    { statement: 'x', coverage: [], evidence: [{ observation: 1 }] }, { statement: 'x', coverage: [], evidence: [], truncated: 'yes' }]) {
    const count = messages.length;
    await sidebar.update({ ...base, fact: bad });
    assert.equal(messages.length, count, JSON.stringify(bad));
  }
  await sidebar.update(base);
  assert.equal(messages.at(-1).detail.fact, undefined);
  sidebar.dispose();
});

test('structured fact details render outcome chips, coverage cards and omission notes', () => {
  const vm = require('node:vm');
  const { renderSidebar } = require('../../../host/ui/blackboard-sidebar.cjs');
  class FakeElement {
    constructor(tag) {
      this.tagName = String(tag).toUpperCase(); this.children = []; this.style = {}; this.dataset = {};
      this.hidden = false; this.className = ''; this._text = '';
      this.classList = {
        add: name => { if (!this.className.split(/\s+/).includes(name)) this.className = (this.className + ' ' + name).trim(); },
        toggle: name => {
          const parts = this.className.split(/\s+/).filter(Boolean); const index = parts.indexOf(name);
          if (index >= 0) { parts.splice(index, 1); this.className = parts.join(' '); return false; }
          parts.push(name); this.className = parts.join(' '); return true;
        },
        contains: name => this.className.split(/\s+/).includes(name)
      };
    }
    get textContent() { return this._text + this.children.map(child => child.textContent || '').join(''); }
    set textContent(value) { this._text = String(value); this.children = []; }
    append(...items) { for (const item of items) this.insertBefore(item, null); }
    insertBefore(item, before) {
      if (item.parent) item.remove();
      item.parent = this;
      const index = before ? this.children.indexOf(before) : this.children.length;
      this.children.splice(index < 0 ? this.children.length : index, 0, item);
    }
    remove() { if (this.parent) { const index = this.parent.children.indexOf(this); if (index >= 0) this.parent.children.splice(index, 1); } this.parent = null; }
    replaceChildren(...items) { this.children = []; this._text = ''; this.append(...items); }
  }
  const nodes = { files: new FakeElement('button'), refresh: new FakeElement('button'), detail: new FakeElement('article'), empty: new FakeElement('div') };
  let listener;
  const context = {
    acquireVsCodeApi: () => ({ postMessage() {} }),
    document: { getElementById: id => nodes[id], createElement: tag => new FakeElement(tag) },
    window: { addEventListener: (type, fn) => { listener = fn; }, scrollTo() {} },
    setTimeout, clearTimeout, console, Promise
  };
  context.globalThis = context;
  vm.runInNewContext(renderSidebar().match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)[1], context);
  const fact = {
    outcome: 'partial',
    statement: '审计结论'.repeat(400),
    coverage: [
      { status: 'confirmed', statusLabel: '已确认', point: '模型字段完整性', result: '读取 adhoc.py 确认四个字段。' },
      { status: 'partial', statusLabel: '部分完成', point: '命令前置校验', result: '只覆盖普通命令路径。' }
    ],
    counts: { confirmed: 1, partial: 1, blocked: 0, negative: 0, unknown: 0, evidence: 3 },
    evidence: [{ observation: '读取 AdHoc 模型定义。', ref: 'call_01' }],
    failedChecks: [], limitations: ['未在运行环境执行。'], nextSteps: ['构造一次真实请求。'],
    truncated: true, omitted: { coverage: 2, evidence: 2, failedChecks: 0, limitations: 0, nextSteps: 0 }
  };
  listener({ data: { type: 'detail', detail: { sessionId: 's', id: 'f', title: '事实详情', meta: '事实 · 部分完成', sections: [{ label: '结论', text: '结论' }], links: [], fact } } });
  const byClass = name => {
    const out = [];
    const walk = node => { if (String(node.className).split(/\s+/).includes(name)) out.push(node); node.children.forEach(walk); };
    walk(nodes.detail);
    return out;
  };
  assert.equal(byClass('fact-chip')[0].textContent, '部分完成');
  assert.equal(byClass('fact-chip')[1].textContent, '摘要');
  assert(byClass('fact-head')[0].children.some(child => String(child.className).includes('fact-counts')), 'counts share the chip row');
  assert.equal(byClass('fact-coverage')[0].children.length, 2);
  assert.equal(byClass('fact-pill')[0].textContent, '已确认');
  assert.equal(byClass('fact-pill')[1].dataset.status, 'partial');
  assert.match(byClass('fact-ref')[0].textContent, /call_01/);
  assert.match(byClass('fact-counts')[0].textContent, /1 已确认/);
  assert.match(byClass('fact-counts')[0].textContent, /3 条证据/);
  assert.match(byClass('fact-note')[0].textContent, /已省略 2 项验证覆盖、2 条证据/);
  assert.equal(byClass('fact-actions')[0].children.length, 2, 'copy and expand actions');
  assert(byClass('fact-statement')[0].classList.contains('is-clamped'));
  assert.match(nodes.detail.textContent, /审计结论/);
  assert.equal(byClass('fact-list')[1].children[0].textContent, '构造一次真实请求。');
});

test('fact content actions use the current session and the existing message handler only', async () => {
  const actions = []; let receive;
  const sidebar = createBlackboardSidebar({ commands: {} }, {
    onSelect() {}, onClose() {}, onAction: async (message, target) => actions.push([message.action, target])
  });
  const view = { webview: { onDidReceiveMessage(fn) { receive = fn; }, postMessage() {} }, onDidDispose() {} };
  sidebar.resolveWebviewView(view); sidebar.setSession('s');
  await sidebar.update({ sessionId: 's', id: 'f', title: 'Fact', sections: [], links: [] });
  await receive({ action: 'copyText', sessionId: 'old', text: 'stale' });
  await receive({ action: 'prompt', sessionId: 's', text: 'not a content action' });
  await receive({ action: 'copyText', sessionId: 's', text: 'code' });
  await receive({ action: 'openMessageLink', sessionId: 's', href: 'https://example.com' });
  assert.deepEqual(actions, [['copyText', view], ['openMessageLink', view]]);
  sidebar.dispose();
});

test('returning to files does not await a stuck conversation notification', async () => {
  const commands = [], errors = [];
  let reject;
  const sidebar = createBlackboardSidebar({ commands: { async executeCommand(command) { commands.push(command); } } }, {
    onSelect() {}, onClose: () => new Promise((_, no) => { reject = no; }), onError: error => errors.push(error.message)
  });
  await sidebar.showFiles();
  assert.deepEqual(commands, ['workbench.view.explorer']);
  reject(Error('closed conversation'));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(errors, ['closed conversation']);
});

test('replacing a detail component invalidates an in-flight reveal', async () => {
  let finish, shown = 0;
  const sidebar = createBlackboardSidebar({ commands: { executeCommand: () => new Promise(resolve => { finish = resolve; }) } }, { onSelect() {}, onClose() {} });
  const view = () => ({ webview: { onDidReceiveMessage() { return { dispose() {} }; }, postMessage() {} }, onDidDispose() {}, show() { shown++; } });
  sidebar.resolveWebviewView(view()); sidebar.setSession('one');
  const opening = sidebar.update({ sessionId: 'one', id: 'a', title: 'A', sections: [], links: [] }, true);
  await new Promise(resolve => setImmediate(resolve));
  sidebar.resolveWebviewView(view()); finish(); await opening;
  assert.equal(shown, 0);
});

test('identical detail publications retain DOM and a new session resets reading position', () => {
  const vm = require('node:vm');
  const { renderSidebar } = require('../../../host/ui/blackboard-sidebar.cjs');
  let listener, replacements = 0, scrolls = 0;
  const node = () => ({
    children: [], append(...items) { for (const item of items) this.insertBefore(item, null); },
    insertBefore(item, before) { item.remove(); item.parent = this; this.children.splice(before ? this.children.indexOf(before) : this.children.length, 0, item); },
    remove() { if (this.parent) { const siblings = this.parent.children; siblings.splice(siblings.indexOf(this), 1); this.parent = null; } },
    replaceChildren(...items) { replacements++; this.children = []; this.append(...items); }
  });
  const elements = { files: node(), refresh: node(), detail: node(), empty: node() };
  const script = renderSidebar().match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)[1];
  vm.runInNewContext(script, {
    acquireVsCodeApi: () => ({ postMessage() {} }),
    document: { getElementById: id => elements[id], createElement: node },
    window: { addEventListener(type, fn) { listener = fn; }, scrollTo() { scrolls++; } }
  });
  const detail = { sessionId: 'one', id: 'a', title: 'A', meta: '', sections: [{ label: '记录', text: '内容' }], links: [] };
  for (let i = 0; i < 1000; i++) listener({ data: { type: 'detail', detail: structuredClone(detail) } });
  assert.equal(replacements, 1); assert.equal(scrolls, 1);
  listener({ data: { type: 'detail', detail: { ...detail, title: 'Updated' } } });
  assert.equal(replacements, 1); assert.equal(scrolls, 1);
  listener({ data: { type: 'detail', detail: { ...detail, sessionId: 'two' } } });
  assert.equal(replacements, 2); assert.equal(scrolls, 2);
});

test('bridge and navigation failures are reported and later detail actions remain usable', async () => {
  let listener, fail = 'sync';
  const errors = [], messages = [];
  const sidebar = createBlackboardSidebar({ commands: { async executeCommand() { if (fail) throw Error('navigation'); } } }, {
    onSelect: async () => { if (fail) throw Error('selection'); },
    onClose() {}, onError: error => errors.push(error.message)
  });
  sidebar.resolveWebviewView({ webview: {
    onDidReceiveMessage(fn) { listener = fn; return { dispose() {} }; },
    postMessage(message) {
      if (fail === 'sync') throw Error('sync send');
      if (fail === 'async') return Promise.reject(Error('async send'));
      messages.push(message);
    }
  }, onDidDispose() {}, show() {} });
  sidebar.setSession('one');
  fail = 'async';
  await sidebar.update({ sessionId: 'one', id: 'a', title: 'A', sections: [], links: [{ id: 'b' }] });
  await listener({ action: 'select', sessionId: 'one', id: 'b' });
  await listener({ action: 'files' });
  assert(errors.includes('sync send')); assert(errors.includes('async send'));
  assert(errors.includes('selection')); assert(errors.includes('navigation'));
  fail = false;
  await sidebar.update({ sessionId: 'one', id: 'b', title: 'Recovered', sections: [], links: [] }, true);
  assert.equal(messages.at(-1).detail.title, 'Recovered');
});

test('native details preserve file navigation, reject stale sessions and allow only related-node jumps', async () => {
  const commands = [], messages = [], selections = [];
  let listener, closed = 0;
  const sidebar = createBlackboardSidebar({ commands: { async executeCommand(command) { commands.push(command); } } }, {
    onSelect: (...args) => selections.push(args), onClose: () => closed++
  });
  sidebar.resolveWebviewView({ webview: {
    onDidReceiveMessage(fn) { listener = fn; return { dispose() {} }; },
    postMessage(message) { messages.push(structuredClone(message)); }
  }, onDidDispose() {}, show() {} });
  sidebar.setSession('one');
  const detail = { sessionId: 'one', id: 'a', title: '事实', meta: '', sections: [], links: [{ id: 'b', label: '来源' }] };
  await sidebar.update(detail, true);
  assert.deepEqual(commands, ['workbench.view.extension.ubovm-blackboard']);
  await sidebar.update({ ...detail, title: '更新事实' }, false);
  assert.equal(commands.length, 1, 'live updates must not reopen the sidebar');
  listener({ action: 'select', sessionId: 'one', id: 'b' });
  listener({ action: 'select', sessionId: 'one', id: 'unrelated' });
  assert.deepEqual(selections, [['b', 'one']]);
  sidebar.setSession('two');
  await sidebar.update(detail, true);
  assert.equal(messages.at(-1).detail, null);
  assert.equal(commands.length, 1);
  await sidebar.showFiles();
  assert.equal(commands.at(-1), 'workbench.view.explorer');
  assert.equal(closed, 1);
});

test('obsolete detail reveals cannot override returning to files or changing sessions', async () => {
  let finish, shown = 0;
  const commands = [];
  const sidebar = createBlackboardSidebar({ commands: { executeCommand(command) {
    commands.push(command);
    return command.includes('ubovm-blackboard') ? new Promise(resolve => { finish = resolve; }) : Promise.resolve();
  } } }, { onSelect() {}, onClose() {} });
  sidebar.resolveWebviewView({ webview: { onDidReceiveMessage() { return { dispose() {} }; }, postMessage() {} }, onDidDispose() {}, show() { shown++; } });
  sidebar.setSession('one');
  const detail = { sessionId: 'one', id: 'a', title: 'A', sections: [], links: [] };
  const opening = sidebar.update(detail, true);
  await new Promise(resolve => setImmediate(resolve));
  const closing = sidebar.showFiles();
  finish(); await Promise.all([opening, closing]);
  assert.equal(shown, 0);
  assert.equal(commands.at(-1), 'workbench.view.explorer');
  const stale = sidebar.update(detail, true);
  await new Promise(resolve => setImmediate(resolve));
  sidebar.setSession('two'); finish(); await stale;
  assert.equal(shown, 0);
});

test('replaced detail views cannot select nodes or navigate away from the live view', async () => {
  const listeners = [], disposed = [], commands = [], selected = [];
  const sidebar = createBlackboardSidebar({ commands: { async executeCommand(command) { commands.push(command); } } }, {
    onSelect: id => selected.push(id), onClose() {}
  });
  const view = () => ({ webview: { onDidReceiveMessage(fn) { listeners.push(fn); return { dispose() {} }; }, postMessage() {} }, onDidDispose(fn) { disposed.push(fn); }, show() {} });
  sidebar.resolveWebviewView(view()); sidebar.resolveWebviewView(view()); disposed[0]();
  sidebar.setSession('one');
  await sidebar.update({ sessionId: 'one', id: 'a', title: 'A', sections: [], links: [{ id: 'b' }] });
  await listeners[0]({ action: 'files' });
  listeners[0]({ action: 'select', sessionId: 'one', id: 'b' });
  listeners[1]({ action: 'select', sessionId: 'one', id: 'b' });
  assert.deepEqual(commands, []); assert.deepEqual(selected, ['b']);
});

test('hidden blackboard tabs pause delivery and cancel late reveals, then restore latest detail', async () => {
  let visibility, finish;
  const messages = []; let shown = 0;
  const sidebar = createBlackboardSidebar({ commands: { executeCommand: () => new Promise(resolve => { finish = resolve; }) } }, { onSelect() {}, onClose() {} });
  const view = { visible: true, show() { shown++; }, webview: {
    onDidReceiveMessage() { return { dispose() {} }; }, postMessage(value) { messages.push(structuredClone(value)); }
  }, onDidChangeVisibility(fn) { visibility = fn; return { dispose() {} }; }, onDidDispose() {} };
  sidebar.resolveWebviewView(view); sidebar.setSession('one');
  const detail = { sessionId: 'one', id: 'a', title: 'A', sections: [], links: [] };
  const opening = sidebar.update(detail, true);
  await new Promise(resolve => setImmediate(resolve));
  view.visible = false; visibility(); finish(); await opening;
  assert.equal(shown, 0);
  const count = messages.length;
  for (let i = 0; i < 100; i++) await sidebar.update({ ...detail, title: '更新 ' + i });
  assert.equal(messages.length, count);
  view.visible = true; visibility();
  assert.equal(messages.length, count + 1);
  assert.equal(messages.at(-1).detail.title, '更新 99');
});

test('renders a refresh control in the blackboard detail header', () => {
  const { renderSidebar } = require('../../../host/ui/blackboard-sidebar.cjs');
  const html = renderSidebar();
  assert.match(html, /id="refresh"/);
  assert.match(html, /id="refresh"[^>]*title="重新读取节点详情"/);
});

test('refresh republishes the current detail without reopening the sidebar', async () => {
  const messages = []; let receive;
  const sidebar = createBlackboardSidebar({ commands: { async executeCommand() {} } }, { onSelect() {}, onClose() {} });
  const view = { visible: true, webview: {
    onDidReceiveMessage(fn) { receive = fn; return { dispose() {} }; },
    postMessage(value) { messages.push(structuredClone(value)); return true; }
  }, onDidChangeVisibility() { return { dispose() {} }; }, onDidDispose() {}, show() {} };
  sidebar.resolveWebviewView(view);
  sidebar.setSession('one');
  const detail = { sessionId: 'one', id: 'a', title: 'A', sections: [], links: [] };
  await sidebar.update(detail);
  const before = messages.length;
  await receive({ action: 'refresh' });
  assert.equal(messages.length, before + 1);
  assert.deepEqual(messages.at(-1).detail, detail);
  sidebar.dispose();
});

test('revealing a hidden detail panel republishes only after show', async () => {
  let finish;
  const messages = [];
  const sidebar = createBlackboardSidebar({ commands: { executeCommand: () => new Promise(resolve => { finish = resolve; }) } }, { onSelect() {}, onClose() {} });
  const view = { visible: false, show() { this.visible = true; }, webview: {
    onDidReceiveMessage() { return { dispose() {} }; },
    postMessage(value) { messages.push(structuredClone(value)); return true; }
  }, onDidChangeVisibility() { return { dispose() {} }; }, onDidDispose() {} };
  sidebar.resolveWebviewView(view);
  sidebar.setSession('one');
  const detail = { sessionId: 'one', id: 'a', title: 'A', sections: [], links: [] };
  const opening = sidebar.update(detail, true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(messages.length, 0, 'a hidden view must not receive the detail before reveal');
  finish(); await opening;
  assert.equal(view.visible, true);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].detail.title, 'A');
  sidebar.dispose();
});

test('refresh rebuilds the panel DOM and asks the host to republish', () => {
  const vm = require('node:vm');
  const { renderSidebar } = require('../../../host/ui/blackboard-sidebar.cjs');
  let listener; let replacements = 0;
  const posts = [];
  const node = () => ({
    children: [], append(...items) { for (const item of items) this.insertBefore(item, null); },
    insertBefore(item, before) { item.remove(); item.parent = this; this.children.splice(before ? this.children.indexOf(before) : this.children.length, 0, item); },
    remove() { if (this.parent) { const siblings = this.parent.children; siblings.splice(siblings.indexOf(this), 1); this.parent = null; } },
    replaceChildren(...items) { replacements++; this.children = []; this.append(...items); }
  });
  const elements = { files: node(), refresh: node(), detail: node(), empty: node() };
  const script = renderSidebar().match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)[1];
  vm.runInNewContext(script, {
    acquireVsCodeApi: () => ({ postMessage(value) { posts.push(value); return true; } }),
    document: { getElementById: id => elements[id], createElement: node },
    window: { addEventListener(type, fn) { if (type === 'message') listener = fn; }, scrollTo() {} }
  });
  const detail = { sessionId: 'one', id: 'a', title: 'A', meta: '', sections: [{ label: '记录', text: '内容' }], links: [] };
  listener({ data: { type: 'detail', detail } });
  const afterFirst = replacements;
  elements.refresh.onclick();
  assert.equal(replacements, afterFirst + 1, 'refresh must rebuild the article instead of reusing a broken subtree');
  assert.ok(posts.some(message => message?.action === 'refresh'));
});
