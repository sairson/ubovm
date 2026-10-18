'use strict';

const { createHash } = require('node:crypto');
const { mkdir, readFile, rename, stat, unlink, writeFile } = require('node:fs/promises');
const { homedir } = require('node:os');
const path = require('node:path');

const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_IMAGES_PER_MESSAGE = 4;
const MIME_EXTENSIONS = Object.freeze({
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
});

function imageRoot() {
  return path.resolve(process.env.UBOVM_IMAGE_ROOT || path.join(homedir(), '.ubovm', 'attachments'));
}

function detectMime(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return undefined;
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47
    && buffer[4] === 0x0d && buffer[5] === 0x0a && buffer[6] === 0x1a && buffer[7] === 0x0a) return 'image/png';
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  const head = buffer.toString('ascii', 0, 12);
  if (head.startsWith('GIF87a') || head.startsWith('GIF89a')) return 'image/gif';
  if (head.startsWith('RIFF') && head.slice(8, 12) === 'WEBP') return 'image/webp';
  return undefined;
}

function decodeBase64(value) {
  if (typeof value !== 'string' || !value) throw new Error('图片数据为空。');
  const text = value.startsWith('data:') ? value.slice(value.indexOf(',') + 1) : value;
  if (!/^[A-Za-z0-9+/=\s]+$/.test(text)) throw new Error('图片数据不是合法的 base64。');
  const buffer = Buffer.from(text, 'base64');
  if (!buffer.length) throw new Error('图片数据为空。');
  return buffer;
}

function safeName(name, mimeType) {
  const base = typeof name === 'string' ? path.basename(name).replace(/[\u0000-\u001f\u007f]/g, '').trim() : '';
  const fallback = 'image' + (MIME_EXTENSIONS[mimeType] || '');
  return (base || fallback).slice(0, 120);
}

function conversationDirectory(conversationId) {
  const value = typeof conversationId === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(conversationId)
    ? conversationId : 'shared';
  return path.join(imageRoot(), value);
}

function isManagedImage(filePath) {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) return false;
  const root = imageRoot() + path.sep;
  return path.resolve(filePath).startsWith(root);
}

async function saveImage({ conversationId, name, mimeType, data } = {}) {
  const buffer = decodeBase64(data);
  if (buffer.length > MAX_IMAGE_BYTES) throw new Error(`图片不能超过 ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)} MiB。`);
  const detected = detectMime(buffer);
  if (!detected) throw new Error('仅支持 PNG、JPEG、WebP 或 GIF 图片。');
  if (mimeType && mimeType !== detected) throw new Error('图片内容与声明的类型不一致。');
  const directory = conversationDirectory(conversationId);
  await mkdir(directory, { recursive: true });
  const id = createHash('sha256').update(buffer).digest('hex').slice(0, 32);
  const filePath = path.join(directory, id + MIME_EXTENSIONS[detected]);
  const temporary = filePath + '.tmp-' + process.pid + '-' + Date.now();
  await writeFile(temporary, buffer, { flag: 'wx' });
  try { await rename(temporary, filePath); }
  catch (error) {
    await unlink(temporary).catch(() => {});
    if (error.code !== 'EEXIST' && error.code !== 'EPERM') throw error;
    await readFile(filePath);
  }
  return { id, name: safeName(name, detected), mimeType: detected, bytes: buffer.length, path: filePath };
}

async function loadImage(filePath) {
  if (!isManagedImage(filePath)) throw new Error('图片不在附件目录中。');
  const info = await stat(filePath);
  if (!info.isFile()) throw new Error('图片路径不是普通文件。');
  if (info.size > MAX_IMAGE_BYTES) throw new Error('图片超过大小上限。');
  const buffer = await readFile(filePath);
  const mimeType = detectMime(buffer);
  if (!mimeType) throw new Error('图片格式不受支持。');
  return { data: buffer.toString('base64'), mimeType, bytes: buffer.length };
}

module.exports = {
  MAX_IMAGE_BYTES,
  MAX_IMAGES_PER_MESSAGE,
  imageRoot,
  detectMime,
  saveImage,
  loadImage,
  isManagedImage,
};
