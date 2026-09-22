import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { createContextSummaryMiddleware, estimateContextTokens } from './context-summary.mjs';

const user = (content, timestamp = 1) => ({ role: 'user', content, timestamp });
const assistant = (text, timestamp = 2) => ({ role: 'assistant', content: [{ type: 'text', text }], timestamp });
const textOf = message => typeof message.content === 'string' ? message.content
  : message.content.filter(part => part.type === 'text').map(part => part.text).join('\n');

function fixture(t, options = {}, store = new Map()) {
  const calls = [], events = [];
  const summarize = options.summarize ?? (async () => 'Earlier observations verified; continue with the current request.');
  const runtime = createContextSummaryMiddleware({
    triggerTokens: 2500, targetTokens: 1100, triggerMessages: 12,
    keepRecentMessages: 4, maxSummaryTokens: 128,
    ...options,
    summarize: async request => { calls.push(request); return summarize(request); },
    load: async key => structuredClone(store.get(key)),
    save: async (key, value) => { store.set(key, structuredClone(value)); },
    onEvent: event => events.push(event),
  });
  t.after(() => runtime.close());
  return { runtime, calls, events, store, transform: (context, extras = {}) => runtime.transform({ scope: 'chat:regression', context, ...extras }) };
}

function history(count = 14, length = 3000) {
  return {
    messages: [
      { role: 'system', content: 'Follow the current user request.', timestamp: 0 },
      ...Array.from({ length: count }, (_, index) => index % 2
        ? assistant(`record-${index}: ` + 'observation '.repeat(Math.ceil(length / 12)), index + 1)
        : user(`record-${index}: ` + 'request '.repeat(Math.ceil(length / 8)), index + 1)),
      user('CURRENT REQUEST: continue from the verified results.', count + 1),
    ],
  };
}

test('repeating the same context reuses its stable projection without another completion event', async t => {
  const { transform, calls, events } = fixture(t);
  const context = history();
  const original = structuredClone(context);
  const first = await transform(context);
  const callCount = calls.length;
  assert.ok(callCount > 0, 'fixture must actually run a summary');
  assert.ok(estimateContextTokens(first) < estimateContextTokens(context));
  const completed = events.filter(event => event.type === 'context.compacted').length;
  await delay(5);
  const second = await transform(context);
  assert.equal(calls.length, callCount, 'unchanged evidence must not consume another summary call');
  assert.deepEqual(second, first, 'repeated projection must not fabricate new message timestamps');
  assert.equal(events.filter(event => event.type === 'context.compacted').length, completed,
    'a reused projection must not restart the UI summary completion cycle');
  assert.deepEqual(context, original, 'the original checkpoint must remain untouched');
  const starts = events.filter(event => event.type === 'context.summary_start');
  const ends = events.filter(event => event.type === 'context.summary_end');
  assert.equal(starts.length, 1, 'one reminder spans all fresh artifact summaries');
  assert.equal(ends.length, 1, 'cache reuse must not repeat the reminder');
  assert.equal(ends[0].operationId, starts[0].operationId);
  assert.equal(ends[0].status, 'completed');
  assert(ends[0].text.includes('Earlier observations'));
  assert.equal(ends[0].beforeTokens, estimateContextTokens(context));
  assert.equal(ends[0].afterTokens, estimateContextTokens(first));
  assert(ends[0].endedAt >= starts[0].startedAt);
});

test('restarting the middleware reuses an unchanged projection without summary success notifications', async t => {
  const original = fixture(t);
  const context = history();
  const first = await original.transform(context);
  assert.ok(original.calls.length > 0);
  await original.runtime.close();
  const restarted = fixture(t, {}, original.store);
  const restored = await restarted.transform(context);
  assert.equal(restarted.calls.length, 0);
  assert.deepEqual(restored, first);
  assert.equal(restarted.events.filter(event => event.type === 'context.compacted').length, 0,
    'restoring an existing summary must not show a fresh summary completion');
  assert.deepEqual(await restarted.transform(restored), restored);
  assert.equal(restarted.calls.length, 0);
});

test('feeding compacted output back through the middleware never summarizes its own summaries', async t => {
  const { transform, calls } = fixture(t, {
    triggerMessages: 6, keepRecentMessages: 2, maxSummaryTokens: 512,
    summarize: async () => 'Verified evidence. '.repeat(50),
  });
  const context = history(8, 6000);
  context.messages[0].content += 'Mandatory instruction. '.repeat(300);
  const first = await transform(context);
  const callCount = calls.length;
  assert.ok(callCount > 0);
  let current = first;
  for (let attempt = 0; attempt < 3; attempt++) current = await transform(current);
  assert.equal(calls.length, callCount, 'previously compacted evidence is not new work');
  assert.deepEqual(current, first, 'compacted context must reach a fixed point');
});

