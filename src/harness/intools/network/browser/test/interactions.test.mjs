import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright-core';
import { BrowserManager, createBrowserTools, BROWSER_ACTIONS, browserActionParameters } from '../index.mjs';

const executablePath = process.env.BROWSER_TEST_EXECUTABLE || [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe', chromium.executablePath(),
].find(path => existsSync(path));
const html = `<!doctype html><title>Browser regression</title>
<label><input type="checkbox" id="check">Enable feature</label>
<select multiple aria-label="Colors" id="colors"><option value="red">Red</option><option value="blue">Blue</option></select>
<label>Password<input type="password" value="do-not-return"></label>
<button disabled>Disabled</button><div id="host"></div><div style="height:1600px">Tall content</div>
<script>
const root = document.querySelector('#host').attachShadow({mode:'open'});
root.innerHTML = '<span id="label">Shadow action</span><button aria-labelledby="label">Run</button><div id="nested"></div>';
root.querySelector('button').onclick = () => document.body.dataset.clicked = 'yes';
root.querySelector('#nested').attachShadow({mode:'open'}).innerHTML = '<button>Nested action</button>';
</script>`;

test('browser schema exposes enhanced interactions', () => {
  assert.ok(BROWSER_ACTIONS.includes('check'));
  assert.ok(BROWSER_ACTIONS.includes('help'));
  for (const action of ['popup_policy', 'console']) assert.ok(BROWSER_ACTIONS.includes(action));
  for (const name of ['checked', 'values', 'full_page', 'allow_popups', 'level', 'topic']) assert.ok(browserActionParameters.properties[name]);
  assert.equal(browserActionParameters.properties.action.type, 'string');
});

