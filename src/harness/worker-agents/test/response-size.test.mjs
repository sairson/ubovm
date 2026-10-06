import test from 'node:test';
import assert from 'node:assert/strict';
import { AssistantMessageEventStream } from '@earendil-works/pi-ai';
import { createPiWorker } from '../worker_pi_agent.mjs';
import { createWorkerCheckpoint, restoreWorkerCheckpoint } from '../checkpoint.mjs';
import { parseWorkerFact } from '../protocol.mjs';

const model = { id: 'fixture', api: 'openai-completions', provider: 'fixture' };
const fact = JSON.stringify({ outcome: 'blocked', statement: 'No evidence available', limitations: ['unavailable'] });
function response(content, stopReason = 'stop') {
  const stream = new AssistantMessageEventStream();
  stream.push({ type: 'done', reason: stopReason, message: {
    role: 'assistant', content, stopReason, api: model.api, provider: model.provider, model: model.id, timestamp: 1,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }
  } });
  return stream;
}
function setup(phase = 'conclude') {
  const checkpoint = createWorkerCheckpoint({ intentId: 'intent', goal: 'verify' });
  checkpoint.phase = phase;
  if (phase === 'execute') checkpoint.plan = [{ description: 'write', doneWhen: 'saved' }];
  const saved = [];
  return { saved, args: { node: { id: 'intent', intent: { description: 'verify', keyPoints: [] } }, attempt: { id: 'attempt' }, checkpoint,
    getContext: () => ({ data: { goal: 'verify', nodes: [] }, text: 'verify' }), saveCheckpoint: async value => { saved.push(value); } } };
}

test('large thinking and signatures do not consume the report budget', async () => {
  const fixture = setup();
  const worker = createPiWorker({ model, streamFn: () => response([
    { type: 'thinking', thinking: '思'.repeat(10000), thinkingSignature: 's'.repeat(30000) }, { type: 'text', text: fact }
  ]) });
  assert.equal(JSON.parse((await worker(fixture.args)).content).outcome, 'blocked');
});

test('large tool arguments execute once and remain durable', async () => {
  const fixture = setup('execute');
  const content = '代码'.repeat(10000);
  let requests = 0, writes = 0;
  const worker = createPiWorker({ model, tools: [{ name: 'write', description: 'write', parameters: { type: 'object', properties: { content: { type: 'string' } }, required: ['content'] },
    execute: async (_id, args) => { writes++; assert.equal(args.content, content); return { content: [{ type: 'text', text: 'saved' }] }; } }],
    streamFn: () => {
      requests++;
      if (requests === 1) return response([{ type: 'toolCall', id: 'write-1', name: 'write', arguments: { content } }], 'toolUse');
      return response([{ type: 'text', text: requests === 2 ? 'saved' : requests === 3 ? '{"done":true}' : fact }]);
    } });
  await worker(fixture.args);
  assert.equal(writes, 1);
  assert.equal(fixture.saved.at(-1).ledger[0].args.content, content);
  assert.doesNotThrow(() => restoreWorkerCheckpoint(fixture.saved.at(-1), { intentId: 'intent', goal: 'verify' }));
});

test('onToolResult hook failures do not abort the worker after a finished tool call', async () => {
  const fixture = setup('execute');
  const events = [];
  let requests = 0;
  const worker = createPiWorker({ model, maxModelCalls: 8,
    onToolResult: async () => { throw Object.assign(new Error('Evidence store unavailable'), { code: 'EVIDENCE_STORE_FAILED' }); },
    onEvent: event => events.push(event.type),
    tools: [{ name: 'inspect', description: 'Inspect a scoped source',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      execute: async () => ({ content: [{ type: 'text', text: 'Source verified' }] }) }],
    streamFn: () => {
      requests++;
      if (requests === 1) return response([{ type: 'toolCall', id: 'inspect-1', name: 'inspect', arguments: { path: 'src' } }], 'toolUse');
      if (requests === 2) return response([{ type: 'text', text: 'verified' }]);
      if (requests === 3) return response([{ type: 'text', text: '{"done":true}' }]);
      return response([{ type: 'text', text: fact }]);
    }
  });
  const result = JSON.parse((await worker(fixture.args)).content);
  assert.equal(result.outcome, 'blocked');
  assert.equal(events.includes('tool_evidence_failed'), true);
  assert.equal(fixture.saved.at(-1).ledger[0].isError, false);
});

