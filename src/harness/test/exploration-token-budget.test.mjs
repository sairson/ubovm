// Permanent regression coverage for the exploration-mode ("goal mode") token
// budget round. These tests build a synthetic blackboard of realistic size and
// assert the model-facing contracts that keep Reason/Worker/sidebar requests
// small without losing planning or evidence capability:
//   - blackboard context is compact (non-pretty) JSON with no information loss;
//   - the prompt agenda is alias-addressed instead of repeating intent text;
//   - Worker system prompts carry tool policies only in phases that can call
//     tools, while keeping every behavioral/security rule;
//   - the phase assignment narrows the tool inventory per phase and the evidence
//     ledger cites completed execute tools instead of re-sending their output;
//   - the Reason system prompt stays inside its budget and the repair turn reuses
//     exactly one Blackboard Evidence message;
//   - the goal Worker todo summary no longer duplicates its own host-managed plan.
import test from 'node:test';
import assert from 'node:assert/strict';
import { AssistantMessageEventStream } from '@earendil-works/pi-ai';
import { Blackboard } from '../blackboard/blackboard.mjs';
import { buildBlackboardContext } from '../blackboard/context.mjs';
import { buildExplorationAgenda, renderAgenda } from '../blackboard/agenda.mjs';
import { createPiWorker, evidenceLedger } from '../worker-agents/worker_pi_agent.mjs';
import { createWorkerCheckpoint } from '../worker-agents/checkpoint.mjs';
import { phasePrompt, workerSystemPrompt } from '../worker-agents/prompts.mjs';
import { createPiReason } from '../agents/reason_agent.mjs';
import { reasonSystemPrompt } from '../agents/prompts.mjs';
import { createTodoTool } from '../intools/todo/index.mjs';
import { MemoryStore } from '../intools/shared/store/memory-store.mjs';
import { IDE_CONTEXT } from '../ide-context.mjs';
import { DEPLOYMENT_VERIFICATION_POLICY } from '../deployment-policy.mjs';
import { RETRIEVAL_POLICY } from '../retrieval-policy.mjs';
import { KNOWLEDGE_POLICY } from '../learning/prompts.mjs';
import { LOCAL_SHELL_POLICY } from '../intools/terminals/local-shell/index.mjs';

const MODEL = { id: 'budget-fixture', api: 'openai-completions', provider: 'budget-fixture' };
const USAGE = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const LONG_INTENT = 'Audit the public export endpoint for missing authorization checks across every tenant query parameter and record the exact request/response pairs for the report with enough detail to reproduce the finding ';
const LONG_FACT = 'The export endpoint returned rows for tenant B while authenticated as tenant A, reproduced twice with the recorded request/response pair, the response body carried the tenant id header, and the baseline control request returned only tenant A rows; tenant C was not exercised because its credential was unavailable.';

function assistantMessage(content, stopReason = 'stop') {
  const stream = new AssistantMessageEventStream();
  stream.push({ type: 'done', reason: stopReason, message: {
    role: 'assistant', content, stopReason, api: MODEL.api, provider: MODEL.provider, model: MODEL.id, timestamp: 1, usage: USAGE
  } });
  return stream;
}

const textOf = message => typeof message.content === 'string'
  ? message.content
  : (message.content ?? []).map(part => part.text ?? '').join('');

/**
 * A saturated-but-realistic board: 23 nodes (root, 16 intents, 6 facts), long
 * intent descriptions, long fact statements, and one intent in each lifecycle
 * state (pending, running, completed, failed). It also carries a Reason-owned
 * agenda direction, which only lives in the shared memory store.
 */
