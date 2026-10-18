'use strict';
// Host-side skill installation. The extension host owns the writable skills
// directory (~/.ubovm/skills), so an install is validated, staged and published
// here before the harness discovers it on the next turn. Two sources are
// supported: content supplied inline by the agent, or a URL that returns either
// a raw SKILL.md or a ZIP / tar.gz package.
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { homedir } = require('node:os');
const { readArchive, isZip, isGzip } = require('./archive.cjs');

const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DEFAULTS = {
  maxSkillBytes: 256 * 1024,
  maxFileBytes: 4 * 1024 * 1024,
  maxTotalBytes: 8 * 1024 * 1024,
  maxFiles: 256,
  maxArchiveBytes: 8 * 1024 * 1024
};

function fail(message, code = 'INVALID_SKILL') {
  return Object.assign(new Error(message), { code });
}

function expandHome(value) {
  return path.resolve(value.replace(/^~(?=[\\/]|$)/, homedir()));
}

function skillName(value) {
  if (typeof value !== 'string' || value.length > 64 || !NAME.test(value)) throw fail('技能名称必须是 1–64 个小写字母、数字或单个连字符。');
  return value;
}

async function regularDirectory(directory) {
  const info = await fs.lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw fail(`技能目录不能是文件或链接：${directory}`);
}

/** Reject absolute paths, traversal, NUL and alternate data streams. */
function safeRelativePath(raw, label = '技能文件路径') {
  if (typeof raw !== 'string' || !raw.trim()) throw fail(`${label}必须是非空字符串。`);
  const value = raw.replace(/\\/g, '/');
  if (value.includes('\0') || value.startsWith('/') || /^[A-Za-z]:/.test(value) || value.includes(':')) throw fail(`${label}不能是绝对路径或包含盘符：${raw}`);
  const segments = value.split('/');
  if (segments.some(segment => !segment || segment === '.' || segment === '..')) throw fail(`${label}不能包含空段或上级目录：${raw}`);
  return segments.join('/');
}

// Minimal YAML reader for skill frontmatter. The harness performs the full
// parse on discovery; this only needs the fields that decide validity and that
// routing directives were not silently dropped.
function parseScalar(raw) {
  const value = raw.trim();
  if (value.startsWith('"')) {
    try { const parsed = JSON.parse(value); if (typeof parsed === 'string') return parsed; } catch { /* fall through */ }
    return value.slice(1, value.endsWith('"') ? -1 : undefined);
  }
  if (value.startsWith("'")) return value.slice(1, value.endsWith("'") ? -1 : undefined).replace(/''/g, "'");
  const comment = /(^|\s)#/.exec(value);
  return (comment ? value.slice(0, comment.index) : value).trim();
}

function parseFrontmatterObject(lines) {
  const fields = new Map();
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (!line.trim() || /^\s*#/.test(line)) continue;
    if (/^\s/.test(line)) throw fail('SKILL.md frontmatter 缩进无效。');
    const match = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(line);
    if (!match) throw fail(`SKILL.md frontmatter 无法解析：${line}`);
    const [, key, rest] = match;
    if (/^[|>]/.test(rest.trim())) {
      const collected = [];
      for (index++; index < lines.length; index++) {
        const next = lines[index];
        if (next.trim() && !/^\s/.test(next)) { index--; break; }
        collected.push(next.replace(/^ {1,}/, ''));
      }
      fields.set(key, collected.join('\n').trim());
    } else fields.set(key, parseScalar(rest));
  }
  return fields;
}

function splitSkill(text, label) {
  const lines = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').split('\n');
  if (lines[0]?.trim() !== '---') throw fail(`${label} 必须以 YAML frontmatter 开始。`);
  let end = -1;
  for (let index = 1; index < lines.length; index++) if (lines[index].trim() === '---') { end = index; break; }
  if (end < 0) throw fail(`${label} 缺少 frontmatter 结束分隔符。`);
  const metadata = parseFrontmatterObject(lines.slice(1, end));
  const name = skillName(metadata.get('name'));
  const description = metadata.get('description');
  if (typeof description !== 'string' || !description.trim()) throw fail(`${label} 缺少 description。`);
  if (Buffer.byteLength(description) > 1024) throw fail(`${label} 的 description 超过 1024 字节。`);
  if (!lines.slice(end + 1).join('\n').trim()) throw fail(`${label} 在 frontmatter 之后必须包含指令正文。`);
  // The Worker executes skills inline; never accept a fork or model route that
  // this runtime cannot honor.
  const context = metadata.get('context');
  if (context !== undefined && !['', 'inline'].includes(context)) throw fail(`${label}: context ${JSON.stringify(context)} 需要技能路由，当前仅支持 inline。`, 'UNSUPPORTED_SKILL_RUNTIME');
  if (metadata.get('agent') || metadata.get('model')) throw fail(`${label}: 暂不支持 inline 技能的 agent/model 路由。`, 'UNSUPPORTED_SKILL_RUNTIME');
  return { name, description: description.trim() };
}

