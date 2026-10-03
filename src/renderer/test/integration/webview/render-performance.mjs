import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { chromium } from 'playwright-core';

const require = createRequire(import.meta.url);
const paint = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const { renderWebview } = require('../../../host/ui/webview.cjs');

test('incremental rendering skips historical tokens and repairs partially overwritten prefixes', async t => {
  const page = await pageFor(t);
  const result = await page.evaluate(() => {
    const original = marked, target = document.createElement('div'), reference = document.createElement('div');
    document.body.append(target, reference);
    let reads = 0, capture = true;
    window.marked = { ...original, lexer(...args) {
      const tokens = original.lexer(...args);
      if (capture) {
        capture = false;
        for (const token of tokens.filter(t => t.type !== 'space').slice(0, -1)) {
          const type = token.type;
          Object.defineProperty(token, 'type', { enumerable: true, get() { reads++; return type; } });
        }
      }
      return tokens;
    } };
    try {
      let text = 'Saved paragraph.\n\n'.repeat(300) + 'Tail';
      UBOVMMarkdown.update(target, text, { streaming: true }); reads = 0;
      for (let i = 0; i < 100; i++) { text += ' word'; UBOVMMarkdown.update(target, text, { streaming: true }); }
      const historicalReads = reads;
      window.marked = { ...original, parser(tokens, ...args) {
        if (tokens[0].raw.includes('FAIL')) throw Error('injected partial render');
        return original.parser(tokens, ...args);
      } };
      let failed = false;
      try { UBOVMMarkdown.update(target, 'Overwritten prefix.\n\nFAIL', { streaming: true }); } catch { failed = true; }
      window.marked = original;
      text += ' recovered';
      UBOVMMarkdown.update(target, text, { streaming: true });
      UBOVMMarkdown.update(reference, text, { streaming: true });
      return { historicalReads, failed, repaired: target.innerHTML === reference.innerHTML };
    } finally { window.marked = original; UBOVMMarkdown.release(target); UBOVMMarkdown.release(reference); target.remove(); reference.remove(); }
  });
  assert.deepEqual(result, { historicalReads: 0, failed: true, repaired: true });
});

test('parser fallback retries identical content instead of caching plain text forever', async t => {
  const page = await pageFor(t);
  const result = await page.evaluate(() => {
    const target = document.createElement('div'); document.body.append(target);
    const original = marked, text = '**Restore formatting**';
    try {
      window.marked = { ...original, lexer() { throw Error('parser temporarily unavailable'); } };
      UBOVMMarkdown.update(target, text, { streaming: true });
      const fallback = target.querySelector('code')?.textContent === text;
      window.marked = original;
      UBOVMMarkdown.update(target, text, { streaming: true });
      return { fallback, recovered: target.querySelector('strong')?.textContent === 'Restore formatting' };
    } finally { window.marked = original; UBOVMMarkdown.release(target); target.remove(); }
  });
  assert.deepEqual(result, { fallback: true, recovered: true });
});

test('prose streaming parses only the growing tail and preserves full Markdown semantics', async t => {
  const page = await pageFor(t);
  const result = await page.evaluate(() => {
    const target = document.createElement('div'), reference = document.createElement('div');
    document.body.append(target, reference);
    const original = marked, sizes = [];
    const prefix = Array.from({ length: 200 }, (_, i) => `Saved paragraph ${i} **complete**.\n\n`).join('');
    let text = prefix + 'Growing';
    UBOVMMarkdown.update(target, text, { streaming: true });
    const first = target.firstChild;
    window.marked = { ...original, lexer(value, options) { sizes.push(value.length); return original.lexer(value, options); } };
    try {
      for (let i = 0; i < 40; i++) { text += ' word'; UBOVMMarkdown.update(target, text, { streaming: true }); }
      const tailOnly = sizes.length === 40 && sizes.every(size => size < 300);
      const retained = first === target.firstChild;
      let matches = true;
      for (const suffix of ['\n---\n\n', 'Column | Other\n', '--- | ---\n', 'value | cell\n\n', '- item\n\n', '[link][ref]\n\n', '[ref]: https://example.com\n']) {
        text += suffix;
        UBOVMMarkdown.update(target, text, { streaming: true });
        UBOVMMarkdown.update(reference, text, { streaming: true });
        matches &&= target.innerHTML === reference.innerHTML;
        UBOVMMarkdown.release(reference); reference.replaceChildren();
      }
      UBOVMMarkdown.update(target, text, { streaming: false });
      UBOVMMarkdown.update(reference, text, { streaming: false });
      const finished = target.innerHTML === reference.innerHTML;
      UBOVMMarkdown.update(target, 'Rewritten **answer**', { streaming: true });
      UBOVMMarkdown.update(reference, 'Rewritten **answer**', { streaming: true });
      return { tailOnly, retained, matches, finished, rewritten: target.innerHTML === reference.innerHTML };
    } finally {
      window.marked = original; UBOVMMarkdown.release(target); UBOVMMarkdown.release(reference); target.remove(); reference.remove();
    }
  });
  assert.deepEqual(result, { tailOnly: true, retained: true, matches: true, finished: true, rewritten: true });
});

test('thinking and summary streams avoid unchanged attributes and refresh cached actions', async t => {
  const page = await pageFor(t);
  const result = await page.evaluate(async () => {
    const target = document.createElement('div'); document.body.append(target);
    const results = [];
    try {
      for (const type of ['thinking', 'summary']) {
        let part = { id: type, type, text: 'Text', status: 'running', source: 'worker', workerId: 'w' };
        const update = options => UBOVMMessage.update(target, '', { ...options, parts: [part] });
        update({});
        const card = target.querySelector('.thinking-card'); card.open = true;
        card.dispatchEvent(new Event('toggle'));
        const observer = new MutationObserver(() => {}); observer.observe(card, { attributes: true, subtree: true });
        for (let i = 0; i < 50; i++) { part = { ...part, text: part.text + ' word' }; update({}); }
        const mutations = observer.takeRecords().length; observer.disconnect();
        part = { ...part, text: '```html\n<div>safe</div>\n```' }; update({});
        const button = card.querySelector('[data-md-code-preview]');
        let old = 0, latest = 0;
        update({ onPreviewHtml: () => { old++; } }); button.click();
        update({ onPreviewHtml: () => { latest++; } }); button.click();
        update({}); const disabled = button.disabled;
        card.open = false;
        update({ onPreviewHtml: () => { latest++; } });
        card.open = true; card.dispatchEvent(new Event('toggle')); button.click();
        results.push({ type, mutations, old, latest, disabled });
        UBOVMMessage.release(target); target.replaceChildren();
      }
      return results;
    } finally { UBOVMMessage.release(target); target.remove(); }
  });
  assert.deepEqual(result, ['thinking', 'summary'].map(type => ({ type, mutations: 0, old: 1, latest: 2, disabled: true })));
});

test('thinking action refresh retries an identical snapshot after rendering fails', async t => {
  const page = await pageFor(t);
  const result = await page.evaluate(() => {
    const target = document.createElement('div'); document.body.append(target);
    const original = UBOVMMarkdown;
    const part = { id: 'thinking', type: 'thinking', text: '```html\n<div>x</div>\n```', status: 'completed' };
    try {
      UBOVMMessage.update(target, '', { parts: [part] });
      const options = { parts: [part], onPreviewHtml() {} };
      window.UBOVMMarkdown = { ...original, update() { throw Error('injected failure'); } };
      let failed = false;
      try { UBOVMMessage.update(target, '', options); } catch { failed = true; }
      window.UBOVMMarkdown = original;
      UBOVMMessage.update(target, '', options);
      return { failed, enabled: !target.querySelector('[data-md-code-preview]').disabled };
    } finally { window.UBOVMMarkdown = original; UBOVMMessage.release(target); target.remove(); }
  });
  assert.deepEqual(result, { failed: true, enabled: true });
});

test('released thinking and summary toggles cannot recreate Markdown views', async t => {
  const page = await pageFor(t);
  const result = await page.evaluate(async () => {
    const original = UBOVMMarkdown;
    let updates = 0;
    window.UBOVMMarkdown = { ...original, update(...args) { updates++; return original.update(...args); } };
    const target = document.createElement('div'); document.body.append(target);
    try {
      const changes = [];
      for (const type of ['thinking', 'summary']) {
        UBOVMMessage.update(target, '', { parts: [{ id: type, type, text: '**Saved**', status: 'completed' }] });
        const old = target.querySelector('.thinking-card');
        old.open = false;
        UBOVMMessage.release(target); target.replaceChildren();
        const before = updates;
        // Both a queued native toggle and an old retained DOM reference must
        // remain inert after the owning message has been released.
        old.open = true; old.dispatchEvent(new Event('toggle'));
        await new Promise(resolve => setTimeout(resolve, 0));
        changes.push(updates - before);
      }
      UBOVMMessage.update(target, '', { parts: [{ id: 'fresh', type: 'thinking', text: '**Fresh**', status: 'completed' }] });
      return { changes, fresh: target.querySelector('strong')?.textContent };
    } finally { UBOVMMessage.release(target); target.remove(); window.UBOVMMarkdown = original; }
  });
  assert.deepEqual(result, { changes: [0, 0], fresh: 'Fresh' });
});

test('duration ticks skip folded maintenance and queued ticks after suspension', async t => {
  const page = await pageFor(t);
  const result = await page.evaluate(async () => {
    const target = document.createElement('div'); document.body.append(target);
    const now = Date.now, interval = window.setInterval;
    let current = 100000, clockTick;
    Date.now = () => current;
    window.setInterval = (callback, delay, ...args) => {
      if (delay === 1000) clockTick = callback;
      return interval(callback, delay, ...args);
    };
    const toggle = async (node, open) => { node.open = open; await new Promise(resolve => setTimeout(resolve, 0)); };
    try {
      UBOVMMessage.update(target, '', { parts: [
        { id: 'summary', type: 'summary', status: 'completed', text: 'Summary' },
        { id: 'wait', type: 'tool', name: 'wait_workers', status: 'running', startedAt: 99000, args: '{}', output: '' }
      ] });
      const group = target.querySelector('.maintenance-group'); await toggle(group, true);
      const time = target.querySelector('.tool-time'), initial = time.textContent;
      await toggle(group, false); current += 10000; clockTick();
      const folded = time.textContent === initial;
      await toggle(group, true); const refreshed = time.textContent === '11s';
      window.dispatchEvent(new Event('pagehide'));
      current += 10000; clockTick();
      const suspended = time.textContent === '11s';
      window.dispatchEvent(new Event('pageshow'));
      return { folded, refreshed, suspended, resumed: time.textContent === '21s' };
    } finally {
      UBOVMMessage.release(target); target.remove(); Date.now = now; window.setInterval = interval;
    }
  });
  assert.deepEqual(result, { folded: true, refreshed: true, suspended: true, resumed: true });
});

test('unchanged Markdown avoids block scans and repairs synchronous and delivered mutations', async t => {
  const page = await pageFor(t);
  const result = await page.evaluate(async () => {
    const target = document.createElement('div'); document.body.append(target);
    const text = Array.from({ length: 300 }, (_, i) => `Paragraph ${i} **saved**\n\n`).join('');
    UBOVMMarkdown.update(target, text);
    const read = Object.getOwnPropertyDescriptor(Node.prototype, 'childNodes').get;
    let reads = 0;
    Object.defineProperty(target, 'childNodes', { configurable: true, get() { reads++; return read.call(this); } });
    for (let i = 0; i < 50; i++) UBOVMMarkdown.update(target, text);
    await Promise.resolve();
    for (let i = 0; i < 50; i++) UBOVMMarkdown.update(target, text);
    const stableReads = reads;
    const first = target.firstChild;
    target.replaceChild(document.createElement('div'), first);
    const synchronous = UBOVMMarkdown.update(target, text) && target.firstChild.textContent.includes('Paragraph 0');
    target.replaceChild(document.createElement('div'), target.lastChild);
    await Promise.resolve();
    const delivered = UBOVMMarkdown.update(target, text) && target.lastChild.textContent.includes('Paragraph 299');
    const repairedReads = reads; UBOVMMarkdown.update(target, text);
    const cachedAgain = reads === repairedReads;
    UBOVMMarkdown.release(target);
    target.replaceChildren(document.createTextNode('Replaced after release'));
    UBOVMMarkdown.update(target, text);
    const recreated = target.children.length === 300;
    UBOVMMarkdown.release(target); target.remove();
    return { stableReads, synchronous, delivered, cachedAgain, recreated };
  });
  t.diagnostic(JSON.stringify(result));
  assert.deepEqual(result, { stableReads: 0, synchronous: true, delivered: true, cachedAgain: true, recreated: true });
});

test('folded maintenance timelines defer nested work and reveal the latest snapshot', async t => {
  const page = await pageFor(t);
  const result = await page.evaluate(async () => {
    const target = document.createElement('div'); document.body.append(target);
    let reads = 0;
    const parts = Array.from({ length: 200 }, (_, i) => ({
      id: 'deferred-' + i, type: i % 2 ? 'tool' : 'summary', name: 'wait_workers', status: 'completed',
      get args() { reads++; return '{}'; }, text: 'Saved summary', output: 'Saved output'
    }));
    const render = text => UBOVMMessage.update(target, '', { streaming: true, parts: [...parts, { id: 'answer', type: 'text', status: 'streaming', text }] });
    const toggle = async (group, open) => { group.open = open; await new Promise(resolve => setTimeout(resolve, 0)); };
    render('Start');
    const group = target.querySelector('.maintenance-group');
    for (let i = 0; i < 30; i++) render('Answer ' + i);
    const deferred = { reads, cards: group.querySelectorAll('.tool-card, .summary-card').length };
    parts[0] = { ...parts[0], text: 'Latest summary' };
    render('Latest'); await toggle(group, true);
    const revealed = group.querySelectorAll('.tool-card, .summary-card').length;
    const summary = group.querySelector('.summary-card');
    summary.open = true; await new Promise(resolve => setTimeout(resolve, 0));
    const latest = summary.textContent.includes('Latest summary');
    await toggle(group, false); const previousReads = reads;
    parts[0] = { ...parts[0], text: 'Updated while folded' };
    for (let i = 0; i < 30; i++) render('Next ' + i);
    const foldedReads = reads - previousReads;
    await toggle(group, true);
    const retained = summary === group.querySelector('.summary-card');
    const refreshed = summary.textContent.includes('Updated while folded');
    await toggle(group, false); render('Pending'); UBOVMMessage.release(target);
    const releasedReads = reads; await toggle(group, true);
    const afterRelease = reads - releasedReads;
    target.remove(); return { deferred, revealed, latest, foldedReads, retained, refreshed, afterRelease };
  });
  t.diagnostic(JSON.stringify(result));
  assert.deepEqual(result, { deferred: { reads: 0, cards: 0 }, revealed: 200, latest: true, foldedReads: 0, retained: true, refreshed: true, afterRelease: 0 });
});

test('Worker transcript cache evicts old views and reconstructs them from current records', async t => {
  const page = await pageFor(t);
  const result = await page.evaluate(() => {
    const original = window.UBOVMMessage;
    let released = 0;
    window.UBOVMMessage = { ...original, release(element) { released++; original.release(element); } };
    const panel = createWorkerPanel({}, { standalone: true });
    const workers = Array.from({ length: 30 }, (_, index) => ({ id: `cache-${index}`, status: 'completed', result: `Saved log ${index}` }));
    panel.update({ sessionId: 'cache-test', workers });
    for (const worker of workers) panel.show(worker.id);
    const evicted = released;
    panel.show('cache-0');
    const restored = [...document.querySelectorAll('.worker-transcript')].some(element => element.textContent.includes('Saved log 0'));
    panel.update({ sessionId: 'next-cache-test', workers: [] });
    return { evicted, released, restored };
  });
  assert.deepEqual(result, { evicted: 22, released: 31, restored: true });
});

test('releasing a running message immediately stops its duration timer', async t => {
  const page = await pageFor(t);
  const result = await page.evaluate(() => {
    const interval = window.setInterval, clear = window.clearInterval, tracked = new Map();
    window.setInterval = (...args) => { const id = interval(...args); tracked.set(id, args[0]); return id; };
    window.clearInterval = id => { tracked.delete(id); clear(id); };
    const element = document.createElement('div'); document.body.append(element);
    try {
      const options = { parts: [{ id: 'timer-test', type: 'tool', name: 'inspect', status: 'running', startedAt: Date.now(), args: '{}', output: '' }] };
      UBOVMMessage.update(element, '', options);
      const before = tracked.size;
      element.remove(); for (const tick of [...tracked.values()]) tick();
      const detached = tracked.size;
      document.body.append(element); UBOVMMessage.update(element, '', options);
      const restored = tracked.size;
      UBOVMMessage.release(element); UBOVMMessage.release(element); element.remove();
      return { before, detached, restored, after: tracked.size };
    } finally { window.setInterval = interval; window.clearInterval = clear; }
  });
  assert.deepEqual(result, { before: 1, detached: 0, restored: 1, after: 0 });
});
test('completed tool cards stay untouched while the answer streams', async t => {
  const page = await pageFor(t);
  const result = await page.evaluate(async () => {
    const target = document.createElement('div'); document.body.append(target);
    const tools = Array.from({ length: 80 }, (_, index) => ({ id: 'stable-' + index, type: 'tool', name: 'read_workspace_file', status: 'completed', args: '{"path":"a.txt"}', output: 'Saved output' }));
    const render = text => UBOVMMessage.update(target, '', { streaming: true, parts: [...tools, { id: 'answer', type: 'text', status: 'streaming', text }] });
    render('Start');
    await new Promise(resolve => requestAnimationFrame(resolve));
    const cards = [...target.querySelectorAll('.tool-card')];
    let changes = 0;
    const observer = new MutationObserver(records => { changes += records.length; });
    for (const card of cards) observer.observe(card, { subtree: true, attributes: true, childList: true, characterData: true });
    for (let i = 0; i < 30; i++) render('Answer ' + i);
    await Promise.resolve(); observer.disconnect();
    const retained = cards.every((card, index) => card === target.querySelectorAll('.tool-card')[index]);
    const answer = target.querySelector('.response-text').textContent.trim();
    UBOVMMessage.release(target); target.remove();
    return { cards: cards.length, changes, retained, answer };
  });
  t.diagnostic(JSON.stringify(result));
  assert.deepEqual(result, { cards: 80, changes: 0, retained: true, answer: 'Answer 29' });
});

