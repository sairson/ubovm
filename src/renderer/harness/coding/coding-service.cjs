'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { createCodeNavigation } = require('./code-navigation.cjs');
const { createCallChain } = require('./call-chain.cjs');
const { createRenamePreview } = require('./rename-preview.cjs');
const { createProjectContext } = require('./project-context.cjs');
const { lineChanges } = require('./line-changes.cjs');
// Whole-file read/edit ceiling. Files above this are still readable through the
// streaming windowed read path, but whole-file editing is refused so the change
// journal stays bounded.
const LIMIT = 1024 * 1024;
const hash = text => text === null ? null : createHash('sha256').update(text).digest('hex');
const output = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }], details: value });
const inside = (root, file) => { const p = path.relative(root, file); return !p || p !== '..' && !p.startsWith('..' + path.sep) && !path.isAbsolute(p); };
const identity = file => process.platform === 'win32' ? file.toLowerCase() : file;
function page(text, input) {
  const offset = input.offset ?? 0, limit = input.limit ?? 16384;
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 65536) throw new Error('无效的内容分页参数。');
  if (text === null) return { content: null, offset, nextOffset: null, totalCharacters: 0, truncated: false };
  // Offsets use UTF-16 code units, just like the editor. Do not split pairs.
  let start = Math.min(offset, text.length), end = Math.min(start + limit, text.length);
  const low = at => at > 0 && /[\uDC00-\uDFFF]/.test(text[at] ?? '') && /[\uD800-\uDBFF]/.test(text[at - 1]);
  if (low(start)) start--;
  if (low(end)) end++;
  return { content: text.slice(start, end), offset: start, nextOffset: end < text.length ? end : null, totalCharacters: text.length, truncated: start > 0 || end < text.length };
}

// Pure helper: derive 1-based line view from a UTF-16 slice without disturbing offsets.
// startLine counts '\n' in fullText.slice(0, start) so CRLF counts once; lines splits slice on /\r?\n/;
// surrogate-pair safety is already guaranteed by page().
function withLines(fullText, start, slice) {
  const startLine = fullText.slice(0, start).split('\n').length;
  const lines = slice.split(/\r?\n/);
  const contentWithLineNumbers = lines.map((line, index) => `${startLine + index}: ${line}`).join('\n');
  return { startLine, lines, contentWithLineNumbers };
}

// Line helpers for the line-oriented insert operation, so callers never hand-compute
// UTF-16 offsets. "" counts as one empty line; the last line may be empty after a
// trailing newline.
const lineCount = text => (text.match(/\n/g)?.length ?? 0) + 1;
function offsetAtLine(text, line) {
  let index = 0;
  for (let current = 1; current < line; current++) {
    const next = text.indexOf('\n', index);
    if (next === -1) return text.length;
    index = next + 1;
  }
  return index;
}

// Bounded before/after summary returned by edit results so the Agent can self-check
// without a second read. Large rewrites report approximate counts instead of stalling.
const SNIPPET_CONTEXT = 3, SNIPPET_LIMIT = 700;
function snippetAt(after, line) {
  if (after === null) return null;
  const lines = after.split('\n');
  const from = Math.max(0, line - 1 - SNIPPET_CONTEXT), to = Math.min(lines.length, line + SNIPPET_CONTEXT);
  let text = lines.slice(from, to).map((value, index) => `${from + index + 1}: ${value}`).join('\n');
  if (text.length > SNIPPET_LIMIT) text = text.slice(0, SNIPPET_LIMIT) + '…';
  return text;
}
// A single-hunk unified diff so the agent can verify an edit without a second
// read. `limit` bounds the returned text: normal edits keep it small, dryRun
// requests the full patch.
const PATCH_LIMIT = 3000, PREVIEW_PATCH_LIMIT = 65536;
function unifiedDiff(before, after, limit = PATCH_LIMIT) {
  // Drop the trailing empty element a final newline produces, so hunk counts are
  // real line numbers and the patch re-applies without a "\ No newline" marker.
  const trim = list => list.length > 1 && list[list.length - 1] === '' ? list.slice(0, -1) : list;
  const bounded = text => Buffer.byteLength(text) > limit
    ? `(diff omitted: ${Buffer.byteLength(text)} bytes; use list_workspace_changes)`
    : text;
  if (before === null || after === null) {
    if (before === after) return '';
    const lines = trim((before === null ? after : before).split('\n'));
    const header = before === null ? `@@ -0,0 +1,${lines.length} @@` : `@@ -1,${lines.length} +0,0 @@`;
    return bounded([header, ...lines.map(line => `${before === null ? '+' : '-'}${line}`)].join('\n'));
  }
  const a = trim(before.split('\n')), b = trim(after.split('\n'));
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length, endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  if (start === endA && start === endB) return '';
  const from = Math.max(0, start - SNIPPET_CONTEXT), toA = Math.min(a.length, endA + SNIPPET_CONTEXT);
  const lines = [`@@ -${from + 1},${toA - from} +${from + 1},${Math.min(b.length, endB + SNIPPET_CONTEXT) - from} @@`];
  for (let index = from; index < start; index++) lines.push(' ' + a[index]);
  for (let index = start; index < endA; index++) lines.push('-' + a[index]);
  for (let index = start; index < endB; index++) lines.push('+' + b[index]);
  for (let index = endA; index < toA; index++) lines.push(' ' + a[index]);
  return bounded(lines.join('\n'));
}
function changeSummary(before, after, patchLimit = PATCH_LIMIT) {
  const { added, removed, approximate } = lineChanges(before, after);
  let firstChangedLine = 1;
  if (before !== null && after !== null) {
    const max = Math.min(before.length, after.length);
    let cursor = 0;
    while (cursor < max && before[cursor] === after[cursor]) cursor++;
    for (let index = 0; index < cursor; index++) if (before[index] === '\n') firstChangedLine++;
  }
  return { added, removed, approximate, firstChangedLine, snippet: snippetAt(after, firstChangedLine),
    ...(patchLimit > 0 ? { patch: unifiedDiff(before, after, patchLimit) } : {}) };
}

// Offset of the end of the text of 1-based `line`, excluding its terminator.
// A preceding CR is excluded too, so a CRLF file never leaves a dangling "\r"
// behind after a line-range replacement. line <= 0 is the insertion point before
// line 1.
function lineEndOffset(text, line) {
  if (line <= 0) return 0;
  let index = 0;
  for (let current = 1; current <= line; current++) {
    const next = text.indexOf('\n', index);
    if (next === -1) return text.length;
    const end = next > index && text.charCodeAt(next - 1) === 13 ? next - 1 : next;
    if (current === line) return end;
    index = next + 1;
  }
  return text.length;
}

// Matching, in order of strictness: exact (which already ignores CRLF vs LF
// because lines are split first), then trailing whitespace ignored, then leading
// indentation ignored. An indentation-insensitive match is only accepted when the
// indentation difference is uniform, so the replacement can be re-indented to the
// file instead of being pasted back at the model's indentation.
const LINE_NORMALIZERS = [
  { mode: 'exact', apply: line => line },
  { mode: 'trimEnd', apply: line => line.replace(/[ \t]+$/, '') },
  { mode: 'trim', apply: line => line.trim() }
];

// Line spans without their terminators so a block can be located and replaced
// without disturbing the surrounding line endings.
function lineSpans(text) {
  const spans = [];
  let start = 0;
  while (start <= text.length) {
    const nl = text.indexOf('\n', start);
    if (nl < 0) { spans.push({ start, end: text.length, text: text.slice(start) }); break; }
    const end = nl > start && text.charCodeAt(nl - 1) === 13 ? nl - 1 : nl;
    spans.push({ start, end, text: text.slice(start, end) });
    start = nl + 1;
  }
  return spans;
}

// Locate `block` (its lines joined by "\n", no trailing newline). Returns the
// strictest level that produced matches plus every candidate span.
function findLineBlock(text, block) {
  const spans = lineSpans(text);
  const target = block.split('\n');
  for (const { mode, apply } of LINE_NORMALIZERS) {
    const wanted = target.map(apply);
    const hits = [];
    for (let index = 0; index + wanted.length <= spans.length; index++) {
      let matched = true;
      for (let offset = 0; offset < wanted.length; offset++) {
        if (apply(spans[index + offset].text) !== wanted[offset]) { matched = false; break; }
      }
      if (matched) {
        hits.push({ start: spans[index].start, end: spans[index + wanted.length - 1].end });
        if (hits.length > 16) break;
      }
    }
    if (hits.length) return { mode, hits };
  }
  return null;
}

// Normalize a replacement to the file's line ending. Models routinely emit LF
// while the file is CRLF; rejecting that is the single most common write friction.
function alignEol(text, eol) {
  if (typeof text !== 'string' || !text) return text;
  return eol === '\r\n' ? text.replace(/\r\n|\r|\n/g, '\r\n') : text.replace(/\r\n|\r/g, '\n');
}