test('appending messages reuses historical summaries, including after middleware restart', async t => {
  const firstRuntime = fixture(t);
  const context = history();
  await firstRuntime.transform(context);
  const summarizedSources = new Set(firstRuntime.calls.map(call => call.text));
  assert.ok(summarizedSources.size > 0);
  await firstRuntime.runtime.close();
  const nextRuntime = fixture(t, {}, firstRuntime.store);
  const extended = {
    messages: [...context.messages,
      assistant('NEW EVIDENCE A: ' + 'finished '.repeat(400), 100),
      user('NEW REQUEST B: ' + 'inspect '.repeat(400), 101),
      assistant('NEW EVIDENCE C: ' + 'checked '.repeat(400), 102),
      user('NEW CURRENT REQUEST: finish the task.', 103)],
  };
  const output = await nextRuntime.transform(extended);
  assert.ok(nextRuntime.calls.length > 0, 'newly old messages should become eligible for compaction');
  assert.ok(nextRuntime.calls.every(call => !summarizedSources.has(call.text)),
    'durably cached historical evidence must never be summarized again');
  assert.ok(nextRuntime.calls.every(call => !call.text.includes('record-0:')),
    'extending a conversation must not regenerate a summary of its unchanged oldest prefix');
  assert.equal(textOf(output.messages.at(-1)), 'NEW CURRENT REQUEST: finish the task.');
});

test('appending to a compacted transcript only summarizes new eligible evidence', async t => {
  const { transform, calls } = fixture(t, {
    triggerMessages: 6, keepRecentMessages: 2, maxSummaryTokens: 512,
    summarize: async () => 'SUMMARY ALREADY PRODUCED. '.repeat(35),
  });
  const first = await transform(history(8, 6000));
  const previousCalls = calls.length;
  const extended = { messages: [...first.messages,
    assistant('NEW OBSERVATION A: ' + 'finished '.repeat(700), 100),
    user('NEW REQUEST B: ' + 'inspect '.repeat(700), 101),
    assistant('NEW OBSERVATION C: ' + 'checked '.repeat(700), 102),
    user('NEW CURRENT REQUEST: complete the task.', 103)],
  };
  const output = await transform(extended);
  assert.ok(calls.length > previousCalls, 'newly old evidence should be summarized');
  assert.ok(calls.slice(previousCalls).every(call => !call.text.includes('SUMMARY ALREADY PRODUCED.')),
    'adding new messages must not make earlier summary messages eligible again');
  assert.equal(textOf(output.messages.at(-1)), 'NEW CURRENT REQUEST: complete the task.');
});

test('many short messages compact below the message trigger and stay compacted', async t => {
  const { transform, calls } = fixture(t, { triggerTokens: 10000, targetTokens: 4000 });
  const context = history(40, 80);
  assert.ok(estimateContextTokens(context) < 10000, 'this case must exercise the message threshold');
  const first = await transform(context);
  assert.ok(first.messages.length < 12,
    `message threshold must be relieved; ${first.messages.length} messages remain`);
  assert.equal(textOf(first.messages.at(-1)), textOf(context.messages.at(-1)));
  const callCount = calls.length;
  assert.ok(callCount > 0);
  assert.deepEqual(await transform(first), first);
  assert.equal(calls.length, callCount);
});

test('large tool output preserves the call envelope, images, and recoverable exact evidence', async t => {
  const { runtime, transform, calls } = fixture(t);
  const source = 'EXACT TOOL EVIDENCE: ' + 'line with an observed value\n'.repeat(700);
  const image = { type: 'image', mimeType: 'image/png', data: 'local-fixture-image' };
  const context = {
    messages: [user('Inspect the file.'),
      { role: 'assistant', content: [{ type: 'toolCall', id: 'tool-17', name: 'read_file', arguments: { path: 'report.txt' } }], timestamp: 2 },
      { role: 'toolResult', toolCallId: 'tool-17', toolName: 'read_file', isError: false,
        content: [{ type: 'text', text: source }, image], timestamp: 3 },
      user('CURRENT REQUEST: explain these observations.', 4)],
  };
  const output = await transform(context);
  const result = output.messages.find(message => message.role === 'toolResult');
  assert.equal(result.toolCallId, 'tool-17');
  assert.equal(result.toolName, 'read_file');
  assert.equal(result.isError, false);
  assert.deepEqual(result.content.find(part => part.type === 'image'), image);
  assert.deepEqual(output.messages.find(message => message.role === 'assistant'), context.messages[1]);
  const artifactId = /exact source artifact: ([a-f0-9]{64})/.exec(textOf(result))?.[1];
  assert.ok(artifactId, 'compacted tool output must retain a recoverable artifact');
  assert.equal((await runtime.readEvidence(artifactId, { scope: 'chat:regression', limit: 32768 })).text, source);
  const callCount = calls.length;
  assert.deepEqual(await transform(output), output);
  assert.equal(calls.length, callCount);
});

