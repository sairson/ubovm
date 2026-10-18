import assert from 'node:assert/strict';
import test from 'node:test';

import { detectImageMime, MAX_IMAGE_BYTES } from '../image-info.mjs';

test('image magic detection accepts the four supported formats', () => {
  assert.equal(detectImageMime(Buffer.from('89504e470d0a1a0a00000000', 'hex')), 'image/png');
  assert.equal(detectImageMime(Buffer.from('ffd8ff000000000000000000', 'hex')), 'image/jpeg');
  assert.equal(detectImageMime(Buffer.from('GIF89a000000000000', 'ascii')), 'image/gif');
  assert.equal(detectImageMime(Buffer.from('RIFF0000WEBP', 'ascii')), 'image/webp');
  assert.equal(detectImageMime(Buffer.from('not an image')), undefined);
  assert.equal(detectImageMime(Buffer.from('89616263', 'hex')), undefined);
  assert.equal(MAX_IMAGE_BYTES, 4 * 1024 * 1024);
});