test('unchanged outline updates skip geometry reads but scrolling still refreshes the active turn', async t => {
  const page = await pageFor(t);
  const result = await page.evaluate(async () => {
    const scroller = document.createElement('div'), messages = scroller;
    scroller.style.cssText = 'height:300px;overflow:auto'; document.body.append(scroller);
    const entries = Array.from({ length: 40 }, (_, index) => {
      const article = document.createElement('article'); article.textContent = 'Turn ' + index; article.style.height = '80px'; messages.append(article);
      return { article, role: 'user', text: article.textContent };
    });
    const outline = createConversationOutline({ scroller });
    const frame = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    // Initial ResizeObserver delivery schedules its own following frame.
    outline.update(entries, 'geometry'); await frame(); await frame();
    let reads = 0;
    for (const element of [scroller, ...entries.map(entry => entry.article)]) {
      const read = element.getBoundingClientRect;
      element.getBoundingClientRect = function () { reads++; return read.call(this); };
    }
    for (let i = 0; i < 12; i++) { outline.update(entries, 'geometry'); await frame(); }
    const unchanged = reads;
    scroller.scrollTop = 600; scroller.dispatchEvent(new Event('scroll')); await frame();
    const afterScroll = reads;
    const selected = document.querySelector('.outline-turn[aria-current]')?.textContent;
    outline.dispose(); scroller.remove();
    return { unchanged, afterScroll, selected };
  });
  assert.equal(result.unchanged, 0);
  assert(result.afterScroll > 0);
  assert.match(result.selected, /Turn/);
});

test('streaming skips unchanged historical file summaries and refreshes changed summaries', async t => {
  const page = await pageFor(t);
  const initial = { ...state(), busy: true, messages: Array.from({ length: 20 }, (_, i) => ({ id: 'assist:turn-' + i, role: 'assistant', text: 'Saved answer ' + i })),
    execution: { status: 'running', streamText: 'Start' }, codeChanges: {} };
  await send(page, initial);
  await page.evaluate(() => {
    window.changeCardCalls = 0;
    const update = UBOVMCodeChanges.update;
    UBOVMCodeChanges.update = (...args) => { changeCardCalls++; return update(...args); };
  });
  for (let i = 0; i < 12; i++) await send(page, { type: 'executionState', conversationId: 'assist-1', busy: true, execution: { status: 'running', streamText: 'Live ' + i } });
  assert.equal(await page.evaluate(() => changeCardCalls), 0);
  const summary = { revision: 1, added: 1, removed: 0, files: [{ id: 'file', path: 'updated.txt', root: 0, state: 'applied', operation: 'create', added: 1, removed: 0 }] };
  await send(page, { ...initial, codeChanges: { 'turn-0': summary } });
  assert.equal(await page.getByRole('button', { name: 'updated.txt', exact: true }).count(), 1);
  await send(page, { type: 'executionState', conversationId: 'assist-1', busy: false, execution: { status: 'completed' } });
  assert.equal(await page.getByRole('button', { name: '一键撤销本轮全部修改', exact: true }).isEnabled(), true);
});

let browser;
test('released message actions cannot revive timers or mutate replacement content', async t => {
  const page = await pageFor(t);
  const result = await page.evaluate(async () => {
    const element = document.createElement('div'); document.body.append(element);
    const original = window.setTimeout;
    let resets = 0, resolveCopy, rejectOpen;
    window.setTimeout = (fn, delay, ...args) => { if ([1400, 1600].includes(delay)) resets++; return original(fn, delay, ...args); };
    try {
      UBOVMMessage.update(element, '', { parts: [{ id: 'tool', type: 'tool', name: 'read_workspace_file', args: '{"path":"a.txt"}', output: 'hello', status: 'completed' }],
        onCopy: () => new Promise(resolve => { resolveCopy = resolve; }), onOpenLink: () => new Promise((_, reject) => { rejectOpen = reject; }) });
      element.querySelectorAll('.tool-action').forEach(button => { if (['复制输出', '打开文件'].includes(button.textContent)) button.click(); });
      UBOVMMessage.release(element);
      resolveCopy(true); rejectOpen(Error('late failure'));
      await Promise.resolve(); await Promise.resolve();
      const toolResets = resets;
      UBOVMMessage.update(element, '```js\noriginal\n```', { onCopy: () => new Promise(resolve => { resolveCopy = resolve; }) });
      element.querySelector('[data-md-copy]').click(); await Promise.resolve();
      UBOVMMessage.release(element);
      UBOVMMessage.update(element, 'replacement');
      resolveCopy(true); for (let i = 0; i < 8; i++) await Promise.resolve();
      const text = element.textContent.trim();
      UBOVMMessage.release(element); element.remove();
      return { toolResets, resets, text };
    } finally { window.setTimeout = original; }
  });
  assert.deepEqual(result, { toolResets: 0, resets: 0, text: 'replacement' });
});
test.before(async () => {
  browser = await chromium.launch({ headless: true, executablePath: process.env.UBOVM_STYLE_EDGE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' });
});
test.after(async () => { await browser?.close(); });

const state = (id = 'assist-1', mode = 'assist') => ({
  type: 'state', mode, conversation: { id, title: '渲染测试' }, messages: [],
  provider: { label: '测试模型', connected: true }, context: { workspace: '测试工作区' },
  execution: { status: 'idle', parts: [], workers: [], activities: [] }, busy: false,
  ...(mode === 'goal' ? { goal: { objective: '验证各栏目的加载', criteria: [{ id: 'criterion-1', text: '保留输入与阅读位置', done: false }], notes: [{ text: '保留已有笔记', createdAt: new Date().toISOString() }] } } : {})
});

test('goal streaming skips static accessibility mutations and repeated criteria serialization', async t => {
  const page = await pageFor(t);
  const snapshot = state('stable-goal', 'goal'); snapshot.busy = true;
  snapshot.execution = { status: 'running', busy: true, streamText: '开始', parts: [], workers: [], activities: [] };
  await page.evaluate(snapshot => {
    window.trackedCriteria = snapshot.goal.criteria;
    window.dispatchEvent(new MessageEvent('message', { data: snapshot }));
  }, snapshot);
  await page.waitForFunction(() => document.querySelector('#criteria-list input'));
  await paint(page);
  await page.evaluate(() => {
    window.criteriaSerializations = 0; window.staticGoalMutations = 0;
    const original = JSON.stringify;
    JSON.stringify = function (value, ...args) { if (value === trackedCriteria) criteriaSerializations++; return original.call(this, value, ...args); };
    const observer = new MutationObserver(records => { staticGoalMutations += records.length; });
    for (const id of ['goal-notes', 'goal-mode', 'assist-notes-toggle', 'goal-completion', 'messages']) observer.observe(document.getElementById(id), { attributes: true });
  });
  for (let index = 0; index < 6; index++) await send(page, {
    type: 'executionState', conversationId: snapshot.conversation.id, busy: true,
    execution: { status: 'running', busy: true, streamText: '输出 ' + index, parts: [], workers: [], activities: [] }
  });
  assert.deepEqual(await page.evaluate(() => ({ serializations: criteriaSerializations, mutations: staticGoalMutations })), { serializations: 0, mutations: 0 });
  const changed = structuredClone(snapshot); changed.goal.criteria[0].done = true;
  await send(page, changed);
  await page.waitForFunction(() => document.querySelector('#criteria-list input').checked);
  assert.equal(await page.locator('#goal-completion').getAttribute('value'), '1');
});

test('appending a note allocates only the new row and retains reading focus', async t => {
  const page = await pageFor(t);
  const snapshot = state('incremental-notes', 'goal');
  snapshot.goal.notes = Array.from({ length: 40 }, (_, index) => ({ id: 'note-' + index, text: '笔记 ' + index, createdAt: 1700000000000 + index }));
  await send(page, snapshot);
  await page.locator('#goal-view-switcher > summary').click(); await page.locator('#goal-tab-notes').click();
  await page.waitForFunction(() => document.querySelectorAll('#goal-notes-list article').length === 40);
  await page.evaluate(() => {
    window.originalNote = document.querySelector('#goal-notes-list article');
    window.noteFocus = originalNote.querySelector('button'); noteFocus.focus();
    window.noteAllocations = 0; const original = document.createElement;
    document.createElement = function (tag, ...args) { if (tag === 'article') noteAllocations++; return original.call(this, tag, ...args); };
  });
  snapshot.goal.notes.push({ id: 'note-40', text: '新增笔记', createdAt: 1700000000040 });
  await send(page, snapshot);
  await page.waitForFunction(() => document.querySelectorAll('#goal-notes-list article').length === 41);
  assert.deepEqual(await page.evaluate(() => ({ allocations: noteAllocations, retained: document.querySelectorAll('#goal-notes-list article')[1] === originalNote, focused: document.activeElement === noteFocus })),
    { allocations: 1, retained: true, focused: true });
});

test('conversation navigation releases both historical and streaming message components immediately', async t => {
  const page = await pageFor(t);
  await page.evaluate(() => {
    const original = UBOVMMessage;
    window.releasedMessages = [];
    window.UBOVMMessage = { ...original, release(element) { if (element.classList.contains('message-text')) window.releasedMessages.push(element.textContent.trim()); return original.release(element); } };
  });
  const first = state('cleanup-first');
  first.messages = [{ id: 'saved', role: 'assistant', text: '已保存回复' }];
  first.busy = true;
  first.execution = { status: 'running', busy: true, parts: [{ id: 'live', type: 'text', text: '正在回复' }], workers: [], activities: [] };
  await send(page, first);
  await page.waitForFunction(() => document.querySelectorAll('#messages .message-text').length >= 2);
  await send(page, state('cleanup-second'));
  await page.waitForFunction(() => window.releasedMessages.length === 2);
  assert.deepEqual(await page.evaluate(() => window.releasedMessages), ['已保存回复', '正在回复']);
  assert.equal(await page.locator('#messages .message-text').count(), 0);
});

test('composer accepts a dropped text file and rejects multiple files without sending a prompt', async t => {
  const page = await pageFor(t); await send(page, state('file-drop'));
  await page.locator('#prompt-input').fill('保留草稿');
  await page.evaluate(() => {
    const transfer = new DataTransfer(); transfer.items.add(new File(['文件内容'], 'notes.txt', { type: 'text/plain' }));
    document.getElementById('prompt-form').dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }));
  });
  await page.waitForFunction(() => sent.some(item => item.action === 'attachFile'));
  const request = await page.evaluate(() => sent.find(item => item.action === 'attachFile'));
  assert.deepEqual(request.attachment, { name: 'notes.txt', content: '文件内容', truncated: false });
  assert.equal(request.sessionId, 'file-drop');
  assert.equal(await page.locator('#prompt-input').inputValue(), '保留草稿');
  assert.equal(await page.evaluate(() => sent.some(item => item.action === 'prompt')), false);
  await send(page, { type: 'uiResult', requestId: request.requestId, ok: true });
  await page.evaluate(() => {
    const transfer = new DataTransfer(); transfer.items.add(new File(['a'], 'a.txt')); transfer.items.add(new File(['b'], 'b.txt'));
    document.getElementById('prompt-form').dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }));
  });
  assert.match(await page.locator('#ui-error-message').textContent(), /一次支持一个文件/);
  assert.equal(await page.evaluate(() => sent.filter(item => item.action === 'attachFile').length), 1);
});

test('late file reads cannot attach across navigation or unlock another pending drop', async t => {
  const page = await pageFor(t); await send(page, state('drop-a'));
  await page.evaluate(() => {
    window.reads = [];
    Blob.prototype.arrayBuffer = () => new Promise(resolve => reads.push(resolve));
    window.dropFile = name => {
      const transfer = new DataTransfer(); transfer.items.add(new File(['content'], name));
      document.getElementById('prompt-form').dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }));
    };
    dropFile('old-a.txt');
  });
  await send(page, state('drop-b'));
  await page.evaluate(() => dropFile('new-b.txt'));
  assert.equal(await page.evaluate(() => reads.length), 2, 'old reads must not block the new session');
  await page.evaluate(() => reads[0](new TextEncoder().encode('old').buffer)); await paint(page);
  assert.equal(await page.evaluate(() => sent.filter(item => item.action === 'attachFile').length), 0);
  assert.equal(await page.locator('#attach-file').isDisabled(), true, 'late finally must not unlock the active read');
  await page.evaluate(() => reads[1](new TextEncoder().encode('new').buffer)); await paint(page);
  const attached = await page.evaluate(() => sent.find(item => item.action === 'attachFile'));
  assert.equal(attached.sessionId, 'drop-b'); assert.equal(attached.attachment.content, 'new');
  await send(page, { type: 'uiResult', requestId: attached.requestId, ok: true });
  await send(page, state('drop-a')); await page.evaluate(() => dropFile('stale-roundtrip.txt'));
  await send(page, state('drop-b')); await send(page, state('drop-a'));
  await page.evaluate(() => reads[2](new TextEncoder().encode('roundtrip').buffer)); await paint(page);
  assert.equal(await page.evaluate(() => sent.filter(item => item.action === 'attachFile').length), 1);
  assert.equal(await page.locator('#attach-file').isDisabled(), false);
});

test('composer accepts IDE resource links and leaves ordinary text drags alone', async t => {
  const page = await pageFor(t); await send(page, state('resource-drop'));
  const ignored = await page.evaluate(() => {
    const transfer = new DataTransfer(); transfer.setData('text/plain', '普通文本');
    return document.getElementById('prompt-form').dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }));
  });
  assert.equal(ignored, true);
  await page.evaluate(() => {
    const transfer = new DataTransfer(); transfer.setData('ResourceURLs', JSON.stringify(['file:///C:/project/readme.md']));
    const form = document.getElementById('prompt-form');
    form.dispatchEvent(new DragEvent('dragenter', { dataTransfer: transfer, bubbles: true, cancelable: true }));
    form.dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }));
  });
  await page.waitForFunction(() => sent.some(item => item.action === 'attachFile'));
  assert.deepEqual(await page.evaluate(() => sent.find(item => item.action === 'attachFile').attachment), { uri: 'file:///C:/project/readme.md' });
  assert.equal(await page.locator('#prompt-form').evaluate(form => form.classList.contains('file-drag-over')), false);
});

test('composer owns the full file drag sequence before the webview host can open an editor', async t => {
  const page = await pageFor(t); await send(page, state('owned-drop'));
  const result = await page.evaluate(() => {
    const escaped = [], prevented = [];
    for (const type of ['dragenter', 'dragover', 'drop']) window.addEventListener(type, () => escaped.push(type));
    const transfer = new DataTransfer(); transfer.items.add(new File(['text'], 'owned.txt'));
    for (const type of ['dragenter', 'dragover', 'drop']) {
      const event = new DragEvent(type, { dataTransfer: transfer, bubbles: true, cancelable: true });
      document.getElementById('prompt-input').dispatchEvent(event); prevented.push(event.defaultPrevented);
    }
    return { escaped, prevented };
  });
  assert.deepEqual(result, { escaped: [], prevented: [true, true, true] });
  await page.waitForFunction(() => sent.some(item => item.action === 'attachFile'));
});

test('linked goals and source chats render safe navigation and clear on unrelated sessions', async t => {
  const page = await pageFor(t);
  await send(page, { ...state('source'), relatedConversations: [{ id: 'target', mode: 'goal', title: '<目标>' }] });
  const button = page.locator('#related-conversations button');
  assert.equal(await button.textContent(), '目标：<目标>');
  await button.click();
  assert.deepEqual(await page.evaluate(() => sent.findLast(item => item.action === 'openRelatedConversation')),
    { action: 'openRelatedConversation', sessionId: 'source', targetId: 'target' });
  await send(page, { ...state('target', 'goal'), relatedConversations: [{ id: 'source', mode: 'assist', title: '原聊天' }] });
  assert.equal(await button.textContent(), '来源聊天：原聊天');
  await button.click();
  assert.equal(await page.evaluate(() => sent.findLast(item => item.action === 'openRelatedConversation').targetId), 'source');
  await send(page, state('unrelated'));
  assert.equal(await page.locator('#related-conversations').isVisible(), false);
});

test('code highlighting bounds long lines and dense tokens while preserving complete text', async t => {
  const page = await pageFor(t);
  const result = await page.evaluate(async () => {
    const target = document.createElement('div'); document.body.append(target);
    let copied;
    const options = { streaming: true, onCopy: value => { copied = value; } };
    try {
      const dense = '1 '.repeat(2000);
      UBOVMMarkdown.update(target, '```js\n' + dense, options);
      const bounded = target.querySelectorAll('.md-token-number').length === 512;
      const denseIntact = target.querySelector('code').textContent === dense;
      const payload = '9'.repeat(100000) + '<script>alert(1)</script>';
      UBOVMMarkdown.update(target, '```js\n' + payload, options);
      const plain = target.querySelector('code').childNodes.length === 1 && target.querySelector('.md-code-line').childNodes.length === 1;
      target.querySelector('[data-md-copy]').click();
      await new Promise(resolve => setTimeout(resolve, 0));
      const copiedAll = copied === payload;
      UBOVMMarkdown.update(target, '```js\n' + payload + 'x\n```', { ...options, streaming: false });
      const complete = target.querySelector('code').textContent === payload + 'x' && !target.querySelector('script');
      UBOVMMarkdown.update(target, '```js\nconst answer = 1;', options);
      return { bounded, denseIntact, plain, copiedAll, complete: Boolean(complete), restored: target.querySelector('.md-token-keyword')?.textContent === 'const' };
    } finally { UBOVMMarkdown.release(target); target.remove(); }
  });
  assert.deepEqual(result, { bounded: true, denseIntact: true, plain: true, copiedAll: true, complete: true, restored: true });
});