test('structured tool errors stay failures, allow corrective execution, and cannot support a finding', async () => {
  const fixture = setup('execute');
  let calls = 0;
  const executed = [];
  const worker = createPiWorker({ model, maxModelCalls: 8,
    tools: [{ name: 'inspect', description: 'Inspect a scoped source',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      execute: async (_id, args) => {
        executed.push(args.path);
        return args.path === 'missing' ? { isError: true, terminate: true, content: [{ type: 'text', text: 'Source unavailable' }], details: { reason: 'not found' } }
          : { content: [{ type: 'text', text: 'Source verified' }] };
      } }],
    streamFn: (_model, transcript) => {
      calls++;
      if (calls === 1) return response([{ type: 'toolCall', id: 'failed', name: 'inspect', arguments: { path: 'missing' } }], 'toolUse');
      if (calls === 2) {
        assert.equal(transcript.messages.find(message => message.role === 'toolResult').isError, true);
        return response([{ type: 'toolCall', id: 'verified', name: 'inspect', arguments: { path: 'actual-source' } }], 'toolUse');
      }
      if (calls === 3) return response([{ type: 'text', text: 'Corrected the source and verified it' }]);
      const evidence = transcript.messages.at(-1).content[0].text;
      const ledger = JSON.parse(evidence.split('Host tool evidence ledger:\n')[1]);
      assert.equal(ledger.every(entry => entry.arguments === undefined), true);
      assert.deepEqual(ledger.map(entry => [entry.toolCallId, entry.isError]), [['failed', true], ['verified', false]]);
      if (calls === 4) return response([{ type: 'text', text: '{"done":true}' }]);
      const source = calls === 5 ? 'failed' : 'verified';
      return response([{ type: 'text', text: JSON.stringify({ outcome: 'confirmed', statement: 'Scoped source verified',
        evidence: [{ toolCallId: source, observation: 'Source verified' }] }) }]);
    }
  });
  const result = JSON.parse((await worker(fixture.args)).content);
  assert.deepEqual(executed, ['missing', 'actual-source']);
  assert.equal(calls, 6, 'invalid failed-call citation gets a bounded repair without re-executing tools');
  assert.equal(result.evidence[0].toolCallId, 'verified');
  const saved = fixture.saved.at(-1);
  assert.equal(saved.ledger[0].isError, true);
  assert.deepEqual(saved.ledger[0].result.details, { reason: 'not found' });
  assert.doesNotThrow(() => restoreWorkerCheckpoint(saved, { intentId: 'intent', goal: 'verify' }));
});

test('legacy incorrectly successful ledger entries cannot cite explicitly failed tool results', () => {
  assert.throws(() => parseWorkerFact(JSON.stringify({ outcome: 'confirmed', statement: 'Unfounded claim',
    evidence: [{ toolCallId: 'failed', observation: 'No source found' }] }), {
    ledger: [{ toolCallId: 'failed', status: 'completed', isError: false, result: { isError: true, content: [] } }]
  }), { code: 'INVALID_FACT' });
});

test('UTF-8 report overflow gets one shortening request and can recover', async () => {
  const fixture = setup();
  let requests = 0;
  const worker = createPiWorker({ model, streamFn: (_model, transcript) => {
    if (++requests === 1) return response([{ type: 'text', text: '中'.repeat(8193) }]);
    assert.ok(transcript.messages.some(message => message.content?.some?.(part => part.text?.includes('24579 UTF-8 bytes'))));
    return response([{ type: 'text', text: fact }]);
  } });
  await worker(fixture.args);
  assert.equal(requests, 2);
});

test('repeated oversized reports fail with an actionable error and bounded retries', async () => {
  const fixture = setup();
  let requests = 0;
  const worker = createPiWorker({ model, streamFn: () => { requests++; return response([{ type: 'text', text: 'x'.repeat(24577) }]); } });
  await assert.rejects(worker(fixture.args), error => error.code === 'RESPONSE_TOO_LARGE' && /worker.maxResponseBytes/.test(error.message));
  assert.equal(requests, 2);
});

