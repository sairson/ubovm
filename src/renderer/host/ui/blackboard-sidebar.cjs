'use strict';

const { randomBytes } = require('node:crypto');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { createLatestDelivery } = require('../agent/latest-delivery.cjs');

let bundle;
function loadBundle() {
  if (bundle) return bundle;
  const read = file => readFileSync(path.join(__dirname, '../../webview', file), 'utf8');
  return bundle = {
    styles: read('messages/message-markdown.css'),
    scripts: ['vendor/marked.umd.js', 'messages/message-markdown.js'].map(read).join('\n;\n').replace(/<\/script/gi, '<\\/script')
  };
}

function renderSidebar() {
  const nonce = randomBytes(24).toString('base64');
  const { styles, scripts } = loadBundle();
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style nonce="${nonce}">
  ${styles}
  *{box-sizing:border-box}body{margin:0;color:var(--vscode-foreground,#292a2d);background:var(--vscode-sideBar-background,#f7f7f6);font-family:var(--vscode-font-family,'Segoe UI','Microsoft YaHei UI',sans-serif);font-size:var(--vscode-font-size,13px);line-height:1.7}
  header{position:sticky;top:0;display:flex;align-items:center;justify-content:space-between;gap:8px;padding:12px 16px;background:var(--vscode-sideBar-background);border-bottom:1px solid var(--vscode-sideBar-border)}
  header span{color:var(--vscode-descriptionForeground);font-size:11px}button{font:inherit;color:var(--vscode-foreground);background:transparent;border:1px solid var(--vscode-widget-border,#ddd);border-radius:6px;padding:5px 9px;cursor:pointer}
  button:hover{background:var(--vscode-list-hoverBackground)}button:focus-visible{outline:2px solid var(--vscode-focusBorder);outline-offset:2px}
  main{padding:16px;overflow-wrap:anywhere;min-width:0}h1{font-size:1.08em;font-weight:600;line-height:1.5;margin:0 0 8px;white-space:pre-wrap}h2{font-size:.92em;color:var(--vscode-descriptionForeground,#666);font-weight:600;line-height:1.5;margin:20px 0 7px}
  p{margin:0;white-space:pre-wrap}.meta{font-size:.85em;line-height:1.5;color:var(--vscode-descriptionForeground,#666);padding-bottom:14px;border-bottom:1px solid var(--vscode-widget-border,#ddd)}.section{font-weight:400;line-height:1.75;tab-size:2}
  .links{display:grid;gap:7px}.links button{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:3;overflow:hidden;width:100%;min-width:0;text-align:left;white-space:normal;overflow-wrap:anywhere;font-size:.92em;line-height:1.6;padding:8px 10px}#empty{color:var(--vscode-descriptionForeground);padding:28px 0}#empty strong{display:block;color:var(--vscode-foreground);font-weight:500;margin-bottom:8px}[hidden]{display:none!important}
  body{--ink:var(--vscode-foreground,#292a2d);--muted:var(--vscode-descriptionForeground,#666);--border:var(--vscode-widget-border,#ddd);--wash:var(--vscode-textCodeBlock-background,#f1f1f1);--hover:var(--vscode-list-hoverBackground,#eee)}
  .section.md-content{--prose-size:13px;white-space:normal}.section.md-content p{white-space:pre-wrap}section{min-width:0}.md-content .md-code-toolbar{position:static;padding:6px 8px;background:transparent}header>span{min-width:0}header>button{flex-shrink:0}
  </style></head><body><header><span>黑板 · 节点详情</span><button id="files" type="button">返回文件</button></header>
  <main><div id="empty"><strong>选择一个黑板节点</strong>在画布中点击事实或意图，在这里查看详情。</div><article id="detail" hidden></article></main>
  <script nonce="${nonce}">
  const vscode=acquireVsCodeApi(); let current=null, rendered, heading, meta, sections, linkHeading, links;
  const sectionNodes=new Map(), linkNodes=new Map();
  let sequence=0,navigation=0;const pending=new Map();
  function cancelRequests(){
    ++navigation;
    for(const entry of pending.values()){clearTimeout(entry.timer);entry.reject(new Error('节点已切换，操作已取消。'));}
    pending.clear();
  }
  window.addEventListener('pagehide',cancelRequests);
  function openLink(href){const origin=navigation;return request('openMessageLink',{href}).catch(error=>{if(origin===navigation&&meta)meta.textContent=error.message;});}
  function request(action,payload){return new Promise((resolve,reject)=>{
    if(pending.size>=32){reject(new Error('待处理操作过多，请稍后重试。'));return;}
    const requestId='fact-'+(++sequence),timer=setTimeout(()=>{pending.delete(requestId);reject(new Error('操作超时，请重试。'));},10000);
    const entry={resolve,reject,timer};pending.set(requestId,entry);
    // Bridge rejection values are untrusted; consumers always receive a readable Error.
    const failed=()=>{if(pending.get(requestId)!==entry)return;clearTimeout(timer);pending.delete(requestId);reject(new Error('操作发送失败，请重试。'));};
    try{Promise.resolve(vscode.postMessage({action,...payload,requestId,sessionId:current?.sessionId})).then(value=>{if(value===false)failed(new Error('操作发送失败，请重试。'));},failed);}catch(error){failed(error);}
  });}
  const element=(tag,text,cls='')=>{const node=document.createElement(tag);node.textContent=text;node.className=cls;return node;};
  const put=(node,text)=>{if(node.textContent!==text)node.textContent=text;};
  function reconcile(parent,records,values,keyOf,create,update){
    const keep=new Set();
    values.forEach((value,index)=>{
      const key=keyOf(value,index);keep.add(key);let record=records.get(key);
      if(!record){record=create(value);records.set(key,record);}update(record,value);
      if(parent.children[index]!==record.node)parent.insertBefore(record.node,parent.children[index]||null);
    });
    for(const [key,record] of records)if(!keep.has(key)){record.node.remove();records.delete(key);}
  }
  document.getElementById('files').onclick=()=>vscode.postMessage({action:'files'});
  window.addEventListener('message',event=>{
    if(event.data?.type==='uiResult'){const response=event.data,entry=pending.get(response.requestId);if(entry){clearTimeout(entry.timer);pending.delete(response.requestId);response.ok?entry.resolve():entry.reject(new Error(typeof response.error==='string'?response.error:response.error?.message||'操作失败，请重试。'));}return;}
    if(event.data?.type!=='detail')return;
    const next=event.data.detail, key=JSON.stringify(next);
    if(key===rendered)return;
    const changed=current?.id!==next?.id||current?.sessionId!==next?.sessionId;current=next;
    if(changed)cancelRequests();
    const article=document.getElementById('detail');article.hidden=!current;document.getElementById('empty').hidden=!!current;
    if(!current){article.replaceChildren();sectionNodes.clear();linkNodes.clear();rendered=key;return;}
    if(changed){
      sectionNodes.clear();linkNodes.clear();
      heading=element('h1','');meta=element('p','','meta');sections=element('div','');linkHeading=element('h2','关联节点');links=element('div','','links');
      article.replaceChildren(heading,meta,sections,linkHeading,links);
    }
    put(heading,current.title);put(meta,current.meta||'');let formatFailed=false;
    reconcile(sections,sectionNodes,current.sections,(value,index)=>value.label+':'+index,()=>{
      const node=element('section',''),label=element('h2',''),text=element('div','','section');node.append(label,text);return {node,label,text};
    },(record,value)=>{
      put(record.label,value.label);
      try{if(window.UBOVMMarkdown)window.UBOVMMarkdown.update(record.text,value.text,{onCopy:text=>request('copyText',{text}),onOpenLink:openLink});else put(record.text,value.text);record.text.style && (record.text.style.whiteSpace='');}
      catch{formatFailed=true;put(record.text,value.text);record.text.style && (record.text.style.whiteSpace='pre-wrap');}
    });
    linkHeading.hidden=links.hidden=!current.links.length;
    reconcile(links,linkNodes,current.links,value=>value.id,value=>{
      const node=element('button','');node.type='button';node.onclick=()=>vscode.postMessage({action:'select',id:value.id,sessionId:current.sessionId});return {node};
    },(record,value)=>put(record.node,value.label));
    if(changed)window.scrollTo(0,0);
    if(formatFailed)put(meta,(current.meta?current.meta+' · ':'')+'部分格式加载失败，已显示原文；重新选择节点可重试。');
    rendered=formatFailed?undefined:key;
  });vscode.postMessage({action:'ready'});
  </script><script nonce="${nonce}">${scripts}</script></body></html>`;
}

function createBlackboardSidebar(vscode, { onSelect, onClose, onAction, onError = () => {} }) {
  let view, detail = null, sessionId = '', navigationRevision = 0;
  let navigationTask = Promise.resolve();
  let disposed = false, viewSubscriptions = [];
  const report = error => {
    try { Promise.resolve(onError(error)).catch(() => {}); } catch { /* Error observers cannot interrupt component cleanup. */ }
  };
  const delivery = createLatestDelivery(report);
  function releaseView() {
    view = undefined; ++navigationRevision; delivery.clear();
    const subscriptions = viewSubscriptions; viewSubscriptions = [];
    for (const subscription of subscriptions) {
      try { Promise.resolve(subscription?.dispose()).catch(report); } catch (error) { report(error); }
    }
  }
  function navigate(command, revision, reveal = false) {
    // Workbench commands cannot be aborted: finish the active command before
    // applying the latest destination, and never reveal an obsolete detail.
    const task = navigationTask.then(async () => {
      if (revision !== navigationRevision) return;
      await vscode.commands.executeCommand(command);
      if (revision === navigationRevision && reveal) view?.show?.(true);
    });
    navigationTask = task.catch(() => {});
    return task;
  }
  const publish = () => {
    if (!view || view.visible === false) return;
    return delivery.publish(() => view && view.visible !== false ? view.webview.postMessage({ type: 'detail', detail }) : undefined);
  };
  async function showFiles() {
    if (disposed) return;
    const revision = ++navigationRevision;
    detail = null; publish();
    // This notification updates the conversation UI, but is not a navigation
    // acknowledgement. A slow/disposed conversation must not trap the sidebar.
    void Promise.resolve().then(onClose).catch(report);
    await navigate('workbench.view.explorer', revision);
  }
  return {
    resolveWebviewView(next) {
      if (disposed || view === next) return;
      if (view) releaseView();
      delivery.clear();
      view = next;
      view.webview.options = { enableScripts: true, localResourceRoots: [] };
      const listener = view.webview.onDidReceiveMessage(async message => {
        try {
        if (view !== next) return;
        if (message?.action === 'ready') void publish();
        else if (message?.action === 'files') await showFiles();
        else if (message?.action === 'select' && detail && message.sessionId === sessionId && detail.links.some(link => link.id === message.id)) await onSelect(message.id, sessionId);
        else if (['copyText', 'openMessageLink'].includes(message?.action) && detail && message.sessionId === sessionId && onAction) await onAction(message, next);
        } catch (error) { if (view === next) report(error); }
      });
      const visibility = view.onDidChangeVisibility?.(() => {
        if (view !== next) return;
        if (!next.visible) { ++navigationRevision; delivery.clear({ resetTransport: false }); }
        else void publish();
      });
      const disposal = view.onDidDispose(() => { if (view === next) releaseView(); });
      viewSubscriptions = [listener, visibility, disposal];
      view.webview.html = renderSidebar();
    },
    setSession(id) {
      if (disposed || sessionId === id) return;
      ++navigationRevision;
      sessionId = id; detail = null; void publish();
    },
    async update(value, reveal = false) {
      if (disposed) return;
      if (value && (value.sessionId !== sessionId || typeof value.id !== 'string' || typeof value.title !== 'string' || !Array.isArray(value.sections) || !Array.isArray(value.links))) return;
      if (value && (value.sections.some(section => !section || typeof section.label !== 'string' || typeof section.text !== 'string')
        || value.links.some(link => !link || typeof link.id !== 'string' || (link.label !== undefined && typeof link.label !== 'string')))) return;
      detail = value; void publish();
      if (!value) ++navigationRevision;
      if (value && reveal) {
        await navigate('workbench.view.extension.ubovm-blackboard', ++navigationRevision, true);
      }
    },
    showFiles,
    dispose() {
      if (disposed) return;
      disposed = true; detail = null; sessionId = ''; releaseView();
    }
  };
}

module.exports = { createBlackboardSidebar, renderSidebar };
