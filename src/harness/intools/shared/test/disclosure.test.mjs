import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Type } from 'typebox';
import {
  buildHelpCatalog, withProgressiveDisclosure, withActionHelp, flagHelpProperties,
  isHelpRequest, helpTopicOf, stripHelpFields,
} from '../disclosure.mjs';
import {
  TODO_CATALOG, FETCH_CATALOG, LEARN_CAPABILITY_CATALOG, WORKSPACE_LIST_CATALOG,
  SPAWN_WORKER_CATALOG, MANAGE_WORKERS_CATALOG, HARNESS_PROJECT_CATALOG,
} from '../tool-catalogs.mjs';
import { createTodoTool } from '../../todo/index.mjs';
import { createSkillResourceTool } from '../../skills/resources.mjs';
import { MemoryStore } from '../store/memory-store.mjs';
import { createWorkspaceTools } from '../../../ide/workspace-tools.mjs';
import { createRunManager } from '../../../agents/collaboration/run-manager.mjs';
import { createHarnessProject } from '../../../agents/collaboration/harness-project.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('buildHelpCatalog defaults to core with next pointer', () => {
  const help = buildHelpCatalog({ ...TODO_CATALOG, tool: 'todo' });
  assert.equal(help.mode, 'help');
  assert.equal(help.topic, 'core');
  assert.ok(help.actions.some(item => item.action === 'write' && item.params));
  assert.equal(help.next.topic, 'manage');
});

test('buildHelpCatalog drills tier, action, and rejects unknown', () => {
  const tier = buildHelpCatalog({ ...LEARN_CAPABILITY_CATALOG, topic: 'library', tool: 'learn_capability' });
  assert.ok(tier.actions.some(item => item.action === 'publish'));
  const one = buildHelpCatalog({ ...FETCH_CATALOG, topic: 'url', tool: 'fetch_web_content' });
  assert.equal(one.action.action, 'url');
  const bad = buildHelpCatalog({ ...TODO_CATALOG, topic: 'nope', tool: 'todo' });
  assert.equal(bad.ok, false);
});

test('flag vs action help request detection', () => {
  assert.equal(isHelpRequest({ action: 'help' }, 'action'), true);
  assert.equal(isHelpRequest({ help: true }, 'flag'), true);
  assert.equal(isHelpRequest({ help: true }, 'action'), false);
  assert.equal(helpTopicOf({ action: 'help', topic: 'manage' }, 'action'), 'manage');
  assert.equal(helpTopicOf({ help: true, help_topic: 'filters' }, 'flag'), 'filters');
  assert.deepEqual(stripHelpFields({ help: true, help_topic: 'x', url: 'https://a' }, 'flag'), { url: 'https://a' });
});

test('withProgressiveDisclosure action mode serves help without execute', async () => {
  let ran = 0;
  const tool = withProgressiveDisclosure({
    name: 'todo',
    description: 'old',
    parameters: Type.Object(withActionHelp({}), { additionalProperties: false }),
    async execute() { ran++; return { content: [], details: {} }; }
  }, TODO_CATALOG);
  assert.match(tool.description, /action=help|Call action=help/i);
  const core = await tool.execute('1', { action: 'help' });
  assert.equal(ran, 0);
  assert.equal(core.details.mode, 'help');
  assert.equal(core.details.topic, 'core');
});

test('withProgressiveDisclosure flag mode serves help without execute', async () => {
  let ran = 0;
  const tool = withProgressiveDisclosure({
    name: 'fetch_web_content',
    description: 'old',
    parameters: Type.Object({ url: Type.Optional(Type.String()), ...flagHelpProperties() }, { additionalProperties: false }),
    async execute() { ran++; return { content: [], details: {} }; }
  }, { ...FETCH_CATALOG, mode: 'flag' });
  const help = await tool.execute('1', { help: true, help_topic: 'paginate' });
  assert.equal(ran, 0);
  assert.equal(help.details.topic, 'paginate');
  await tool.execute('2', { url: 'https://example.com' });
  assert.equal(ran, 1);
});

test('todo and skill resource tools expose progressive catalogs', async () => {
  const store = new MemoryStore({ sessionId: 'disclosure-todo' });
  const todo = createTodoTool({ store, sessionId: 'disclosure-todo', workerId: 'w1' });
  const help = await todo.execute('t', { action: 'help', topic: 'manage' });
  assert.ok(help.details.actions.some(item => item.action === 'update'));
  const skill = createSkillResourceTool({ cwd: process.cwd() });
  const skillHelp = await skill.execute('s', { help: true });
  assert.equal(skillHelp.details.mode, 'help');
  assert.match(skill.description, /help=true/);
});

test('workspace and collaboration tools serve help catalogs', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'disclosure-ws-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const [list] = await createWorkspaceTools([root]);
  assert.ok(list.description.includes(WORKSPACE_LIST_CATALOG.description.slice(0, 40)));
  const listHelp = await list.execute('1', { help: true });
  assert.equal(listHelp.details.mode, 'help');

  const runtime = createRunManager();
  const inspectHelp = await runtime.tool.execute('2', { help: true, help_topic: 'inspect' });
  assert.equal(inspectHelp.details.mode, 'help');
  assert.equal(inspectHelp.details.action?.action || inspectHelp.details.topic, 'inspect');

  const project = createHarnessProject();
  assert.match(project.tool.description, /action=help/i);
  const projectHelp = await project.tool.execute('3', { action: 'help' });
  assert.ok(projectHelp.details.actions.some(item => item.action === 'validate'));
  assert.ok(HARNESS_PROJECT_CATALOG.docs.some(doc => doc.action === 'define'));
  assert.ok(SPAWN_WORKER_CATALOG.description.includes('help=true'));
  assert.match(MANAGE_WORKERS_CATALOG.description, /action=help/);
  assert.ok(MANAGE_WORKERS_CATALOG.docs.some(doc => doc.action === 'prioritize'));
  assert.ok(MANAGE_WORKERS_CATALOG.docs.some(doc => doc.action === 'interrupt'));
});
