import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { sanitizeUsage, usageSignature, accumulateUsage } = require('../runtime/projection.cjs');

test('sanitizeUsage keeps nonnegative usage fields and drops invalid shapes', () => {
  assert.equal(sanitizeUsage(null), undefined);
  assert.equal(sanitizeUsage({ input: -1, output: 'x' }), undefined);
  assert.deepEqual(sanitizeUsage({
    input: 10, output: 2, cacheRead: 1, cacheWrite: 0, totalTokens: 13,
    cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.3, extra: 9 }
  }), {
    input: 10, output: 2, cacheRead: 1, cacheWrite: 0, totalTokens: 13,
    cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.3 }
  });
});

test('sanitizeUsage floors token counts and clamps to safe integers', () => {
  assert.deepEqual(sanitizeUsage({ input: 1.9, output: 2.1, totalTokens: Number.MAX_SAFE_INTEGER + 10 }), {
    input: 1, output: 2, totalTokens: Number.MAX_SAFE_INTEGER
  });
});

test('usageSignature is stable across object identity churn', () => {
  const usage = { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 12, cost: { total: 0.01 } };
  assert.equal(usageSignature(usage), usageSignature({ ...usage, cost: { ...usage.cost } }));
  assert.equal(usageSignature({ input: 0, output: 0, totalTokens: 0 }), '');
  assert.notEqual(usageSignature(usage), usageSignature({ ...usage, output: 3 }));
});

test('accumulateUsage sums assistant and worker replies for one turn', () => {
  const first = accumulateUsage(undefined, { input: 100, output: 20, totalTokens: 120, cost: { total: 0.01 } });
  const next = accumulateUsage(first, { input: 50, output: 5, cacheRead: 10, totalTokens: 65, cost: { total: 0.002 } });
  assert.deepEqual(next, {
    input: 150, output: 25, cacheRead: 10, cacheWrite: 0, totalTokens: 185,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.012 }
  });
  assert.equal(accumulateUsage(next, null), next);
});
