(() => {
  'use strict';

  function createModalDialog() {
    const dialog = document.getElementById('ubovm-modal');
    if (!dialog) throw new Error('Missing #ubovm-modal');
    const title = document.getElementById('ubovm-modal-title');
    const message = document.getElementById('ubovm-modal-message');
    const detail = document.getElementById('ubovm-modal-detail');
    const error = document.getElementById('ubovm-modal-error');
    const field = document.getElementById('ubovm-modal-field');
    const label = document.getElementById('ubovm-modal-label');
    const input = document.getElementById('ubovm-modal-input');
    const searchWrap = document.getElementById('ubovm-modal-search-wrap');
    const search = document.getElementById('ubovm-modal-search');
    const list = document.getElementById('ubovm-modal-list');
    const empty = document.getElementById('ubovm-modal-empty');
    const cancel = document.getElementById('ubovm-modal-cancel');
    const confirm = document.getElementById('ubovm-modal-confirm');
    const close = document.getElementById('ubovm-modal-close');
    const footer = document.getElementById('ubovm-modal-footer');

    let open = false;
    let kind = '';
    let settle;
    let lastFocus;
    let items = [];
    let activeId = '';
    let filter = '';
    let validate;
    let busy = false;

    const setText = (node, value) => { if (node && node.textContent !== value) node.textContent = value; };
    const showError = text => {
      if (!error) return;
      if (!text) { error.hidden = true; setText(error, ''); return; }
      setText(error, text); error.hidden = false;
    };
    const finish = value => {
      if (!settle) return;
      const done = settle;
      settle = undefined;
      busy = false;
      closeDialog();
      done(value);
    };

    function closeDialog() {
      open = false;
      kind = '';
      items = [];
      activeId = '';
      filter = '';
      validate = undefined;
      busy = false;
      showError('');
      document.body.classList.remove('ubovm-modal-visible');
      if (dialog.open) {
        try { dialog.close(); } catch { /* already closing */ }
      }
      const focus = lastFocus;
      lastFocus = undefined;
      try { focus?.focus?.({ preventScroll: true }); } catch { /* ignore */ }
    }

    function prepare(options = {}) {
      kind = options.kind || 'confirm';
      dialog.dataset.kind = kind;
      setText(title, options.title || '');
      setText(message, options.message || '');
      message.hidden = !options.message;
      setText(detail, options.detail || '');
      detail.hidden = !options.detail;
      showError('');
      field.hidden = kind !== 'prompt';
      searchWrap.hidden = kind !== 'search';
      list.hidden = kind !== 'search';
      empty.hidden = true;
      footer.hidden = kind === 'search';
      cancel.hidden = options.hideCancel === true;
      setText(cancel, options.cancelLabel || '取消');
      setText(confirm, options.confirmLabel || '确定');
      confirm.classList.toggle('danger-button', options.danger === true);
      confirm.classList.toggle('primary-button', options.danger !== true);
      if (kind === 'prompt') {
        setText(label, options.label || '名称');
        input.value = options.value || '';
        input.maxLength = Number.isFinite(options.maxLength) ? options.maxLength : 60;
        input.placeholder = options.placeholder || '';
        validate = typeof options.validate === 'function' ? options.validate : undefined;
      }
      if (kind === 'search') {
        search.value = '';
        filter = '';
        items = Array.isArray(options.items) ? options.items.slice() : [];
        activeId = items[0]?.id || '';
        renderList();
      }
      lastFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
      if (!dialog.open) dialog.showModal();
      open = true;
      document.body.classList.add('ubovm-modal-visible');
      if (kind === 'prompt') { input.focus(); input.select(); }
      else if (kind === 'search') search.focus();
      else confirm.focus();
    }

    function renderList() {
      const query = filter.toLocaleLowerCase().trim();
      const terms = query.split(/\s+/).filter(Boolean);
      const visible = items.filter(item => {
        if (!terms.length) return true;
        const haystack = `${item.label || ''} ${item.description || ''} ${item.detail || ''} ${item.searchText || ''}`.toLocaleLowerCase();
        return terms.every(term => haystack.includes(term));
      });
      empty.hidden = visible.length > 0;
      setText(empty, query ? '没有匹配的会话' : (items.length ? '没有匹配的会话' : '暂无会话'));
      const fragment = document.createDocumentFragment();
      for (const item of visible) {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'ubovm-modal-row' + (item.id === activeId ? ' is-active' : '');
        row.dataset.id = item.id;
        row.setAttribute('role', 'option');
        row.setAttribute('aria-selected', item.id === activeId ? 'true' : 'false');
        const titleEl = document.createElement('span');
        titleEl.className = 'ubovm-modal-row-title';
        titleEl.textContent = item.label || '';
        row.append(titleEl);
        if (item.description) {
          const meta = document.createElement('span');
          meta.className = 'ubovm-modal-row-meta';
          meta.textContent = item.description;
          row.append(meta);
        }
        if (item.detail) {
          const detailEl = document.createElement('span');
          detailEl.className = 'ubovm-modal-row-detail';
          detailEl.textContent = item.detail;
          row.append(detailEl);
        }
        fragment.append(row);
      }
      list.replaceChildren(fragment);
      if (!visible.some(item => item.id === activeId)) activeId = visible[0]?.id || '';
      for (const row of list.querySelectorAll('.ubovm-modal-row')) {
        const selected = row.dataset.id === activeId;
        row.classList.toggle('is-active', selected);
        row.setAttribute('aria-selected', selected ? 'true' : 'false');
      }
    }

    function moveActive(delta) {
      const rows = [...list.querySelectorAll('.ubovm-modal-row')];
      if (!rows.length) return;
      const index = Math.max(0, rows.findIndex(row => row.dataset.id === activeId));
      const next = rows[(index + delta + rows.length) % rows.length];
      activeId = next.dataset.id;
      renderList();
      next.focus({ preventScroll: true });
      next.scrollIntoView({ block: 'nearest' });
    }

    function acceptPrompt() {
      if (busy) return;
      const value = input.value;
      const failure = validate?.(value);
      if (failure) { showError(failure); input.focus(); return; }
      finish(value.trim());
    }

    function acceptConfirm() {
      if (busy) return;
      finish(true);
    }

    function acceptSearch() {
      if (!activeId) return;
      finish({ id: activeId });
    }

    confirm.addEventListener('click', () => {
      if (kind === 'prompt') acceptPrompt();
      else if (kind === 'confirm') acceptConfirm();
    });
    cancel.addEventListener('click', () => finish(undefined));
    close.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      finish(undefined);
    });
    input.addEventListener('keydown', event => {
      if (event.isComposing) return;
      if (event.key === 'Enter') { event.preventDefault(); acceptPrompt(); }
      else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); finish(undefined); }
    });
    search.addEventListener('input', () => {
      filter = search.value;
      renderList();
    });
    search.addEventListener('keydown', event => {
      if (event.isComposing) return;
      if (event.key === 'ArrowDown') { event.preventDefault(); moveActive(1); }
      else if (event.key === 'ArrowUp') { event.preventDefault(); moveActive(-1); }
      else if (event.key === 'Enter') { event.preventDefault(); acceptSearch(); }
      else if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        if (search.value) { search.value = ''; filter = ''; renderList(); }
        else finish(undefined);
      }
    });
    list.addEventListener('click', event => {
      const row = event.target.closest('.ubovm-modal-row');
      if (!row?.dataset.id) return;
      activeId = row.dataset.id;
      acceptSearch();
    });
    list.addEventListener('keydown', event => {
      const row = event.target.closest('.ubovm-modal-row');
      if (!row) return;
      if (event.key === 'ArrowDown') { event.preventDefault(); moveActive(1); }
      else if (event.key === 'ArrowUp') { event.preventDefault(); moveActive(-1); }
      else if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); activeId = row.dataset.id; acceptSearch(); }
    });
    dialog.addEventListener('cancel', event => {
      event.preventDefault();
      finish(undefined);
    });
    dialog.addEventListener('click', event => {
      if (event.target === dialog) finish(undefined);
    });
    dialog.querySelector('.ubovm-modal-shell')?.addEventListener('click', event => event.stopPropagation());
    dialog.addEventListener('close', () => {
      open = false;
      if (settle) {
        const done = settle;
        settle = undefined;
        done(undefined);
      }
    });

    function run(options) {
      if (settle) finish(undefined);
      return new Promise(resolve => {
        settle = resolve;
        prepare(options);
      });
    }

    return {
      confirm(options = {}) {
        return run({ kind: 'confirm', confirmLabel: '确定', ...options });
      },
      prompt(options = {}) {
        return run({ kind: 'prompt', confirmLabel: '确定', ...options });
      },
      searchList(options = {}) {
        return run({ kind: 'search', ...options });
      },
      close: () => finish(undefined),
      isOpen: () => open && dialog.open,
      handleMessage(message) {
        if (message?.type === 'closeUbomModal') {
          finish(undefined);
          return true;
        }
        return false;
      }
    };
  }

  window.createModalDialog = createModalDialog;
})();