function decodeText(buffer, label) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buffer); }
  catch { throw fail(`${label} 必须是 UTF-8 文本。`); }
}

function checkLimits(entries, limits) {
  if (entries.size === 0) throw fail('技能包为空。');
  if (entries.size > limits.maxFiles) throw fail(`技能文件数量超过 ${limits.maxFiles}。`, 'SKILL_LIMIT_EXCEEDED');
  let total = 0;
  for (const [relative, content] of entries) {
    const size = content.length;
    if (relative === 'SKILL.md' && size > limits.maxSkillBytes) throw fail(`SKILL.md 超过 ${limits.maxSkillBytes} 字节。`, 'SKILL_LIMIT_EXCEEDED');
    if (size > limits.maxFileBytes) throw fail(`${relative} 超过 ${limits.maxFileBytes} 字节。`, 'SKILL_LIMIT_EXCEEDED');
    total += size;
  }
  if (total > limits.maxTotalBytes) throw fail(`技能内容超过 ${limits.maxTotalBytes} 字节。`, 'SKILL_LIMIT_EXCEEDED');
  return total;
}

async function download(url, fetchImpl, signal, maxBytes) {
  let parsed;
  try { parsed = new URL(url); } catch { throw fail('技能下载地址必须是完整的 HTTP(S) 地址。'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.hash) throw fail('技能下载地址不能包含凭据或片段。');
  let response;
  try { response = await fetchImpl(parsed, { signal, redirect: 'follow' }); }
  catch (error) { if (signal?.aborted) throw error; throw fail(`下载技能失败：${error?.message || error}`, 'SKILL_DOWNLOAD_FAILED'); }
  if (!response.ok) throw fail(`下载技能失败：HTTP ${response.status}。`, 'SKILL_DOWNLOAD_FAILED');
  const declared = Number(response.headers?.get?.('content-length') ?? '');
  if (Number.isFinite(declared) && declared > maxBytes) throw fail(`技能包超过 ${maxBytes} 字节。`, 'SKILL_LIMIT_EXCEEDED');
  const reader = response.body?.getReader?.();
  if (!reader) {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maxBytes) throw fail(`技能包超过 ${maxBytes} 字节。`, 'SKILL_LIMIT_EXCEEDED');
    return buffer;
  }
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) { await reader.cancel().catch(() => {}); throw fail(`技能包超过 ${maxBytes} 字节。`, 'SKILL_LIMIT_EXCEEDED'); }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total);
}

function findSkillRoot(files, requestedName) {
  const roots = new Set();
  for (const raw of files.keys()) {
    const normalized = raw.replace(/\\/g, '/');
    if (normalized === 'SKILL.md') roots.add('');
    else if (normalized.endsWith('/SKILL.md')) roots.add(normalized.slice(0, -'SKILL.md'.length - 1));
  }
  if (!roots.size) throw fail('技能包中找不到 SKILL.md。');
  const list = [...roots];
  if (requestedName && list.includes(requestedName)) return requestedName;
  if (list.length === 1) return list[0];
  throw fail('技能包包含多个技能目录，请整理为单一 SKILL.md 后再安装。', 'SKILL_AMBIGUOUS');
}

function packageEntries(files, root) {
  const prefix = root ? `${root}/` : '';
  const entries = new Map();
  for (const [raw, content] of files) {
    const normalized = raw.replace(/\\/g, '/');
    if (!normalized.startsWith(prefix)) continue;
    const relative = safeRelativePath(normalized.slice(prefix.length));
    if (entries.has(relative)) throw fail(`技能包包含重复文件：${relative}`);
    entries.set(relative, content);
  }
  return entries;
}

