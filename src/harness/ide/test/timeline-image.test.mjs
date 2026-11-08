import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

import { cleanTimelineParts, redactDisplayObject, sanitizeToolImage, TOOL_IMAGE_LIMITS } from '../runtime/projection.cjs';

const require = createRequire(import.meta.url);
const { workerRecord } = require('../runtime/worker-record.cjs');

const B64 = 'AAAA';
const image = (overrides = {}) => ({ mimeType: 'image/png', data: B64, width: 1, height: 1, bytes: 3, ...overrides });
const toolPart = (id, imageValue, overrides = {}) => ({
  id, type: 'tool', name: 'read_image', status: 'completed', args: '{"path":"screen.png"}', output: '{"bytes":3}',
  startedAt: 1, endedAt: 2, ...(imageValue ? { image: imageValue } : {}), ...overrides
});

test('cleanTimelineParts preserves one bounded tool image and its metadata', () => {
  const parts = cleanTimelineParts([toolPart('tool:1', image({ name: 'screen.png' }))]);
  assert.equal(parts.length, 1);
  assert.deepEqual(parts[0].image, { mimeType: 'image/png', data: B64, width: 1, height: 1, bytes: 3, name: 'screen.png' });
  assert.equal(Object.hasOwn(parts[0], 'imageOmitted'), false);

  const plain = cleanTimelineParts([toolPart('tool:2'), { id: 'text:1', type: 'text', text: '进度正常', status: 'completed' }]);
  assert.equal(Object.hasOwn(plain[0], 'image'), false, 'a non-image tool part gains no image key');
  assert.equal(Object.hasOwn(plain[0], 'imageOmitted'), false);
  assert.equal(Object.hasOwn(plain[1], 'image'), false);
});

test('cleanTimelineParts sanitizes or omits invalid and oversized image payloads', () => {
  const invalidMime = cleanTimelineParts([toolPart('tool:mime', image({ mimeType: 'image/svg+xml' }))])[0];
  assert.equal(Object.hasOwn(invalidMime, 'image'), false);
  assert.equal(invalidMime.imageOmitted, true);

  const badData = cleanTimelineParts([toolPart('tool:data', image({ data: 'not base64!' }))])[0];
  assert.equal(Object.hasOwn(badData, 'image'), false);
  assert.equal(badData.imageOmitted, true);

  const oversized = cleanTimelineParts([toolPart('tool:big', image({ data: 'A'.repeat(TOOL_IMAGE_LIMITS.maxBase64CharsPerImage + 4) }))])[0];
  assert.equal(Object.hasOwn(oversized, 'image'), false);
  assert.equal(oversized.imageOmitted, true);

  const explicit = cleanTimelineParts([toolPart('tool:note', undefined, { imageOmitted: true })])[0];
  assert.equal(explicit.imageOmitted, true);
  assert.equal(Object.hasOwn(explicit, 'image'), false);

  assert.equal(sanitizeToolImage({ mimeType: 'image/png', data: 'A' }), undefined, 'base64 length must be a multiple of four');
  assert.equal(sanitizeToolImage(null), undefined);
});

test('cleanTimelineParts keeps the newest images within the snapshot budget', () => {
  const input = Array.from({ length: TOOL_IMAGE_LIMITS.maxImages + 2 }, (_, index) => toolPart(`tool:${index}`, image()));
  const parts = cleanTimelineParts(input);
  assert.equal(parts.length, TOOL_IMAGE_LIMITS.maxImages + 2);
  // Newest four keep their payload; the two oldest become an explicit note.
  assert.deepEqual(parts.map(part => Boolean(part.image)), [false, false, true, true, true, true]);
  assert.deepEqual(parts.slice(0, 2).map(part => part.imageOmitted), [true, true]);
  assert.deepEqual(parts.slice(2).map(part => Object.hasOwn(part, 'imageOmitted')), [false, false, false, false]);
  // Input is not mutated.
  assert.ok(input.every(part => part.image && part.image.data === B64));
});

test('redactDisplayObject keeps base64 image payloads intact but still clamps plain strings', () => {
  const data = 'A'.repeat(100000);
  const redacted = redactDisplayObject({ type: 'tool', image: image({ data }) });
  assert.equal(redacted.image.data.length, data.length, 'image base64 escapes the 64000-char string clamp');
  assert.equal(redacted.image.mimeType, 'image/png');
  const plain = redactDisplayObject({ text: 'x'.repeat(70000) });
  assert.ok(plain.text.length <= 64000, `plain string stays bounded (${plain.text.length})`);
});

test('workerRecord persists image payloads intact and drops unreadable ones cleanly', () => {
  const data = 'A'.repeat(100000);
  const record = workerRecord('session', [{ id: 'w1', status: 'running', description: 'worker',
    parts: [toolPart('tool:image', image({ data })), toolPart('tool:broken', image({ data: '@@@@' }))] }], 1);
  const parts = record.workers[0].parts;
  assert.equal(parts.length, 2);
  assert.equal(parts[0].image.data, data, 'the persisted base64 is never truncated');
  assert.equal(Object.hasOwn(parts[1], 'image'), false, 'an invalid payload is not persisted');
  assert.equal(parts[1].imageOmitted, true);
  assert.ok(Buffer.byteLength(JSON.stringify(record)) <= 8 * 1024 * 1024);
});
