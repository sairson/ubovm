import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { renderWebview } from '../host/webview.cjs';

const screenshotDirectory = fileURLToPath(new URL('../../../.cache', import.meta.url));
let browser;
test.before(async () => {
  await mkdir(screenshotDirectory, { recursive: true });
  browser = await chromium.launch({ headless: true, executablePath: process.env.UBOVM_STYLE_EDGE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' });
});
test.after(async () => browser?.close());

function state(id = 'composer-a', overrides = {}) {
  return {
    type: 'state', mode: 'assist', conversation: { id, title: '输入体验回归' }, messages: [], goal: null,
    context: { workspace: 'UBOVM', file: '', fileSource: null },
    provider: { configured: true, connected: true, label: '测试模型' },
    busy: false, execution: { status: 'idle', busy: false, streamText: '', activities: [], canResume: false },
    ...overrides
  };
}

async function fixture(viewport = { width: 900, height: 800 }) {
  const page = await browser.newPage({ viewport, reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    window.hostMessages = [];
    window.savedDrafts = {};
    window.acquireVsCodeApi = () => ({
      getState: () => window.savedDrafts,
      setState: value => { window.savedDrafts = value; },
      postMessage: value => window.hostMessages.push(value)
    });
  });
  const html = renderWebview({ version: 'test', workspaceName: 'UBOVM', nonce: 'assist-composer-test' });
  await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: html }));
  await page.goto('http://assist-composer.test/');
  const frames = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const emit = async value => {
    await page.evaluate(value => window.dispatchEvent(new MessageEvent('message', { data: value })), value);
    await frames();
  };
  const sent = action => page.evaluate(action => window.hostMessages.filter(message => message.action === action), action);
  const ack = (message, ok = true) => emit({ type: 'uiResult', requestId: message.requestId, ok, ...(ok ? {} : { error: '测试请求失败，保留草稿' }) });
  const input = page.locator('#prompt-input');
  const fill = async text => { await input.fill(text); await frames(); };
  const close = async () => { assert.deepEqual(errors, [], 'the composer must not generate browser exceptions'); await page.close(); };
  return { page, input, emit, frames, sent, ack, fill, close };
}

test('selected code context shows its range, preserves drafts and can be removed in either mode', async () => {
  const f = await fixture();
  try {
    await f.emit(state()); await f.fill('解释这段代码');
    const context = { workspace: 'UBOVM', file: 'src/component.ts', fileSource: 'selection', selectionLabel: 'L3–7' };
    await f.emit(state('composer-a', { context }));
    assert.equal(await f.page.locator('#context-label').textContent(), 'component.ts · L3–7');
    assert.match(await f.page.locator('#composer-file').getAttribute('title'), /添加时的快照/);
    assert.equal(await f.input.inputValue(), '解释这段代码');
    assert.equal((await f.sent('prompt')).length, 0);
    await f.page.locator('#remove-context').click();
    await f.ack((await f.sent('clearFileContext')).at(-1));
    await f.emit(state('composer-a', { mode: 'goal', context }));
    assert.equal(await f.page.locator('#goal-selection-context').isVisible(), true);
    assert.equal(await f.page.locator('#goal-selection-label').textContent(), 'component.ts · L3–7');
    await f.page.locator('#goal-selection-context button').click();
    assert.equal((await f.sent('clearFileContext')).at(-1).sessionId, 'composer-a');
  } finally { await f.close(); }
});

test('deleted conversation drafts are removed from persisted webview state without erasing remaining drafts', async () => {
  const f = await fixture();
  try {
    await f.emit(state('keep', { conversationIds: ['keep', 'deleted'] })); await f.fill('保留草稿');
    await f.emit(state('deleted', { conversationIds: ['keep', 'deleted'] })); await f.fill('删除草稿');
    await f.emit(state('keep', { conversationIds: ['keep'] }));
    assert.equal(await f.input.inputValue(), '保留草稿');
    const drafts = await f.page.evaluate(() => window.savedDrafts.drafts);
    assert.equal(drafts.deleted, undefined); assert.equal(drafts.keep.assist, '保留草稿');
    await f.emit(state('blank', { conversationIds: ['blank'] }));
    assert.equal(await f.input.inputValue(), '');
    assert.deepEqual(await f.page.evaluate(() => Object.keys(window.savedDrafts.drafts)), ['blank']);
  } finally { await f.close(); }
});