test('long invalid numeric identifiers do not retry highlighting at every character', async t => {
  const page = await pageFor(t);
  const result = await page.evaluate(() => {
    const target = document.createElement('div'); document.body.append(target);
    const exec = RegExp.prototype.exec;
    let numericAttempts = 0;
    RegExp.prototype.exec = function (...args) {
      if (this.source.includes('0x[')) numericAttempts++;
      return Reflect.apply(exec, this, args);
    };
    try {
      const body = '9'.repeat(4000) + 'suffix';
      UBOVMMarkdown.update(target, '```js\n' + body, { streaming: true });
      return { numericAttempts, intact: target.querySelector('code').textContent === body, spans: target.querySelectorAll('.md-token-number').length };
    } finally { RegExp.prototype.exec = exec; UBOVMMarkdown.release(target); target.remove(); }
  });
  assert.equal(result.intact, true); assert.equal(result.spans, 0);
  assert.ok(result.numericAttempts <= 2, JSON.stringify(result));
});

test('code streaming leaves unchanged toolbar attributes untouched and refreshes preview capabilities', async t => {
  const page = await pageFor(t);
  const result = await page.evaluate(() => {
    const target = document.createElement('div'); document.body.append(target);
    try {
      let text = '```html\n<div>';
      UBOVMMarkdown.update(target, text, { streaming: true });
      const toolbar = target.querySelector('.md-code-toolbar');
      const observer = new MutationObserver(() => {}); observer.observe(toolbar, { subtree: true, attributes: true });
      for (let i = 0; i < 50; i++) { text += 'x'; UBOVMMarkdown.update(target, text, { streaming: true }); }
      const mutations = observer.takeRecords().length; observer.disconnect();
      let previews = 0;
      UBOVMMarkdown.update(target, text, { streaming: true, onPreviewHtml: () => { previews++; } });
      const button = target.querySelector('[data-md-code-preview]');
      const enabled = !button.disabled; button.click();
      UBOVMMarkdown.update(target, text, { streaming: true });
      const disabled = button.disabled;
      const nested = '> ```html\n> <div>nested</div>\n> ```';
      UBOVMMarkdown.update(target, nested, {});
      UBOVMMarkdown.update(target, nested, { onPreviewHtml: () => { previews++; } });
      const nestedEnabled = !target.querySelector('[data-md-code-preview]').disabled;
      return { mutations, enabled, disabled, previews, nestedEnabled };
    } finally { UBOVMMarkdown.release(target); target.remove(); }
  });
  assert.deepEqual(result, { mutations: 0, enabled: true, disabled: true, previews: 1, nestedEnabled: true });
});

test('code line bursts commit together and retry safely after a highlighting failure', async t => {
  const page = await pageFor(t);
  const result = await page.evaluate(() => {
    const target = document.createElement('div'), reference = document.createElement('div');
    document.body.append(target, reference);
    const create = document.createElement;
    try {
      const start = '```js\nconst first = 1;';
      UBOVMMarkdown.update(target, start, { streaming: true });
      const code = target.querySelector('code'), first = code.firstChild;
      const observer = new MutationObserver(() => {}); observer.observe(code, { childList: true });
      const text = start + '\n' + 'const next = 2;\n'.repeat(1000);
      UBOVMMarkdown.update(target, text, { streaming: true });
      const commits = observer.takeRecords().length; observer.disconnect();
      let remaining = 5, failed = false;
      document.createElement = function (...args) {
        if (--remaining === 0) throw Error('injected highlighter failure');
        return Reflect.apply(create, this, args);
      };
      const next = text + 'const recovered = 3;\n'.repeat(20);
      try { UBOVMMarkdown.update(target, next, { streaming: true }); } catch { failed = true; }
      document.createElement = create;
      UBOVMMarkdown.update(target, next, { streaming: true });
      UBOVMMarkdown.update(reference, next, { streaming: true });
      return { commits, retained: first === code.firstChild, failed, recovered: target.innerHTML === reference.innerHTML };
    } finally { document.createElement = create; UBOVMMarkdown.release(target); UBOVMMarkdown.release(reference); target.remove(); reference.remove(); }
  });
  assert.deepEqual(result, { commits: 1, retained: true, failed: true, recovered: true });
});

test('empty fences remain streaming until a distinct closing line arrives', async t => {
  const page = await pageFor(t);
  const result = await page.evaluate(() => {
    const target = document.createElement('div'); document.body.append(target);
    const states = [];
    try {
      for (const text of ['```', '```\n', '```\n\n', '```\n\nx', '```\n\nx\n```']) {
        UBOVMMarkdown.update(target, text, { streaming: true });
        states.push(target.querySelector('.md-code-card').dataset.streaming);
      }
      return states;
    } finally { UBOVMMarkdown.release(target); target.remove(); }
  });
  assert.deepEqual(result, ['true', 'true', 'true', 'true', 'false']);
});

test('long streaming fences skip repeated lexing and match full rendering after close and rewrite', async t => {
  const page = await pageFor(t);
  const result = await page.evaluate(() => {
    const target = document.createElement('div'), reference = document.createElement('div');
    document.body.append(target, reference);
    const prefix = Array.from({ length: 120 }, (_, i) => `段落 ${i} **已完成** [引用][ref]\n\n`).join('');
    let source = prefix + '```js\n' + 'const stable = 1;\n'.repeat(200);
    UBOVMMarkdown.update(target, source, { streaming: true });
    const first = target.firstChild, line = target.querySelector('.md-code-line');
    const original = globalThis.marked, sizes = [];
    globalThis.marked = { ...original, lexer(value, options) { sizes.push(value.length); return original.lexer(value, options); } };
    try {
      for (let i = 0; i < 30; i++) {
        source += `const next${i} = ${i};\n`;
        UBOVMMarkdown.update(target, source, { streaming: true });
      }
    } finally { globalThis.marked = original; }
    const reused = first === target.firstChild && line === target.querySelector('.md-code-line');
    const lexerCalls = sizes.length;
    source += '```\n\n[ref]: https://example.com\n\n完成。';
    UBOVMMarkdown.update(target, source, { streaming: false });
    UBOVMMarkdown.update(reference, source, { streaming: false });
    const completeMatches = target.innerHTML === reference.innerHTML;
    source = '```python\nprint("改写")\n```';
    UBOVMMarkdown.update(target, source, { streaming: false });
    UBOVMMarkdown.update(reference, source, { streaming: false });
    return { reused, lexerCalls, completeMatches, rewriteMatches: target.innerHTML === reference.innerHTML };
  });
  assert.deepEqual(result, { reused: true, lexerCalls: 0, completeMatches: true, rewriteMatches: true });
});

test('Markdown repairs externally replaced children without duplicate action handlers', async t => {
  const page = await pageFor(t);
  const result = await page.evaluate(async () => {
    const target = document.createElement('div'); document.body.append(target);
    let copied = 0;
    const options = { onCopy: () => { copied++; } }, text = '**保留内容**\n\n```js\nconst x = 1;\n```';
    UBOVMMarkdown.update(target, text, options);
    target.replaceChildren(document.createTextNode('临时错误提示'));
    const changed = UBOVMMarkdown.update(target, text, options);
    target.querySelector('.md-code-actions').lastElementChild.click();
    await new Promise(resolve => setTimeout(resolve, 0));
    const textResult = target.querySelector('strong')?.textContent, codeResult = target.querySelector('code')?.textContent;
    UBOVMMarkdown.update(target, '', options);
    target.append(document.createTextNode('过期错误提示'));
    UBOVMMarkdown.update(target, '', options);
    return { changed, copied, text: textResult, code: codeResult, empty: target.textContent === '' };
  });
  assert.deepEqual(result, { changed: true, copied: 1, text: '保留内容', code: 'const x = 1;', empty: true });
});

test('acknowledgement callback failures release controls and retry rendering without replaying actions', async t => {
  const page = await pageFor(t);
  await send(page, state());
  await page.locator('#attach-file').click();
  const requestId = await page.evaluate(() => sent.find(message => message.action === 'attachFile').requestId);
  await page.evaluate(() => {
    const input = document.getElementById('prompt-input');
    window.savedFocus = input.focus; input.focus = () => { throw Error('focus failed'); };
  });
  await send(page, { type: 'uiResult', requestId, ok: true });
  assert.equal(await page.locator('#attach-file').isEnabled(), true);
  assert.equal(await page.locator('#ui-render-retry').isVisible(), true);
  await page.evaluate(() => { document.getElementById('prompt-input').focus = savedFocus; });
  await page.locator('#ui-render-retry').click();
  await page.waitForFunction(() => document.getElementById('ui-render-retry').hidden);
  assert.equal(await page.evaluate(() => sent.filter(message => message.action === 'attachFile').length), 1);
});

test('execution updates leave static page attributes untouched and publish final content', async t => {
  const page = await pageFor(t);
  await send(page, state());
  await page.waitForFunction(() => document.getElementById('conversation-title').textContent === '渲染测试');
  await paint(page);
  await page.evaluate(() => {
    window.staticMutations = 0;
    new MutationObserver(records => { window.staticMutations += records.length; }).observe(document.getElementById('conversation-title'), { attributes: true, childList: true });
  });
  await send(page, { type: 'executionState', conversationId: 'assist-1', busy: true, execution: { status: 'running', busy: true, streamText: '实时输出', parts: [] } });
  assert.match(await page.locator('#messages').textContent(), /实时输出/);
  assert.equal(await page.evaluate(() => window.staticMutations), 0);
  await send(page, { ...state(), messages: [{ role: 'assistant', text: '最终输出' }] });
  assert.match(await page.locator('#messages').textContent(), /最终输出/);
});

test('streaming does not mutate unchanged composer controls or measure their layout', async t => {
  const page = await pageFor(t);
  await send(page, { ...state(), busy: true, execution: { status: 'running', streamText: 'Start' } });
  await paint(page);
  await page.evaluate(() => {
    window.controlChanges = 0; window.composerMeasurements = 0;
    new MutationObserver(records => { controlChanges += records.length; }).observe(document.getElementById('prompt-form'), { subtree: true, attributes: true, childList: true, characterData: true });
    const field = document.getElementById('prompt-input');
    const width = Object.getOwnPropertyDescriptor(Element.prototype, 'clientWidth').get;
    Object.defineProperty(field, 'clientWidth', { configurable: true, get() { composerMeasurements++; return width.call(this); } });
  });
  for (let i = 0; i < 12; i++) {
    await send(page, { type: 'executionState', conversationId: 'assist-1', busy: true, execution: { status: 'running', streamText: 'Live ' + i } });
    await page.waitForFunction(value => document.querySelector('.streaming-message')?.textContent.includes(value), 'Live ' + i);
  }
  const counts = await page.evaluate(() => ({ mutations: controlChanges, measurements: composerMeasurements }));
  t.diagnostic(JSON.stringify(counts));
  assert.deepEqual(counts, { mutations: 0, measurements: 0 });
  await page.locator('#prompt-input').fill('草稿\n'.repeat(20));
  await paint(page);
  assert(await page.locator('#prompt-input').evaluate(field => field.clientHeight > 64), 'typing still resizes the composer');
  await send(page, { type: 'executionState', conversationId: 'assist-1', busy: false, execution: { status: 'completed' } });
  assert.equal(await page.locator('#submit-prompt').getAttribute('data-action-mode'), 'send');
});

test('outline marker animations keep layout width fixed and respect reduced motion', async t => {
  const page = await pageFor(t);
  await send(page, state());
  const result = await page.evaluate(() => {
    const button = document.createElement('button'); button.className = 'outline-turn';
    const mark = document.createElement('span'); mark.className = 'outline-mark'; button.append(mark);
    document.body.append(button);
    const before = mark.offsetWidth;
    button.setAttribute('aria-current', 'true');
    const after = mark.offsetWidth;
    const transition = getComputedStyle(mark).transitionProperty;
    button.id = 'motion-probe';
    return { before, after, transition };
  });
  assert.equal(result.before, result.after);
  assert.equal(result.transition, 'transform, opacity');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await page.locator('#motion-probe .outline-mark').evaluate(mark => getComputedStyle(mark).transitionDuration), '0s');
});

test('streaming updates do not rescan unchanged published history', async t => {
  const page = await pageFor(t);
  await send(page, state());
  await page.evaluate(() => {
    window.historyReads = 0;
    const items = Array.from({ length: 100 }, (_, i) => ({ get role() { window.historyReads++; return 'assistant'; }, text: 'History ' + i }));
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'state', mode: 'assist', conversation: { id: 'assist-1' }, messages: items, execution: {} } }));
  });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.evaluate(() => { window.historyReads = 0; });
  for (let i = 0; i < 5; i++) await send(page, { type: 'executionState', conversationId: 'assist-1', busy: true, execution: { status: 'running', streamText: 'Live ' + i } });
  assert.equal(await page.evaluate(() => window.historyReads), 0);
  assert.match(await page.locator('#messages').textContent(), /Live 4/);
});

test('hidden panels defer rendering and reopening displays the latest state', async t => {
  const page = await pageFor(t);
  const current = state('deferred-panels', 'goal');
  current.execution.workers = [{ id: 'w1', name: 'First worker', status: 'running' }];
  current.execution.parts = [{ id: 'p1', type: 'text', text: 'First output' }];
  await send(page, current);
  assert.equal(await page.locator('#goal-workers-list .worker-card').count(), 0, 'unopened directory has no cards');
  await page.locator('#goal-view-switcher > summary').click(); await page.locator('#goal-tab-notes').click(); await paint(page);
  await page.evaluate(() => {
    window.hiddenChanges = 0;
    const observer = new MutationObserver(records => { window.hiddenChanges += records.length; });
    for (const id of ['goal-output-content', 'goal-workers-list']) observer.observe(document.getElementById(id), { subtree: true, childList: true, attributes: true, characterData: true });
  });
  current.execution.workers[0].name = 'Updated worker';
  current.execution.parts[0].text = 'Latest output';
  await send(page, current);
  assert.equal(await page.evaluate(() => window.hiddenChanges), 0);
  await page.locator('#goal-view-switcher > summary').click(); await page.locator('#goal-tab-overview').click();
  await page.waitForFunction(() => document.getElementById('goal-output-content').textContent.includes('Latest output'));
  await page.locator('#goal-view-switcher > summary').click(); await page.locator('#goal-tab-workers').click(); await paint(page);
  assert.match(await page.locator('#goal-workers-list').textContent(), /Updated worker/);
});

test('unchanged execution logs keep headers and worker links intact during streaming', async t => {
  const page = await pageFor(t);
  const current = state('stable-logs', 'goal');
  current.execution.workers = [{ id: 'w1', name: 'Worker', status: 'running', createdAt: 1000 }];
  current.execution.parts = [{ id: 'p1', type: 'text', text: 'Live', startedAt: 2000 }];
  await send(page, current);
  await page.evaluate(() => {
    window.stableChanges = 0;
    new MutationObserver(records => { window.stableChanges += records.length; }).observe(document.querySelector('[data-log-id="worker:w1"]'), { subtree: true, childList: true, attributes: true, characterData: true });
  });
  current.execution.parts[0].text += ' updated'; current.execution.busy = true;
  await send(page, current);
  assert.equal(await page.evaluate(() => window.stableChanges), 0);
});

test('large overview history avoids serialization and only updates changed bodies', async t => {
  const page = await pageFor(t);
  const result = await page.evaluate(() => {
    const container = document.createElement('div'); document.body.append(container);
    const original = window.UBOVMMessage, stringify = JSON.stringify;
    let updates = 0, released = 0, serialized = 0;
    window.UBOVMMessage = { update() { updates++; }, release() { released++; } };
    try {
      const log = createGoalExecutionLog(container, { actions: {}, statusText: value => value, openWorker() {} });
      const parts = Array.from({ length: 200 }, (_, i) => ({ id: String(i), type: 'tool', name: 'read', status: 'completed', output: 'x'.repeat(20000), startedAt: 1000 + i }));
      log.update('large', { parts }); updates = 0;
      const headings = new MutationObserver(() => {});
      for (const heading of container.querySelectorAll('header')) headings.observe(heading, { subtree: true, childList: true, attributes: true, characterData: true });
      JSON.stringify = (...args) => { serialized++; return stringify(...args); };
      parts[199] = { ...parts[199], output: 'changed' };
      log.update('large', { parts: parts.map(part => ({ ...part })) });
      const changes = headings.takeRecords().length; headings.disconnect();
      const changedUpdates = updates;
      log.update('large', { parts: parts.slice(1) });
      log.update('next', { parts: [] });
      return { updates: changedUpdates, serialized, changes, released };
    } finally { JSON.stringify = stringify; window.UBOVMMessage = original; container.remove(); }
  });
  assert.deepEqual(result, { updates: 1, serialized: 0, changes: 0, released: 120 });
});

test('expensive overview streams yield, coalesce latest state and prioritize completion', async t => {
  const page = await pageFor(t);
  await page.evaluate(() => {
    const create = window.createGoalExecutionLog;
    window.logPaints = 0;
    window.createGoalExecutionLog = (...args) => {
      const log = create(...args);
      return { ...log, update(...values) {
        window.logPaints++;
        if (window.logPaints === 1 || window.slowPaint) { window.slowPaint = false; const end = performance.now() + 90; while (performance.now() < end) {} }
        return log.update(...values);
      } };
    };
  });
  const current = state('yielding', 'goal'); current.busy = true;
  current.execution = { status: 'running', busy: true, streamText: 'initial' };
  await send(page, current);
  const counts = await page.evaluate(async () => {
    const before = logPaints;
    for (let i = 0; i < 10; i++) window.dispatchEvent(new MessageEvent('message', { data: {
      type: 'executionState', conversationId: 'yielding', busy: true,
      execution: { status: 'running', busy: true, streamText: 'latest-' + i }
    } }));
    await new Promise(resolve => setTimeout(resolve, 20));
    return { before, after: logPaints };
  });
  assert.equal(counts.after, counts.before, 'input tasks run while a heavy paint rests');
  await page.waitForFunction(() => document.getElementById('goal-output-content').textContent.includes('latest-9'));
  assert.equal(await page.evaluate(() => logPaints), counts.before + 1);
  await page.evaluate(() => { window.slowPaint = true; });
  await send(page, current);
  await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: {
    type: 'executionState', conversationId: 'yielding', busy: true,
    execution: { status: 'running', busy: true, streamText: 'pending stale output' }
  } })));
  await send(page, { type: 'executionState', conversationId: 'yielding', busy: false,
    execution: { status: 'completed', busy: false, streamText: 'final answer' } });
  assert.match(await page.locator('#goal-output-content').textContent(), /final answer/);
  await send(page, state('replacement', 'goal'));
  await page.waitForTimeout(300);
  assert.doesNotMatch(await page.locator('#goal-output-content').textContent(), /latest-9|final answer|pending stale output/);
});