async function explorationFixture() {
  const board = new Blackboard({ sessionId: 'token-budget', goal: 'verify authorization on the export endpoint' });
  for (let index = 0; index < 4; index++) {
    await board.createIntent({ description: `${LONG_INTENT}pending-${index}`, keyPoints: [`pending-${index}`], priority: index % 2 ? 'high' : 'medium' });
  }
  for (let index = 0; index < 6; index++) {
    const intent = await board.createIntent({ description: `${LONG_INTENT}completed-${index}`, keyPoints: [`completed-${index}`] });
    const attempt = await board.beginAttempt(intent.id);
    await board.completeAttempt(intent.id, attempt.id, JSON.stringify({
      version: 1,
      outcome: index % 3 === 0 ? 'partial' : 'confirmed',
      statement: `${LONG_FACT} Scope ${index}.`,
      coverage: [{ point: `completed-${index}`, status: index % 3 === 0 ? 'partial' : 'confirmed', result: `cross-tenant rows observed in scope ${index}` }],
      evidence: [{ toolCallId: `call-${index}`, observation: `rows for scope ${index}` }],
      limitations: index % 3 === 0 ? ['tenant C list incomplete'] : []
    }));
  }
  for (let index = 0; index < 5; index++) {
    const intent = await board.createIntent({ description: `${LONG_INTENT}failed-${index}`, keyPoints: [`failed-${index}`] });
    const attempt = await board.beginAttempt(intent.id);
    await board.failAttempt(intent.id, attempt.id, `resolver timed out resolving tenant ${index} after three retries with a materially different method`);
  }
  const running = await board.createIntent({ description: `${LONG_INTENT}running`, keyPoints: ['running'] });
  const runningAttempt = await board.beginAttempt(running.id);
  await board.saveCheckpoint(running.id, runningAttempt.id, {
    kind: 'ubovm.pi-worker', version: 1, phase: 'execute',
    plan: [
      { description: 'Collect the export responses for each tenant', doneWhen: 'one response per tenant recorded' },
      { description: 'Compare tenant scoping against the requested filter', doneWhen: 'scope comparison recorded' },
      { description: 'Diff the returned row sets against the baseline', doneWhen: 'row diff recorded' }
    ],
    completed: []
  });
  const store = new MemoryStore({ sessionId: 'token-budget' });
  await store.commit(state => {
    state.agenda = [
      { id: 'direction-cache', worker_id: 'reason', content: 'Check cache poisoning via the CDN edge with conflicting headers',
        status: 'active', dedupe_key: 'cache poisoning via cdn edge', method: 'send conflicting cache headers to the edge node',
        acceptance: 'the edge returns both variants to the same client', created_at: 'x', updated_at: 'x' },
      { id: 'direction-normalization', worker_id: 'reason', content: 'Probe the tenant header normalization path',
        status: 'planned', dedupe_key: 'tenant header normalization', method: 'send mixed-case tenant headers',
        acceptance: 'normalization behavior recorded', created_at: 'x', updated_at: 'x' }
    ];
  });
  return { board, store };
}

test('model-facing blackboard context is compact JSON with no information loss', async () => {
  const { board } = await explorationFixture();
  const snapshot = board.snapshot();
  assert.ok(snapshot.nodes.length >= 20, `fixture has a realistic board (${snapshot.nodes.length} nodes)`);
  const intents = snapshot.nodes.filter(node => node.intent);
  assert.equal(intents.some(node => node.intent.status === 'pending'), true, 'fixture has a pending intent');
  assert.equal(intents.some(node => node.intent.status === 'running'), true, 'fixture has a running intent');
  assert.equal(intents.some(node => node.intent.status === 'completed'), true, 'fixture has a completed intent');
  assert.equal(intents.some(node => node.attempts.some(attempt => attempt.status === 'failed')), true, 'fixture has a failed intent');

  const context = buildBlackboardContext(snapshot);
  const pretty = JSON.stringify(context.data, null, 2);
  assert.equal(context.text, JSON.stringify(context.data), 'model-facing text is compact JSON');
  assert.deepEqual(JSON.parse(context.text), context.data, 'every projected field survives the round-trip');
  assert.equal(context.text.includes('\n  "'), false, 'no pretty-printer indentation reaches the model');
  assert.ok(context.text.length <= pretty.length * 0.85,
    `compact JSON is materially smaller (${context.text.length} vs ${pretty.length} pretty chars)`);
  assert.ok(context.text.length > 0);

  // Worker scope (focusId) has an even smaller projection and is compact too.
  const focusId = snapshot.nodes.find(node => node.intent?.status === 'pending').id;
  const focused = buildBlackboardContext(snapshot, { focusId });
  assert.equal(focused.text, JSON.stringify(focused.data));
  assert.equal(focused.data.exploration, undefined, 'worker-scope context keeps its focused projection');
  assert.ok(focused.text.length < context.text.length, 'worker-scope context is smaller than the Reason projection');
  assert.equal(buildBlackboardContext(snapshot).text.includes('\n  "'), false);
  assert.throws(() => buildBlackboardContext(snapshot, { focusId: 'missing-node' }), /focus does not exist/);
});

