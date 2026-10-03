import test from 'node:test';
import assert from 'node:assert/strict';
import { createProcessOutput } from '../process-output.mjs';

test('rolling blocks evict old allocations and preserve the exact tail across many flushes', () => {
  const limit = 4096, output = createProcessOutput(limit, undefined, { rolling: () => true });
  let expected = '';
  for (let i = 0; i < 10000; i++) {
    const line = `日志 ${i}\n`;
    expected = (expected + line).slice(-5000);
    output.write(Buffer.from(line)); output.flush();
  }
  const encoded = Buffer.from(expected);
  let start = encoded.length - limit;
  while ((encoded[start] & 0xc0) === 0x80) start++;
  assert.equal(output.finish(), encoded.subarray(start).toString('utf8'));
  assert.equal(output.finish(), encoded.subarray(start).toString('utf8'));
});

test('resident logs retain a Unicode-safe tail and keep streaming beyond the output limit', () => {
  let resident = false;
  const updates = [], output = createProcessOutput(32, item => updates.push(item.content[0].text), { rolling: () => resident });
  output.write(Buffer.from('ready\n')); output.flush();
  resident = true;
  for (let i = 0; i < 1000; i++) {
    assert.equal(output.write(Buffer.from('日志' + i + '\n')), true);
    output.flush();
  }
  const final = output.finish();
  assert(Buffer.byteLength(final) <= 32);
  assert.match(final, /日志999/);
  assert(!final.includes('\ufffd'));
  assert.equal(output.truncated, true);
  assert.match(updates.at(-1), /日志999/);
});

test('stderr packet boundaries do not insert prefixes into words or consume the output budget', () => {
  const output = createProcessOutput(14);
  for (const byte of Buffer.from('error')) assert.equal(output.write(Buffer.from([byte]), true), true);
  assert.equal(output.finish(), '[stderr] error');
});

test('ten thousand tiny chunks produce one notification and flush only once at completion', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const updates = [], output = createProcessOutput(20000, item => updates.push(item.content[0].text));
  for (let i = 0; i < 10000; i++) output.write(Buffer.from('x'));
  assert.equal(updates.length, 0);
  assert.equal(output.finish(), 'x'.repeat(10000));
  assert.equal(updates.length, 1);
  assert.equal(output.finish(), updates[0]);
  assert.equal(output.write(Buffer.from('late')), false);
  output.end(); output.flush(); t.mock.timers.tick(1000);
  assert.equal(updates.length, 1);
});

test('sparse output flushes on time and sustained output flushes on size', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const updates = [], output = createProcessOutput(200000, item => updates.push(item.content[0].text));
  output.write(Buffer.from('first'));
  t.mock.timers.tick(15); assert.equal(updates.length, 0);
  t.mock.timers.tick(1); assert.deepEqual(updates, ['first']);
  for (let i = 0; i < 100; i++) output.write(Buffer.alloc(1024, 'x'));
  assert.equal(updates.length, 4);
  assert.equal(output.finish(), updates.join(''));
  assert.equal(updates.length, 5);
});

test('split Unicode, interleaved stderr and malformed bytes respect the decoded byte budget', () => {
  const output = createProcessOutput(100);
  const text = Buffer.from('中文');
  output.write(text.subarray(0, 2)); output.write(Buffer.from('warning'), true); output.write(text.subarray(2));
  output.end(); output.end(true);
  assert.equal(output.finish(), '[stderr] warning中文');
  for (const stderr of [false, true]) {
    const bounded = createProcessOutput(16);
    assert.equal(bounded.write(Buffer.alloc(16, 255), stderr), false);
    assert(Buffer.byteLength(bounded.finish()) <= 16);
    assert.equal(bounded.truncated, true);
  }
  const partial = createProcessOutput(2);
  partial.write(Buffer.from([0xe4])); partial.end();
  assert.equal(partial.truncated, true);
  assert.equal(partial.finish(), '');
});

test('stream-only output is delivered without retaining a second result', () => {
  const updates = [], output = createProcessOutput(100000, item => updates.push(item.content[0].text), { captureOutput: false });
  output.write(Buffer.alloc(40000, 'x')); output.write(Buffer.from('last'));
  assert.equal(output.finish(), '');
  assert.equal(updates.join(''), 'x'.repeat(40000) + 'last');
  assert.equal(output.finish(), '');
});

test('observers may finish reentrantly or reject without duplicating output', async () => {
  let nested, calls = 0;
  const output = createProcessOutput(100, () => { calls++; nested = output.finish(); return Promise.reject(new Error('observer')); });
  output.write(Buffer.from('last'));
  assert.equal(output.finish(), 'last'); assert.equal(nested, 'last');
  assert.equal(calls, 1);
  await new Promise(resolve => setImmediate(resolve));
});