test('assist input grows, shrinks, limits long text, and respects IME and keyboard submission', async () => {
  const f = await fixture();
  try {
    await f.emit(state());
    const submit = f.page.locator('#submit-prompt');
    assert.equal(await submit.isDisabled(), true);
    await f.fill('  \n  ');
    assert.equal(await submit.isDisabled(), true, 'whitespace alone cannot be submitted');
    await f.fill('检查输入体验');
    const oneLine = await f.input.evaluate(element => element.getBoundingClientRect().height);
    await f.fill('保留每一行的上下文\n'.repeat(5));
    const severalLines = await f.input.evaluate(element => element.getBoundingClientRect().height);
    assert(severalLines > oneLine, 'the textarea grows with several lines');
    await f.fill('继续逐行解释实现\n'.repeat(90));
    const longInput = await f.input.evaluate(element => ({ height: element.getBoundingClientRect().height, scrollHeight: element.scrollHeight, clientHeight: element.clientHeight }));
    assert(longInput.height >= severalLines && longInput.height < 800 / 2, 'long drafts have a bounded height');
    assert(longInput.scrollHeight > longInput.clientHeight, 'overflow scrolls inside the textarea');
    await f.fill('短草稿');
    assert(Math.abs(await f.input.evaluate(element => element.getBoundingClientRect().height) - oneLine) < 2, 'deleting long content restores compact height');

    const maximum = Number(await f.input.getAttribute('maxlength'));
    assert(maximum > 0);
    await f.fill('字'.repeat(maximum));
    await f.input.press('End');
    await f.input.press('x');
    assert.equal((await f.input.inputValue()).length, maximum, 'typing cannot exceed the supported draft length');
    assert.equal(await f.page.locator('#prompt-count').isVisible(), true, 'the limit is visible near the maximum');
    assert((await f.page.locator('#prompt-count').textContent()).replace(/[,\s]/g, '').includes(String(maximum)));

    await f.fill('中文输入');
    await f.input.evaluate(element => {
      element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '中' }));
      element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true, bubbles: true, cancelable: true }));
      element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 229, bubbles: true, cancelable: true }));
      element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
      element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '中文' }));
    });
    assert.equal((await f.sent('prompt')).length, 0, 'IME confirmation must not send a prompt');
    await f.input.press('End');
    await f.input.press('Shift+Enter');
    assert((await f.input.inputValue()).includes('\n'), 'Shift+Enter creates a real newline');
    assert.equal((await f.sent('prompt')).length, 0);
    await f.fill('  单次提交  ');
    await f.input.press('Enter');
    await f.input.press('Enter');
    await f.page.locator('#prompt-form').evaluate(element => element.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    const submitted = await f.sent('prompt');
    assert.equal(submitted.length, 1, 'Enter and form submit share the pending request guard');
    assert.equal(submitted[0].text, '单次提交');
    assert.equal(submitted[0].sessionId, 'composer-a');
    assert(submitted[0].requestId);
    await f.ack(submitted[0], false);
    assert.equal(await f.input.inputValue(), '  单次提交  ', 'failed requests retain the exact original draft');
    assert.equal(await f.page.locator('#ui-error').isVisible(), true);
    assert.equal(await submit.isEnabled(), true);
    await f.input.press('Enter');
    await f.ack((await f.sent('prompt')).at(-1));
    assert.equal(await f.input.inputValue(), '', 'successful requests clear an unchanged submitted draft');
  } finally { await f.close(); }
});