test('expensive assist streams yield to input and discard deferred output after session changes', async t => {
  const page = await pageFor(t);
  await page.evaluate(() => {
    const original = UBOVMMessage;
    window.messagePaints = 0;
    window.UBOVMMessage = { ...original, update(...args) {
      messagePaints++;
      if (messagePaints === 1 || window.slowPaint) {
        window.slowPaint = false;
        const end = performance.now() + 90; while (performance.now() < end) {}
      }
      return original.update(...args);
    } };
  });
  const current = { ...state('assist-yield'), busy: true,
    execution: { status: 'running', streamText: 'initial' } };
  await send(page, current);
  const counts = await page.evaluate(async () => {
    const before = messagePaints;
    for (let i = 0; i < 80; i++) dispatchEvent(new MessageEvent('message', { data: {
      type: 'executionState', conversationId: 'assist-yield', busy: true,
      execution: { status: 'running', streamText: 'latest-' + i }
    } }));
    const input = document.getElementById('prompt-input');
    input.value = '保留输入'; input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 20));
    return { before, after: messagePaints, input: input.value };
  });
  assert.equal(counts.after, counts.before);
  assert.equal(counts.input, '保留输入');
  await page.waitForFunction(() => document.getElementById('messages').textContent.includes('latest-79'));
  assert.equal(await page.evaluate(() => messagePaints), counts.before + 1);
  await page.evaluate(() => { window.slowPaint = true; });
  await send(page, current);
  await send(page, { type: 'executionState', conversationId: 'assist-yield', busy: false,
    execution: { status: 'completed', parts: [{ id: 'answer', type: 'text', status: 'completed', text: 'final answer' }] } });
  assert.equal(await page.locator('.streaming-message').count(), 0, 'completion bypasses the stream rest period');
  await send(page, { ...state('assist-yield'), messages: [{ role: 'assistant', text: 'final answer' }] });
  assert.match(await page.locator('#messages').textContent(), /final answer/);
  await page.evaluate(() => { window.slowPaint = true; });
  await send(page, current);
  await page.evaluate(() => dispatchEvent(new MessageEvent('message', { data: {
    type: 'executionState', conversationId: 'assist-yield', busy: true,
    execution: { status: 'running', streamText: 'stale deferred content' }
  } })));
  await send(page, state('replacement-assist'));
  await page.waitForTimeout(300);
  assert.equal(await page.locator('#messages article').count(), 0);
});

test('long conversation navigation bounds layout reads and reuses the published history index', async t => {
  const page = await pageFor(t);
  const result = await page.evaluate(async () => {
    const scroller = document.getElementById('conversation');
    const messages = document.getElementById('messages');
    Object.defineProperty(scroller, 'clientHeight', { value: 600, configurable: true });
    scroller.getBoundingClientRect = () => ({ top: 0 });
    let reads = 0, scans = 0, position = 999;
    const entries = Array.from({ length: 1024 }, (_, i) => {
      const article = document.createElement('article'); messages.append(article);
      article.getBoundingClientRect = () => { reads++; return { top: (i - position) * 100 }; };
      return { article, role: 'user', text: '消息 ' + i };
    });
    entries.filter = (...args) => { scans++; return Array.prototype.filter.apply(entries, args); };
    const outline = createConversationOutline({ scroller, beforeNavigate() {} });
    const paint = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    outline.update(entries, 'long'); await paint();
    const initial = document.querySelector('[aria-current="location"]').title;
    reads = 0;
    for (let i = 0; i < 80; i++) outline.update(entries, 'long');
    await paint();
    const repeatedReads = reads;
    position = 127; scroller.dispatchEvent(new Event('scroll')); await paint();
    const moved = document.querySelector('[aria-current="location"]').title;
    const selected = document.querySelectorAll('[aria-current="location"]').length;
    outline.update(entries.slice(0, 10), 'long'); await paint();
    const truncated = document.querySelector('[aria-current="location"]').title;
    outline.dispose();
    return { scans, repeatedReads, initial, moved, selected, truncated };
  });
  assert.equal(result.scans, 1);
  assert(result.repeatedReads <= 11, `layout reads: ${result.repeatedReads}`);
  assert.equal(result.initial, '1000. 消息 999');
  assert.equal(result.moved, '128. 消息 127');
  assert.equal(result.selected, 1);
  assert.equal(result.truncated, '10. 消息 9');
});

test('latest message control preserves reading position and resumes following after activation', async t => {
  const page = await pageFor(t);
  const current = state(); current.busy = true;
  current.messages = Array.from({ length: 25 }, (_, i) => ({ role: 'assistant', text: `消息 ${i}\n\n` + '历史内容。'.repeat(60) }));
  current.execution = { status: 'running', busy: true, streamText: '开始输出', parts: [] };
  await send(page, current);
  await page.waitForFunction(() => { const n = document.getElementById('conversation'); return n.scrollHeight - n.scrollTop - n.clientHeight < 3; });
  assert.equal(await page.locator('#conversation-latest').isVisible(), false);
  await page.locator('#conversation').evaluate(n => { n.scrollTop = 80; });
  await page.waitForFunction(() => !document.getElementById('conversation-latest').hidden);
  const top = await page.locator('#conversation').evaluate(n => n.scrollTop);
  await send(page, { type: 'executionState', conversationId: 'assist-1', busy: true, execution: { ...current.execution, streamText: '持续输出\n\n'.repeat(25) } });
  assert.equal(await page.locator('#conversation').evaluate(n => n.scrollTop), top);
  await page.locator('#conversation-latest').focus(); await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.getElementById('conversation-latest').hidden);
  await send(page, { type: 'executionState', conversationId: 'assist-1', busy: true, execution: { ...current.execution, streamText: '持续输出\n\n'.repeat(30) } });
  await page.waitForFunction(() => { const n = document.getElementById('conversation'); return n.scrollHeight - n.scrollTop - n.clientHeight < 3; });
  await send(page, state('empty-conversation'));
  assert.equal(await page.locator('#conversation-latest').isVisible(), false);
});

