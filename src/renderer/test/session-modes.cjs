'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createSessions } = require('../harness/sessions.cjs');
const fs = require('node:fs/promises');
const path = require('node:path');
const { tmpdir } = require('node:os');
const { createDefaultWorkspace } = require('../harness/default-workspace.cjs');

test('default workspaces are created, isolated, restored and preserve selected directories', async t => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'ubovm-workspaces-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const options = { createWorkspace: id => createDefaultWorkspace(id, root) };
  const f = harness({}, options); await f.store.ready;
  const first = f.store.current();
  assert.equal(first.workspace, path.join(root, first.id));
  assert((await fs.stat(first.workspace)).isDirectory());
  await fs.writeFile(path.join(first.workspace, 'keep.txt'), 'retained');
  const second = await f.store.create();
  assert.notEqual(second.workspace, first.workspace);
  assert((await fs.stat(second.workspace)).isDirectory());
  const goal = await f.store.setMode('goal');
  assert.notEqual(goal.workspace, second.workspace);
  assert((await fs.stat(goal.workspace)).isDirectory());
  const selected = path.join(root, 'selected');
  await f.store.setWorkspace(selected);
  const reopened = harness(Object.fromEntries(f.persisted), options); await reopened.store.ready;
  assert.equal(reopened.store.current().workspace, selected);
  await reopened.store.setMode('assist');
  await reopened.store.select(first.id);
  assert.equal(reopened.store.current().workspace, first.workspace);
  assert.equal(await fs.readFile(path.join(first.workspace, 'keep.txt'), 'utf8'), 'retained');
  await reopened.store.remove(first.id);
  const replacement = await reopened.store.remove(second.id);
  assert((await fs.stat(replacement.workspace)).isDirectory());
  const legacy = harness({ conversations: { version: 3, activeMode: 'assist', currentIds: { assist: '../../legacy' },
    sessions: [{ id: '../../legacy', mode: 'assist', messages: [] }] } }, options);
  await legacy.store.ready;
  assert.equal(path.dirname(legacy.store.current().workspace), root);
  assert((await fs.stat(legacy.store.current().workspace)).isDirectory());
});

test('workspace creation failure does not publish or persist a partial session', async () => {
  let fail = false;
  const f = harness({}, { createWorkspace: async id => { if (fail) throw Error('mkdir failed'); return '/workspace/' + id; } });
  await f.store.ready;
  const before = f.store.current();
  const persisted = structuredClone(f.persisted.get('conversations'));
  const publications = f.publications.length;
  fail = true;
  await assert.rejects(f.store.create(), /mkdir failed/);
  assert.deepEqual(f.store.current(), before);
  assert.deepEqual(f.persisted.get('conversations'), persisted);
  assert.equal(f.publications.length, publications);
});

test('workspaces belong to individual sessions in both modes and survive reload', async () => {
  const f = harness(); await f.store.ready;
  const first = f.store.current().id;
  await f.store.setWorkspace('C:\\project-a', first);
  const second = (await f.store.create()).id;
  assert.equal(f.store.current().workspace, undefined);
  await f.store.setWorkspace('C:\\project-b', second);
  await f.store.setMode('goal');
  const goalId = f.store.current().id;
  await f.store.setWorkspace('C:\\project-c', goalId);
  await assert.rejects(f.store.setWorkspace('C:\\wrong', first), /会话已切换/);
  await assert.rejects(f.store.setWorkspace('', goalId), /工作空间/);
  const reopened = harness(Object.fromEntries(f.persisted)); await reopened.store.ready;
  assert.equal(reopened.store.get(first).workspace, 'C:\\project-a');
  assert.equal(reopened.store.get(second).workspace, 'C:\\project-b');
  assert.equal(reopened.store.current().workspace, 'C:\\project-c');
  f.failNext();
  await assert.rejects(f.store.setWorkspace('C:\\failed', goalId), /storage failure/);
  assert.equal(f.store.current().workspace, 'C:\\project-c');
});

test('running sessions cannot change their workspace', async () => {
  let busy = false;
  const f = harness({}, { isBusy: () => busy }); await f.store.ready;
  await f.store.setWorkspace('C:\\project'); busy = true;
  await assert.rejects(f.store.setWorkspace('C:\\other'), /停止/);
  assert.equal(f.store.current().workspace, 'C:\\project');
});

