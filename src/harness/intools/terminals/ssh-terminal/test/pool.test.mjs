import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { requireText } from '../../../shared/common.mjs';
// Exercise the actual pool source without opening SSH or loading SDK dependencies.
const source = readFileSync(new URL('../pool.mjs', import.meta.url), 'utf8')
  .replace(/^import .*;\r?\n/gm, '').replace('export class SSHCommandsPool', 'class SSHCommandsPool');
const SSHCommandsPool = runInNewContext(source + '\nSSHCommandsPool;', {
  SSHCommands: class {}, requireText, Promise, AggregateError
});

test('pool close attempts every connection and waits for cleanup before reporting failures', async () => {
  const pool = new SSHCommandsPool({ profiles: ['first', 'second', 'last'].map(id => ({ id, host: 'example.test', username: 'test', insecure_ignore_host_key: true })) });
  const attempted = [];
  let release;
  pool.get('first').close = () => { attempted.push('first'); throw Error('first close failed'); };
  pool.get('second').close = () => { attempted.push('second'); return new Promise(resolve => { release = resolve; }); };
  pool.get('last').close = async () => { attempted.push('last'); throw Error('last close failed'); };
  let settled = false;
  const closing = pool.close();
  const observed = closing.then(() => { settled = true; }, error => { settled = true; return error; });
  await new Promise(resolve => setImmediate(resolve));
  try {
    assert.deepEqual(attempted, ['first', 'second', 'last']);
    assert.equal(settled, false, 'failed connection must not bypass sibling cleanup');
  } finally { release?.(); }
  const error = await observed;
  assert(error instanceof AggregateError);
  assert.deepEqual(error.errors.map(item => item.message), ['first close failed', 'last close failed']);
});
