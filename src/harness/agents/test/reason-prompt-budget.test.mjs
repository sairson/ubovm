import test from 'node:test';
import assert from 'node:assert/strict';
import { AssistantMessageEventStream } from '@earendil-works/pi-ai';
import { reasonSystemPrompt } from '../prompts.mjs';
import { createPiReason } from '../reason_agent.mjs';

const model = { id: 'fixture', provider: 'fixture', api: 'openai-completions' };
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
function response(text, stopReason = 'stop') {
  const stream = new AssistantMessageEventStream();
  stream.push({ type: 'done', reason: stopReason, message: { role: 'assistant', content: [{ type: 'text', text }], api: model.api, provider: model.provider,
    model: model.id, usage, stopReason, timestamp: Date.now() } });
  return stream;
}
const textOf = message => typeof message.content === 'string' ? message.content : (message.content ?? []).map(part => part.text ?? '').join('');
const context = {
  data: { goal: 'verify', revision: 3, root: 'n1', nodes: [
    { ref: 'n1', kind: 'root', parents: [] },
    { ref: 'n2', kind: 'intent', parents: ['n1'], intent: { description: 'inspect', status: 'running', keyPoints: ['checked'] } }
  ] },
  resolveId: ref => ref, aliasFor: id => id
};

const fullPrompt = () => reasonSystemPrompt({
  goal: 'verify the deployment', maxIntents: 3, openIntents: 5, nodes: [],
  workerTools: ['list_workers', 'stop_worker', 'start_worker', 'prompt_worker', 'wait_worker_sleep'],
  agendaTools: ['exploration_todo'], graphTools: ['exploration_graph'], decisionTool: 'submit_decision'
});
const plainPrompt = () => reasonSystemPrompt({ goal: 'verify', maxIntents: 3, openIntents: 5, nodes: [] });

test('Reason system prompt stays within the review token budget', () => {
  const prompt = fullPrompt();
  assert.ok(prompt.length < 13_800, `Reason system prompt is ${prompt.length} chars, budget is 13800`);
  // The imported host policies are not optional: they must not be traded for budget.
  assert.match(prompt, /Deployment acceptance rule/);
  assert.match(prompt, /Public-web and environment retrieval/);
});

test('Reason system prompt keeps every distinct planning requirement', () => {
  const prompt = fullPrompt();
  const requirements = [
    // Capacity and slot math.
    [/Open = pending \+ running/, 'open intents are pending plus running'],
    [/full set permits zero, each free slot one/, 'capacity slot math'],
    [/Surplus intents are admitted, not rejected/, 'surplus intent admission'],
    [/maxIntents is an extra cap/, 'maxIntents is only an upper bound'],
    // Worker control and correction policy.
    [/list_workers/, 'list_workers tool'],
    [/stop_worker/, 'stop_worker tool'],
    [/start_worker/, 'start_worker tool'],
    [/prompt_worker/, 'prompt_worker tool'],
    [/wait_worker_sleep/, 'wait_worker_sleep tool'],
    [/concrete reason/, 'stop reason requirement'],
    [/lastCorrection/, 'lastCorrection inspection'],
    [/Correction ladder/, 'correction cadence'],
    [/two review intervals/, 'escalation after two review intervals'],
    [/unchangedReviews/, 'unchangedReviews loop signal'],
    // Exploration graph.
    [/COMPLETE exploration graph/, 'complete graph projection'],
    [/detail=full\|summary\|topology-only/, 'graph detail levels'],
    [/truncated=true/, 'truncated graph handling'],
    [/read_fact/, 'read_fact rule'],
    [/never invent an alias/, 'graph alias rule'],
    // Agenda.
    [/exploration_todo/, 'exploration_todo tool'],
    [/dedupe_key/, 'agenda dedupe key'],
    [/never evidence/, 'agenda is never evidence'],
    [/换方法/, 'derived agenda suggestions'],
    // Exploration index and completion evidence.
    [/exploration\.frontier/, 'exploration frontier guidance'],
    [/completionEligible/, 'completionEligible structural check'],
    [/unresolvedKeyPoints/, 'unresolvedKeyPoints assessment'],
    [/completionIssue/, 'completionIssue assessment'],
    [/2048 characters/, 'key point length limit'],
    [/1 to 6 concise distinct keyPoints/, 'key point count limit'],
    [/parentIds/, 'parent id rule'],
    [/No unknown fields are allowed/, 'no unknown fields'],
    [/Completion requires at least one independent fact/, 'completion evidence rule'],
    [/Assist-mode foundational evidence/, 'assist evidence rule'],
    [/confirmed negative finding/, 'negative finding rule'],
    [/Completion and new intents are mutually exclusive/, 'completion/new-work exclusivity'],
    // Decision channel, hints and language.
    [/submit_decision/, 'submit_decision tool'],
    [/Text JSON remains an accepted fallback/, 'text JSON fallback'],
    [/never create, change or clear one/, 'hint authoring prohibition'],
    [/same language as the goal/, 'language rule'],
    [/Return exactly one raw JSON object/, 'single JSON decision rule']
  ];
  for (const [pattern, label] of requirements) assert.match(prompt, pattern, label);
});