test('an archived tool result is not sent for another summary when it remains above the text threshold', async t => {
  const { transform, calls } = fixture(t, {
    maxSummaryTokens: 1500, summarize: async () => 'Detailed verified observation. '.repeat(80),
  });
  const context = {
    messages: [
      { role: 'system', content: 'Mandatory instruction. '.repeat(300), timestamp: 0 },
      { role: 'assistant', content: [{ type: 'toolCall', id: 'tool-long', name: 'inspect', arguments: {} }], timestamp: 1 },
      { role: 'toolResult', toolCallId: 'tool-long', toolName: 'inspect',
        content: [{ type: 'text', text: 'Original tool evidence. '.repeat(800) }], timestamp: 2 },
      user('CURRENT REQUEST: use the evidence.', 3),
    ],
  };
  const first = await transform(context);
  assert.equal(calls.length, 1);
  assert.ok(textOf(first.messages.find(message => message.role === 'toolResult')).length > 2048);
  assert.deepEqual(await transform(first), first);
  assert.equal(calls.length, 1, 'the archived-tool wrapper is evidence already processed by this middleware');
});

test('new output for the same tool call is new evidence and is not mistaken for an old projection', async t => {
  const { transform, calls, runtime } = fixture(t);
  const context = {
    messages: [
      { role: 'assistant', content: [{ type: 'toolCall', id: 'tool-changing', name: 'inspect', arguments: {} }], timestamp: 1 },
      { role: 'toolResult', toolCallId: 'tool-changing', toolName: 'inspect',
        content: [{ type: 'text', text: 'INITIAL EVIDENCE: ' + 'initial '.repeat(1800) }], timestamp: 2 },
      user('CURRENT REQUEST: use the evidence.', 3),
    ],
  };
  await transform(context);
  const updated = structuredClone(context);
  const newSource = 'UPDATED EVIDENCE: ' + 'updated '.repeat(1800);
  updated.messages[1].content[0].text = newSource;
  const output = await transform(updated);
  assert.equal(calls.length, 2, 'projection identity must include the content, not only toolCallId');
  const artifactId = /exact source artifact: ([a-f0-9]{64})/.exec(textOf(output.messages[1]))?.[1];
  assert.ok(artifactId);
  assert.equal((await runtime.readEvidence(artifactId, { scope: 'chat:regression', limit: 32768 })).text, newSource);
});

test('archived parallel tool batches keep a deterministic execution manifest and exact source', async t => {
  const { transform, runtime } = fixture(t, { keepRecentMessages: 2 });
  const context = history(2, 100);
  const call = { role: 'assistant', content: [
    { type: 'toolCall', id: 'archive-a', name: 'inspect', arguments: { file: 'a' } },
    { type: 'toolCall', id: 'archive-b', name: 'inspect', arguments: { file: 'b' } },
  ], timestamp: 100 };
  const resultB = { role: 'toolResult', toolCallId: 'archive-b', toolName: 'inspect', content: [{ type: 'text', text: 'B succeeded. '.repeat(500) }], timestamp: 101 };
  const resultA = { role: 'toolResult', toolCallId: 'archive-a', toolName: 'inspect', content: [{ type: 'text', text: 'A failed. '.repeat(500) }], isError: true, timestamp: 102 };
  context.messages.push(call, resultB, resultA, assistant('Both tool outcomes are known.', 103),
    user('Continue.', 104), assistant('Continue with the next step.', 105), user('CURRENT REQUEST: finish.', 106));
  const output = await transform(context);
  assert.equal(output.messages.some(message => message.role === 'toolResult'), false);
  const archived = output.messages.find(message => textOf(message).includes('Host execution manifest:'));
  assert.ok(archived);
  const body = textOf(archived);
  const manifest = JSON.parse(/Host execution manifest: (.+)/.exec(body)[1]);
  assert.deepEqual(manifest.map(entry => [entry.id, entry.state]), [['archive-a', 'result_received'], ['archive-b', 'result_received']]);
  assert.deepEqual(manifest.map(entry => [entry.outcome, entry.paths]), [['error', ['a']], ['returned', ['b']]],
    'a returned error must not be remembered as a successful tool action');
  const artifactId = /Original artifact: ([a-f0-9]{64})/.exec(body)[1];
  const original = JSON.parse((await runtime.readEvidence(artifactId, { scope: 'chat:regression', limit: 32768 })).text);
  assert.deepEqual(original.filter(message => message.role === 'toolResult'), [resultB, resultA]);
});

