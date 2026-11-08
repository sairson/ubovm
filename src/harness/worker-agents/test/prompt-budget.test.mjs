import test from 'node:test';
import assert from 'node:assert/strict';
import { AssistantMessageEventStream } from '@earendil-works/pi-ai';
import { createPiWorker, evidenceLedger } from '../worker_pi_agent.mjs';
import { createWorkerCheckpoint } from '../checkpoint.mjs';
import { phasePrompt, workerSystemPrompt } from '../prompts.mjs';
import { IDE_CONTEXT } from '../../ide-context.mjs';
import { DEPLOYMENT_VERIFICATION_POLICY } from '../../deployment-policy.mjs';
import { RETRIEVAL_POLICY } from '../../retrieval-policy.mjs';
import { KNOWLEDGE_POLICY } from '../../learning/prompts.mjs';
import { LOCAL_SHELL_POLICY } from '../../intools/terminals/local-shell/index.mjs';

const ALL_TOOL_POLICIES = [LOCAL_SHELL_POLICY, KNOWLEDGE_POLICY, DEPLOYMENT_VERIFICATION_POLICY, RETRIEVAL_POLICY];
const model = { id: 'fixture', api: 'openai-completions', provider: 'fixture' };

function response(content, stopReason = 'stop') {
  const stream = new AssistantMessageEventStream();
  stream.push({ type: 'done', reason: stopReason, message: {
    role: 'assistant', content, stopReason, api: model.api, provider: model.provider, model: model.id, timestamp: 1,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }
  } });
  return stream;
}

const fixtureTools = [
  { name: 'inspect', description: 'I'.repeat(1200) },
  { name: 'write', description: 'W'.repeat(800) }
];
const fixtureState = {
  goal: 'verify deployment',
  plan: [{ description: 'inspect service', doneWhen: 'reachable' }],
  completed: [{ step: { description: 'checked host', doneWhen: 'output seen' }, output: 'host ok' }],
  barrierResult: 'B'.repeat(900)
};
const fixtureNode = { intent: { description: 'verify reachability', hint: 'use the IDE', priority: 2, keyPoints: ['reachable'] } };

test('worker system prompt sends tool policies only to phases that can call tools', () => {
  const execute = workerSystemPrompt('execute');
  for (const policy of ALL_TOOL_POLICIES) assert.ok(execute.includes(policy), 'execute keeps every tool policy');
  for (const phase of ['plan', 'replan']) {
    const prompt = workerSystemPrompt(phase);
    assert.ok(prompt.includes(IDE_CONTEXT), `${phase} keeps IDE context`);
    for (const policy of ALL_TOOL_POLICIES) assert.equal(prompt.includes(policy), false, `${phase} must not repeat a tool policy`);
  }
  const conclude = workerSystemPrompt('conclude');
  assert.ok(conclude.includes(IDE_CONTEXT), 'conclude keeps IDE context');
  assert.ok(conclude.includes(DEPLOYMENT_VERIFICATION_POLICY), 'conclude keeps deployment reporting rules');
  for (const policy of [LOCAL_SHELL_POLICY, KNOWLEDGE_POLICY, RETRIEVAL_POLICY]) {
    assert.equal(conclude.includes(policy), false, 'conclude cannot call tools');
  }
});

test('every phase keeps the distinct behavioral core rules', () => {
  const coreRules = [
    /Use the same language as the goal/,
    /never fabricate task completion/,
    /Do not invent tool calls/,
    /Use only tools supplied by the host/,
    /Never modify another Worker/,
    /Inspect the scope of other\s+intents/,
    /Explicit tool errors are failed attempts/
  ];
  for (const phase of ['plan', 'execute', 'replan', 'conclude']) {
    const prompt = workerSystemPrompt(phase);
    for (const rule of coreRules) assert.match(prompt, rule, `${phase} lost a core rule: ${rule}`);
  }
  for (const phase of ['execute', 'conclude']) {
    assert.match(workerSystemPrompt(phase), /make end-to-end accessibility the final plan step and completion checkpoint/);
    assert.match(workerSystemPrompt(phase), /user-facing endpoint/);
  }
  for (const phase of ['plan', 'replan']) assert.doesNotMatch(workerSystemPrompt(phase), /Deployment acceptance rule/);
  assert.match(workerSystemPrompt('plan'), /include the final user-facing verification step in the plan/);
  assert.match(workerSystemPrompt('replan'), /No tools are available in this phase/);
  assert.match(workerSystemPrompt('conclude'), /No tools are available/);
  assert.match(workerSystemPrompt('execute'), /exploration_graph/);
  assert.match(workerSystemPrompt('execute'), /navigation, never\s+evidence/);
  assert.doesNotMatch(workerSystemPrompt('plan'), /exploration_graph/);
});

