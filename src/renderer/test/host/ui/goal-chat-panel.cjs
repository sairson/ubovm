'use strict';

// Host-side contract for the exploration chat native sidebar tab
// (`ubovm.goalChat`). The fake vscode object mirrors the real WebviewView shape:
// the provider must only publish after the page handshake, only while visible,
// and must never trust page-supplied session identity.

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { runInNewContext } = require('node:vm');
const { createGoalChatPanel, renderGoalChatPanel } = require('../../../host/ui/goal-chat-panel.cjs');

const CHAT = {
  status: 'completed',
  messages: [
    { id: 'chat:user-1', role: 'user', text: '现在进展到哪一步了？', at: 1 },
    { id: 'chat:answer-1', role: 'assistant', text: '目标已保存，正在核对证据。', at: 2 }
  ],
  streamText: '', error: null, canStop: false, updatedAt: 3
};
const THREADS = [
  { id: 'goal-one', title: '验证聊天契约', active: true, draft: '' },
  { id: 'goal-two', title: '检查第二个目标', active: false, draft: '未发送的草稿' }
];
const projection = (overrides = {}) => ({
  sessionId: 'goal-one', mode: 'goal', available: true, modelReady: true, offline: false, goalMissing: false,
  imageInput: true, threads: THREADS, chat: CHAT, ...overrides
});

function fakeView() {
  const received = [], messages = [], disposals = [], subscriptions = [];
  const view = {
    visible: true, title: undefined, shown: 0,
    show() { view.shown++; },
    webview: {
      options: undefined,
      html: undefined,
      onDidReceiveMessage(fn) { subscriptions.push(fn); return { dispose() { disposals.push('message'); } }; },
      postMessage(message) { messages.push(structuredClone(message)); return Promise.resolve(true); }
    },
    onDidChangeVisibility(fn) { view.visibility = fn; return { dispose() { disposals.push('visibility'); } }; },
    onDidDispose(fn) { view.disposeView = fn; return { dispose() { disposals.push('view'); } }; }
  };
  view.received = received; view.messages = messages; view.disposals = disposals; view.subscriptions = subscriptions;
  view.receive = async message => { for (const fn of subscriptions) await fn(message); };
  return view;
}

test('provider renders the standalone page, handshakes and only then publishes the projection', async () => {
  const commands = [], errors = [];
  const panel = createGoalChatPanel({ commands: { async executeCommand(command) { commands.push(command); } } }, {
    onAction() {}, onError: error => errors.push(error.message)
  });
  assert.equal(panel.visible, false);
  assert.equal(panel.publish(), undefined, 'nothing can be delivered before a view exists');
  panel.update(projection());
  assert.doesNotThrow(() => panel.update(undefined));

  const view = fakeView();
  panel.resolveWebviewView(view);
  assert.equal(typeof view.webview.html, 'string');
  assert.match(view.webview.html, /id="goal-chat"/);
  assert.match(view.webview.html, /role="log"/);
  assert.match(view.webview.html, /exploration|探索对话/);
  assert.match(view.webview.html, /Content-Security-Policy/);
  assert.deepEqual(view.webview.options, { enableScripts: true, localResourceRoots: [] });
  assert.equal(view.title, '探索对话');
  assert.equal(panel.visible, false, 'a resolved view is not ready until the page answers');
  assert.equal(view.messages.length, 0);

  panel.update(projection({ sessionId: 'goal-two' }));
  assert.equal(view.messages.length, 0, 'no projection is posted before the handshake');

  await view.receive({ action: 'ready' });
  assert.equal(panel.visible, true);
  assert.equal(view.messages.length, 1);
  assert.deepEqual(view.messages[0], { type: 'goalChat', ...projection({ sessionId: 'goal-two' }) });
  // v3 payload fields pass through verbatim; the provider never rewrites them.
  assert.equal(view.messages[0].sessionId, 'goal-two');
  assert.deepEqual(view.messages[0].threads, THREADS);
  assert.equal(view.messages[0].goalMissing, false);
  assert.equal(view.messages[0].imageInput, true, 'the page learns whether the model accepts images');

  const released = panel.show();
  assert.deepEqual(commands, ['workbench.view.extension.ubovm-goal-chat']);
  assert.equal(await released, true);
  assert.equal(view.shown, 1);
  panel.dispose();
  assert.deepEqual(errors, []);
});

