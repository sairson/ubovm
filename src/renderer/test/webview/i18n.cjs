'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const webview = path.join(__dirname, '../../webview');

function loadI18n(saved) {
  const store = new Map(saved ? [['ubovm.locale', saved]] : []);
  const listeners = new Map();
  const document = {
    documentElement: { lang: 'zh-CN' },
    body: { nodeType: 1 },
    title: 'UBOVM · 对话',
    getElementById() { return null; },
    createTreeWalker() { return { nextNode() { return null; } }; },
    querySelector() { return null; }
  };
  const context = {
    globalThis: null,
    console,
    Object,
    String,
    Set,
    WeakMap,
    Boolean,
    Array,
    CustomEvent: class CustomEvent { constructor(type, init) { this.type = type; this.detail = init?.detail; } },
    localStorage: { getItem: key => store.get(key) ?? null, setItem: (key, value) => store.set(key, value) },
    document,
    NodeFilter: { SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2 },
    dispatchEvent(event) { for (const listener of listeners.get(event.type) || []) listener(event); },
    addEventListener(type, listener) {
      const list = listeners.get(type) || [];
      list.push(listener);
      listeners.set(type, list);
    }
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(webview, 'i18n-en.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(webview, 'i18n.js'), 'utf8'), context);
  return context.UBOVMi18n;
}

test('webview locale stays Chinese until English is selected', () => {
  const i18n = loadI18n();
  assert.equal(i18n.locale, 'zh-CN');
  assert.equal(i18n.t('系统配置'), '系统配置');
  assert.equal(i18n.t('基础配置 1/2 · 请完成模型。'), '基础配置 1/2 · 请完成模型。');
  assert.equal(i18n.t('删除项目“{0}”？', '官网'), '删除项目“官网”？');
  i18n.setLocale('en', { applyNow: false });
  assert.equal(i18n.locale, 'zh-CN');
  assert.equal(i18n.selected, 'en');
  assert.equal(i18n.t('系统配置'), '系统配置');
  i18n.setLocale('en');
  assert.equal(i18n.locale, 'en');
  assert.equal(i18n.t('系统配置'), 'Settings');
  assert.equal(i18n.t('首次初始化'), 'First-time setup');
  assert.equal(i18n.t('3 条记录'), '3 records');
  assert.equal(i18n.t('删除探索会话“重构”？'), 'Delete exploration “重构”?');
  assert.equal(i18n.t('用户写的笔记标题'), '用户写的笔记标题');
  i18n.setLocale('zh-CN');
  assert.equal(i18n.t('系统配置'), '系统配置');
});

test('a saved language survives the next load and ignores the host display language', () => {
  const i18n = loadI18n('en');
  assert.equal(i18n.locale, 'en');
  assert.equal(i18n.selected, 'en');
  assert.equal(i18n.t('系统配置'), 'Settings');
  i18n.applyHostLocale('zh-CN');
  assert.equal(i18n.locale, 'en');
  assert.equal(i18n.t('系统配置'), 'Settings');
});

test('conversation page bundles the locale catalog before the interface', () => {
  const { renderWebview } = require('../../host/ui/webview.cjs');
  const html = renderWebview({ workspaceName: 'demo' });
  const catalog = html.indexOf('UBOVM_I18N_EN');
  const runtime = html.indexOf('ubovm.locale');
  assert.ok(catalog > 0 && runtime > catalog);
  assert.doesNotMatch(html, /id="locale-toggle"/);
  assert.match(html, /id="settings-locale-zh"/);
  assert.match(html, /id="settings-locale-en"/);
  assert.match(html, /id="settings-locale-notice"/);
  assert.match(html, /id="settings-locale-restart"/);
  assert.match(html, /id="settings-locale-current"/);
  assert.match(html, /下次启动将切换界面语言。/);
  assert.match(html, /界面语言将在重新启动后生效。/);
  assert.match(html, />系统配置</);
});
