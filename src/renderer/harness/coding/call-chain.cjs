'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { bounded } = require('./code-navigation.cjs');

const inside = (root, file) => { const p = path.relative(root, file); return !p || p !== '..' && !p.startsWith('..' + path.sep) && !path.isAbsolute(p); };
const result = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }], details: value });

function createCallChain(vscode, { locate, workspaceFolders }) {
  return sessionId => ({
    name: 'analyze_workspace_call_chain', recovery: 'retry-read-only', label: '分析代码调用链',
    description: 'Read-only bounded BFS over language-provider definition/references starting at a workspace path and 1-based line/column. Depth and node caps apply; results stay inside session workspace roots. Empty or truncated chains do not prove absence of callers/callees; fall back to search_workspace when providers are incomplete. Dirty buffers are rejected.',
    parameters: {
      type: 'object',
      properties: {
        root: { type: 'integer', minimum: 0 },
        path: { type: 'string' },
        line: { type: 'integer', minimum: 1 },
        column: { type: 'integer', minimum: 1 },
        direction: { type: 'string', enum: ['callees', 'callers', 'both'], description: 'callees follows definitions/implementations; callers follows references; both explores both edges.' },
        maxDepth: { type: 'integer', minimum: 1, maximum: 6 },
        maxNodes: { type: 'integer', minimum: 1, maximum: 100 }
      },
      required: ['path', 'line', 'column'],
      additionalProperties: false
    },
    async execute(_id, input, signal) {
      signal?.throwIfAborted();
      const direction = input.direction ?? 'both';
      const maxDepth = input.maxDepth ?? 2;
      const maxNodes = input.maxNodes ?? 40;
      if (!['callees', 'callers', 'both'].includes(direction)) throw new Error('无效的调用链方向。');
      if (!Number.isSafeInteger(maxDepth) || maxDepth < 1 || maxDepth > 6) throw new Error('maxDepth 必须在 1 至 6 之间。');
      if (!Number.isSafeInteger(maxNodes) || maxNodes < 1 || maxNodes > 100) throw new Error('maxNodes 必须在 1 至 100 之间。');
      const target = await locate(input, sessionId);
      const info = await fs.stat(target.file);
      if (!info.isFile() || info.size > 1024 * 1024) throw new Error('调用链分析仅支持不超过 1 MiB 的文件。');
      const document = await bounded(() => vscode.workspace.openTextDocument(vscode.Uri.file(target.file)), signal);
      if (document.isDirty) throw new Error('文件有未保存的编辑，请先保存后重试。');
      if (!Number.isSafeInteger(input.line) || input.line < 1 || input.line > document.lineCount
        || !Number.isSafeInteger(input.column) || input.column < 1 || input.column > document.lineAt(input.line - 1).text.length + 1) {
        throw new Error('调用链起点超出文件范围。');
      }
      const roots = await Promise.all(workspaceFolders(sessionId).filter(f => f.uri.scheme === 'file').map(f => fs.realpath(f.uri.fsPath)));
      const keyOf = node => `${node.root}:${node.path}:${node.line}:${node.column}`;
      const start = { root: target.rootIndex, path: target.path, line: input.line, column: input.column, depth: 0, via: 'start' };
      const nodes = [start];
      const edges = [];
      const seen = new Set([keyOf(start)]);
      const queue = [start];
      let truncated = false, omitted = 0, providerEmpty = 0;

      async function locateHits(command, file, line, column) {
        const uri = vscode.Uri.file(file);
        const doc = await bounded(() => vscode.workspace.openTextDocument(uri), signal);
        if (doc.isDirty) throw new Error('调用链遍历期间发现未保存文件，请保存后重试。');
        const version = doc.version;
        const raw = await bounded(() => vscode.commands.executeCommand(command, uri, new vscode.Position(line - 1, column - 1)), signal);
        signal?.throwIfAborted();
        if (doc.isDirty || doc.version !== version) throw new Error('调用链遍历期间文件已变化，请重新读取后重试。');
        const items = Array.isArray(raw) ? raw : raw ? [raw] : [];
        if (!items.length) providerEmpty++;
        const hits = [];
        for (const item of items) {
          const hitUri = item.targetUri ?? item.location?.uri ?? item.uri;
          const range = item.targetSelectionRange ?? item.selectionRange ?? item.location?.range ?? item.range ?? item.targetRange;
          if (hitUri?.scheme !== 'file' || !range?.start) { omitted++; continue; }
          let filePath;
          try { filePath = await fs.realpath(hitUri.fsPath); } catch { omitted++; continue; }
          const root = roots.findIndex(r => inside(r, filePath));
          if (root < 0) { omitted++; continue; }
          hits.push({
            root,
            path: path.relative(roots[root], filePath).split(path.sep).join('/'),
            line: range.start.line + 1,
            column: range.start.character + 1,
            file: filePath
          });
        }
        return hits;
      }

      while (queue.length) {
        signal?.throwIfAborted();
        if (nodes.length >= maxNodes) { truncated = true; break; }
        const current = queue.shift();
        if (current.depth >= maxDepth) continue;
        const currentFile = current.file ?? (current.root === target.rootIndex && current.path === target.path
          ? target.file
          : path.join(roots[current.root], current.path.split('/').join(path.sep)));
        const expansions = [];
        if (direction === 'callees' || direction === 'both') {
          expansions.push(['callees', 'vscode.executeDefinitionProvider'], ['callees', 'vscode.executeImplementationProvider']);
        }
        if (direction === 'callers' || direction === 'both') {
          expansions.push(['callers', 'vscode.executeReferenceProvider']);
        }
        for (const [via, command] of expansions) {
          signal?.throwIfAborted();
          let hits;
          try { hits = await locateHits(command, currentFile, current.line, current.column); }
          catch (error) {
            if (error.message?.includes('语言服务超时') || error.message?.includes('Navigation cancelled') || error.message?.includes('cancelled')) {
              truncated = true;
              continue;
            }
            throw error;
          }
          for (const hit of hits) {
            const next = { root: hit.root, path: hit.path, line: hit.line, column: hit.column, depth: current.depth + 1, via, file: hit.file };
            const key = keyOf(next);
            edges.push({ from: keyOf(current), to: key, via });
            if (seen.has(key)) continue;
            if (nodes.length >= maxNodes) { truncated = true; break; }
            seen.add(key);
            nodes.push(next);
            queue.push(next);
          }
          if (truncated) break;
        }
      }

      return result({
        direction,
        maxDepth,
        maxNodes,
        start: { root: start.root, path: start.path, line: start.line, column: start.column },
        nodes: nodes.map(({ file: _file, ...node }) => node),
        edges,
        totalNodes: nodes.length,
        omitted,
        providerEmpty,
        truncated,
        note: 'Bounded language-provider call-chain sketch only; incomplete indexing yields partial graphs.'
      });
    }
  });
}

module.exports = { createCallChain };