test('short history aggregation never splits a parallel tool batch at the recent-message boundary', async t => {
  const { transform } = fixture(t, { triggerTokens: 10000, targetTokens: 4000, keepRecentMessages: 1 });
  const context = history(30, 80);
  const call = { role: 'assistant', content: [
    { type: 'toolCall', id: 'parallel-a', name: 'inspect', arguments: { file: 'a' } },
    { type: 'toolCall', id: 'parallel-b', name: 'inspect', arguments: { file: 'b' } },
  ], timestamp: 100 };
  const resultB = { role: 'toolResult', toolCallId: 'parallel-b', toolName: 'inspect', content: [{ type: 'text', text: 'B succeeded.' }], timestamp: 101 };
  const request = user('CURRENT REQUEST: compare both results.', 102);
  const resultA = { role: 'toolResult', toolCallId: 'parallel-a', toolName: 'inspect', content: [{ type: 'text', text: 'A succeeded.' }], timestamp: 103 };
  context.messages.push(call, resultB, request, resultA);
  const output = await transform(context);
  assert.ok(output.messages.length < 12, 'eligible short history should be compacted');
  assert.deepEqual(output.messages.slice(-4), [call, resultB, request, resultA],
    'keeping one result recent must protect its complete parallel call batch');
});

test('crossing a trigger without any compressible content does not report a successful compaction', async t => {
  const { transform, events, calls } = fixture(t);
  const context = { messages: [
    { role: 'system', content: 'Mandatory instructions. '.repeat(600), timestamp: 0 },
    user('CURRENT REQUEST: follow these instructions.'),
  ] };
  assert.deepEqual(await transform(context), context);
  assert.deepEqual(await transform(context), context);
  assert.equal(calls.length, 0);
  assert.equal(events.filter(event => event.type === 'context.compacted').length, 0,
    'a no-op must not send the UI through summary-success repeatedly');
});

test('protected context that cannot fit fails with a budget error without repeated summary calls', async t => {
  const { transform, calls } = fixture(t);
  const context = { messages: [
    { role: 'system', content: 'Mandatory instructions. '.repeat(900), timestamp: 0 },
    user('Keep the instructions and answer this request.'),
  ] };
  await assert.rejects(transform(context, { model: { contextWindow: 4096, maxTokens: 1024 } }),
    { code: 'CONTEXT_BUDGET_EXCEEDED' });
  assert.equal(calls.length, 0, 'protected material cannot be summarized to evade its budget');
});

test('summary call limits remain bounded across repeated transforms and restarts', async t => {
  const options = { maxSummaryCalls: 1, maxSummaryCallsPerScope: 1 };
  const firstRuntime = fixture(t, options);
  const context = history();
  await firstRuntime.transform(context);
  assert.equal(firstRuntime.calls.length, 1);
  await firstRuntime.transform(context);
  assert.equal(firstRuntime.calls.length, 1);
  await firstRuntime.runtime.close();
  const nextRuntime = fixture(t, options, firstRuntime.store);
  await nextRuntime.transform(history(18, 3500));
  assert.equal(nextRuntime.calls.length, 0, 'restart must not reset the durable scope call budget');
});

test('cancelling a summary stops the transform and allows the scope to run again', async t => {
  const controller = new AbortController();
  const cancelReason = new Error('fixture cancelled');
  const { transform, events, calls } = fixture(t, {
    summarize: async () => {
      if (!controller.signal.aborted) {
        controller.abort(cancelReason);
        return new Promise(() => {});
      }
      return 'Recovered summary after cancellation.';
    },
  });
  const context = history();
  await assert.rejects(transform(context, { signal: controller.signal }), error => error === cancelReason);
  assert.equal(events.filter(event => event.type === 'context.compacted').length, 0);
  assert.equal(events.find(event => event.type === 'context.summary_end').status, 'interrupted');
  const output = await transform(context);
  assert.ok(calls.length > 1, 'aborted work must not poison the scope queue');
  assert.ok(estimateContextTokens(output) < estimateContextTokens(context));
});

