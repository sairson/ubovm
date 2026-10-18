import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePlan, parseWorkerFact } from '../protocol.mjs';

const plan = { steps: [{ description: 'open the file', doneWhen: 'contents are visible' }] };
const fact = { outcome: 'blocked', statement: 'No evidence available', limitations: ['unavailable'] };

test('unknown extra fields are ignored instead of failing the object', () => {
  const valid = { description: 'finish the check', doneWhen: 'the check passes' };
  assert.equal(parsePlan(JSON.stringify({ ok: true, steps: [valid] })).steps.length, 1);
  assert.deepEqual(parsePlan('{"ok":true,"done":true}', { replan: true }), { done: true, steps: [] });
  assert.equal(parsePlan(JSON.stringify({ ok: true, steps: [{ ...valid, status: 'new' }] })).steps[0].description, 'finish the check');
  // A genuinely missing required field is still reported.
  assert.throws(() => parsePlan('{"ok":true}'), { code: 'INVALID_PLAN' });
  assert.throws(() => parsePlan('{"ok":true,"done":false}'), { code: 'INVALID_PLAN' });
});

test('replanning decisions treat done as authoritative and ignore stray steps', () => {
  const valid = { description: 'finish the check', doneWhen: 'the check passes' };
  // done:true wins whether steps is absent, empty, or a leftover schema echo.
  assert.deepEqual(parsePlan('{"done":true}', { replan: true }), { done: true, steps: [] });
  assert.deepEqual(parsePlan('{"done":true,"steps":[]}', { replan: true }), { done: true, steps: [] });
  assert.deepEqual(parsePlan(JSON.stringify({ done: true, steps: [valid] }), { replan: true }), { done: true, steps: [] });
  // done:false still requires a real, valid plan.
  assert.equal(parsePlan(JSON.stringify({ done: false, steps: [valid] }), { replan: true }).steps.length, 1);
  for (const bad of ['{"done":false}', '{"done":false,"steps":[]}', '{"steps":[{"description":"x","doneWhen":"y"}]}']) {
    assert.throws(() => parsePlan(bad, { replan: true }), { code: 'INVALID_PLAN' });
  }
});

test('plans and facts accept commentary, fences and a later JSON object', () => {
  const wrapped = `Sure.\n\`\`\`json\n${JSON.stringify(plan)}\n\`\`\`\nLet me know if you want more steps.`;
  assert.deepEqual(parsePlan(wrapped).steps[0].description, 'open the file');
  const later = `Scratch: {"done":true}\n${JSON.stringify({ done: false, ...plan })}`;
  assert.equal(parsePlan(later, { replan: true }).done, false);
  assert.equal(parsePlan(`<think>not json {</think>\n${JSON.stringify(plan)}`).steps.length, 1);
  assert.equal(parseWorkerFact(`Here is the fact:\n\`\`\`\n${JSON.stringify(fact)}\n\`\`\``).outcome, 'blocked');
  assert.equal(parsePlan('```json' + JSON.stringify(plan) + '```').steps.length, 1);
  assert.equal(parsePlan(JSON.stringify({
    steps: [{ description: 'look for {braces} in the file', doneWhen: 'contents are visible' }]
  })).steps[0].description, 'look for {braces} in the file');
  const preamble = `note ${'x'.repeat(40_000)}\n${JSON.stringify(plan)}`;
  assert.equal(parsePlan(preamble).steps[0].description, 'open the file');
  assert.equal(parseWorkerFact(`lead-in ${'y'.repeat(30_000)}\n${JSON.stringify(fact)}`).outcome, 'blocked');
});

test('invalid fragments still fail instead of inventing a plan', () => {
  assert.throws(() => parsePlan('I will inspect the repository.'), { code: 'INVALID_PLAN' });
  assert.throws(() => parsePlan('{"steps":'), { code: 'INVALID_PLAN' });
});
