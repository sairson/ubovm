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

test('mixed evidence keeps successful ledger citations and drops unknown or failed toolCallIds', () => {
  const options = {
    keyPoints: ['validate'],
    ledger: [
      { toolCallId: 'ok-1', status: 'completed', isError: false },
      { toolCallId: 'ok-2', status: 'completed', isError: false },
      { toolCallId: 'failed', status: 'completed', isError: true, result: { content: [] } },
      { toolCallId: 'soft-fail', status: 'completed', isError: false, result: { isError: true, content: [] } }
    ]
  };
  const normalized = parseWorkerFact(JSON.stringify({
    outcome: 'confirmed',
    statement: 'Validated with mixed citations',
    coverage: [{ point: 'validate', status: 'confirmed', result: 'Checked' }],
    evidence: [
      { toolCallId: 'ok-1', observation: 'first check' },
      { toolCallId: 'ok-2', observation: 'second check' },
      { toolCallId: 'missing', observation: 'invented' },
      { toolCallId: 'failed', observation: 'hard failure' },
      { toolCallId: 'soft-fail', observation: 'result error' },
      { toolCallId: 'ok-1', observation: 'first check' },
      { toolCallId: 'ghost', observation: 'seventh bad citation' }
    ],
    failedChecks: [],
    limitations: []
  }), options);
  assert.deepEqual(normalized.evidence, [
    { toolCallId: 'ok-1', observation: 'first check' },
    { toolCallId: 'ok-2', observation: 'second check' }
  ]);
  assert.match(normalized.limitations.join('\n'), /Dropped 4 evidence citation/);
  assert.throws(() => parseWorkerFact(JSON.stringify({
    outcome: 'confirmed', statement: 'No valid sources', evidence: [{ toolCallId: 'ghost', observation: 'missing' }]
  }), options), /Successful ledger toolCallIds: ok-1, ok-2/);
});

test('invalid nodeRef citations are dropped like invalid toolCallIds', () => {
  const context = {
    data: {
      root: 'n1',
      nodes: [
        { ref: 'n1', kind: 'root', fact: 'goal' },
        { ref: 'n2', kind: 'fact', fact: '{"outcome":"confirmed"}' },
        { ref: 'n3', kind: 'intent' }
      ]
    },
    resolveId: ref => ({ n1: 'root-id', n2: 'fact-id', n3: 'intent-id' })[ref]
  };
  const options = { keyPoints: ['validate'], context, ledger: [] };
  const normalized = parseWorkerFact(JSON.stringify({
    outcome: 'confirmed',
    statement: 'Fact node cited; root and intent aliases ignored',
    coverage: [{ point: 'validate', status: 'confirmed', result: 'Checked' }],
    evidence: [
      { nodeRef: 'n2', observation: 'recorded fact' },
      { nodeRef: 'n1', observation: 'root is not evidence' },
      { nodeRef: 'n3', observation: 'intent has no fact yet' },
      { nodeRef: 'n9', observation: 'missing alias' }
    ],
    failedChecks: [],
    limitations: []
  }), options);
  assert.deepEqual(normalized.evidence, [{ nodeRef: 'n2', observation: 'recorded fact' }]);
  assert.match(normalized.limitations.join('\n'), /Dropped 3 evidence citation/);
  assert.throws(() => parseWorkerFact(JSON.stringify({
    outcome: 'confirmed', statement: 'Only invalid node refs',
    evidence: [{ nodeRef: 'n1', observation: 'root' }]
  }), options), /non-root fact node alias/);
});

test('optional fact lists discard blank/object placeholders while preserving real entries', () => {
  const options = { ledger, keyPoints: ['validate'] };
  const normalized = parseWorkerFact(JSON.stringify({ ...fact,
    failedChecks: ['', '  ', ' Build failed ', 'Build failed', null, {}],
    limitations: ['\t\n', ' Build not run ', { text: 'Object-wrapped limitation' }],
    nextSteps: ['', null, { step: 'Run the build' }, { description: 'Retest edge case' }, 'Run the build']
  }), options);
  assert.deepEqual(normalized.failedChecks, ['Build failed']);
  assert.ok(normalized.limitations.includes('Object-wrapped limitation'));
  assert.deepEqual(normalized.nextSteps, ['Run the build', 'Retest edge case']);
  assert.deepEqual(parseWorkerFact(JSON.stringify(normalized), options), normalized);
  const empty = parseWorkerFact(JSON.stringify({ outcome: 'blocked', statement: 'No access',
    failedChecks: [''], limitations: [' '], nextSteps: ['\n'] }));
  for (const field of ['failedChecks', 'limitations', 'nextSteps']) assert.deepEqual(empty[field], []);
});

test('optional fact lists still reject invalid types and enforce original limits', () => {
  for (const field of ['failedChecks', 'limitations', 'nextSteps']) {
    for (const value of [[123], [false], 'failure', [' '.repeat(8193)]]) {
      assert.throws(() => parseWorkerFact(JSON.stringify({ outcome: 'blocked', statement: 'No access', [field]: value })),
        { code: 'INVALID_FACT' });
    }
  }
  assert.throws(() => parseWorkerFact(JSON.stringify({ outcome: 'blocked', statement: ' ' })), { code: 'INVALID_FACT' });
  assert.throws(() => parseWorkerFact(JSON.stringify({ outcome: 'confirmed', statement: 'Done', failedChecks: [''] })),
    { code: 'INVALID_FACT' });
});

test('coverage paraphrases bind to the original key points instead of failing the fact', () => {
  const points = ['Check login', 'Check logout', 'Check timeout', 'Check refresh', 'Check lockout', 'Check session isolation'];
  const options = { ledger, keyPoints: points };
  const normalized = parseWorkerFact(JSON.stringify({
    outcome: 'confirmed',
    statement: 'All session checks passed',
    coverage: [
      { point: 'check login', status: 'confirmed', result: 'ok' },
      { point: 'Check logout', status: 'confirmed', result: 'ok' },
      { point: 'Check timeout window', status: 'confirmed', result: 'ok' },
      { point: 'Check refresh', status: 'confirmed', result: 'ok' },
      { point: 'Check lockout', status: 'confirmed', result: 'ok' },
      { point: '6. sessions stay isolated per user', status: 'confirmed', result: 'ok' }
    ],
    evidence: [evidence]
  }), options);
  assert.deepEqual(normalized.coverage.map(item => item.point), points);
  assert.ok(normalized.coverage.every(item => item.status === 'confirmed'));
  const dropped = parseWorkerFact(JSON.stringify({
    outcome: 'partial',
    statement: 'Unrelated extra coverage ignored',
    coverage: [
      { point: 'Check login', status: 'confirmed', result: 'ok' },
      { point: 'unrelated extra check', status: 'confirmed', result: 'ok' },
      { point: 'another invented check', status: 'confirmed', result: 'ok' }
    ]
  }), { keyPoints: ['Check login', 'Check logout'] });
  assert.equal(dropped.coverage[1].point, 'Check logout');
  assert.equal(dropped.coverage[1].status, 'partial');
  assert.match(dropped.limitations.join('\n'), /Dropped 2 coverage item/);
});