function harness(initial = {}, options) {
  const persisted = new Map(Object.entries(initial));
  const publications = [];
  const events = [];
  let failure;
  let held;
  const vscode = {
    EventEmitter: class {
      event() { return { dispose() {} }; }
      fire(value) { events.push(value); }
      dispose() {}
    },
    TreeItem: class { constructor(label) { this.label = label; } },
    ThemeIcon: class { constructor(id) { this.id = id; } },
    TreeItemCollapsibleState: { None: 0 }
  };
  const context = {
    workspaceState: {
      get(key, fallback) { return persisted.has(key) ? persisted.get(key) : fallback; },
      async update(key, value) {
        if (failure) {
          const error = failure;
          failure = undefined;
          throw error;
        }
        if (held) {
          const gate = held;
          held = undefined;
          gate.enter();
          await gate.wait;
        }
        persisted.set(key, structuredClone(value));
      }
    }
  };
  const store = createSessions(vscode, context, value => publications.push(value), options);
  return {
    store, persisted, publications, events,
    failNext() { failure = new Error('Simulated storage failure'); },
    holdNext() {
      let enter;
      let release;
      const entered = new Promise(resolve => { enter = resolve; });
      const wait = new Promise(resolve => { release = resolve; });
      held = { enter, wait };
      return { entered, release };
    }
  };
}

const user = text => ({ role: 'user', text });

test('deleting current and background conversations preserves the other mode and survives reload', async () => {
  const f = harness(); await f.store.ready;
  await f.store.saveMessages([user('first')]); const first = f.store.current().id;
  await f.store.create(); const second = f.store.current().id;
  await f.store.setMode('goal'); await f.store.saveGoal({ objective: 'keep this goal', criteria: [] }); const goal = f.store.current().id;
  await f.store.setMode('assist'); await f.store.remove(first);
  assert.equal(f.store.current().id, second); assert.equal(f.store.get(first), undefined);
  await f.store.remove(second);
  assert.equal(f.store.current().mode, 'assist'); assert.notEqual(f.store.current().id, second);
  assert.equal(f.store.current().placeholder, true); assert.deepEqual(f.store.history(), []);
  assert.equal(f.store.get(goal).goal.objective, 'keep this goal');
  assert(!f.store.ids().includes(first)); assert(!f.store.ids().includes(second));
  const reloaded = harness(Object.fromEntries(f.persisted)); await reloaded.store.ready;
  assert.deepEqual(reloaded.store.ids(), f.store.ids()); assert.deepEqual(reloaded.store.history(), []);
  await reloaded.store.setMode('goal'); assert.equal(reloaded.store.current().id, goal);
  await reloaded.store.remove(goal); assert.equal(reloaded.store.current().mode, 'goal'); assert.deepEqual(reloaded.store.history(), []);
  await assert.rejects(reloaded.store.appendMessage(goal, { role: 'assistant', text: 'late reply' }), /已不存在/);
});

test('deleting the selected conversation switches to an existing same-mode conversation', async () => {
  const { store } = harness(); await store.ready;
  await store.saveMessages([user('keep')]); const keep = store.current().id;
  await store.create(); await store.remove(store.current().id);
  assert.equal(store.current().id, keep); assert.deepEqual(store.current().messages, [user('keep')]);
  await store.setMode('goal'); const goal = store.current().id;
  await store.remove(keep); assert.equal(store.current().id, goal);
  assert.deepEqual(store.list('assist'), []);
  await store.setMode('assist'); assert.equal(store.current().placeholder, true);
});

test('failed deletion and running-conversation deletion leave persisted and published state intact', async () => {
  const running = new Set(), f = harness({}, { isBusy: id => running.has(id) }); await f.store.ready;
  await f.store.saveMessages([user('retain on failure')]); const id = f.store.current().id;
  const before = structuredClone(f.persisted.get('conversations')), count = f.publications.length;
  f.failNext(); await assert.rejects(f.store.remove(id), /storage failure/);
  assert.deepEqual(f.persisted.get('conversations'), before); assert.equal(f.store.current().id, id); assert.equal(f.publications.length, count);
  running.add(id); await assert.rejects(f.store.remove(id), /先停止/);
  assert.deepEqual(f.persisted.get('conversations'), before); assert.equal(f.publications.length, count);
  running.delete(id); await f.store.remove(id); await assert.rejects(f.store.remove(id), /已不存在/);
});

