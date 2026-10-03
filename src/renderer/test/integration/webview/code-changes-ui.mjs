import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { renderWebview } from '../../../host/ui/webview.cjs';
import { readFile } from 'node:fs/promises';

test('action rendering faults release locks without sending or replaying actions', async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage(); const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setContent('<div id="card"></div>');
    await page.addScriptTag({ content: await readFile(new URL('../../../webview/messages/code-changes.js', import.meta.url), 'utf8') });
    const result = await page.evaluate(async () => {
      let calls = 0, notices = 0;
      window.UBOVMRuntime = { fail() { notices++; } };
      const root = document.getElementById('card');
      const summary = { files: [{ id: 'a', path: 'a.ts', root: 0, state: 'applied' }] };
      const options = { turnId: 'one', onAction() { calls++; } };
      UBOVMCodeChanges.update(root, summary, options);
      const replace = root.replaceChildren;
      root.replaceChildren = () => { throw Error('DOM unavailable'); };
      root.querySelector('button').click(); await Promise.resolve();
      const prevented = calls === 0;
      root.replaceChildren = replace;
      UBOVMCodeChanges.update(root, summary, options);
      const unlocked = !root.querySelector('button').disabled;
      root.querySelector('button').click();
      root.replaceChildren = () => { throw Error('completion DOM failure'); };
      await Promise.resolve(); await Promise.resolve();
      root.replaceChildren = replace;
      UBOVMCodeChanges.update(root, summary, options);
      return { prevented, unlocked, notices, calls, recovered: !root.querySelector('button').disabled };
    });
    assert.deepEqual(result, { prevented: true, unlocked: true, notices: 2, calls: 1, recovered: true });
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('failed code card DOM commit can retry the identical snapshot', async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<div id="card">旧内容</div>');
    await page.addScriptTag({ content: await readFile(new URL('../../../webview/messages/code-changes.js', import.meta.url), 'utf8') });
    const result = await page.evaluate(() => {
      const root = document.getElementById('card');
      const summary = { added: 1, removed: 0, files: [{ id: 'a', path: 'new.ts', root: 0, added: 1, removed: 0, state: 'applied' }] };
      const options = { turnId: 'one', busy: false, onAction() {} };
      const replace = root.replaceChildren;
      root.replaceChildren = () => { throw Error('injected DOM fault'); };
      let failed = false;
      try { UBOVMCodeChanges.update(root, summary, options); } catch { failed = true; }
      root.replaceChildren = replace;
      const preserved = root.textContent === '旧内容';
      const retried = UBOVMCodeChanges.update(root, summary, options);
      const skipped = UBOVMCodeChanges.update(root, summary, options) === false;
      return { failed, preserved, retried, skipped, rendered: root.textContent.includes('new.ts') };
    });
    assert.deepEqual(result, { failed: true, preserved: true, retried: true, skipped: true, rendered: true });
  } finally { await browser.close(); }
});

