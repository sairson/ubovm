// ASAR container + authenticated encryption used by the packaging step.
// The runtime reader lives in build/protected-runtime.cjs (generated into the
// payload), so both sides must keep the exact same layout:
//
//   [uint32 headerSize][uint32 jsonLength][json][padding to 4 bytes][blobs...]
//   headerSize = 4 + jsonLength + padding
//   blob offsets are relative to the first byte after the header.
//
// Encryption wraps the whole ASAR buffer:
//   "UBOVMPAK" + uint32 version + 12-byte IV + 16-byte GCM tag + ciphertext
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

export const MAGIC = Buffer.from('UBOVMPAK');
export const CONTAINER_VERSION = 1;

function uint32(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value >>> 0, 0);
  return buffer;
}

export function keyFromSecret(secret) {
  return createHash('sha256').update(secret).digest();
}

// entries: Map<posixRelativePath, Buffer>
export function buildAsar(entries) {
  const tree = { files: {} };
  const blobs = [];
  let offset = 0;
  for (const [relative, data] of [...entries.entries()].sort((left, right) => (left[0] < right[0] ? -1 : 1))) {
    const parts = relative.split('/').filter(Boolean);
    let node = tree;
    parts.forEach((part, index) => {
      if (index === parts.length - 1) {
        node.files[part] = { size: data.length, offset };
        offset += data.length;
        blobs.push(data);
      } else {
        node.files[part] ??= { files: {} };
        node = node.files[part];
      }
    });
  }
  const json = Buffer.from(JSON.stringify(tree), 'utf8');
  const padding = (4 - (json.length % 4)) % 4;
  const headerSize = 4 + json.length + padding;
  return Buffer.concat([uint32(headerSize), uint32(json.length), json, Buffer.alloc(padding), ...blobs]);
}

export function readAsar(buffer) {
  if (buffer.length < 8) throw new Error('Invalid ASAR payload');
  const headerSize = buffer.readUInt32LE(0);
  const jsonLength = buffer.readUInt32LE(4);
  const padding = (4 - (jsonLength % 4)) % 4;
  if (headerSize !== 4 + jsonLength + padding) throw new Error('Invalid ASAR header size');
  if (8 + jsonLength > buffer.length) throw new Error('Truncated ASAR header');
  const tree = JSON.parse(buffer.subarray(8, 8 + jsonLength).toString('utf8'));
  const dataStart = 8 + jsonLength + padding;
  const files = new Map();
  const walk = (node, prefix) => {
    for (const [name, value] of Object.entries(node.files || {})) {
      const relative = prefix ? prefix + '/' + name : name;
      if (value.files) walk(value, relative);
      else {
        const start = dataStart + value.offset;
        if (start < 0 || start + value.size > buffer.length) throw new Error('Invalid ASAR entry: ' + relative);
        files.set(relative, buffer.subarray(start, start + value.size));
      }
    }
  };
  walk(tree, '');
  return files;
}

export function encryptAsar(asar, key) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(asar), cipher.final()]);
  return Buffer.concat([MAGIC, uint32(CONTAINER_VERSION), iv, cipher.getAuthTag(), ciphertext]);
}

export function decryptAsar(container, key) {
  if (container.length < MAGIC.length + 4 + 12 + 16) throw new Error('Invalid protected package');
  if (!container.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('Invalid protected package magic');
  if (container.readUInt32LE(MAGIC.length) !== CONTAINER_VERSION) throw new Error('Unsupported protected package version');
  const iv = container.subarray(12, 24);
  const tag = container.subarray(24, 40);
  const ciphertext = container.subarray(40);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}
