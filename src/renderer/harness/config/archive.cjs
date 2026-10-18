'use strict';
// Dependency-free readers for the two archive formats a skill package may ship
// as. The extension host runs without node_modules, so ZIP and TAR are parsed
// directly instead of pulling in a library. Every reader is intentionally
// strict: unknown compression, ZIP64, encryption and links are rejected rather
// than silently skipped, so an install either produces exactly what was
// published or fails loudly.
const { inflateRawSync, gunzipSync } = require('node:zlib');

const ZIP_LOCAL = 0x04034b50;
const ZIP_CENTRAL = 0x02014b50;
const ZIP_EOCD = 0x06054b50;
const DEFAULT_LIMITS = { maxEntryBytes: 4 * 1024 * 1024, maxTotalBytes: 8 * 1024 * 1024, maxEntries: 1024 };
const limitsFor = value => ({ ...DEFAULT_LIMITS, ...(value ?? {}) });

function fail(message, code = 'ARCHIVE_INVALID') {
  return Object.assign(new Error(message), { code });
}

function cstring(buffer) {
  const end = buffer.indexOf(0);
  return buffer.subarray(0, end < 0 ? buffer.length : end).toString('utf8');
}

function parseOctal(buffer) {
  if (buffer[0] & 0x80) throw fail('归档条目使用了暂不支持的大尺寸编码。');
  const text = cstring(buffer).trim();
  if (!text) return 0;
  if (!/^[0-7]+$/.test(text)) throw fail('归档条目大小字段无效。');
  const size = parseInt(text, 8);
  if (!Number.isSafeInteger(size) || size < 0) throw fail('归档条目大小字段无效。');
  return size;
}

/** Return the entry names of a ZIP archive without decompressing file bodies. */
function readZip(buffer, options) {
  const { maxEntryBytes, maxTotalBytes, maxEntries } = limitsFor(options);
  if (buffer.length < 22) throw fail('ZIP 文件不完整。');
  const floor = Math.max(0, buffer.length - 22 - 0xffff);
  let eocd = -1;
  for (let index = buffer.length - 22; index >= floor; index--) {
    if (buffer.readUInt32LE(index) === ZIP_EOCD) { eocd = index; break; }
  }
  if (eocd < 0) throw fail('ZIP 缺少中央目录，文件可能不完整。');
  const count = buffer.readUInt16LE(eocd + 10);
  const size = buffer.readUInt32LE(eocd + 12);
  const offset = buffer.readUInt32LE(eocd + 16);
  if (count === 0xffff || size === 0xffffffff || offset === 0xffffffff) throw fail('暂不支持 ZIP64 归档。');
  if (offset > buffer.length || size > buffer.length || offset + size > buffer.length) throw fail('ZIP 中央目录位置无效。');
  if (count > maxEntries) throw fail(`ZIP 条目数超过 ${maxEntries}。`, 'ARCHIVE_LIMIT');
  const files = new Map();
  let pointer = offset, total = 0;
  for (let index = 0; index < count; index++) {
    if (pointer + 46 > buffer.length || buffer.readUInt32LE(pointer) !== ZIP_CENTRAL) throw fail('ZIP 中央目录条目损坏。');
    const flags = buffer.readUInt16LE(pointer + 8);
    const method = buffer.readUInt16LE(pointer + 10);
    const compressedSize = buffer.readUInt32LE(pointer + 20);
    const uncompressedSize = buffer.readUInt32LE(pointer + 24);
    const nameLength = buffer.readUInt16LE(pointer + 28);
    const extraLength = buffer.readUInt16LE(pointer + 30);
    const commentLength = buffer.readUInt16LE(pointer + 32);
    const externalAttributes = buffer.readUInt32LE(pointer + 38);
    const localOffset = buffer.readUInt32LE(pointer + 42);
    if (pointer + 46 + nameLength + extraLength + commentLength > buffer.length) throw fail('ZIP 中央目录条目超出文件范围。');
    const name = buffer.subarray(pointer + 46, pointer + 46 + nameLength).toString('utf8');
    pointer += 46 + nameLength + extraLength + commentLength;
    if (flags & 0x1) throw fail('不支持加密的 ZIP 条目。');
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff) throw fail('暂不支持 ZIP64 归档。');
    const unixMode = (externalAttributes >>> 16) & 0xffff;
    if (name.endsWith('/') || (unixMode & 0xf000) === 0x4000) continue;
    if ((unixMode & 0xf000) === 0xa000) throw fail('ZIP 归档包含符号链接，已拒绝。');
    if (uncompressedSize > maxEntryBytes) throw fail(`ZIP 条目超过 ${maxEntryBytes} 字节。`, 'ARCHIVE_LIMIT');
    total += uncompressedSize;
    if (total > maxTotalBytes) throw fail(`ZIP 解压内容超过 ${maxTotalBytes} 字节。`, 'ARCHIVE_LIMIT');
    if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== ZIP_LOCAL) throw fail('ZIP 本地文件头损坏。');
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const data = buffer.subarray(dataStart, dataStart + compressedSize);
    if (data.length !== compressedSize) throw fail('ZIP 条目数据超出文件范围。');
    let content;
    if (method === 0) content = Buffer.from(data);
    else if (method === 8) content = inflateRawSync(data, { maxOutputLength: uncompressedSize });
    else throw fail(`不支持的 ZIP 压缩方式（${method}）。`);
    if (content.length !== uncompressedSize) throw fail('ZIP 条目解压大小与目录记录不一致。');
    files.set(name, content);
  }
  return files;
}

