'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createIdeBrowserHost, SUPPORTED, UNSUPPORTED_HINT } = require('../../../host/system/ide-browser-host.cjs');

function fakeVscode(options = {}) {
  const tabs = [];
  let activeTab;
  const locks = [];
  const listeners = {
    close: [],
    active: [],
    state: []
  };
  let lastOpen;
  function setActive(tab) {
    activeTab = tab;
    for (const listener of listeners.active) listener(tab);
  }

  const commands = new Map([
    ['workbench.action.browser.open', async urlOrOptions => {
      const openOptions = typeof urlOrOptions === 'string' ? { url: urlOrOptions } : (urlOrOptions || {});
      const target = openOptions.url || 'about:blank';
      if (openOptions.reuseUrlFilter) {
        const match = (activeTab && activeTab.url === openOptions.reuseUrlFilter ? activeTab : undefined)
          || tabs.find(tab => tab.url === openOptions.reuseUrlFilter || tab.url === target);
        if (match) {
          setActive(match);
          return match;
        }
      }
      const tab = makeTab(target);
      tabs.push(tab);
      setActive(tab);
      return tab;
    }],
    ['workbench.action.browser.setAgentControlLock', async (locked, reason) => { locks.push({ locked, reason }); }]
  ]);
  function makeTab(url) {
    let closed = false;
    let title = url;
    const tab = {
      get url() { return url; },
      set url(value) { url = value; },
      get title() { return title; },
      set title(value) { title = value; },
      async startCDPSession() {
        const handlers = [];
        return {
          onDidReceiveMessage(listener) {
            handlers.push(listener);
            return { dispose() {} };
          },
          async sendMessage(message) {
            try {
              const result = options.cdp?.(message, {
                tab,
                emit(method, params, extra = {}) {
                  queueMicrotask(() => {
                    for (const handler of handlers) handler({ method, params, ...extra });
                  });
                }
              }) ?? {};
              queueMicrotask(() => {
                for (const handler of handlers) handler({ id: message.id, result, sessionId: message.sessionId });
              });
            } catch (error) {
              queueMicrotask(() => {
                for (const handler of handlers) handler({
                  id: message.id,
                  error: { message: error.message || String(error) },
                  sessionId: message.sessionId
                });
              });
            }
          },
          async close() {}
        };
      },
      async close() {
        closed = true;
        const index = tabs.indexOf(tab);
        if (index >= 0) tabs.splice(index, 1);
        if (activeTab === tab) activeTab = tabs[tabs.length - 1];
        for (const listener of listeners.close) listener(tab);
      },
      get closed() { return closed; }
    };
    return tab;
  }
  if (options.lockFails) commands.delete('workbench.action.browser.setAgentControlLock');
  return {
    ViewColumn: { One: 1, Two: 2, Beside: -2 },
    get lastOpen() { return lastOpen; },
    window: {
      get browserTabs() { return tabs; },
      get activeBrowserTab() { return activeTab; },
      async openBrowserTab(url, openOptions) {
        lastOpen = { url, options: openOptions };
        const tab = makeTab(url);
        tabs.push(tab);
        // Background tabs exist for agent actions without becoming the visible page.
        if (openOptions?.background !== true) setActive(tab);
        return tab;
      },
      onDidCloseBrowserTab(listener) {
        listeners.close.push(listener);
        return { dispose() { listeners.close = listeners.close.filter(item => item !== listener); } };
      },
      onDidChangeActiveBrowserTab(listener) {
        listeners.active.push(listener);
        return { dispose() { listeners.active = listeners.active.filter(item => item !== listener); } };
      },
      onDidChangeBrowserTabState(listener) {
        listeners.state.push(listener);
        return { dispose() { listeners.state = listeners.state.filter(item => item !== listener); } };
      },
      ...(options.browserPane === true ? {
        tabGroups: { all: [{ isActive: true, tabs: [{ label: 'Browser', input: { constructor: { name: 'BrowserEditorInput' } } }] }] }
      } : {})
    },
    commands: {
      executeCommand: async (id, ...args) => {
        const handler = commands.get(id);
        if (!handler) throw new Error('missing command ' + id);
        return handler(...args);
      },
      getCommands: async () => [...commands.keys()]
    },
    locks, tabs, listeners, makeTab
  };
}

