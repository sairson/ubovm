'use strict';

const { randomBytes } = require('node:crypto');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { createLatestDelivery } = require('../agent/latest-delivery.cjs');
const { interfaceText, currentInterfaceLocale } = require('../../harness/runtime/interface-text.cjs');

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
  const text = {
    title: interfaceText('黑板 · 节点详情'),
    files: interfaceText('返回文件'),
    emptyTitle: interfaceText('选择一个黑板节点'),
    emptyBody: interfaceText('在画布中点击事实或意图，在这里查看详情。'),
    links: interfaceText('关联节点'),
    switched: interfaceText('节点已切换，操作已取消。'),
    busy: interfaceText('待处理操作过多，请稍后重试。'),
    timeout: interfaceText('操作超时，请重试。'),
    send: interfaceText('操作发送失败，请重试。'),
    failed: interfaceText('操作失败，请重试。'),
    refresh: interfaceText('刷新'),
    refreshTitle: interfaceText('重新读取节点详情'),
    format: interfaceText('部分格式加载失败，已显示原文；重新选择节点可重试。')
  };
  const copy = JSON.stringify(text).replace(/</g, '\\u003c');
  const html = value => String(value).replace(/[&<>]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[char]));
  return `<!doctype html><html lang="${currentInterfaceLocale() === 'en' ? 'en' : 'zh-CN'}"><head><meta charset="utf-8">
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
  .section.md-content{--prose-size:13px;white-space:normal}.section.md-content p{white-space:pre-wrap}section{min-width:0}.md-content .md-code-toolbar{position:static;padding:6px 8px;background:transparent}header>span{min-width:0}.header-actions{display:flex;align-items:center;gap:6px;flex-shrink:0}
  /* Structured fact view: the Worker envelope is data, so it is rendered with
     dedicated cards instead of one long markdown blob. All colors come from the
     VS Code theme tokens and degrade to readable fallbacks. */
  .fact{display:grid;gap:12px;min-width:0;margin-top:10px}
  .fact-head{display:flex;flex-wrap:wrap;align-items:center;gap:6px 10px;min-width:0}
  .fact-chip{display:inline-flex;align-items:center;padding:1px 8px;border:1px solid currentColor;border-radius:999px;font-size:11px;line-height:1.7;white-space:nowrap}
  .fact-chip[data-status=confirmed]{color:var(--vscode-testing-iconPassed,#3fb950)}
  .fact-chip[data-status=partial]{color:var(--vscode-charts-yellow,#d29922)}
  .fact-chip[data-status=negative]{color:var(--vscode-charts-red,#f85149)}
  .fact-chip[data-status=blocked]{color:var(--vscode-charts-orange,#db6d28)}
  .fact-chip[data-status=truncated]{color:var(--vscode-descriptionForeground,#666);border-style:dashed}
  .fact-counts{display:flex;flex-wrap:wrap;gap:4px 12px;margin:0;font-size:11.5px;color:var(--vscode-descriptionForeground,#666)}
  .fact-statement{font-size:13px;line-height:1.75;white-space:pre-wrap;overflow-wrap:anywhere;margin:0}
  .fact-statement.is-clamped{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:8;overflow:hidden}
  .fact-actions{display:flex;flex-wrap:wrap;gap:6px}
  .fact-actions button{font-size:11px;padding:2px 9px;border-radius:5px}
  .fact-block{min-width:0}.fact-block h2{margin:16px 0 8px}
  .fact-coverage,.fact-evidence,.fact-list{list-style:none;margin:0;padding:0;display:grid;gap:8px;min-width:0}
  .fact-coverage li,.fact-evidence li{border:1px solid var(--border);border-radius:8px;padding:8px 10px;background:var(--wash);min-width:0;overflow-wrap:anywhere}
  .fact-item-head{display:flex;align-items:baseline;gap:7px;flex-wrap:wrap;min-width:0}
  .fact-pill{flex:0 0 auto;font-size:10.5px;line-height:1.6;padding:0 6px;border:1px solid currentColor;border-radius:999px;white-space:nowrap}
  .fact-pill[data-status=confirmed]{color:var(--vscode-testing-iconPassed,#3fb950)}
  .fact-pill[data-status=partial]{color:var(--vscode-charts-yellow,#d29922)}
  .fact-pill[data-status=negative]{color:var(--vscode-charts-red,#f85149)}
  .fact-pill[data-status=blocked]{color:var(--vscode-charts-orange,#db6d28)}
  .fact-pill[data-status=unknown]{color:var(--vscode-descriptionForeground,#666)}
  .fact-point{font-weight:600;overflow-wrap:anywhere}
  .fact-result{margin:4px 0 0;font-size:12px;line-height:1.7;white-space:pre-wrap;overflow-wrap:anywhere;color:var(--vscode-descriptionForeground,#666)}
  .fact-observation{margin:0;font-size:12px;line-height:1.7;white-space:pre-wrap;overflow-wrap:anywhere}
  .fact-ref{display:inline-block;margin-top:5px;padding:0 5px;border-radius:4px;background:var(--vscode-textCodeBlock-background,#f1f1f1);font-family:var(--vscode-editor-font-family,Consolas,'SFMono-Regular',monospace);font-size:10.5px;overflow-wrap:anywhere}
  .fact-list li{position:relative;padding-left:13px;font-size:12px;line-height:1.7;overflow-wrap:anywhere}
  .fact-list li::before{content:'•';position:absolute;left:2px;color:var(--vscode-descriptionForeground,#666)}
  .fact-note{margin:0;padding:8px 10px;border-radius:8px;background:var(--vscode-textBlockQuote-background,#f5f5f5);color:var(--vscode-descriptionForeground,#666);font-size:11.5px;line-height:1.7;overflow-wrap:anywhere}
  .fact-empty{font-size:12px;color:var(--vscode-descriptionForeground,#666);margin:0}
  </style></head><body><header><span>${html(text.title)}</span><div class="header-actions"><button id="refresh" type="button" title="${html(text.refreshTitle)}">${html(text.refresh)}</button><button id="files" type="button">${html(text.files)}</button></div></header>
  <main><div id="empty"><strong>${html(text.emptyTitle)}</strong>${html(text.emptyBody)}</div><article id="detail" hidden></article></main>
  <script nonce="${nonce}">
  const L=${copy};
  const vscode=acquireVsCodeApi(); let current=null, rendered, heading, meta, factHost, sections, linkHeading, links, factKey='';
  const sectionNodes=new Map(), linkNodes=new Map();
  let sequence=0,navigation=0;const pending=new Map();
  function cancelRequests(){
    ++navigation;
    for(const entry of pending.values()){clearTimeout(entry.timer);entry.reject(new Error(L.switched));}
    pending.clear();
  }
  window.addEventListener('pagehide',cancelRequests);
  function openLink(href){const origin=navigation;return request('openMessageLink',{href}).catch(error=>{if(origin===navigation&&meta)meta.textContent=error.message;});}
  function request(action,payload){return new Promise((resolve,reject)=>{
    if(pending.size>=32){reject(new Error(L.busy));return;}
    const requestId='fact-'+(++sequence),timer=setTimeout(()=>{pending.delete(requestId);reject(new Error(L.timeout));},10000);
    const entry={resolve,reject,timer};pending.set(requestId,entry);
    // Bridge rejection values are untrusted; consumers always receive a readable Error.
    const failed=()=>{if(pending.get(requestId)!==entry)return;clearTimeout(timer);pending.delete(requestId);reject(new Error(L.send));};
    try{Promise.resolve(vscode.postMessage({action,...payload,requestId,sessionId:current?.sessionId})).then(value=>{if(value===false)failed(new Error(L.send));},failed);}catch(error){failed(error);}
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
  function factStringList(values){return Array.isArray(values)?values.filter(value=>typeof value==='string'&&value.trim()):[];}
  function factCountLine(counts){
    const labels=[['confirmed','已确认'],['partial','部分完成'],['negative','已否定'],['blocked','受阻'],['unknown','待确认']],bits=[];
    for(const [key,label] of labels)if(Number.isSafeInteger(counts?.[key])&&counts[key]>0)bits.push(counts[key]+' '+label);
    if(Number.isSafeInteger(counts?.evidence)&&counts.evidence>0)bits.push(counts.evidence+' 条证据');
    if(!bits.length)return null;
    const line=element('p','','fact-counts');
    for(const bit of bits)line.append(element('span',bit,'fact-count'));
    return line;
  }
  function factBlock(label,listClass){
    const block=element('section','','fact-block');block.append(element('h2',label));
    const list=element('ul','',listClass);block.append(list);return {block,list};
  }
  function buildFact(host,fact){
    const labels={confirmed:'已确认',partial:'部分完成',negative:'已否定',blocked:'受阻'};
    const head=element('div','','fact-head');
    const outcome=labels[fact.outcome]?fact.outcome:'';
    if(outcome){const chip=element('span',labels[outcome],'fact-chip');chip.dataset.status=outcome;head.append(chip);}
    if(fact.truncated){const chip=element('span','摘要','fact-chip');chip.dataset.status='truncated';head.append(chip);}
    const counts=factCountLine(fact.counts);if(counts)head.append(counts);
    if(head.children.length)host.append(head);
    const statementText=typeof fact.statement==='string'?fact.statement:'';
    const statement=element('p',statementText,'section fact-statement');host.append(statement);
    const actions=element('div','','fact-actions');
    const copy=element('button','复制结论');copy.type='button';copy.onclick=()=>request('copyText',{text:fact.statement}).catch(()=>{});actions.append(copy);
    if(statementText.length>700){
      statement.classList.add('is-clamped');
      const toggle=element('button','展开全文');toggle.type='button';
      toggle.onclick=()=>{const clamped=statement.classList.toggle('is-clamped');toggle.textContent=clamped?'展开全文':'收起';};
      actions.append(toggle);
    }
    host.append(actions);
    const coverage=Array.isArray(fact.coverage)?fact.coverage:[];
    if(coverage.length){
      const parts=factBlock('验证覆盖','fact-coverage');
      for(const item of coverage){
        const li=element('li',''),itemHead=element('div','','fact-item-head');
        const status=typeof item.status==='string'?item.status:'unknown';
        const pill=element('span',typeof item.statusLabel==='string'?item.statusLabel:(labels[status]||'待确认'),'fact-pill');pill.dataset.status=status;
        itemHead.append(pill,element('span',typeof item.point==='string'?item.point:'','fact-point'));
        li.append(itemHead,element('p',typeof item.result==='string'?item.result:'','fact-result'));
        parts.list.append(li);
      }
      host.append(parts.block);
    }
    const evidence=Array.isArray(fact.evidence)?fact.evidence:[];
    if(evidence.length){
      const parts=factBlock('证据','fact-evidence');
      for(const item of evidence){
        const li=element('li','');
        li.append(element('p',typeof item.observation==='string'?item.observation:'','fact-observation'));
        if(typeof item.ref==='string'&&item.ref.trim())li.append(element('span',item.ref,'fact-ref'));
        parts.list.append(li);
      }
      host.append(parts.block);
    }
    for(const [label,values] of [['失败检查',fact.failedChecks],['限制',fact.limitations],['后续步骤',fact.nextSteps]]){
      const items=factStringList(values);if(!items.length)continue;
      const parts=factBlock(label,'fact-list');
      for(const item of items)parts.list.append(element('li',item));
      host.append(parts.block);
    }
    if(fact.truncated){
      const omitted=fact.omitted&&typeof fact.omitted==='object'?fact.omitted:{};
      const names=[['coverage','项验证覆盖'],['evidence','条证据'],['failedChecks','项失败检查'],['limitations','项限制'],['nextSteps','项后续步骤']],parts=[];
      for(const [key,label] of names){const value=omitted[key];if(Number.isSafeInteger(value)&&value>0)parts.push(value+' '+label);}
      host.append(element('p','事实正文较长，界面显示结构化摘要'+(parts.length?'，已省略 '+parts.join('、'):'')+'；完整正文请查看 Worker 日志或导出图谱。','fact-note'));
    }
  }
  function render(detail){
    const next=detail, key=JSON.stringify(next);
    if(key===rendered)return;
    const changed=current?.id!==next?.id||current?.sessionId!==next?.sessionId;current=next;
    if(changed)cancelRequests();
    const article=document.getElementById('detail');article.hidden=!current;document.getElementById('empty').hidden=!!current;
    if(!current){article.replaceChildren();sectionNodes.clear();linkNodes.clear();factKey='';rendered=key;return;}
    if(changed){
      sectionNodes.clear();linkNodes.clear();factKey='';
      heading=element('h1','');meta=element('p','','meta');factHost=element('div','','fact');sections=element('div','');linkHeading=element('h2',L.links);links=element('div','','links');
      article.replaceChildren(heading,meta,factHost,sections,linkHeading,links);
    }
    put(heading,current.title);put(meta,current.meta||'');let formatFailed=false;
    const fact=current.fact;
    if(fact){
      const nextFactKey=JSON.stringify(fact);
      sections.hidden=true;factHost.hidden=false;
      if(nextFactKey!==factKey){factHost.replaceChildren();buildFact(factHost,fact);factKey=nextFactKey;}
    }else{
      sections.hidden=false;factHost.hidden=true;factKey='';
      reconcile(sections,sectionNodes,current.sections,(value,index)=>value.label+':'+index,()=>{
        const node=element('section',''),label=element('h2',''),text=element('div','','section');node.append(label,text);return {node,label,text};
      },(record,value)=>{
        put(record.label,value.label);
        try{if(window.UBOVMMarkdown)window.UBOVMMarkdown.update(record.text,value.text,{onCopy:text=>request('copyText',{text}),onOpenLink:openLink});else put(record.text,value.text);record.text.style && (record.text.style.whiteSpace='');}
        catch{formatFailed=true;put(record.text,value.text);record.text.style && (record.text.style.whiteSpace='pre-wrap');}
      });
    }
    linkHeading.hidden=links.hidden=!current.links.length;
    reconcile(links,linkNodes,current.links,value=>value.id,value=>{
      const node=element('button','');node.type='button';node.onclick=()=>vscode.postMessage({action:'select',id:value.id,sessionId:current.sessionId});return {node};
    },(record,value)=>put(record.node,value.label));
    if(changed)window.scrollTo(0,0);
    if(formatFailed)put(meta,(current.meta?current.meta+' · ':'')+L.format);
    rendered=formatFailed?undefined:key;
  }
  document.getElementById('refresh').onclick=()=>{
    // Rebuild the panel from the last detail even when the previous paint was
    // partial, then ask the host to republish the authoritative projection. A
    // lost detail message otherwise leaves the panel blank with no recovery.
    const detail=current;current=null;rendered=undefined;
    try{render(detail);}catch{}
    try{vscode.postMessage({action:'refresh'});}catch{}
  };
  window.addEventListener('message',event=>{
    if(event.data?.type==='uiResult'){const response=event.data,entry=pending.get(response.requestId);if(entry){clearTimeout(entry.timer);pending.delete(response.requestId);response.ok?entry.resolve():entry.reject(new Error(typeof response.error==='string'?response.error:response.error?.message||L.failed));}return;}
    if(event.data?.type!=='detail')return;
    render(event.data.detail);
  });vscode.postMessage({action:'ready'});
  </script><script nonce="${nonce}">${scripts}</script></body></html>`;
}