test('truncated tool arguments are discarded and repaired without executing partial writes', async () => {
  const fixture = setup('execute');
  let requests = 0, writes = 0;
  const worker = createPiWorker({ model,
    tools: [{ name: 'write', description: 'write', parameters: { type: 'object', properties: {} }, execute: async () => { writes++; return { content: [] }; } }],
    streamFn: () => {
      requests++;
      if (requests <= 2) return response([{ type: 'toolCall', id: 'call-' + requests, name: 'write', arguments: {} }], requests === 1 ? 'length' : 'toolUse');
      return response([{ type: 'text', text: requests === 3 ? 'saved' : requests === 4 ? '{"done":true}' : fact }]);
    } });
  await worker(fixture.args);
  assert.equal(writes, 1);
  assert.deepEqual(fixture.saved.at(-1).ledger.map(entry => entry.toolCallId), ['call-2']);
  assert.doesNotThrow(() => restoreWorkerCheckpoint(fixture.saved.at(-1), { intentId: 'intent', goal: 'verify' }));
});

test('repeated token truncation is bounded and leaves a recoverable checkpoint', async () => {
  const fixture = setup(); let requests = 0;
  const worker = createPiWorker({ model, streamFn: () => { requests++; return response([{ type: 'text', text: '{"outcome":' }], 'length'); } });
  await assert.rejects(worker(fixture.args), { code: 'MODEL_RESPONSE_TRUNCATED' });
  assert.equal(requests, 2);
  assert.doesNotThrow(() => restoreWorkerCheckpoint(fixture.saved.at(-1), { intentId: 'intent', goal: 'verify' }));
});

test('worker retries empty transient network failures within a phase', async () => {
  const fixture = setup(); let requests = 0;
  const events = [];
  const worker = createPiWorker({ model, onEvent: event => events.push(event), streamFn: () => {
    requests++;
    if (requests === 1) {
      const stream = new AssistantMessageEventStream();
      const message = {
        role: 'assistant', content: [], stopReason: 'error', errorMessage: 'fetch failed: ECONNRESET',
        api: model.api, provider: model.provider, model: model.id, timestamp: 1,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      };
      stream.push({ type: 'error', reason: 'error', error: message });
      return stream;
    }
    return response([{ type: 'text', text: fact }]);
  } });
  assert.equal(JSON.parse((await worker(fixture.args)).content).outcome, 'blocked');
  assert.equal(requests, 2);
  assert.ok(events.some(event => event.type === 'worker_network_retry'));
});

test('repair after a successful tool retains its result instead of replaying the operation', async () => {
  const fixture = setup('execute'); let requests = 0, writes = 0;
  const worker = createPiWorker({ model,
    tools: [{ name: 'write', description: 'write', parameters: { type: 'object', properties: {} }, execute: async () => { writes++; return { content: [{ type: 'text', text: 'durable result' }] }; } }],
    streamFn: (_model, transcript) => {
      requests++;
      if (requests === 1) return response([{ type: 'toolCall', id: 'successful', name: 'write', arguments: {} }], 'toolUse');
      if (requests === 2) return response([{ type: 'text', text: 'unfinished report' }], 'length');
      if (requests === 3) {
        assert.ok(transcript.messages.some(message => message.role === 'toolResult' && message.toolCallId === 'successful' && message.content[0].text === 'durable result'));
        assert.ok(!transcript.messages.some(message => message.role === 'assistant' && message.stopReason === 'length'));
      }
      return response([{ type: 'text', text: requests === 3 ? 'saved' : requests === 4 ? '{"done":true}' : fact }]);
    } });
  await worker(fixture.args); assert.equal(writes, 1);
});

test('cancellation holds the intent lock until an outstanding tool has stopped', { timeout: 5000 }, async () => {
  const fixture = setup('execute'), controller = new AbortController();
  let release, started;
  const gate = new Promise(resolve => { release = resolve; });
  const running = new Promise(resolve => { started = resolve; });
  let resume = false;
  const worker = createPiWorker({ model,
    tools: [{ name: 'write', description: 'write', parameters: { type: 'object', properties: {} }, execute: async () => { started(); await gate; return { content: [] }; } }],
    streamFn: () => resume ? response([{ type: 'text', text: fact }]) : response([{ type: 'toolCall', id: 'pending', name: 'write', arguments: {} }], 'toolUse') });
  const operation = worker({ ...fixture.args, signal: controller.signal });
  try {
    await running; controller.abort();
    await assert.rejects(operation, { code: 'ABORT_ERR' });
    await assert.rejects(worker(setup().args), { code: 'WORKER_BUSY' });
  } finally { release(); }
  await new Promise(resolve => setImmediate(resolve));
  resume = true;
  assert.equal(JSON.parse((await worker(setup().args)).content).outcome, 'blocked');
});