test('hidden views miss streaming ticks and receive only the latest projection when revealed', async () => {
  const panel = createGoalChatPanel({ commands: { async executeCommand() {} } }, { onAction() {} });
  const view = fakeView();
  panel.resolveWebviewView(view);
  await view.receive({ action: 'ready' });
  panel.update(projection());
  assert.equal(view.messages.length, 1);

  view.visible = false;
  for (let index = 0; index < 50; index++) panel.update(projection({ chat: { ...CHAT, streamText: '第 ' + index + ' 段' } }));
  assert.equal(view.messages.length, 1, 'hidden sidebars do not receive streaming projections');

  view.visible = true;
  view.visibility();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(view.messages.length, 2);
  assert.equal(view.messages.at(-1).chat.streamText, '第 49 段', 'reveal publishes the latest snapshot once');

  // Availability changes for another mode still publish; the page owns the copy.
  panel.update(projection({ available: false, mode: 'assist' }));
  assert.equal(view.messages.at(-1).available, false);
  assert.equal(view.messages.at(-1).mode, 'assist');
  panel.dispose();
});

test('page actions are forwarded with the view while a re-render requires a new handshake', async () => {
  const actions = [], errors = [];
  let actionView;
  const panel = createGoalChatPanel({ commands: { async executeCommand() {} } }, {
    onAction: async (message, view) => { actions.push(message); actionView = view; },
    onError: error => errors.push(error.message)
  });
  const view = fakeView();
  panel.resolveWebviewView(view);
  await view.receive({ action: 'ready' });

  await view.receive({ action: 'goalChatSend', text: '还有哪些没有验证完？', requestId: 'r-1' });
  await view.receive({ action: 'goalChatCancel', requestId: 'r-2' });
  await view.receive({ action: 'copyText', text: 'answer' });
  assert.deepEqual(actions.map(message => message.action), ['goalChatSend', 'goalChatCancel', 'copyText']);
  assert.deepEqual(actions[0], { action: 'goalChatSend', text: '还有哪些没有验证完？', requestId: 'r-1' });
  assert.equal(actionView, view);

  // Image-bearing sends forward the page payload verbatim; the host validates
  // and saves the data URLs later in its own action handler.
  const images = [{ name: 'shot.png', mimeType: 'image/png', data: 'data:image/png;base64,iVBORw0KGgo=' }];
  await view.receive({ action: 'goalChatSend', text: '', images, requestId: 'r-image' });
  assert.deepEqual(actions.at(-1), { action: 'goalChatSend', text: '', images, requestId: 'r-image' });

  // A rejected handler is reported through onError instead of escaping the listener.
  const failing = createGoalChatPanel({ commands: {} }, { onAction: () => { throw new Error('host action failed'); }, onError: error => errors.push(error.message) });
  const failingView = fakeView();
  failing.resolveWebviewView(failingView);
  await failingView.receive({ action: 'ready' });
  await failingView.receive({ action: 'goalChatSend', text: 'x', requestId: 'r-3' });
  assert.deepEqual(errors, ['host action failed']);
  failing.dispose();
  panel.dispose();
});

test('image capability and saved message descriptors pass through unchanged', async () => {
  const panel = createGoalChatPanel({ commands: { async executeCommand() {} } }, { onAction() {} });
  const view = fakeView();
  panel.resolveWebviewView(view);
  await view.receive({ action: 'ready' });
  // The backend keeps the host-only path on the descriptor; the page receives
  // the projection untouched and resolves pixels through goalChatImage.
  const images = [{ id: 'image-1', name: '截图.png', mimeType: 'image/png', bytes: 12, path: 'C:\\tmp\\attachments\\image-1.png' }];
  const chat = {
    ...CHAT,
    messages: [...CHAT.messages, { id: 'chat:user-image', role: 'user', text: '', at: 3, images }]
  };
  panel.update(projection({ imageInput: false, chat }));
  assert.equal(view.messages.at(-1).imageInput, false, 'a text-only model disables the attach control');
  assert.deepEqual(view.messages.at(-1).chat.messages.at(-1).images, images);
  panel.dispose();
});