// A per-line tolerant pattern for replaceAll: literal text with any trailing
// spaces/tabs at each line end tolerated and CRLF/LF treated as equal. This keeps
// substring semantics (oldText is not forced to whole lines) while matching the
// occurrences the model actually sees. Oversized inputs fall back to exact only.
function tolerantPattern(text) {
  if (typeof text !== 'string' || !text || text.length > 8192) return null;
  const lines = text.split('\n').map(line => line.endsWith('\r') ? line.slice(0, -1) : line);
  const escaped = lines.map(line => line.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const body = escaped.map((line, index) => index < escaped.length - 1 ? `${line}[ \\t]*\\r?\\n` : `${line}[ \\t]*`).join('');
  return body ? new RegExp(body, 'g') : null;
}

function nearestLineHint(before, block) {
  const probe = (block.split('\n').find(line => line.trim()) ?? '').trim();
  if (probe.length < 3) return '';
  const spans = lineSpans(before);
  let best = -1, bestScore = 0;
  for (let index = 0; index < spans.length; index++) {
    const candidate = spans[index].text.trim();
    if (!candidate) continue;
    const max = Math.min(candidate.length, probe.length);
    let score = 0;
    while (score < max && candidate[score] === probe[score]) score++;
    if (score > bestScore) { bestScore = score; best = index; }
  }
  return best >= 0 && bestScore >= 3 ? `；最接近的内容在第 ${best + 1} 行 ${JSON.stringify(spans[best].text.slice(0, 120))}` : '';
}

// 1-based line number and a short preview for each candidate offset, so an
// ambiguous match can be resolved with `occurrence` in one step.
function candidateInfo(before, offsets) {
  const spans = lineSpans(before);
  let pointer = 0;
  const items = [];
  for (const offset of offsets) {
    while (pointer + 1 < spans.length && spans[pointer + 1].start <= offset) pointer++;
    items.push({ line: pointer + 1, preview: spans[pointer].text.trim().slice(0, 100) });
  }
  return items;
}

function splitPlainLines(text) {
  return text.split('\n').map(line => line.endsWith('\r') ? line.slice(0, -1) : line);
}

// The uniform indentation difference between what the model wrote and what the
// file holds: adding `add`, removing `remove`, or null when it is not uniform
// (which means the block probably matched the wrong place and must not be fuzzed).
function indentDelta(block, matched) {
  const from = splitPlainLines(block), to = splitPlainLines(matched);
  if (from.length !== to.length) return null;
  let delta = null;
  for (let index = 0; index < from.length; index++) {
    if (!from[index].trim()) continue;
    const left = (from[index].match(/^[ \t]*/) ?? [''])[0];
    const right = (to[index].match(/^[ \t]*/) ?? [''])[0];
    const current = right.startsWith(left) ? { add: right.slice(left.length), remove: '' }
      : left.startsWith(right) ? { add: '', remove: left.slice(right.length) }
        : null;
    if (!current) return null;
    if (delta === null) delta = current;
    else if (delta.add !== current.add || delta.remove !== current.remove) return null;
  }
  return delta ?? { add: '', remove: '' };
}

// Re-apply the file's indentation to a replacement written at the model's
// indentation, preserving each line's relative nesting.
function reindent(text, delta) {
  if (!delta || (!delta.add && !delta.remove)) return text;
  return text.split('\n').map(line => {
    const cr = line.endsWith('\r') ? '\r' : '';
    const body = cr ? line.slice(0, -1) : line;
    if (!body.trim()) return line;
    if (delta.add) return delta.add + body + cr;
    return (body.startsWith(delta.remove) ? body.slice(delta.remove.length) : body) + cr;
  }).join('\n');
}

/** Re-indent `replacement` to match the located block. Returns null when the
 *  indentation differs non-uniformly, so callers can fail instead of mis-indenting. */
function alignReplacement(replacement, block, matched, mode) {
  if (mode === 'exact' || mode === 'trimEnd') return replacement;
  const delta = indentDelta(block, matched);
  return delta ? reindent(replacement, delta) : null;
}

function locateUnique(before, block, messages) {
  const missing = () => new Error(`${messages.missing}${nearestLineHint(before, block)}`);
  const ambiguous = offsets => {
    const candidates = candidateInfo(before, offsets);
    const lines = candidates.map(item => item.line).join('、');
    const error = new Error(`${messages.ambiguous}（匹配到 ${candidates.length} 处：第 ${lines} 行；用 occurrence 指定第几处，或增加上下文）`);
    error.details = { reason: 'ambiguous_match', recovery: messages.recovery ?? 'occurrence', candidates };
    return error;
  };
  const exact = before.indexOf(block);
  if (exact >= 0) {
    const offsets = [];
    for (let at = exact; at >= 0; at = before.indexOf(block, at + 1)) { offsets.push(at); if (offsets.length > 16) break; }
    if (offsets.length > 1) throw ambiguous(offsets);
    return { start: exact, end: exact + block.length, mode: 'exact', matched: block };
  }
  const located = findLineBlock(before, block);
  if (!located) throw missing();
  if (located.hits.length > 1) throw ambiguous(located.hits.map(hit => hit.start));
  const hit = located.hits[0];
  const matched = before.slice(hit.start, hit.end);
  // An indentation-insensitive hit is only usable when it can be aligned back.
  if (located.mode === 'trim' && !indentDelta(block, matched)) throw new Error(messages.indent ?? messages.ambiguous);
  return { start: hit.start, end: hit.end, mode: located.mode, matched };
}

// Minimal unified-diff reader: `@@ -a,b +c,d @@` hunks with space/'-'/'+ ' bodies.
// File headers before the first hunk are ignored, and an unmarked body line is
// accepted as context because models frequently omit its leading space. Context
// and removed lines locate the hunk, so a whole-patch edit stays hash-verified
// and atomic.
function parseUnifiedPatch(patch) {
  const hunks = [];
  let current;
  for (const raw of patch.split(/\r?\n/)) {
    if (raw.startsWith('@@')) {
      const header = /^@@+ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
      if (!header) throw new Error('补丁头无效，需要 @@ -a,b +c,d @@。');
      current = { beforeStart: Number(header[1]), before: [], after: [] };
      hunks.push(current);
      continue;
    }
    if (!current) continue; // git/file headers before the first hunk
    if (raw.startsWith('\\')) continue; // "\ No newline at end of file"
    const marker = raw[0];
    if (marker === '+') current.after.push(raw.slice(1));
    else if (marker === '-') current.before.push(raw.slice(1));
    else if (marker === ' ') { current.before.push(raw.slice(1)); current.after.push(raw.slice(1)); }
    else if (raw === '') continue; // blank separator between hunks
    else { current.before.push(raw); current.after.push(raw); } // unmarked context
  }
  const valid = hunks.filter(hunk => hunk.before.length || hunk.after.length);
  if (!valid.length) throw new Error('补丁不包含任何修改。');
  return valid;
}
function applyUnifiedPatch(before, hunks) {
  const eol = before.includes('\r\n') ? '\r\n' : '\n';
  const edits = [];
  let fuzzy = false, alreadyApplied = 0;
  for (const hunk of hunks) {
    const block = hunk.before.join(eol);
    const text = hunk.after.join(eol);
    const stated = offsetAtLine(before, hunk.beforeStart);
    if (!block) {
      // Pure insertion (`@@ -0,0 +1,3 @@`): insert after the stated line, keeping
      // the insertion on a line boundary.
      let at = offsetAtLine(before, hunk.beforeStart + 1);
      const prefix = at > 0 && before[at - 1] !== '\n' ? eol : '';
      edits.push({ start: at, end: at, text: prefix + (text ? text + eol : '') });
      continue;
    }
    const exact = before.startsWith(block, stated) ? stated : before.indexOf(block);
    if (exact >= 0 && (exact === stated || before.indexOf(block, exact + 1) < 0)) {
      edits.push({ start: exact, end: exact + block.length, text });
      continue;
    }
    // Whitespace- or indentation-tolerant match when the exact block is absent.
    const located = findLineBlock(before, block);
    if (located) {
      const hit = located.hits.find(item => item.start === stated) ?? (located.hits.length === 1 ? located.hits[0] : undefined);
      if (hit) {
        if (located.mode !== 'exact') fuzzy = true;
        const adjusted = alignReplacement(text, block, before.slice(hit.start, hit.end), located.mode);
        if (adjusted === null) throw new Error('补丁缩进差异不一致，无法自动对齐；请重新读取后生成补丁。');
        edits.push({ start: hit.start, end: hit.end, text: adjusted });
        continue;
      }
      if (located.hits.length > 1) throw new Error(`补丁块有 ${located.hits.length} 处匹配，请增加上下文行。`);
    }
    // Idempotency: the hunk's result already sits where it was expected.
    if (text && before.startsWith(text, stated)) { alreadyApplied++; continue; }
    throw new Error(`补丁上下文与当前文件不匹配${nearestLineHint(before, block)}；请重新读取后再生成补丁。`);
  }
  edits.sort((a, b) => a.start - b.start);
  for (let index = 1; index < edits.length; index++) if (edits[index].start < edits[index - 1].end) throw new Error('补丁块之间有重叠或顺序错误。');
  let after = before;
  for (const edit of [...edits].reverse()) after = after.slice(0, edit.start) + edit.text + after.slice(edit.end);
  return { after, hunks: hunks.length, fuzzy, alreadyApplied };
}

/** Host-owned coding tools and durable, per-conversation before/after snapshots. */
function createCodingService(vscode, context, { beforeEdit, turnId = () => undefined, unbounded = () => false, workspaceFolders = () => vscode.workspace.workspaceFolders ?? [] } = {}) {
  let queue = Promise.resolve();
  const serial = action => { const next = queue.then(action); queue = next.catch(() => {}); return next; };
  const key = 'ubovm.codeChanges.v1';
  let records = context.workspaceState.get(key, []);
  const summaryCache = new Map();
  const instructionCache = new Map();
  const lineStats = new WeakMap(), recordHashes = new WeakMap();
  const snapshots = new Map();
  const turnDiffs = new Map(), diffKeys = new Map();
  const provider = vscode.workspace.registerTextDocumentContentProvider('ubovm-diff', {
    provideTextDocumentContent: uri => snapshots.get(uri.toString()) ?? ''
  });
  const closed = vscode.workspace.onDidCloseTextDocument(document => {
    if (document.uri.scheme === 'ubovm-diff') {
      const uri = document.uri.toString(), key = diffKeys.get(uri);
      snapshots.delete(uri);
      if (key) {
        const entry = turnDiffs.get(key);
        if (entry) { diffKeys.delete(entry.left.toString()); diffKeys.delete(entry.right.toString()); }
        turnDiffs.delete(key);
      }
    }
  });
  async function persist(next) {
    if (Buffer.byteLength(JSON.stringify(next)) > 8 * 1024 * 1024) throw new Error('代码更改记录已达 8 MiB，请先清除不再需要的记录。');
    await context.workspaceState.update(key, next);
    records = next;
    summaryCache.clear();
  }
  function assertTrusted() {
    if (!vscode.workspace.isTrusted) throw new Error('请先信任工作区，再运行编码 Agent。');
  }
  // Root realpaths are stable within a session; cache them so a 20-file batch does
  // not repeat fs.realpath for every entry. Cleared when workspace folders change.
  const realpaths = new Map();
  async function canonicalRoot(fsPath) {
    const cached = realpaths.get(fsPath);
    if (cached !== undefined) return cached;
    const value = await fs.realpath(fsPath);
    realpaths.set(fsPath, value);
    return value;
  }
  const foldersChanged = vscode.workspace.onDidChangeWorkspaceFolders?.(() => { realpaths.clear(); checkCache.clear(); });
  async function locate(input, sessionId) {
    const open = unbounded(sessionId) === true;
    const folders = workspaceFolders(sessionId).filter(folder => folder.uri.scheme === 'file');
    const index = input.root ?? 0;
    if (typeof input.path !== 'string' || !input.path) throw new Error(open ? '文件路径无效。' : '请使用工作区内的相对文件路径。');
    if (/[\x00-\x1f<>"|?*]/.test(input.path) || !open && (input.path.includes(':') || path.isAbsolute(input.path))) throw new Error(open ? '文件路径无效。' : '请使用工作区内的相对文件路径。');
    if (!Number.isSafeInteger(index) || index < 0 && !open) throw new Error('请选择已打开的工作区。');
    if (!folders[index] && !open) throw new Error('请选择已打开的工作区。');
    const base = folders[index] ? await canonicalRoot(folders[index].uri.fsPath) : undefined;
    if (!base && !path.isAbsolute(input.path)) throw new Error('请选择已打开的工作区，或使用绝对路径。');
    const file = path.resolve(base ?? process.cwd(), input.path);
    if (!open && (!inside(base, file) || file === base)) throw new Error('文件路径超出工作区。');
    // 完全模式: a file outside every workspace root keeps its absolute path so the
    // journal and undo can still rebuild it, and skips the .git/reserved/symlink gates.
    const insideRoot = Boolean(base) && inside(base, file) && file !== base;
    const root = insideRoot ? base : path.dirname(file);
    const relativePath = insideRoot ? path.relative(base, file) : file;
    // 完全模式 skips the .git / reserved-name / symlink gates as well; the
    // confined modes keep all three.
    if (!open) {
      const parts = path.relative(root, file).split(path.sep).filter(Boolean);
      if (parts.some(part => part.toLowerCase() === '.git' || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part))) throw new Error('此文件路径不支持编码修改。');
      let current = root;
      for (const part of parts) {
        current = path.join(current, part);
        try { if ((await fs.lstat(current)).isSymbolicLink()) throw new Error('编码工具不通过符号链接修改文件。'); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
    }
    return { sessionId, root, file, path: relativePath, rootIndex: index };
  }
  async function read(file) {
    let handle;
    try {
      handle = await fs.open(file, 'r');
      const info = await handle.stat();
      if (!info.isFile() || info.size > LIMIT) throw new Error('编码工具仅支持不超过 1 MiB 的 UTF-8 文件；更大的文件请用 read_workspace_code 分页读取。');
      // Size the buffer to the file (plus one byte to detect growth) instead of
      // always allocating the 1 MiB ceiling.
      const buffer = Buffer.alloc(Math.min(info.size, LIMIT) + 1);
      let count = 0;
      while (count < buffer.length) { const { bytesRead } = await handle.read(buffer, count, buffer.length - count, null); if (!bytesRead) break; count += bytesRead; }
      if (count > LIMIT) throw new Error('文件超过 1 MiB。');
      const text = buffer.subarray(0, count).toString('utf8');
      if (text.includes('\0') || !Buffer.from(text).equals(buffer.subarray(0, count))) throw new Error('文件不是有效的 UTF-8 文本。');
      return text;
    } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    finally { await handle?.close(); }
  }
  // Streaming windowed read for files above LIMIT. Decodes with a fatal UTF-8
  // decoder (invalid bytes are rejected), keeps only the requested window in memory
  // and reports total characters plus the 1-based start line of the window.
  async function readWindow(file, offset, limit) {
    let handle;
    try {
      handle = await fs.open(file, 'r');
      const info = await handle.stat();
      if (!info.isFile()) throw new Error('编码工具仅支持读取普通文件。');
      const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
      const buffer = Buffer.alloc(64 * 1024);
      const from = Math.max(0, offset - 1), to = offset + limit + 1;
      let position = 0, seen = 0, collected = '', newlinesBeforeFrom = 0;
      const invalid = () => Object.assign(new Error('文件不是有效的 UTF-8 文本。'), { code: 'INVALID_UTF8' });
      while (true) {
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
        if (!bytesRead) break;
        position += bytesRead;
        let text;
        try { text = decoder.decode(buffer.subarray(0, bytesRead), { stream: true }); } catch { throw invalid(); }
        if (text.includes('\0')) throw Object.assign(new Error('编码工具仅支持不含 NUL 的 UTF-8 文本。'), { code: 'INVALID_TEXT' });
        if (seen < to) collected += text.slice(Math.max(0, from - seen), Math.max(0, to - seen));
        for (let index = Math.max(0, seen); index < Math.min(seen + text.length, from); index++) if (text[index - seen] === '\n') newlinesBeforeFrom++;
        seen += text.length;
      }
      try { const tail = decoder.decode(); if (tail) { if (seen < to) collected += tail.slice(Math.max(0, from - seen), Math.max(0, to - seen)); seen += tail.length; } } catch { throw invalid(); }
      const base = from;
      let start = offset, end = Math.min(offset + limit, seen);
      const at = index => collected[index - base] ?? '';
      const low = index => index > 0 && /[\uDC00-\uDFFF]/.test(at(index)) && /[\uD800-\uDBFF]/.test(at(index - 1));
      if (low(start)) start--;
      if (low(end)) end++;
      let startLine = newlinesBeforeFrom + 1;
      for (let index = 0; index < start - base; index++) if (collected[index] === '\n') startLine++;
      return { content: collected.slice(start - base, end - base), offset: start, nextOffset: end < seen ? end : null,
        totalCharacters: seen, truncated: start > 0 || end < seen, startLine };
    } finally { await handle?.close(); }
  }
  async function assertClean(file) {
    for (const doc of vscode.workspace.textDocuments) {
      if (doc.uri.scheme !== 'file' || !doc.isDirty) continue;
      const resolved = await fs.realpath(doc.uri.fsPath).catch(() => path.resolve(doc.uri.fsPath));
      if (identity(resolved) === identity(file)) {
        throw Object.assign(new Error('文件有未保存的编辑，请先保存后调用 read_workspace_code 再修改。reason=dirty recovery=save_then_read_workspace_code'), {
          details: { reason: 'dirty', recovery: 'save_then_read_workspace_code' }
        });
      }
    }
  }
  async function recordTarget(record) {
    const sessionId = record.sessionId;
    const folders = workspaceFolders(sessionId).filter(folder => folder.uri.scheme === 'file');
    for (let root = 0; root < folders.length; root++) {
      const canonical = await canonicalRoot(folders[root].uri.fsPath).catch(() => null);
      if (canonical !== record.root) continue;
      const target = await locate({ root, path: record.path }, sessionId);
      if (target.file === record.file) return target;
    }
    throw new Error('原工作区当前不可用，保留修改记录。');
  }
  async function reconcile(sessionId, file) {
    const next = [];
    for (const record of records) {
      if (sessionId !== undefined && record.sessionId !== sessionId || file !== undefined && record.file !== file) { next.push(record); continue; }
      let current, target;
      try { target = await recordTarget(record); current = await read(target.file); }
      catch (error) { next.push({ ...record, legacyPending: record.legacyPending ?? !record.state, state: 'unavailable', reason: error.message }); continue; }
      try { await assertClean(target.file); }
      catch (error) { next.push({ ...record, legacyPending: record.legacyPending ?? !record.state, state: 'conflict', reason: error.message }); continue; }
      let after = record.after, turns = record.turns;
      if (record.pending) {
        if (current === record.after) {
          if (record.pending === 'undo') continue;
        } else if (current === record.previousAfter) { after = record.previousAfter; turns = record.previousTurns; }
        else { next.push({ ...record, state: 'conflict', reason: '写入被中断且磁盘内容与写入前后均不一致。' }); continue; }
      } else if (current !== record.after) {
        // v1 had no write status. An unchanged original is an unapplied write.
        if ((!record.state || record.legacyPending) && current === record.before) continue;
        next.push({ ...record, state: 'conflict', reason: '磁盘内容已变化；未覆盖当前文件。' }); continue;
      }
      if (record.before === after && !turns?.length) continue;
      const { pending, previousAfter, previousTurns, reason, legacyPending, turns: _turns, ...stable } = record;
      next.push({ ...stable, ...(turns ? { turns } : {}), rootIndex: target.rootIndex, after, state: 'applied' });
    }
    // Snapshots can occupy MiBs. Compare immutable fields instead of serializing
    // all before/after texts twice merely to detect an unchanged journal.
    const unchanged = next.length === records.length && next.every((item, index) => {
      const previous = records[index], keys = Object.keys(item);
      return keys.length === Object.keys(previous).length && keys.every(key => item[key] === previous[key]);
    });
    if (!unchanged) await persist(next);
    return records.filter(record => sessionId === undefined || record.sessionId === sessionId);
  }
  const describe = list => list.filter(record => record.before !== record.after).map(({ id, path, rootIndex, before, after, state, reason }) => ({ id, path, root: rootIndex,
    operation: before === null ? 'create' : after === null ? 'delete' : 'replace', changed: before !== after, state: state ?? 'pending', ...(reason ? { reason } : {}) }));
  async function write(target, before, after, createParents = false) {
    assertTrusted(); await assertClean(target.file);
    const verified = await locate({ root: target.rootIndex, path: target.path }, target.sessionId);
    if (verified.file !== target.file || await read(target.file) !== before) throw new Error('文件已变化，请重新读取后再修改。');
    const uri = vscode.Uri.file(target.file), edit = new vscode.WorkspaceEdit();
    let document, textEdit;
    if (after === null) edit.deleteFile(uri, { ignoreIfNotExists: false });
    else if (before === null) {
      if (createParents) {
        await fs.mkdir(path.dirname(target.file), { recursive: true });
        await locate({ root: target.rootIndex, path: target.path }, target.sessionId);
      }
      if (!(await fs.stat(path.dirname(target.file))).isDirectory()) throw new Error('父目录不存在。');
      edit.createFile(uri, { overwrite: false, ignoreIfExists: false });
      textEdit = vscode.TextEdit.insert(new vscode.Position(0, 0), after);
    } else {
      document = await vscode.workspace.openTextDocument(uri);
      const bom = before.startsWith('\uFEFF');
      if (bom !== after.startsWith('\uFEFF')) throw new Error('请保留文件原有的 UTF-8 BOM。');
      const source = bom ? before.slice(1) : before, replacement = bom ? after.slice(1) : after;
      if (document.isDirty || document.getText() !== source) throw new Error('编辑器内容已变化，请保存并重新读取。');
      textEdit = vscode.TextEdit.replace(new vscode.Range(document.positionAt(0), document.positionAt(source.length)), replacement);
    }
    if (after !== null) {
      if (/\r(?!\n)/.test(after) || after.includes('\r\n') && /(?<!\r)\n/.test(after)) throw new Error('请使用统一的 LF 或 CRLF 换行符。');
      edit.set(uri, [textEdit, vscode.TextEdit.setEndOfLine(after.includes('\r\n') ? vscode.EndOfLine.CRLF : vscode.EndOfLine.LF)]);
    }
    if (!await vscode.workspace.applyEdit(edit)) throw new Error('编辑器拒绝应用修改。');
    if (after !== null) {
      document ??= await vscode.workspace.openTextDocument(uri);
      const expected = before?.startsWith('\uFEFF') ? after.slice(1) : after;
      if (document.getText() !== expected) throw Object.assign(new Error('编辑器应用后的内容与预期不同，请检查文件。reason=write_mismatch recovery=recover_workspace_changes'), { details: { reason: 'write_mismatch', recovery: 'recover_workspace_changes' } });
      if (!await document.save()) throw Object.assign(new Error('修改未能保存，请检查编辑器中的内容。reason=save_failed recovery=recover_workspace_changes'), { details: { reason: 'save_failed', recovery: 'recover_workspace_changes' } });
    }
    if (await read(target.file) !== after) throw Object.assign(new Error('保存后的内容与预期不同，请检查文件（包括保存时格式化操作）。reason=post_save_mismatch recovery=recover_workspace_changes'), { details: { reason: 'post_save_mismatch', recovery: 'recover_workspace_changes' } });
  }
  async function editFile(sessionId, input, signal, preview = false) {
    const isPreview = preview || input.dryRun === true;
    return serial(async () => {
      signal?.throwIfAborted(); assertTrusted();
      const target = await locate(input, sessionId);
      if (!isPreview) await reconcile(sessionId, target.file);
      const before = await read(target.file);
      await assertClean(target.file);
      let after, replacements, hunks, matchMode, patchSkipped = 0;
      // Align model-provided replacements to the file's line ending so a CRLF
      // file never rejects LF text (the most common write failure on Windows).
      const fileEol = before === null ? null : (before.includes('\r\n') ? '\r\n' : '\n');
      const align = text => fileEol ? alignEol(text, fileEol) : text;
      if (input.operation === 'create') {
        if (before !== null) throw new Error('文件已经存在，请使用 replace。');
        after = input.newText;
      } else {
        if (before === null) throw new Error('文件不存在。');
        const currentHash = hash(before);
        // Missing and stale versions are different mistakes. Separate them and
        // include the current hash so the model can recover in one step instead
        // of guessing why an edit was refused.
        if (typeof input.expectedHash !== 'string' || !input.expectedHash) {
          throw Object.assign(new Error(`缺少 expectedHash：请先用 read_workspace_code 读取本文件，或使用上一次 edit_workspace_file 返回的 hash。当前 hash=${currentHash}。reason=missing_hash recovery=read_workspace_code`), {
            details: { reason: 'missing_hash', recovery: 'read_workspace_code', path: target.path, currentHash, currentBytes: Buffer.byteLength(before) }
          });
        }
        if (input.expectedHash !== currentHash) {
          throw Object.assign(new Error(`文件版本不匹配（期望 ${input.expectedHash.slice(0, 12)}…，当前 ${currentHash.slice(0, 12)}…）。若刚才是你自己改的，请改用那次 edit_workspace_file 返回的 nextExpectedHash=${currentHash}；否则重新调用 read_workspace_code 获取最新内容与 hash。reason=hash_mismatch recovery=read_workspace_code`), {
            details: { reason: 'hash_mismatch', recovery: 'read_workspace_code', path: target.path, currentHash, currentBytes: Buffer.byteLength(before) }
          });
        }
        if (input.operation === 'delete') after = null;
        else if (input.operation === 'ranges') {
          if (!Array.isArray(input.edits) || !input.edits.length || input.edits.length > 100) throw new Error('ranges 需要 1 至 100 个替换。');
          const ranges = input.edits.map(item => {
            if (!item || !Number.isSafeInteger(item.start) || !Number.isSafeInteger(item.end) || item.start < 0 || item.end < item.start || item.end > before.length || typeof item.newText !== 'string') throw new Error('无效的 UTF-16 编辑范围。');
            for (const offset of [item.start, item.end]) if (offset > 0 && /[\uDC00-\uDFFF]/.test(before[offset] ?? '') && /[\uD800-\uDBFF]/.test(before[offset - 1])) throw new Error('编辑范围不能拆分 Unicode 代理对。');
            return item;
          }).sort((a, b) => a.start - b.start || a.end - b.end);
          for (let i = 1; i < ranges.length; i++) if (ranges[i].start < ranges[i - 1].end || ranges[i].start === ranges[i - 1].start) throw new Error('编辑范围不能重叠或共享起点。');
          after = before;
          for (const item of ranges.reverse()) after = after.slice(0, item.start) + align(item.newText) + after.slice(item.end);
        } else if (input.operation === 'patch') {
          if (!Array.isArray(input.edits) || !input.edits.length || input.edits.length > 100) throw new Error('patch 需要 1 至 100 个替换。');
          const ranges = input.edits.map(item => {
            if (!item || typeof item.oldText !== 'string' || !item.oldText || typeof item.newText !== 'string') throw new Error('每个替换需要非空 oldText 和 newText。');
            const located = locateUnique(before, item.oldText, {
              missing: 'oldText 必须精确匹配且仅出现一次，请增加上下文。',
              ambiguous: 'oldText 必须精确匹配且仅出现一次，请增加上下文。',
              indent: 'oldText 的缩进与文件不一致且不是统一偏移，无法自动对齐；请提供与文件一致的缩进。'
            });
            if (located.mode !== 'exact') matchMode = 'fuzzy';
            const adjusted = alignReplacement(align(item.newText), item.oldText, located.matched, located.mode);
            if (adjusted === null) throw new Error('oldText 的缩进与文件不一致且不是统一偏移，无法自动对齐；请提供与文件一致的 oldText。');
            return { start: located.start, end: located.end, text: adjusted };
          }).sort((a, b) => a.start - b.start);
          for (let i = 1; i < ranges.length; i++) if (ranges[i].start < ranges[i - 1].end) throw new Error('替换范围不能重叠。');
          after = before;
          for (const range of ranges.reverse()) after = after.slice(0, range.start) + range.text + after.slice(range.end);
        } else if (input.operation === 'replace') {
          if (typeof input.oldText !== 'string' || !input.oldText || typeof input.newText !== 'string') throw new Error('replace 需要非空 oldText 和 newText。');
          const replacement = align(input.newText);
          if (input.occurrence !== undefined) {
            if (!Number.isSafeInteger(input.occurrence) || input.occurrence < 1) throw new Error('occurrence 须为正整数。');
            let start = -1, from = 0;
            for (let nth = 0; nth < input.occurrence; nth++) {
              start = before.indexOf(input.oldText, from);
              if (start < 0) throw new Error(`oldText 在文件中出现次数少于 ${input.occurrence} 次。`);
              from = start + input.oldText.length;
            }
            after = before.slice(0, start) + replacement + before.slice(start + input.oldText.length);
          } else {
            const located = locateUnique(before, input.oldText, {
              missing: 'oldText 必须精确匹配且仅出现一次，请增加上下文或使用 occurrence。',
              ambiguous: 'oldText 必须精确匹配且仅出现一次，请增加上下文或使用 occurrence。',
              indent: 'oldText 的缩进与文件不一致且不是统一偏移，无法自动对齐；请提供与文件一致的缩进。'
            });
            if (located.mode !== 'exact') matchMode = located.mode;
            const adjusted = alignReplacement(replacement, input.oldText, located.matched, located.mode);
            if (adjusted === null) throw new Error('oldText 的缩进与文件不一致且不是统一偏移，无法自动对齐；请提供与文件一致的 oldText。');
            after = before.slice(0, located.start) + adjusted + before.slice(located.end);
          }
        } else if (input.operation === 'replaceAll') {
          if (typeof input.oldText !== 'string' || !input.oldText || typeof input.newText !== 'string') throw new Error('replaceAll 需要非空 oldText 和 newText。');
          if (input.expectedCount !== undefined && (!Number.isSafeInteger(input.expectedCount) || input.expectedCount < 1)) throw new Error('expectedCount 须为正整数。');
          const replacement = align(input.newText);
          const exactCount = before.split(input.oldText).length - 1;
          const pattern = tolerantPattern(input.oldText);
          const tolerantCount = pattern ? [...before.matchAll(pattern)].length : exactCount;
          if (!exactCount && !tolerantCount) throw new Error('oldText 在文件中不存在，未做任何替换。');
          const breakdown = tolerantCount === exactCount ? `${exactCount} 次` : `精确 ${exactCount} 次、忽略行尾空白与 CRLF/LF 后 ${tolerantCount} 次`;
          if (input.expectedCount !== undefined && exactCount !== input.expectedCount && tolerantCount !== input.expectedCount) {
            throw new Error(`oldText 出现 ${breakdown}，与 expectedCount=${input.expectedCount} 不符。去掉 expectedCount 可按现有匹配替换，或改用 patch 逐处指定。`);
          }
          // Prefer exact when it already satisfies the request; otherwise fall back
          // to the tolerant sweep so whitespace/CRLF differences no longer block it.
          if (exactCount && (input.expectedCount === undefined || exactCount === input.expectedCount)) {
            after = before.split(input.oldText).join(replacement);
            replacements = exactCount;
          } else {
            after = before.replace(pattern, () => replacement);
            replacements = tolerantCount;
            matchMode = 'trimEnd';
          }
          if (replacements > 1000) throw new Error('replaceAll 单次最多替换 1000 处，请缩小范围或改用 patch/ranges。');
        } else if (input.operation === 'insert') {
          if (typeof input.newText !== 'string') throw new Error('insert 需要 newText。');
          const total = lineCount(before);
          if (!Number.isSafeInteger(input.afterLine) || input.afterLine < 0 || input.afterLine > total) throw new Error(`afterLine 须为 0 到 ${total} 之间的整数（0=文件头，${total}=末尾）。`);
          const offset = offsetAtLine(before, input.afterLine + 1);
          // Keep the insertion on its own line even when the file has no trailing newline.
          const separator = offset > 0 && before[offset - 1] !== '\n' ? (fileEol ?? '\n') : '';
          after = before.slice(0, offset) + separator + align(input.newText) + before.slice(offset);
        } else if (input.operation === 'replaceLines') {
          if (typeof input.newText !== 'string') throw new Error('replaceLines 需要 newText。');
          const total = lineCount(before);
          if (!Number.isSafeInteger(input.startLine) || input.startLine < 1 || input.startLine > total) throw new Error(`startLine 须为 1 到 ${total} 之间的整数。`);
          if (!Number.isSafeInteger(input.endLine) || input.endLine < input.startLine - 1 || input.endLine > total) throw new Error(`endLine 须为 ${input.startLine - 1} 到 ${total} 之间的整数（= startLine-1 表示插入）。`);
          const start = offsetAtLine(before, input.startLine), end = lineEndOffset(before, input.endLine);
          after = before.slice(0, start) + align(input.newText) + before.slice(end);
        } else if (input.operation === 'applyPatch') {
          if (typeof input.patch !== 'string' || !input.patch.trim()) throw new Error('applyPatch 需要非空 patch。');
          const parsed = parseUnifiedPatch(input.patch);
          const applied = applyUnifiedPatch(before, parsed);
          after = applied.after; hunks = applied.hunks;
          if (applied.fuzzy) matchMode = 'fuzzy';
          patchSkipped = applied.alreadyApplied;
        } else throw new Error('不支持的编辑操作。');
      }
      if (after !== null && (typeof after !== 'string' || Buffer.byteLength(after) > LIMIT || after.includes('\0') || Buffer.from(after).toString('utf8') !== after)) throw new Error('修改内容必须是不超过 1 MiB 的有效 UTF-8 文本。');
      if (after !== null && (/\r(?!\n)/.test(after) || after.includes('\r\n') && /(?<!\r)\n/.test(after))) throw new Error('请使用统一的 LF 或 CRLF 换行符。');
      const old = records.find(record => record.sessionId === sessionId && record.file === target.file);
      if (old && old.after !== before) throw new Error('文件在上次 Agent 修改后已被其他操作更改，请先查看并清除该文件的旧记录。');
      if (before !== null && after !== null && before.startsWith('\uFEFF') !== after.startsWith('\uFEFF')) throw new Error('请保留文件原有的 UTF-8 BOM。');
      if (before === null && after !== null && !input.createParents && !(await fs.stat(path.dirname(target.file))).isDirectory()) throw new Error('父目录不存在。');
      if (isPreview) return output({ path: target.path, root: target.rootIndex, operation: input.operation, changed: before !== after,
        ...(replacements === undefined ? {} : { replacements }),
        ...(hunks === undefined ? {} : { hunks }),
        ...(matchMode ? { match: matchMode } : {}),
        ...(patchSkipped ? { already_applied: patchSkipped } : {}),
        beforeHash: hash(before), afterHash: hash(after), beforeBytes: before === null ? 0 : Buffer.byteLength(before), afterBytes: after === null ? 0 : Buffer.byteLength(after),
        // dryRun returns the complete patch up front so the edit can be reviewed
        // and re-applied without another read.
        patch: unifiedDiff(before, after, PREVIEW_PATCH_LIMIT), diff: changeSummary(before, after, 0),
        saved: false, validation: 'edit preconditions only; nothing was written' });
      if (before === after) return output({ path: target.path, changed: false, hash: hash(after), nextExpectedHash: hash(after),
        ...(matchMode ? { match: matchMode } : {}),
        ...(patchSkipped ? { already_applied: patchSkipped } : {}) });
      await beforeEdit?.(sessionId, target.file, { reset: !old });
      const currentTurn = turnId(sessionId);
      let turns = old?.turns;
      if (typeof currentTurn === 'string' && currentTurn) {
        if (turns?.some(item => item.id === currentTurn && item.undone)) throw new Error('本轮文件修改已撤销，请发送新消息开始新的修改。');
        const previous = turns?.find(item => item.id === currentTurn && !item.undone);
        const turn = { id: currentTurn, before: previous ? previous.before : before, after, updatedAt: Date.now() };
        turns = [...(turns ?? []).filter(item => item !== previous), turn];
      }
      const record = { ...target, id: old?.id ?? randomUUID(), sessionId, before: old ? old.before : before, after,
        ...(turns ? { turns, previousTurns: old?.turns ?? [] } : {}),
        state: 'pending', pending: 'write', previousAfter: before, updatedAt: Date.now() };
      signal?.throwIfAborted();
      // Journal before mutation: a crash or save failure never loses the original.
      await persist([...records.filter(item => item.id !== record.id), record]);
      try { signal?.throwIfAborted(); await write(target, before, after, input.createParents === true); }
      catch (error) {
        await reconcile(sessionId, target.file).catch(() => {});
        throw error;
      }
      await reconcile(sessionId, target.file);
      // A manifest edit invalidates cached check suggestions for that tree.
      if (path.basename(target.path) === 'package.json') checkCache.clear();
      return output({ path: target.path, root: target.rootIndex, operation: input.operation, changed: true, hash: hash(after), nextExpectedHash: hash(after), changeId: record.id, saved: true,
        ...(replacements === undefined ? {} : { replacements }),
        ...(hunks === undefined ? {} : { hunks }),
        ...(matchMode ? { match: matchMode } : {}),
        ...(patchSkipped ? { already_applied: patchSkipped } : {}),
        diff: changeSummary(before, after),
        checks: await suggestedChecks(target, signal),
        validation: 'not_run; call validate_workspace_changes after edits', review: '通过会话页头“代码更改”查看 diff 或撤销。' });
    });
  }
  // AGENTS.md files rarely change; reuse content until mtime or size differs so
  // repeated reads do not re-open every ancestor instruction file.
  async function readCachedInstruction(absolute) {
    let info;
    try { info = await fs.stat(absolute); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    const cached = instructionCache.get(absolute);
    if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) return cached.content;
    const content = await read(absolute);
    instructionCache.set(absolute, { mtimeMs: info.mtimeMs, size: info.size, content });
    return content;
  }
  async function instructions(target, signal) {
    const directories = [''];
    const relative = path.dirname(target.path);
    if (relative !== '.') {
      let current = '';
      for (const part of relative.split(path.sep)) { current = path.join(current, part); directories.push(current); }
    }
    const items = [];
    let bytes = 0;
    for (const directory of directories) {
      signal?.throwIfAborted();
      const name = path.join(directory, 'AGENTS.md');
      try {
        const file = await locate({ root: target.rootIndex, path: name }, target.sessionId);
        const content = await readCachedInstruction(file.file);
        if (content === null) continue;
        bytes += Buffer.byteLength(content);
        if (bytes > 65536) { items.push({ path: name, omitted: true, reason: 'Instruction budget exceeded; read this file separately before editing.' }); continue; }
        items.push({ path: name, content });
      } catch (error) { items.push({ path: name, omitted: true, reason: error.message }); }
    }
    return items;
  }
  const navigation = createCodeNavigation(vscode, { locate, workspaceFolders, unbounded });
  const callChain = createCallChain(vscode, { locate, workspaceFolders, unbounded });
  const renamePreview = createRenamePreview(vscode, { locate, read, assertClean, workspaceFolders, unbounded, hash });
  const projectContext = createProjectContext({ locate, read, stat: fs.stat, hash, assertClean });
  // Post-edit suggestions: point at the project's own check/test scripts so the
  // Agent closes the verification loop instead of stopping at the edit. Cached per
  // directory; invalidated when a manifest is edited, folders change or on dispose.
  const checkCache = new Map();
  async function suggestedChecks(target, signal) {
    const cacheKey = `${target.rootIndex}\0${path.dirname(target.path)}`;
    if (checkCache.has(cacheKey)) return checkCache.get(cacheKey);
    let value;
    try {
      const context = await projectContext.inspect({ root: target.rootIndex, path: target.path }, target.sessionId, signal);
      const project = context.projects?.[0];
      const pick = category => project ? project.tasks.filter(task => task.category === category && task.argv).map(task => ({ name: task.name, argv: task.argv })).slice(0, 4) : [];
      value = {
        validate: 'validate_workspace_changes',
        ...(project ? { cwd: project.cwd, ...(project.manager ? { manager: project.manager } : {}) } : {}),
        ...(pick('check').length ? { check: pick('check') } : {}),
        ...(pick('test').length ? { test: pick('test') } : {}),
        note: project
          ? 'Suggested from package scripts; nothing was executed and names are only hints. Run through an enabled execution tool with purpose/reason, or call validate_workspace_changes for type/syntax/diagnostics.'
          : 'No package manifest found near this file; call validate_workspace_changes and run the project checks you know apply.'
      };
    } catch (error) {
      signal?.throwIfAborted();
      value = { validate: 'validate_workspace_changes', note: 'Could not read project scripts; call validate_workspace_changes and run the checks you know apply.' };
    }
    checkCache.set(cacheKey, value);
    return value;
  }
  function tools(sessionId) {
    const base = { root: { type: 'integer', minimum: 0 }, path: { type: 'string', description: 'Workspace-relative file path' } };
    const paging = { offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 65536 } };
    const list = [
      navigation(sessionId),
      callChain(sessionId),
      renamePreview(sessionId),
      projectContext.tool(sessionId),
      { name: 'read_workspace_change', recovery: 'retry-read-only', label: '读取代码修改快照',
        description: 'Read a paginated before or after snapshot for a changeId from list_workspace_changes. Supports Agent review without opening UI. Snapshot hashes are not current disk hashes; conflict/unavailable state must be resolved before editing. Offsets are UTF-16 characters. Pass expectedHash when continuing a snapshot.',
        parameters: { type: 'object', properties: { changeId: { type: 'string' }, side: { type: 'string', enum: ['before', 'after'] }, ...paging, expectedHash: { type: 'string' } }, required: ['changeId', 'side'], additionalProperties: false },
        async execute(_id, input, signal) { return serial(async () => {
          signal?.throwIfAborted();
          if (!['before', 'after'].includes(input.side)) throw new Error('请选择 before 或 after。');
          const record = (await reconcile(sessionId)).find(item => item.id === input.changeId);
          if (!record) throw new Error('当前会话不存在此更改。');
          const text = record[input.side], version = hash(text);
          if (input.expectedHash !== undefined && version !== input.expectedHash) throw new Error('快照版本已变化，请重新读取。');
          signal?.throwIfAborted();
          return output({ ...describe([record])[0], side: input.side, hash: version, exists: text !== null, ...page(text, input) });
        }); } },
      { name: 'read_workspace_code', recovery: 'retry-read-only', label: '读取待编辑代码', description: 'Read UTF-8 code up to 1 MiB with a whole-file hash and scoped project instructions; use it for code to edit and to align UTF-16 ranges for edit_workspace_file (same offsets/hash). Files larger than 1 MiB return a streamed paged window with large:true and editable:false: read them here or with read_workspace_file, but whole-file editing is refused (reason=file_too_large). Optional offset/limit paginate by UTF-16 character offsets (surrogate pairs never split); pass expectedHash on continuation. Follow nextOffset until null; truncated means this is not the whole file. Optional lineNumbers:true adds startLine/lines/contentWithLineNumbers (1-based startLine, lines split on /\r?\n/ so CRLF does not disturb offsets). Loop example: let offset=0,hash; do { r=await read_workspace_code({path,offset,limit:16384,expectedHash:hash}); hash=r.hash; use r.content or r.contentWithLineNumbers; offset=r.nextOffset; } while(offset!==null). For large files prefer small limit (2048-16384); on hash mismatch re-read from offset 0. Dirty buffers are rejected. Missing files return exists:false without a tool error.',
        parameters: { type: 'object', properties: { ...base, ...paging, expectedHash: { type: 'string', description: 'Require this version when continuing paged reads.' }, lineNumbers: { type: 'boolean', description: 'When true add startLine/lines/contentWithLineNumbers; default false.' } }, required: ['path'], additionalProperties: false },
        async execute(_id, input, signal) {
          signal?.throwIfAborted();
          if (input.lineNumbers !== undefined && typeof input.lineNumbers !== 'boolean') throw new Error('lineNumbers 须为 boolean。');
          const target = await locate(input, sessionId);
          let stats;
          try { stats = await fs.stat(target.file); } catch (error) { if (error.code === 'ENOENT') stats = null; else throw error; }
          await assertClean(target.file);
          // Files above the whole-file limit are still readable page by page; only
          // whole-file editing (and its before/after snapshots) is refused.
          if (stats && stats.isFile() && stats.size > LIMIT) {
            const offset = input.offset ?? 0, limit = input.limit ?? 16384;
            if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 65536) throw new Error('无效的内容分页参数。');
            const windowed = await readWindow(target.file, offset, limit);
            const withLineNumbers = input.lineNumbers === true;
            const lines = withLineNumbers ? windowed.content.split(/\r?\n/) : undefined;
            return output({ path: target.path, root: target.rootIndex, exists: true,
              ...windowed,
              ...(withLineNumbers ? { lines, contentWithLineNumbers: lines.map((line, index) => `${windowed.startLine + index}: ${line}`).join('\n') } : {}),
              hash: hash(windowed.content), hashKind: 'sha256-window', large: true, editable: false, totalBytes: stats.size,
              guidance: 'This file is larger than 1 MiB. Paged reads work; whole-file editing is refused (reason=file_too_large recovery=read_workspace_file). Edit a smaller file, or extract the change into a separate module.' });
          }
          const content = await read(target.file);
          const version = hash(content);
          if (content !== null && input.expectedHash !== undefined && input.expectedHash !== version) {
            throw Object.assign(new Error(`文件版本不匹配（期望 ${String(input.expectedHash).slice(0, 12)}…，当前 ${version.slice(0, 12)}…）。请从头重新读取。reason=hash_mismatch recovery=read_workspace_code`), {
              details: { reason: 'hash_mismatch', recovery: 'read_workspace_code', path: target.path, currentHash: version, currentBytes: Buffer.byteLength(content) }
            });
          }
          const projectInstructions = await instructions(target, signal);
          signal?.throwIfAborted();
          const withLineNumbers = input.lineNumbers === true;
          let body;
          if (content === null) {
            body = { content: null, guidance: 'This file does not exist. Create it if needed; a missing path is not a tool failure.' };
          } else if (input.offset !== undefined || input.limit !== undefined) {
            const paged = page(content, input);
            body = withLineNumbers ? { ...paged, ...withLines(content, paged.offset, paged.content) } : paged;
          } else if (withLineNumbers) {
            body = { content, truncated: false, ...withLines(content, 0, content) };
          } else {
            body = { content, truncated: false };
          }
          return output({ path: target.path, root: target.rootIndex, exists: content !== null,
            ...body,
            hash: version, projectInstructions });
        } },
      { name: 'edit_workspace_file', label: '编辑工作区文件', description: 'Create, edit or delete one workspace UTF-8 file. Flow: read_workspace_code for the current hash, edit here, then validate_workspace_changes. Operations: create (new file; set createParents for missing directories; empty directories remain after undo or a failed save); replace (one unique oldText -> newText; an ambiguous match is rejected with the candidate line numbers, then add occurrence:N to target the Nth match); replaceAll (every oldText -> newText, optional expectedCount, up to 1000 places); replaceLines (replace lines startLine..endLine inclusive with newText; endLine = startLine-1 inserts before startLine); insert (afterLine: 0 = start of file, N = after line N, line count = end of file); patch (several unique oldText edits, prevalidated together as one saved edit); ranges (zero-based UTF-16 start/end, end exclusive; insertion uses equal offsets); applyPatch (unified diff text with @@ hunks, located by context lines); delete. Everything except create requires expectedHash from the read; patch/ranges/applyPatch edits must not overlap and target the same original hash. dryRun:true validates and returns before/after hashes plus the complete unified patch without writing. Changes save immediately and keep one undo record per file; preserve newline style and any BOM. Never claim tests ran. The result carries hash and nextExpectedHash: reuse nextExpectedHash as expectedHash for a follow-up edit on the same file instead of re-reading, and never reuse an older hash. oldText/context matching tolerates CRLF-vs-LF and trailing-whitespace differences and aligns newText to the file newline, so a CRLF file never rejects LF text (replaceAll counts with the same tolerance and, on a real mismatch, reports the exact and tolerant counts); a uniform indentation offset is also accepted and newText is re-indented to the file while non-uniform indentation is refused; applyPatch also accepts hunks with no context (pure insertion) and unmarked context lines, applies them at the stated line, and reports already_applied when a hunk is already present; the result diff carries a small unified patch for verification and omits it when oversized.',
        parameters: { type: 'object', properties: { ...base, createParents: { type: 'boolean', description: 'Create missing parent directories for create.' }, operation: { type: 'string', enum: ['create', 'replace', 'replaceAll', 'replaceLines', 'insert', 'patch', 'ranges', 'applyPatch', 'delete'] }, expectedHash: { type: 'string' }, oldText: { type: 'string' }, newText: { type: 'string' }, occurrence: { type: 'integer', minimum: 1, description: 'replace: target the Nth occurrence instead of requiring uniqueness.' }, expectedCount: { type: 'integer', minimum: 1, description: 'replaceAll: require exactly this many occurrences.' }, startLine: { type: 'integer', minimum: 1, description: 'replaceLines: first line to replace (1-based, inclusive).' }, endLine: { type: 'integer', minimum: 0, description: 'replaceLines: last line to replace (inclusive); startLine-1 inserts.' }, afterLine: { type: 'integer', minimum: 0, description: 'insert: insert after this 1-based line; 0 = start of file, line count = end.' }, patch: { type: 'string', description: 'applyPatch: unified diff text with @@ -a,b +c,d @@ hunks; include context lines.' }, dryRun: { type: 'boolean', description: 'Validate and return before/after hashes and a diff without writing.' }, edits: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'object', properties: { oldText: { type: 'string', minLength: 1 }, start: { type: 'integer', minimum: 0 }, end: { type: 'integer', minimum: 0 }, newText: { type: 'string' } }, required: ['newText'], additionalProperties: false }, description: 'For patch: unique oldText replacements. For ranges: zero-based UTF-16 start/end offsets (end exclusive); insertion uses equal offsets. All edits target the same original hash and must not overlap.' } }, required: ['path', 'operation'], additionalProperties: false },
        execute: (_id, input, signal) => editFile(sessionId, input, signal) },
      { name: 'list_workspace_changes', label: '查看代码更改', description: 'List this conversation’s recorded code changes. Review opens from the IDE code changes button.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        async execute(_id, _input, signal) { signal?.throwIfAborted(); return serial(async () => output(describe(await reconcile(sessionId)))); } },
      { name: 'recover_workspace_changes', label: '恢复代码修改状态', description: 'Reconcile saved edit journals against actual files after cancellation/restart. Never writes workspace files. Returns applied, conflict or unavailable records; unapplied writes are rolled back in the journal.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        async execute(_id, _input, signal) { signal?.throwIfAborted(); return serial(async () => output(describe(await reconcile(sessionId)))); } }
    ];
    const editTool = list.find(tool => tool.name === 'edit_workspace_file');
    list.push({ name: 'preview_workspace_edits', recovery: 'retry-read-only', label: '检查跨文件修改方案',
      description: 'Validate up to 20 proposed file edits without writing files, creating directories or recording changes (the same preflight edit_workspace_files runs). Checks hashes, ranges, content, duplicate files and current edit conflicts, and returns before/after hashes and a complete unified patch per file. Each file must appear once; a successful preview is not a transaction or a guarantee against later changes. Use edit_workspace_files to apply after inspecting the affected files and instructions.',
      parameters: { type: 'object', properties: { files: { type: 'array', minItems: 1, maxItems: 20, items: editTool.parameters } }, required: ['files'], additionalProperties: false },
      async execute(_id, input, signal) {
        if (!Array.isArray(input.files) || !input.files.length || input.files.length > 20) throw new Error('一次需要 1 至 20 个文件修改。');
        const results = [], seen = new Set();
        for (let index = 0; index < input.files.length; index++) {
          signal?.throwIfAborted();
          try {
            const target = await locate(input.files[index], sessionId), key = identity(target.file);
            if (seen.has(key)) throw new Error('预览中每个文件只能出现一次。');
            seen.add(key);
            results.push({ index, valid: true, ...(await editFile(sessionId, input.files[index], signal, true)).details });
          } catch (error) { signal?.throwIfAborted(); results.push({ index, valid: false, error: error.message }); }
        }
        return output({ status: results.every(item => item.valid) ? 'ready' : 'invalid', results, saved: false, validation: 'edit preconditions only; tests/build not run' });
      }
    });
    list.push({ name: 'edit_workspace_files', label: '批量编辑工作区文件',
      description: 'Apply up to 20 file edits using the same schema as edit_workspace_file. Every file is preflighted first, so a foreseeable failure (stale hash, bad range, duplicate file, missing parent) returns status=invalid with nothing written. A valid batch applies in order; a race after preflight stops at the failing index and returns completed plus failedIndex. Each file may appear once. Use fresh per-file hashes; inspect recover_workspace_changes after a cancellation.',
      parameters: { type: 'object', properties: { files: { type: 'array', minItems: 1, maxItems: 20, items: editTool.parameters } }, required: ['files'], additionalProperties: false },
      async execute(_id, input, signal) {
        signal?.throwIfAborted();
        if (!Array.isArray(input.files) || !input.files.length || input.files.length > 20) throw new Error('一次需要 1 至 20 个文件修改。');
        // Preflight every file against current disk state before any write, so a
        // foreseeable failure never leaves a half-applied batch.
        const results = [], seen = new Set();
        for (let index = 0; index < input.files.length; index++) {
          signal?.throwIfAborted();
          try {
            const target = await locate(input.files[index], sessionId), key = identity(target.file);
            if (seen.has(key)) throw new Error('同一文件在批量修改中只能出现一次。');
            seen.add(key);
            results.push({ index, valid: true, ...(await editFile(sessionId, input.files[index], signal, true)).details });
          } catch (error) { signal?.throwIfAborted(); results.push({ index, valid: false, error: error.message }); }
        }
        if (results.some(item => item.valid === false)) {
          return { ...output({ status: 'invalid', results, applied: [], validation: 'edit preconditions only; nothing was written' }), isError: true };
        }
        const completed = [];
        for (let index = 0; index < input.files.length; index++) {
          try { completed.push({ index, ...(await editFile(sessionId, input.files[index], signal)).details }); }
          catch (error) {
            signal?.throwIfAborted();
            // Preflight already passed, so this is a race: the file changed between
            // validation and application.
            return { ...output({ status: completed.length ? 'partially_applied' : 'failed', completed, failedIndex: index, error: error.message, notAttempted: input.files.length - index - 1, recovery: 'The file changed after preflight; inspect recover_workspace_changes before retrying.' }), isError: true };
          }
        }
        return output({ status: 'applied', completed, validation: 'not_run' });
      }
    });
    return list;
  }
  async function review(sessionId) {
    const list = await serial(() => reconcile(sessionId));
    if (!list.length) { await vscode.window.showInformationMessage('当前会话暂无代码更改。向 Agent 描述需要实现或修改的代码即可开始。'); return; }
    const selected = await vscode.window.showQuickPick(list.map(record => ({ label: `${record.state === 'conflict' ? '冲突' : record.state === 'unavailable' ? '不可用' : record.before === null ? '新增' : record.after === null ? '删除' : '修改'}  ${record.path}`, description: record.reason || record.root, record })), { title: '代码更改', placeHolder: '选择文件查看修改前后 diff' });
    if (!selected) return;
    const record = selected.record;
    const token = randomUUID();
    const uri = side => vscode.Uri.parse(`ubovm-diff:/${token}/${side}/${encodeURIComponent(path.basename(record.path))}`);
    const left = uri('before'), right = uri('after');
    snapshots.set(left.toString(), record.before ?? ''); snapshots.set(right.toString(), record.after ?? '');
    try { await vscode.commands.executeCommand('vscode.diff', left, right, `${record.path} · Agent 修改`, { viewColumn: vscode.ViewColumn.Two, preview: false }); }
    catch (error) { snapshots.delete(left.toString()); snapshots.delete(right.toString()); throw error; }
    const action = await vscode.window.showQuickPick(['保留修改', '撤销此文件修改', '清除此文件记录'], { title: record.path, placeHolder: 'diff 为本会话保存的快照；撤销会检查文件当前版本' });
    if (!action || action === '保留修改') return;
    await serial(async () => {
      const latest = records.find(item => item.id === record.id);
      if (latest !== record) throw new Error('更改记录已更新，请重新打开 diff。');
      if (action === '撤销此文件修改') {
        const target = await recordTarget(record);
        // Undo is journaled too, so a crash after restoring the file is recoverable.
        if (await read(target.file) !== record.after) throw new Error('文件已变化，请先处理冲突。');
        await assertClean(target.file);
        const undo = { ...record, state: 'pending', pending: 'undo', previousAfter: record.after, after: record.before };
        await persist(records.map(item => item.id === record.id ? undo : item));
        try { await write(target, record.after, record.before); }
        catch (error) { await reconcile(sessionId).catch(() => {}); throw error; }
      }
      await persist(records.filter(item => item.id !== record.id));
    });
  }
  function turnSummary(sessionId) {
    if (summaryCache.has(sessionId)) return summaryCache.get(sessionId);
    const result = Object.create(null), revisions = new Map();
    for (const record of records.filter(item => item.sessionId === sessionId)) {
      if (!record.turns?.length) continue;
      let stamp = recordHashes.get(record);
      if (!stamp) { stamp = hash(JSON.stringify(record)); recordHashes.set(record, stamp); }
      for (const turn of record.turns) {
        let stamps = revisions.get(turn.id);
        if (!stamps) { stamps = new Set(); revisions.set(turn.id, stamps); }
        stamps.add(stamp);
        if (turn.before === turn.after) continue;
        const item = result[turn.id] ??= { files: [], added: 0, removed: 0, approximate: false, undone: true, revision: '' };
        let counts = lineStats.get(turn);
        if (!counts) { counts = lineChanges(turn.before, turn.after); lineStats.set(turn, counts); }
        const undone = turn.undone === true && !record.pending;
        item.files.push({ id: record.id, path: record.path, root: record.rootIndex, operation: turn.before === null ? 'create' : turn.after === null ? 'delete' : 'replace',
          ...counts, undone, state: record.state, reason: record.reason });
        item.added += counts.added; item.removed += counts.removed;
        item.approximate ||= counts.approximate; item.undone &&= undone;
      }
    }
    for (const [id, item] of Object.entries(result)) {
      item.revision = hash(JSON.stringify([...revisions.get(id)]));
    }
    summaryCache.set(sessionId, result); return result;
  }
  async function showTurnFile(sessionId, id, fileId, openFile = false) {
    const record = records.find(item => item.sessionId === sessionId && item.id === fileId);
    const turn = record?.turns?.find(item => item.id === id);
    if (!turn) throw new Error('本轮修改记录已不存在，请刷新后重试。');
    const target = await recordTarget(record);
    if (openFile && await read(target.file) !== null) {
      await vscode.window.showTextDocument(vscode.Uri.file(target.file), { viewColumn: vscode.ViewColumn.Two, preview: false }); return;
    }
    const key = JSON.stringify([sessionId, id, fileId, hash(turn.before), hash(turn.after)]);
    let entry = turnDiffs.get(key);
    if (!entry) {
      const token = randomUUID();
      entry = { left: vscode.Uri.parse(`ubovm-diff:/${token}/before/${encodeURIComponent(path.basename(record.path))}`),
        right: vscode.Uri.parse(`ubovm-diff:/${token}/after/${encodeURIComponent(path.basename(record.path))}`) };
      turnDiffs.set(key, entry);
      snapshots.set(entry.left.toString(), turn.before ?? ''); snapshots.set(entry.right.toString(), turn.after ?? '');
      diffKeys.set(entry.left.toString(), key); diffKeys.set(entry.right.toString(), key);
    }
    if (entry.opening) return entry.opening;
    // Stable URIs let the editor reveal the existing tab rather than retain
    // another pair of potentially large snapshots for every repeated click.
    entry.opening = Promise.resolve().then(() => vscode.commands.executeCommand('vscode.diff', entry.left, entry.right,
      `${record.path} · 本轮修改`, { viewColumn: vscode.ViewColumn.Two, preview: false })).catch(error => {
        if (turnDiffs.get(key) === entry) turnDiffs.delete(key);
        for (const uri of [entry.left, entry.right]) { snapshots.delete(uri.toString()); diffKeys.delete(uri.toString()); }
        throw error;
      }).finally(() => { entry.opening = undefined; });
    return entry.opening;
  }
  function undoTurn(sessionId, id, revision) {
    return serial(async () => {
      assertTrusted();
      await reconcile(sessionId);
      const summary = turnSummary(sessionId)[id];
      if (!summary || summary.revision !== revision) throw new Error('修改记录已更新，请查看最新记录后重试。');
      if (summary.files.some(file => !file.undone && file.state !== 'applied')) throw new Error('文件存在冲突或尚未确认的写入，请先保存编辑器内容并检查文件状态。');
      const plan = [];
      // Preflight every file before the first write, including dirty buffers.
      for (const record of records.filter(item => item.sessionId === sessionId)) {
        const turn = record.turns?.find(item => item.id === id && !item.undone && item.before !== item.after);
        if (!turn) continue;
        const latest = record.turns.findLast(item => !item.undone && item.before !== item.after);
        if (latest !== turn || record.after !== turn.after) throw new Error(`${record.path} 有后续修改，请先撤销后续轮次。`);
        const target = await recordTarget(record); await assertClean(target.file);
        if (await read(target.file) !== turn.after) throw new Error(`${record.path} 已被其他操作修改，本轮未撤销。`);
        plan.push({ record, turn, target });
      }
      let restored = 0;
      for (const { record, turn, target } of plan) {
        const undo = { ...record, after: turn.before, previousAfter: record.after, previousTurns: record.turns,
          turns: record.turns.map(item => item === turn ? { ...item, undone: true } : item), state: 'pending', pending: 'write' };
        try {
          await persist(records.map(item => item.id === record.id ? undo : item));
          await write(target, record.after, turn.before);
          await reconcile(sessionId, record.file); restored++;
        } catch (error) {
          await reconcile(sessionId).catch(() => {});
          restored = plan.filter(({ record: planned, turn: plannedTurn }) => {
            const latest = records.find(item => item.id === planned.id);
            return latest && !latest.pending && latest.state === 'applied' && latest.turns?.some(item => item.id === plannedTurn.id && item.undone);
          }).length;
          throw new Error(`已撤销 ${restored}/${plan.length} 个文件；${record.path}：${error.message}。请检查当前状态后重试。`);
        }
      }
      return { restored };
    });
  }
  return { tools, review, turnSummary, showTurnFile, undoTurn, recover: sessionId => serial(() => reconcile(sessionId)), changes: sessionId => serial(async () => describe(await reconcile(sessionId))),
    remove: sessionId => serial(() => persist(records.filter(item => item.sessionId !== sessionId))), dispose() { provider.dispose(); closed.dispose(); foldersChanged?.dispose?.(); snapshots.clear(); turnDiffs.clear(); diffKeys.clear(); realpaths.clear(); instructionCache.clear(); checkCache.clear(); } };
}

module.exports = { createCodingService, withLines };
