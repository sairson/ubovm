(() => {
  const states = new WeakMap();
  const tr = value => window.UBOVMi18n?.t(value) ?? value;
  const node = (tag, className, text) => { const item = document.createElement(tag); item.className = className; if (text !== undefined) item.textContent = text; return item; };
  window.UBOVMCodeChanges = {
    update(root, summary, options) {
      let state = states.get(root);
      if (!state || state.options?.turnId !== options.turnId) { state = { pending: false }; states.set(root, state); }
      state.summary = summary; state.options = options;
      const signature = JSON.stringify([summary, options.busy, options.turnId, state.pending, state.error]);
      if (signature === state.signature) return false;
      const files = summary?.files ?? [];
      root.className = 'code-change-card'; root.setAttribute('aria-label', tr('本轮文件修改'));
      const header = node('div', 'code-change-heading');
      header.append(node('strong', '', tr(files.length ? `本轮修改 ${files.length} 个文件` : '本轮未记录工作区文件修改')));
      const counts = value => `${value.approximate ? '≤ ' : ''}+${value.added} / −${value.removed}`;
      if (files.length) header.append(node('span', 'code-change-counts', counts(summary)));
      const children = [header];
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
      if (files.length) {
        const list = node('ul', 'code-change-files');
        for (const file of files) {
          const row = node('li', 'code-change-file');
          const open = node('button', 'code-change-path', file.path); open.type = 'button';
          open.title = `工作区 ${file.root + 1} · 点击查看本轮修改差异`; open.disabled = state.pending;
          open.addEventListener('click', () => run('reviewCodeTurnFile', file.id));
          const badge = file.undone ? '已撤销' : file.state === 'conflict' ? '存在冲突' : file.state !== 'applied' ? '待核对' : file.operation === 'create' ? '新增' : file.operation === 'delete' ? '删除' : '修改';
          if (file.reason) row.title = file.reason;
          row.append(open, node('span', 'code-change-kind', tr(badge)), node('span', 'code-change-counts', counts(file)));
          list.append(row);
        }
        children.push(list);
        const undo = node('button', 'code-change-undo', tr(state.pending ? '正在处理…' : summary.undone ? '本轮修改已撤销' : '一键撤销本轮全部修改'));
        undo.type = 'button'; undo.disabled = state.pending || options.busy || summary.undone;
        undo.addEventListener('click', () => run('undoCodeTurn')); children.push(undo);
      }
      children.push(node('p', 'code-change-scope', tr('仅包含工作区编码工具记录的文件修改；SSH、终端和外部工具的操作不在此撤销范围内。') + (summary?.approximate ? tr(' 大规模差异的行数显示上限估算。') : '')));
      if (state.error) { const error = node('p', 'code-change-error', state.error); error.setAttribute('role', 'alert'); children.push(error); }
      // A failed DOM commit must not make the same snapshot look rendered.
      root.replaceChildren(...children); state.signature = signature; return true;
    }
  };
})();