test('applyLanguage re-renders with a fresh nonce and dispose releases every subscription', async () => {
  const panel = createGoalChatPanel({ commands: { async executeCommand() {} } }, { onAction() {} });
  const view = fakeView();
  panel.resolveWebviewView(view);
  await view.receive({ action: 'ready' });
  panel.update(projection());
  const first = view.webview.html;
  panel.applyLanguage();
  assert.notEqual(view.webview.html, first, 'a new locale re-renders the page');
  assert.equal(panel.visible, false, 'the re-rendered page must handshake again');
  panel.update(projection({ chat: { ...CHAT, streamText: '新的投影' } }));
  assert.equal(view.messages.length, 1, 'projections wait for the new page handshake');
  await view.receive({ action: 'ready' });
  assert.equal(view.messages.at(-1).chat.streamText, '新的投影');

  panel.dispose();
  assert.equal(panel.visible, false);
  assert.deepEqual(view.disposals.sort(), ['message', 'view', 'visibility']);
  await assert.rejects(panel.show(), /关闭/);
  const count = view.messages.length;
  panel.update(projection());
  assert.equal(view.messages.length, count, 'a disposed provider ignores later projections');
});

test('the rendered page ships the accessible shell, quick questions and goal-chat bootstrap', () => {
  const first = renderGoalChatPanel();
  const second = renderGoalChatPanel();
  assert.match(first, /<aside id="goal-chat" class="goal-chat goal-chat-page" aria-label="探索对话"/);
  assert.match(first, /id="goal-chat-log" role="log" aria-live="polite"/);
  assert.match(first, /id="goal-chat-input"/);
  // The composer can attach images: a labelled button, a hidden multi-file
  // input restricted to the supported formats, and a pending strip above it.
  assert.match(first, /id="goal-chat-attach"/);
  assert.match(first, /id="goal-chat-image-input"/);
  assert.match(first, /type="file"/);
  assert.match(first, /accept="image\/png,image\/jpeg,image\/webp,image\/gif[^"]*"/);
  assert.match(first, /multiple hidden/);
  assert.match(first, /id="goal-chat-images"[^>]*role="group"/);
  assert.match(first, /aria-label="待发送图片"/);
  assert.match(first, /可粘贴或拖入图片/);
  assert.match(first, /img-src data: https:/, 'saved thumbnails are data URIs, so the CSP must allow them');
  // Both halves of the attachment bridge ship in the served bundle: the page
  // intake helpers and the view-side host request.
  assert.match(first, /addImageFiles/);
  assert.match(first, /goalChatImage/, 'the page bridge requests saved thumbnails from the host');
  assert.match(first, /goal-chat-message-images/);
  assert.equal((first.match(/class="goal-chat-suggestion"/g) || []).length, 3);
  assert.match(first, /data-question="现在进展到哪一步了？"/);
  assert.match(first, /goal-chat-view\.js|createGoalChat/);
  const nonce = first.match(/script-src 'nonce-([^']+)'/)[1];
  assert.equal(nonce, first.match(/script nonce="([^"]+)"/)[1]);
  assert.notEqual(second.match(/script nonce="([^"]+)"/)[1], nonce, 'each page gets a fresh CSP nonce');
  assert.match(first, /<html lang="zh-CN">|<html lang="en">/);
});

// The extension host owns the image half of the bridge. It cannot be required
// directly in-process (it needs the `vscode` module), so its goal-chat bridge
// block is evaluated in a sandbox with the attachment store and harness stubbed;
// the page cannot pass a host path, and only saved descriptors reach the backend.
const EXTENSION_SOURCE = readFileSync(require.resolve('../../../extension.cjs'), 'utf8');
const IMAGE_ID = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6';
const MANAGED_PATH = 'C:\\attachments\\goal-one\\shot.png';
const plain = value => JSON.parse(JSON.stringify(value));
function goalChatBridgeSource() {
  const start = EXTENSION_SOURCE.indexOf('  function goalChatText(');
  const end = EXTENSION_SOURCE.indexOf('  // The exploration chat page posts its own actions');
  assert.ok(start > 0 && end > start, 'the goal chat host bridge block moved; update this contract test');
  return EXTENSION_SOURCE.slice(start, end);
}
function goalChatBridge({ input = ['text', 'image'], state } = {}) {
  const saved = [], sent = [];
  const sandbox = {
    MAX_IMAGES_PER_MESSAGE: 4,
    sessions: { current: () => ({ id: 'goal-one', mode: 'goal', goal: { objective: '核对证据' } }) },
    assertCurrentSession() {},
    modelConfiguration: { status: () => ({ input }) },
    saveImage: async value => {
      saved.push(value);
      return { id: IMAGE_ID, name: value.name || 'image.png', mimeType: 'image/png', bytes: 70, path: MANAGED_PATH };
    },
    isManagedImage: value => value === MANAGED_PATH,
    loadImage: async () => ({ data: 'AAAA', mimeType: 'image/png', bytes: 3 }),
    harness: {
      state: () => state ?? {
        goalChat: {
          messages: [{ id: 'chat:user-1', role: 'user', text: '', images: [{ id: IMAGE_ID, name: 'shot.png', mimeType: 'image/png', bytes: 70, path: MANAGED_PATH }] }]
        }
      },
      goalChatSend: async (...args) => { sent.push(args); }
    },
    publishState() {}
  };
  runInNewContext(goalChatBridgeSource(), sandbox);
  return { sandbox, saved, sent };
}