test('lightweight summaries track committed mode and history without exposing message data', async () => {
  const { store, failNext } = harness();
  await store.ready;
  const id = store.current().id;
  assert.deepEqual(store.summary(), { id, title: '新对话', mode: 'assist', historyCount: 0 });
  await store.saveMessages([user('历史标题')]);
  const summary = store.summary();
  assert.deepEqual(summary, { id, title: '历史标题', mode: 'assist', historyCount: 1 });
  summary.title = '外部修改';
  assert.equal(store.summary().title, '历史标题');
  failNext();
  await assert.rejects(store.create());
  assert.equal(store.summary().historyCount, 1);
  await store.create();
  assert.equal(store.summary().historyCount, 2);
  await store.setMode('goal');
  assert.equal(store.summary().mode, 'goal');
  assert.equal(store.summary().historyCount, 0);
  await store.setMode('assist');
  assert.equal(store.summary().historyCount, 2);
});

test('fresh spaces show welcome content until the first message or saved goal, without losing the draft identity', async () => {
  const { store, persisted } = harness();
  await store.ready;
  const assistId = store.current().id;
  assert.deepEqual(store.provider.getChildren(), []);
  assert.deepEqual(store.search(''), []);
  const reopened = harness({ conversations: structuredClone(persisted.get('conversations')) });
  await reopened.store.ready;
  assert.equal(reopened.store.current().id, assistId);
  assert.deepEqual(reopened.store.history(), []);
  await store.saveMessages([user('第一条消息')]);
  assert.equal(store.provider.getChildren()[0].id, assistId);
  await store.setMode('goal');
  const goalId = store.current().id;
  assert.deepEqual(store.provider.getChildren(), []);
  await store.saveGoal({ objective: '第一个目标', criteria: [] });
  assert.equal(store.provider.getChildren()[0].id, goalId);
  await store.create();
  assert.equal(store.history().length, 2, 'Explicitly created sessions remain selectable before sending.');
  await store.setMode('assist');
  assert.equal(store.current().id, assistId);
  assert.equal(store.history().length, 1);
});

test('search matches content in the active mode without changing selection or stored data', async () => {
  const { store, persisted } = harness();
  await store.ready;
  await store.saveMessages([user('项目介绍'), { role: 'assistant', text: 'UniqueBody Token ＡＢＣ' }]);
  const first = store.current();
  await store.create();
  const second = store.current();
  const before = structuredClone(persisted.get('conversations'));
  assert.deepEqual(store.search('uniquebody abc').map(item => item.id), [first.id]);
  assert.deepEqual(store.search('项目').map(item => item.id), [first.id]);
  assert.deepEqual(store.search('does-not-exist'), []);
  assert.equal(store.search('   ').length, 2);
  store.search('token')[0].messages[0].text = '外部修改';
  assert.equal(store.current().id, second.id);
  assert.deepEqual(persisted.get('conversations'), before);
  await store.setMode('goal');
  await store.saveGoal({ objective: '目标文本', criteria: [{ text: '验收词' }] });
  await store.addGoalNote('专属笔记');
  assert.deepEqual(store.search('UniqueBody'), []);
  for (const query of ['目标文本', '验收词', '专属笔记']) assert.equal(store.search(query)[0].id, store.current().id);
  await store.setMode('assist');
  assert.deepEqual(store.search('专属笔记'), []);
  assert.equal(store.current().id, second.id);
});

test('legacy single-conversation data migrates to assist without losing its messages', async () => {
  const messages = [user('保留旧聊天'), { role: 'assistant', text: '原始回复' }];
  const { store, persisted } = harness({ conversation: messages });
  await store.ready;
  assert.equal(store.current().mode, 'assist');
  assert.equal(store.current().goal, null);
  assert.deepEqual(store.current().messages, messages);
  assert.equal(store.current().title, '保留旧聊天');
  assert.equal(persisted.get('conversations').version, 3);
  assert.equal(store.activeMode(), 'assist');
  assert.deepEqual(store.list('goal'), []);
  assert.deepEqual(persisted.get('conversation'), messages);
});