test('late code action completion cannot overwrite a reused or detached turn card', async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage(); const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setContent('<div id="card"></div>');
    await page.addScriptTag({ content: await readFile(new URL('../../../webview/messages/code-changes.js', import.meta.url), 'utf8') });
    const result = await page.evaluate(async () => {
      const card = document.getElementById('card'), gates = [];
      const summary = name => ({ revision: name, added: 1, removed: 0, files: [{ id: name, path: name, root: 0, added: 1, removed: 0, state: 'applied' }] });
      const options = turnId => ({ turnId, busy: false, onAction: () => new Promise((resolve, reject) => gates.push({ resolve, reject })) });
      UBOVMCodeChanges.update(card, summary('old'), options('old'));
      card.querySelector('button').click();
      UBOVMCodeChanges.update(card, summary('new'), options('new'));
      const unlocked = !card.querySelector('button').disabled;
      card.querySelector('button').click();
      gates[0].reject(Error('old error')); await Promise.resolve(); await Promise.resolve();
      const isolated = card.textContent.includes('new') && !card.textContent.includes('old error') && card.querySelector('button').disabled;
      const child = card.firstChild; card.remove();
      gates[1].reject(null); await Promise.resolve(); await Promise.resolve();
      return { unlocked, isolated, detachedUnchanged: card.firstChild === child };
    });
    assert.deepEqual(result, { unlocked: true, isolated: true, detachedUnchanged: true });
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('turn cards show counts, send scoped file and undo actions, and preserve history', async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 420, height: 800 } });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      window.sent = [];
      window.acquireVsCodeApi = () => ({ getState: () => ({}), setState() {}, postMessage: message => window.sent.push(message) });
    });
    await page.route('http://code-changes.test/', route => route.fulfill({ contentType: 'text/html', body: renderWebview() }));
    await page.goto('http://code-changes.test/');
    const send = async value => {
      await page.evaluate(value => window.dispatchEvent(new MessageEvent('message', { data: value })), value);
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    };
    const state = {
      type: 'state', mode: 'assist', conversation: { id: 'session', title: '修改文件' },
      messages: [{ role: 'user', id: 'u1', text: '修改项目' }, { role: 'assistant', id: 'assist:round', text: '已完成修改。' }],
      context: { workspace: 'test', workspaceConfigured: true }, provider: { configured: true },
      busy: false, execution: { status: 'completed', busy: false, runId: 'round', parts: [], workers: [] },
      codeChanges: { round: { revision: 'r1', added: 4, removed: 2, undone: false, files: [
        { id: 'file1', root: 0, path: 'src/中文.ts', added: 3, removed: 2, operation: 'replace', state: 'applied' },
        { id: 'file2', root: 0, path: '<img onerror=alert(1)>.txt', added: 1, removed: 0, operation: 'create', state: 'applied' }
      ] } }
    };
    await send(state);
    const card = page.locator('#messages .code-change-card');
    assert.match(await card.textContent(), /本轮修改 2 个文件/);
    assert.match(await card.textContent(), /\+4 \/ −2/);
    assert.equal(await card.locator('img').count(), 0);
    assert.equal(await card.evaluate(node => node.scrollWidth <= node.clientWidth), true);
    await page.screenshot({ path: '.cache/code-changes-review.png', fullPage: true });
    const ack = async action => {
      const request = await page.evaluate(action => window.sent.findLast(message => message.action === action), action);
      assert.equal(request.sessionId, 'session'); assert.equal(request.turnId, 'round');
      await send({ type: 'uiResult', requestId: request.requestId, ok: true }); return request;
    };
    await card.getByRole('button', { name: 'src/中文.ts', exact: true }).click();
    assert.equal((await ack('reviewCodeTurnFile')).fileId, 'file1');
    assert.equal(await card.getByRole('button', { name: '查看差异', exact: true }).count(), 0);
    assert.equal(await page.evaluate(() => window.sent.some(message => message.action === 'openTurnFile')), false);
    await card.getByRole('button', { name: '一键撤销本轮全部修改', exact: true }).click();
    assert.equal(await card.getByRole('button', { name: '正在处理…', exact: true }).isDisabled(), true);
    const request = await page.evaluate(() => window.sent.findLast(message => message.action === 'undoCodeTurn'));
    assert.equal(request.revision, 'r1');
    await send({ type: 'uiResult', requestId: request.requestId, ok: false, error: '文件已变化' });
    assert.match(await card.locator('[role="alert"]').textContent(), /文件已变化/);
    await card.getByRole('button', { name: '一键撤销本轮全部修改', exact: true }).click();
    state.codeChanges.round.undone = true; state.codeChanges.round.revision = 'r2';
    for (const file of state.codeChanges.round.files) file.undone = true;
    await send(state); await ack('undoCodeTurn');
    assert.equal(await card.getByRole('button', { name: '本轮修改已撤销', exact: true }).isDisabled(), true);
    state.messages.push({ role: 'assistant', id: 'assist:empty', text: '这一轮只解释代码。' });
    await send(state);
    assert.equal(await page.locator('.code-change-card').count(), 2);
    assert.match(await page.locator('.code-change-card').last().textContent(), /未记录/);
    state.messages = [state.messages[0]];
    state.execution = { status: 'failed', busy: false, runId: 'round', parts: [], workers: [], canResume: true };
    state.codeChanges.round.undone = false;
    for (const file of state.codeChanges.round.files) file.undone = false;
    await send(state);
    assert.equal(await page.locator('.code-change-card').count(), 1);
    assert.match(await page.locator('.code-change-card').textContent(), /本轮修改 2 个文件/);
    state.busy = true; state.execution.busy = true; state.execution.status = 'running';
    state.messages.push({ role: 'assistant', id: 'assist:round', text: '历史回复' });
    await send(state);
    assert.equal(await page.getByRole('button', { name: '一键撤销本轮全部修改', exact: true }).isDisabled(), true);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
