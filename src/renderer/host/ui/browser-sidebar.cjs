'use strict';

const { randomBytes } = require('node:crypto');

function normalizeUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return 'about:blank';
  if (/^(https?:|about:|file:|vscode-file:)/i.test(raw)) return raw;
  if (raw.includes('.') || raw.includes('/')) return `https://${raw}`;
  return raw;
}

function renderBrowserSidebar() {
  const nonce = randomBytes(24).toString('base64');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style nonce="${nonce}">
  *{box-sizing:border-box}body{margin:0;min-height:100%;display:flex;flex-direction:column;color:var(--vscode-foreground,#292a2d);background:var(--vscode-sideBar-background,#f7f7f6);font-family:var(--vscode-font-family,'Segoe UI','Microsoft YaHei UI',sans-serif);font-size:var(--vscode-font-size,13px);line-height:1.45}
  .toolbar{display:grid;gap:8px;padding:12px 12px 10px;border-bottom:1px solid var(--vscode-sideBar-border,var(--vscode-widget-border,#ddd))}
  .nav-row,.toolbar-row{display:grid;gap:8px;align-items:center}
  .nav-row{grid-template-columns:auto minmax(0,1fr)}
  .toolbar-row{grid-template-columns:minmax(0,1fr) auto}
  .nav-actions,.actions{display:flex;gap:4px;flex-shrink:0;align-items:center}
  .toolbar input{min-width:0;width:100%;padding:7px 10px;border-radius:6px;border:1px solid var(--vscode-input-border,var(--vscode-widget-border,#ddd));background:var(--vscode-input-background,transparent);color:var(--vscode-input-foreground,var(--vscode-foreground));font:inherit}
  .toolbar input:focus-visible,.actions button:focus-visible,.nav-actions button:focus-visible,.tab:focus-visible,.tab-close:focus-visible,.peer-links button:focus-visible,.empty-actions button:focus-visible,#tabs:focus-visible{outline:2px solid var(--vscode-focusBorder);outline-offset:2px}
  .nav-actions button,.actions button,.peer-links button,.empty-actions button{font:inherit;border-radius:6px;border:1px solid var(--vscode-button-border,transparent);cursor:pointer}
  .nav-actions button{width:30px;height:30px;padding:0;display:inline-flex;align-items:center;justify-content:center;color:var(--vscode-foreground);background:transparent;border-color:var(--vscode-widget-border,#ddd)}
  .nav-actions button:hover:not(:disabled){background:var(--vscode-list-hoverBackground)}
  .nav-actions button:disabled{opacity:.45;cursor:default}
  .nav-actions button.loading{opacity:1}
  .actions button{color:var(--vscode-button-foreground);background:var(--vscode-button-background);padding:6px 10px}.actions button:hover{background:var(--vscode-button-hoverBackground)}
  .actions button.secondary,.empty-actions button.secondary,.peer-links button{color:var(--vscode-foreground);background:transparent;border-color:var(--vscode-widget-border,#ddd)}.actions button.secondary:hover,.empty-actions button.secondary:hover,.peer-links button:hover{background:var(--vscode-list-hoverBackground)}
  .empty-actions button{padding:6px 12px;background:var(--vscode-button-background);color:var(--vscode-button-foreground)}.empty-actions button:hover{background:var(--vscode-button-hoverBackground)}
  main{flex:1;min-height:0;display:flex;flex-direction:column;padding:10px 12px 12px;gap:10px}
  #empty{margin:18px 4px 0;color:var(--vscode-descriptionForeground,#666);text-align:center;line-height:1.65}
  #empty strong{display:block;margin-bottom:6px;color:var(--vscode-foreground);font-weight:600}
  .empty-actions{display:flex;flex-wrap:wrap;gap:8px;justify-content:center;margin-top:14px}
  #tabs{display:grid;gap:6px;margin:0;padding:0;list-style:none;overflow:auto;min-height:0;border-radius:6px}
  .row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:4px;align-items:stretch}
  .tab{display:grid;gap:2px;width:100%;min-width:0;text-align:left;padding:8px 10px;border-radius:6px;border:1px solid transparent;background:transparent;color:var(--vscode-foreground);cursor:pointer}
  .tab:hover,.tab.focused:not(.active){background:var(--vscode-list-hoverBackground)}
  .tab.active{background:var(--vscode-list-activeSelectionBackground);color:var(--vscode-list-activeSelectionForeground)}
  .tab.loading strong::after{content:' ·';opacity:.7}
  .tab strong,.tab span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.tab span{font-size:11px;opacity:.8}
  .tab-close{width:28px;border:0;border-radius:6px;background:transparent;color:inherit;cursor:pointer;opacity:.7}.tab-close:hover{background:var(--vscode-toolbar-hoverBackground,var(--vscode-list-hoverBackground));opacity:1}
  footer{margin-top:auto;padding-top:8px;border-top:1px solid var(--vscode-sideBar-border,var(--vscode-widget-border,#ddd));display:grid;gap:8px}
  .peer-hint{margin:0;color:var(--vscode-descriptionForeground,#666);font-size:11px;line-height:1.45}
  .peer-links{display:grid;grid-template-columns:1fr 1fr;gap:6px}
  .peer-links button{width:100%;padding:6px 10px}
  [hidden]{display:none!important}
  </style></head><body>
  <form class="toolbar" id="nav" autocomplete="off">
    <div class="nav-row">
      <div class="nav-actions" role="group" aria-label="页面导航">
        <button type="button" id="back" title="后退" aria-label="后退" disabled>←</button>
        <button type="button" id="forward" title="前进" aria-label="前进" disabled>→</button>
        <button type="button" id="reload" title="刷新" aria-label="刷新">↻</button>
      </div>
      <div class="toolbar-row">
        <input id="url" type="text" inputmode="url" spellcheck="false" placeholder="输入网址，例如 example.com" aria-label="浏览器地址">
        <div class="actions">
          <button type="submit" id="go">前往</button>
          <button type="button" class="secondary" id="new" title="新页面 (Ctrl+T)">新页面</button>
        </div>
      </div>
    </div>
  </form>
  <main>
    <div id="empty" role="status">
      <strong>还没有打开的网页</strong>
      <span>网页在右侧编辑区显示，地址栏也在页面顶部。点下方按钮开始浏览。</span>
      <div class="empty-actions">
        <button type="button" id="empty-open">打开空白页</button>
        <button type="button" class="secondary" id="empty-files">打开文件树</button>
        <button type="button" class="secondary" id="empty-workers">打开任务记录</button>
      </div>
    </div>
    <ul id="tabs" hidden role="listbox" aria-label="已打开的页面" tabindex="0"></ul>
    <footer id="footer">
      <p class="peer-hint">与文件树、任务记录同为右侧栏标签，可随时切换。</p>
      <div class="peer-links">
        <button type="button" id="files">打开文件树</button>
        <button type="button" id="workers">打开任务记录</button>
      </div>
    </footer>
  </main>
  <script nonce="${nonce}">
  const vscode=acquireVsCodeApi();
  const empty=document.getElementById('empty');
  const list=document.getElementById('tabs');
  const footer=document.getElementById('footer');
  const urlInput=document.getElementById('url');
  const backBtn=document.getElementById('back');
  const forwardBtn=document.getElementById('forward');
  const reloadBtn=document.getElementById('reload');
  let tabsCache=[];
  let focusIndex=-1;

  document.getElementById('nav').onsubmit=event=>{
    event.preventDefault();
    vscode.postMessage({action:'go',url:urlInput.value});
  };
  document.getElementById('new').onclick=()=>vscode.postMessage({action:'open',url:urlInput.value||'about:blank'});
  document.getElementById('empty-open').onclick=()=>vscode.postMessage({action:'open',url:'about:blank'});
  document.getElementById('files').onclick=()=>vscode.postMessage({action:'files'});
  document.getElementById('empty-files').onclick=()=>vscode.postMessage({action:'files'});
  document.getElementById('workers').onclick=()=>vscode.postMessage({action:'workers'});
  document.getElementById('empty-workers').onclick=()=>vscode.postMessage({action:'workers'});
  backBtn.onclick=()=>vscode.postMessage({action:'back'});
  forwardBtn.onclick=()=>vscode.postMessage({action:'forward'});
  reloadBtn.onclick=()=>vscode.postMessage({action:'reload'});

  function activeIndex(){
    const index=tabsCache.findIndex(item=>item.active);
    return index>=0?index:0;
  }
  function setNavState(tabs){
    const active=tabs.find(item=>item.active)||tabs[0];
    const has=!!active;
    backBtn.disabled=!has||active.canGoBack===false;
    forwardBtn.disabled=!has||active.canGoForward===false;
    reloadBtn.disabled=!has;
    reloadBtn.classList.toggle('loading',!!active?.loading);
    reloadBtn.title=active?.loading?'加载中…':'刷新';
    reloadBtn.setAttribute('aria-label',reloadBtn.title);
  }
  function focusUrlBar(select){
    queueMicrotask(()=>{urlInput.focus(); if(select) urlInput.select();});
  }
  function syncFocusStyles(){
    list.querySelectorAll('.tab').forEach((button,index)=>{
      button.classList.toggle('focused',index===focusIndex);
    });
  }
  function render(tabs, focusUrl){
    const items=Array.isArray(tabs)?tabs:[];
    tabsCache=items;
    empty.hidden=items.length>0;
    list.hidden=!items.length;
    footer.hidden=!items.length;
    list.replaceChildren();
    focusIndex=items.length?Math.min(Math.max(focusIndex,0),items.length-1): -1;
    if(items.length && focusIndex<0) focusIndex=activeIndex();
    for(const [index,tab] of items.entries()){
      const row=document.createElement('li');
      row.className='row';
      row.setAttribute('role','presentation');
      const button=document.createElement('button');
      button.type='button';
      button.className='tab'+(tab.active?' active':'')+(tab.loading?' loading':'');
      button.setAttribute('role','option');
      button.setAttribute('aria-selected',tab.active?'true':'false');
      button.dataset.pageId=tab.id||'';
      button.dataset.index=String(index);
      const title=document.createElement('strong');
      title.textContent=tab.loading?((tab.title||tab.url||'未命名页面')+' …'):(tab.title||tab.url||'未命名页面');
      const url=document.createElement('span');
      url.textContent=tab.url||'';
      button.append(title,url);
      button.onclick=()=>vscode.postMessage({action:'activate',pageId:tab.id});
      button.onauxclick=event=>{
        if(event.button===1){
          event.preventDefault();
          vscode.postMessage({action:'close',pageId:tab.id});
        }
      };
      const close=document.createElement('button');
      close.type='button';
      close.className='tab-close';
      close.title='关闭页面';
      close.setAttribute('aria-label','关闭 '+(tab.title||tab.url||'页面'));
      close.textContent='×';
      close.onclick=event=>{event.stopPropagation();vscode.postMessage({action:'close',pageId:tab.id});};
      row.append(button,close);
      list.appendChild(row);
    }
    setNavState(items);
    syncFocusStyles();
    const active=items.find(item=>item.active)||items[0];
    if(active?.url && document.activeElement!==urlInput)urlInput.value=active.url==='about:blank'?'':active.url;
    if(focusUrl) focusUrlBar(true);
  }

  list.addEventListener('keydown',event=>{
    if(!tabsCache.length) return;
    const max=tabsCache.length-1;
    if(event.key==='ArrowDown'||event.key==='ArrowUp'){
      event.preventDefault();
      if(focusIndex<0) focusIndex=activeIndex();
      else focusIndex=event.key==='ArrowDown'?Math.min(max,focusIndex+1):Math.max(0,focusIndex-1);
      syncFocusStyles();
      list.querySelectorAll('.tab')[focusIndex]?.focus();
      return;
    }
    if(event.key==='Home'){
      event.preventDefault();
      focusIndex=0;
      syncFocusStyles();
      list.querySelectorAll('.tab')[0]?.focus();
      return;
    }
    if(event.key==='End'){
      event.preventDefault();
      focusIndex=max;
      syncFocusStyles();
      list.querySelectorAll('.tab')[max]?.focus();
      return;
    }
    if(event.key==='Enter' && focusIndex>=0){
      event.preventDefault();
      const tab=tabsCache[focusIndex];
      if(tab) vscode.postMessage({action:'activate',pageId:tab.id});
      return;
    }
    if((event.key==='Delete'||(event.key==='w'&&(event.ctrlKey||event.metaKey))) && focusIndex>=0){
      event.preventDefault();
      const tab=tabsCache[focusIndex];
      if(tab) vscode.postMessage({action:'close',pageId:tab.id});
    }
  });

  document.addEventListener('keydown',event=>{
    if(event.key==='Escape'){
      event.preventDefault();
      focusUrlBar(true);
      return;
    }
    if((event.ctrlKey||event.metaKey) && event.key.toLowerCase()==='t'){
      event.preventDefault();
      vscode.postMessage({action:'open',url:urlInput.value||'about:blank'});
    }
  });

  urlInput.addEventListener('keydown',event=>{
    if(event.key==='Escape'){event.preventDefault();urlInput.select();}
  });

  window.addEventListener('message',event=>{
    if(event.data?.type==='tabs')render(event.data.tabs, event.data.focusUrl===true);
  });
  vscode.postMessage({action:'ready'});
  </script></body></html>`;
}

function createBrowserSidebar(vscode, { host, onError = () => {} } = {}) {
  let view;
  let disposed = false;
  let viewSubscriptions = [];
  let queue = Promise.resolve();
  let ensureOpenOnce = false;
  let openedOnce = false;
  let suppressAutoOpen = false;
  let lastRevealedId = '';
  const report = error => {
    try { Promise.resolve(onError(error)).catch(() => {}); } catch { /* observers must not interrupt cleanup */ }
  };

  function releaseView() {
    view = undefined;
    const subscriptions = viewSubscriptions;
    viewSubscriptions = [];
    for (const subscription of subscriptions) {
      try { Promise.resolve(subscription?.dispose()).catch(report); } catch (error) { report(error); }
    }
  }

  function pages() {
    if (typeof host?.listPages === 'function') return host.listPages();
    const tabs = typeof vscode.window.browserTabs !== 'undefined' ? [...vscode.window.browserTabs] : [];
    const active = vscode.window.activeBrowserTab;
    return tabs.map((tab, index) => ({
      id: String(index),
      url: tab.url || '',
      title: tab.title || tab.url || '未命名页面',
      active: tab === active || (!active && index === 0),
      loading: tab.loading === true,
      canGoBack: typeof tab.canGoBack === 'boolean' ? tab.canGoBack : !!(tab.url && tab.url !== 'about:blank'),
      canGoForward: typeof tab.canGoForward === 'boolean' ? tab.canGoForward : true
    }));
  }

  function publish(options = {}) {
    if (!view || view.visible === false) return;
    return view.webview.postMessage({ type: 'tabs', tabs: pages(), focusUrl: options.focusUrl === true });
  }

  function run(task) {
    queue = queue.then(task).catch(report);
    return queue;
  }

  async function callHost(action, pageId) {
    if (typeof host?.call !== 'function') return;
    const input = { action };
    if (pageId) input.page_id = pageId;
    try {
      await host.call({}, input);
    } catch (error) {
      report(error);
    }
  }

  async function syncVisible() {
    if (disposed || !view?.visible) return;
    const current = pages();
    if (current.length) {
      // Sidebar show must not steal editor focus — only refresh the page list.
      const active = current.find(item => item.active) || current[0];
      if (active?.id) lastRevealedId = active.id;
      openedOnce = true;
      suppressAutoOpen = false;
      ensureOpenOnce = false;
      publish();
      return;
    }
    if (ensureOpenOnce && typeof host?.open === 'function') {
      ensureOpenOnce = false;
      openedOnce = true;
      suppressAutoOpen = false;
      const opened = await host.open('about:blank', { preserveFocus: false, viewColumn: vscode.ViewColumn?.Two });
      lastRevealedId = opened?.id || '';
      publish();
      return;
    }
    lastRevealedId = '';
    publish();
  }

  return {
    /** Request a blank page the next time this sidebar becomes visible with no pages. */
    requestEnsureOpen() {
      ensureOpenOnce = true;
      suppressAutoOpen = false;
    },
    whenIdle() {
      return queue;
    },
    resolveWebviewView(next) {
      if (disposed || view === next) return;
      if (view) releaseView();
      view = next;
      if (!pages().length) {
        openedOnce = false;
        lastRevealedId = '';
      }
      view.webview.options = { enableScripts: true, localResourceRoots: [] };
      const listener = view.webview.onDidReceiveMessage(message => run(async () => {
        if (view !== next || disposed) return;
        if (message?.action === 'ready') {
          await syncVisible();
          return;
        }
        if (message?.action === 'files') {
          await vscode.commands.executeCommand('workbench.view.explorer');
          return;
        }
        if (message?.action === 'workers') {
          await vscode.commands.executeCommand('workbench.view.extension.ubovm-workers');
          return;
        }
        if (message?.action === 'go') {
          const url = normalizeUrl(message.url);
          suppressAutoOpen = false;
          openedOnce = true;
          const current = pages();
          const active = current.find(item => item.active) || current[0];
          if (active && typeof host?.navigate === 'function') {
            await host.navigate(url, active.id);
            lastRevealedId = active.id;
          } else if (typeof host?.open === 'function') {
            const opened = await host.open(url, { preserveFocus: false, viewColumn: vscode.ViewColumn?.Two });
            lastRevealedId = opened?.id || '';
          }
          publish();
          return;
        }
        if (message?.action === 'open') {
          const url = normalizeUrl(message.url);
          suppressAutoOpen = false;
          openedOnce = true;
          if (typeof host?.open === 'function') {
            const opened = await host.open(url, { preserveFocus: false, viewColumn: vscode.ViewColumn?.Two });
            lastRevealedId = opened?.id || '';
          }
          publish();
          return;
        }
        if (message?.action === 'back' || message?.action === 'forward' || message?.action === 'reload') {
          const current = pages();
          const active = current.find(item => item.active) || current[0];
          if (!active) return;
          await callHost(message.action, active.id);
          lastRevealedId = active.id;
          publish();
          return;
        }
        if (message?.action === 'activate' && typeof message.pageId === 'string') {
          if (typeof host?.call === 'function') {
            await host.call({}, { action: 'tab_activate', page_id: message.pageId });
          } else if (typeof host?.reveal === 'function') {
            const page = pages().find(item => item.id === message.pageId);
            if (page) await host.reveal(page.url || 'about:blank', { preserveFocus: false, force: true, pageId: message.pageId });
          }
          lastRevealedId = message.pageId;
          publish();
          return;
        }
        if (message?.action === 'close' && typeof message.pageId === 'string') {
          if (typeof host?.closePage === 'function') await host.closePage(message.pageId);
          else if (typeof host?.call === 'function') await host.call({}, { action: 'tab_close', page_id: message.pageId });
          if (lastRevealedId === message.pageId) lastRevealedId = '';
          if (!pages().length) suppressAutoOpen = true;
          publish({ focusUrl: !pages().length });
        }
      }));
      const visibility = view.onDidChangeVisibility?.(() => {
        if (view !== next) return;
        if (next.visible) void run(() => syncVisible());
        else publish();
      });
      const openSub = vscode.window.onDidOpenBrowserTab?.(() => publish());
      const closeSub = vscode.window.onDidCloseBrowserTab?.(() => {
        if (!pages().length) {
          suppressAutoOpen = true;
          lastRevealedId = '';
        }
        publish();
      });
      const activeSub = vscode.window.onDidChangeActiveBrowserTab?.(() => publish());
      const stateSub = vscode.window.onDidChangeBrowserTabState?.(() => publish());
      const disposal = view.onDidDispose(() => { if (view === next) releaseView(); });
      viewSubscriptions = [listener, visibility, openSub, closeSub, activeSub, stateSub, disposal].filter(Boolean);
      view.webview.html = renderBrowserSidebar();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      ensureOpenOnce = false;
      releaseView();
    }
  };
}

module.exports = { createBrowserSidebar, renderBrowserSidebar, normalizeUrl };