test('previous session-list format keeps the active session, titles and order', async () => {
  const old = {
    version: 1, currentId: 'second', sessions: [
      { id: 'first', title: '第一条', messages: [user('一')], createdAt: 1, updatedAt: 2 },
      { id: 'second', title: '第二条', messages: [user('二')], createdAt: 3, updatedAt: 4 }
    ]
  };
  const { store } = harness({ conversations: old });
  await store.ready;
  assert.equal(store.current().id, 'second');
  assert.deepEqual(store.list().map(item => item.id), ['first', 'second']);
  assert.ok(store.list().every(item => item.mode === 'assist' && item.goal === null));
  assert.deepEqual(store.list().map(item => item.title), ['第一条', '第二条']);
  assert.equal(store.current().createdAt, 3);
});

test('v2 mixed sessions split chat from goals, preserving notes, progress and old draft identifiers', async () => {
  const goal = objective => ({
    objective,
    criteria: [{ id: `criterion-${objective}`, text: '已经手工确认', done: true }],
    notes: [{ id: `note-${objective}`, text: '不能丢失的原始记录', createdAt: 12 }],
    createdAt: 10, updatedAt: 13
  });
  const old = {
    version: 2, currentId: 'mixed-goal', sessions: [
      { id: 'mixed-goal', mode: 'goal', title: '混合会话', messages: [user('旧讨论')], goal: goal('目标一'), createdAt: 1, updatedAt: 2 },
      { id: 'mixed-assist', mode: 'assist', title: '已切回协助', messages: [user('另一段讨论')], goal: goal('目标二'), createdAt: 3, updatedAt: 4 },
      { id: 'goal-only', mode: 'goal', title: '只有目标', messages: [], goal: goal('目标三'), createdAt: 5, updatedAt: 6 },
      { id: 'unsaved-draft', mode: 'goal', title: '还有本地草稿', messages: [user('草稿之前的讨论')], goal: null, createdAt: 7, updatedAt: 8 }
    ]
  };
  const untouched = structuredClone(old);
  const { store, persisted } = harness({ conversations: old });
  await store.ready;
  assert.deepEqual(old, untouched, 'Migration must not mutate its source.');
  const assists = store.list('assist');
  const goals = store.list('goal');
  assert.deepEqual(assists.map(item => item.id), ['mixed-goal', 'mixed-assist', 'unsaved-draft']);
  assert.ok(assists.every(item => item.mode === 'assist' && item.goal === null));
  assert.deepEqual(assists[0].messages, old.sessions[0].messages);
  assert.deepEqual(assists[1].messages, old.sessions[1].messages);
  assert.deepEqual(assists[2].messages, old.sessions[3].messages);
  assert.equal(goals.length, 4);
  assert.equal(new Set([...assists, ...goals].map(item => item.id)).size, 7);
  for (const source of old.sessions) {
    const migrated = goals.find(item => item.legacyDraftId === source.id);
    assert.ok(migrated, `A goal/draft must remain associated with ${source.id}.`);
    assert.deepEqual(migrated.goal, source.goal ? { ...source.goal, initialFacts: '' } : source.goal);
    assert.deepEqual(migrated.messages, []);
    assert.equal(migrated.mode, 'goal');
    if (source.id === 'goal-only') assert.equal(migrated.id, source.id);
    else assert.notEqual(migrated.id, source.id);
  }
  assert.equal(store.activeMode(), 'goal');
  const selectedGoal = store.current();
  assert.equal(selectedGoal.legacyDraftId, 'mixed-goal');
  assert.equal(selectedGoal.title, '目标一');
  assert.equal((await store.setMode('assist')).id, 'mixed-goal');
  assert.deepEqual(await store.setMode('goal'), selectedGoal);
  const reloaded = harness({ conversations: structuredClone(persisted.get('conversations')) });
  await reloaded.store.ready;
  assert.deepEqual(reloaded.store.list('assist'), assists);
  assert.deepEqual(reloaded.store.list('goal'), goals, 'Reloading v3 must not split already-independent goal discussions again.');
});

