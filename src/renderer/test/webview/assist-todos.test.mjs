import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('assist mode renders the session todo board from execution memory', () => {
  const html = read('webview/index.html');
  // A collapsible <details> board: the summary stays clickable and the state is user-controlled.
  // Collapsed by default; the header row carries the counts and the meter.
  assert.match(html, /<details class="assist-todos" id="assist-todos"[^>]*hidden>/);
  assert.doesNotMatch(html, /<details class="assist-todos"[^>]*\sopen[\s>]/);
  assert.match(html, /<summary class="assist-todos-summary"[^>]*>/);
  assert.match(html, /id="assist-todos-count"/);
  assert.match(html, /class="assist-todos-progress" aria-hidden="true"><span><\/span>/);
  // The meter belongs to the header row, so it never draws a rule across the panel.
  assert.match(html, /assist-todos-title[\s\S]*assist-todos-progress[\s\S]*<\/summary>/);
  assert.match(html, /id="assist-todos-groups"/);

  const app = read('webview/app.js');
  assert.match(app, /function renderAssistTodos\(\)/);
  assert.match(app, /hostState\?\.execution\?\.memory\?\.todos/);
  assert.match(app, /const TODO_ORDER = \['in_progress', 'pending', 'completed'\]/);
  assert.match(app, /const TODO_LABELS = \{ in_progress: '进行中', pending: '待做', completed: '已完成' \}/);
  assert.match(app, /pill\.className = 'assist-todos-pill'/);
  // Owner badges only appear for spawned workers and reuse the roster's name.
  assert.match(app, /const workers = Array\.isArray\(hostState\?\.execution\?\.workers\)/);
  assert.match(app, /const worker = workers\.find\(item => item\.id === id\)/);
  // A worker-owned row jumps to that worker's record.
  assert.match(app, /owner\.addEventListener\('click', \(\) => workerPanel\.show\(item\.owner\.id, owner\)\)/);
  // The fold choice is remembered per conversation, not per DOM node.
  assert.match(app, /const todoFold = new Map\(\)/);
  assert.match(app, /panel\.open = todoFold\.get\(currentSessionId\) \?\? false/);
  assert.match(app, /byId\('assist-todos'\)\.addEventListener\('toggle'/);
  // A slim completion bar rides the header.
  assert.match(app, /panel\.style\.setProperty\('--assist-todos-progress', Math\.round\(done \/ items\.length \* 100\) \+ '%'\)/);
  assert.match(app, /if \(goalMode \|\| !items\.length\) \{ panel\.hidden = true; return; \}/);
  // Runs on execution-only ticks too, so todo status changes repaint without a full paint.
  assert.match(app, /renderAssistTodos,\s*\n\s*\.\.\.\(executionOnly \? \[\] : \[renderConversationOutline, renderAssistEvidence\]\)/);

  const css = read('webview/styles.css');
  assert.match(css, /\.assist-todos-item\[data-status="completed"\] \.assist-todos-text \{/);
  assert.match(css, /\.assist-todos-item\[data-status="in_progress"\]::before \{/);
  assert.match(css, /\.assist-todos-summary \{[^}]*list-style: none;[^}]*cursor: pointer;/);
  assert.match(css, /\.assist-todos\[open\] > \.assist-todos-summary::before \{ transform: rotate\(90deg\); \}/);
  // A quiet list that belongs to the conversation: no box, no dividers, and the
  // same heading size and badge shape as the parallel-task strip it sits above.
  assert.match(css, /\.assist-todos \{ width: min\(100%, var\(--reading\)\); margin: 0 auto; padding: 6px var\(--gutter\) 2px; \}/);
  assert.doesNotMatch(css, /\.assist-todos \{[^}]*border-top/);
  assert.match(css, /\.assist-todos-item \{ display: flex; align-items: flex-start; gap: 11px; padding: 6px 8px; margin-inline: -8px; border-radius: 8px;/);
  assert.doesNotMatch(css, /\.assist-todos-item \+ \.assist-todos-item/);
  assert.match(css, /\.assist-todos-list \{[^}]*max-height: min\(30vh, 280px\);[^}]*overflow-y: auto;/);
  assert.match(css, /\.assist-todos-pill \{ display: inline-flex; align-items: center; gap: 5px; min-height: 19px; padding: 0 7px; border: 0; border-radius: 5px; background: var\(--hover\);/);
  // Completed rows use the roster's muted check mark instead of a filled badge.
  assert.match(css, /\.assist-todos-item\[data-status="completed"\]::before \{[^}]*transform: rotate\(-45deg\);/);
  assert.match(css, /\.assist-todos-item\[data-status="in_progress"\]::before \{[^}]*animation: tool-spin/);
  // The active task is the board's selected row: rail, tint and heavier text.
  assert.match(css, /\.assist-todos-item\[data-status="in_progress"\] \{ background: color-mix\(in srgb, var\(--accent\) 12%, var\(--canvas\)\); box-shadow: inset 3px 0 0 var\(--accent\); color: var\(--ink\); font-weight: 600; \}/);
  assert.match(app, /if \(item\.status === 'in_progress'\) row\.setAttribute\('aria-current', 'true'\)/);
  // Finished work reads as done: muted, struck-through text.
  assert.match(css, /\.assist-todos-item\[data-status="completed"\] \.assist-todos-text \{[^}]*text-decoration: line-through;/);
  // Hover stays inside the scroll container so row/owner highlights keep rounded corners.
  assert.match(css, /\.assist-todos-list \{[^}]*margin: 0 -8px; padding: 0 8px;[^}]*overflow-y: auto;/);
  assert.match(css, /\.assist-todos-item:hover \{ background: var\(--wash\); \}/);
  assert.match(css, /\.assist-todos-owner:hover \{ background: color-mix\(in srgb, var\(--ink\) 16%, var\(--canvas\)\); color: var\(--ink\); \}/);
  assert.match(css, /\.assist-todos-item\[data-status="in_progress"\] \.assist-todos-owner:hover \{/);

  const i18n = read('webview/i18n-en-more.js');
  assert.match(i18n, /'任务清单': 'Task list'/);
  assert.match(i18n, /'待做': 'To do'/);
});