test('compact prompt agenda is alias-addressed, keeps direction/plan state and skips duplicated descriptions', async () => {
  const { board, store } = await explorationFixture();
  const agenda = buildExplorationAgenda({ snapshot: board.snapshot(), memory: store.snapshot(['agenda']) });
  assert.ok(agenda.items.filter(item => item.kind === 'intent').length >= 16);
  assert.equal(agenda.items.filter(item => item.kind === 'direction').length, 2);
  assert.ok(agenda.items.filter(item => item.kind === 'suggestion').length >= 2, 'failed/gap suggestions exist');

  const full = renderAgenda(agenda);
  const compact = renderAgenda(agenda, { compact: true });
  assert.match(compact, /^# Shared exploration agenda/);
  assert.match(compact, /Status: \d+ planned, \d+ active, \d+ blocked, \d+ done, \d+ dropped\./);
  // Intent lines address the graph alias; the description already exists in the
  // evidence graph / blackboard JSON, so it must not be repeated here.
  assert.match(compact, /- \[active\] · intent n\d+/);
  assert.equal(compact.includes(LONG_INTENT), false, 'intent descriptions are not duplicated in prompts');
  // Run state that only the agenda projects stays available.
  assert.match(compact, /current: Collect the export responses for each tenant/);
  assert.match(compact, /plan: Collect the export responses for each tenant > Compare tenant scoping against the requested filter/);
  assert.match(compact, /blocker: resolver timed out resolving tenant 0/);
  assert.match(compact, /\[done\] · intent n\d+ · evidence: n\d+/, 'completed intents cite their result fact alias');
  // Reason-owned directions have no other projection and stay verbatim.
  assert.match(compact, /Check cache poisoning via the CDN edge with conflicting headers/);
  assert.match(compact, /method: send conflicting cache headers to the edge node/);
  assert.match(compact, /acceptance: the edge returns both variants to the same client/);
  for (const status of ['active', 'blocked', 'planned', 'done']) assert.ok(compact.includes(`[${status}]`), `compact agenda keeps ${status} statuses`);
  assert.ok(compact.length <= full.length * 0.6, `compact agenda is materially smaller (${compact.length} vs ${full.length} chars)`);
  // The human/tool view keeps the full descriptions it was designed for.
  assert.ok(full.includes(LONG_INTENT));
  assert.match(full, /never (?:rerun|repeat) completed/i);

  // Worker injection uses the same renderer with a narrower window.
  const workerFull = renderAgenda(agenda, { maxOpen: 10, maxDone: 4 });
  const workerCompact = renderAgenda(agenda, { maxOpen: 10, maxDone: 4, compact: true });
  assert.ok(workerCompact.length < workerFull.length * 0.6);
  assert.equal(workerCompact.includes(LONG_INTENT), false);
});

test('worker system prompts ship tool policies only to phases that can call tools and keep every rule', () => {
  const policies = { LOCAL_SHELL_POLICY, KNOWLEDGE_POLICY, DEPLOYMENT_VERIFICATION_POLICY, RETRIEVAL_POLICY };
  const execute = workerSystemPrompt('execute');
  for (const [name, policy] of Object.entries(policies)) assert.ok(execute.includes(policy), `execute keeps ${name}`);
  for (const phase of ['plan', 'replan']) {
    const prompt = workerSystemPrompt(phase);
    assert.ok(prompt.includes(IDE_CONTEXT), `${phase} keeps IDE context`);
    for (const [name, policy] of Object.entries(policies)) assert.equal(prompt.includes(policy), false, `${phase} cannot call tools and must not repeat ${name}`);
  }
  const conclude = workerSystemPrompt('conclude');
  assert.ok(conclude.includes(IDE_CONTEXT));
  assert.ok(conclude.includes(DEPLOYMENT_VERIFICATION_POLICY), 'conclude reports deployment results and keeps the deployment policy');
  for (const policy of [LOCAL_SHELL_POLICY, KNOWLEDGE_POLICY, RETRIEVAL_POLICY]) assert.equal(conclude.includes(policy), false);

  // Token-budget sizes per phase (the tool-heavy execute prompt is the ceiling).
  const plan = workerSystemPrompt('plan');
  const replan = workerSystemPrompt('replan');
  assert.ok(plan.length < 6_000, `plan prompt is ${plan.length} chars`);
  assert.ok(replan.length < 6_500, `replan prompt is ${replan.length} chars`);
  assert.ok(conclude.length < 10_500, `conclude prompt is ${conclude.length} chars`);
  assert.ok(execute.length < 12_000, `execute prompt is ${execute.length} chars`);
  assert.ok(execute.length > plan.length * 1.5 && execute.length > replan.length * 1.5);

  // Every phase keeps the distinct behavioral core rules (assert the meaning,
  // not an exact sentence: another token-trimming pass may reword the prose).
  const coreRules = [
    [/same language as the goal/i, 'language rule'],
    [/fabricat\w* task completion|never fabricate/i, 'no-fabrication rule'],
    [/Peer visibility[^.]*READ-ONLY/i, 'peer read-only visibility'],
    [/modify another Worker/i, 'peer-mutation prohibition'],
    [/tools supplied by the host/i, 'host-authorized tools only'],
    [/Do not invent tool calls/i, 'tool-evidence rule'],
    [/tool errors are failed attempts/i, 'error semantics']
  ];
  for (const phase of ['plan', 'execute', 'replan', 'conclude']) {
    const prompt = workerSystemPrompt(phase);
    for (const [pattern, label] of coreRules) assert.match(prompt, pattern, `${phase} keeps the ${label}`);
    assert.match(prompt, /Worker phase: /, `${phase} identifies its phase`);
  }

  // The host security append path survives the phase split.
  const appended = workerSystemPrompt('execute', 'HOST SECURITY: deny fixture changes');
  assert.ok(appended.endsWith('Host instructions:\nHOST SECURITY: deny fixture changes'));
  assert.match(appended, /Worker phase: execute/);
  assert.throws(() => workerSystemPrompt('unknown-phase'), /Unknown Worker phase/);
});

test('phasePrompt narrows the tool inventory but keeps the assignment payload', () => {
  const tools = [
    { name: 'run_local_shell_command', description: 'S'.repeat(900) },
    { name: 'note', description: 'N'.repeat(600) },
    { name: 'todo', description: 'T'.repeat(300) }
  ];
  const state = {
    goal: 'verify the deployment',
    plan: [{ description: 'inspect service', doneWhen: 'reachable' }],
    completed: [{ step: { description: 'checked host', doneWhen: 'output seen' }, output: 'host ok' }],
    barrierResult: 'B'.repeat(900)
  };
  const node = { intent: { description: 'verify reachability', hint: 'use the IDE', priority: 2, keyPoints: ['reachable'] } };

  const fullText = phasePrompt(state, node, tools, 8);
  const full = JSON.parse(fullText);
  assert.deepEqual(full.availableTools, tools.map(tool => ({ name: tool.name, description: tool.description })));
  assert.equal(fullText, phasePrompt(state, node, tools, 8, { toolInventory: 'full' }), 'default stays backward compatible');

  const namesText = phasePrompt(state, node, tools, 8, { toolInventory: 'names' });
  const names = JSON.parse(namesText);
  assert.deepEqual(names.availableTools, tools.map(tool => ({ name: tool.name })), 'execute ships schemas in the request, so only names repeat');

  const noneText = phasePrompt(state, node, tools, 8, { toolInventory: 'none' });
  const none = JSON.parse(noneText);
  assert.equal(Object.hasOwn(none, 'availableTools'), false, 'replan/conclude cannot call tools and get no inventory');

  for (const payload of [full, names, none]) {
    assert.equal(payload.goal, state.goal);
    assert.deepEqual(payload.intent, node.intent);
    assert.equal(payload.maxPlanSteps, 8);
    assert.deepEqual(payload.plan, state.plan);
    assert.deepEqual(payload.completedSteps, [{ description: 'checked host', doneWhen: 'output seen' }]);
    assert.ok(payload.ownedWorkResults.startsWith('B'.repeat(800)));
    assert.ok(payload.ownedWorkResults.endsWith('[truncated]'));
  }
  assert.ok(namesText.length < fullText.length);
  assert.ok(noneText.length < namesText.length);
  assert.throws(() => phasePrompt(state, node, tools, 8, { toolInventory: 'short' }), /Unknown toolInventory mode/);
});

test('worker requests use the right inventory per phase and only cite completed execute tools', async () => {
  const requests = [];
  let calls = 0;
  const longDescription = 'Inspect a scoped source and return the decisive observation for the acceptance check';
  const fact = JSON.stringify({ outcome: 'confirmed', statement: 'Service verified', evidence: [{ toolCallId: 'inspect-1', observation: 'Source verified' }] });
  const worker = createPiWorker({
    model: MODEL,
    tools: [{
      name: 'inspect', description: longDescription,
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      execute: async () => ({ content: [{ type: 'text', text: 'Source verified' }] })
    }],
    streamFn: (_model, transcript) => {
      calls++;
      const systemText = textOf(transcript.messages.find(message => message.role === 'system'));
      const phase = /Worker phase: (\w+)/.exec(systemText)?.[1];
      const assignmentText = transcript.messages
        .flatMap(message => typeof message.content === 'string' ? [message.content] : (message.content ?? []).map(part => part.text))
        .find(value => typeof value === 'string' && value.startsWith('{') && value.includes('"maxPlanSteps"'));
      const evidence = transcript.messages.at(-1).content[0].text;
      requests.push({ phase, assignment: JSON.parse(assignmentText), ledger: JSON.parse(evidence.split('Host tool evidence ledger:\n')[1]) });
      if (calls === 1) return assistantMessage([{ type: 'text', text: JSON.stringify({ steps: [{ description: 'inspect service', doneWhen: 'reachable' }] }) }]);
      if (calls === 2) return assistantMessage([{ type: 'toolCall', id: 'inspect-1', name: 'inspect', arguments: {} }], 'toolUse');
      if (calls === 3) return assistantMessage([{ type: 'text', text: 'step done' }]);
      if (calls === 4) return assistantMessage([{ type: 'text', text: JSON.stringify({ done: true }) }]);
      return assistantMessage([{ type: 'text', text: fact }]);
    }
  });
  const result = await worker({
    node: { id: 'intent', intent: { description: 'verify the source', keyPoints: [] } },
    attempt: { id: 'attempt' },
    checkpoint: createWorkerCheckpoint({ intentId: 'intent', goal: 'verify' }),
    getContext: () => ({ data: { goal: 'verify', nodes: [] }, text: 'verify' }),
    saveCheckpoint: async () => {}
  });
  assert.equal(JSON.parse(result.content).outcome, 'confirmed');
  assert.equal(calls, 5);

  const [plan, executeStart, executeAfterTool, replan, conclude] = requests;
  assert.equal(plan.phase, 'plan');
  assert.deepEqual(plan.assignment.availableTools, [{ name: 'inspect', description: longDescription }], 'plan gets full tool descriptions');

  assert.equal(executeStart.phase, 'execute');
  assert.deepEqual(executeStart.assignment.availableTools, [{ name: 'inspect' }], 'execute ships full schemas in the request, so only names repeat');
  assert.deepEqual(executeStart.ledger, []);

  assert.equal(executeAfterTool.phase, 'execute');
  assert.deepEqual(executeAfterTool.ledger, [{ toolCallId: 'inspect-1', toolName: 'inspect', status: 'completed', isError: false }]);
  assert.equal(Object.hasOwn(executeAfterTool.ledger[0], 'observations'), false, 'completed execute results live in the transcript');

  assert.equal(replan.phase, 'replan');
  assert.equal(Object.hasOwn(replan.assignment, 'availableTools'), false, 'replan cannot call tools');
  assert.deepEqual(replan.ledger, [{ toolCallId: 'inspect-1', toolName: 'inspect', status: 'completed', isError: false,
    observations: ['Source verified'], imageCount: 0 }], 'replan still sees the executed observations');

  assert.equal(conclude.phase, 'conclude');
  assert.equal(Object.hasOwn(conclude.assignment, 'availableTools'), false, 'conclude cannot call tools');
  assert.deepEqual(conclude.ledger.map(entry => entry.toolCallId), ['inspect-1']);
});

test('evidence ledger clips replan/conclude observations and hides earlier-phase tools in execute', () => {
  const observation = 'observation '.repeat(100);
  const entry = overrides => ({
    toolCallId: 'call-1', toolName: 'inspect', args: {}, status: 'completed', isError: false,
    result: { content: [{ type: 'text', text: observation }, { type: 'image', data: 'AA==', mimeType: 'image/png' }] },
    ...overrides
  });
  const state = {
    phase: 'execute',
    messages: [
      { role: 'assistant', content: [{ type: 'toolCall', id: 'call-1' }, { type: 'toolCall', id: 'call-2' }] },
      { role: 'toolResult', toolCallId: 'call-1' }
    ],
    ledger: [
      entry({}),
      entry({ toolCallId: 'call-2', status: 'running', isError: undefined, result: { content: [{ type: 'text', text: 'still running' }] } }),
      entry({ toolCallId: 'call-old' })
    ]
  };

  const execute = evidenceLedger(state);
  assert.equal(execute.length, 2, 'completed calls from an earlier phase stay hidden in execute');
  assert.deepEqual(execute[0], { toolCallId: 'call-1', toolName: 'inspect', status: 'completed', isError: false });
  assert.equal(Object.hasOwn(execute[0], 'observations'), false, 'a completed transcript result is not sent twice');
  assert.equal(Object.hasOwn(execute[0], 'imageCount'), false);
  assert.equal(execute[1].status, 'running');
  assert.deepEqual(execute[1].observations, ['still running'], 'running entries have no transcript copy yet, so they keep output');
  assert.equal(Object.hasOwn(execute[1], 'isError'), false);

  const replan = evidenceLedger({ phase: 'replan', messages: [], ledger: state.ledger });
  assert.deepEqual(replan.map(item => item.toolCallId), ['call-1', 'call-old']);
  assert.equal(replan[0].observations[0].length, 512 + ' [truncated]'.length, 'replan observations are clipped to 512 chars');
  assert.equal(replan[0].observations[0].endsWith(' [truncated]'), true);
  assert.equal(replan[0].imageCount, 1);
  assert.equal(evidenceLedger({ phase: 'plan', messages: [], ledger: state.ledger }).length, 0, 'plan has no tools to report');
  assert.equal(evidenceLedger({ phase: 'conclude', messages: [], ledger: state.ledger }).length, 2, 'conclude keeps completed tool citations');
});

test('Reason system prompt fits the review budget and keeps every planning requirement', () => {
  const toolNames = {
    workerTools: ['list_workers', 'stop_worker', 'start_worker', 'prompt_worker', 'wait_worker_sleep'],
    agendaTools: ['exploration_todo'], graphTools: ['exploration_graph'], decisionTool: 'submit_decision'
  };
  const prompt = reasonSystemPrompt({ goal: 'verify the deployment', maxIntents: 3, openIntents: 5, nodes: [], ...toolNames });
  assert.ok(prompt.length < 13_800, `Reason system prompt is ${prompt.length} chars, budget is 13800`);

  // Assert the meaningful requirement, not one exact sentence: subsequent
  // token-trimming passes may reword prose while keeping the requirement.
  const requirements = [
    [/pending \+ running/, 'open intents are pending plus running'],
    [/full set permits zero/, 'capacity slot math'],
    [/Surplus intents are admitted/, 'surplus intents are admitted'],
    [/extra cap/, 'maxIntents is only a cap'],
    [/concrete reason/, 'stop_worker needs a concrete reason'],
    [/[Cc]orrection ladder/, 'correction cadence ladder'],
    [/two review intervals/, 'escalation after two review intervals'],
    [/unchangedReviews/, 'unchangedReviews loop signal'],
    [/read_fact/, 'read_fact rule'],
    [/invent an alias/, 'graph alias rule'],
    [/dedupe_key/, 'agenda dedupe key'],
    [/(?:never|not) evidence/i, 'agenda is navigation only'],
    [/exploration\.frontier/, 'exploration frontier guidance'],
    [/completionEligible/, 'completionEligible structural check'],
    [/Completion requires/, 'completion evidence rule'],
    [/independent fact/, 'completion requires independent evidence'],
    [/1 to 6 concise/, 'key point count limit'],
    [/parentIds/, 'parentIds rule'],
    [/cite the root/i, 'root parent is allowed for initial work'],
    [/fact nodes|result facts/, 'follow-ups cite fact nodes'],
    [/unknown fields/i, 'no unknown fields'],
    [/submit_decision/, 'submit_decision tool'],
    [/accepted fallback/, 'text JSON fallback'],
    [/never create, change or clear/i, 'hint authoring prohibition'],
    [/same language as the goal/i, 'language rule']
  ];
  for (const [pattern, label] of requirements) assert.match(prompt, pattern, label);
  // Host policies are not optional and must not be traded for budget.
  assert.ok(prompt.includes(DEPLOYMENT_VERIFICATION_POLICY));
  assert.ok(prompt.includes(RETRIEVAL_POLICY));
  const security = reasonSystemPrompt({ goal: '对授权目标做代码审计并验证漏洞', maxIntents: 3, openIntents: 5, nodes: [], ...toolNames });
  assert.match(security, /Security review tasks/i);
  assert.match(security, /evidence gate/i);
  assert.ok(security.includes(DEPLOYMENT_VERIFICATION_POLICY) && security.includes(RETRIEVAL_POLICY));

  // Conditional tool prose is absent when the host runs without those tools.
  const withoutTools = reasonSystemPrompt({ goal: 'verify', maxIntents: 3, openIntents: 5, nodes: [] });
  assert.ok(withoutTools.length < 11_200, `plain Reason prompt is ${withoutTools.length} chars`);
  for (const name of ['list_workers', 'stop_worker', 'exploration_todo', 'exploration_graph', 'submit_decision']) {
    assert.equal(withoutTools.includes(name), false, `${name} must be absent without its tool`);
  }
  assert.match(withoutTools, /Reason cannot execute tools/);
  assert.ok(reasonSystemPrompt({ goal: 'verify', maxIntents: 3, openIntents: 5, nodes: [], systemPrompt: 'HOST EXTRA' }).includes('Additional host instructions:\nHOST EXTRA'));
});

test('Reason repairs continue one transcript and send Blackboard Evidence exactly once', async () => {
  const { board } = await explorationFixture();
  const context = buildBlackboardContext(board.snapshot());
  const providers = [
    ['compact JSON fallback', undefined],
    ['rendered topology', async () => '# Exploration graph (complete topology)\nrevision=2 nodes=2 root=n1 detail=full\nn1 root "verify authorization on the export endpoint"\nn2 intent <-n1 status=pending desc="queued check"']
  ];
  for (const [label, evidenceProvider] of providers) {
    const requests = [];
    const reason = createPiReason({
      model: MODEL, evidenceProvider,
      streamFn: (_model, request) => {
        requests.push(structuredClone(request));
        return requests.length === 1 ? assistantMessage([{ type: 'text', text: 'not a JSON decision' }]) : assistantMessage([{ type: 'text', text: JSON.stringify({ wait: true }) }]);
      }
    });
    assert.deepEqual(await reason({ context }), { wait: true }, label);
    assert.equal(requests.length, 2, `${label}: one repair turn is enough`);

    const evidenceMessages = request => request.messages.filter(message => message.role === 'user' && textOf(message).startsWith('Blackboard Evidence'));
    const repairMessages = request => request.messages.filter(message => message.role === 'user' && /The previous response failed host validation:/.test(textOf(message)));
    assert.equal(evidenceMessages(requests[0]).length, 1, `${label}: the first turn sends evidence once`);
    assert.equal(repairMessages(requests[0]).length, 0);
    assert.equal(evidenceMessages(requests[1]).length, 1, `${label}: the repair reuses the single evidence message`);
    assert.equal(repairMessages(requests[1]).length, 1, `${label}: the repair adds one user correction`);
    assert.equal(requests[1].messages.filter(message => message.role === 'user').length, 2,
      `${label}: evidence and correction are the only user messages`);

    const evidenceIndex = requests[1].messages.findIndex(message => message.role === 'user' && textOf(message).startsWith('Blackboard Evidence'));
    const repairIndex = requests[1].messages.findIndex(message => message.role === 'user' && /The previous response failed host validation:/.test(textOf(message)));
    assert.ok(evidenceIndex >= 0 && repairIndex > evidenceIndex, `${label}: the correction follows the evidence`);
    assert.match(textOf(requests[1].messages[repairIndex]), /corrected JSON decision/i, `${label}: correction asks for a corrected decision`);
    assert.match(textOf(requests[1].messages[repairIndex]), /Do not fabricate facts/i, `${label}: correction keeps the no-fabrication rule`);
    assert.match(textOf(requests[1].messages[repairIndex]), /same evidence/i, `${label}: correction reuses the same evidence`);
    assert.ok(requests[1].messages.slice(0, repairIndex).some(message => message.role === 'assistant'),
      `${label}: the failed response stays visible in the continued transcript`);
  }
});

test('goal Worker todo summaries hide their own host-managed plan without hiding peer progress', async () => {
  const sessionId = 'token-budget-todos';
  const store = new MemoryStore({ sessionId });
  const own = createTodoTool({ store, sessionId, workerId: 'worker-a' });
  const peer = createTodoTool({ store, sessionId, workerId: 'worker-b' });
  await own.syncPlan('worker-a', [
    { id: '1', content: 'inspect host step', status: 'in_progress' },
    { id: '2', content: 'deploy service', status: 'pending' }
  ]);
  await peer.syncPlan('worker-b', [{ id: '1', content: 'peer investigation', status: 'pending' }]);
  await own.execute('t', { action: 'write', items: [{ content: 'own scratch note', status: 'in_progress' }] });

  const assist = own.summary('worker-a');
  assert.match(assist, /inspect host step/);
  assert.match(assist, /peer investigation/);
  assert.equal(own.summary('worker-a', { ownPlan: true }), assist, 'assist mode keeps the full board');

  const goal = own.summary('worker-a', { ownPlan: false });
  assert.doesNotMatch(goal, /inspect host step|deploy service/, 'the phase assignment already carries the goal plan');
  assert.match(goal, /peer investigation/, 'peer progress stays visible');
  assert.match(goal, /own scratch note/, 'todos the worker wrote itself stay visible');
  assert.match(goal, /# Session Todo Board/);
  assert.match(goal, /2 item\(s\) still open/);

  const solo = createTodoTool({ store: new MemoryStore({ sessionId: 'token-budget-solo' }), sessionId: 'token-budget-solo', workerId: 'worker-c' });
  await solo.syncPlan('worker-c', [{ id: '1', content: 'only host step', status: 'in_progress' }]);
  assert.match(solo.summary('worker-c'), /only host step/);
  assert.equal(solo.summary('worker-c', { ownPlan: false }), '', 'a goal worker with only its plan items gets no board noise');
});
