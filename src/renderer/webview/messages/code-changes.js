(() => {
  const states = new WeakMap();
  const tr = (value, ...args) => window.UBOVMi18n?.t(value, ...args) ?? value;
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
        const renderFile = file => {
          const row = node('li', 'code-change-file');
          const open = node('button', 'code-change-path', file.path); open.type = 'button';
          open.title = `${file.path} · 工作区 ${file.root + 1} · 点击查看本轮修改差异`; open.disabled = state.pending;
          open.addEventListener('click', () => run('reviewCodeTurnFile', file.id));
          const badge = file.undone ? '已撤销' : file.state === 'conflict' ? '存在冲突' : file.state !== 'applied' ? '待核对' : file.operation === 'create' ? '新增' : file.operation === 'delete' ? '删除' : '修改';
          const kind = node('span', 'code-change-kind', tr(badge));
          kind.dataset.kind = file.undone ? 'undone' : file.state === 'conflict' ? 'conflict' : file.state !== 'applied' ? 'pending' : file.operation || 'replace';
          const openEditor = node('button', 'code-change-open');
          openEditor.type = 'button'; openEditor.disabled = state.pending;
          openEditor.title = tr('在编辑器中打开') + ' · ' + file.path;
          openEditor.setAttribute('aria-label', tr('在编辑器中打开') + ' ' + file.path);
          openEditor.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3h7v7m0-7-9 9"/><path d="M19 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h5"/></svg><span class="code-change-open-label">' + tr('打开') + '</span>';
          openEditor.addEventListener('click', () => run('openTurnFile', file.id));
          if (file.reason) row.title = file.reason;
          row.append(open, kind, counts(file), openEditor);
          return row;
        };
        const visible = files.slice(0, 3);
        const list = node('ul', 'code-change-files');
        for (const file of visible) list.append(renderFile(file));
        children.push(list);
        if (files.length > visible.length) {
          // Keep the card compact: the first three changed files are visible,
          // the rest stay one click away and preserve their expanded state
          // while execution summaries stream in.
          const more = node('details', 'code-change-more');
          more.open = state.moreOpen === true;
          const moreSummary = node('summary', 'code-change-more-toggle', tr('更多 {0} 个文件', files.length - visible.length));
          const moreList = node('ul', 'code-change-files');
          for (const file of files.slice(visible.length)) moreList.append(renderFile(file));
          more.append(moreSummary, moreList);
          more.addEventListener('toggle', () => { state.moreOpen = more.open; });
          children.push(more);
        }
        const blocked = files.filter(file => !file.undone && file.state && file.state !== 'applied').length;
        if (blocked) {
          const warning = node('p', 'code-change-warning', tr('有 {0} 个文件存在冲突或尚未确认的写入，请先在编辑器中核对并保存，再撤销或继续修改。', blocked));
          warning.setAttribute('role', 'status');
          children.push(warning);
        }
        const actions = node('div', 'code-change-actions');
        const undo = node('button', 'code-change-undo', tr(state.pending ? '正在处理…' : summary.undone ? '本轮修改已撤销' : '一键撤销本轮全部修改'));
        undo.type = 'button'; undo.disabled = state.pending || options.busy || summary.undone || blocked > 0;
        if (blocked) undo.title = tr('存在冲突或待核对文件，请先核对后再撤销。');
        undo.addEventListener('click', () => run('undoCodeTurn')); actions.append(undo);
        // Surface the two follow-up actions at the place where edits are read,
        // instead of making the reader rediscover them in the topbar overflow.
        const validate = node('button', 'code-change-validate', tr('验证修改'));
        validate.type = 'button'; validate.disabled = state.pending || options.busy;
        validate.title = tr('检查修改后的分支、诊断与项目建议检查');
        validate.addEventListener('click', () => run('validateCodeChanges'));
        const reviewAll = node('button', 'code-change-review', tr('查看全部更改'));
        reviewAll.type = 'button'; reviewAll.disabled = state.pending;
        reviewAll.title = tr('列出本轮及历史文件修改');
        reviewAll.addEventListener('click', () => run('reviewCodeChanges'));
        actions.append(validate);
        // The native review quick-pick is assist-scoped; goal execution panels
        // already expose their own review entry points.
        if (document.body.dataset.mode !== 'goal') actions.append(reviewAll);
        children.push(actions);
        children.push(node('p', 'code-change-scope', tr('仅包含工作区编码工具记录的文件修改；SSH、终端和外部工具的操作不在此撤销范围内。') + (summary?.approximate ? tr(' 大规模差异的行数显示上限估算。') : '')));
      }
      if (state.error) { const error = node('p', 'code-change-error', state.error); error.setAttribute('role', 'alert'); children.push(error); }
      // A failed DOM commit must not make the same snapshot look rendered.
      root.replaceChildren(...children); state.signature = signature; return true;
    }
  };
})();