test('modes have independent lists and remember their last selected sessions without mutating content', async () => {
  const { store } = harness();
  await store.ready;
  await store.saveMessages([user('协助中的讨论')]);
  const assistFirst = store.current();
  const assistSecond = await store.create();
  await store.select(assistFirst.id);
  const goalFirst = await store.setMode('goal', assistFirst.id);
  assert.notEqual(goalFirst.id, assistFirst.id);
  assert.deepEqual(goalFirst.messages, []);
  await store.saveGoal({ objective: '一个独立的目标', criteria: [{ text: '能够启动' }] }, goalFirst.id);
  await store.addGoalNote('手工记录的验证结果', goalFirst.id);
  await store.toggleGoalCriterion(store.current().goal.criteria[0].id, true, goalFirst.id);
  await store.saveMessages([user('仅属于目标的讨论')]);
  const goalSaved = store.current();
  const goalSecond = await store.create();
  assert.equal(goalSecond.mode, 'goal');
  assert.equal(goalSecond.goal, null);
  await store.select(goalFirst.id);

  assert.deepEqual(store.list().map(item => item.id), [goalSecond.id, goalFirst.id]);
  assert.deepEqual(store.provider.getChildren().map(item => item.id), [goalSecond.id, goalFirst.id]);
  assert.ok(store.list('assist').every(item => item.mode === 'assist' && item.goal === null));
  assert.equal(store.activeMode(), 'goal', 'Reading another list must not switch modes.');
  await assert.rejects(store.select(assistSecond.id), /切换.*模式/);
  await assert.rejects(store.create('assist'), /切换模式/);
  assert.equal(store.current().id, goalFirst.id);

  const allBefore = [store.list('assist'), store.list('goal')];
  assert.deepEqual(await store.setMode('assist', goalFirst.id), assistFirst);
  assert.deepEqual(store.provider.getChildren(), store.list('assist'));
  await store.select(assistSecond.id);
  assert.deepEqual(await store.setMode('goal', assistSecond.id), goalSaved);
  assert.deepEqual(await store.setMode('assist', goalFirst.id), assistSecond);
  assert.deepEqual([store.list('assist'), store.list('goal')], allBefore);

  await store.setMode('goal');
  const treeItem = store.provider.getTreeItem(store.list().find(item => item.id === goalSecond.id));
  assert.equal(treeItem.iconPath.id, 'target');
  assert.match(treeItem.tooltip, /探索模式/);
  assert.match(treeItem.accessibilityInformation.label, /探索模式/);
  const activeItem = store.provider.getTreeItem(store.current());
  assert.equal(activeItem.iconPath.id, 'circle-filled');
  assert.match(activeItem.tooltip, /探索模式/);
});

test('initial facts persist independently, survive legacy edits, and can be cleared', async () => {
  const f = harness();
  await f.store.ready;
  await f.store.setMode('goal');
  await f.store.saveGoal({ objective: '预期结果', initialFacts: '  已有框架\n本地存储  ', criteria: [] });
  assert.equal(f.store.current().goal.initialFacts, '已有框架\n本地存储');
  const restored = harness(Object.fromEntries(f.persisted));
  await restored.store.ready;
  assert.equal(restored.store.current().goal.initialFacts, '已有框架\n本地存储');
  await f.store.saveGoal({ objective: '更新结果', criteria: [] });
  assert.equal(f.store.current().goal.initialFacts, '已有框架\n本地存储');
  await assert.rejects(f.store.saveGoal({ objective: '结果', initialFacts: '字'.repeat(8001) }), /8000/);
  await f.store.saveGoal({ objective: '结果', initialFacts: '', criteria: [] });
  assert.equal(f.store.current().goal.initialFacts, '');
});

test('goal edits retain completion only for the same criterion ID and text', async () => {
  const { store } = harness();
  await store.ready;
  await store.setMode('goal');
  await store.saveGoal({ objective: '第一行目标\n补充说明', criteria: [{ text: '标准 A' }, { text: '标准 B' }] });
  assert.equal(store.current().title, '第一行目标');
  const [a, b] = store.current().goal.criteria;
  await store.toggleGoalCriterion(a.id, true);
  await store.toggleGoalCriterion(b.id, true);
  await store.addGoalNote('保留这条备注');
  const before = store.current().goal;
  const edited = await store.saveGoal({
    objective: '更新探索',
    criteria: [{ id: a.id, text: '标准 A' }, { id: b.id, text: '标准 B 已修改' }, { text: '新增标准' }]
  });
  assert.deepEqual(edited.goal.criteria.map(item => item.done), [true, false, false]);
  assert.deepEqual(edited.goal.notes, before.notes);
  assert.equal(edited.goal.createdAt, before.createdAt);
  assert.equal(new Set(edited.goal.criteria.map(item => item.id)).size, 3);

  const replaced = await store.saveGoal({ objective: '更新探索', criteria: [{ text: '标准 A' }] });
  assert.equal(replaced.goal.criteria[0].done, false);
  assert.notEqual(replaced.goal.criteria[0].id, a.id);
});