test('saved content paints while execution history recovers, with drafts available and execution gated', async t => {
  const page = await pageFor(t);
  const initial = { ...state(), recovering: true, messages: [{ role: 'user', text: '上次会话的内容' }] };
  await send(page, initial);
  await page.waitForFunction(() => window.sent.some(message => message.action === 'firstPaint'));
  await page.waitForFunction(() => window.sent.some(message => message.action === 'contentReady'));
  assert.equal(await page.evaluate(() => window.sent.filter(message => message.action === 'contentReady').length), 1, 'painted history reveals the sidebar even while execution recovery is pending');
  assert.equal(await page.locator('#page-loading').isVisible(), false);
  assert.match(await page.locator('#messages').textContent(), /上次会话的内容/);
  await page.locator('#prompt-input').fill('恢复期间保留草稿');
  assert.equal(await page.locator('#prompt-input').isEnabled(), true);
  assert.equal(await page.locator('#submit-prompt').isDisabled(), true);
  await send(page, { ...initial, recovering: false });
  await page.waitForFunction(() => window.sent.some(message => message.action === 'contentReady'));
  await page.waitForFunction(() => !document.getElementById('submit-prompt').disabled);
  assert.equal(await page.locator('#prompt-input').inputValue(), '恢复期间保留草稿');
  assert.equal(await page.evaluate(() => window.sent.filter(message => message.action === 'contentReady').length), 1);
});
async function pageFor(t, options = {}) {
  const page = await browser.newPage({ viewport: { width: 1000, height: 760 }, ...options });
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  t.after(async () => { await page.close(); assert.deepEqual(errors, []); });
  const html = renderWebview({ nonce: 'performance-test', workspaceName: '测试工作区' });
  await page.addInitScript(() => {
    window.persistCount = 0;
    window.sent = [];
    window.acquireVsCodeApi = () => ({
      getState: () => window.persisted,
      setState(value) { window.persisted = value; window.persistCount++; },
      postMessage(value) { window.sent.push(value); }
    });
  });
  await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: html }));
  await page.goto('http://render.test/');
  return page;
}
async function send(page, message) {
  await page.evaluate(message => window.dispatchEvent(new MessageEvent('message', { data: message })), message);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

test('switching conversations after the first paint sends another contentReady acknowledgement', async t => {
  const page = await pageFor(t);
  await send(page, state('project-session-a'));
  await page.waitForFunction(() => sent.filter(message => message.action === 'contentReady').length === 1);
  await send(page, state('project-session-b'));
  await page.waitForFunction(() => sent.filter(message => message.action === 'contentReady').length === 2);
  assert.deepEqual(
    await page.evaluate(() => sent.filter(message => message.action === 'contentReady').map(message => message.sessionId)),
    ['project-session-a', 'project-session-b']
  );
});

test('session loading fills the conversation column and switch overlay uses a thread skeleton', async t => {
  const page = await pageFor(t);
  const startup = await page.evaluate(() => {
    const loading = document.getElementById('page-loading');
    const main = document.getElementById('main-content').getBoundingClientRect();
    const box = loading.getBoundingClientRect();
    let opacity = 1;
    for (let node = loading; node; node = node.parentElement) opacity *= Number(getComputedStyle(node).opacity);
    const label = loading.querySelector('#page-loading-label').getBoundingClientRect();
    const thread = loading.querySelector('.skeleton-thread').getBoundingClientRect();
    return {
      opacity, fills: box.height > main.height * 0.55,
      thread: Boolean(loading.querySelector('.skeleton-thread')),
      composer: Boolean(loading.querySelector('.skeleton-composer')),
      statusAboveThread: label.bottom <= thread.top + 1,
    };
  });
  assert.equal(startup.opacity, 1);
  assert.equal(startup.thread, true);
  assert.equal(startup.composer, true);
  assert.equal(startup.statusAboveThread, true, 'startup status must stay readable above the thread skeleton');
  assert.equal(startup.fills, true, 'startup skeleton should occupy the conversation column');
  await send(page, state('load-session-a'));
  await page.waitForFunction(() => sent.some(message => message.action === 'contentReady'));
  const switching = await page.evaluate(next => {
    window.dispatchEvent(new MessageEvent('message', { data: next }));
    return new Promise(resolve => requestAnimationFrame(() => {
      const loader = document.getElementById('route-loading');
      resolve({
        hidden: loader.hidden,
        kind: loader.dataset.kind,
        sessionDisplay: getComputedStyle(loader.querySelector('.route-loading-session')).display,
        barsDisplay: getComputedStyle(loader.querySelector('.route-loading-lines')).display,
        opacity: getComputedStyle(loader).opacity,
        label: document.getElementById('route-loading-label').textContent,
      });
    }));
  }, state('load-session-b'));
  assert.equal(switching.hidden, false);
  assert.equal(switching.kind, 'session');
  assert.notEqual(switching.sessionDisplay, 'none');
  assert.equal(switching.barsDisplay, 'none');
  assert.equal(switching.opacity, '1');
  assert.match(switching.label, /正在加载会话/);
});

test('an open settings dialog does not block conversation contentReady after a session switch', async t => {
  const page = await pageFor(t);
  await send(page, state('settings-lock-a'));
  await page.waitForFunction(() => sent.filter(message => message.action === 'contentReady').length === 1);
  await page.evaluate(() => document.getElementById('settings-dialog').showModal());
  await send(page, state('settings-lock-b'));
  await page.waitForFunction(() => sent.filter(message => message.action === 'contentReady').length === 2);
  assert.deepEqual(
    await page.evaluate(() => sent.filter(message => message.action === 'contentReady').map(message => message.sessionId)),
    ['settings-lock-a', 'settings-lock-b']
  );
});

test('readiness follows the newest rendered session when first-paint delivery changes state', async t => {
  const page = await pageFor(t);
  const replacement = state('newest-paint');
  replacement.conversation.title = '最新完成的会话';
  await page.evaluate(replacement => {
    const api = UBOVMRuntime.api, original = api.postMessage.bind(api);
    window.readyPaints = [];
    api.postMessage = message => {
      if (message.action === 'firstPaint') window.dispatchEvent(new MessageEvent('message', { data: replacement }));
      if (message.action === 'contentReady') readyPaints.push({ sessionId: message.sessionId, title: document.getElementById('conversation-title').textContent });
      return original(message);
    };
  }, replacement);
  await send(page, state('earlier-paint'));
  await page.waitForFunction(() => readyPaints.length === 1);
  assert.deepEqual(await page.evaluate(() => readyPaints), [{ sessionId: 'newest-paint', title: '最新完成的会话' }]);
});

test('a pending first-paint bridge cannot unlock an obsolete session or duplicate readiness', async t => {
  const page = await pageFor(t);
  await page.evaluate(() => {
    const api = UBOVMRuntime.api, original = api.postMessage.bind(api);
    api.postMessage = message => {
      if (message.action === 'firstPaint') {
        original(message);
        return new Promise(resolve => { window.resolvePaint = resolve; });
      }
      return original(message);
    };
  });
  await send(page, state('pending-paint'));
  await page.waitForFunction(() => typeof resolvePaint === 'function');
  await send(page, state('replacement-paint'));
  assert.equal(await page.evaluate(() => sent.some(message => message.action === 'contentReady')), false);
  await page.evaluate(() => resolvePaint(true));
  await page.waitForFunction(() => sent.some(message => message.action === 'contentReady'));
  assert.deepEqual(await page.evaluate(() => sent.filter(message => message.action === 'contentReady').map(message => message.sessionId)), ['replacement-paint']);
});

test('rejected and refused readiness deliveries retry after fresh rendering without a frame loop', async t => {
  const page = await pageFor(t);
  await page.evaluate(() => {
    const api = UBOVMRuntime.api, original = api.postMessage.bind(api);
    window.readyAttempts = 0;
    api.postMessage = message => {
      if (message.action === 'contentReady') {
        if (++readyAttempts === 1) return Promise.reject();
        if (readyAttempts === 2) return false;
      }
      return original(message);
    };
  });
  const snapshot = state('bridge-retry');
  await send(page, snapshot);
  await page.waitForFunction(() => readyAttempts === 1);
  for (let i = 0; i < 4; i++) await paint(page);
  assert.equal(await page.evaluate(() => readyAttempts), 1);
  await send(page, snapshot);
  await page.waitForFunction(() => readyAttempts === 2);
  assert.equal(await page.evaluate(() => sent.some(message => message.action === 'contentReady')), false);
  await send(page, snapshot);
  await page.waitForFunction(() => sent.some(message => message.action === 'contentReady'));
  assert.equal(await page.evaluate(() => readyAttempts), 3);
});

test('suspended readiness delivery cannot block resume or clear a newer bridge transaction', async t => {
  const page = await pageFor(t);
  await page.evaluate(() => {
    const api = UBOVMRuntime.api, original = api.postMessage.bind(api);
    const set = window.setTimeout, clear = window.clearTimeout;
    window.pendingPaintClocks = new Set();
    window.setTimeout = (callback, delay, ...args) => {
      const id = set(callback, delay, ...args);
      if (delay === 5000) pendingPaintClocks.add(id);
      return id;
    };
    window.clearTimeout = id => { pendingPaintClocks.delete(id); clear(id); };
    window.paintResolvers = [];
    api.postMessage = message => {
      if (message.action === 'firstPaint') return new Promise(resolve => paintResolvers.push(resolve));
      return original(message);
    };
  });
  await send(page, state('suspended-bridge'));
  await page.waitForFunction(() => paintResolvers.length === 1);
  assert.equal(await page.evaluate(() => pendingPaintClocks.size), 1);
  await page.evaluate(() => { dispatchEvent(new Event('pagehide')); dispatchEvent(new Event('pageshow')); });
  await page.waitForFunction(() => paintResolvers.length === 2);
  assert.equal(await page.evaluate(() => pendingPaintClocks.size), 1, 'the old suspended delivery clock must be cancelled');
  await page.evaluate(() => paintResolvers[0](true));
  for (let i = 0; i < 3; i++) await paint(page);
  assert.equal(await page.evaluate(() => sent.some(message => message.action === 'contentReady')), false);
  assert.equal(await page.evaluate(() => paintResolvers.length), 2);
  await page.evaluate(() => paintResolvers[1](true));
  await page.waitForFunction(() => sent.some(message => message.action === 'contentReady'));
  assert.equal(await page.evaluate(() => sent.filter(message => message.action === 'contentReady').length), 1);
  assert.equal(await page.evaluate(() => pendingPaintClocks.size), 0);
});

test('stalled paint deliveries time out once, release clocks and ignore late rejection after retry', async t => {
  for (const action of ['firstPaint', 'contentReady']) {
    const page = await pageFor(t);
    await page.evaluate(action => {
      const api = UBOVMRuntime.api, original = api.postMessage.bind(api);
      const set = window.setTimeout, clear = window.clearTimeout;
      window.paintClocks = new Set();
      window.stalledDeliveries = 0;
      window.stallPaint = true;
      window.setTimeout = (callback, delay, ...args) => {
        const id = set(callback, delay, ...args);
        if (delay === 5000) { paintClocks.add(id); window.expirePaint = callback; }
        return id;
      };
      window.clearTimeout = id => { paintClocks.delete(id); clear(id); };
      api.postMessage = message => {
        if (stallPaint && message.action === action) {
          stalledDeliveries++;
          return new Promise((_, reject) => { window.rejectLatePaint = reject; });
        }
        return original(message);
      };
    }, action);
    await send(page, state('stalled-' + action));
    await page.waitForFunction(() => typeof expirePaint === 'function');
    assert.equal(await page.evaluate(() => paintClocks.size), 1);
    await page.evaluate(() => expirePaint());
    await page.locator('#runtime-recovery').waitFor({ state: 'visible' });
    assert.equal(await page.evaluate(() => paintClocks.size), 0);
    for (let i = 0; i < 3; i++) await paint(page);
    assert.equal(await page.evaluate(() => stalledDeliveries), 1, 'timeout cannot resend in a frame loop');
    await page.evaluate(() => { window.stallPaint = false; });
    await page.locator('#runtime-resync').click();
    await page.waitForFunction(() => sent.some(message => message.action === 'contentReady'));
    await page.evaluate(() => rejectLatePaint(Error('late transport failure')));
    assert.equal(await page.evaluate(() => paintClocks.size), 0);
    assert.equal(await page.locator('#runtime-recovery').isVisible(), false);
    assert.equal(await page.evaluate(() => sent.filter(message => message.action === 'contentReady').length), 1);
  }
});

test('normal paint delivery does not allocate asynchronous timeout clocks', async t => {
  const page = await pageFor(t);
  await page.evaluate(() => {
    const set = window.setTimeout;
    window.paintClockStarts = 0;
    window.setTimeout = (callback, delay, ...args) => {
      if (delay === 5000) paintClockStarts++;
      return set(callback, delay, ...args);
    };
  });
  await send(page, state('native-paint'));
  await page.waitForFunction(() => sent.some(message => message.action === 'contentReady'));
  assert.equal(await page.evaluate(() => paintClockStarts), 0);
});

test('initial state bridge failure exposes retry and ignores rejection after state recovery', async t => {
  const page = await pageFor(t);
  await page.evaluate(() => {
    const api = UBOVMRuntime.api, original = api.postMessage.bind(api);
    window.readyMode = '';
    window.consumeRetryReady = false;
    document.getElementById('page-retry').addEventListener('click', () => { window.consumeRetryReady = true; }, true);
    api.postMessage = message => {
      if (message.action === 'ready' && window.consumeRetryReady) {
        window.consumeRetryReady = false;
        if (window.readyMode === 'reject') return Promise.reject(Error('read unavailable'));
        if (window.readyMode === 'hang') return new Promise((_, reject) => { window.rejectOldRead = reject; });
      }
      return original(message);
    };
    document.getElementById('page-retry').hidden = false;
  });
  await page.evaluate(() => { window.readyMode = 'reject'; });
  await page.locator('#page-retry').click();
  await page.waitForFunction(() => !document.getElementById('page-retry').hidden);
  assert.match(await page.locator('#page-loading-label').textContent(), /连接暂时不可用/);
  await page.evaluate(() => { window.readyMode = 'hang'; });
  await page.locator('#page-retry').click();
  await send(page, state('read-recovered'));
  await page.waitForFunction(() => sent.some(message => message.action === 'contentReady'));
  await page.evaluate(() => rejectOldRead(Error('late rejection')));
  assert.equal(await page.locator('#page-loading').isVisible(), false);
  assert.equal(await page.locator('#page-retry').evaluate(node => node.hidden), true);
});

test('first-paint component failure releases loading and updates the healthy page shell', async t => {
  const page = await pageFor(t);
  await page.evaluate(() => {
    window.originalMessage = UBOVMMessage;
    window.UBOVMMessage = { update() { throw Error('first paint failed'); } };
  });
  await send(page, { ...state(), messages: [{ role: 'assistant', text: '可恢复的内容' }] });
  await page.waitForFunction(() => sent.some(message => message.action === 'contentReady'));
  assert.equal(await page.locator('#page-loading').isVisible(), false);
  assert.equal(await page.locator('#ui-render-retry').isVisible(), true);
  assert.equal(await page.locator('#conversation-title').textContent(), '渲染测试');
  await page.locator('#prompt-input').fill('仍可输入');
  await page.evaluate(() => { window.UBOVMMessage = window.originalMessage; });
  await page.locator('#ui-render-retry').click();
  await page.waitForFunction(() => document.getElementById('ui-render-retry').hidden);
  assert.match(await page.locator('#messages').textContent(), /可恢复的内容/);
  assert.equal(await page.locator('#prompt-input').inputValue(), '仍可输入');
  assert.equal(await page.evaluate(() => sent.filter(message => message.action === 'contentReady').length), 1);
});

test('component failure preserves drafts and retries without an animation error loop', async t => {
  const page = await pageFor(t);
  await send(page, state());
  await page.locator('#prompt-input').fill('保留未发送的草稿');
  await page.evaluate(() => {
    window.originalMessage = UBOVMMessage;
    window.failedRenders = 0;
    window.UBOVMMessage = { update() { window.failedRenders++; throw new Error('Injected component failure'); } };
  });
  await send(page, { ...state(), messages: [{ role: 'assistant', text: '恢复后的内容' }] });
  assert.equal(await page.locator('#ui-render-retry').isVisible(), true);
  await page.evaluate(() => new Promise(resolve => {
    let frames = 0;
    const tick = () => ++frames === 10 ? resolve() : requestAnimationFrame(tick);
    requestAnimationFrame(tick);
  }));
  assert.equal(await page.evaluate(() => window.failedRenders), 1);
  await page.locator('#ui-render-retry').click();
  await page.waitForFunction(() => window.failedRenders === 2);
  await page.evaluate(() => { window.UBOVMMessage = window.originalMessage; });
  await page.locator('#ui-render-retry').click();
  await page.waitForFunction(() => document.getElementById('ui-render-retry').hidden);
  assert.match(await page.locator('#messages').textContent(), /恢复后的内容/);
  assert.equal(await page.locator('#prompt-input').inputValue(), '保留未发送的草稿');
});

test('cached panels retry failed identical state and restore a previously rendered state after partial failure', async t => {
  const page = await pageFor(t);
  for (const target of ['assist-activities', 'exploration-run-list', 'criteria-list']) {
    const snapshot = state('cache-' + target, target === 'criteria-list' ? 'goal' : 'assist');
    const change = label => {
      if (target === 'assist-activities') snapshot.execution.activities = [{ label, timestamp: '2026-09-22T09:00:00Z' }];
      if (target === 'exploration-run-list') snapshot.execution.explorationRuns = [{ id: 'run', title: label, busy: true, status: 'running' }];
      if (target === 'criteria-list') snapshot.goal.criteria = [{ id: 'criterion', text: label, done: false }];
    };
    change('旧内容'); await send(page, snapshot);
    await page.evaluate(target => {
      window.targetPanel = document.getElementById(target);
      // Activities reconcile rows in place; other panels replace their body.
      window.panelMethod = target === 'assist-activities' ? 'insertBefore' : 'replaceChildren';
      window.replacePanel = targetPanel[panelMethod];
      window.failCount = 0;
      targetPanel[panelMethod] = function (...args) {
        if (panelMethod === 'insertBefore') { failCount++; throw new Error('row insertion failure'); }
        replacePanel.apply(this, args); failCount++; throw new Error('partial panel failure');
      };
    }, target);
    change('更新内容'); await send(page, snapshot);
    await page.locator('#ui-render-retry').waitFor({ state: 'visible' });
    const attempts = await page.evaluate(() => failCount);
    await page.locator('#ui-render-retry').click();
    await page.waitForFunction(count => failCount > count, attempts);
    assert.equal(await page.locator('#ui-render-retry').isVisible(), true);
    await page.evaluate(() => { targetPanel[panelMethod] = replacePanel; });
    change('旧内容'); await send(page, snapshot);
    await page.waitForFunction(() => document.getElementById('ui-render-retry').hidden);
    assert.match(await page.locator('#' + target).textContent(), /旧内容/);
    change('更新内容'); await send(page, snapshot);
    assert.match(await page.locator('#' + target).textContent(), /更新内容/);
  }
});

test('blackboard creation failure stays retryable until the same snapshot is rendered', async t => {
  const page = await pageFor(t);
  const snapshot = state('board-retry', 'goal');
  snapshot.execution.blackboard = { sessionId: 'board-retry', revision: 1, rootId: 'root', goal: '恢复黑板', nodes: [{ id: 'root', kind: 'root', parentIds: [] }] };
  await send(page, snapshot);
  await page.evaluate(() => {
    window.originalGraph = createBlackboardGraph;
    window.graphAttempts = 0;
    window.createBlackboardGraph = () => { graphAttempts++; throw new Error('graph unavailable'); };
  });
  await page.locator('#goal-view-switcher > summary').click(); await page.locator('#goal-tab-board').click(); await paint(page);
  await page.locator('#ui-render-retry').waitFor({ state: 'visible' });
  const attempts = await page.evaluate(() => graphAttempts);
  await page.locator('#ui-render-retry').click();
  await page.waitForFunction(count => graphAttempts > count, attempts);
  assert.equal(await page.locator('#ui-render-retry').isVisible(), true);
  await page.evaluate(() => { window.createBlackboardGraph = originalGraph; });
  await page.locator('#ui-render-retry').click();
  await page.waitForFunction(() => document.getElementById('ui-render-retry').hidden);
  assert.equal(await page.locator('#blackboard-nodes [data-node-id="root"]').count(), 1);
});

test('repeated session changes, stream bursts and resizing keep the latest page usable', async t => {
  const page = await pageFor(t);
  const counts = [];
  for (let cycle = 0; cycle < 120; cycle++) {
    const id = 'stress-' + cycle;
    await send(page, state(id));
    if (cycle % 20 === 0) await page.setViewportSize({ width: cycle % 40 ? 390 : 1200, height: 760 });
    await page.evaluate(id => {
      for (let update = 0; update < 20; update++) window.dispatchEvent(new MessageEvent('message', { data: {
        type: 'executionState', conversationId: id, busy: true,
        execution: { status: 'running', streamText: '最新输出 ' + update, parts: [] }
      } }));
    }, id);
    await page.waitForFunction(() => document.getElementById('messages').textContent.includes('最新输出 19'));
    await send(page, { type: 'executionState', conversationId: 'obsolete-session', busy: true, execution: { streamText: '过期输出' } });
    assert.doesNotMatch(await page.locator('#messages').textContent(), /过期输出/);
    assert.equal(await page.locator('#ui-render-retry').isVisible(), false);
    assert.equal(await page.locator('#page-loading').isVisible(), false);
    counts.push(await page.locator('body *').count());
  }
  assert(Math.max(...counts) - Math.min(...counts) < 20, 'old session DOM must not accumulate');
  await send(page, state('stress-final'));
  await page.locator('#prompt-input').fill('连续切换后仍可输入');
  assert.equal(await page.locator('#prompt-input').inputValue(), '连续切换后仍可输入');
});

test('loading and page switches remain opaque from their first animation frame', async t => {
  const page = await pageFor(t);
  async function assertPainted(selector) {
    const result = await page.locator(selector).evaluate(element => {
      // Inspect the exact first frame, independent of browser scheduling speed.
      for (const animation of document.getAnimations()) { animation.pause(); animation.currentTime = 0; }
      let opacity = 1;
      for (let node = element; node; node = node.parentElement) opacity *= Number(getComputedStyle(node).opacity);
      return { opacity, height: element.getBoundingClientRect().height, display: getComputedStyle(element).display };
    });
    assert.equal(result.opacity, 1, selector + ' must not fade through a blank page');
    assert.ok(result.height > 0);
    assert.notEqual(result.display, 'none');
  }
  await assertPainted('#page-loading');
  await send(page, state());
  await assertPainted('#assist-mode');
  await send(page, state('goal-loading', 'goal'));
  await assertPainted('#goal-overview');
  for (const view of ['notes', 'board', 'overview']) {
    await page.locator('#goal-view-switcher > summary').click();
    await page.locator('#goal-tab-' + view).click(); await paint(page);
    await assertPainted('#goal-' + view);
  }
  await send(page, { type: 'settingsLoading', requestId: 'slow-settings', page: 'skills' });
  await assertPainted('#settings-skeleton');
  assert.equal(await page.locator('#settings-dialog').evaluate(n => getComputedStyle(n).transform), 'none', 'fullscreen settings must cover the viewport without moving its background');
  for (const [theme, expected] of [['vscode-dark', 'rgb(27, 30, 34)'], ['vscode-light', 'rgb(255, 255, 255)']]) {
    await page.evaluate(theme => { document.body.classList.remove('vscode-dark', 'vscode-light'); document.body.classList.add(theme); }, theme);
    assert.equal(await page.locator('html').evaluate(n => getComputedStyle(n).backgroundColor), expected, 'root surface follows theme instead of exposing the browser default');
    await assertPainted('#settings-skeleton');
  }
  await send(page, { type: 'settingsLoadError', requestId: 'slow-settings', error: '加载失败，请重试' });
  assert.equal(await page.locator('#settings-load-error').isVisible(), true);
});

test('goal overview logs Reason thinking, worker dispatch and tools without replacing history with the result', async t => {
  const page = await pageFor(t);
  const message = state('overview-output', 'goal');
  message.execution = { status: 'running', busy: true, parts: [
    { id: 'thought', type: 'thinking', source: 'reason', text: '先检查项目入口。', status: 'running', startedAt: 1000 },
    { id: 'tool', type: 'tool', name: 'read_workspace_file', status: 'completed', args: '{}', output: '检查结果', startedAt: 3000 }
  ], workers: [{ id: 'worker-1', name: '检查项目', description: '读取项目结构', status: 'running', startedAt: 2000, parts: [] }] }; message.busy = true;
  await send(page, message);
  assert.deepEqual(await page.locator('.goal-log-entry').evaluateAll(rows => rows.map(row => row.dataset.logId)), ['part:thought', 'worker:worker-1', 'part:tool']);
  assert.equal(await page.locator('.goal-log-body .thinking-body').isVisible(), true);
  assert.match(await page.locator('#goal-output-content').textContent(), /先检查项目入口/);
  await page.locator('.goal-log-worker').click();
  assert.equal(await page.locator('#worker-panel').isVisible(), true);
  await page.getByRole('button', { name: '关闭 Worker 详情' }).click();
  await page.locator('.thinking-summary').click();
  message.execution.parts[0].text += '继续检查依赖。'; await send(page, message);
  assert.equal(await page.locator('.thinking-card').getAttribute('open'), null);
  message.busy = false; message.execution.busy = false; message.execution.status = 'completed';
  message.execution.result = { summary: '检查已完成。' }; await send(page, message);
  assert.equal(await page.locator('#goal-output-title').textContent(), '思考与调度日志');
  assert.match(await page.locator('#goal-output-content').textContent(), /检查已完成/);
  assert.match(await page.locator('#goal-output-content').textContent(), /先检查项目入口/);
  await page.locator('.thinking-summary').click();
  await page.screenshot({ path: '.cache/goal-execution-log.png' });
  await send(page, state('empty-output', 'goal'));
  assert.equal(await page.locator('#goal-output-content').isVisible(), false);
});

test('overview shows only the full-width Reason log across viewport sizes', async t => {
  const now = Date.now();
  for (const width of [1440, 390]) {
    const page = await pageFor(t, { viewport: { width, height: 900 }, reducedMotion: 'reduce' });
    const current = state('live-overview-' + width, 'goal'); current.busy = true;
    current.goal.objective = '完善项目的浏览器安装与工具执行体验';
    current.execution = { status: 'running', busy: true, parts: [
      { id: 'plan', type: 'thinking', source: 'reason', status: 'completed', startedAt: now - 60000, endedAt: now - 45000, text: '先确认 **浏览器安装流程** 和工具卡片的状态更新路径。\n\n把检查拆成两个独立任务：一个验证下载与重试，另一个检查界面交互。等待结果后，再整合发现并验证。' },
      { id: 'review', type: 'thinking', source: 'reason', status: 'running', startedAt: now - 8000, text: '安装流程已经检查完成，正在核对界面的状态变化。\n\n- 失败的工具保持收起\n- 思考日志默认展开\n- 用户手动选择在流式更新中保留' },
      { id: 'private-worker', type: 'thinking', source: 'worker', text: '仅在 Worker 详情显示', status: 'running' }
    ], workers: [
      { id: 'done', name: '验证安装流程', description: '检查下载、重复点击和失败重试。', status: 'completed', createdAt: now - 50000, startedAt: now - 48000, finishedAt: now - 12000 },
      { id: 'active', name: '检查界面交互', description: '验证工具卡片和思考日志的展开状态。', status: 'running', createdAt: now - 40000, startedAt: now - 35000, parts: [{ id: 'test', type: 'tool', name: 'run_linux_ssh_command', status: 'running' }] },
      { id: 'queued', name: '检查窄屏布局', description: '验证小窗口内的阅读与操作。', status: 'queued', createdAt: now - 2000 }
    ] };
    await send(page, current);
    assert.equal(await page.locator('#worker-list, [data-overview-panel="workers"], #goal-overview-split, .goal-panel-controls').count(), 0);
    assert.equal(await page.locator('[data-log-id="worker:done"] .goal-log-state').textContent(), '已派发');
    assert.equal(await page.locator('[data-log-id="part:private-worker"]').count(), 0);
    assert.equal(await page.locator('#goal-panels').evaluate(n => n.scrollWidth <= n.clientWidth), true);
    if (width >= 900) {
      const journal = await page.locator('.goal-output-panel').boundingBox();
      const columns = await page.locator('.goal-overview-columns').boundingBox();
      assert.ok(Math.abs(journal.width - columns.width) < 1, 'log fills the overview width');
      assert.ok(await page.locator('#goal-output-content').evaluate(n => n.scrollHeight > n.clientHeight), 'long logs scroll inside their panel');
    }
    await page.screenshot({ path: '.cache/goal-overview-' + width + '.png' });
    await page.locator('#goal-view-switcher > summary').click(); await page.locator('#goal-tab-workers').click(); await paint(page);
    await page.locator('#goal-workers-list [data-worker-id="active"]').click();
    assert.equal(await page.locator('#worker-panel').isVisible(), true);
  }
});

test('goal creation keeps initial facts in drafts and submits them separately', async t => {
  const page = await pageFor(t);
  const initial = { ...state('goal-create', 'goal'), goal: null };
  await send(page, initial);
  await page.locator('#goal-facts-input').fill('已有桌面框架\n数据保存在本地');
  await page.locator('#goal-objective-input').fill('完成项目管理功能');
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  assert.equal(await page.evaluate(() => window.persisted.drafts['goal-create'].goalDraft.initialFacts), '已有桌面框架\n数据保存在本地');
  await send(page, state('other', 'goal'));
  await send(page, initial);
  await page.evaluate(() => window.dispatchEvent(new Event('pageshow')));
  await page.locator('#route-loading').waitFor({ state: 'hidden' });
  assert.equal(await page.locator('#goal-facts-input').inputValue(), '已有桌面框架\n数据保存在本地');
  await page.locator('#goal-save').click();
  const message = await page.evaluate(() => window.sent.find(item => item.action === 'saveGoal'));
  assert.equal(message.goal.initialFacts, '已有桌面框架\n数据保存在本地');
  assert.equal(message.goal.objective, '完成项目管理功能');
  await send(page, { ...initial, goal: { ...message.goal, notes: [] } });
  await send(page, { type: 'uiResult', requestId: message.requestId, ok: true });
  assert.equal(await page.locator('#goal-overview').getByText('初始事实', { exact: true }).count(), 0);
  assert.equal(await page.locator('#goal-overview').getByText(message.goal.initialFacts, { exact: true }).count(), 0);
});

test('goal page switcher supports keyboard navigation and restores reading position', async t => {
  const page = await pageFor(t, { viewport: { width: 1100, height: 760 } });
  const initial = state('goal-navigation', 'goal');
  initial.goal.criteria = Array.from({ length: 20 }, (_, index) => ({ id: 'c' + index, text: '验收条件 ' + index + '：保留页面中的阅读位置与输入内容。'.repeat(8), done: false }));
  await send(page, initial);
  assert.equal(await page.locator('#goal-tabs').getAttribute('aria-orientation'), 'vertical');
  assert.equal(await page.locator('#goal-tabs button').count(), 4);
  assert.equal(await page.locator('#goal-prompt-form').isVisible(), false);
  await page.locator('.goal-acceptance-panel > summary').click();
  await page.locator('#goal-panels').evaluate(node => { node.scrollTop = 240; });
  await page.locator('#goal-view-switcher > summary').click();
  await page.locator('#goal-tab-overview').focus();
  await page.keyboard.press('ArrowDown'); await paint(page);
  assert.equal(await page.locator('#goal-tab-board').getAttribute('aria-selected'), 'true');
  assert.equal(await page.locator('#goal-prompt-form').isVisible(), false);
  await page.keyboard.press('Home'); await paint(page);
  assert.equal(await page.locator('#goal-panels').evaluate(node => node.scrollTop), 240);
  await page.keyboard.press('End'); await paint(page);
  assert.equal(await page.locator('#goal-tab-notes').getAttribute('aria-selected'), 'true');
  assert.equal(await page.locator('#goal-prompt-form').count(), 0);
  await page.setViewportSize({ width: 390, height: 760 });
  assert.equal(await page.locator('#goal-tabs').getAttribute('aria-orientation'), 'vertical');
  await page.locator('#goal-tab-notes').focus();
  await page.keyboard.press('ArrowDown'); await paint(page);
  assert.equal(await page.locator('#goal-tab-overview').getAttribute('aria-selected'), 'true');
  assert.equal(await page.locator('#goal-tabs').evaluate(node => node.scrollWidth <= node.clientWidth), true);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#goal-tabs').isVisible(), false);
  assert.equal(await page.locator('#goal-view-switcher > summary').evaluate(node => node === document.activeElement), true);
  await page.locator('#goal-view-switcher > summary').click();
  await page.locator('#goal-panels').click({ position: { x: 4, y: 100 } });
  assert.equal(await page.locator('#goal-tabs').isVisible(), false);
});

test('legacy goal chat selection falls back to overview without a dialogue panel', async t => {
  const page = await pageFor(t);
  await page.addInitScript(() => { window.persisted = { drafts: { 'goal-legacy': { view: 'chat', goalPrompt: '已有草稿', note: '已有笔记草稿' } } }; });
  await page.reload();
  await send(page, state('goal-legacy', 'goal'));
  assert.equal(await page.locator('#goal-overview').isVisible(), true);
  assert.equal(await page.locator('#goal-chat, #goal-prompt-form, #goal-tab-chat').count(), 0);
  assert.equal(await page.locator('#goal-current-icon svg').count(), 1);
  await send(page, { type: 'focusInput' });
  assert.equal(await page.locator('#goal-view-switcher > summary').evaluate(node => node === document.activeElement), true);
});

test('goal surfaces fill available space without nested page overflow', async t => {
  for (const viewport of [{ width: 1440, height: 900 }, { width: 900, height: 600 }, { width: 390, height: 460 }]) {
    const page = await pageFor(t, { viewport, reducedMotion: 'reduce' });
    const initial = state('goal-layout', 'goal');
    initial.goal.objective = '优化目标工作区，让进展、探索与记录各有合适的空间';
    initial.goal.criteria = Array.from({ length: 4 }, (_, index) => ({ id: 'criterion-' + index, text: ['概览的信息层级清晰', '黑板画布充分利用窗口', '笔记列表与正文独立滚动', '窄屏下操作按钮保持可见'][index], done: index === 0 }));
    initial.execution.blackboard = { sessionId: 'goal-layout', rootId: 'root', goal: initial.goal.objective, revision: 1, nodes: [
      { id: 'root', kind: 'root', parentIds: [] },
      { id: 'i', kind: 'intent', parentIds: ['root'], resultId: 'f', intent: { description: '检查空间分配', status: 'completed' }, attempts: [] },
      { id: 'f', kind: 'fact', producerId: 'i', parentIds: ['i'], fact: { content: '根据面板用途分配空间' } }
    ] };
    await send(page, initial);
    if (viewport.width > 1000) {
      const journal = await page.locator('.goal-output-panel').boundingBox();
      const columns = await page.locator('.goal-overview-columns').boundingBox();
      assert.ok(Math.abs(journal.width - columns.width) < 2);
      assert.equal(await page.locator('.execution-panel').count(), 0);
      assert.equal(await page.locator('.goal-acceptance-panel').evaluate(node => node.open), false);
    }
    for (const view of ['overview', 'board', 'notes']) {
      if (view !== 'overview') { await page.locator('#goal-view-switcher > summary').click(); await page.locator('#goal-tab-' + view).click(); await paint(page); }
      const bounds = await page.locator('#goal-panels').boundingBox();
      assert.ok(bounds.y + bounds.height <= viewport.height + 1);
      assert.equal(await page.locator('#goal-panels').evaluate(node => node.scrollWidth <= node.clientWidth), true);
      if (view !== 'overview') {
        assert.ok(await page.locator('#goal-panels').evaluate(node => node.scrollHeight <= node.clientHeight + 1));
        const surface = await page.locator(view === 'board' ? '.graph-viewport' : '.notebook-layout').boundingBox();
        assert.ok(surface.height > 60);
        assert.ok(surface.y + surface.height <= bounds.y + bounds.height + 1);
      }
      if (process.env.UBOVM_UI_PREVIEW) await page.screenshot({ path: process.env.UBOVM_UI_PREVIEW + '/layout-' + view + '-' + viewport.width + '.png' });
      if (view === 'board') {
        assert.equal(await page.locator('#goal-board .graph-acceptance').count(), 0);
        assert.equal(await page.locator('#goal-board-objective, #goal-board-criteria').count(), 0);
        assert.ok(await page.locator('#goal-panels').evaluate(node => node.scrollHeight <= node.clientHeight + 1));
      }
    }
  }
});

test('startup skeleton resolves on data; streaming bursts render once and preserve published nodes', async t => {
  const page = await pageFor(t);
  assert.equal(await page.locator('#page-loading').isVisible(), true);
  assert.equal(await page.locator('#assist-mode').isVisible(), false);
  const initial = state();
  initial.messages = [{ role: 'user', text: '这是一条已经发布的消息' }];
  await send(page, initial);
  assert.equal(await page.locator('#page-loading').isVisible(), false);
  await page.evaluate(() => {
    window.savedArticle = document.querySelector('#messages article');
    const selection = getSelection(), range = document.createRange();
    range.selectNodeContents(document.querySelector('#messages .message-text'));
    selection.removeAllRanges(); selection.addRange(range);
    const original = window.UBOVMMessage;
    window.messageRenders = 0;
    window.UBOVMMessage = { update(...args) { window.messageRenders++; return original.update(...args); } };
    for (let index = 0; index < 80; index++) window.dispatchEvent(new MessageEvent('message', { data: {
      type: 'executionState', conversationId: 'assist-1', busy: true,
      execution: { status: 'running', streamText: '流式回复 ' + index, parts: [] }
    } }));
  });
  await page.waitForFunction(() => document.querySelector('.streaming-message')?.textContent.includes('流式回复 79'));
  assert.equal(await page.evaluate(() => window.messageRenders), 1);
  assert.equal(await page.evaluate(() => window.savedArticle === document.querySelector('#messages article')), true);
  assert.equal(await page.evaluate(() => getSelection().toString()), initial.messages[0].text);
  await send(page, { type: 'executionState', conversationId: 'older-session', execution: { status: 'running', streamText: '不该出现' }, busy: true });
  assert.equal(await page.locator('#messages').textContent().then(text => text.includes('不该出现')), false);
  await send(page, { ...initial, messages: [...initial.messages, { role: 'assistant', text: '流式回复 79' }] });
  assert.equal(await page.locator('.streaming-message').count(), 0);
  assert.equal(await page.locator('#messages article').count(), 2);
  assert.equal(await page.locator('#busy-status').isVisible(), false);
});

test('rapid route changes render only the final panel and cancel motion when reduced motion changes', async t => {
  const page = await pageFor(t);
  const initial = state('rapid-route', 'goal');
  initial.execution.blackboard = { revision: 1, nodes: Array.from({ length: 200 }, (_, index) => ({ id: `rapid-${index}`, kind: 'fact', fact: { content: `事实 ${index}` } })) };
  await send(page, initial);
  await page.evaluate(() => {
    window.routeAnimations = [];
    const animate = Element.prototype.animate;
    Element.prototype.animate = function (...args) {
      const animation = animate.apply(this, args);
      // Keep the animation active long enough to exercise preference changes.
      animation.pause(); window.routeAnimations.push({ target: this.id, animation });
      return animation;
    };
    document.querySelector('#goal-tab-board').click();
    document.querySelector('#goal-tab-workers').click();
    document.querySelector('#goal-tab-notes').click();
  });
  await page.waitForFunction(() => !document.querySelector('#goal-notes').hidden && document.querySelector('#goal-notes-list').children.length > 0);
  assert.equal(await page.locator('#blackboard-nodes .graph-node').count(), 0, 'intermediate board must not render');
  assert.deepEqual(await page.evaluate(() => routeAnimations.map(item => item.target)), ['goal-notes']);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.waitForFunction(() => routeAnimations.every(item => item.animation.playState === 'idle'));
});

test('hidden goal tabs defer expensive content and render the latest data when selected', async t => {
  const page = await pageFor(t);
  const initial = state('goal-1', 'goal');
  initial.messages = [{ role: 'user', text: '执行目标' }, { role: 'assistant', text: '# 历史回复\n\n内容' }];
  initial.execution = { status: 'running', blackboard: { revision: 1, nodes: Array.from({ length: 200 }, (_, index) => ({ id: 'node-' + index, kind: 'fact', fact: { content: '证据 ' + index } })) }, memory: { notes: [{ text: 'Agent 记录' }] }, parts: [] };
  await send(page, initial);
  assert.equal(await page.locator('#blackboard-nodes > *').count(), 0);
  assert.equal(await page.locator('#goal-notes-list > *').count(), 0);
  assert.equal(await page.locator('#goal-messages > *').count(), 0);
  assert.equal(await page.locator('#goal-output-status').isVisible(), true);
  assert.match(await page.locator('#goal-output-status').textContent(), /执行中/);
  await page.locator('#goal-view-switcher > summary').click(); await page.locator('#goal-tab-board').click(); await paint(page);
  assert.equal(await page.locator('#blackboard-nodes .graph-node[data-node-id]').count(), 200);
  assert.equal(await page.locator('#blackboard-nodes .graph-goal-badge').count(), 1);
  await page.locator('#goal-view-switcher > summary').click(); await page.locator('#goal-tab-notes').click(); await paint(page);
  assert.equal(await page.locator('#goal-notes-list').textContent().then(text => text.includes('保留已有笔记')), true);
  assert.equal(await page.locator('#agent-notes-list').textContent(), 'Agent 记录');
  assert.equal(await page.locator('#goal-chat, #goal-tab-chat').count(), 0);
  await send(page, { type: 'executionState', conversationId: 'goal-1', execution: { status: 'completed' }, busy: false });
  assert.equal(await page.locator('#header-execution-status').isVisible(), false);
});

test('typing coalesces persistence and a fast session switch flushes the previous draft', async t => {
  const page = await pageFor(t);
  await send(page, state());
  await page.evaluate(() => {
    const input = document.querySelector('#prompt-input');
    for (let index = 0; index < 80; index++) {
      input.value = '尚未提交的草稿 ' + index;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
    window.writesBeforeFlush = window.persistCount;
  });
  assert.equal(await page.evaluate(() => window.writesBeforeFlush), 0);
  await send(page, state('assist-2'));
  assert.equal(await page.evaluate(() => window.persisted.drafts['assist-1'].assist), '尚未提交的草稿 79');
  await page.locator('#prompt-input').fill('第二个会话的草稿');
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  assert.equal(await page.evaluate(() => window.persisted.drafts['assist-2'].assist), '第二个会话的草稿');
  await send(page, state());
  assert.equal(await page.locator('#prompt-input').inputValue(), '尚未提交的草稿 79');
});

test('reduced motion disables loading animation including pseudo elements at narrow widths', async t => {
  const page = await pageFor(t, { viewport: { width: 320, height: 640 }, reducedMotion: 'reduce' });
  assert.equal(await page.locator('.loading-skeleton').evaluate(element => getComputedStyle(element).animationName), 'none');
  assert.equal(await page.locator('.loading-skeleton').evaluate(element => getComputedStyle(element, '::after').animationName), 'none');
  assert.equal(await page.locator('#page-loading-label').evaluate(element => getComputedStyle(element, '::before').animationName), 'none');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await send(page, { ...state(), execution: { status: 'running', streamText: '正在生成回复' } });
  assert.equal(await page.locator('#busy-status').evaluate(element => getComputedStyle(element, '::before').animationName), 'none');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
});

test('native blackboard details replace the canvas overlay and follow related-node navigation', async t => {
  const page = await pageFor(t);
  const message = { ...state('native-graph', 'goal'), nativeBlackboardSidebar: true };
  message.execution.blackboard = { sessionId: 'native-graph', rootId: 'root', revision: 1, goal: '侧边栏验证', nodes: [
    { id: 'root', kind: 'root', parentIds: [] },
    { id: 'fact', kind: 'fact', parentIds: ['root'], fact: { content: '证据 <script>unsafe</script>' } }
  ] };
  await send(page, message);
  await page.locator('#goal-view-switcher > summary').click(); await page.locator('#goal-tab-board').click(); await paint(page);
  await page.locator('.graph-node[data-kind="fact"]').click();
  const detail = await page.evaluate(() => window.sent.findLast(item => item.action === 'blackboardDetail'));
  assert.equal(detail.sessionId, 'native-graph');
  assert.equal(detail.reveal, true);
  assert.equal(detail.detail.title, '事实详情');
  assert.match(detail.detail.sections[0].text, /证据/);
  assert.equal(await page.locator('.graph-detail').isVisible(), false);
  await send(page, { type: 'selectBlackboardNode', sessionId: 'native-graph', id: 'root' });
  assert.equal(await page.evaluate(() => window.sent.findLast(item => item.action === 'blackboardDetail').detail.id), 'root');
  await send(page, { type: 'closeBlackboardDetails' });
  assert.equal(await page.evaluate(() => window.sent.findLast(item => item.action === 'blackboardDetail').detail), null);
});

 test('goal graph represents intentions as selectable edges and results as draggable facts', async t => {
  const page = await pageFor(t);
  const message = state('graph-test', 'goal');
  message.execution.blackboard = { sessionId: 'graph-test', rootId: 'root', goal: '探索目标', revision: 1, nodes: [
    { id: 'root', kind: 'root', parentIds: [] },
    { id: 'a', kind: 'intent', parentIds: ['root'], resultId: 'f', intent: { description: '检查数据模型', status: 'completed' }, attempts: [] },
    { id: 'f', kind: 'fact', producerId: 'a', parentIds: ['a'], fact: { content: '独立证据 <script>unsafe</script>' } },
    { id: 'b', kind: 'intent', parentIds: ['f'], intent: { description: '检查前端布局', status: 'running' }, attempts: [] }
  ] };
  await send(page, message); await page.locator('#goal-view-switcher > summary').click(); await page.locator('#goal-tab-board').click(); await paint(page);
  assert.equal(await page.locator('.graph-node[data-node-id]').count(), 2);
  assert.equal(await page.locator('.graph-goal-badge').count(), 1);
  assert.equal(await page.locator('.graph-node[data-kind="intent"]').count(), 0);
  assert(await page.locator('.graph-edge-label textPath').count() > 0);
  assert(await page.evaluate(() => [...document.querySelectorAll('.graph-edge-label textPath')].every(text => {
    const track = document.querySelector(text.getAttribute('href'));
    if (!track) return false;
    const line = text.parentElement.previousElementSibling;
    const route = line.getAttribute('d').split(' M')[0];
    const points = route.match(/-?\d+(?:\.\d+)?/g).map(Number);
    const midpoint = track.getPointAtLength(track.getTotalLength() / 2);
    return Math.abs(midpoint.x - (points[0] + points[2]) / 2) < 1 && Math.abs(midpoint.y - (points[1] + points[3]) / 2) < 1;
  })));
  assert.equal(await page.locator('.graph-frontier').count(), 1);
  assert.equal(await page.locator('.graph-edges path[data-intent-id="a"][data-source="root"][data-target="f"]').count(), 1);
  await page.locator('.graph-edges > path[data-intent-id="a"]').focus(); await page.keyboard.press('Enter');
  assert.match(await page.locator('.graph-detail').textContent(), /检查数据模型/);
  await page.locator('.graph-result-link').click();
  assert.match(await page.locator('.graph-detail').textContent(), /独立证据/);
  assert.equal(await page.locator('.graph-detail script').count(), 0);
  await page.getByRole('button', { name: '关闭节点详情' }).click();
  await page.locator('.graph-edges > path[data-intent-id="b"]').focus();
  await page.keyboard.press('Enter');
  assert.match(await page.locator('.graph-detail').textContent(), /检查前端布局/);
  await page.getByRole('button', { name: '关闭节点详情' }).click();
  await page.getByRole('button', { name: '缩小探索图' }).click();
  await page.evaluate(() => { window.savedFact = document.querySelector('.graph-node[data-node-id="f"]'); });
  message.execution.blackboard.nodes[3].intent.status = 'completed';
  message.execution.blackboard.nodes[3].resultId = 'f2';
  message.execution.blackboard.nodes.push({ id: 'f2', kind: 'fact', producerId: 'b', parentIds: ['b'], fact: { content: '布局验证完成' } });
  message.execution.blackboard.revision++;
  await send(page, message);
  assert.equal(await page.locator('.graph-frontier').count(), 0);
  assert.equal(await page.locator('.graph-node[data-kind="fact"]').count(), 2);
  assert.equal(await page.locator('.graph-edges path[data-intent-id="b"][data-target="f2"]').count(), 1);
  assert.equal(await page.evaluate(() => savedFact === document.querySelector('.graph-node[data-node-id="f"]')), true);
  assert.equal(await page.locator('.graph-zoom').textContent(), '85%');
  assert.equal(await page.locator('.graph-direction').count(), 0);
  await page.screenshot({ path: '.cache/goal-blackboard-graph.png' });
  await page.setViewportSize({ width: 320, height: 760 });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
 });

 test('graph dragging respects zoom, preserves manual positions and keeps details optional', async t => {
  const page = await pageFor(t);
  const message = state('drag-test', 'goal');
  message.execution.blackboard = { sessionId: 'drag-test', rootId: 'root', revision: 1, goal: '拖动探索图', nodes: [
    { id: 'root', kind: 'root', parentIds: [] },
    { id: 'a', kind: 'fact', parentIds: ['root'], fact: { content: '检查数据得到的事实' } }
  ] };
  await send(page, message); await page.locator('#goal-view-switcher > summary').click(); await page.locator('#goal-tab-board').click(); await paint(page);
  assert.equal(await page.locator('.graph-detail').isVisible(), false);
  const viewportBefore = await page.locator('.graph-viewport').boundingBox();
  const node = page.locator('.graph-node[data-node-id="a"]');
  await node.click();
  assert.equal(await page.locator('.graph-detail').isVisible(), true);
  assert.equal((await page.locator('.graph-viewport').boundingBox()).width, viewportBefore.width);
  await page.getByRole('button', { name: '关闭节点详情' }).click();
  await page.getByRole('button', { name: '缩小探索图' }).click();
  const original = await node.evaluate(n => ({ x: parseFloat(n.style.left), y: parseFloat(n.style.top) }));
  const edge = page.locator('.graph-edges > path:not(.graph-edge-hit)'); const pathBefore = await edge.getAttribute('d');
  const box = await node.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down(); await page.mouse.move(box.x + box.width / 2 + 68, box.y + box.height / 2 + 34, { steps: 8 }); await page.mouse.up();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
  const moved = await node.evaluate(n => ({ x: parseFloat(n.style.left), y: parseFloat(n.style.top) }));
  assert(Math.abs(moved.x - original.x - 80) < 2);
  assert(Math.abs(moved.y - original.y - 40) < 2);
  assert.notEqual(await edge.getAttribute('d'), pathBefore);
  assert.equal(await page.locator('.graph-detail').isVisible(), false);
  message.execution.blackboard.revision++;
  await send(page, message);
  assert.deepEqual(await node.evaluate(n => ({ x: parseFloat(n.style.left), y: parseFloat(n.style.top) })), moved);
  await node.click(); assert.equal(await page.locator('.graph-detail').isVisible(), true);
  await page.getByRole('button', { name: '关闭节点详情' }).press('Escape');
  assert.equal(await page.locator('.graph-detail').isVisible(), false);
  await page.getByRole('button', { name: '适应画布', exact: true }).click();
  assert.deepEqual(await node.evaluate(n => ({ x: parseFloat(n.style.left), y: parseFloat(n.style.top) })), original);
  await page.screenshot({ path: '.cache/goal-graph-drag.png' });
 });

test('unlabelled edges have a generous mouse target and keyboard selection at low zoom', async t => {
  const page = await pageFor(t), message = { ...state('edge-hit', 'goal'), nativeBlackboardSidebar: true };
  message.execution.blackboard = { sessionId: 'edge-hit', rootId: 'root', revision: 1, nodes: [
    { id: 'root', kind: 'root', parentIds: [] },
    { id: 'f', kind: 'fact', parentIds: ['root'], fact: { content: '直接关系事实' } },
    { id: 'i', kind: 'intent', parentIds: ['f'], resultId: 'f2', intent: { description: '', status: 'completed' } },
    { id: 'f2', kind: 'fact', producerId: 'i', parentIds: ['i'], fact: { content: '产出事实' } }
  ] };
  await send(page, message); await page.locator('#goal-view-switcher > summary').click(); await page.locator('#goal-tab-board').click(); await paint(page);
  for (let i = 0; i < 3; i++) await page.getByRole('button', { name: '缩小探索图' }).click();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  for (const id of ['f', 'i']) {
    const line = page.locator(`.graph-edges > path[data-selection-id="${id}"]:not(.graph-edge-hit)`);
    const label = page.locator(`.graph-edge-label[data-selection-id="${id}"]`);
    assert.equal(await label.getAttribute('aria-hidden'), 'true');
    assert.equal(await line.getAttribute('tabindex'), '0');
    const point = await line.evaluate(path => {
      const p = path.getPointAtLength(path.getTotalLength() * .4);
      const screen = new DOMPoint(p.x, p.y).matrixTransform(path.getScreenCTM());
      return { x: screen.x + 4, y: screen.y };
    });
    await page.mouse.click(point.x, point.y);
    assert.equal(await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle), 'none', 'clicking the invisible edge target must not draw a rectangular focus ring');
    assert.equal(await page.evaluate(() => window.sent.findLast(item => item.action === 'blackboardDetail')?.detail?.id), id);
    assert.equal(await page.locator('.graph-viewport').evaluate(n => n.classList.contains('is-panning')), false);
    await send(page, { type: 'closeBlackboardDetails' });
    await line.focus(); await page.keyboard.press('Enter');
    assert.equal(await line.evaluate(n => getComputedStyle(n).outlineStyle), 'none');
    assert.equal(await line.evaluate(n => getComputedStyle(n).strokeWidth), '2.5px', 'keyboard focus remains visible on the line');
    assert.equal(await page.evaluate(() => window.sent.findLast(item => item.action === 'blackboardDetail')?.detail?.id), id);
    await send(page, { type: 'closeBlackboardDetails' });
  }
});

test('graph wheel zoom anchors the pointer, clamps scale and leaves detail scrolling alone', async t => {
  const page = await pageFor(t, { reducedMotion: 'reduce' }), message = state('wheel-test', 'goal');
  message.execution.blackboard = { sessionId: 'wheel-test', rootId: 'root', revision: 1, nodes: [
    { id: 'root', kind: 'root', parentIds: [] },
    { id: 'f', kind: 'fact', parentIds: ['root'], fact: { content: '证据\n'.repeat(100) } }
  ] };
  await send(page, message); await page.locator('#goal-view-switcher > summary').click(); await page.locator('#goal-tab-board').click(); await paint(page);
  const viewport = page.locator('.graph-viewport'), canvas = page.locator('.graph-canvas');
  const bounds = await viewport.boundingBox(), anchor = { x: bounds.x + 100, y: bounds.y + 160 };
  const point = () => canvas.evaluate((node, anchor) => {
    const rect = node.getBoundingClientRect(), scale = new DOMMatrix(getComputedStyle(node).transform).a;
    return { x: (anchor.x - rect.left) / scale, y: (anchor.y - rect.top) / scale };
  }, anchor);
  const before = await point();
  await page.mouse.move(anchor.x, anchor.y); await page.mouse.wheel(0, 120);
  await page.waitForFunction(() => new DOMMatrix(getComputedStyle(document.querySelector('.graph-canvas')).transform).a < 1);
  const after = await point();
  assert(Math.abs(before.x - after.x) < 1 && Math.abs(before.y - after.y) < 1, `pointer stays on the same graph point: ${JSON.stringify({ before, after })}`);
  await page.mouse.wheel(0, -120);
  await page.waitForFunction(() => document.querySelector('.graph-zoom').textContent === '100%');
  for (const [deltaY, expected] of [[-1000, '150%'], [1000, '25%']]) {
    await viewport.evaluate((node, deltaY) => {
      const rect = node.getBoundingClientRect();
      for (let i = 0; i < 10; i++) node.dispatchEvent(new WheelEvent('wheel', { deltaY, deltaMode: 1, clientX: rect.left + 100, clientY: rect.top + 160, bubbles: true, cancelable: true }));
    }, deltaY);
    assert.equal(await page.locator('.graph-zoom').textContent(), expected);
  }
  await page.getByRole('button', { name: '适应画布', exact: true }).click();
  await page.locator('.graph-node[data-node-id="f"]').click();
  const scale = await page.locator('.graph-zoom').textContent();
  await page.locator('.graph-detail-text').hover(); await page.mouse.wheel(0, 200);
  await page.waitForFunction(() => document.querySelector('.graph-detail-text').scrollTop > 0);
  assert.equal(await page.locator('.graph-zoom').textContent(), scale);
});

test('wheel bursts after panning preserve the graph point through streamed renders and scale limits', async t => {
  for (const width of [1440, 390]) {
    const page = await pageFor(t, { viewport: { width, height: 850 }, deviceScaleFactor: 1.25, reducedMotion: 'reduce' });
    const message = state('stable-camera-' + width, 'goal');
    message.execution.blackboard = { sessionId: message.conversation.id, rootId: 'root', revision: 1, nodes: [
      { id: 'root', kind: 'root', parentIds: [] },
      ...Array.from({ length: 12 }, (_, i) => ({ id: 'fact-' + i, kind: 'fact', parentIds: ['root'], fact: { content: '证据 ' + i } }))
    ] };
    await send(page, message); await page.locator('#goal-view-switcher > summary').click(); await page.locator('#goal-tab-board').click(); await paint(page);
    const viewport = page.locator('.graph-viewport'), node = page.locator('[data-node-id="fact-0"]');
    const bounds = await viewport.boundingBox();
    await page.mouse.move(bounds.x + 30, bounds.y + 160);
    await page.mouse.down(); await page.mouse.move(bounds.x + 95, bounds.y + 195); await page.mouse.up();
    // Synthetic MouseEvent coordinates are integer CSS pixels in Chromium.
    const anchor = { x: Math.round(bounds.x + 40), y: Math.round(bounds.y + 120) };
    const read = () => node.evaluate((n, anchor) => {
      const rect = n.getBoundingClientRect();
      const matrix = new DOMMatrix(getComputedStyle(document.querySelector('.graph-canvas')).transform);
      return { x: (anchor.x - rect.left) / matrix.a, y: (anchor.y - rect.top) / matrix.a };
    }, anchor);
    const original = await read();
    for (const delta of [25, 60, -40, 240, 240, 240, 240, -240, -240, -240, -240, -240, 60]) {
      await viewport.evaluate((n, { delta, anchor }) => n.dispatchEvent(new WheelEvent('wheel', {
        deltaY: delta, clientX: anchor.x, clientY: anchor.y, bubbles: true, cancelable: true
      })), { delta, anchor });
      await paint(page);
      message.execution.blackboard.revision++;
      await send(page, message); await paint(page);
      const current = await read();
      assert.ok(Math.abs(current.x - original.x) < .2 && Math.abs(current.y - original.y) < .2,
        `no drift after zoom and streaming at ${width}px: ${JSON.stringify({ original, current })}`);
      assert.deepEqual(await viewport.evaluate(n => [n.scrollLeft, n.scrollTop]), [0, 0]);
    }
    const before = await node.boundingBox();
    await page.getByRole('button', { name: '适应画布', exact: true }).click();
    assert.notDeepEqual(await node.boundingBox(), before);
  }
});

test('blank canvas pans at zoom without moving facts and survives streamed updates', async t => {
  const page = await pageFor(t), message = state('pan-test', 'goal');
  message.execution.blackboard = { sessionId: 'pan-test', rootId: 'root', revision: 1, nodes: [
    { id: 'root', kind: 'root', parentIds: [] },
    { id: 'f', kind: 'fact', parentIds: ['root'], fact: { content: '证据' } }
  ] };
  await send(page, message); await page.locator('#goal-view-switcher > summary').click(); await page.locator('#goal-tab-board').click(); await paint(page);
  await page.getByRole('button', { name: '缩小探索图' }).click();
  const node = page.locator('.graph-node[data-node-id="f"]');
  const before = await node.boundingBox(), original = await node.getAttribute('style');
  const viewport = await page.locator('.graph-viewport').boundingBox();
  await page.mouse.move(viewport.x + 80, viewport.y + 300);
  await page.mouse.down(); await page.mouse.move(viewport.x + 148, viewport.y + 334, { steps: 6 }); await page.mouse.up();
  const after = await node.boundingBox();
  assert(Math.abs(after.x - before.x - 68) < 2); assert(Math.abs(after.y - before.y - 34) < 2);
  assert.equal(await node.getAttribute('style'), original);
  assert.equal(await page.locator('.graph-detail').isVisible(), false);
  const transform = await page.locator('.graph-canvas').evaluate(n => n.style.transform);
  message.execution.blackboard.revision++; await send(page, message);
  assert.equal(await page.locator('.graph-canvas').evaluate(n => n.style.transform), transform);
  await node.click(); assert.equal(await page.locator('.graph-detail').isVisible(), true);
  assert.equal(await page.locator('.graph-canvas').evaluate(n => n.style.transform), transform);
  await page.getByRole('button', { name: '关闭节点详情' }).click();
  await page.getByRole('button', { name: '适应画布', exact: true }).click();
  const fitted = await page.locator('.graph-canvas').boundingBox();
  assert.ok(Math.abs(fitted.x + fitted.width / 2 - (viewport.x + viewport.width / 2)) < 2, 'fit centers the camera');
  assert.equal(await page.locator('.graph-viewport').evaluate(n => n.classList.contains('is-panning')), false);
});

test('edge labels hide when nodes overlap them and remain accessible at low zoom', async t => {
  const page = await pageFor(t), message = state('labels-test', 'goal');
  message.execution.blackboard = { sessionId: 'labels-test', rootId: 'root', revision: 1, nodes: [
    { id: 'root', kind: 'root', parentIds: [] },
    { id: 'i', kind: 'intent', parentIds: ['root'], resultId: 'f', intent: { description: '验证', status: 'completed' } },
    { id: 'f', kind: 'fact', producerId: 'i', parentIds: ['i'], fact: { content: '已验证事实' } },
    { id: 'other', kind: 'fact', parentIds: ['f'], fact: { content: '另一项事实' } }
  ] };
  await send(page, message); await page.locator('#goal-view-switcher > summary').click(); await page.locator('#goal-tab-board').click(); await paint(page);
  const label = page.locator('.graph-edge-label[data-intent-id="i"]'), line = page.locator('path[data-intent-id="i"]');
  // Viewport resize, geometry and label collision checks each settle on a frame.
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve)))));
  assert.equal(await label.isVisible(), true);
  const textBox = await label.boundingBox(), other = await page.locator('.graph-node[data-node-id="other"]').boundingBox();
  await page.mouse.move(other.x + other.width / 2, other.y + other.height / 2);
  await page.mouse.down(); await page.mouse.move(textBox.x + textBox.width / 2, textBox.y + textBox.height / 2, { steps: 8 }); await page.mouse.up();
  await page.waitForFunction(() => document.querySelector('.graph-edge-label').style.visibility === 'hidden');
  assert.equal(await line.getAttribute('tabindex'), '0');
  assert.match(await line.locator('title').textContent(), /验证/);
  await line.focus(); await page.keyboard.press('Enter');
  assert.match(await page.locator('.graph-detail').textContent(), /验证/);
  await page.getByRole('button', { name: '关闭节点详情' }).click();
  await page.getByRole('button', { name: '适应画布', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.graph-edge-label').style.visibility === 'visible');
  for (let i = 0; i < 3; i++) await page.getByRole('button', { name: '缩小探索图' }).click();
  await page.waitForFunction(() => document.querySelector('.graph-edge-label').style.visibility === 'hidden');
  assert.equal(await label.isVisible(), false);
  assert.equal(await line.getAttribute('tabindex'), '0');
  for (let i = 0; i < 3; i++) await page.getByRole('button', { name: '放大探索图' }).click();
  await page.waitForFunction(() => document.querySelector('.graph-edge-label').style.visibility === 'visible');
});


