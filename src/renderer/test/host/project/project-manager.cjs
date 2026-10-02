'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createProjectManager } = require('../../../host/project/project-manager.cjs');
const turn = () => new Promise(resolve => setImmediate(resolve));
function fixture() {
  const pickers = [], changes = new Set(), calls = [];
  const projects = [{ id: 'a', name: 'Alpha', workspace: 'C:\\alpha' }, { id: 'b', name: 'Beta', workspace: 'C:\\beta' }];
  const vscode = { ThemeIcon: class { constructor(id) { this.id = id; } }, QuickPickItemKind: { Separator: -1 },
    commands: { executeCommand: async () => undefined },
    window: {
    createQuickPick() {
      const events = new Map();
      const picker = { value: '', activeItems: [], selectedItems: [], show() {}, hide() { this.emit('Hide'); }, dispose() { this.disposed = true; },
        emit(name, value) { for (const callback of [...(events.get(name) || [])]) callback(value); } };
      for (const name of ['Accept', 'Hide', 'TriggerButton', 'TriggerItemButton']) picker['onDid' + name] = callback => {
        if (!events.has(name)) events.set(name, new Set());
        events.get(name).add(callback);
        return { dispose: () => events.get(name).delete(callback) };
      };
      pickers.push(picker); return picker;
    }
  } };
  const sessions = { summary: () => ({ projectId: 'a' }), projects: () => projects.map(project => ({ ...project })),
    projectSessions: () => [{ id: 'chat' }], provider: { onDidChangeTreeData(callback) { changes.add(callback); return { dispose: () => changes.delete(callback) }; } } };
  const actions = { create: async () => calls.push('create'), open: async id => calls.push('open:' + id),
    rename: async id => { calls.push('rename:' + id); projects.find(project => project.id === id).name = 'Renamed'; },
    remove: async id => { calls.push('remove:' + id); projects.splice(projects.findIndex(project => project.id === id), 1); },
    onError: async error => calls.push('error:' + error.message) };
  const manager = createProjectManager(vscode, sessions, actions);
  return { manager, pickers, changes, calls, projects, actions, sessions, vscode };
}
test('project manager exposes search, current project and contextual actions without duplicate pickers', async () => {
  const f = fixture();
  const pending = f.manager.show(); assert.equal(f.manager.show(), pending);
  const picker = f.pickers[0];
  assert.equal(picker.matchOnDetail, true);
  assert.match(picker.items.find(item => item.projectId === 'a').description, /当前项目/);
  assert.equal(picker.activeItems[0].projectId, 'a');
  assert.equal(picker.items.find(item => item.projectId === 'b').buttons.length, 2);
  picker.selectedItems = [picker.items.find(item => item.projectId === 'b')]; picker.emit('Accept');
  await pending;
  assert.deepEqual(f.calls, ['open:b']); assert.equal(picker.disposed, true); assert.equal(f.changes.size, 0);
});
test('renaming and deleting reopen fresh project lists while preserving search and disposing listeners', async () => {
  const f = fixture(), pending = f.manager.show();
  const picker = f.pickers[0], item = picker.items.find(item => item.projectId === 'a');
  picker.value = 'alpha'; picker.emit('TriggerItemButton', { item, button: item.buttons[0] });
  await turn();
  const renamed = f.pickers[1];
  assert.equal(renamed.value, 'alpha');
  assert.equal(renamed.items.find(item => item.projectId === 'a').label, 'Renamed');
  const toRemove = renamed.items.find(item => item.projectId === 'b');
  renamed.emit('TriggerItemButton', { item: toRemove, button: toRemove.buttons[1] }); await turn();
  const last = f.pickers[2]; assert.equal(last.items.some(item => item.projectId === 'b'), false);
  last.emit('Hide'); await pending;
  assert.deepEqual(f.calls, ['rename:a', 'remove:b']); assert.equal(f.changes.size, 0);
});
test('creation and shutdown settle project managers without leaking native UI listeners', async () => {
  const f = fixture(), pending = f.manager.show();
  f.pickers[0].emit('TriggerButton', f.pickers[0].buttons[0]); await pending;
  assert.deepEqual(f.calls, ['create']);
  const reopened = f.manager.show(); f.manager.dispose(); await reopened;
  assert.equal(f.changes.size, 0); assert.equal(f.pickers[1].disposed, true);
  await f.manager.show(); assert.equal(f.pickers.length, 2);
});
test('failed project actions return to the manager with fresh data and an error receipt', async () => {
  const f = fixture(); f.actions.remove = async () => { throw new Error('busy'); };
  const pending = f.manager.show(), picker = f.pickers[0], item = picker.items.find(item => item.projectId === 'b');
  picker.emit('TriggerItemButton', { item, button: item.buttons[1] }); await turn();
  assert.deepEqual(f.calls, ['error:busy']);
  assert(f.pickers[1].items.some(item => item.projectId === 'b'));
  f.pickers[1].emit('Hide'); await pending;
});
test('cancelling creation returns to the project list with its previous search', async () => {
  const f = fixture(); f.actions.create = async () => undefined;
  const pending = f.manager.show(), picker = f.pickers[0];
  picker.value = 'beta'; picker.selectedItems = [picker.items[0]]; picker.emit('Accept');
  await turn();
  assert.equal(f.pickers[1].value, 'beta');
  f.pickers[1].emit('Hide'); await pending;
  assert.equal(f.changes.size, 0);
});

