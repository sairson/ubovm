'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { interfaceText, setInterfaceLocale } = require('../../../harness/runtime/interface-text.cjs');

test('sidebar chrome stays Chinese until the saved interface language is English', () => {
  setInterfaceLocale('zh-CN');
  assert.equal(interfaceText('项目与会话'), '项目与会话');
  assert.equal(interfaceText('2 个协助会话 · 1 个探索会话'), '2 个协助会话 · 1 个探索会话');
  setInterfaceLocale('en');
  try {
    assert.equal(interfaceText('项目与会话'), 'Projects and sessions');
    assert.equal(interfaceText('模型'), 'Model');
    assert.equal(interfaceText('黑板详情'), 'Blackboard');
    assert.equal(interfaceText('Worker 日志'), 'Worker logs');
    assert.equal(interfaceText('2 个协助会话 · 1 个探索会话'), '2 assist sessions · 1 exploration sessions');
    assert.equal(interfaceText('3 条消息'), '3 messages');
    assert.equal(interfaceText('运行中'), 'Running');
  } finally {
    setInterfaceLocale('zh-CN');
  }
});