test('goal header substitutes module actions and restores overview controls', async t => {
  const page = await pageFor(t), message = state('module-actions', 'goal');
  await send(page, state('assist-actions'));
  assert.equal(await page.locator('#review-code-changes').isVisible(), true);
  message.execution.blackboard = { sessionId: 'module-actions', rootId: 'root', nodes: [{ id: 'root', kind: 'root', parentIds: [] }] };
  await send(page, message);
  assert.equal(await page.locator('#review-code-changes').isVisible(), false);
  assert.equal(await page.locator('#goal-mode').getAttribute('aria-label'), '探索模式');
  assert.match(await page.title(), /探索工作台/);
  const choose = async view => { await page.locator('#goal-view-switcher > summary').click(); await page.locator('#goal-tab-' + view).click(); await paint(page); };
  assert(await page.locator('#goal-edit').isVisible()); assert(await page.locator('#new-goal').isVisible());
  await choose('board');
  assert.equal(await page.locator('#goal-edit').isVisible(), false); assert.equal(await page.locator('#new-goal').isVisible(), false);
  assert.equal(await page.locator('.topbar #goal-board-actions button').count(), 0);
  assert(await page.locator('.graph-workspace .graph-controls').isVisible());
  assert.equal(await page.locator('.graph-direction, .graph-toolbar').count(), 0);
  const viewport = await page.locator('.graph-viewport').boundingBox();
  const controls = await page.locator('.graph-controls').boundingBox();
  assert(controls.x >= viewport.x && controls.y >= viewport.y && controls.y + controls.height <= viewport.y + viewport.height);
  assert(viewport.height > 500);
  assert.equal(await page.locator('#goal-board').getByRole('button', { name: '自动布局', exact: true }).count(), 0);
  await choose('notes');
  assert.equal(await page.locator('#goal-board-actions').isVisible(), false);
  assert(await page.locator('.topbar #note-new').isVisible());
  assert.equal(await page.locator('#goal-notes #note-new').count(), 0);
  await page.locator('#note-new').click(); assert(await page.locator('#goal-note-input').isVisible());
  await page.locator('#note-close').click();
  await send(page, { type: 'executionState', conversationId: 'module-actions', execution: message.execution, busy: false });
  assert(await page.locator('.topbar #note-new').isVisible()); assert.equal(await page.locator('#new-goal').isVisible(), false);
  await choose('overview');
  assert(await page.locator('#goal-edit').isVisible()); assert(await page.locator('#new-goal').isVisible());
  assert.equal(await page.locator('#goal-notes-actions').isVisible(), false);
  await send(page, state('assist-actions'));
  assert.equal(await page.locator('#review-code-changes').isVisible(), true);
});

