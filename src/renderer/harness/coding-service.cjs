'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const LIMIT = 256 * 1024;
const hash = text => text === null ? null : createHash('sha256').update(text).digest('hex');
const output = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }], details: value });
const inside = (root, file) => { const p = path.relative(root, file); return !p || p !== '..' && !p.startsWith('..' + path.sep) && !path.isAbsolute(p); };

/** Host-owned coding tools and durable, per-conversation before/after snapshots. */
function createCodingService(vscode, context, { beforeEdit, workspaceFolders = () => vscode.workspace.workspaceFolders ?? [] } = {}) {
  let queue = Promise.resolve();
  const serial = action => { const next = queue.then(action); queue = next.catch(() => {}); return next; };
  const key = 'ubovm.codeChanges.v1';
  let records = context.workspaceState.get(key, []);
  const snapshots = new Map();
  const provider = vscode.workspace.registerTextDocumentContentProvider('ubovm-diff', {
    provideTextDocumentContent: uri => snapshots.get(uri.toString()) ?? ''
  });
  const closed = vscode.workspace.onDidCloseTextDocument(document => {
    if (document.uri.scheme === 'ubovm-diff') snapshots.delete(document.uri.toString());
  });
  async function persist(next) {
    if (Buffer.byteLength(JSON.stringify(next)) > 8 * 1024 * 1024) throw new Error('代码更改记录已达 8 MiB，请先清除不再需要的记录。');
    await context.workspaceState.update(key, next);
    records = next;
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
      if (resolved.toLowerCase() === file.toLowerCase()) throw new Error('文件有未保存的编辑，请先保存后重试。');
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
      let after = record.after;
      if (record.pending) {
        if (current === record.after) {
          if (record.pending === 'undo') continue;
        } else if (current === record.previousAfter) after = record.previousAfter;
        else { next.push({ ...record, state: 'conflict', reason: '写入被中断且磁盘内容与写入前后均不一致。' }); continue; }
      } else if (current !== record.after) {
        // v1 had no write status. An unchanged original is an unapplied write.
        if ((!record.state || record.legacyPending) && current === record.before) continue;
        next.push({ ...record, state: 'conflict', reason: '磁盘内容已变化；未覆盖当前文件。' }); continue;
      }
      if (record.before === after) continue;
      const { pending, previousAfter, reason, legacyPending, ...stable } = record;
      next.push({ ...stable, rootIndex: target.rootIndex, after, state: 'applied' });
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
  const describe = list => list.map(({ id, path, rootIndex, before, after, state, reason }) => ({ id, path, root: rootIndex,
    operation: before === null ? 'create' : after === null ? 'delete' : 'replace', changed: before !== after, state: state ?? 'pending', ...(reason ? { reason } : {}) }));
  async function write(target, before, after) {
    assertTrusted(); await assertClean(target.file);
    const verified = await locate({ root: target.rootIndex, path: target.path }, target.sessionId);
    if (verified.file !== target.file || await read(target.file) !== before) throw new Error('文件已变化，请重新读取后再修改。');
    const uri = vscode.Uri.file(target.file), edit = new vscode.WorkspaceEdit();
    let document, textEdit;
    if (after === null) edit.deleteFile(uri, { ignoreIfNotExists: false });
    else if (before === null) {
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
  async function editFile(sessionId, input, signal) {
    return serial(async () => {
      signal?.throwIfAborted(); assertTrusted();
      const target = await locate(input, sessionId);
      await reconcile(sessionId, target.file);
      const before = await read(target.file);
      await assertClean(target.file);
      let after;
      if (input.operation === 'create') {
        if (before !== null) throw new Error('文件已经存在，请使用 replace。');
        after = input.newText;
      } else {
        if (before === null) throw new Error('文件不存在。');
        if (typeof input.expectedHash !== 'string' || input.expectedHash !== hash(before)) throw new Error('文件版本不匹配，请先调用 read_workspace_code 获取最新 hash。');
        if (input.operation === 'delete') after = null;
        else if (input.operation === 'replace') {
          if (typeof input.oldText !== 'string' || !input.oldText || typeof input.newText !== 'string') throw new Error('replace 需要非空 oldText 和 newText。');
          const start = before.indexOf(input.oldText);
          if (start < 0 || before.indexOf(input.oldText, start + 1) >= 0) throw new Error('oldText 必须精确匹配且仅出现一次，请增加上下文。');
          after = before.slice(0, start) + input.newText + before.slice(start + input.oldText.length);
        } else throw new Error('不支持的编辑操作。');
      }
      if (after !== null && (typeof after !== 'string' || Buffer.byteLength(after) > LIMIT || after.includes('\0') || Buffer.from(after).toString('utf8') !== after)) throw new Error('修改内容必须是不超过 256 KiB 的有效 UTF-8 文本。');
      if (before === after) return output({ path: target.path, changed: false, hash: hash(after) });
      const old = records.find(record => record.sessionId === sessionId && record.file === target.file);
      if (old && old.after !== before) throw new Error('文件在上次 Agent 修改后已被其他操作更改，请先查看并清除该文件的旧记录。');
      await beforeEdit?.(sessionId, target.file, { reset: !old });
      const record = { ...target, id: old?.id ?? randomUUID(), sessionId, before: old ? old.before : before, after,
        state: 'pending', pending: 'write', previousAfter: before, updatedAt: Date.now() };
      signal?.throwIfAborted();
      // Journal before mutation: a crash or save failure never loses the original.
      await persist([...records.filter(item => item.id !== record.id), record]);
      try { signal?.throwIfAborted(); await write(target, before, after); }
      catch (error) {
        await reconcile(sessionId, target.file).catch(() => {});
        throw error;
      }
      await reconcile(sessionId, target.file);
      return output({ path: target.path, root: target.rootIndex, operation: input.operation, hash: hash(after), changeId: record.id, saved: true,
        validation: 'not_run; call validate_workspace_changes after edits', review: '通过会话页头“代码更改”查看 diff 或撤销。' });
    });
  }
  function tools(sessionId) {
    const base = { root: { type: 'integer', minimum: 0 }, path: { type: 'string', description: 'Workspace-relative file path' } };
    return [
      { name: 'read_workspace_code', recovery: 'retry-read-only', label: '读取待编辑代码', description: 'Read a complete UTF-8 file up to 256 KiB and its hash before editing. Never edit from truncated context.',
        parameters: { type: 'object', properties: base, required: ['path'], additionalProperties: false },
        async execute(_id, input, signal) { signal?.throwIfAborted(); const target = await locate(input, sessionId), content = await read(target.file); signal?.throwIfAborted(); return output({ path: target.path, root: target.rootIndex, exists: content !== null, content, hash: hash(content) }); } },
      { name: 'edit_workspace_file', label: '编辑工作区文件', description: 'Coding Agent: create, precisely replace once, or delete a workspace UTF-8 file. Changes are immediately saved and retained for native diff review/undo. Use only for user-requested coding. Read with read_workspace_code first; replace/delete require its expectedHash. Preserve newline style. Never claim tests ran using this tool. Parent directory must exist for new files.',
        parameters: { type: 'object', properties: { ...base, operation: { type: 'string', enum: ['create', 'replace', 'delete'] }, expectedHash: { type: 'string' }, oldText: { type: 'string' }, newText: { type: 'string' } }, required: ['path', 'operation'], additionalProperties: false },
        execute: (_id, input, signal) => editFile(sessionId, input, signal) },
      { name: 'list_workspace_changes', label: '查看代码更改', description: 'List this conversation’s recorded code changes. Review opens from the IDE code changes button.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        async execute(_id, _input, signal) { signal?.throwIfAborted(); return serial(async () => output(describe(await reconcile(sessionId)))); } },
      { name: 'recover_workspace_changes', label: '恢复代码修改状态', description: 'Reconcile saved edit journals against actual files after cancellation/restart. Never writes workspace files. Returns applied, conflict or unavailable records; unapplied writes are rolled back in the journal.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        async execute(_id, _input, signal) { signal?.throwIfAborted(); return serial(async () => output(describe(await reconcile(sessionId)))); } }
    ];
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
  return { tools, review, recover: sessionId => serial(() => reconcile(sessionId)), changes: sessionId => serial(async () => describe(await reconcile(sessionId))),
    remove: sessionId => serial(() => persist(records.filter(item => item.sessionId !== sessionId))), dispose() { provider.dispose(); closed.dispose(); snapshots.clear(); } };
}

module.exports = { createCodingService };