test('streaming updates preserve list identity and search selection until project metadata changes', async () => {
  const f = fixture(), pending = f.manager.show(), picker = f.pickers[0];
  const items = picker.items;
  picker.value = 'beta'; picker.activeItems = [items.find(item => item.projectId === 'b')];
  for (const refresh of f.changes) refresh();
  assert.equal(picker.items, items);
  assert.equal(picker.activeItems[0].projectId, 'b');
  assert.equal(items[0].alwaysShow, true);
  f.projects[1].name = 'Beta updated';
  for (const refresh of f.changes) refresh();
  assert.notEqual(picker.items, items); assert.equal(picker.value, 'beta');
  assert.equal(picker.activeItems[0].projectId, 'b');
  picker.emit('Hide'); await pending;
});

test('running projects expose status and suppress delete while unknown buttons do nothing', async () => {
  const f = fixture(); let running = 1;
  f.actions.runningCount = id => id === 'b' ? running : 0;
  const pending = f.manager.show(), picker = f.pickers[0];
  let item = picker.items.find(item => item.projectId === 'b');
  assert.match(item.description, /1 运行中/); assert.equal(item.buttons.length, 1);
  picker.emit('TriggerItemButton', { item, button: {} });
  assert.equal(picker.disposed, undefined); assert.deepEqual(f.calls, []);
  running = 0; for (const refresh of f.changes) refresh();
  item = picker.items.find(item => item.projectId === 'b');
  assert.equal(item.buttons.length, 2); assert.doesNotMatch(item.description, /运行中/);
  picker.emit('Hide'); await pending;
});

test('creation receives search as a name suggestion and rename reveals a formerly matching project', async () => {
  const f = fixture(); f.actions.create = async query => { f.calls.push(query); return { created: true }; };
  let pending = f.manager.show(), picker = f.pickers[0];
  picker.value = 'My project'; picker.emit('TriggerButton', picker.buttons[0]); await pending;
  assert.deepEqual(f.calls, ['My project']);
  f.projects[0].name = 'Unique title';
  pending = f.manager.show(); picker = f.pickers[1]; picker.value = 'Unique';
  const item = picker.items.find(item => item.projectId === 'a');
  picker.emit('TriggerItemButton', { item, button: item.buttons[0] }); await turn();
  assert.equal(f.pickers[2].value, ''); assert.equal(f.pickers[2].activeItems[0].projectId, 'a');
  f.pickers[2].emit('Hide'); await pending;
});

test('refresh failures dispose the picker and allow a clean retry', async () => {
  const f = fixture(), pending = f.manager.show(), picker = f.pickers[0];
  const original = f.sessions.projects;
  f.sessions.projects = () => { throw new Error('refresh failed'); };
  const rejected = assert.rejects(pending, /refresh failed/);
  for (const refresh of [...f.changes]) refresh();
  await rejected; assert.equal(picker.disposed, true); assert.equal(f.changes.size, 0);
  f.sessions.projects = original;
  const retry = f.manager.show(); f.pickers[1].emit('Hide'); await retry;
  assert.equal(f.changes.size, 0);
});

test('disposing during an awaited action never reopens the manager', async () => {
  const f = fixture(); let complete;
  f.actions.create = () => new Promise(resolve => { complete = resolve; });
  const pending = f.manager.show(), picker = f.pickers[0];
  picker.emit('TriggerButton', picker.buttons[0]); await turn();
  f.manager.dispose(); complete(undefined); await pending;
  assert.equal(f.pickers.length, 1); assert.equal(f.changes.size, 0);
});
