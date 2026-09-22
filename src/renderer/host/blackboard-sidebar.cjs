'use strict';

const { randomBytes } = require('node:crypto');

function renderSidebar() {
  const nonce = randomBytes(24).toString('base64');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style nonce="${nonce}">
  *{box-sizing:border-box}body{margin:0;color:var(--vscode-foreground);background:var(--vscode-sideBar-background);font:13px/1.75 'Segoe UI','Microsoft YaHei UI',sans-serif}
  header{position:sticky;top:0;display:flex;align-items:center;justify-content:space-between;gap:8px;padding:12px 16px;background:var(--vscode-sideBar-background);border-bottom:1px solid var(--vscode-sideBar-border)}
  header span{color:var(--vscode-descriptionForeground);font-size:11px}button{font:inherit;color:var(--vscode-foreground);background:transparent;border:1px solid var(--vscode-widget-border);border-radius:6px;padding:5px 9px;cursor:pointer}
  button:hover{background:var(--vscode-list-hoverBackground)}button:focus-visible{outline:2px solid var(--vscode-focusBorder);outline-offset:2px}
  main{padding:20px 16px;overflow-wrap:anywhere}h1{font-size:16px;line-height:1.6;margin:0 0 10px;white-space:pre-wrap}h2{font-size:11px;color:var(--vscode-descriptionForeground);font-weight:500;margin:22px 0 8px}
  p{margin:0;white-space:pre-wrap}.meta{font-size:11px;color:var(--vscode-descriptionForeground)}.section{padding:12px;background:color-mix(in srgb,var(--vscode-foreground) 4%,transparent);border:1px solid var(--vscode-widget-border);border-radius:8px}
  .links{display:grid;gap:7px}.links button{text-align:left;white-space:normal;overflow-wrap:anywhere}#empty{color:var(--vscode-descriptionForeground);padding:28px 0}#empty strong{display:block;color:var(--vscode-foreground);font-weight:500;margin-bottom:8px}[hidden]{display:none!important}
  </style></head><body><header><span>黑板 · 节点详情</span><button id="files" type="button">返回文件</button></header>
  <main><div id="empty"><strong>选择一个黑板节点</strong>在画布中点击事实或意图，在这里查看详情。</div><article id="detail" hidden></article></main>
  <script nonce="${nonce}">
  const vscode=acquireVsCodeApi(); let current=null;
  const element=(tag,text,cls='')=>{const node=document.createElement(tag);node.textContent=text;node.className=cls;return node;};
  document.getElementById('files').onclick=()=>vscode.postMessage({action:'files'});
  window.addEventListener('message',event=>{
    if(event.data?.type!=='detail')return;
    const next=event.data.detail, changed=current?.id!==next?.id;current=next;
    const article=document.getElementById('detail');article.replaceChildren();article.hidden=!current;document.getElementById('empty').hidden=!!current;
    if(!current)return;
    article.append(element('h1',current.title),element('p',current.meta,'meta'));
    for(const section of current.sections){article.append(element('h2',section.label),element('p',section.text,'section'));}
    if(current.links.length){article.append(element('h2','关联节点'));const links=element('div','','links');
      for(const link of current.links){const button=element('button',link.label);button.onclick=()=>vscode.postMessage({action:'select',id:link.id,sessionId:current.sessionId});links.append(button);}article.append(links);}
    if(changed)window.scrollTo(0,0);
  });vscode.postMessage({action:'ready'});
  </script></body></html>`;
}

function createBlackboardSidebar(vscode, { onSelect, onClose }) {
  let view, detail = null, sessionId = '';
  const publish = () => view?.webview.postMessage({ type: 'detail', detail });
  async function showFiles() {
    detail = null; publish(); onClose();
    await vscode.commands.executeCommand('workbench.view.explorer');
  }
  return {
    resolveWebviewView(next) {
      view = next;
      view.webview.options = { enableScripts: true, localResourceRoots: [] };
      const listener = view.webview.onDidReceiveMessage(message => {
        if (message?.action === 'ready') void publish();
        else if (message?.action === 'files') void showFiles();
        else if (message?.action === 'select' && detail && message.sessionId === sessionId && detail.links.some(link => link.id === message.id)) onSelect(message.id, sessionId);
      });
      view.onDidDispose(() => { listener.dispose(); if (view === next) view = undefined; });
      view.webview.html = renderSidebar();
    },
    setSession(id) {
      if (sessionId === id) return;
      sessionId = id; detail = null; void publish();
    },
    async update(value, reveal = false) {
      if (value && (value.sessionId !== sessionId || typeof value.id !== 'string' || typeof value.title !== 'string' || !Array.isArray(value.sections) || !Array.isArray(value.links))) return;
      detail = value; void publish();
      if (value && reveal) {
        await vscode.commands.executeCommand('workbench.view.extension.ubovm-blackboard');
        view?.show?.(true);
      }
    },
    showFiles
  };
}

module.exports = { createBlackboardSidebar, renderSidebar };