test('host instructions append after the phase text and unknown phases fail', () => {
  const prompt = workerSystemPrompt('conclude', 'HOST SECURITY: deny fixture changes');
  assert.ok(prompt.endsWith('Host instructions:\nHOST SECURITY: deny fixture changes'));
  assert.match(prompt, /Worker phase: conclude/);
  assert.throws(() => workerSystemPrompt('nope'), /Unknown Worker phase: nope/);
});

test('phasePrompt supports full, names and none tool inventories', () => {
  const full = JSON.parse(phasePrompt(fixtureState, fixtureNode, fixtureTools, 8));
  assert.deepEqual(full.availableTools, fixtureTools.map(tool => ({ name: tool.name, description: tool.description })));
  assert.equal(phasePrompt(fixtureState, fixtureNode, fixtureTools, 8, { toolInventory: 'full' }), phasePrompt(fixtureState, fixtureNode, fixtureTools, 8),
    'default stays backward compatible');

  const names = JSON.parse(phasePrompt(fixtureState, fixtureNode, fixtureTools, 8, { toolInventory: 'names' }));
  assert.deepEqual(names.availableTools, [{ name: 'inspect' }, { name: 'write' }]);

  const none = JSON.parse(phasePrompt(fixtureState, fixtureNode, fixtureTools, 8, { toolInventory: 'none' }));
  assert.equal(Object.hasOwn(none, 'availableTools'), false);
  for (const value of [full, names, none]) {
    assert.equal(value.goal, fixtureState.goal);
    assert.deepEqual(value.intent, fixtureNode.intent);
    assert.equal(value.maxPlanSteps, 8);
    assert.deepEqual(value.plan, fixtureState.plan);
    assert.deepEqual(value.completedSteps, [{ description: 'checked host', doneWhen: 'output seen' }]);
    assert.ok(value.ownedWorkResults.startsWith('B'.repeat(800)));
    assert.ok(value.ownedWorkResults.endsWith('[truncated]'));
  }
  assert.ok(phasePrompt(fixtureState, fixtureNode, fixtureTools, 8, { toolInventory: 'names' }).length
    < phasePrompt(fixtureState, fixtureNode, fixtureTools, 8).length);
  assert.ok(phasePrompt(fixtureState, fixtureNode, fixtureTools, 8, { toolInventory: 'none' }).length
    < phasePrompt(fixtureState, fixtureNode, fixtureTools, 8, { toolInventory: 'names' }).length);
  assert.throws(() => phasePrompt(fixtureState, fixtureNode, fixtureTools, 8, { toolInventory: 'short' }), /Unknown toolInventory mode/);
});

function ledgerEntry(overrides) {
  return {
    toolCallId: 'call-1', toolName: 'inspect', args: {}, status: 'completed', isError: false,
    result: { content: [{ type: 'text', text: 'observation '.repeat(100) }, { type: 'image', data: 'AA==', mimeType: 'image/png' }] },
    ...overrides
  };
}

test('execute ledger cites completed tools without repeating transcript observations', () => {
  const state = {
    phase: 'execute',
    messages: [
      { role: 'assistant', content: [{ type: 'toolCall', id: 'call-1' }, { type: 'toolCall', id: 'call-2' }] },
      { role: 'toolResult', toolCallId: 'call-1' }
    ],
    ledger: [
      ledgerEntry({}),
      ledgerEntry({ toolCallId: 'call-2', status: 'running', isError: undefined, result: { content: [{ type: 'text', text: 'running '.repeat(100) }] } }),
      ledgerEntry({ toolCallId: 'call-old', status: 'completed' })
    ]
  };
  const entries = evidenceLedger(state);
  assert.deepEqual(entries[0], { toolCallId: 'call-1', toolName: 'inspect', status: 'completed', isError: false });
  assert.equal(Object.hasOwn(entries[0], 'observations'), false, 'completed results live in the transcript');
  assert.equal(Object.hasOwn(entries[0], 'imageCount'), false);
  assert.equal(entries[1].toolCallId, 'call-2');
  assert.equal(entries[1].status, 'running');
  assert.ok(entries[1].observations[0].startsWith('running '.repeat(50)));
  assert.ok(entries[1].observations[0].endsWith('[truncated]'));
  assert.equal(Object.hasOwn(entries[1], 'isError'), false);
  assert.equal(entries.length, 2, 'completed calls from an earlier phase stay hidden in execute');
});