test('the exploration chat host bridge saves whitelisted image fields and forwards descriptors', async () => {
  const { sandbox, saved, sent } = goalChatBridge();
  const incoming = [{ name: '截图.png', mimeType: 'image/png', data: 'data:image/png;base64,AAAA', path: 'C:\\evil\\x.png', url: 'https://example.test/x.png' }];
  assert.deepEqual(plain(sandbox.goalChatImages(undefined)), []);
  assert.deepEqual(plain(sandbox.goalChatImages(incoming)), [{ name: '截图.png', mimeType: 'image/png', data: 'data:image/png;base64,AAAA' }]);
  assert.throws(() => sandbox.goalChatImages('nope'), /图片数据无效/);
  assert.throws(() => sandbox.goalChatImages(new Array(5).fill(incoming[0])), /一条消息最多附加 4 张图片/);

  await sandbox.goalChatSend('goal-one', '看这个', incoming);
  assert.equal(saved.length, 1);
  assert.deepEqual(plain(saved[0]), { conversationId: 'goal-one', name: '截图.png', mimeType: 'image/png', data: 'data:image/png;base64,AAAA' });
  assert.equal(sent.length, 1);
  assert.deepEqual(plain(sent[0]), ['goal-one', '看这个', [{ id: IMAGE_ID, name: '截图.png', mimeType: 'image/png', bytes: 70, path: MANAGED_PATH }]]);

  // An image-only turn is valid; the page sends empty text and the backend captions it.
  await sandbox.goalChatSend('goal-one', '', incoming);
  assert.equal(sent.at(-1)[1], '');
  await assert.rejects(sandbox.goalChatSend('goal-one', '   ', []), /请输入要询问的内容或添加图片/);
});

test('a text-only model rejects goal chat images before the attachment is saved', async () => {
  const { sandbox, saved, sent } = goalChatBridge({ input: ['text'] });
  await assert.rejects(
    sandbox.goalChatSend('goal-one', '看这个', [{ name: 'a.png', mimeType: 'image/png', data: 'AAAA' }]),
    { code: 'MODEL_IMAGE_UNSUPPORTED' }
  );
  assert.deepEqual(saved, [], 'nothing is written to the attachment store');
  assert.equal(sent.length, 0, 'the backend is never asked to persist an unsupported turn');
});

test('saved goal chat thumbnails resolve only from managed attachments', async () => {
  const { sandbox } = goalChatBridge();
  assert.deepEqual(plain(await sandbox.goalChatImage(IMAGE_ID)), { uri: 'data:image/png;base64,AAAA', name: 'shot.png' });
  await assert.rejects(sandbox.goalChatImage('ffffffffffffffffffffffffffffffff'), /图片已不存在或不属于当前对话/);
  await assert.rejects(sandbox.goalChatImage(''), /图片标识无效/);
  const tampered = goalChatBridge({
    state: { goalChat: { messages: [{ role: 'user', text: '看图', images: [{ id: IMAGE_ID, name: 'a.png', mimeType: 'image/png', bytes: 1, path: 'C:\\Windows\\evil.png' }] }] } }
  });
  await assert.rejects(tampered.sandbox.goalChatImage(IMAGE_ID), /图片不在附件目录中/);
});
