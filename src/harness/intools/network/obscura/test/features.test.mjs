import test from 'node:test';
import assert from 'node:assert/strict';
import { objectCatalog, mutateRequest } from '../features.mjs';

test('malformed percent segments do not break browser catalogs or unrelated query mutations', () => {
  const request = { url: 'https://example.com/100%/%E0%A4/123?item=456' };
  const result = objectCatalog(request);
  assert.ok(result.candidates.some(item => item.value === '100%'));
  assert.ok(result.candidates.some(item => item.value === '123'));
  const updated = mutateRequest(request, { query: { item: 789 } });
  assert.equal(updated.url, 'https://example.com/100%/%E0%A4/123?item=789');
});

test('browser path replacements remain encoded and cannot alter the captured origin', () => {
  const request = { url: 'https://example.com/items/123' };
  assert.equal(mutateRequest(request, { path: { 123: 'a/b' } }).url, 'https://example.com/items/a%2Fb');
  assert.throws(() => mutateRequest(request, { url: 'https://other.example/items' }), /captured origin/);
  assert.throws(() => mutateRequest({ ...request, postData: '{}' }, { json: { '__proto__.bad': true } }), /Unsafe/);
});