test('goal titles follow the objective independently of goal discussion messages', async () => {
  const { store } = harness();
  await store.ready;
  const empty = await store.setMode('goal');
  assert.equal(empty.title, '新探索');
  await store.saveGoal({ objective: '原目标\n详细说明', criteria: [] });
  await store.saveMessages([user('第一条独立目标指令')]);
  assert.equal(store.current().title, '原目标');
  await store.saveGoal({ objective: '更新后的目标\n更多说明', criteria: [] });
  assert.equal(store.current().title, '更新后的目标');
  assert.deepEqual(store.current().messages, [user('第一条独立目标指令')]);
  await store.saveMessages(Array.from({ length: 45 }, (_, index) => user(`目标指令 ${index}`)));
  assert.equal(store.current().title, '更新后的目标');
  assert.equal(store.current().messages.length, 40);
});

test('goal writes require the goal space and stale queued writes cannot affect another session or mode', async () => {
  const { store } = harness();
  await store.ready;
  const assist = store.current();
  await assert.rejects(store.saveGoal({ objective: '禁止写到协助会话', criteria: [] }), /仅可在探索模式/);
  await assert.rejects(store.addGoalNote('禁止写到协助会话'), /仅可在探索模式/);
  await assert.rejects(store.toggleGoalCriterion('missing', true), /仅可在探索模式/);
  const firstId = (await store.setMode('goal', assist.id)).id;
  await store.saveGoal({ objective: '会话一', criteria: [{ text: '标准一' }] }, firstId);
  const first = store.current();
  const second = await store.create();
  await store.saveMessages([user('会话二的消息')]);
  await store.saveGoal({ objective: '会话二', criteria: [{ text: '标准二' }] }, second.id);
  await store.select(firstId);

  const switching = store.select(second.id);
  const stale = store.addGoalNote('不得写入会话二', firstId);
  await switching;
  await assert.rejects(stale, /会话已切换/);
  const before = store.list();
  await assert.rejects(store.setMode('assist', firstId), /会话已切换/);
  await assert.rejects(store.saveGoal({ objective: '过期编辑', criteria: [] }, firstId), /会话已切换/);
  await assert.rejects(store.toggleGoalCriterion(first.goal.criteria[0].id, true, firstId), /会话已切换/);
  assert.deepEqual(store.list(), before);
  assert.deepEqual(store.list().find(item => item.id === firstId), first);
  assert.equal(store.current().mode, 'goal');
  assert.deepEqual(store.current().messages, [user('会话二的消息')]);

  const changingMode = store.setMode('assist', second.id);
  const staleGoalSave = store.saveGoal({ objective: '过期目标页面', criteria: [] }, second.id);
  await changingMode;
  await assert.rejects(staleGoalSave, /会话已切换/);
  assert.deepEqual(store.current(), assist);
  assert.deepEqual(store.list('goal'), before);
});

test('writes publish only after persistence and a storage failure leaves all visible state unchanged', async () => {
  const fixture = harness();
  const { store, publications, events } = fixture;
  await store.ready;
  await store.setMode('goal');
  await store.saveGoal({ objective: '持久化验证', criteria: [{ text: '已完成检查' }] });
  const before = store.current();
  const publicationCount = publications.length;
  const eventCount = events.length;
  const gate = fixture.holdNext();
  const pending = store.toggleGoalCriterion(before.goal.criteria[0].id, true);
  await gate.entered;
  assert.deepEqual(store.current(), before);
  assert.equal(publications.length, publicationCount);
  assert.equal(events.length, eventCount);
  gate.release();
  await pending;
  assert.equal(store.current().goal.criteria[0].done, true);
  assert.equal(publications.length, publicationCount + 1);

  const saved = store.list();
  fixture.failNext();
  await assert.rejects(store.saveGoal({ objective: '不应暴露的内容', criteria: [] }), /storage failure/);
  assert.deepEqual(store.list(), saved);
  assert.equal(publications.length, publicationCount + 1);
  assert.equal(events.length, eventCount + 1);
  await store.addGoalNote('失败后仍可继续保存');
  assert.equal(store.current().goal.notes[0].text, '失败后仍可继续保存');
});

