import test from 'node:test';
import assert from 'node:assert/strict';
import { parseWorkerFact } from '../protocol.mjs';

const evidence = { toolCallId: 'check-1', observation: 'src/main.js updated; build not run' };
const ledger = [{ toolCallId: 'check-1', status: 'completed', isError: false }];
const fact = { outcome: 'partial', statement: 'Change applied; validation remains',
  evidence: [evidence, evidence], coverage: [{ point: 'validate', status: 'partial', result: 'Build not run' }],
  limitations: ['Build not run'], failedChecks: [], nextSteps: ['Run the build', 'Run the build'] };

test('facts keep actionable handoff work, deduplicate evidence and survive normalization', () => {
  const options = { ledger, keyPoints: ['validate'] };
  const normalized = parseWorkerFact(JSON.stringify(fact), options);
  assert.deepEqual(normalized.nextSteps, ['Run the build']);
  assert.deepEqual(normalized.evidence, [evidence]);
  assert.equal(normalized.outcome, 'partial');
  assert.deepEqual(parseWorkerFact(JSON.stringify(normalized), options), normalized);
  assert.equal(parseWorkerFact(JSON.stringify({ ...fact, outcome: 'confirmed', coverage: [{ point: 'validate', status: 'confirmed', result: 'Claimed done' }] }), options).outcome, 'partial',
    'remaining required actions prevent a completed outcome');
});

test('legacy facts remain compatible and next actions cannot substitute for verified evidence', () => {
  const legacy = parseWorkerFact('{"outcome":"blocked","statement":"No access"}');
  assert.equal(Object.hasOwn(legacy, 'nextSteps'), false);
  assert.throws(() => parseWorkerFact('{"outcome":"confirmed","statement":"Done","nextSteps":["Run tests"]}'), { code: 'INVALID_FACT' });
  assert.throws(() => parseWorkerFact(JSON.stringify({ ...fact, nextSteps: [123] }), { ledger, keyPoints: ['validate'] }), { code: 'INVALID_FACT' });
});

test('optional fact lists discard blank placeholders while preserving real entries', () => {
  const options = { ledger, keyPoints: ['validate'] };
  const normalized = parseWorkerFact(JSON.stringify({ ...fact,
    failedChecks: ['', '  ', ' Build failed ', 'Build failed'],
    limitations: ['\t\n', ' Build not run '], nextSteps: ['', ' Run the build ', 'Run the build']
  }), options);
  assert.deepEqual(normalized.failedChecks, ['Build failed']);
  assert.deepEqual(normalized.limitations, ['Build not run']);
  assert.deepEqual(normalized.nextSteps, ['Run the build']);
  assert.deepEqual(parseWorkerFact(JSON.stringify(normalized), options), normalized);
  const empty = parseWorkerFact(JSON.stringify({ outcome: 'blocked', statement: 'No access',
    failedChecks: [''], limitations: [' '], nextSteps: ['\n'] }));
  for (const field of ['failedChecks', 'limitations', 'nextSteps']) assert.deepEqual(empty[field], []);
});

test('optional fact lists still reject invalid types and enforce original limits', () => {
  for (const field of ['failedChecks', 'limitations', 'nextSteps']) {
    for (const value of [[null], [{}], [123], [false], 'failure', [' '.repeat(8193)], Array(65).fill('')]) {
      assert.throws(() => parseWorkerFact(JSON.stringify({ outcome: 'blocked', statement: 'No access', [field]: value })),
        { code: 'INVALID_FACT' });
    }
  }
  assert.throws(() => parseWorkerFact(JSON.stringify({ outcome: 'blocked', statement: ' ' })), { code: 'INVALID_FACT' });
  assert.throws(() => parseWorkerFact(JSON.stringify({ outcome: 'confirmed', statement: 'Done', failedChecks: [''] })),
    { code: 'INVALID_FACT' });
});
