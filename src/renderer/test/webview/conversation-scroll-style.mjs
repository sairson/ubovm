import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = relative => readFileSync(new URL(relative, import.meta.url), 'utf8');
const css = read('../../webview/styles.css');
const app = read('../../webview/app.js');
const goalChat = read('../../webview/goal/goal-chat.js');
const goalChatCss = read('../../webview/goal/goal-chat.css');
const goalChatPanel = read('../../host/ui/goal-chat-panel.cjs');

test('conversation keeps a stable scroll geometry at the bottom', () => {
  // Intrinsic-size re-estimation is the main source of thumb/content jumps while
  // dragging the scrollbar; the conversation must not opt into content-visibility.
  assert.doesNotMatch(css, /#messages\.history-heavy/);
  assert.match(css, /\.conversation \{[^}]*overflow-anchor: none/s);
  assert.match(css, /\.conversation-region:has\(> \.conversation:not\(\[hidden\]\)\) \.conversation \{ margin-inline: 32px; \}/);
});

test('the back-to-latest control uses hysteresis instead of flapping at the threshold', () => {
  assert.match(app, /let latestVisible = false/);
  assert.match(app, /delta > \(latestVisible \? 120 : 200\)/);
});

test('following pins synchronously so the thumb never drifts for a painted frame', () => {
  assert.doesNotMatch(app, /pendingScroll/);
  assert.match(app, /scroller\.scrollTop = scroller\.scrollHeight;\s*\n\s*position\.top = scroller\.scrollTop;/);
});

test('exploration chat pins synchronously and pauses following while dragging', () => {
  assert.doesNotMatch(goalChat, /followFrame = requestAnimationFrame/);
  assert.match(goalChat, /!follow \|\| interacting\(\)/);
  assert.match(goalChat, /pointerdown[\s\S]*?noteInteraction\(\)/);
  assert.match(goalChatCss, /\.goal-chat-body \{[^}]*scrollbar-gutter: stable/s);
});

test('exploration chat back-to-latest control never participates in transcript layout', () => {
  // It used to be a sticky flex item inside the scroll container: toggling it on
  // follow/near-bottom changed scrollHeight by its own height and jumped the thumb.
  assert.match(goalChatCss, /\.goal-chat-latest \{[^}]*position: absolute/s);
  assert.match(goalChatCss, /\.goal-chat-composer \{ position: relative;/);
  const composer = goalChatPanel.indexOf('id="goal-chat-composer"');
  const button = goalChatPanel.indexOf('id="goal-chat-latest"');
  assert.ok(composer > 0 && button > composer, 'the control lives in the composer, not in the scrolling log');
});