/** Read a tar archive that may carry GNU long names and pax headers. */
function readTar(tar, options) {
  const { maxEntryBytes, maxTotalBytes, maxEntries } = limitsFor(options);
  const files = new Map();
  let pointer = 0, total = 0, longName;
  while (pointer + 512 <= tar.length) {
    const header = tar.subarray(pointer, pointer + 512);
    if (!header.some(byte => byte !== 0)) break;
    const size = parseOctal(header.subarray(124, 136));
    const type = String.fromCharCode(header[156] === 0 ? 0x30 : header[156]);
    const name = cstring(header.subarray(0, 100));
    const prefix = cstring(header.subarray(345, 500));
    const dataStart = pointer + 512;
    if (dataStart + size > tar.length) throw fail('TAR 条目数据超出文件范围。');
    const data = tar.subarray(dataStart, dataStart + size);
    pointer = dataStart + Math.ceil(size / 512) * 512;
    if (type === 'L') { longName = cstring(data); continue; }
    if (type === 'x' || type === 'g' || type === 'K') continue;
    if (type === '1' || type === '2') throw fail('TAR 归档包含链接，已拒绝。');
    if (type === '5') { longName = undefined; continue; }
    if (type !== '0' && type !== '') continue;
    if (size > maxEntryBytes) throw fail(`TAR 条目超过 ${maxEntryBytes} 字节。`, 'ARCHIVE_LIMIT');
    total += size;
    if (total > maxTotalBytes) throw fail(`TAR 解压内容超过 ${maxTotalBytes} 字节。`, 'ARCHIVE_LIMIT');
    if (files.size >= maxEntries) throw fail(`TAR 条目数超过 ${maxEntries}。`, 'ARCHIVE_LIMIT');
    const full = longName ?? (prefix ? `${prefix}/${name}` : name);
    longName = undefined;
    files.set(full, Buffer.from(data));
  }
  return files;
}

function isZip(buffer) {
  return buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b && [0x03, 0x05, 0x07].includes(buffer[2]);
}
function isGzip(buffer) {
  return buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b;
}

/** Detect and decode a skill archive, returning a path → Buffer map. */
function readArchive(buffer, options) {
  const limits = limitsFor(options);
  if (isZip(buffer)) return readZip(buffer, limits);
  if (isGzip(buffer)) {
    const ceiling = limits.maxTotalBytes + limits.maxEntries * 1024 + 1024;
    return readTar(gunzipSync(buffer, { maxOutputLength: ceiling }), limits);
  }
  throw fail('无法识别的归档格式，仅支持 ZIP 或 tar.gz。');
}

module.exports = { readArchive, readZip, readTar, isZip, isGzip, fail, DEFAULT_LIMITS };

