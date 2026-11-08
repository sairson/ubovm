'use strict';
// Runtime loader for the protected ASAR payloads. The installed app keeps only
// this loader (plus a stub entry) in plaintext; the code tree is decrypted from
// the authenticated archive into a per-version cache directory at startup.
const { createDecipheriv, createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const MAGIC = Buffer.from('UBOVMPAK');
const KEY = Buffer.from('__UBOVM_ASAR_KEY__', 'hex');

function readArchive(container) {
  if (container.length < MAGIC.length + 4 + 12 + 16 || !container.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('Invalid protected package');
  if (container.readUInt32LE(MAGIC.length) !== 1) throw new Error('Unsupported protected package version');
  const decipher = createDecipheriv('aes-256-gcm', KEY, container.subarray(12, 24));
  decipher.setAuthTag(container.subarray(24, 40));
  const asar = Buffer.concat([decipher.update(container.subarray(40)), decipher.final()]);
  const headerSize = asar.readUInt32LE(0);
  const jsonLength = asar.readUInt32LE(4);
  const padding = (4 - (jsonLength % 4)) % 4;
  if (headerSize !== 4 + jsonLength + padding) throw new Error('Invalid protected package header');
  const tree = JSON.parse(asar.subarray(8, 8 + jsonLength).toString('utf8'));
  const dataStart = 8 + jsonLength + padding;
  const files = new Map();
  const walk = (node, prefix) => {
    for (const name of Object.keys(node.files || {})) {
      const value = node.files[name];
      const relative = prefix ? prefix + '/' + name : name;
      if (value.files) walk(value, relative);
      else files.set(relative, asar.subarray(dataStart + value.offset, dataStart + value.offset + value.size));
    }
  };
  walk(tree, '');
  return files;
}

function materialize(archivePath, component, cacheBase) {
  const container = fs.readFileSync(archivePath);
  const hash = createHash('sha256').update(container).digest('hex').slice(0, 16);
  const base = cacheBase || path.join(os.tmpdir(), 'ubovm-protected');
  const target = path.join(base, component + '-' + hash);
  try {
    if (JSON.parse(fs.readFileSync(path.join(target, '.ubovm-protected.json'), 'utf8')).hash === hash) return target;
  } catch { /* Extract below. */ }
  const staging = target + '.tmp-' + process.pid + '-' + Date.now();
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  for (const [relative, data] of readArchive(container)) {
    const parts = relative.split('/');
    if (!parts.length || parts.some(part => !part || part === '.' || part === '..') || path.isAbsolute(relative)) throw new Error('Invalid protected entry: ' + relative);
    const file = path.join(staging, ...parts);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, data);
  }
  fs.writeFileSync(path.join(staging, '.ubovm-protected.json'), JSON.stringify({ hash, component }));
  fs.rmSync(target, { recursive: true, force: true });
  fs.renameSync(staging, target);
  return target;
}

module.exports = { materialize };
