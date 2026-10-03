'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { createCodeNavigation } = require('./code-navigation.cjs');
const { createCallChain } = require('./call-chain.cjs');
const { createRenamePreview } = require('./rename-preview.cjs');
const { createProjectContext } = require('./project-context.cjs');
const { lineChanges } = require('./line-changes.cjs');
const LIMIT = 256 * 1024;
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

/** Host-owned coding tools and durable, per-conversation before/after snapshots. */
function createCodingService(vscode, context, { beforeEdit, turnId = () => undefined, workspaceFolders = () => vscode.workspace.workspaceFolders ?? [] } = {}) {
  let queue = Promise.resolve();
  const serial = action => { const next = queue.then(action); queue = next.catch(() => {}); return next; };
  const key = 'ubovm.codeChanges.v1';
  let records = context.workspaceState.get(key, []);
  const summaryCache = new Map();
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
  async function locate(input, sessionId) {
    const folders = workspaceFolders(sessionId).filter(folder => folder.uri.scheme === 'file');
    const index = input.root ?? 0;
    if (!Number.isSafeInteger(index) || index < 0 || !folders[index]) throw new Error('请选择已打开的工作区。');
    if (typeof input.path !== 'string' || !input.path || /[\x00-\x1f<>:"|?*]/.test(input.path) || path.isAbsolute(input.path)) throw new Error('请使用工作区内的相对文件路径。');
    const root = await fs.realpath(folders[index].uri.fsPath), file = path.resolve(root, input.path);
    if (!inside(root, file) || file === root) throw new Error('文件路径超出工作区。');
    const parts = path.relative(root, file).split(path.sep);
    if (parts.some(part => part.toLowerCase() === '.git' || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part))) throw new Error('此文件路径不支持编码修改。');
    let current = root;
    for (const part of parts) {
      current = path.join(current, part);
      try { if ((await fs.lstat(current)).isSymbolicLink()) throw new Error('编码工具不通过符号链接修改文件。'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    return { sessionId, root, file, path: path.relative(root, file), rootIndex: index };
  }
  async function read(file) {
    let handle;
    try {
      handle = await fs.open(file, 'r');
      const info = await handle.stat();
      if (!info.isFile() || info.size > LIMIT) throw new Error('编码工具仅支持不超过 256 KiB 的 UTF-8 文件。');
      const buffer = Buffer.alloc(LIMIT + 1);
      let count = 0;
      while (count < buffer.length) { const { bytesRead } = await handle.read(buffer, count, buffer.length - count, null); if (!bytesRead) break; count += bytesRead; }
      if (count > LIMIT) throw new Error('文件超过 256 KiB。');
      const text = buffer.subarray(0, count).toString('utf8');
      if (text.includes('\0') || !Buffer.from(text).equals(buffer.subarray(0, count))) throw new Error('文件不是有效的 UTF-8 文本。');
      return text;
    } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    finally { await handle?.close(); }
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
      const canonical = await fs.realpath(folders[root].uri.fsPath).catch(() => null);
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
      if (document.getText() !== expected) throw new Error('编辑器应用后的内容与预期不同，请检查文件。');
      if (!await document.save()) throw new Error('修改未能保存，请检查编辑器中的内容。');
    }
    if (await read(target.file) !== after) throw new Error('保存后的内容与预期不同，请检查文件（包括保存时格式化操作）。');
  }
  async function editFile(sessionId, input, signal, preview = false) {
    return serial(async () => {
      signal?.throwIfAborted(); assertTrusted();
      const target = await locate(input, sessionId);
      if (!preview) await reconcile(sessionId, target.file);
      const before = await read(target.file);
      await assertClean(target.file);
      let after;
      if (input.operation === 'create') {
        if (before !== null) throw new Error('文件已经存在，请使用 replace。');
        after = input.newText;
      } else {
        if (before === null) throw new Error('文件不存在。');
        if (typeof input.expectedHash !== 'string' || input.expectedHash !== hash(before)) {
          throw Object.assign(new Error('文件版本不匹配，请先调用 read_workspace_code 获取最新 hash。reason=hash_mismatch recovery=read_workspace_code'), {
            details: { reason: 'hash_mismatch', recovery: 'read_workspace_code', path: target.path }
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
          for (const item of ranges.reverse()) after = after.slice(0, item.start) + item.newText + after.slice(item.end);
        } else if (input.operation === 'patch') {
          if (!Array.isArray(input.edits) || !input.edits.length || input.edits.length > 100) throw new Error('patch 需要 1 至 100 个替换。');
          const ranges = input.edits.map(item => {
            if (!item || typeof item.oldText !== 'string' || !item.oldText || typeof item.newText !== 'string') throw new Error('每个替换需要非空 oldText 和 newText。');
            const start = before.indexOf(item.oldText);
            if (start < 0 || before.indexOf(item.oldText, start + 1) >= 0) throw new Error('oldText 必须精确匹配且仅出现一次，请增加上下文。');
            return { start, end: start + item.oldText.length, text: item.newText };
          }).sort((a, b) => a.start - b.start);
          for (let i = 1; i < ranges.length; i++) if (ranges[i].start < ranges[i - 1].end) throw new Error('替换范围不能重叠。');
          after = before;
          for (const range of ranges.reverse()) after = after.slice(0, range.start) + range.text + after.slice(range.end);
        } else if (input.operation === 'replace') {
          if (typeof input.oldText !== 'string' || !input.oldText || typeof input.newText !== 'string') throw new Error('replace 需要非空 oldText 和 newText。');
          const start = before.indexOf(input.oldText);
          if (start < 0 || before.indexOf(input.oldText, start + 1) >= 0) throw new Error('oldText 必须精确匹配且仅出现一次，请增加上下文。');
          after = before.slice(0, start) + input.newText + before.slice(start + input.oldText.length);
        } else throw new Error('不支持的编辑操作。');
      }
      if (after !== null && (typeof after !== 'string' || Buffer.byteLength(after) > LIMIT || after.includes('\0') || Buffer.from(after).toString('utf8') !== after)) throw new Error('修改内容必须是不超过 256 KiB 的有效 UTF-8 文本。');
      if (after !== null && (/\r(?!\n)/.test(after) || after.includes('\r\n') && /(?<!\r)\n/.test(after))) throw new Error('请使用统一的 LF 或 CRLF 换行符。');
      const old = records.find(record => record.sessionId === sessionId && record.file === target.file);
      if (old && old.after !== before) throw new Error('文件在上次 Agent 修改后已被其他操作更改，请先查看并清除该文件的旧记录。');
      if (before !== null && after !== null && before.startsWith('\uFEFF') !== after.startsWith('\uFEFF')) throw new Error('请保留文件原有的 UTF-8 BOM。');
      if (before === null && after !== null && !input.createParents && !(await fs.stat(path.dirname(target.file))).isDirectory()) throw new Error('父目录不存在。');
      if (preview) return output({ path: target.path, root: target.rootIndex, operation: input.operation, changed: before !== after, beforeHash: hash(before), afterHash: hash(after), beforeBytes: before === null ? 0 : Buffer.byteLength(before), afterBytes: after === null ? 0 : Buffer.byteLength(after), saved: false });
      if (before === after) return output({ path: target.path, changed: false, hash: hash(after) });
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
      return output({ path: target.path, root: target.rootIndex, operation: input.operation, hash: hash(after), changeId: record.id, saved: true,
        validation: 'not_run; call validate_workspace_changes after edits', review: '通过会话页头“代码更改”查看 diff 或撤销。' });
    });
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
        const content = await read(file.file);
        if (content === null) continue;
        bytes += Buffer.byteLength(content);
        if (bytes > 65536) { items.push({ path: name, omitted: true, reason: 'Instruction budget exceeded; read this file separately before editing.' }); continue; }
        items.push({ path: name, content });
      } catch (error) { items.push({ path: name, omitted: true, reason: error.message }); }
    }
    return items;
  }
  const navigation = createCodeNavigation(vscode, { locate, workspaceFolders });
  const callChain = createCallChain(vscode, { locate, workspaceFolders });
  const renamePreview = createRenamePreview(vscode, { locate, read, assertClean, workspaceFolders, hash });
  const projectContext = createProjectContext({ locate, read, stat: fs.stat, hash, assertClean });
  function tools(sessionId) {
    const base = { root: { type: 'integer', minimum: 0 }, path: { type: 'string', description: 'Workspace-relative file path' } };
    const paging = { offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 65536 } };
    const list = [
      navigation(sessionId),
      callChain(sessionId),
      renamePreview(sessionId),
      projectContext(sessionId),
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
      { name: 'read_workspace_code', recovery: 'retry-read-only', label: '读取待编辑代码', description: 'Read UTF-8 code up to 256 KiB with hash and scoped project instructions. Optional offset/limit paginate by UTF-16 character offsets; pass expectedHash on continuation. Follow nextOffset to read all needed context; truncated means this is not the whole file. Dirty buffers are rejected.',
        parameters: { type: 'object', properties: { ...base, ...paging, expectedHash: { type: 'string', description: 'Require this version when continuing paged reads.' } }, required: ['path'], additionalProperties: false },
        async execute(_id, input, signal) {
          signal?.throwIfAborted();
          const target = await locate(input, sessionId), content = await read(target.file);
          await assertClean(target.file);
          const version = hash(content);
          if (input.expectedHash !== undefined && input.expectedHash !== version) {
            throw Object.assign(new Error('文件版本不匹配，请从头重新读取。reason=hash_mismatch recovery=read_workspace_code'), {
              details: { reason: 'hash_mismatch', recovery: 'read_workspace_code', path: target.path }
            });
          }
          const projectInstructions = await instructions(target, signal);
          signal?.throwIfAborted();
          return output({ path: target.path, root: target.rootIndex, exists: content !== null, ...(input.offset !== undefined || input.limit !== undefined ? page(content, input) : { content, truncated: false }), hash: version, projectInstructions });
        } },
      { name: 'edit_workspace_file', label: '编辑工作区文件', description: 'Coding Agent: create, precisely replace once, patch multiple unique text fragments, edit exact UTF-16 ranges, or delete a workspace UTF-8 file. Patch edits all match the original file, are prevalidated together, and use one saved edit and undo record. Changes are immediately saved and retained for native diff review/undo. Use only for user-requested coding. Read with read_workspace_code first; replace/patch/ranges/delete require its expectedHash. Preserve newline style. Never claim tests ran using this tool. For new files, set createParents=true to create missing directories; empty directories remain after undo or failed save.',
        parameters: { type: 'object', properties: { ...base, createParents: { type: 'boolean', description: 'Create missing parent directories for create. Empty directories remain after undo or failed save.' }, operation: { type: 'string', enum: ['create', 'replace', 'patch', 'ranges', 'delete'] }, expectedHash: { type: 'string' }, oldText: { type: 'string' }, newText: { type: 'string' }, edits: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'object', properties: { oldText: { type: 'string', minLength: 1 }, start: { type: 'integer', minimum: 0 }, end: { type: 'integer', minimum: 0 }, newText: { type: 'string' } }, required: ['newText'], additionalProperties: false }, description: 'For patch: unique oldText replacements. For ranges: zero-based UTF-16 start/end offsets (end exclusive); insertion uses equal offsets. All edits target the same original hash and must not overlap.' } }, required: ['path', 'operation'], additionalProperties: false },
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
      description: 'Validate up to 20 proposed file edits without writing files, creating directories or recording changes. Checks hashes, ranges, content and current edit conflicts. Each file must appear once. Returns all validation failures; a successful preview is not a transaction or a guarantee against later changes. Use edit_workspace_files to apply after inspecting the affected files and instructions.',
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
      description: 'Apply up to 20 ordered file edits using the same schema as edit_workspace_file. This is NOT a transaction: stop on the first failure and return completed results plus failedIndex. Earlier changes remain saved and reviewable. Do not replay completed edits; inspect recovery after cancellation. Use fresh per-file hashes and avoid multiple entries for the same file.',
      parameters: { type: 'object', properties: { files: { type: 'array', minItems: 1, maxItems: 20, items: editTool.parameters } }, required: ['files'], additionalProperties: false },
      async execute(_id, input, signal) {
        signal?.throwIfAborted();
        if (!Array.isArray(input.files) || !input.files.length || input.files.length > 20) throw new Error('一次需要 1 至 20 个文件修改。');
        const completed = [];
        for (let index = 0; index < input.files.length; index++) {
          try { completed.push({ index, ...(await editFile(sessionId, input.files[index], signal)).details }); }
          catch (error) {
            signal?.throwIfAborted();
            return { ...output({ status: completed.length ? 'partially_applied' : 'failed', completed, failedIndex: index, error: error.message, remaining: input.files.length - index - 1, recovery: 'Inspect recover_workspace_changes before retrying; the failed edit may have reached the editor or disk.' }), isError: true };
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
    remove: sessionId => serial(() => persist(records.filter(item => item.sessionId !== sessionId))), dispose() { provider.dispose(); closed.dispose(); snapshots.clear(); turnDiffs.clear(); diffKeys.clear(); } };
}

module.exports = { createCodingService };
