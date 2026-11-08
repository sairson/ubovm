import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// The blackboard page must recover when the backend checkpoint was never loaded
// for the restored conversation: local refresh alone cannot rebuild the graph,
// so the host has to re-read (or restore) the authoritative projection.
const extension = readFileSync(new URL('../../extension.cjs', import.meta.url), 'utf8');
const app = readFileSync(new URL('../../webview/app.js', import.meta.url), 'utf8');

test('refreshBlackboard restores the backend checkpoint when the projection is not loaded', () => {
  const start = extension.indexOf('async function refreshBlackboard');
  assert.ok(start > 0, 'refreshBlackboard must exist');
  const block = extension.slice(start, start + 1600);
  assert.match(block, /harness\.authoritative\(id\)/, 'refresh re-reads the authoritative projection');
  assert.match(block, /if \(!loaded && !shuttingDown && sessions\.summary\(\)\.id === id\)/, 'only the current conversation may be restored from a refresh click');
  assert.match(block, /restoreExecutionFor\(sessions\.current\(\)\)/, 'a missing backend session is restored from its checkpoint before publishing');
  assert.match(extension, /async function restoreExecutionFor\(conversation\)/, 'restore logic is shared with the normal conversation restore');
  assert.match(extension, /async function restoreExecution\(\) \{\n\s+if \(!harness\) return;\n\s+return restoreExecutionFor\(sessions\.current\(\)\);/, 'the normal restore path still restores the current conversation');
});

test('the blackboard page asks the host for a missing board and explains restore failures', () => {
  assert.match(app, /function requestMissingBoard\(snapshot, nodes\)/, 'the page owns the missing-board request');
  assert.match(app, /if \(snapshot\) \{ missingBoardRequest\.pending = false; return; \}/, 'a published empty board is authoritative and must not cause request loops');
  assert.match(app, /action: 'refreshBlackboard'/, 'the page asks the host for an authoritative board');
  assert.match(app, /missingBoardRequest\.session === currentSessionId && now - missingBoardRequest\.at < 3000/, 'automatic requests are throttled per session');
  assert.match(app, /\['completed', 'failed', 'interrupted'\]\.includes\(execution\.status\)/, 'a finished session auto-requests its missing board');
  assert.match(app, /execution\.status === 'running' && Boolean\(execution\.parts\?\.length \|\| execution\.activities\?\.length \|\| execution\.workers\?\.length\)/, 'a running session only asks after it has produced work');
  assert.match(app, /黑板读取失败：\{0\} 点击刷新重试；若仍无内容，请重新打开会话。/, 'restore failures are surfaced on the empty board');
  assert.match(app, /正在重新读取黑板记录…/, 'the page explains that a reload is in flight');
});