test('mode switches and queued creation publish atomically and failed switches create no orphan session', async () => {
  const fixture = harness();
  const { store, persisted, publications, events } = fixture;
  await store.ready;
  await store.saveMessages([user('留在协助页面')]);
  const assist = store.current();
  const saved = structuredClone(persisted.get('conversations'));
  const eventCount = events.length;
  fixture.failNext();
  await assert.rejects(store.setMode('goal', assist.id), /storage failure/);
  assert.equal(store.activeMode(), 'assist');
  assert.deepEqual(store.current(), assist);
  assert.deepEqual(store.list('goal'), []);
  assert.deepEqual(persisted.get('conversations'), saved);
  assert.equal(events.length, eventCount);

  const gate = fixture.holdNext();
  const switching = store.setMode('goal', assist.id);
  const creating = store.create();
  await gate.entered;
  assert.equal(store.activeMode(), 'assist');
  assert.deepEqual(store.provider.getChildren(), [assist]);
  assert.deepEqual(store.list('goal'), []);
  gate.release();
  const firstGoal = await switching;
  const secondGoal = await creating;
  assert.equal(firstGoal.mode, 'goal');
  assert.equal(secondGoal.mode, 'goal');
  assert.notEqual(secondGoal.id, firstGoal.id);
  assert.equal(store.current().id, secondGoal.id);
  assert.deepEqual(store.list().map(item => item.id), [secondGoal.id, firstGoal.id]);
  assert.deepEqual(store.list('assist'), [assist]);
  assert.deepEqual(publications.slice(-2).map(item => item.id), [firstGoal.id, secondGoal.id]);

  await store.setMode('assist');
  const beforeFailedReturn = structuredClone(persisted.get('conversations'));
  fixture.failNext();
  await assert.rejects(store.setMode('goal'), /storage failure/);
  assert.equal(store.current().id, assist.id);
  assert.deepEqual(persisted.get('conversations'), beforeFailedReturn);
  assert.equal((await store.setMode('goal')).id, secondGoal.id);
});

test('restoration, snapshots, publications and queued input do not share editable nested objects', async () => {
  const seed = {
    version: 3, activeMode: 'goal', currentIds: { assist: null, goal: 'seed' }, sessions: [{
      id: 'seed', title: '隔离副本', mode: 'goal', messages: [user('原消息')], createdAt: 1, updatedAt: 2,
      goal: { objective: '原目标', criteria: [{ id: 'c1', text: '原标准', done: true }], notes: [{ id: 'n1', text: '原备注', createdAt: 3 }], createdAt: 4, updatedAt: 5 }
    }]
  };
  const { store, publications, persisted } = harness({ conversations: seed });
  await store.ready;
  const expected = store.current();
  seed.sessions[0].goal.criteria[0].done = false;
  seed.sessions[0].goal.notes[0].text = '改动外部原数据';
  seed.sessions[0].messages[0].text = '改动外部消息';
  seed.currentIds.goal = 'invalid';
  for (const copy of [store.current(), store.list()[0], publications[0], persisted.get('conversations').sessions[0]]) {
    copy.messages[0].text = '改动消息';
    copy.goal.criteria[0].text = '改动标准';
    copy.goal.notes[0].text = '改动备注';
  }
  persisted.get('conversations').currentIds.goal = 'invalid';
  assert.deepEqual(store.current(), expected);

  const draft = { objective: '提交时的目标', criteria: [{ text: '提交时的标准' }] };
  const pending = store.saveGoal(draft);
  draft.objective = '提交后的外部改动';
  draft.criteria[0].text = '提交后的标准改动';
  await pending;
  assert.equal(store.current().goal.objective, '提交时的目标');
  assert.equal(store.current().goal.criteria[0].text, '提交时的标准');
});