test('busy assist runs allow next drafts while acknowledgments and session changes preserve ownership', async () => {
  const f = await fixture();
  try {
    const a = state();
    const running = state('composer-a', {
      messages: [{ role: 'user', text: '已提交的请求' }], busy: true,
      execution: { status: 'running', busy: true, streamText: '正在分析', activities: [] }
    });
    await f.emit(a);
    await f.fill('已提交的请求');
    await f.input.press('Enter');
    const firstRequest = (await f.sent('prompt')).at(-1);
    await f.emit(running);
    assert.equal(await f.input.isEnabled(), true, 'the next assist draft stays editable during execution');
    await f.fill('下一条草稿，不应被旧请求清空');
    await f.ack(firstRequest);
    assert.equal(await f.input.inputValue(), '下一条草稿，不应被旧请求清空');
    const before = { prompts: (await f.sent('prompt')).length, stops: (await f.sent('cancelRun')).length };
    await f.input.press('Enter');
    assert.equal((await f.sent('prompt')).length, before.prompts, 'Enter during execution does not queue an implicit request');
    assert.equal((await f.sent('cancelRun')).length, before.stops, 'Enter while composing never stops a run');
    assert((await f.page.locator('#composer-status').textContent()).trim(), 'the busy composer explains its current state');

    await f.input.evaluate(element => { element.focus(); element.setSelectionRange(3, 8); window.composerNode = element; });
    for (let index = 0; index < 12; index++) {
      const execution = { ...running.execution, streamText: '流式输出 '.repeat(index + 1) };
      await f.emit(index % 2 ? { type: 'executionState', conversationId: 'composer-a', execution, busy: true } : { ...running, execution });
    }
    assert.deepEqual(await f.input.evaluate(element => ({ same: window.composerNode === element, focus: document.activeElement === element, selection: [element.selectionStart, element.selectionEnd], value: element.value })), {
      same: true, focus: true, selection: [3, 8], value: '下一条草稿，不应被旧请求清空'
    }, 'stream updates must retain the input node, focus, selection and value');
    await f.page.locator('#submit-prompt').click();
    const stop = (await f.sent('cancelRun')).at(-1);
    assert(stop?.requestId, 'the explicit stop control sends a tracked stop action');
    assert.equal(await f.page.locator('#submit-prompt').isDisabled(), true, 'a pending stop cannot be repeated');
    await f.ack(stop);
    await f.emit({ ...running, busy: false, execution: { status: 'interrupted', busy: false, canResume: false } });
    assert.equal(await f.page.locator('#submit-prompt').isEnabled(), true);
    assert.equal(await f.input.inputValue(), '下一条草稿，不应被旧请求清空');
    await f.input.press('Enter');
    const delayedRequest = (await f.sent('prompt')).at(-1);
    const b = state('composer-b');
    await f.emit(b);
    assert.equal(await f.input.inputValue(), '', 'a new session begins with its own draft');
    await f.fill('会话 B 的草稿');
    await f.emit({ type: 'executionState', conversationId: 'composer-a', execution: running.execution, busy: true });
    assert.equal(await f.page.locator('#submit-prompt').getAttribute('data-running'), 'false', 'old-session stream events cannot change the current composer state');
    await f.ack(delayedRequest);
    assert.equal(await f.input.inputValue(), '会话 B 的草稿', 'a previous session acknowledgment cannot clear the current draft');
    await f.emit(a);
    assert.equal(await f.input.inputValue(), '', 'the successful acknowledgment clears the owning session draft');
    await f.fill('会话 A 的后续草稿');
    await f.emit(b);
    assert.equal(await f.input.inputValue(), '会话 B 的草稿');
    await f.emit(a);
    assert.equal(await f.input.inputValue(), '会话 A 的后续草稿');

    await f.emit(state('goal-c', { mode: 'goal', goal: { objective: '保留探索模式行为', criteria: [], notes: [] }, busy: true, execution: { status: 'running', busy: true } }));
    assert.equal(await f.page.locator('#goal-objective-input').isDisabled(), true, 'goal mode retains its execution-time edit guard');
  } finally { await f.close(); }
});

