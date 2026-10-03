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
        setActive(tab);
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
      }
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
    return {};
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

  it('keeps agent tab_new in the background and honors explicit user focus', async () => {
    const vscode = fakeVscode();
    const host = createIdeBrowserHost(vscode);
    await host.open('about:blank', { preserveFocus: false, viewColumn: vscode.ViewColumn.Two });
    assert.equal(vscode.lastOpen.options.preserveFocus, false);
    await host.call({ sessionId: 's', workerId: 'w' }, { action: 'tab_new', url: 'https://example.com/agent' });
    assert.equal(vscode.lastOpen.options.preserveFocus, true);
    assert.equal(vscode.lastOpen.options.background, true);
  });

  it('locks during call and unlocks afterwards', async () => {
    const vscode = fakeVscode({ cdp: pageEvalCdp });
    const host = createIdeBrowserHost(vscode);
    await host.call({ sessionId: 's', workerId: 'w' }, { action: 'navigate', url: 'https://example.com/a' });
    assert.deepEqual(vscode.locks.map(item => item.locked), [true, false]);
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
});
