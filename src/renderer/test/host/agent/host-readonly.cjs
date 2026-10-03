const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { runInNewContext } = require('node:vm');
const source = readFileSync(require.resolve('../../../host/agent/agent-service.cjs'), 'utf8');
const readonly = runInNewContext(source.slice(source.indexOf('function readonly('), source.indexOf('/** The host owns')) + '\nreadonly');

test('host snapshot freezing is stack safe and handles shared/cyclic references', () => {
  const root = {}; let last = root;
  for (let index = 0; index < 25000; index++) { last.next = {}; last = last.next; }
  last.root = root;
  root.shared = last;
  assert.equal(readonly(root), root);
  for (let item = root, index = 0; index <= 25000; index++, item = item.next) assert(Object.isFrozen(item));
  assert(Object.isFrozen(last));
});

test('a shallowly frozen container does not leave mutable child state', () => {
  const child = { values: [1, 2] }, root = Object.freeze({ child });
  readonly(root);
  assert(Object.isFrozen(child)); assert(Object.isFrozen(child.values));
});
