'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

let locale = 'zh-CN';
let api;

function fill(message, args) {
  const text = message == null ? '' : String(message);
  if (!args.length) return text;
  return text.replace(/\{(\d+)\}/g, (match, index) => args[index] == null ? match : String(args[index]));
}

function ensure() {
  if (api) return api;
  const directory = path.join(__dirname, '../../webview');
  const context = {
    console,
    Object,
    String,
    Set,
    WeakMap,
    Boolean,
    Array,
    localStorage: { getItem: () => null, setItem() {} },
    document: {
      documentElement: { lang: 'zh-CN' },
      body: { nodeType: 1 },
      getElementById() { return null; },
      createTreeWalker() { return { nextNode() { return null; } }; }
    },
    NodeFilter: { SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2 },
    CustomEvent: class CustomEvent { constructor(type, init) { this.type = type; this.detail = init?.detail; } },
    dispatchEvent() {}
  };
  context.globalThis = context;
  vm.createContext(context);
  for (const file of ['i18n-en.js', 'i18n-en-more.js', 'i18n.js']) {
    vm.runInContext(fs.readFileSync(path.join(directory, file), 'utf8'), context, { filename: file });
  }
  api = context.UBOVMi18n;
  if (locale === 'en') api.setLocale('en', { persist: false, user: true, applyNow: true });
  return api;
}

function setInterfaceLocale(next) {
  locale = next === 'en' ? 'en' : 'zh-CN';
  if (api || locale === 'en') ensure().setLocale(locale, { persist: false, user: true, applyNow: true });
}

function currentInterfaceLocale() {
  return locale;
}

function interfaceText(message, ...args) {
  if (locale !== 'en') return fill(message, args);
  return ensure().t(message, ...args);
}

module.exports = { interfaceText, setInterfaceLocale, currentInterfaceLocale };
