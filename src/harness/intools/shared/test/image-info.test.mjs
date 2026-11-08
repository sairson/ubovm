import assert from 'node:assert/strict';
import test from 'node:test';

import { detectImageMime, imageDimensions, imageFormat, MAX_IMAGE_BYTES } from '../image-info.mjs';

const png = () => {
  const buffer = Buffer.alloc(33);
  Buffer.from('89504e470d0a1a0a', 'hex').copy(buffer, 0);
  buffer.writeUInt32BE(13, 8);
  buffer.write('IHDR', 12, 'ascii');
  buffer.writeUInt32BE(640, 16);
  buffer.writeUInt32BE(480, 20);
  return buffer;
};
const jpeg = () => {
  const buffer = Buffer.alloc(21);
  buffer.set([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0x2c, 0x01, 0x90], 0);
  return buffer;
};
const gif = () => {
  const buffer = Buffer.alloc(20);
  buffer.write('GIF89a', 0, 'ascii');
  buffer.writeUInt16LE(320, 6);
  buffer.writeUInt16LE(200, 8);
  return buffer;
};
const webpLossy = () => {
  const buffer = Buffer.alloc(30);
  buffer.write('RIFF', 0, 'ascii');
  buffer.write('WEBP', 8, 'ascii');
  buffer.write('VP8 ', 12, 'ascii');
  buffer.set([0x9d, 0x01, 0x2a], 23);
  buffer.writeUInt16LE(400, 26);
  buffer.writeUInt16LE(300, 28);
  return buffer;
};
const webpLossless = (width = 400, height = 300) => {
  const buffer = Buffer.alloc(25);
  buffer.write('RIFF', 0, 'ascii');
  buffer.write('WEBP', 8, 'ascii');
  buffer.write('VP8L', 12, 'ascii');
  buffer[20] = 0x2f;
  buffer.writeUInt32LE(((height - 1) << 14) | (width - 1), 21);
  return buffer;
};
const webpExtended = (width = 400, height = 300) => {
  const buffer = Buffer.alloc(30);
  buffer.write('RIFF', 0, 'ascii');
  buffer.write('WEBP', 8, 'ascii');
  buffer.write('VP8X', 12, 'ascii');
  const w = width - 1, h = height - 1;
  buffer[24] = w & 0xff; buffer[25] = w >> 8 & 0xff; buffer[26] = w >> 16 & 0xff;
  buffer[27] = h & 0xff; buffer[28] = h >> 8 & 0xff; buffer[29] = h >> 16 & 0xff;
  return buffer;
};

test('image magic detection accepts the four supported formats', () => {
  assert.equal(detectImageMime(Buffer.from('89504e470d0a1a0a00000000', 'hex')), 'image/png');
  assert.equal(detectImageMime(Buffer.from('ffd8ff000000000000000000', 'hex')), 'image/jpeg');
  assert.equal(detectImageMime(Buffer.from('GIF89a000000000000', 'ascii')), 'image/gif');
  assert.equal(detectImageMime(Buffer.from('RIFF0000WEBP', 'ascii')), 'image/webp');
  assert.equal(detectImageMime(Buffer.from('not an image')), undefined);
  assert.equal(detectImageMime(Buffer.from('89616263', 'hex')), undefined);
  assert.equal(MAX_IMAGE_BYTES, 4 * 1024 * 1024);
});

test('imageFormat names only the four supported formats', () => {
  assert.equal(imageFormat('image/png'), 'png');
  assert.equal(imageFormat('image/jpeg'), 'jpeg');
  assert.equal(imageFormat('image/gif'), 'gif');
  assert.equal(imageFormat('image/webp'), 'webp');
  assert.equal(imageFormat('image/svg+xml'), undefined);
  assert.equal(imageFormat(undefined), undefined);
});

test('imageDimensions reads PNG, JPEG, GIF and WebP headers', () => {
  assert.deepEqual(imageDimensions(png()), { width: 640, height: 480 });
  assert.deepEqual(imageDimensions(jpeg()), { width: 400, height: 300 });
  assert.deepEqual(imageDimensions(gif()), { width: 320, height: 200 });
  assert.deepEqual(imageDimensions(webpLossy()), { width: 400, height: 300 });
  assert.deepEqual(imageDimensions(webpLossless()), { width: 400, height: 300 });
  assert.deepEqual(imageDimensions(webpExtended(1024, 768)), { width: 1024, height: 768 });
});

test('imageDimensions returns undefined for unsupported, truncated or corrupt images', () => {
  assert.equal(imageDimensions(Buffer.from('not an image at all')), undefined);
  assert.equal(imageDimensions(Buffer.alloc(0)), undefined);
  assert.equal(imageDimensions('89504e47'), undefined);
  assert.equal(imageDimensions(Buffer.from('89504e470d0a1a0a00000000', 'hex')), undefined, 'truncated PNG header');
  assert.equal(imageDimensions(Buffer.from('ffd8ff000000000000000000', 'hex')), undefined, 'JPEG without a frame');
  assert.equal(imageDimensions(Buffer.from('GIF89a00', 'ascii')), undefined, 'truncated GIF header');
  const badWebp = webpLossy(); badWebp[23] = 0;
  assert.equal(imageDimensions(badWebp), undefined, 'bad VP8 start code');
  const badPng = png(); badPng.writeUInt32BE(0, 16);
  assert.equal(imageDimensions(badPng), undefined, 'zero width');
});