test('replan and conclude ledgers keep clipped observations and plan stays empty', () => {
  const ledger = [ledgerEntry({}), ledgerEntry({ toolCallId: 'call-running', status: 'running' })];
  const replan = evidenceLedger({ phase: 'replan', messages: [], ledger });
  assert.deepEqual(replan.map(entry => entry.toolCallId), ['call-1']);
  assert.equal(replan[0].observations.length, 1);
  assert.equal(replan[0].observations[0].length, 512 + ' [truncated]'.length);
  assert.equal(replan[0].imageCount, 1);
  assert.deepEqual(evidenceLedger({ phase: 'plan', messages: [], ledger }), []);
});

test('execute request narrows the tool inventory and cites completed tools compactly', async () => {
  const checkpoint = createWorkerCheckpoint({ intentId: 'intent', goal: 'verify' });
  checkpoint.phase = 'execute';
  checkpoint.plan = [{ description: 'inspect service', doneWhen: 'reachable' }];
  const fact = JSON.stringify({ outcome: 'confirmed', statement: 'Service verified',
    evidence: [{ toolCallId: 'inspect-1', observation: 'Source verified' }] });
  const requests = [];
  let calls = 0;
  const worker = createPiWorker({
    model,
    tools: [{ name: 'inspect', description: 'Inspect a scoped source', parameters: { type: 'object', properties: {}, additionalProperties: false },
      execute: async () => ({ content: [{ type: 'text', text: 'Source verified' }] }) }],
    streamFn: (_model, transcript) => {
      calls++;
      const system = transcript.messages.find(message => message.role === 'system');
      const systemText = typeof system?.content === 'string' ? system.content : (system?.content ?? []).map(part => part.text).join('\n');
      const phase = /Worker phase: (\w+)/.exec(systemText)?.[1];
      const assignmentText = transcript.messages
        .flatMap(message => typeof message.content === 'string' ? [message.content] : (message.content ?? []).map(part => part.text))
        .find(text => typeof text === 'string' && text.startsWith('{') && text.includes('"maxPlanSteps"'));
      const evidence = transcript.messages.at(-1).content[0].text;
      requests.push({ phase, assignment: JSON.parse(assignmentText), ledger: JSON.parse(evidence.split('Host tool evidence ledger:\n')[1]) });
      if (calls === 1) return response([{ type: 'toolCall', id: 'inspect-1', name: 'inspect', arguments: {} }], 'toolUse');
      if (calls === 2) return response([{ type: 'text', text: 'step done' }]);
      if (calls === 3) return response([{ type: 'text', text: '{"done":true}' }]);
      return response([{ type: 'text', text: fact }]);
    }
  });
  const workerArgs = () => ({
    node: { id: 'intent', intent: { description: 'verify', keyPoints: [] } }, attempt: { id: 'attempt' }, checkpoint,
    getContext: () => ({ data: { goal: 'verify', nodes: [] }, text: 'verify' }), saveCheckpoint: async () => {}
  });
  const result = JSON.parse((await worker(workerArgs())).content);
  assert.equal(result.outcome, 'confirmed');
  assert.equal(calls, 4);

  const [executeStart, executeAfterTool, replan, conclude] = requests;
  assert.equal(executeStart.phase, 'execute');
  assert.deepEqual(executeStart.assignment.availableTools, [{ name: 'inspect' }], 'execute ships schemas in the request, so only names repeat');
  assert.deepEqual(executeStart.ledger, []);

  assert.equal(executeAfterTool.phase, 'execute');
  assert.deepEqual(executeAfterTool.ledger, [{ toolCallId: 'inspect-1', toolName: 'inspect', status: 'completed', isError: false }]);
  assert.equal(Object.hasOwn(executeAfterTool.ledger[0], 'observations'), false, 'transcript already carries the observation');

  assert.equal(replan.phase, 'replan');
  assert.equal(Object.hasOwn(replan.assignment, 'availableTools'), false, 'replan cannot call tools');
  assert.deepEqual(replan.ledger, [{ toolCallId: 'inspect-1', toolName: 'inspect', status: 'completed', isError: false,
    observations: ['Source verified'], imageCount: 0 }]);

  assert.equal(conclude.phase, 'conclude');
  assert.equal(Object.hasOwn(conclude.assignment, 'availableTools'), false, 'conclude cannot call tools');
  assert.deepEqual(conclude.ledger.map(entry => entry.toolCallId), ['inspect-1']);
});