test('opening Worker shows waiting, suppresses rapid clicks and releases controls after acknowledgement', async t => {
  const page = await pageFor(t);
  const current = state('waiting', 'goal'); current.nativeWorkerPanel = true;
  current.execution.workers = [{ id: 'w1', name: '检查项目', status: 'running', createdAt: 1000 }];
  await send(page, current);
  await page.locator('.goal-log-worker').evaluate(button => { for (let i = 0; i < 20; i++) button.click(); });
  const requests = await page.evaluate(() => sent.filter(message => message.action === 'openWorker'));
  assert.equal(requests.length, 1);
  assert.equal(await page.locator('#operation-loading').isVisible(), true);
  assert.match(await page.locator('#operation-loading').textContent(), /正在打开日志，请稍候/);
  assert.equal(await page.locator('.goal-log-worker').isDisabled(), true);
  await send(page, { type: 'uiResult', requestId: requests[0].requestId, ok: true });
  assert.equal(await page.locator('#operation-loading').isVisible(), false);
  assert.equal(await page.locator('.goal-log-worker').isDisabled(), false);
  await page.locator('.goal-log-worker').click();
  const latest = await page.evaluate(() => sent.filter(message => message.action === 'openWorker').at(-1));
  assert.notEqual(latest.requestId, requests[0].requestId);
  await send(page, { type: 'uiResult', requestId: latest.requestId, ok: false, error: '日志加载失败' });
  assert.equal(await page.locator('#operation-loading').isVisible(), false);
  assert.equal(await page.locator('.goal-log-worker').isDisabled(), false);
  assert.match(await page.locator('#ui-error-message').textContent(), /日志加载失败/);
});

 test('legacy hidden and swapped overview preferences cannot hide the single log panel', async t => {
  const page = await pageFor(t);
  await page.addInitScript(() => { window.persisted = { goalWorkerWidth: 700, goalPanelLayout: { log: false, workers: true, swapped: true } }; });
  await page.reload();
  const current = state('legacy-layout', 'goal');
  current.execution.parts = [{ id: 'reason-log', type: 'thinking', source: 'reason', text: '保留思考日志', status: 'completed' }];
  await send(page, current);
  assert.equal(await page.locator('[data-overview-panel="log"]').isVisible(), true);
  assert.match(await page.locator('#goal-output-content').textContent(), /保留思考日志/);
  assert.equal(await page.locator('[data-overview-panel="workers"], .goal-panel-controls, #goal-overview-split').count(), 0);
});