test('failed auxiliary summaries finish the reminder with truthful fallback excerpts', async t => {
  const { transform, events } = fixture(t, { summarize: async () => { throw new Error('Provider unavailable'); } });
  await transform(history());
  const end = events.find(event => event.type === 'context.summary_end');
  assert.equal(end.status, 'completed'); assert.equal(end.fallback, true);
  assert.match(end.text, /Summary unavailable/);
  assert(end.text.length <= 12000);
});

test('large evidence is summarized contiguously including its middle and reuses the durable result', async t => {
  const source = '前'.repeat(2200) + 'MIDDLE_FAILURE: src/main.js test failed' + '😀'.repeat(2200);
  const options = { triggerTokens: 1000, targetTokens: 500, maxSummaryInputTokens: 1200, maxSummaryTokens: 1024,
    summarize: async ({ text }) => text.includes('MIDDLE_FAILURE') ? 'MIDDLE_FAILURE: src/main.js test failed' : 'Other source segment.' };
  const first = fixture(t, options);
  const context = { messages: [
    { role: 'assistant', content: [{ type: 'toolCall', id: 'long', name: 'inspect', arguments: {} }] },
    { role: 'toolResult', toolCallId: 'long', content: [{ type: 'text', text: source }] }, user('Continue')
  ] };
  const result = await first.transform(context);
  assert.ok(first.calls.length > 1);
  assert.equal(first.calls.map(call => call.text).join(''), source, 'no middle evidence is skipped');
  let offset = 0;
  for (const call of first.calls) {
    assert.equal(call.sourceOffset, offset);
    assert.equal(call.sourceLength, source.length);
    assert.equal(call.text.isWellFormed(), true);
    assert.match(call.instructions, /Open work and next action/);
    assert.ok(estimateContextTokens({ messages: [
      { role: 'system', content: call.instructions, timestamp: 0 }, { role: 'user', content: call.text, timestamp: 0 }
    ] }) <= options.maxSummaryInputTokens);
    offset += call.text.length;
  }
  assert.match(textOf(result.messages[1]), /MIDDLE_FAILURE/);
  const restarted = fixture(t, options, first.store);
  assert.deepEqual(await restarted.transform(context), result);
  assert.equal(restarted.calls.length, 0);
});

test('unreviewed source after a segment call limit is explicitly marked and still recoverable', async t => {
  const source = 'x'.repeat(18000) + 'TAIL_EVIDENCE';
  const { transform, calls, runtime } = fixture(t, { triggerTokens: 1000, targetTokens: 500, maxSummaryInputTokens: 1200, maxSummaryCalls: 1 });
  const result = await transform({ messages: [
    { role: 'assistant', content: [{ type: 'toolCall', id: 'limited', name: 'inspect', arguments: {} }] },
    { role: 'toolResult', toolCallId: 'limited', content: [{ type: 'text', text: source }] }, user('Continue')
  ] });
  assert.equal(calls.length, 1);
  const body = textOf(result.messages[1]);
  assert.match(body, /Summary unavailable/);
  const id = /exact source artifact: ([a-f0-9]{64})/.exec(body)[1];
  assert.equal((await runtime.readEvidence(id, { scope: 'chat:regression', limit: 32768 })).text, source);
});

test('fact compaction preserves unresolved coverage, evidence IDs, failures and next actions', async t => {
  const { transform } = fixture(t, { triggerTokens: 1000, targetTokens: 500 });
  const fact = { version: 1, outcome: 'partial', statement: 'Implementation observed. '.repeat(500),
    coverage: [{ point: 'validate changes', status: 'partial', result: 'Build not run' }],
    evidence: [{ toolCallId: 'edit-1', observation: 'src/main.js changed' }],
    failedChecks: ['test-1 failed'], limitations: ['No build available'], nextSteps: ['Run build after restoring dependencies'] };
  const blackboard = { goal: 'verify', nodes: [{ ref: 'f1', kind: 'fact', fact: JSON.stringify(fact) }] };
  const boardText = JSON.stringify(blackboard);
  const result = await transform({ messages: [user(boardText)] }, { blackboard, evidence: { messageIndex: 0, boardText } });
  const node = JSON.parse(textOf(result.messages[0])).nodes[0];
  assert.ok(node.factArtifactId);
  const compacted = JSON.parse(node.fact);
  for (const key of ['outcome', 'coverage', 'evidence', 'failedChecks', 'limitations', 'nextSteps']) assert.deepEqual(compacted[key], fact[key]);
});