function inlineEntries(input) {
  if (typeof input.content !== 'string' || !input.content.trim()) throw fail('inline 安装需要提供 SKILL.md 内容。');
  const entries = new Map([['SKILL.md', Buffer.from(input.content, 'utf8')]]);
  const files = input.files ?? [];
  if (!Array.isArray(files) || files.length > DEFAULTS.maxFiles) throw fail('技能附属文件列表无效。');
  for (const file of files) {
    if (!file || typeof file !== 'object' || Array.isArray(file)) throw fail('技能附属文件必须是 { path, content } 对象。');
    const relative = safeRelativePath(file.path);
    if (relative === 'SKILL.md') throw fail('附属文件不能覆盖 SKILL.md。');
    if (typeof file.content !== 'string') throw fail(`${relative} 的内容必须是字符串。`);
    if (entries.has(relative)) throw fail(`技能文件重复：${relative}`);
    entries.set(relative, Buffer.from(file.content, 'utf8'));
  }
  return entries;
}

async function archiveEntries(input, fetchImpl, signal, limits) {
  const buffer = await download(input.url, fetchImpl, signal, limits.maxArchiveBytes);
  if (!isZip(buffer) && !isGzip(buffer)) {
    // A plain markdown document is treated as a single-file skill.
    return new Map([['SKILL.md', buffer]]);
  }
  const files = readArchive(buffer, { maxEntryBytes: limits.maxFileBytes, maxTotalBytes: limits.maxTotalBytes, maxEntries: limits.maxFiles * 4 });
  const root = findSkillRoot(files, typeof input.name === 'string' ? input.name.trim() : undefined);
  const entries = packageEntries(files, root);
  if (!entries.has('SKILL.md')) throw fail('技能包中找不到 SKILL.md。');
  return entries;
}

async function publish(destination, name, entries, overwrite) {
  await fs.mkdir(destination, { recursive: true });
  await regularDirectory(destination);
  const target = path.join(destination, name);
  const existing = await fs.lstat(target).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (existing && !overwrite) throw fail(`技能 ${name} 已存在；如需替换请设置 overwrite 为 true。`, 'SKILL_EXISTS');
  const stage = await fs.mkdtemp(path.join(destination, '.install-'));
  let trash;
  try {
    const packagePath = path.join(stage, name);
    await fs.mkdir(packagePath, { recursive: true });
    for (const [relative, content] of entries) {
      const file = path.join(packagePath, relative);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, content, { flag: 'wx' });
    }
    if (existing) {
      trash = path.join(destination, `.trash-${randomUUID()}`);
      await fs.rename(target, trash);
    }
    try { await fs.rename(packagePath, target); }
    catch (error) {
      if (trash) { await fs.rename(trash, target).catch(() => {}); trash = undefined; }
      if (['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw fail(`技能 ${name} 已存在。`, 'SKILL_EXISTS');
      throw error;
    }
    if (trash) { await fs.rm(trash, { recursive: true, force: true }).catch(() => {}); trash = undefined; }
  } finally {
    await fs.rm(stage, { recursive: true, force: true }).catch(() => {});
    if (trash) await fs.rm(trash, { recursive: true, force: true }).catch(() => {});
  }
  return { target, replaced: Boolean(existing) };
}

/** Install one skill, returning its published identity and file list. */
async function installSkill(input, options = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw fail('技能安装参数无效。');
  const destination = expandHome(options.destination ?? path.join(homedir(), '.ubovm', 'skills'));
  const limits = { ...DEFAULTS, ...(options.limits ?? {}) };
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw fail('当前环境不支持下载技能。');
  if (input.overwrite !== undefined && typeof input.overwrite !== 'boolean') throw fail('overwrite 必须是布尔值。');
  const hasContent = input.content !== undefined;
  const hasUrl = input.url !== undefined;
  if (hasContent === hasUrl) throw fail('请且仅提供 content（直接写入）或 url（下载安装）之一。');
  const requested = input.name === undefined ? undefined : skillName(String(input.name).trim());
  const entries = hasContent
    ? inlineEntries(input)
    : await archiveEntries({ ...input, name: requested }, fetchImpl, options.signal, limits);
  checkLimits(entries, limits);
  const parsed = splitSkill(decodeText(entries.get('SKILL.md'), 'SKILL.md'), 'SKILL.md');
  if (requested && requested !== parsed.name) throw fail(`技能名称与 SKILL.md 不一致：请求 ${requested}，frontmatter 为 ${parsed.name}。`);
  const directory = await publish(destination, parsed.name, entries, input.overwrite === true);
  return {
    name: parsed.name,
    description: parsed.description,
    directory: directory.target,
    source: hasContent ? 'inline' : 'url',
    files: [...entries.keys()].sort(),
    overwritten: directory.replaced
  };
}

module.exports = { installSkill, skillName, safeRelativePath, parseFrontmatterObject, splitSkill, DEFAULTS };