test('real Chromium browser interactions', { skip: !executablePath && 'Set BROWSER_TEST_EXECUTABLE to run browser integration tests' }, async t => {
  let navigations = 0;
  const server = createServer((req, res) => {
    if (req.url === '/') navigations++;
    res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(html);
  });
  const manager = new BrowserManager({ executablePath, ...(/msedge\.exe$/i.test(executablePath) ? { channel: 'msedge' } : {}) });
  t.after(async () => {
    await manager.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const binding = { sessionId: 'regression', workerId: 'worker' };
  const call = input => manager.call(binding, input);
  const eventually = async read => {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (await read()) return;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.fail('Expected browser event was not observed within 5 seconds');
  };
  await t.test('first navigation requests the target only once', async () => {
    assert.equal((await call({ action: 'navigate', url })).url, url);
    assert.equal(navigations, 1);
  });
  await t.test('filters before pagination, discovers nested shadow controls and rejects stale refs', async () => {
    const first = await call({ action: 'snapshot', role: 'button', query: 'action', max_elements: 1 });
    assert.equal(first.total_elements, 2);
    assert.equal(first.has_more, true);
    assert.equal(first.elements[0].name, 'Shadow action');
    await call({ action: 'click', ref: first.elements[0].ref });
    assert.equal((await call({ action: 'evaluate', script: 'document.body.dataset.clicked' })).result, 'yes');
    const second = await call({ action: 'snapshot', role: 'button', query: 'action', offset: first.next_offset, max_elements: 1 });
    assert.equal(second.elements[0].name, 'Nested action');
    assert.equal(second.has_more, false);
    await call({ action: 'click', ref: second.elements[0].ref });
    await assert.rejects(call({ action: 'click', ref: first.elements[0].ref }), /stale element ref/);
    const ax = await call({ action: 'accessibility', role: 'button', query: 'action', max_elements: 1 });
    assert.equal(ax.elements[0].name, 'Shadow action');
  });
  await t.test('checkbox, multi-select and password omission', async () => {
    const snapshot = await call({ action: 'snapshot' });
    const checkbox = snapshot.elements.find(item => item.role === 'checkbox');
    assert.equal(checkbox.checked, false);
    assert.equal(snapshot.elements.find(item => item.name === 'Disabled').disabled, true);
    assert.equal('value' in snapshot.elements.find(item => item.name === 'Password'), false);
    await assert.rejects(call({ action: 'check', ref: checkbox.ref }), /checked must be a boolean/);
    await call({ action: 'check', ref: checkbox.ref, checked: true });
    await call({ action: 'check', ref: checkbox.ref, checked: true });
    assert.equal((await call({ action: 'evaluate', script: 'document.querySelector("#check").checked' })).result, true);
    await call({ action: 'check', ref: checkbox.ref, checked: false });
    const select = snapshot.elements.find(item => item.role === 'listbox');
    await assert.rejects(call({ action: 'select', ref: select.ref, value: 'red', values: ['blue'] }), /either value or values/);
    await call({ action: 'select', ref: select.ref, values: ['red', 'blue'] });
    assert.deepEqual((await call({ action: 'evaluate', script: '[...document.querySelector("#colors").selectedOptions].map(x => x.value)' })).result, ['red', 'blue']);
    await call({ action: 'select', ref: select.ref, values: [] });
    assert.equal((await call({ action: 'evaluate', script: 'document.querySelector("#colors").selectedOptions.length' })).result, 0);
  });
  await t.test('element screenshots and state waits use scoped references', async () => {
    const snapshot = await call({ action: 'snapshot', query: 'Shadow action' });
    const ref = snapshot.elements[0].ref;
    await call({ action: 'wait', ref, wait_for: 'visible' });
    await assert.rejects(call({ action: 'wait', ref, wait_for: 'networkidle' }), /wait_for with ref/);
    await assert.rejects(call({ action: 'screenshot', ref, full_page: true }), /either ref or full_page/);
    const [tool] = createBrowserTools({ manager, ...binding });
    const shot = await tool.execute('shot', { action: 'screenshot', ref });
    assert.equal(shot.content[1].mimeType, 'image/jpeg');
    assert.ok(Buffer.from(shot.content[1].data, 'base64').length > 100);
    const whole = await call({ action: 'screenshot', full_page: true });
    assert.ok(whole.image.data.length > shot.content[1].data.length);
    await call({ action: 'evaluate', script: 'document.querySelector("#host").shadowRoot.querySelector("button").style.display = "none"' });
    await call({ action: 'wait', ref, wait_for: 'hidden' });
    await call({ action: 'wait', ref, wait_for: 'attached' });
    await call({ action: 'evaluate', script: 'document.querySelector("#host").remove()' });
    await call({ action: 'wait', ref, wait_for: 'detached' });
    await call({ action: 'reload' });
    await assert.rejects(call({ action: 'click', ref }), /stale element ref/);
    await assert.rejects(manager.call({ ...binding, workerId: 'other' }, { action: 'snapshot', page_id: snapshot.page_id }), /another Worker/);
  });
  await t.test('console captures logs and uncaught errors with filtering, pagination and selective clearing', async () => {
    const baseline = await call({ action: 'console' });
    await call({ action: 'evaluate', script: 'console.log("fixture-log"); console.warn("fixture-warning"); setTimeout(() => { throw new Error("fixture-error"); }, 0)' });
    await eventually(async () => (await call({ action: 'console', query: 'fixture-error' })).entries.length > 0);
    const first = await call({ action: 'console', after_sequence: baseline.next_sequence, query: 'fixture-', limit: 1 });
    assert.equal(first.entries[0].text, 'fixture-log');
    assert.equal(first.has_more, true);
    const rest = await call({ action: 'console', after_sequence: first.next_sequence, query: 'fixture-' });
    assert.equal(rest.entries.length, 2);
    assert.equal(rest.entries[1].kind, 'pageerror');
    const warning = await call({ action: 'console', level: 'warning', query: 'fixture-', clear: true });
    assert.equal(warning.entries.length, 1);
    const retained = await call({ action: 'console', query: 'fixture-' });
    assert.equal(retained.entries.length, 2);
    assert.ok(retained.entries.some(entry => entry.level === 'error'));
    const empty = await call({ action: 'console', query: 'absent-string' });
    assert.equal(empty.entries.length, 0);
    assert.equal(empty.next_sequence, retained.next_sequence);
    await assert.rejects(call({ action: 'console', after_sequence: -1 }), /nonnegative/);
    await call({ action: 'cdp_detach' });
    await call({ action: 'evaluate', script: 'console.info("after-detach")' });
    await eventually(async () => (await call({ action: 'console', query: 'after-detach' })).entries.length === 1);
    await call({ action: 'evaluate', script: 'for (let i=0; i<510; i++) console.log("overflow-" + i); console.log("x".repeat(5000))' });
    await eventually(async () => (await call({ action: 'console', query: 'overflow-509' })).entries.length === 1);
    const overflow = await call({ action: 'console', limit: 200 });
    assert.equal(overflow.buffer_overflow, true);
    assert.ok(overflow.dropped_through_sequence > 0);
    const long = await call({ action: 'console', query: 'x'.repeat(100) });
    assert.equal(long.entries[0].text.length, 4000);
    assert.equal(long.entries[0].truncated, true);
  });
  await t.test('popups require opt-in, preserve selection, obey Worker limits and remain isolated', async () => {
    const initial = await call({ action: 'tabs' });
    const opener = initial.active_page_id;
    const open = () => call({ action: 'evaluate', page_id: opener, script: 'void window.open("/?popup")' });
    await open();
    await eventually(async () => (await call({ action: 'tabs' })).pages[0].blocked_popups === 1);
    assert.equal((await call({ action: 'tabs' })).pages.length, 1);
    await assert.rejects(call({ action: 'popup_policy' }), /allow_popups must be a boolean/);
    await call({ action: 'popup_policy', allow_popups: true });
    await open();
    await eventually(async () => (await call({ action: 'tabs' })).pages.length === 2);
    const tabs = await call({ action: 'tabs' });
    assert.equal(tabs.active_page_id, opener);
    const popup = tabs.pages.find(page => page.opener_page_id === opener);
    assert.equal(popup.allow_popups, false);
    await call({ action: 'wait', page_id: popup.page_id, wait_for: 'domcontentloaded' });
    const snapshot = await call({ action: 'snapshot', page_id: popup.page_id, role: 'checkbox' });
    await call({ action: 'check', page_id: popup.page_id, ref: snapshot.elements[0].ref, checked: true });
    await assert.rejects(manager.call({ ...binding, workerId: 'other' }, { action: 'console', page_id: popup.page_id }), /another Worker/);
    await call({ action: 'tab_activate', page_id: popup.page_id });
    assert.equal((await call({ action: 'tabs' })).active_page_id, popup.page_id);
    await call({ action: 'evaluate', script: 'console.log("popup-only"); void window.open("/?nested")' });
    await eventually(async () => (await call({ action: 'tabs' })).pages.find(page => page.page_id === popup.page_id).blocked_popups === 1);
    assert.equal((await call({ action: 'console', page_id: opener, query: 'popup-only' })).entries.length, 0);
    assert.equal((await call({ action: 'console', page_id: popup.page_id, query: 'popup-only' })).entries.length, 1);
    await call({ action: 'evaluate', page_id: opener, script: 'for(let i=0;i<5;i++) void window.open("/?burst=" + i)' });
    await eventually(async () => (await call({ action: 'tabs' })).pages.find(page => page.page_id === opener).blocked_popups === 4);
    const full = await call({ action: 'tabs' });
    assert.equal(full.pages.length, 4);
    await assert.rejects(call({ action: 'tab_new' }), /maximum of 4/);
    await call({ action: 'popup_policy', page_id: opener, allow_popups: false });
    for (const page of full.pages.filter(page => page.page_id !== opener)) await call({ action: 'tab_close', page_id: page.page_id });
    assert.equal((await call({ action: 'tabs' })).active_page_id, opener);
    await assert.rejects(call({ action: 'console', page_id: popup.page_id }), /unknown/);
  });
});
