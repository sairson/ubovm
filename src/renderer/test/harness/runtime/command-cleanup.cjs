'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const source = readFileSync(require.resolve('../../../../harness/ide/runtime/harness-service.cjs'), 'utf8');
const block = source.slice(source.indexOf('  async function stopCommands('), source.indexOf('  function interruptCommand('));
const stopCommands = vm.runInNewContext('(' + block.trim() + ')');

test('one command interrupt failure cannot skip other interrupts or cleanup barriers', async () => {
  const events = []; let finish;
  const barrier = new Promise(resolve => { finish = resolve; });
  const commands = new Map([
    ['broken', { interrupt() { events.push('interrupt broken'); throw Error('interrupt failed'); }, done() { events.push('done broken'); return barrier; } }],
    ['other', { interrupt() { events.push('interrupt other'); }, done() { events.push('done other'); } }]
  ]);
  let settled = false;
  const pending = stopCommands({ commands });
  const failure = assert.rejects(pending, /command.*clean|interrupt failed/i).then(() => { settled = true; });
  await new Promise(resolve => setImmediate(resolve));
  try {
    assert.deepEqual(events, ['interrupt broken', 'interrupt other', 'done broken', 'done other']);
    assert.equal(settled, false, 'must wait for all command cleanup before reporting failure');
  } finally { finish(); await failure; }
});

test('synchronous done failure still waits for other command cleanup', async () => {
  let finish, waited = false;
  const barrier = new Promise(resolve => { finish = resolve; });
  const pending = stopCommands({ commands: new Map([
    ['broken', { done() { throw Error('done failed'); } }],
    ['other', { done() { waited = true; return barrier; } }]
  ]) });
  const failure = assert.rejects(pending, /command.*clean|done failed/i);
  await new Promise(resolve => setImmediate(resolve));
  try { assert.equal(waited, true); } finally { finish(); await failure; }
});

test('backend shutdown closes every session and clears caches after command failures', async () => {
  const events = [];
  const sessions = new Map(['first', 'second'].map(id => [id, { id, active: Promise.resolve(),
    session: { close() { events.push('close ' + id); } },
    commands: new Map([[id, { interrupt() { events.push('interrupt ' + id); if (id === 'first') throw Error('broken interrupt'); },
      done() { events.push('done ' + id); if (id === 'first') throw Error('broken completion'); } }]]) }]));
  const workspaceScopes = new Map([['scope', Promise.resolve('workspace')]]);
  const closeBlock = source.slice(source.indexOf('  function close() {'), source.indexOf('  function steer('));
  const close = vm.runInNewContext('(function(){let closed=false,closing;' + closeBlock + ';return close;})()', {
    sessions, workspaceScopes, restores: new Map(), transitions: new Map(), clearTimeout,
    cancel: id => { events.push('cancel ' + id); }, stopCommands,
    saveWorkers: entry => { events.push('save ' + entry.id); }
  });
  const pending = close(); assert.equal(close(), pending);
  await assert.rejects(pending, /could not close cleanly/);
  for (const id of ['first', 'second']) for (const event of ['cancel', 'done', 'save', 'close']) assert(events.includes(event + ' ' + id));
  assert.equal(sessions.size, 0); assert.equal(workspaceScopes.size, 0);
});