function pageEvalCdp(message, helpers) {
  if (message.method === 'Runtime.enable' || message.method === 'Page.enable' || message.method === 'Accessibility.enable') return {};
  if (message.method === 'Page.navigate') {
    helpers.tab.url = message.params.url;
    helpers.tab.title = message.params.url;
    helpers.emit('Page.loadEventFired', {});
    return { frameId: 'main', loaderId: 'loader-1' };
  }
  if (message.method === 'Page.reload') {
    helpers.emit('Page.loadEventFired', {});
    return {};
  }
  if (message.method === 'Page.captureScreenshot') {
    return { data: Buffer.from('jpeg').toString('base64') };
  }
  if (message.method === 'Accessibility.getFullAXTree') {
    return { nodes: [{ role: { value: 'button' }, name: { value: 'Run' }, ignored: false }] };
  }
  if (message.method === 'Page.getFrameTree') {
    return {
      frameTree: {
        frame: { id: 'main', url: helpers.tab.url, name: '', securityOrigin: 'https://example.com', mimeType: 'text/html' },
        childFrames: [{ frame: { id: 'child', parentId: 'main', url: 'https://example.com/frame', name: 'frame', securityOrigin: 'https://example.com', mimeType: 'text/html' } }]
      }
    };
  }
  if (message.method === 'Page.createIsolatedWorld') return { executionContextId: 4242 };
  if (message.method === 'Runtime.evaluate') {
    const expression = message.params.expression;
    // Minimal DOM emulator for snapshot/interaction scripts.
    const sandbox = {
      document: globalThis.__ideDom || createDom(),
      console: { log() {}, info() {}, warn() {}, error() {}, debug() {} },
      window: null,
      location: { href: helpers.tab.url },
      getComputedStyle: () => ({ visibility: 'visible', display: 'block' }),
      CSS: { escape: value => String(value).replace(/"/g, '\\"') },
      Node: class {},
      MouseEvent: class { constructor(type) { this.type = type; this.bubbles = true; } },
      KeyboardEvent: class { constructor(type, init = {}) { this.type = type; this.key = init.key; this.bubbles = true; } },
      Event: class { constructor(type) { this.type = type; this.bubbles = true; } },
      Buffer
    };
    sandbox.window = sandbox;
    sandbox.window.devicePixelRatio = 1;
    sandbox.window.scrollBy = () => {};
    sandbox.window.scrollX = 40;
    sandbox.window.scrollY = 100;
    sandbox.window.innerWidth = 1280;
    sandbox.window.innerHeight = 720;
    sandbox.window.addEventListener = () => {};
    globalThis.__ideDom = sandbox.document;
    // eslint-disable-next-line no-new-func
    const fn = new Function('document', 'console', 'window', 'location', 'getComputedStyle', 'CSS', 'MouseEvent', 'KeyboardEvent', 'Event',
      `return (${expression.startsWith('(') ? expression : `(${expression})`})`);
    try {
      const value = fn(sandbox.document, sandbox.console, sandbox.window, sandbox.location, sandbox.getComputedStyle, sandbox.CSS, sandbox.MouseEvent, sandbox.KeyboardEvent, sandbox.Event);
      return { result: { value } };
    } catch (error) {
      return { exceptionDetails: { text: error.message, exception: { description: error.message } } };
    }
  }
  return {};
}

function createDom() {
  const bodyText = 'Shadow action page';
  let document;
  function el(tag, props = {}) {
    const node = {
      tagName: tag.toUpperCase(),
      id: props.id || '',
      type: props.type || '',
      value: props.value || '',
      checked: !!props.checked,
      disabled: !!props.disabled,
      multiple: !!props.multiple,
      size: props.size || 0,
      options: props.options || [],
      isContentEditable: false,
      shadowRoot: props.shadowRoot || null,
      attributes: { ...(props.attrs || {}) },
      labels: props.labels || [],
      innerText: props.innerText || '',
      textContent: props.innerText || '',
      getAttribute(name) { return this.attributes[name] ?? (name === 'role' ? props.role || null : null); },
      setAttribute(name, value) { this.attributes[name] = String(value); },
      removeAttribute(name) { delete this.attributes[name]; },
      hasAttribute(name) { return name in this.attributes || (name === 'href' && props.href != null); },
      matches(selector) {
        if (selector === ':disabled') return !!this.disabled;
        return selector.split(',').some(part => {
          const item = part.trim();
          if (item === tag || item === tag.toLowerCase()) return true;
          if (item.startsWith('[') && item.endsWith(']')) {
            const attr = item.slice(1, -1).replace(/="true"/, '');
            return this.hasAttribute(attr) || (attr === 'role' && props.role);
          }
          return false;
        });
      },
      getRootNode() { return props.root || document; },
      getBoundingClientRect: () => ({ x: 1, y: 1, width: 20, height: 12 }),
      scrollIntoView() {},
      scrollBy() {},
      focus() {},
      click() { this.clicked = true; document.body.dataset.clicked = 'yes'; },
      dispatchEvent() { return true; }
    };
    if (props.href != null) node.attributes.href = props.href;
    if (props.role) node.attributes.role = props.role;
    if (props['aria-label']) node.attributes['aria-label'] = props['aria-label'];
    return node;
  }
  const shadowRoot = {
    getElementById() { return null; },
    querySelectorAll(sel) {
      if (sel === '*') return [shadowButton];
      if (sel.startsWith('[data-intools-ref')) return shadowButton.attributes['data-intools-ref'] ? [shadowButton] : [];
      return [shadowButton].filter(node => node.matches(sel));
    }
  };
  const shadowButton = el('button', {
    'aria-label': 'Shadow action',
    attrs: { 'aria-label': 'Shadow action' },
    root: shadowRoot
  });
  const host = el('div', { id: 'host', shadowRoot });
  const checkbox = el('input', { type: 'checkbox', id: 'check', labels: [{ innerText: 'Enable feature' }] });
  const password = el('input', { type: 'password', value: 'secret', attrs: { name: 'Password' }, labels: [{ innerText: 'Password' }] });
  const disabled = el('button', { disabled: true, innerText: 'Disabled', attrs: {} });
  const light = [host, checkbox, password, disabled];
  document = {
    body: { innerText: bodyText, dataset: {} },
    getElementById(id) { return light.find(node => node.id === id) || null; },
    querySelectorAll(sel) {
      if (sel === '*') return light;
      if (sel === '[data-intools-ref]') return [...light, shadowButton].filter(node => node.attributes['data-intools-ref']);
      return light.filter(node => node.matches(sel));
    },
    querySelector(sel) {
      return document.querySelectorAll(sel)[0] || null;
    }
  };
  return document;
}

describe('ide-browser-host', () => {
  it('reports connected status and opens a tab', async () => {
    const vscode = fakeVscode();
    const host = createIdeBrowserHost(vscode);
    const status = await host.status({ sessionId: 's', workerId: 'w' });
    assert.equal(status.source, 'ide-browser');
    assert.equal(status.available, true);
    assert.ok(status.supported_actions.includes('snapshot'));
    const opened = await host.open('https://example.com');
    assert.equal(opened.tab.url, 'https://example.com');
    assert.equal(vscode.tabs.length, 1);
    assert.equal(vscode.lastOpen.options.viewColumn, vscode.ViewColumn.Two);
    assert.equal(vscode.lastOpen.options.preserveFocus, false);
  });

  it('opens the native welcome surface without navigating to about:blank', async () => {
    const vscode = fakeVscode();
    const host = createIdeBrowserHost(vscode);
    const opened = await host.open('', { startBlank: true, preserveFocus: false, viewColumn: vscode.ViewColumn.Two });
    assert.equal(vscode.lastOpen.url, '');
    assert.equal(opened.tab.url, '');
    assert.equal(vscode.tabs.length, 1);
  });

  it('keeps agent tab_new in the background and honors explicit user focus', async () => {
    const vscode = fakeVscode();
    const host = createIdeBrowserHost(vscode);
    await host.open('about:blank', { preserveFocus: false, viewColumn: vscode.ViewColumn.Two });
    assert.equal(vscode.lastOpen.options.preserveFocus, false);
    await host.call({ sessionId: 's', workerId: 'w' }, { action: 'tab_new', url: 'https://example.com/agent' });
    assert.equal(vscode.lastOpen.options.preserveFocus, true);
    assert.equal(vscode.lastOpen.options.background, true);
  });

  it('locks for the whole agent task and unlocks only when the task ends', async () => {
    const vscode = fakeVscode({ cdp: pageEvalCdp });
    const host = createIdeBrowserHost(vscode);
    await host.open('about:blank');
    await host.call({ sessionId: 's', workerId: 'w' }, { action: 'navigate', url: 'https://example.com/a' });
    assert.deepEqual(vscode.locks.map(item => item.locked), [true], 'the first browser action keeps the tab locked after it returns');
    await host.call({ sessionId: 's', workerId: 'w' }, { action: 'snapshot' });
    assert.deepEqual(vscode.locks.map(item => item.locked), [true], 'later calls reuse the task lock');
    await host.endAgentTask();
    assert.deepEqual(vscode.locks.map(item => item.locked), [true, false], 'the mask is released when the whole task ends');
  });

  it('uses an in-page task mask when the prebuilt workbench has no native lock command', async () => {
    const expressions = [];
    const cdp = (message, helpers) => {
      if (message.method === 'Runtime.evaluate') { expressions.push(message.params.expression); return {}; }
      return pageEvalCdp(message, helpers);
    };
    const vscode = fakeVscode({ cdp, lockFails: true });
    const host = createIdeBrowserHost(vscode);
    await host.open('about:blank');
    await host.call({ sessionId: 's', workerId: 'w' }, { action: 'navigate', url: 'https://example.com/a' });
    assert.ok(expressions.some(expression => expression.includes('__ubovm_agent_control_overlay__')), 'fallback mask is injected');
    assert.ok(expressions.some(expression => expression.includes('接管页面')), 'fallback mask offers manual takeover');
    await host.endAgentTask();
    assert.ok(expressions.some(expression => expression.includes('root.remove()')), 'task end removes the fallback mask');
  });
  it('yields agent control for user interaction and reacquires on the next action', async () => {
    const vscode = fakeVscode({ cdp: pageEvalCdp });
    const host = createIdeBrowserHost(vscode);
    await host.open('about:blank');
    await host.call({ sessionId: 's', workerId: 'w' }, { action: 'navigate', url: 'https://example.com/login' });
    const locked = await host.call({ sessionId: 's', workerId: 'w' }, { action: 'status' });
    assert.equal(locked.agent_control, 'agent');
    assert.equal(locked.yield_supported, true);
    const yielded = await host.call({ sessionId: 's', workerId: 'w' }, { action: 'yield_control' });
    assert.equal(yielded.control, 'user');
    assert.match(yielded.guidance, /login|MFA|consent/i);
    assert.deepEqual(vscode.locks.map(item => item.locked), [true, false], 'user interaction releases the native lock');
    const userControl = await host.call({ sessionId: 's', workerId: 'w' }, { action: 'status' });
    assert.equal(userControl.agent_control, 'user');
    await host.call({ sessionId: 's', workerId: 'w' }, { action: 'snapshot' });
    assert.deepEqual(vscode.locks.map(item => item.locked), [true, false, true], 'the next action reacquires the lock');
    const agentControl = await host.call({ sessionId: 's', workerId: 'w' }, { action: 'status' });
    assert.equal(agentControl.agent_control, 'agent');
  });

  it('does not lock for status', async () => {
    const vscode = fakeVscode();
    const host = createIdeBrowserHost(vscode);
    await host.call({ sessionId: 's', workerId: 'w' }, { action: 'status' });
    assert.equal(vscode.locks.length, 0);
  });

  it('rejects unsupported security actions with guidance', async () => {
    const vscode = fakeVscode();
    const host = createIdeBrowserHost(vscode);
    const result = await host.call({ sessionId: 's', workerId: 'w' }, { action: 'identity_capture' });
    assert.equal(result.ok, false);
    assert.match(result.error, /IDE 内嵌浏览器/);
    assert.match(UNSUPPORTED_HINT, /Obscura/);
    assert.equal(SUPPORTED.has('navigate'), true);
    assert.equal(SUPPORTED.has('identity_capture'), false);
  });

  it('snapshot assigns refs and click uses them across shadow roots', async () => {
    globalThis.__ideDom = undefined;
    const vscode = fakeVscode({ cdp: pageEvalCdp });
    const host = createIdeBrowserHost(vscode);
    await host.open('https://example.com');
    const snapshot = await host.call({ sessionId: 's', workerId: 'w' }, {
      action: 'snapshot', role: 'button', query: 'shadow', max_elements: 5
    });
    assert.ok(snapshot.elements?.length >= 1);
    assert.match(snapshot.elements[0].ref, /^r[a-z0-9]+_0$/);
    assert.equal(snapshot.elements[0].name, 'Shadow action');
    const clicked = await host.call({ sessionId: 's', workerId: 'w' }, {
      action: 'click', ref: snapshot.elements[0].ref
    });
    assert.equal(clicked.ok, true);
    await assert.rejects(
      () => host.call({ sessionId: 's', workerId: 'w' }, { action: 'click', ref: 'missing_ref' }),
      /stale element ref/
    );
  });

  it('tab_activate reveals an existing page without opening another tab', async () => {
    const vscode = fakeVscode({ cdp: pageEvalCdp });
    const host = createIdeBrowserHost(vscode);
    const first = await host.open('https://example.com/one');
    const second = await host.open('https://example.com/two');
    assert.equal(vscode.tabs.length, 2);
    const activated = await host.call({ sessionId: 's', workerId: 'w' }, {
      action: 'tab_activate', page_id: first.id
    });
    assert.equal(activated.page_id, first.id);
    assert.equal(vscode.tabs.length, 2);
    assert.notEqual(second.id, first.id);
  });

  it('reveal reuses an open page by url filter', async () => {
    const vscode = fakeVscode();
    const host = createIdeBrowserHost(vscode);
    await host.open('https://example.com/reuse');
    assert.equal(vscode.tabs.length, 1);
    const revealed = await host.reveal('https://example.com/reuse');
    assert.equal(vscode.tabs.length, 1);
    assert.equal(revealed.tab.url, 'https://example.com/reuse');
    const pages = host.listPages();
    assert.equal(pages.length, 1);
    assert.equal(pages[0].url, 'https://example.com/reuse');
  });

  it('navigate updates the active page without opening another tab', async () => {
    globalThis.__ideDom = undefined;
    const vscode = fakeVscode({ cdp: pageEvalCdp });
    const host = createIdeBrowserHost(vscode);
    const opened = await host.open('about:blank');
    assert.equal(vscode.tabs.length, 1);
    await host.navigate('https://example.com/next', opened.id);
    assert.equal(vscode.tabs.length, 1);
    assert.equal(vscode.tabs[0].url, 'https://example.com/next');
  });

  it('keeps distinct page ids for duplicate urls and a single active flag', async () => {
    const vscode = fakeVscode();
    const host = createIdeBrowserHost(vscode);
    const first = await host.open('https://example.com/same');
    const second = await host.open('https://example.com/same');
    assert.equal(vscode.tabs.length, 2);
    assert.notEqual(first.id, second.id);
    const pages = host.listPages();
    assert.equal(pages.length, 2);
    assert.equal(pages.filter(page => page.active).length, 1);
    assert.equal(pages.every(page => page.url === 'https://example.com/same'), true);
    assert.ok('loading' in pages[0]);
    assert.ok('canGoBack' in pages[0]);
    assert.ok('canGoForward' in pages[0]);

    await host.call({ sessionId: 's', workerId: 'w' }, { action: 'tab_activate', page_id: first.id });
    const after = host.listPages();
    const active = after.find(page => page.active);
    assert.equal(active?.id, first.id);
    assert.equal(vscode.tabs.length, 2);
  });

  it('attaches to the page session before Page.enable', async () => {
    const methods = [];
    const vscode = fakeVscode({
      cdp(message, helpers) {
        methods.push({ method: message.method, sessionId: message.sessionId });
        if (message.method === 'Target.setDiscoverTargets') return {};
        if (message.method === 'Target.getTargets') {
          return { targetInfos: [{ targetId: 'page-1', type: 'page', url: helpers.tab.url }] };
        }
        if (message.method === 'Target.attachToTarget') {
          assert.equal(message.params.targetId, 'page-1');
          assert.equal(message.params.flatten, true);
          return { sessionId: 'sess-page' };
        }
        if (!message.sessionId) {
          throw new Error(`Method not found: ${message.method}`);
        }
        return pageEvalCdp(message, helpers);
      }
    });
    const host = createIdeBrowserHost(vscode);
    await host.open('about:blank');
    await host.call({ sessionId: 's', workerId: 'w' }, { action: 'navigate', url: 'https://example.com/cdp' });
    assert.ok(methods.some(item => item.method === 'Target.attachToTarget' && !item.sessionId));
    assert.ok(methods.some(item => item.method === 'Page.enable' && item.sessionId === 'sess-page'));
    assert.ok(methods.some(item => item.method === 'Page.navigate' && item.sessionId === 'sess-page'));
    assert.equal(vscode.tabs[0].url, 'https://example.com/cdp');
  });

  it('handle routes open/status/call', async () => {
    globalThis.__ideDom = undefined;
    const vscode = fakeVscode({ cdp: pageEvalCdp });
    const host = createIdeBrowserHost(vscode);
    const status = await host.handle('status', { binding: { sessionId: 's', workerId: 'w' } });
    assert.equal(status.source, 'ide-browser');
    await host.handle('open', { url: 'https://example.com' });
    const shot = await host.handle('call', {
      binding: { sessionId: 's', workerId: 'w' },
      input: { action: 'screenshot' }
    });
    assert.equal(shot.source, 'ide-browser');
    assert.equal(shot.image.mimeType, 'image/jpeg');
  });

  it('reuses one CDP session per page across actions', async () => {
    globalThis.__ideDom = undefined;
    let attaches = 0;
    const vscode = fakeVscode({
      cdp(message, helpers) {
        if (message.method === 'Target.setDiscoverTargets') return {};
        if (message.method === 'Target.getTargets') return { targetInfos: [{ targetId: 'p1', type: 'page', url: helpers.tab.url }] };
        if (message.method === 'Target.attachToTarget') { attaches++; return { sessionId: 'sess-1' }; }
        return pageEvalCdp(message, helpers);
      }
    });
    const host = createIdeBrowserHost(vscode);
    await host.open('https://example.com');
    await host.call({ sessionId: 's', workerId: 'w' }, { action: 'snapshot', role: 'button' });
    await host.call({ sessionId: 's', workerId: 'w' }, { action: 'snapshot', role: 'button' });
    assert.equal(attaches, 1);
  });

  it('dispatches real input events for click, hover, press and scroll', async () => {
    globalThis.__ideDom = undefined;
    const input = [];
    const vscode = fakeVscode({
      cdp(message, helpers) {
        if (message.method.startsWith('Input.')) { input.push(message.params); return {}; }
        return pageEvalCdp(message, helpers);
      }
    });
    const host = createIdeBrowserHost(vscode);
    await host.open('https://example.com');
    const snapshot = await host.call({ sessionId: 's', workerId: 'w' }, { action: 'snapshot', role: 'button', query: 'shadow' });
    const ref = snapshot.elements[0].ref;
    await host.call({ sessionId: 's', workerId: 'w' }, { action: 'click', ref });
    await host.call({ sessionId: 's', workerId: 'w' }, { action: 'hover', ref });
    await host.call({ sessionId: 's', workerId: 'w' }, { action: 'press', key: 'a' });
    await host.call({ sessionId: 's', workerId: 'w' }, { action: 'scroll', delta_y: 300 });
    assert.deepEqual(input.map(item => item.type),
      ['mouseMoved', 'mousePressed', 'mouseReleased', 'mouseMoved', 'keyDown', 'keyUp', 'mouseWheel']);
    assert.equal(input.find(item => item.type === 'mousePressed').buttons, 1);
    assert.equal(input.find(item => item.type === 'keyDown').text, 'a');
    assert.equal(input.find(item => item.type === 'mouseWheel').deltaY, 300);
  });

  it('captures console and page errors host-side and keeps them across navigation', async () => {
    globalThis.__ideDom = undefined;
    const binding = { sessionId: 's', workerId: 'w' };
    const vscode = fakeVscode({
      cdp(message, helpers) {
        if (message.method === 'Runtime.enable') {
          helpers.emit('Runtime.consoleAPICalled', { type: 'log', args: [{ type: 'string', value: 'hello' }], stackTrace: { callFrames: [{ url: 'https://example.com/app.js', lineNumber: 3, columnNumber: 7 }] } });
          helpers.emit('Runtime.consoleAPICalled', { type: 'warning', args: [{ type: 'string', value: 'careful' }] });
          helpers.emit('Runtime.exceptionThrown', { exceptionDetails: { exception: { description: 'Error: boom' } } });
          return {};
        }
        return pageEvalCdp(message, helpers);
      }
    });
    const host = createIdeBrowserHost(vscode);
    await host.open('about:blank');
    await host.call(binding, { action: 'navigate', url: 'https://example.com/one' });
    const all = await host.call(binding, { action: 'console' });
    assert.deepEqual(all.entries.map(entry => [entry.kind, entry.level, entry.text]),
      [['console', 'log', 'hello'], ['console', 'warning', 'careful'], ['pageerror', 'error', 'Error: boom']]);
    assert.deepEqual(all.entries[0].location, { url: 'https://example.com/app.js', line: 3, column: 7 });
    assert.equal((await host.call(binding, { action: 'console', level: 'warning' })).entries.length, 1);
    await host.call(binding, { action: 'navigate', url: 'https://example.com/two' });
    assert.equal((await host.call(binding, { action: 'console' })).entries.length, 3, 'console survives navigation');
    const cleared = await host.call(binding, { action: 'console', clear: true, limit: 1 });
    assert.equal(cleared.entries.length, 1);
    assert.equal(cleared.has_more, true);
    assert.equal((await host.call(binding, { action: 'console' })).entries.length, 2);
  });

  it('element screenshots use page coordinates that include the scroll offset', async () => {
    globalThis.__ideDom = undefined;
    let clip;
    const vscode = fakeVscode({
      cdp(message, helpers) {
        if (message.method === 'Page.captureScreenshot') { clip = message.params.clip; return { data: Buffer.from('jpeg').toString('base64') }; }
        return pageEvalCdp(message, helpers);
      }
    });
    const host = createIdeBrowserHost(vscode);
    await host.open('https://example.com');
    const snapshot = await host.call({ sessionId: 's', workerId: 'w' }, { action: 'snapshot', role: 'button', query: 'shadow' });
    await host.call({ sessionId: 's', workerId: 'w' }, { action: 'screenshot', ref: snapshot.elements[0].ref });
    assert.deepEqual(clip, { x: 41, y: 101, width: 20, height: 12, scale: 1 });
  });

  it('wait polls inside the page with a single evaluate round trip', async () => {
    globalThis.__ideDom = undefined;
    let evaluates = 0;
    const vscode = fakeVscode({
      cdp(message, helpers) {
        if (message.method === 'Runtime.evaluate' && /deadline/.test(message.params.expression)) {
          evaluates++;
          assert.equal(message.params.awaitPromise, true);
          return { result: { value: { ready: true } } };
        }
        return pageEvalCdp(message, helpers);
      }
    });
    const host = createIdeBrowserHost(vscode);
    await host.open('https://example.com');
    const waited = await host.call({ sessionId: 's', workerId: 'w' }, { action: 'wait', query: 'Shadow' });
    assert.equal(waited.ok, true);
    assert.equal(waited.wait_for, 'text');
    assert.equal(evaluates, 1);
  });

  it('lists frames and evaluates inside an iframe', async () => {
    const vscode = fakeVscode({ cdp: pageEvalCdp });
    const host = createIdeBrowserHost(vscode);
    const binding = { sessionId: 's', workerId: 'w' };
    await host.open('https://example.com');
    const frames = await host.call(binding, { action: 'frames' });
    assert.equal(frames.frames.length, 2);
    assert.equal(frames.frames[1].frame_id, 'child');
    assert.equal(frames.frames[1].parent_frame_id, 'main');
    const evaluated = await host.call(binding, { action: 'frame_evaluate', frame_id: 'child', script: '1+1' });
    assert.equal(evaluated.frame_id, 'child');
    assert.equal(evaluated.result, 2);
  });

  it('surfaces CDP navigation failures instead of pretending the page loaded', async () => {
    const vscode = fakeVscode({
      cdp(message, helpers) {
        if (message.method === 'Page.navigate') return { frameId: 'main', loaderId: '', errorText: 'net::ERR_NAME_NOT_RESOLVED' };
        return pageEvalCdp(message, helpers);
      }
    });
    const host = createIdeBrowserHost(vscode);
    await host.open('about:blank');
    await assert.rejects(
      () => host.call({ sessionId: 's', workerId: 'w' }, { action: 'navigate', url: 'https://nope.invalid' }),
      /导航失败/
    );
  });

  it('reports page_open in status and keeps agent actions off the browser until it is open', async () => {
    const vscode = fakeVscode({ cdp: pageEvalCdp });
    const host = createIdeBrowserHost(vscode);
    const closed = await host.call({ sessionId: 's', workerId: 'w' }, { action: 'status' });
    assert.equal(closed.page_open, false);
    assert.equal(closed.tab_count, 0);
    await host.open('https://example.com');
    const opened = await host.call({ sessionId: 's', workerId: 'w' }, { action: 'status' });
    assert.equal(opened.page_open, true);
    assert.equal(opened.tab_count, 1);
    assert.ok(opened.active_page_id);
  });

  it('captures network events after network_start and stops on network_stop', async () => {
    globalThis.__ideDom = undefined;
    let emit;
    const vscode = fakeVscode({ cdp(message, helpers) { emit = helpers.emit; return pageEvalCdp(message, helpers); } });
    const host = createIdeBrowserHost(vscode);
    const binding = { sessionId: 's', workerId: 'w' };
    await host.open('https://example.com');
    const started = await host.call(binding, { action: 'network_start' });
    assert.equal(started.capturing, true);
    emit('Network.requestWillBeSent', { requestId: 'r1', request: { url: 'https://example.com/api', method: 'GET' }, type: 'Fetch' });
    emit('Network.responseReceived', { requestId: 'r1', response: { url: 'https://example.com/api', status: 200, mimeType: 'application/json' } });
    await new Promise(resolve => setTimeout(resolve, 0));
    const listed = await host.call(binding, { action: 'network', query: '/api' });
    assert.deepEqual(listed.entries.map(item => item.kind), ['request', 'response']);
    assert.equal(listed.entries[1].status, 200);
    await host.call(binding, { action: 'network_stop' });
    emit('Network.requestWillBeSent', { requestId: 'r2', request: { url: 'https://example.com/late', method: 'GET' }, type: 'Fetch' });
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal((await host.call(binding, { action: 'network' })).entries.length, 2);
  });

  it('reads page cookies with redaction unless credentials are requested', async () => {
    globalThis.__ideDom = undefined;
    const vscode = fakeVscode({
      cdp(message, helpers) {
        if (message.method === 'Network.getCookies') {
          return { cookies: [{ name: 'sid', value: 's3cret', domain: 'example.com', path: '/', secure: true, httpOnly: true, sameSite: 'Lax', expires: 123 }] };
        }
        return pageEvalCdp(message, helpers);
      }
    });
    const host = createIdeBrowserHost(vscode);
    const binding = { sessionId: 's', workerId: 'w' };
    await host.open('https://example.com/app');
    const redacted = await host.call(binding, { action: 'cookies' });
    assert.equal(redacted.cookies[0].name, 'sid');
    assert.equal(redacted.cookies[0].value_present, true);
    assert.equal(redacted.cookies[0].value, undefined);
    const withValues = await host.call(binding, { action: 'cookies', include_credentials: true });
    assert.equal(withValues.cookies[0].value, 's3cret');
  });

  it('buffers CDP events for cdp_events', async () => {
    globalThis.__ideDom = undefined;
    let emit;
    const vscode = fakeVscode({ cdp(message, helpers) { emit = helpers.emit; return pageEvalCdp(message, helpers); } });
    const host = createIdeBrowserHost(vscode);
    const binding = { sessionId: 's', workerId: 'w' };
    await host.open('https://example.com');
    await host.call(binding, { action: 'snapshot' });
    emit('Page.loadEventFired', { timestamp: 1 });
    await new Promise(resolve => setTimeout(resolve, 0));
    const events = await host.call(binding, { action: 'cdp_events', query: 'loadEventFired' });
    assert.ok(events.entries.some(item => item.method === 'Page.loadEventFired'));
  });

  it('fills an already-open Browser editor pane instead of returning IDE_BROWSER_NOT_OPEN', async () => {
    globalThis.__ideDom = undefined;
    const vscode = fakeVscode({ cdp: pageEvalCdp, browserPane: true });
    const host = createIdeBrowserHost(vscode);
    const result = await host.call({ sessionId: 's', workerId: 'w' }, { action: 'navigate', url: 'https://example.com/pane' });
    assert.equal(result.code, undefined);
    assert.equal(result.url, 'https://example.com/pane');
    assert.equal(vscode.tabs.length, 1);
    assert.equal(vscode.tabs[0].url, 'https://example.com/pane');
  });

  it('opens an agent page through the bridge fallback without returning NOT_OPEN', async () => {
    const vscode = fakeVscode({ cdp: pageEvalCdp });
    const host = createIdeBrowserHost(vscode);
    const opened = await host.handle('openAgentPage', { url: 'https://example.com/auto' });
    assert.equal(opened.opened, true);
    assert.equal(opened.url, 'https://example.com/auto');
    assert.equal(vscode.tabs.length, 1);
    const result = await host.call({ sessionId: 's', workerId: 'w' }, { action: 'navigate', url: 'https://example.com/auto' });
    assert.equal(result.code, undefined);
  });

  it('intercepts JS dialogs so navigate/click never hang', async () => {
    globalThis.__ideDom = undefined;
    const methods = [];
    let emit;
    const vscode = fakeVscode({
      cdp(message, helpers) {
        methods.push(message.method);
        emit = helpers.emit;
        return pageEvalCdp(message, helpers);
      }
    });
    const host = createIdeBrowserHost(vscode);
    await host.open('https://example.com');
    await host.call({ sessionId: 's', workerId: 'w' }, { action: 'snapshot' });
    emit('Page.javascriptDialogOpening', { type: 'alert', message: 'hello', url: 'https://example.com' });
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.ok(methods.includes('Page.handleJavaScriptDialog'), 'the host must answer the dialog');
    const listed = await host.call({ sessionId: 's', workerId: 'w' }, { action: 'dialogs' });
    assert.equal(listed.dialogs[0].message, 'hello');
    const policy = await host.call({ sessionId: 's', workerId: 'w' }, { action: 'dialog_policy', accept: false, prompt_text: 'ok' });
    assert.equal(policy.accept, false);
    assert.equal(policy.prompt_text, 'ok');
  });

  it('reports IDE_BROWSER_NOT_OPEN instead of opening the browser for an agent action', async () => {
    globalThis.__ideDom = undefined;
    const activity = [];
    const vscode = fakeVscode({ cdp: pageEvalCdp });
    const host = createIdeBrowserHost(vscode, { onActivity: event => activity.push(event) });
    const result = await host.call({ sessionId: 's', workerId: 'w' }, { action: 'navigate', url: 'https://example.com/agent' });
    assert.equal(result.code, 'IDE_BROWSER_NOT_OPEN');
    assert.equal(result.url, 'https://example.com/agent');
    assert.equal(vscode.tabs.length, 0, 'the browser page must not open automatically');
    assert.equal(activity.at(-1).active, true, 'the conversation is told the agent needs the browser');
    assert.equal(activity.at(-1).url, 'https://example.com/agent');
  });

  it('reports IDE_BROWSER_NOT_OPEN for tab_new when no page is open', async () => {
    globalThis.__ideDom = undefined;
    const vscode = fakeVscode({ cdp: pageEvalCdp });
    const host = createIdeBrowserHost(vscode);
    const result = await host.call({ sessionId: 's', workerId: 'w' }, { action: 'tab_new', url: 'https://example.com/new' });
    assert.equal(result.code, 'IDE_BROWSER_NOT_OPEN');
    assert.equal(vscode.tabs.length, 0);
  });

  it('still operates an already-open page without opening another tab', async () => {
    globalThis.__ideDom = undefined;
    const vscode = fakeVscode({ cdp: pageEvalCdp });
    const host = createIdeBrowserHost(vscode);
    await host.open('https://example.com');
    const result = await host.call({ sessionId: 's', workerId: 'w' }, { action: 'navigate', url: 'https://example.com/next' });
    assert.equal(result.url, 'https://example.com/next');
    assert.equal(vscode.tabs.length, 1);
  });
});
