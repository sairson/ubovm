(() => {
  'use strict';

  function createProjectSwitcher(vscode, { request, getProjects, getWorkspace, modal } = {}) {
    const $ = id => document.getElementById(id);
    const dialog = $('project-switcher');
    const search = $('project-switcher-search');
    const list = $('project-switcher-list');
    const empty = $('project-switcher-empty');
    const error = $('project-switcher-error');
    const createPanel = $('project-switcher-create');
    const createName = $('project-switcher-name');
    const createPath = $('project-switcher-path');
    const createError = $('project-switcher-create-error');
    let open = false;
    let filter = '';
    let activeId = '';
    let lastFocus;
    let projects = [];
    let creating = false;
    let busy = false;

    const setText = (node, value) => { if (node && node.textContent !== value) node.textContent = value; };
    const folderName = value => String(value || '').split(/[\\/]/).filter(Boolean).pop() || String(value || '');
    const sanitizeFolder = value => String(value || '').trim().replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').replace(/[. ]+$/, '') || 'project';
    const joinPath = (parent, name) => {
      if (!parent) return name;
      const sep = parent.includes('\\') && !parent.includes('/') ? '\\' : '/';
      return parent.replace(/[\\/]+$/, '') + sep + name;
    };
    const parentDir = value => {
      const text = String(value || '');
      if (!text || text === '选择项目目录（必选）' || text === '选择工作空间（必选）') return '';
      const parts = text.split(/[\\/]/);
      if (parts.length <= 1) return '';
      return parts.slice(0, -1).join(text.includes('\\') && !text.includes('/') ? '\\' : '/');
    };
    const matches = (project, query) => {
      const terms = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
      if (!terms.length) return true;
      const haystack = `${project.name} ${project.folder || ''} ${project.workspace || ''}`.toLocaleLowerCase();
      return terms.every(term => haystack.includes(term));
    };
    const showError = (node, message) => {
      if (!node) return;
      if (!message) { node.hidden = true; setText(node, ''); return; }
      setText(node, message); node.hidden = false;
    };
    const updateSuggestedPath = () => {
      const name = createName.value.trim();
      const base = parentDir(getWorkspace?.() || '') || parentDir(projects.find(item => item.current)?.workspace || '') || parentDir(projects[0]?.workspace || '');
      const suggested = name && base ? joinPath(base, sanitizeFolder(name)) : name ? sanitizeFolder(name) : base ? joinPath(base, 'project') : '';
      setText(createPath, suggested || '输入名称后显示建议目录');
      createPath.title = suggested || '';
      createPath.dataset.path = suggested || '';
    };

    function visibleProjects() {
      return projects.filter(project => matches(project, filter));
    }

    function setActive(id, { focusRow = false } = {}) {
      activeId = id || '';
      for (const row of list.querySelectorAll('.project-switcher-row')) {
        const selected = row.dataset.id === activeId;
        row.classList.toggle('is-active', selected);
        row.setAttribute('aria-selected', selected ? 'true' : 'false');
        if (selected && focusRow) row.focus({ preventScroll: true });
      }
    }

    function renderList() {
      const items = visibleProjects();
      empty.hidden = items.length > 0;
      setText(empty, filter.trim() ? '没有匹配的项目' : '还没有项目，先新建一个');
      const fragment = document.createDocumentFragment();
      for (const project of items) {
        const row = document.createElement('div');
        row.className = 'project-switcher-row' + (project.current ? ' is-current' : '') + (project.id === activeId ? ' is-active' : '');
        row.dataset.id = project.id;
        row.tabIndex = 0;
        row.setAttribute('role', 'option');
        row.setAttribute('aria-selected', project.id === activeId ? 'true' : 'false');
        row.title = `${project.name}\n${project.workspace || ''}`;

        const icon = document.createElement('span');
        icon.className = 'project-switcher-icon';
        icon.setAttribute('aria-hidden', 'true');
        icon.innerHTML = '<svg viewBox="0 0 24 24"><path d="M3 7h7l2 2h9v11H3V7Z"/></svg>';

        const body = document.createElement('span');
        body.className = 'project-switcher-body';
        const title = document.createElement('span');
        title.className = 'project-switcher-title';
        title.textContent = project.name;
        if (project.current) {
          const badge = document.createElement('span');
          badge.className = 'project-switcher-badge';
          badge.textContent = '当前';
          title.append(badge);
        }
        if (project.running) {
          const badge = document.createElement('span');
          badge.className = 'project-switcher-badge running';
          badge.textContent = `${project.running} 运行中`;
          title.append(badge);
        }
        const meta = document.createElement('span');
        meta.className = 'project-switcher-meta';
        const folder = project.folder || folderName(project.workspace);
        const sessions = Number(project.sessionCount) || 0;
        meta.textContent = `${folder}${sessions ? ` · ${sessions} 个会话` : ''}`;
        body.append(title, meta);

        const actions = document.createElement('span');
        actions.className = 'project-switcher-actions';
        const rename = document.createElement('button');
        rename.type = 'button';
        rename.className = 'project-switcher-action';
        rename.dataset.action = 'rename';
        rename.title = '重命名';
        rename.setAttribute('aria-label', `重命名 ${project.name}`);
        rename.innerHTML = '<svg viewBox="0 0 24 24"><path d="M4 20h4L18 10l-4-4L4 16v4Zm11-13 4 4"/></svg>';
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'project-switcher-action danger';
        remove.dataset.action = 'delete';
        remove.title = project.running ? '有会话运行中，无法删除' : '删除';
        remove.disabled = Boolean(project.running);
        remove.setAttribute('aria-label', `删除 ${project.name}`);
        remove.innerHTML = '<svg viewBox="0 0 24 24"><path d="M6 7h12m-9 0V5h6v2m-8 3v9h8V10"/></svg>';
        actions.append(rename, remove);

        row.append(icon, body, actions);
        fragment.append(row);
      }
      list.replaceChildren(fragment);
      if (!items.some(item => item.id === activeId)) {
        const preferred = items.find(item => item.current) || items[0];
        setActive(preferred?.id || '');
      }
    }

    function showCreate(seed = '') {
      createPanel.hidden = false;
      dialog.dataset.mode = 'create';
      createName.value = String(seed || filter || '').trim().slice(0, 60);
      showError(createError, '');
      updateSuggestedPath();
      createName.focus();
      createName.select();
    }

    function hideCreate() {
      createPanel.hidden = true;
      dialog.dataset.mode = 'list';
      creating = false;
      showError(createError, '');
      search.focus();
    }

    function openDialog({ query = '' } = {}) {
      projects = Array.isArray(getProjects?.()) ? getProjects().map(item => ({ ...item })) : [];
      filter = typeof query === 'string' ? query : '';
      search.value = filter;
      showError(error, '');
      hideCreate();
      const preferred = projects.find(item => item.current) || projects[0];
      activeId = preferred?.id || '';
      renderList();
      lastFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
      if (!dialog.open) dialog.showModal();
      open = true;
      document.body.classList.add('project-switcher-visible');
      search.focus();
      search.select();
    }

    function closeDialog() {
      open = false;
      busy = false;
      creating = false;
      showError(error, '');
      showError(createError, '');
      createPanel.hidden = true;
      dialog.dataset.mode = 'list';
      document.body.classList.remove('project-switcher-visible');
      if (dialog.open) {
        try { dialog.close(); } catch { /* Dialog may already be closing via light dismiss. */ }
      }
      const focus = lastFocus;
      lastFocus = undefined;
      try { focus?.focus?.({ preventScroll: true }); } catch { /* Ignore stale focus targets. */ }
    }

    function moveActive(delta) {
      const items = visibleProjects();
      if (!items.length) return;
      const index = Math.max(0, items.findIndex(item => item.id === activeId));
      const next = items[(index + delta + items.length) % items.length];
      setActive(next.id, { focusRow: document.activeElement?.classList?.contains('project-switcher-row') });
      list.querySelector(`.project-switcher-row[data-id="${CSS.escape(next.id)}"]`)?.scrollIntoView({ block: 'nearest' });
    }

    function openProject(id) {
      if (!id || busy) return;
      busy = true;
      showError(error, '');
      request?.('projectSwitcherOpen', { projectId: id }, () => { busy = false; closeDialog(); }, failure => {
        busy = false;
        showError(error, failure?.message || '打开项目失败，请重试。');
      });
    }

    async function renameProject(id) {
      if (!id || busy) return;
      const project = projects.find(item => item.id === id);
      if (!project) return;
      const name = await modal?.prompt?.({
        title: '重命名项目',
        label: '项目名称',
        value: project.name,
        maxLength: 60,
        confirmLabel: '保存',
        validate: value => !value.trim() || value.trim().length > 60 ? '请输入 1–60 个字符的项目名称。' : undefined
      });
      if (name === undefined) return;
      busy = true;
      showError(error, '');
      request?.('projectSwitcherRename', { projectId: id, name: name.trim() }, () => { busy = false; }, failure => {
        busy = false;
        showError(error, failure?.message || '重命名失败，请重试。');
      });
    }

    async function deleteProject(id) {
      if (!id || busy) return;
      const project = projects.find(item => item.id === id);
      if (!project) return;
      if (project.running) {
        showError(error, '项目中有会话正在运行，请先停止后再删除。');
        return;
      }
      const sessions = Number(project.sessionCount) || 0;
      const confirmed = await modal?.confirm?.({
        title: '删除项目',
        message: `删除项目“${project.name}”？`,
        detail: `将删除 ${sessions} 个会话及其草稿和本地执行记录，包含协助和探索两个模式。\n项目目录：${project.workspace || ''}\n目录中的文件不会被删除。此操作无法撤销。`,
        confirmLabel: '删除项目',
        danger: true
      });
      if (confirmed !== true) return;
      busy = true;
      showError(error, '');
      request?.('projectSwitcherDelete', { projectId: id, confirmed: true }, () => { busy = false; closeDialog(); }, failure => {
        busy = false;
        showError(error, failure?.message || '删除失败，请重试。');
      });
    }

    function createProject(folderMode) {
      const name = createName.value.trim();
      if (!name || name.length > 60) {
        showError(createError, '请输入 1–60 个字符的项目名称。');
        createName.focus();
        return;
      }
      if (creating || busy) return;
      creating = true;
      busy = true;
      showError(createError, '');
      request?.('projectSwitcherCreate', {
        name,
        folderMode: folderMode === 'browse' ? 'browse' : 'suggested',
        suggestedPath: createPath.dataset.path || ''
      }, () => {
        creating = false;
        busy = false;
        closeDialog();
      }, failure => {
        creating = false;
        busy = false;
        const message = failure?.message || '创建项目失败，请重试。';
        if (/已取消/.test(message)) { showError(createError, ''); return; }
        showError(createError, message);
      });
    }

    search.addEventListener('input', () => {
      filter = search.value;
      renderList();
    });
    search.addEventListener('keydown', event => {
      if (event.isComposing) return;
      if (event.key === 'ArrowDown') { event.preventDefault(); moveActive(1); }
      else if (event.key === 'ArrowUp') { event.preventDefault(); moveActive(-1); }
      else if (event.key === 'Enter') {
        event.preventDefault();
        if (activeId) openProject(activeId);
        else showCreate(filter);
      }
      else if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        if (search.value) {
          search.value = '';
          filter = '';
          renderList();
        } else closeDialog();
      }
    });

    $('project-switcher-new')?.addEventListener('click', () => showCreate(filter));
    $('project-switcher-close')?.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      closeDialog();
    });
    $('project-switcher-create-back')?.addEventListener('click', hideCreate);
    $('project-switcher-create-browse')?.addEventListener('click', () => createProject('browse'));
    $('project-switcher-create-submit')?.addEventListener('click', () => createProject('suggested'));
    createName?.addEventListener('input', updateSuggestedPath);
    createName?.addEventListener('keydown', event => {
      if (event.isComposing) return;
      if (event.key === 'Enter') { event.preventDefault(); createProject('suggested'); }
      else if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        hideCreate();
      }
    });

    list.addEventListener('click', event => {
      const action = event.target.closest('[data-action]');
      const row = event.target.closest('.project-switcher-row');
      if (action && row) {
        event.preventDefault();
        event.stopPropagation();
        if (action.dataset.action === 'rename') renameProject(row.dataset.id);
        else if (action.dataset.action === 'delete') deleteProject(row.dataset.id);
        return;
      }
      if (row?.dataset.id) openProject(row.dataset.id);
    });
    list.addEventListener('keydown', event => {
      const row = event.target.closest('.project-switcher-row');
      if (!row) return;
      if (event.key === 'ArrowDown') { event.preventDefault(); moveActive(1); }
      else if (event.key === 'ArrowUp') { event.preventDefault(); moveActive(-1); }
      else if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openProject(row.dataset.id); }
      else if (event.key === 'Home') { event.preventDefault(); search.focus(); }
    });

    dialog.addEventListener('cancel', event => {
      event.preventDefault();
      if (dialog.dataset.mode === 'create' || !createPanel.hidden) hideCreate();
      else closeDialog();
    });
    dialog.addEventListener('click', event => {
      if (event.target === dialog) closeDialog();
    });
    dialog.querySelector('.project-switcher-shell')?.addEventListener('click', event => {
      event.stopPropagation();
    });
    dialog.addEventListener('close', () => {
      open = false;
      busy = false;
      creating = false;
      document.body.classList.remove('project-switcher-visible');
    });

    function openCreate(seed = '') {
      openDialog({});
      showCreate(seed);
    }

    return {
      open: openDialog,
      openCreate,
      close: closeDialog,
      isOpen: () => open && dialog.open,
      update(nextProjects) {
        if (!Array.isArray(nextProjects)) return;
        projects = nextProjects.map(item => ({ ...item }));
        if (!open || !dialog.open) return;
        if (!createPanel.hidden) updateSuggestedPath();
        renderList();
      },
      handleMessage(message) {
        if (message?.type === 'openProjectSwitcher') {
          openDialog({ query: typeof message.query === 'string' ? message.query : '' });
          if (message.create === true) showCreate(typeof message.query === 'string' ? message.query : '');
          return true;
        }
        if (message?.type === 'openProjectSwitcherCreate') {
          openCreate(typeof message.query === 'string' ? message.query : '');
          return true;
        }
        if (message?.type === 'closeProjectSwitcher') {
          closeDialog();
          return true;
        }
        if (message?.type === 'openProjectRename') {
          const id = typeof message.projectId === 'string' ? message.projectId : '';
          if (!id) return true;
          projects = Array.isArray(getProjects?.()) ? getProjects().map(item => ({ ...item })) : projects;
          void renameProject(id);
          return true;
        }
        if (message?.type === 'openProjectDelete') {
          const id = typeof message.projectId === 'string' ? message.projectId : '';
          if (!id) return true;
          projects = Array.isArray(getProjects?.()) ? getProjects().map(item => ({ ...item })) : projects;
          void deleteProject(id);
          return true;
        }
        return false;
      }
    };
  }

  window.createProjectSwitcher = createProjectSwitcher;
})();