test('Reason conditional sections appear only when their tools are configured', () => {
  const plain = plainPrompt();
  for (const name of ['list_workers', 'stop_worker', 'start_worker', 'prompt_worker', 'wait_worker_sleep',
    'exploration_todo', 'exploration_graph', 'submit_decision']) {
    assert.doesNotMatch(plain, new RegExp(name), `${name} must be absent without tools`);
  }
  assert.match(plain, /Reason cannot execute tools/);

  const workerOnly = reasonSystemPrompt({ goal: 'verify', maxIntents: 3, openIntents: 5, nodes: [], workerTools: ['list_workers'] });
  assert.match(workerOnly, /list_workers/);
  for (const name of ['exploration_todo', 'exploration_graph', 'submit_decision']) assert.doesNotMatch(workerOnly, new RegExp(name));

  const agendaOnly = reasonSystemPrompt({ goal: 'verify', maxIntents: 3, openIntents: 5, nodes: [], agendaTools: ['exploration_todo'] });
  assert.match(agendaOnly, /exploration_todo/);
  for (const name of ['list_workers', 'exploration_graph', 'submit_decision']) assert.doesNotMatch(agendaOnly, new RegExp(name));

  const graphOnly = reasonSystemPrompt({ goal: 'verify', maxIntents: 3, openIntents: 5, nodes: [], graphTools: ['exploration_graph'] });
  assert.match(graphOnly, /exploration_graph/);
  for (const name of ['list_workers', 'exploration_todo', 'submit_decision']) assert.doesNotMatch(graphOnly, new RegExp(name));

  const decisionOnly = reasonSystemPrompt({ goal: 'verify', maxIntents: 3, openIntents: 5, nodes: [], decisionTool: 'submit_decision' });
  assert.match(decisionOnly, /submit_decision/);
  for (const name of ['list_workers', 'exploration_todo', 'exploration_graph']) assert.doesNotMatch(decisionOnly, new RegExp(name));
});

test('Reason repairs continue the same transcript without resending evidence', async () => {
  for (const evidenceProvider of [undefined, async () => '# Exploration graph (complete topology)\nrevision=3 nodes=2 root=n1 detail=full\nn1 root "verify"\nn2 intent <-n1 status=running desc="inspect"']) {
    const requests = [];
    const reason = createPiReason({
      model, evidenceProvider,
      streamFn: (requestModel, request) => {
        requests.push(structuredClone(request));
        return requests.length === 1
          ? response('not a JSON decision')
          : response(JSON.stringify({ wait: true }));
      }
    });
    assert.deepEqual(await reason({ context }), { wait: true });
    assert.equal(requests.length, 2, 'one repair turn is enough');

    const first = requests[0];
    const second = requests[1];
    const evidenceTexts = request => request.messages.filter(message => message.role === 'user' && textOf(message).startsWith('Blackboard Evidence'));
    const repairTexts = request => request.messages.filter(message => message.role === 'user' && /The previous response failed host validation:/.test(textOf(message)));

    assert.equal(evidenceTexts(first).length, 1, 'the first turn sends the evidence once');
    assert.equal(repairTexts(first).length, 0);
    assert.equal(evidenceTexts(second).length, 1, 'the repair reuses the one evidence message');
    assert.equal(repairTexts(second).length, 1, 'the repair adds one user correction message');

    const evidenceIndex = second.messages.indexOf(evidenceTexts(second)[0]);
    const repairIndex = second.messages.indexOf(repairTexts(second)[0]);
    assert.ok(evidenceIndex >= 0 && repairIndex > evidenceIndex, 'the correction follows the single evidence message');
    assert.match(textOf(repairTexts(second)[0]), /Return one corrected JSON decision using the same evidence and required schema\. Do not fabricate facts\./);
    assert.ok(second.messages.slice(0, repairIndex).some(message => message.role === 'assistant'),
      'the failed response stays visible in the continued transcript');
  }
});
