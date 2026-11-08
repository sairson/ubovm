/** Shared image metadata for tools and message attachment loading. */
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
export const MAX_IMAGES_PER_MESSAGE = 4;

const EXTENSIONS = Object.freeze({
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
});

const FORMATS = Object.freeze({
  'image/png': 'png',
  'image/jpeg': 'jpeg',
  'image/webp': 'webp',
  'image/gif': 'gif',
});

export function imageExtension(mimeType) {
  return EXTENSIONS[mimeType];
}

/** Short display/storage format name for a supported image MIME type. */
export function imageFormat(mimeType) {
  return FORMATS[mimeType];
}

export function detectImageMime(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return undefined;
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47
    && buffer[4] === 0x0d && buffer[5] === 0x0a && buffer[6] === 0x1a && buffer[7] === 0x0a) return 'image/png';
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  const head = buffer.toString('ascii', 0, 12);
  if (head.startsWith('GIF87a') || head.startsWith('GIF89a')) return 'image/gif';
  if (head.startsWith('RIFF') && head.slice(8, 12) === 'WEBP') return 'image/webp';
  return undefined;
}

// JPEG dimensions live in any Start-Of-Frame segment. C4/C8/CC are DHT/JPG/DAC,
// not frames, so they are skipped like the other non-SOF markers.
const JPEG_SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

function dimensions(value) {
  return Number.isSafeInteger(value.width) && value.width > 0 && value.width <= 0x7fffffff
    && Number.isSafeInteger(value.height) && value.height > 0 && value.height <= 0x7fffffff
    ? { width: value.width, height: value.height }
    : undefined;
}

function pngDimensions(buffer) {
  if (buffer.length < 24 || buffer.toString('ascii', 12, 16) !== 'IHDR') return undefined;
  return dimensions({ width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) });
}

function gifDimensions(buffer) {
  if (buffer.length < 10) return undefined;
  return dimensions({ width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) });
}

function jpegDimensions(buffer) {
  let offset = 2;
  while (offset + 9 <= buffer.length) {
    if (buffer[offset] !== 0xff) { offset++; continue; }
    let marker = buffer[offset + 1];
    // Fill bytes (0xFF padding) may precede a marker.
    while (marker === 0xff && offset + 2 < buffer.length) { offset++; marker = buffer[offset + 1]; }
    if (marker === 0xd8 || marker === 0xd9 || marker === 0x01 || marker >= 0xd0 && marker <= 0xd7) { offset += 2; continue; }
    if (marker === 0xda || marker === 0xd9) return undefined;
    if (offset + 4 > buffer.length) return undefined;
    const size = buffer.readUInt16BE(offset + 2);
    if (size < 2 || offset + 2 + size > buffer.length) return undefined;
    if (JPEG_SOF.has(marker)) {
      return dimensions({ height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) });
    }
    offset += 2 + size;
  }
  return undefined;
}

function webpDimensions(buffer) {
  if (buffer.length < 21) return undefined;
  const chunk = buffer.toString('ascii', 12, 16);
  if (chunk === 'VP8 ') {
    if (buffer.length < 30 || buffer[23] !== 0x9d || buffer[24] !== 0x01 || buffer[25] !== 0x2a) return undefined;
    return dimensions({ width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff });
  }
  if (chunk === 'VP8L') {
    if (buffer.length < 25 || buffer[20] !== 0x2f) return undefined;
    const bits = buffer.readUInt32LE(21);
    return dimensions({ width: 1 + (bits & 0x3fff), height: 1 + ((bits >>> 14) & 0x3fff) });
  }
  if (chunk === 'VP8X') {
    if (buffer.length < 30) return undefined;
    return dimensions({ width: 1 + (buffer[24] | buffer[25] << 8 | buffer[26] << 16), height: 1 + (buffer[27] | buffer[28] << 8 | buffer[29] << 16) });
  }
  return undefined;
}

/**
 * Pixel dimensions from the image header only (PNG/JPEG/GIF/WebP).
 * Returns undefined when the bytes are not a supported image or the header is
 * truncated/corrupt; callers must treat missing dimensions as display-only
 * metadata, never as a read failure.
 */
export function imageDimensions(buffer) {
  if (!Buffer.isBuffer(buffer)) return undefined;
  const mimeType = detectImageMime(buffer);
  try {
    if (mimeType === 'image/png') return pngDimensions(buffer);
    if (mimeType === 'image/jpeg') return jpegDimensions(buffer);
    if (mimeType === 'image/gif') return gifDimensions(buffer);
    if (mimeType === 'image/webp') return webpDimensions(buffer);
  } catch { /* A malformed header must not fail the image read. */ }
  return undefined;
}
