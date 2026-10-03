'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { lineChanges } = require('../../../harness/coding/line-changes.cjs');
test('line statistics match an independent LCS including repeated lines', () => {
  let seed = 12;
  const random = n => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed % n; };
  for (let run = 0; run < 300; run++) {
    const a = Array.from({ length: random(15) }, () => String(random(4)) + '\n');
    const b = Array.from({ length: random(15) }, () => String(random(4)) + '\n');
    const table = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
    for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) table[i][j] = a[i - 1] === b[j - 1] ? table[i - 1][j - 1] + 1 : Math.max(table[i - 1][j], table[i][j - 1]);
    const same = table[a.length][b.length];
    assert.deepEqual(lineChanges(a.join(''), b.join('')), { added: b.length - same, removed: a.length - same, approximate: false });
  }
  assert.deepEqual(lineChanges(null, '中文\r\n'), { added: 1, removed: 0, approximate: false });
  assert.deepEqual(lineChanges('x', 'x\n'), { added: 1, removed: 1, approximate: false });
  assert.equal(lineChanges('a\n'.repeat(2000), 'b\n'.repeat(2000)).approximate, true);
});