test('context chips and model labels reflect host state with scoped, acknowledged file changes', async () => {
  const f = await fixture();
  try {
    await f.emit(state());
    const chip = f.page.locator('#composer-file');
    assert.equal(await chip.isVisible(), false, 'an absent file has no placeholder attachment chip');
    assert.equal(await f.page.locator('#provider-label').textContent(), '测试模型');
    await f.fill('携带所选文件的下一条请求');
    await f.page.locator('#attach-file').click();
    const attachedRequest = (await f.sent('attachFile')).at(-1);
    assert(attachedRequest?.requestId, 'file selection must have an acknowledgment id');
    assert.equal(attachedRequest.sessionId, 'composer-a');
    await f.input.press('Enter');
    assert.equal((await f.sent('prompt')).length, 0, 'a pending file picker cannot race prompt submission');
    assert.equal(await f.input.isEnabled(), true, 'choosing context does not lock draft editing');
    await f.ack(attachedRequest);
    const attached = state('composer-a', { context: { workspace: 'UBOVM', file: 'C:\\project\\src\\组件.tsx', fileSource: 'attached' } });
    await f.emit(attached);
    assert.equal(await chip.isVisible(), true);
    assert.equal(await f.page.locator('#context-label').textContent(), '组件.tsx');
    assert.equal(await chip.getAttribute('data-source'), 'attached');
    const explicitSource = (await chip.getAttribute('title')).replace(attached.context.file, '').trim();
    await f.page.locator('#remove-context').click();
    const clearRequest = (await f.sent('clearFileContext')).at(-1);
    assert(clearRequest?.requestId);
    assert.equal(clearRequest.sessionId, 'composer-a');
    await f.input.press('Enter');
    assert.equal((await f.sent('prompt')).length, 0, 'a pending clear cannot submit stale file context');
    await f.ack(clearRequest, false);
    assert.equal(await chip.isVisible(), true, 'a failed clear retains the known host attachment');
    await f.page.locator('#remove-context').click();
    await f.ack((await f.sent('clearFileContext')).at(-1));
    await f.emit(state());
    assert.equal(await chip.isVisible(), false);
    await f.emit(state('composer-a', { context: { workspace: 'UBOVM', file: 'C:\\project\\active.ts', fileSource: 'active' } }));
    assert.equal(await chip.isVisible(), true);
    assert.equal(await f.page.locator('#context-label').textContent(), 'active.ts');
    assert.equal(await chip.getAttribute('data-source'), 'active');
    const activeSource = (await chip.getAttribute('title')).replace('C:\\project\\active.ts', '').trim();
    assert.notEqual(activeSource, explicitSource, 'active editor context and explicit file attachment are distinguishable');
    await f.emit(state('composer-b', { provider: { connected: false, configured: false, label: '等待配置模型', error: '连接尚未配置' } }));
    assert.equal(await chip.isVisible(), false, 'file chips do not carry over to another conversation');
    assert.equal(await f.page.locator('#provider-label').textContent(), '等待配置模型');
    assert((await f.page.locator('#provider-label').getAttribute('title')).includes('连接尚未配置'));
    await f.emit(attached);
    assert.equal(await f.page.locator('#context-label').textContent(), '组件.tsx', 'returning to a session renders its own file context');
  } finally { await f.close(); }
});