/** Optional structured fact payload; malformed records never replace the readable projection. */
function plausibleFactView(fact) {
  if (fact === undefined || fact === null) return true;
  if (typeof fact !== 'object' || Array.isArray(fact)) return false;
  if (typeof fact.statement !== 'string' || !Array.isArray(fact.coverage) || !Array.isArray(fact.evidence)) return false;
  if (fact.coverage.some(item => !item || typeof item !== 'object' || Array.isArray(item) ||
      typeof item.point !== 'string' || typeof item.result !== 'string' ||
      typeof item.status !== 'string' || typeof item.statusLabel !== 'string')) return false;
  if (fact.evidence.some(item => !item || typeof item !== 'object' || Array.isArray(item) ||
      typeof item.observation !== 'string' || (item.ref !== undefined && typeof item.ref !== 'string'))) return false;
  for (const key of ['failedChecks', 'limitations', 'nextSteps']) {
    if (fact[key] !== undefined && (!Array.isArray(fact[key]) || fact[key].some(value => typeof value !== 'string'))) return false;
  }
  if (fact.outcome !== undefined && typeof fact.outcome !== 'string') return false;
  if (fact.truncated !== undefined && typeof fact.truncated !== 'boolean') return false;
  if (fact.omitted !== undefined && fact.omitted !== null && (typeof fact.omitted !== 'object' || Array.isArray(fact.omitted))) return false;
  if (fact.counts !== undefined && (!fact.counts || typeof fact.counts !== 'object' || Array.isArray(fact.counts))) return false;
  return true;
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
        else if (message?.action === 'refresh') void publish();
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
      view.title = interfaceText('黑板详情');
      view.webview.html = renderSidebar();
    },
    applyLanguage() {
      if (!view) return;
      view.title = interfaceText('黑板详情');
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
      if (value && !plausibleFactView(value.fact)) return;
      detail = value; void publish();
      if (!value) ++navigationRevision;
      if (value && reveal) {
        const revision = ++navigationRevision;
        await navigate('workbench.view.extension.ubovm-blackboard', revision, true);
        // publish() above was skipped while the view was hidden; repeat the
        // latest detail after the reveal so a missed visibility event cannot
        // leave the panel showing an older node. Await it so callers only
        // observe the revealed panel once the detail has been handed over.
        if (view && revision === navigationRevision) await publish();
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
