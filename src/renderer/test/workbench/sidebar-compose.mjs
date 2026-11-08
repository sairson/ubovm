import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = relative => readFileSync(new URL(relative, import.meta.url), 'utf8');

test('sessions compose row wires the workspace switcher and new conversation commands', () => {
  const patch = read('../../../../resources/patches/sidebar-mode.patch');
  const extension = read('../../extension.cjs');
  assert.match(patch, /className = 'ubovm-sidebar-compose'/);
  assert.match(patch, /className = 'ubovm-workspace-row'/);
  assert.match(patch, /workspaceButton = container\.ownerDocument\.createElement\('div'\)/);
  assert.doesNotMatch(patch, /workspaceButton\.addEventListener\('click'/);
  assert.match(patch, /compose\.append\(chatButton, workspaceRow\)/, 'new session button sits above the workspace header');
  assert.match(patch, /className = 'ubovm-workspace-action'/);
  assert.match(patch, /'ubovm\.searchConversations'/);
  assert.match(patch, /'ubovm\.manageProjects'/);
  assert.match(patch, /'ubovm\.newProject'/);
  assert.match(patch, /'ubovm\.newChat'/);
  assert.match(patch, /'ubovm\.newGoal'/);
  assert.match(patch, /'ubovm\.workspaceLabel'/);
  assert.match(extension, /setContext', 'ubovm\.workspaceLabel'/);
});

test('sessions compose row reserves its chrome budget above the tree', () => {
  const css = read('../../workbench/workbench.css');
  assert.match(css, /\.ubovm-sidebar-compose/);
  assert.match(css, /\.ubovm-sidebar-compose \{[^}]*gap: 8px/s);
  assert.match(css, /\.ubovm-sidebar-compose \{[^}]*padding-bottom: 10px/s);
  assert.match(css, /top: 128px/);
  assert.match(css, /calc\(100% - 174px\)/);
  assert.match(read('../../../../resources/patches/sidebar-mode.patch'), /height - 174/);
});

test('new session button keeps a quiet card style with an outlined plus badge', () => {
  const css = read('../../workbench/workbench.css');
  assert.match(css, /\.ubovm-compose-new \{[^}]*border-radius: 9px/s);
  assert.match(css, /\.ubovm-compose-new \.codicon-add \{[^}]*border: 1px solid/s);
  assert.match(css, /\.ubovm-compose-new \.codicon-add \{[^}]*border-radius: 50%/s);
  assert.match(css, /\.ubovm-compose-new \.codicon-add::before/);
  assert.match(css, /\.ubovm-compose-new \.codicon-add::after/);
});