test('reload restores current mode, goal progress, notes and messages', async () => {
  const original = harness();
  await original.store.ready;
  await original.store.saveMessages([user('协助会话')]);
  const assistSession = original.store.current();
  const goalSession = await original.store.setMode('goal');
  await original.store.saveGoal({ objective: '重载后继续检查', criteria: [{ text: '确认持久化' }] }, goalSession.id);
  await original.store.toggleGoalCriterion(original.store.current().goal.criteria[0].id, true, goalSession.id);
  await original.store.addGoalNote('由用户手工确认', goalSession.id);
  await original.store.saveMessages([user('探索会话的讨论')]);
  const current = original.store.current();
  const sessions = [original.store.list('assist'), original.store.list('goal')];
  original.store.dispose();
  const reloaded = harness({ conversations: structuredClone(original.persisted.get('conversations')) });
  await reloaded.store.ready;
  assert.deepEqual(reloaded.store.current(), current);
  assert.deepEqual([reloaded.store.list('assist'), reloaded.store.list('goal')], sessions);
  assert.equal(reloaded.store.activeMode(), 'goal');
  assert.deepEqual(await reloaded.store.setMode('assist'), assistSession);
  assert.deepEqual(await reloaded.store.setMode('goal'), current);
});

test('invalid modes, oversized drafts and duplicate criterion IDs do not partially persist', async () => {
  const { store, publications } = harness();
  await store.ready;
  await store.setMode('goal');
  await store.saveGoal({
    objective: '目'.repeat(4000),
    criteria: Array.from({ length: 20 }, (_, index) => ({ id: `criterion-${index}`, text: '标'.repeat(300) }))
  });
  await store.addGoalNote('记'.repeat(2000));
  const before = store.list();
  const count = publications.length;
  for (const operation of [
    () => store.setMode('automatic'),
    () => store.create('automatic'),
    () => store.saveGoal({ objective: '', criteria: [] }),
    () => store.saveGoal({ objective: '目'.repeat(4001), criteria: [] }),
    () => store.saveGoal({ objective: '目标', criteria: Array.from({ length: 21 }, () => ({ text: '标准' })) }),
    () => store.saveGoal({ objective: '目标', criteria: [{ text: '标'.repeat(301) }] }),
    () => store.saveGoal({ objective: '目标', criteria: [{ id: 'same', text: '甲' }, { id: 'same', text: '乙' }] }),
    () => store.toggleGoalCriterion('criterion-0', 'true'),
    () => store.toggleGoalCriterion('missing', true),
    () => store.addGoalNote('记'.repeat(2001))
  ]) {
    await assert.rejects(operation());
    assert.deepEqual(store.list(), before);
    assert.equal(publications.length, count);
  }
});

test('bounded history retains 50 notes and 40 messages with an independent 50-session allowance per mode', async () => {
  const { store, persisted } = harness();
  await store.ready;
  await store.saveMessages([user('另一模式的消息不能被目标列表挤掉')]);
  const assist = store.current();
  await store.setMode('goal');
  await store.saveGoal({ objective: '有界历史', criteria: [] });
  for (let index = 0; index < 51; index++) await store.addGoalNote(`备注 ${index}`);
  assert.equal(store.current().goal.notes.length, 50);
  assert.equal(store.current().goal.notes[0].text, '备注 1');
  assert.equal(store.current().goal.notes.at(-1).text, '备注 50');
  await store.saveMessages(Array.from({ length: 45 }, (_, index) => user(`消息 ${index}`)));
  assert.equal(store.current().messages.length, 40);
  assert.equal(store.current().messages[0].text, '消息 5');
  const oldestId = store.current().id;
  for (let index = 0; index < 50; index++) await store.create();
  assert.equal(store.list().length, 50);
  assert.ok(!store.list().some(item => item.id === oldestId));
  assert.deepEqual(store.list('assist'), [assist]);
  const goals = store.list();
  await store.setMode('assist');
  for (let index = 0; index < 49; index++) await store.create();
  assert.equal(store.list().length, 50);
  assert.deepEqual(store.list('goal'), goals);
  const reloaded = harness({ conversations: structuredClone(persisted.get('conversations')) });
  await reloaded.store.ready;
  assert.equal(reloaded.store.list('assist').length, 50);
  assert.equal(reloaded.store.list('goal').length, 50);
});
