(() => {
  const states = new WeakMap();
  const tr = value => window.UBOVMi18n?.t(value) ?? value;
  const node = (tag, className, text) => { const item = document.createElement(tag); item.className = className; if (text !== undefined) item.textContent = text; return item; };
  const amount = value => Number(value || 0).toLocaleString('en-US');
  const counts = value => {
    const wrap = node('span', 'code-change-counts');
    if (value?.approximate) wrap.append(node('span', 'code-change-approx', '≤ '));
    wrap.append(
      node('span', 'code-change-added', `+${value?.added ?? 0}`),
      node('span', 'code-change-count-sep', ' / '),
      node('span', 'code-change-removed', `−${value?.removed ?? 0}`)
    );
    return wrap;
  };
  const usageSignature = value => {
    if (!value || typeof value !== 'object') return '';
    const num = key => {
      const raw = value[key];
      if (!Number.isFinite(raw) || raw < 0) return 0;
      return Math.min(Number.MAX_SAFE_INTEGER, Math.floor(raw));
    };
    const total = num('totalTokens') || num('input') + num('output') + num('cacheRead') + num('cacheWrite');
    if (!(num('input') || num('output') || num('cacheRead') || num('cacheWrite') || total)) return '';
    const cost = Number.isFinite(value.cost?.total) && value.cost.total >= 0 ? value.cost.total : 0;
    return [num('input'), num('output'), num('cacheRead'), num('cacheWrite'), total, cost].join('|');
  };
  const hasUsage = value => Boolean(usageSignature(value));
  const usageLine = value => {
    if (!hasUsage(value)) return null;
    const parts = [];
    const push = (label, key) => {
      const raw = value[key];
      if (!Number.isFinite(raw) || raw <= 0) return;
      parts.push(`${tr(label)} ${amount(Math.floor(raw))}`);
    };
    push('输入', 'input');
    push('输出', 'output');
    push('缓存读', 'cacheRead');
    push('缓存写', 'cacheWrite');
    const total = Number.isFinite(value.totalTokens) && value.totalTokens > 0
      ? Math.floor(value.totalTokens)
      : Math.floor((value.input || 0) + (value.output || 0) + (value.cacheRead || 0) + (value.cacheWrite || 0));
    if (total > 0) parts.push(`${tr('共')} ${amount(total)}`);
    const cost = value.cost?.total;
    if (Number.isFinite(cost) && cost > 0) {
      parts.push(cost < 0.01
        ? `${tr('约')} $${cost.toFixed(4)}`
        : `${tr('约')} $${cost.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`);
    }
    const line = node('p', 'code-change-usage');
    const metrics = node('span', 'code-change-usage-metrics', parts.join(' · '));
    line.append(node('span', 'code-change-usage-label', tr('本轮 Token 消耗')), document.createTextNode('：'), metrics);
    return line;
  };
  window.UBOVMCodeChanges = {
    usageSignature,
    update(root, summary, options) {
      let state = states.get(root);
      if (!state || state.options?.turnId !== options.turnId) { state = { pending: false }; states.set(root, state); }
      state.summary = summary; state.options = options;
      const signature = JSON.stringify([summary, options.usage, options.busy, options.turnId, state.pending, state.error]);
      if (signature === state.signature) return false;
      const files = summary?.files ?? [];
      const empty = files.length === 0;
      const usage = usageLine(options.usage);
      const usageOnly = empty && Boolean(usage);
      root.className = empty ? 'code-change-card code-change-empty' : 'code-change-card';
      root.setAttribute('aria-label', tr(usage ? '本轮文件修改（含 Token 消耗）' : '本轮文件修改'));
      const header = node('div', 'code-change-heading');
      const title = empty
        ? (usageOnly ? '本轮未修改工作区文件' : '本轮未记录工作区文件修改')
        : `本轮修改 ${files.length} 个文件`;
      header.append(node('strong', '', tr(title)));
      if (!empty) header.append(counts(summary));
      const children = [header];
      if (usage) children.push(usage);
      const run = async (action, fileId) => {
        const current = () => root.isConnected && states.get(root) === state;
        if (!current() || state.signature !== signature || state.pending || action === 'undoCodeTurn' && options.busy) return;
        state.pending = true; state.error = '';
        try {
          window.UBOVMCodeChanges.update(root, state.summary, state.options);
          await options.onAction(action, { turnId: options.turnId, fileId, revision: summary?.revision });
        } catch (error) {
          if (current()) {
            state.error = '操作失败，请重试。';
            try { state.error = window.UBOVMErrors?.text(error) || error?.message || state.error; } catch {}
          }
        } finally {
          state.pending = false;
          if (current()) {
            try { window.UBOVMCodeChanges.update(root, state.summary, state.options); }
            catch {
              state.signature = undefined;
              try { window.UBOVMRuntime?.fail('修改记录显示失败。请同步状态；已发送操作不会自动重试。'); } catch {}
            }
          }
        }
      };
      if (!empty) {
        const list = node('ul', 'code-change-files');
        for (const file of files) {
          const row = node('li', 'code-change-file');
          const open = node('button', 'code-change-path', file.path); open.type = 'button';
          open.title = `${file.path} · 工作区 ${file.root + 1} · 点击查看本轮修改差异`; open.disabled = state.pending;
          open.addEventListener('click', () => run('reviewCodeTurnFile', file.id));
          const badge = file.undone ? '已撤销' : file.state === 'conflict' ? '存在冲突' : file.state !== 'applied' ? '待核对' : file.operation === 'create' ? '新增' : file.operation === 'delete' ? '删除' : '修改';
          const kind = node('span', 'code-change-kind', tr(badge));
          kind.dataset.kind = file.undone ? 'undone' : file.state === 'conflict' ? 'conflict' : file.state !== 'applied' ? 'pending' : file.operation || 'replace';
          if (file.reason) row.title = file.reason;
          row.append(open, kind, counts(file));
          list.append(row);
        }
        children.push(list);
        const undo = node('button', 'code-change-undo', tr(state.pending ? '正在处理…' : summary.undone ? '本轮修改已撤销' : '一键撤销本轮全部修改'));
        undo.type = 'button'; undo.disabled = state.pending || options.busy || summary.undone;
        undo.addEventListener('click', () => run('undoCodeTurn')); children.push(undo);
        children.push(node('p', 'code-change-scope', tr('仅包含工作区编码工具记录的文件修改；SSH、终端和外部工具的操作不在此撤销范围内。') + (summary?.approximate ? tr(' 大规模差异的行数显示上限估算。') : '')));
      }
      if (state.error) { const error = node('p', 'code-change-error', state.error); error.setAttribute('role', 'alert'); children.push(error); }
      // A failed DOM commit must not make the same snapshot look rendered.
      root.replaceChildren(...children); state.signature = signature; return true;
    }
  };
})();