test('completion notifications reach the next model call without cancelling a running tool', async () => {
  const fixture = setup('execute'), controller = new AbortController();
  let notifications = [], calls = 0, finishedTool = false;
  const worker = createPiWorker({ model,
    tools: [{ name: 'work', description: 'work', parameters: { type: 'object', properties: {} }, execute: async (_id, _args, signal) => {
      notifications = [{ type: 'goal_completed', completion: { summary: 'verified elsewhere', evidenceIds: ['fact-id'] } }];
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(signal.aborted, false); finishedTool = true;
      return { content: [{ type: 'text', text: 'cleanup finished' }] };
    } }],
    streamFn: (_model, transcript) => {
      calls++;
      if (calls === 1) return response([{ type: 'toolCall', id: 'work-1', name: 'work', arguments: {} }], 'toolUse');
      assert.equal(finishedTool, true);
      assert.ok(transcript.messages.some(message => message.content?.some?.(part => part.text?.includes('verified elsewhere'))));
      return response([{ type: 'text', text: calls === 2 ? 'I finished cleanup.' : calls === 3 ? '{"done":true}' : fact }]);
    }
  });
  await worker({ ...fixture.args, signal: controller.signal, getMessages: () => notifications });
  assert.equal(controller.signal.aborted, false);
  assert.equal(calls, 4);
});

test('later worker phases keep the latest board and drop prior step history', async () => {
  const fixture = setup('plan');
  const bulky = 'BODY'.repeat(4000);
  let requests = 0;
  const texts = messages => messages.flatMap(message => {
    if (typeof message.content === 'string') return [message.content];
    return (message.content ?? []).map(part => part.text).filter(Boolean);
  });
  const worker = createPiWorker({
    model,
    tools: [{ name: 'inspect', description: 'inspect', parameters: { type: 'object', properties: {} },
      execute: async () => ({ content: [{ type: 'text', text: bulky }] }) }],
    streamFn: (_model, transcript) => {
      requests++;
      const blob = texts(transcript.messages).join('\n');
      if (requests === 1) return response([{ type: 'text', text: JSON.stringify({ steps: [
        { description: 'first', doneWhen: 'a' }, { description: 'second', doneWhen: 'b' }
      ] }) }]);
      if (requests === 2) return response([{ type: 'toolCall', id: 'inspect-1', name: 'inspect', arguments: {} }], 'toolUse');
      if (requests === 3) return response([{ type: 'text', text: 'first step done' }]);
      if (requests === 4) {
        assert.equal(blob.includes(bulky), false);
        const assignment = texts(transcript.messages).find(text => text.trim().startsWith('{') && text.includes('"completedSteps"'));
        const parsed = JSON.parse(assignment);
        assert.deepEqual(parsed.completedSteps, [{ description: 'first', doneWhen: 'a' }]);
        const ledger = JSON.parse(blob.split('Host tool evidence ledger:\n')[1]);
        assert.equal(ledger[0].arguments, undefined);
        assert.ok(ledger[0].observations[0].includes('[truncated]'));
        return response([{ type: 'text', text: JSON.stringify({ done: false, steps: [{ description: 'second', doneWhen: 'b' }] }) }]);
      }
      if (requests === 5) {
        assert.equal(blob.includes(bulky), false);
        assert.equal(blob.includes('first step done'), false);
        return response([{ type: 'text', text: 'second step done' }]);
      }
      if (requests === 6) return response([{ type: 'text', text: '{"done":true}' }]);
      return response([{ type: 'text', text: fact }]);
    }
  });
  await worker(fixture.args);
  assert.equal(fixture.saved.at(-1).ledger[0].result.content[0].text, bulky);
});
