'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createBrowserSidebar, renderBrowserSidebar, normalizeUrl } = require('../../../host/ui/browser-sidebar.cjs');

function fakeWebview() {
  const handlers = [];
  return {
    options: {},
    html: '',
    last: undefined,
    postMessage(message) { this.last = message; return Promise.resolve(true); },
    onDidReceiveMessage(handler) {
      handlers.push(handler);
      return { dispose() {} };
    },
    async emit(message) {
      for (const handler of handlers) await handler(message);
    }
  };
}

function createHost() {
  const pages = [];
  let revealCount = 0;
  const calls = [];
  return {
    pages,
    calls,
    get revealCount() { return revealCount; },
    listPages() {
      return pages.map((page, index) => ({
        id: page.id,
        url: page.url,
        title: page.title,
        active: page.active === true || (page.active !== false && index === pages.length - 1),
        loading: page.loading === true,
        canGoBack: page.canGoBack !== false && !!(page.url && page.url !== 'about:blank'),
        canGoForward: page.canGoForward !== false
      }));
    },
    lastOpen: undefined,
    async open(url, options) {
      this.lastOpen = { url, options };
      for (const page of pages) page.active = false;
      const page = {
        id: 'p' + (pages.length + 1),
        url,
        title: url === 'about:blank' ? '新标签页' : url,
        active: true,
        loading: false,
        canGoBack: url !== 'about:blank',
        canGoForward: true
      };
      pages.push(page);
      return { id: page.id, tab: page };
    },
    async reveal(url) {
      revealCount += 1;
      const page = pages.find(item => item.url === url) || pages[pages.length - 1];
      if (!page) throw new Error('missing page');
      for (const item of pages) item.active = item === page;
      return { id: page.id, tab: page };
    },
    async navigate(url, pageId) {
      const page = pages.find(item => item.id === pageId) || pages[pages.length - 1];
      if (!page) return this.open(url);
      page.url = url;
      page.title = url === 'about:blank' ? '新标签页' : url;
      page.canGoBack = url !== 'about:blank';
      for (const item of pages) item.active = item === page;
      return { id: page.id, tab: page };
    },
    async closePage(pageId) {
      const index = pages.findIndex(page => page.id === pageId);
      if (index < 0) return { ok: true, closed: false };
      pages.splice(index, 1);
      if (pages.length) pages[pages.length - 1].active = true;
      return { ok: true, closed: true };
    },
    async call(_binding, input) {
      calls.push(input);
      if (input.action === 'tab_activate') {
        const page = pages.find(item => item.id === input.page_id);
        if (!page) throw new Error('Unknown page_id');
        for (const item of pages) item.active = item === page;
        return this.reveal(page.url);
      }
      if (input.action === 'tab_close') return this.closePage(input.page_id);
      if (input.action === 'back' || input.action === 'forward' || input.action === 'reload') {
        return { ok: true, page_id: input.page_id, action: input.action };
      }
      throw new Error(input.action);
    }
  };
}

function mountSidebar(host) {
  const vscode = {
    commands: { executeCommand: async () => {} },
    window: {
      onDidOpenBrowserTab() { return { dispose() {} }; },
      onDidCloseBrowserTab() { return { dispose() {} }; },
      onDidChangeActiveBrowserTab() { return { dispose() {} }; },
      onDidChangeBrowserTabState() { return { dispose() {} }; }
    }
  };
  const sidebar = createBrowserSidebar(vscode, { host });
  const webview = fakeWebview();
  const view = {
    visible: true,
    webview,
    onDidChangeVisibility() { return { dispose() {} }; },
    onDidDispose() { return { dispose() {} }; }
  };
  sidebar.resolveWebviewView(view);
  return { sidebar, webview, view };
}