test('composer and long user messages fit narrow, wide, short and dark IDE surfaces', async () => {
  for (const viewport of [{ width: 320, height: 760 }, { width: 600, height: 760 }, { width: 1000, height: 760 }, { width: 600, height: 360 }]) {
    const f = await fixture(viewport);
    try {
      const label = `${viewport.width}x${viewport.height}`;
      await f.emit(state());
      await f.input.scrollIntoViewIfNeeded();
      await f.fill('可以直接描述你的下一步');
      assert.equal(await f.page.locator('#submit-prompt').isVisible(), true);
      assert.equal(await f.page.locator('#provider-label').isVisible(), true);
      await f.emit(state('composer-a', {
        context: { workspace: 'UBOVM', file: 'C:\\project\\src\\very-long-module-name-for-context-rendering-and-overflow-regression.tsx', fileSource: 'attached' },
        provider: { connected: true, label: 'Provider / a-very-long-model-identifier-with-reasoning-enabled' },
        messages: [
          { role: 'user', text: '请完善这个模块，并保留每一条验收条件。\n' + 'unbroken_source_identifier_'.repeat(160) },
          { role: 'assistant', text: '我会检查输入、上下文与执行状态。\n\n- 草稿保留\n- 文件上下文\n- 稳定的流式输出' }
        ]
      }));
      await f.fill('需要保留的多行草稿\n'.repeat(80));
      const geometry = await f.page.evaluate(() => {
        const rect = selector => { const value = document.querySelector(selector).getBoundingClientRect(); return { left: value.left, right: value.right, top: value.top, bottom: value.bottom, width: value.width, height: value.height }; };
        return {
          width: innerWidth, height: innerHeight, documentWidth: document.documentElement.scrollWidth,
          shellWidth: document.querySelector('.shell').scrollWidth,
          composer: rect('#prompt-form'), input: rect('#prompt-input'), submit: rect('#submit-prompt'),
          provider: rect('#provider-label'), user: rect('#messages .message.user'),
          messageWidth: document.querySelector('#messages .message.user .message-text').scrollWidth,
          messageClient: document.querySelector('#messages .message.user .message-text').clientWidth
        };
      });
      assert(geometry.documentWidth <= viewport.width + 1 && geometry.shellWidth <= viewport.width + 1, `${label}: the page has no horizontal overflow`);
      for (const key of ['composer', 'input', 'submit', 'provider']) {
        const rectangle = geometry[key];
        assert(rectangle.width > 0 && rectangle.height > 0, `${label}: ${key} has a usable box`);
        assert(rectangle.left >= -1 && rectangle.right <= viewport.width + 1, `${label}: ${key} fits horizontally`);
        assert(rectangle.top >= -1 && rectangle.bottom <= viewport.height + 1, `${label}: ${key} remains visible vertically`);
      }
      assert(geometry.messageWidth <= geometry.messageClient + 1, `${label}: unbroken user text wraps inside its reading column`);
      assert(geometry.user.left >= geometry.composer.left - 2 && geometry.user.right <= geometry.composer.right + 2, `${label}: user messages stay inside the composer reading column: ${JSON.stringify({ user: geometry.user, composer: geometry.composer })}`);
      if (viewport.height === 760) {
        await f.fill('为这个模块增加边界检查，先给我简短的实现方案。\n保留现有接口。');
        await f.page.screenshot({ path: `${screenshotDirectory}/assist-composer-${viewport.width}.png` });
      }
      if (viewport.width === 1000) {
        await f.emit(state('composer-a', {
          context: { workspace: 'UBOVM', file: 'C:\\project\\src\\renderer\\webview\\app.js', fileSource: 'attached' },
          provider: { connected: true, label: 'Worker · 本地测试模型' },
          messages: [
            { role: 'user', text: '优化协助模式下的输入体验，让上下文、模型和发送状态更清晰。\n执行时也允许我准备下一条消息。' },
            { role: 'assistant', text: '我会完善输入框的层次和交互，保留你当前的草稿。\n\n- **上下文**：显示已添加的文件，并支持移除。\n- **草稿**：输入区随内容增长，执行期间仍可编辑。\n- **发送**：Enter 发送，Shift + Enter 换行，执行时显示停止按钮。\n\n新消息会继续使用当前会话的模型和上下文。' }
          ]
        }));
        await f.fill('同时检查中文输入法，避免确认候选词时误发送。');
        await f.page.screenshot({ path: `${screenshotDirectory}/assist-composer-conversation.png` });
      }
      if (viewport.width === 600 && viewport.height === 760) {
        await f.page.evaluate(() => {
          document.body.classList.add('vscode-dark');
          for (const [key, value] of Object.entries({ '--vscode-foreground': '#d4d4d4', '--vscode-descriptionForeground': '#a6a6a6', '--vscode-editor-background': '#1e1e1e', '--vscode-panel-border': '#383838', '--vscode-focusBorder': '#6b8eae' })) document.documentElement.style.setProperty(key, value);
        });
        await f.frames();
        await f.page.screenshot({ path: `${screenshotDirectory}/assist-composer-dark.png` });
      }
      if (viewport.height === 360) await f.page.screenshot({ path: `${screenshotDirectory}/assist-composer-short.png` });
    } finally { await f.close(); }
  }
});
