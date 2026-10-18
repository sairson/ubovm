import test from 'node:test';
import assert from 'node:assert/strict';
import { createAskHumanTool, normalizeAskHumanInput, ASK_HUMAN_LIMITS } from '../index.mjs';
import { createInternalTools } from '../../index.mjs';

const base = { question: 'Which target should I use?', options: [{ label: 'dev' }, { label: 'prod', description: 'live traffic' }] };

test('ask_human forwards a normalized request and returns the selected labels', async () => {
  const calls = [];
  const tool = createAskHumanTool({ askHuman: async request => { calls.push(request); return { selected: ['prod'], custom: 'after hours', cancelled: false }; }, sessionId: 'session', workerId: 'worker' });
  const result = await tool.execute('call', { ...base, multiple: true, allow_custom: true });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { question: base.question, options: [{ label: 'dev' }, { label: 'prod', description: 'live traffic' }], multiple: true, allowCustom: true, sessionId: 'session', workerId: 'worker', signal: undefined });
  assert.deepEqual(result.details, { question: base.question, selected: ['prod'], custom: 'after hours', cancelled: false });
  assert.match(result.content[0].text, /prod/);
  assert.match(result.content[0].text, /after hours/);
});

test('ask_human defaults to a single choice and a custom answer, and reports cancellation', async () => {
  let seen;
  const tool = createAskHumanTool({ askHuman: async request => { seen = request; return { selected: [], custom: '', cancelled: true }; } });
  const result = await tool.execute('call', base);
  assert.equal(seen.multiple, false);
  assert.equal(seen.allowCustom, true);
  assert.equal(result.details.cancelled, true);
  assert.match(result.content[0].text, /没有得到回答/);
});

test('ask_human drops labels the host never offered', async () => {
  const tool = createAskHumanTool({ askHuman: async () => ({ selected: ['dev', 'injected'], custom: '', cancelled: false }) });
  const result = await tool.execute('call', base);
  assert.deepEqual(result.details.selected, ['dev']);
});

test('ask_human requires a working host hook and a usable answer', async () => {
  const tool = createAskHumanTool({});
  await assert.rejects(tool.execute('call', base), /人工问答界面不可用/);
  const broken = createAskHumanTool({ askHuman: async () => null });
  await assert.rejects(broken.execute('call', base), /无效结果/);
});

test('ask_human answers progressive help before contacting the host', async () => {
  let called = false;
  const tool = createAskHumanTool({ askHuman: async () => { called = true; return { selected: [], custom: '', cancelled: true }; } });
  const result = await tool.execute('call', { help: true, help_topic: 'limits' });
  assert.equal(called, false);
  const payload = JSON.parse(result.content[0].text);
  assert.equal(payload.topic, 'limits');
});

test('ask_human guidance steers the agent to act before asking', async () => {
  const { ASK_HUMAN_CATALOG } = await import('../../shared/tool-catalogs.mjs');
  assert.match(ASK_HUMAN_CATALOG.description, /只在用户本人才能决定/);
  assert.match(ASK_HUMAN_CATALOG.description, /默认先按最合理的解释动手/);
  assert.match(ASK_HUMAN_CATALOG.description, /在你能自行评估的方案之间让用户挑选/);
});

test('ask_human input validation rejects malformed options and unknown fields', () => {
  assert.throws(() => normalizeAskHumanInput({ ...base, options: [] }), /1 to 8 options/);
  assert.throws(() => normalizeAskHumanInput({ ...base, options: Array.from({ length: ASK_HUMAN_LIMITS.maxOptions + 1 }, (_, i) => ({ label: 'o' + i })) }), /1 to 8 options/);
  assert.throws(() => normalizeAskHumanInput({ ...base, options: [{ label: 'x' }, { label: 'x' }] }), /Duplicate/);
  assert.throws(() => normalizeAskHumanInput({ ...base, extra: true }), /Unknown ask_human field/);
  assert.throws(() => normalizeAskHumanInput({ options: base.options }), /question/);
});

test('ask_human is a host-interaction tool: it needs both the hook and an explicit allowlist entry', async () => {
  const { INTERNAL_TOOL_NAMES, HOST_INTERACTION_TOOL_NAMES } = await import('../../index.mjs');
  assert.equal(INTERNAL_TOOL_NAMES.includes('ask_human'), false, 'autonomous (goal) sessions must not carry ask_human');
  assert.deepEqual([...HOST_INTERACTION_TOOL_NAMES], ['ask_human']);

  const runtime = await createInternalTools({ sessionId: 'ask-session', allowedTools: ['ask_human'], knowledge: false,
    askHuman: async () => ({ selected: ['dev'], custom: '', cancelled: false }) });
  try {
    const tools = await runtime.forWorker('worker');
    const tool = tools.find(item => item.name === 'ask_human');
    assert.ok(tool, 'ask_human should be available when the host provides askHuman and allows it');
    const result = await tool.execute('call', base);
    assert.deepEqual(result.details.selected, ['dev']);
  } finally { await runtime.close(); }

  const without = await createInternalTools({ sessionId: 'no-ask-session', allowedTools: ['ask_human'], knowledge: false });
  try {
    const tools = await without.forWorker('worker');
    assert.equal(tools.some(item => item.name === 'ask_human'), false, 'no host hook means no ask_human');
  } finally { await without.close(); }

  // A goal session never enables ask_human: the default allowlist has no entry,
  // so even an accidental host hook cannot surface the tool.
  const defaulted = await createInternalTools({ sessionId: 'default-ask-session', knowledge: false,
    askHuman: async () => ({ selected: ['dev'], custom: '', cancelled: false }) });
  try {
    const tools = await defaulted.forWorker('worker');
    assert.equal(tools.some(item => item.name === 'ask_human'), false, 'the built-in allowlist excludes host-interaction tools');
  } finally { await defaulted.close(); }
});
