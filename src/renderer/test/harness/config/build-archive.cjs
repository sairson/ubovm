'use strict';
// In-memory ZIP / tar.gz builders so skill-install tests stay hermetic.
const { deflateRawSync, gzipSync } = require('node:zlib');

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let index = 0; index < 256; index++) {
    let value = index;
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value;
  }
  return table;
})();
function crc32(buffer) {
  let crc = -1;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

/** Build a ZIP archive. Each entry is [name, content, { deflate, symlink, declaredSize }]. */
function zip(entries) {
  const parts = [], central = [];
  let offset = 0;
  for (const [name, content, options = {}] of entries) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    const declared = options.declaredSize ?? data.length;
    const nameBuffer = Buffer.from(name, 'utf8');
    const stored = options.deflate ? deflateRawSync(data) : data;
    const method = options.deflate ? 8 : 0;
    const crc = crc32(data);
    const local = Buffer.alloc(30 + nameBuffer.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 6); local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10); local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(stored.length, 18); local.writeUInt32LE(declared, 22);
    local.writeUInt16LE(nameBuffer.length, 26); local.writeUInt16LE(0, 28);
    nameBuffer.copy(local, 30);
    parts.push(local, stored);
    const entry = Buffer.alloc(46 + nameBuffer.length);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(0x031e, 4); entry.writeUInt16LE(20, 6); entry.writeUInt16LE(0, 8); entry.writeUInt16LE(method, 10);
    entry.writeUInt16LE(0, 12); entry.writeUInt16LE(0, 14);
    entry.writeUInt32LE(crc, 16); entry.writeUInt32LE(stored.length, 20); entry.writeUInt32LE(declared, 24);
    entry.writeUInt16LE(nameBuffer.length, 28); entry.writeUInt16LE(0, 30); entry.writeUInt16LE(0, 32);
    entry.writeUInt16LE(0, 34); entry.writeUInt16LE(0, 36);
    entry.writeUInt32LE(options.symlink ? (0xa1ed << 16) >>> 0 : (0x81a4 << 16) >>> 0, 38);
    entry.writeUInt32LE(offset, 42);
    nameBuffer.copy(entry, 46);
    central.push(entry);
    offset += local.length + stored.length;
  }
  const directory = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4); eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(directory.length, 12); eocd.writeUInt32LE(offset, 16); eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...parts, directory, eocd]);
}

function tarHeader(name, size, type) {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, 'utf8');
  header.write('0000644\0', 100, 8);
  header.write('0000000\0', 108, 8);
  header.write('0000000\0', 116, 8);
  header.write(size.toString(8).padStart(11, '0') + '\0', 124, 12);
  header.write('00000000000\0', 136, 12);
  header.write('        ', 148, 8);
  header.write(type, 156, 1);
  header.write('ustar\0', 257, 6);
  header.write('00', 263, 2);
  let sum = 0; for (const byte of header) sum += byte;
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
  return header;
}

/** Build a gzip-compressed tar archive from [name, content] entries. */
function tarGz(entries) {
  const parts = [];
  for (const [name, content] of entries) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    parts.push(tarHeader(name, data.length, '0'), Buffer.concat([data, Buffer.alloc((512 - data.length % 512) % 512)]));
  }
  parts.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(parts));
}

module.exports = { zip, tarGz, crc32 };