test('long-lived logs bound rendered rows, page older records and release hidden sessions', async t => {
  const page = await pageFor(t);
  const current = state('long-log', 'goal');
  current.execution.parts = Array.from({length: 3000}, (_, i) => ({ id: 'part-' + i, type: 'thinking', source: 'reason', status: 'completed', text: '记录 ' + i, startedAt: i + 1 }));
  await send(page, current);
  assert.equal(await page.locator('.goal-log-entry').count(), 120);
  assert.match(await page.locator('.goal-log-pager').textContent(), /3000/);
  await page.getByRole('button', {name: '较早日志', exact: true}).click();
  const first = await page.locator('.goal-log-entry').first().getAttribute('data-log-id');
  for (let i = 3000; i < 3100; i++) current.execution.parts.push({ id: 'part-' + i, type: 'text', text: '追加 ' + i, startedAt: i + 1 });
  await send(page, current);
  assert.equal(await page.locator('.goal-log-entry').count(), 120);
  assert.equal(await page.locator('.goal-log-entry').first().getAttribute('data-log-id'), first);
  await page.locator('#goal-log-bottom').click();
  assert.equal(await page.locator('.goal-log-entry').last().getAttribute('data-log-id'), 'part:part-3099');
  const heap = await page.context().newCDPSession(page);
  await heap.send('HeapProfiler.collectGarbage');
  const before = (await heap.send('Runtime.getHeapUsage')).usedSize;
  for (let cycle = 0; cycle < 20; cycle++) {
    await send(page, state('empty-' + cycle));
    assert.equal(await page.locator('.goal-log-entry').count(), 0);
    await send(page, current);
    assert.equal(await page.locator('.goal-log-entry').count(), 120);
  }
  await heap.send('HeapProfiler.collectGarbage');
  const after = (await heap.send('Runtime.getHeapUsage')).usedSize;
  t.diagnostic(`3100 records / 20 session cycles, GC heap: ${before} -> ${after} bytes; rendered rows <= 120`);
  await heap.detach();
});

test('replacing nested maintenance messages releases timers immediately', async t => {
  const page = await pageFor(t);
  const counts = await page.evaluate(() => {
    const interval = window.setInterval, clear = window.clearInterval, active = new Set();
    window.setInterval = (...args) => { const id = interval(...args); active.add(id); return id; };
    window.clearInterval = id => { active.delete(id); clear(id); };
    const target = document.createElement('div'); document.body.append(target);
    try {
      const values = [];
      for (let i = 0; i < 20; i++) {
        UBOVMMessage.update(target, '', { parts: [
          { id: 'summary', type: 'summary', status: 'running', startedAt: Date.now(), text: '整理中' },
          { id: 'wait', type: 'tool', name: 'wait_workers', status: 'running', startedAt: Date.now(), args: '{}' }
        ] });
        UBOVMMessage.update(target, '普通文本', { parts: [] });
        values.push(active.size);
      }
      return values;
    } finally { UBOVMMessage.release(target); target.remove(); window.setInterval = interval; window.clearInterval = clear; }
  });
  assert.deepEqual(counts, Array(20).fill(0));
});

test('streaming graph additions preserve existing nodes and session changes dispose the old graph', async t => {
  const page = await pageFor(t, { reducedMotion: 'reduce' }); const current = state('stable-growth', 'goal');
  current.execution.blackboard = { sessionId: 'stable-growth', rootId: 'root', revision: 1, nodes: [
    { id: 'root', kind: 'root', parentIds: [] }, { id: 'f', kind: 'fact', parentIds: ['root'], fact: { content: '初始事实' } }
  ] };
  await send(page, current); await page.locator('#goal-view-switcher > summary').click(); await page.locator('#goal-tab-board').click(); await paint(page);
  const node = page.locator('[data-node-id="f"]'); const original = await node.boundingBox();
  for (let i = 0; i < 12; i++) {
    current.execution.blackboard.nodes.push({ id: 'new-' + i, kind: 'fact', parentIds: ['root'], fact: { content: '新事实' } });
    current.execution.blackboard.revision++;
    await send(page, current);
    assert.deepEqual(await node.boundingBox(), original);
  }
  await send(page, state('other-assist'));
  assert.equal(await page.locator('.graph-canvas').count(), 0);
});


test('route loader paints before heavy content and entry motion starts only after commit', async t => {
  const page = await pageFor(t, { reducedMotion: 'no-preference' });
  const current = state('route-stages', 'goal');
  current.execution.blackboard = { sessionId: 'route-stages', revision: 1, nodes: Array.from({length: 200}, (_, i) => ({id: 'node-' + i, kind: 'fact', fact: {content: '事实 ' + i}})) };
  await send(page, current);
  const first = await page.evaluate(async () => {
    const animate = Element.prototype.animate;
    window.committedAnimations = [];
    Element.prototype.animate = function(...args) {
      const animation = animate.apply(this, args);
      committedAnimations.push({ target: this.id, loaderHidden: document.getElementById('route-loading').hidden, startup: document.body.dataset.loading });
      return animation;
    };
    document.getElementById('goal-tab-board').click();
    return await new Promise(resolve => requestAnimationFrame(() => resolve({
      loader: !document.getElementById('route-loading').hidden,
      busy: document.getElementById('main-content').getAttribute('aria-busy'),
      spinner: getComputedStyle(document.getElementById('route-loading-label'), '::before').animationName,
      graphs: document.querySelectorAll('.graph-canvas').length,
      animations: committedAnimations.length
    })));
  });
  assert.deepEqual(first, {loader: true, busy: 'true', spinner: 'loading-spin', graphs: 0, animations: 0});
  await page.waitForFunction(() => document.body.dataset.switching === 'false');
  assert.deepEqual(await page.evaluate(() => committedAnimations), [{target: 'goal-board', loaderHidden: true, startup: 'false'}]);
  assert.equal(await page.locator('#navigation-loading').isVisible(), false);
  assert.equal(await page.locator('#main-content').getAttribute('aria-busy'), 'false');
  await send(page, { type: 'executionState', conversationId: current.conversation.id, execution: current.execution, busy: false });
  assert.equal(await page.evaluate(() => committedAnimations.length), 1, 'stream updates do not replay entry motion');
});

test('interrupted route resumes after pageshow and render failure clears loading for retry', async t => {
  const page = await pageFor(t, { reducedMotion: 'reduce' });
  const current = state('route-recovery', 'goal');
  current.execution.blackboard = { sessionId: 'route-recovery', revision: 1, nodes: [{id: 'root', kind: 'root', parentIds: []}] };
  await send(page, current);
  await page.evaluate(() => {
    const create = window.createBlackboardGraph;
    let fail = true;
    window.createBlackboardGraph = (...args) => { if (fail) { fail = false; throw Error('test failure'); } return create(...args); };
    document.getElementById('goal-tab-board').click();
    window.dispatchEvent(new Event('pagehide'));
  });
  await paint(page);
  assert.equal(await page.locator('.graph-canvas').count(), 0);
  await page.evaluate(() => window.dispatchEvent(new Event('pageshow')));
  await page.locator('#ui-render-retry').waitFor();
  assert.equal(await page.locator('#route-loading').isVisible(), false);
  assert.equal(await page.locator('#main-content').getAttribute('aria-busy'), 'false');
  await page.locator('#ui-render-retry').click();
  await page.locator('.graph-canvas').waitFor();
  assert.equal(await page.locator('#ui-render-retry').isVisible(), false);
  assert.equal(await page.evaluate(() => document.getAnimations().some(a => a.id === 'page-enter')), false);
});


test('page suspension blocks late render and focus work and resumes only the newest stream', async t => {
  const page = await pageFor(t);
  await send(page, { ...state('suspended-stream'), busy: true, execution: { status: 'running', streamText: 'before suspension' } });
  const counts = await page.evaluate(async () => {
    const original = UBOVMMessage, input = document.getElementById('prompt-input');
    let paints = 0, focuses = 0;
    window.UBOVMMessage = { ...original, update(...args) { paints++; return original.update(...args); } };
    const focus = input.focus; input.focus = () => { focuses++; };
    dispatchEvent(new Event('pagehide'));
    for (let i = 0; i < 1000; i++) dispatchEvent(new MessageEvent('message', { data: {
      type: 'executionState', conversationId: 'suspended-stream', busy: true, execution: { status: 'running', streamText: 'latest-' + i }
    } }));
    dispatchEvent(new MessageEvent('message', { data: { type: 'focusInput', sessionId: 'suspended-stream' } }));
    dispatchEvent(new Event('resize'));
    const frame = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    await frame(); const paused = { paints, focuses, text: document.querySelector('.streaming-message').textContent };
    dispatchEvent(new Event('pageshow')); await frame();
    input.focus = focus;
    return { paused, paints, text: document.querySelector('.streaming-message').textContent };
  });
  assert.equal(counts.paused.paints, 0); assert.equal(counts.paused.focuses, 0);
  assert.match(counts.paused.text, /before suspension/);
  assert.equal(counts.paints, 1); assert.match(counts.text, /latest-999/);
});

test('first content acknowledgement waits for page recovery and is sent only once', async t => {
  const page = await pageFor(t);
  await page.evaluate(() => {
    const original = UBOVMMessage;
    let pause = true;
    window.UBOVMMessage = { ...original, update(...args) {
      const result = original.update(...args);
      if (pause) { pause = false; dispatchEvent(new Event('pagehide')); }
      return result;
    } };
  });
  await send(page, { ...state('initial-suspension'), busy: true, execution: { status: 'running', streamText: 'initial visible content' } });
  await paint(page);
  assert.equal(await page.evaluate(() => sent.filter(item => item.action === 'contentReady').length), 0);
  await page.evaluate(() => dispatchEvent(new Event('pageshow'))); await paint(page); await paint(page);
  assert.equal(await page.evaluate(() => sent.filter(item => item.action === 'contentReady').length), 1);
  await page.evaluate(() => dispatchEvent(new Event('pageshow'))); await paint(page);
  assert.equal(await page.evaluate(() => sent.filter(item => item.action === 'contentReady').length), 1);
});

test('component clocks pause across settings, background and page suspension without duplicating timers', async t => {
  const page = await pageFor(t);
  const result = await page.evaluate(() => {
    const interval = window.setInterval, clear = window.clearInterval, tracked = new Set();
    window.setInterval = (...args) => { const id = interval(...args); if (args[1] === 1000) tracked.add(id); return id; };
    window.clearInterval = id => { tracked.delete(id); clear(id); };
    const element = document.createElement('div'); document.body.append(element);
    const panel = createWorkerPanel({}, { standalone: true });
    const dialog = document.getElementById('settings-dialog');
    const counts = [];
    try {
      UBOVMMessage.update(element, '', { parts: [{ id: 'clock', type: 'tool', name: 'inspect', status: 'running', startedAt: Date.now(), args: '{}', output: '' }] });
      panel.update({ sessionId: 'clock', workers: [{ id: 'one', status: 'running', startedAt: Date.now() }] });
      counts.push(tracked.size);
      window.dispatchEvent(new Event('pagehide')); counts.push(tracked.size);
      window.dispatchEvent(new Event('pageshow')); window.dispatchEvent(new Event('pageshow')); counts.push(tracked.size);
      dialog.showModal(); window.dispatchEvent(new CustomEvent('ubovm-settings-visibility', { detail: { open: true } })); counts.push(tracked.size);
      dialog.close(); window.dispatchEvent(new CustomEvent('ubovm-settings-visibility', { detail: { open: false } })); counts.push(tracked.size);
      Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')); counts.push(tracked.size);
      Object.defineProperty(document, 'hidden', { configurable: true, value: false }); document.dispatchEvent(new Event('visibilitychange')); counts.push(tracked.size);
      UBOVMMessage.release(element); element.remove(); panel.update({ sessionId: 'empty', workers: [] }); counts.push(tracked.size);
      return counts;
    } finally { delete document.hidden; window.setInterval = interval; window.clearInterval = clear; }
  });
  assert.deepEqual(result, [2, 0, 2, 0, 2, 0, 2, 0]);
});


test('oversized Worker cache releases its transcript and restores lightweight reading preferences', async t => {
  const page = await pageFor(t);
  const result = await page.evaluate(() => {
    const original = UBOVMMessage; let released = 0;
    window.UBOVMMessage = { ...original, release(element) { released++; original.release(element); } };
    const panel = createWorkerPanel({}, { standalone: true });
    const workers = [{ id: 'large', status: 'completed', result: 'x'.repeat(1100000) }, { id: 'small', status: 'completed', result: 'small result' }];
    panel.update({ sessionId: 'large-cache', workers }); panel.show('large');
    const transcript = [...document.querySelectorAll('.worker-transcript')].find(node => node.textContent.length > 1000000);
    const workerPanel = transcript.closest('.worker-panel');
    // Store the preference via the actual follow button rather than component internals.
    const button = [...workerPanel.querySelectorAll('button')].find(node => node.textContent === '跟随最新'); button.click();
    panel.show('small'); const evicted = released;
    panel.show('large');
    const rebuilt = [...document.querySelectorAll('.worker-transcript')].find(node => node.textContent.length > 1000000);
    const restored = [...workerPanel.querySelectorAll('button')].some(node => node.textContent === '回到最新');
    panel.update({ sessionId: 'done', workers: [] });
    return { evicted, rebuilt: rebuilt !== transcript, restored };
  });
  assert.deepEqual(result, { evicted: 1, rebuilt: true, restored: true });
});