describe('browser sidebar', () => {
  it('normalizes typed addresses', () => {
    assert.equal(normalizeUrl('example.com'), 'https://example.com');
    assert.equal(normalizeUrl('https://a.test'), 'https://a.test');
    assert.equal(normalizeUrl(''), 'about:blank');
  });

  it('renders page manager chrome with nav and peer-tab CTAs', () => {
    const html = renderBrowserSidebar();
    assert.match(html, /输入网址/);
    assert.match(html, /打开文件树/);
    assert.match(html, /打开任务记录/);
    assert.match(html, /同为右侧栏标签/);
    assert.match(html, /id="back"/);
    assert.match(html, /id="forward"/);
    assert.match(html, /id="reload"/);
    assert.match(html, /打开空白页/);
    assert.match(html, /还没有打开的网页/);
    assert.match(html, /role="listbox"/);
    assert.doesNotMatch(html, /<header><span>浏览器<\/span>/);
  });

  it('switches to explorer or worker peer tabs without opening pages', async () => {
    const host = createHost();
    const commands = [];
    const vscode = {
      commands: { executeCommand: async (...args) => { commands.push(args); } },
      window: {
        onDidOpenBrowserTab() { return { dispose() {} }; },
        onDidCloseBrowserTab() { return { dispose() {} }; },
        onDidChangeActiveBrowserTab() { return { dispose() {} }; },
        onDidChangeBrowserTabState() { return { dispose() {} }; }
      }
    };
    const sidebar = createBrowserSidebar(vscode, { host });
    const webview = fakeWebview();
    sidebar.resolveWebviewView({
      visible: true, webview,
      onDidChangeVisibility() { return { dispose() {} }; },
      onDidDispose() { return { dispose() {} }; }
    });
    await webview.emit({ action: 'files' });
    await sidebar.whenIdle();
    assert.deepEqual(commands.at(-1), ['workbench.view.explorer']);
    await webview.emit({ action: 'workers' });
    await sidebar.whenIdle();
    assert.deepEqual(commands.at(-1), ['workbench.view.extension.ubovm-workers']);
    assert.equal(host.pages.length, 0);
    sidebar.dispose();
  });

  it('does not auto-open a page until the user asks, then reuses stable ids', async () => {
    const host = createHost();
    const { sidebar, webview } = mountSidebar(host);
    await webview.emit({ action: 'ready' });
    await sidebar.whenIdle();
    assert.equal(host.pages.length, 0);
    assert.equal(webview.last.type, 'tabs');
    assert.equal(webview.last.tabs.length, 0);

    await webview.emit({ action: 'open', url: 'about:blank' });
    await sidebar.whenIdle();
    assert.equal(host.pages.length, 1);
    assert.equal(host.pages[0].url, 'about:blank');
    assert.equal(host.lastOpen.options.preserveFocus, false);
    assert.equal(webview.last.tabs[0].id, 'p1');

    await webview.emit({ action: 'go', url: 'example.com' });
    await sidebar.whenIdle();
    assert.equal(host.pages.length, 1, 'go navigates the active page instead of opening another tab');
    assert.equal(host.pages[0].url, 'https://example.com');

    await webview.emit({ action: 'open', url: 'about:blank' });
    await sidebar.whenIdle();
    assert.equal(host.pages.length, 2);

    const before = host.pages.length;
    await webview.emit({ action: 'activate', pageId: 'p1' });
    await sidebar.whenIdle();
    assert.equal(host.pages.length, before, 'activate must not open another page');

    await webview.emit({ action: 'close', pageId: 'p1' });
    await webview.emit({ action: 'close', pageId: 'p2' });
    await sidebar.whenIdle();
    assert.equal(host.pages.length, 0);

    await webview.emit({ action: 'ready' });
    await sidebar.whenIdle();
    assert.equal(host.pages.length, 0, 'after the user clears pages, return visits stay empty');
    sidebar.dispose();
  });

  it('routes back and reload through host.call', async () => {
    const host = createHost();
    const { sidebar, webview } = mountSidebar(host);
    await webview.emit({ action: 'ready' });
    await sidebar.whenIdle();
    await webview.emit({ action: 'go', url: 'https://example.com' });
    await sidebar.whenIdle();
    host.calls.length = 0;

    await webview.emit({ action: 'back' });
    await sidebar.whenIdle();
    assert.equal(host.calls[0]?.action, 'back');
    assert.equal(host.calls[0]?.page_id, 'p1');

    await webview.emit({ action: 'reload' });
    await sidebar.whenIdle();
    assert.equal(host.calls.at(-1)?.action, 'reload');
    sidebar.dispose();
  });

  it('does not reveal when sidebar becomes visible with existing pages', async () => {
    const host = createHost();
    await host.open('https://example.com');
    let visibleHandler;
    const vscode = {
      commands: { executeCommand: async () => {} },
      window: {
        onDidOpenBrowserTab() { return { dispose() {} }; },
        onDidCloseBrowserTab() { return { dispose() {} }; },
        onDidChangeActiveBrowserTab() { return { dispose() {} }; },
        onDidChangeBrowserTabState() { return { dispose() {} }; }
      }
    };
    const sidebar = createBrowserSidebar(vscode, { host });
    const webview = fakeWebview();
    const view = {
      visible: true,
      webview,
      onDidChangeVisibility(handler) {
        visibleHandler = handler;
        return { dispose() {} };
      },
      onDidDispose() { return { dispose() {} }; }
    };
    sidebar.resolveWebviewView(view);
    await webview.emit({ action: 'ready' });
    await sidebar.whenIdle();
    const before = host.revealCount;
    view.visible = false;
    visibleHandler?.();
    await sidebar.whenIdle();
    view.visible = true;
    visibleHandler?.();
    await sidebar.whenIdle();
    assert.equal(host.revealCount, before, 'syncVisible must not reveal existing pages');
    assert.equal(webview.last.type, 'tabs');
    assert.equal(webview.last.tabs.length, 1);
    sidebar.dispose();
  });

  it('requestEnsureOpen seeds a blank page after pages were cleared', async () => {
    const host = createHost();
    const { sidebar, webview } = mountSidebar(host);
    await webview.emit({ action: 'ready' });
    await sidebar.whenIdle();
    await webview.emit({ action: 'close', pageId: 'p1' });
    await sidebar.whenIdle();
    sidebar.requestEnsureOpen();
    await webview.emit({ action: 'ready' });
    await sidebar.whenIdle();
    assert.equal(host.pages.length, 1);
    assert.equal(host.pages[0].url, 'about:blank');
    sidebar.dispose();
  });
});
