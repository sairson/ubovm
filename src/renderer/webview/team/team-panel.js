(() => {
  'use strict';
  // Agent Teams popover: a read-only roster and shared task board projected from
  // `state.execution.team`. The panel renders outside the topbar (fixed popover)
  // but is driven by the trigger button in the header. Component patterns mirror
  // workers/worker-panel.js: plain DOM, no framework, text nodes only.
  const t = (value, ...args) => window.UBOVMi18n?.t(value, ...args) ?? value;
  const node = (tag, className, text) => {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = t(text);
    return element;
  };
  const setText = (element, value) => {
    const text = t(value);
    if (element.textContent !== text) element.textContent = text;
  };
  const setRaw = (element, value) => {
    const text = String(value ?? '');
    if (element.textContent !== text) element.textContent = text;
  };
  const setAttribute = (element, name, value) => {
    const text = String(name === 'title' || name === 'aria-label' ? t(value) : value);
    if (element.getAttribute(name) !== text) element.setAttribute(name, text);
  };
  const setHidden = (element, hidden) => { if (element.hidden !== hidden) element.hidden = hidden; };
  const setData = (element, name, value) => {
    const text = String(value);
    if (element.dataset[name] !== text) element.dataset[name] = text;
  };
  const clean = (value, limit) => typeof value === 'string' ? value.trim().slice(0, limit) : '';
  const cleanList = value => Array.isArray(value)
    ? value.filter(item => typeof item === 'string' && item.trim()).slice(0, 8).map(item => clean(item, 160))
    : [];

  const MEMBER_STATUS = Object.freeze({ running: '运行中', inactive: '未运行', provisioning: '准备中', failed: '失败' });
  const ACTIVITY_STATUS = Object.freeze({ running: '进行中', completed: '完成', failed: '失败', interrupted: '已停止' });
  const MEMBERS = '成员';
  const TASKS = '任务';

  function icon(paths, size = 14) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    for (const [key, value] of Object.entries({
      viewBox: '0 0 24 24', width: String(size), height: String(size), fill: 'none', stroke: 'currentColor',
      'stroke-width': '1.6', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true'
    })) svg.setAttribute(key, value);
    for (const path of paths) {
      const shape = document.createElementNS('http://www.w3.org/2000/svg', path.circle ? 'circle' : 'path');
      for (const [key, value] of Object.entries(path)) shape.setAttribute(key, String(value));
      svg.append(shape);
    }
    return svg;
  }
  const personIcon = () => icon([
    { cx: 9, cy: 7, r: 4 },
    { d: 'M3 21v-2a6 6 0 0 1 12 0v2M16 3.5a4 4 0 0 1 0 7M21 21v-2a5 5 0 0 0-3-4.6' }
  ]);
  const chevronIcon = () => icon([{ d: 'm6 9 6 6 6-6' }], 12);

  function normalizeRoster(value) {
    const rows = [];
    for (const item of (Array.isArray(value) ? value : []).slice(0, 32)) {
      if (!item || typeof item !== 'object') continue;
      const name = clean(item.name, 64);
      if (!name) continue;
      const activity = item.activity && typeof item.activity === 'object'
        ? { label: clean(item.activity.label, 120), status: clean(item.activity.status, 40) }
        : undefined;
      const error = typeof item.error === 'string' ? clean(item.error, 400)
        : item.error && typeof item.error === 'object' ? clean(item.error.message, 400) : '';
      rows.push({
        name,
        role: item.role === 'lead' ? 'lead' : 'teammate',
        status: ['running', 'inactive', 'provisioning', 'failed'].includes(item.status) ? item.status : 'inactive',
        description: clean(item.description, 400),
        context: item.context === 'fork' || item.context === 'fresh' ? item.context : '',
        error,
        activity: activity && activity.label ? activity : undefined
      });
    }
    return rows;
  }
  function normalizeTasks(value) {
    const rows = [];
    const seen = new Set();
    for (const item of (Array.isArray(value) ? value : []).slice(0, 300)) {
      if (!item || typeof item !== 'object') continue;
      const id = clean(item.id, 48);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      rows.push({
        id,
        revision: Number.isSafeInteger(item.revision) ? item.revision : 0,
        subject: clean(item.subject, 200) || id,
        description: clean(item.description, 4000),
        status: ['pending', 'in_progress', 'completed'].includes(item.status) ? item.status : 'pending',
        ownerName: clean(item.ownerName, 64),
        blockedBy: cleanList(item.blockedBy),
        writeScopes: cleanList(item.writeScopes),
        ready: item.ready === true,
        warnings: cleanList(item.writeScopeWarnings)
      });
    }
    return rows;
  }
  function taskState(task) {
    if (task.status === 'pending') return task.ready ? 'idle' : 'warning';
    return task.status === 'in_progress' ? 'ongoing' : 'done';
  }
  // Streamed execution ticks reach the panel often. Descriptions can be long, so
  // compare roster activity plus task CAS revisions instead of serializing the
  // whole board on every tick.
  function signature(roster, tasks) {
    const members = roster.map(member => [member.name, member.role, member.status, member.context,
      member.description, member.error, member.activity ? member.activity.label : '',
      member.activity ? member.activity.status : ''].join('\u0001'));
    const board = tasks.map(entry => [entry.id, entry.revision, entry.status, entry.ready ? 1 : 0,
      entry.ownerName, entry.subject, entry.blockedBy.join(','), entry.writeScopes.join(','),
      entry.warnings.join(',')].join('\u0001'));
    return members.join('\u0002') + '\u0003' + board.join('\u0002');
  }
  function taskStatusText(task) {
    if (task.status === 'pending') return task.ready ? '可开始' : '被依赖阻塞';
    return task.status === 'in_progress' ? '进行中' : '已完成';
  }
  function memberState(member) {
    if (member.status === 'running' || member.status === 'provisioning') return 'ongoing';
    return member.status === 'failed' ? 'error' : 'inactive';
  }
  function activityText(activity) {
    const label = window.UBOVMTimeline?.displayActivityLabel?.(activity.label) || activity.label;
    const status = ACTIVITY_STATUS[activity.status] || activity.status || '';
    return status ? t(label) + ' · ' + t(status) : t(label);
  }
  function labeled(element, label, value, hidden) {
    const next = t(label) + value;
    if (element.textContent !== next) element.textContent = next;
    setHidden(element, hidden);
  }

  window.createTeamPanel = function createTeamPanel({
    trigger = document.getElementById('team-toggle'),
    panel = document.getElementById('team-panel'),
    onSelectMember
  } = {}) {
    if (!trigger || !panel) {
      return { element: panel, update() {}, open() {}, close() {}, toggle() {}, get isOpen() { return false; } };
    }
    panel.hidden = true;
    panel.tabIndex = -1;
    setAttribute(trigger, 'aria-controls', panel.id || 'team-panel');
    setAttribute(trigger, 'aria-expanded', 'false');
    setAttribute(trigger, 'title', '团队成员与任务板');
    setAttribute(trigger, 'aria-label', '团队成员与任务板');
    const countEl = document.getElementById('team-count');

    const body = node('div', 'team-panel-body');
    body.tabIndex = 0;
    setAttribute(body, 'aria-label', '团队详情');
    const errorNotice = node('p', 'team-panel-error', '');
    errorNotice.setAttribute('role', 'alert');
    errorNotice.hidden = true;

    const rosterSection = node('section', 'team-section team-roster-section');
    const rosterHeading = node('h3', 'team-section-heading');
    const rosterTitle = node('span', 'team-section-title', MEMBERS);
    const rosterCount = node('span', 'team-section-count');
    rosterHeading.append(rosterTitle, rosterCount);
    const rosterList = node('div', 'team-roster');
    rosterList.setAttribute('role', 'group');
    rosterSection.append(rosterHeading, rosterList);

    const tasksSection = node('section', 'team-section team-tasks-section');
    const tasksHeading = node('h3', 'team-section-heading');
    const tasksTitle = node('span', 'team-section-title', TASKS);
    const tasksCount = node('span', 'team-section-count');
    tasksHeading.append(tasksTitle, tasksCount);
    const emptyNotice = node('p', 'team-empty', '任务板为空。主 Agent 创建任务后会显示在这里。');
    const taskList = node('div', 'team-tasks');
    taskList.setAttribute('role', 'list');
    tasksSection.append(tasksHeading, emptyNotice, taskList);

    body.append(errorNotice, rosterSection, tasksSection);
    panel.replaceChildren(body);
    panel.setAttribute('role', 'dialog');
    setAttribute(panel, 'aria-label', '团队');

    const rosterItems = new Map(), taskItems = new Map();
    let open = false, measureFrame = 0, lastKey = null, lastLocale = null, lastVisible = null;

    function createMember() {
      const element = node('article', 'team-member');
      element.setAttribute('role', 'listitem');
      const dot = node('span', 'team-member-dot');
      dot.setAttribute('aria-hidden', 'true');
      const textBox = node('div', 'team-member-text');
      const nameRow = node('span', 'team-member-name');
      const nameText = node('span', 'team-member-name-text');
      const roleTag = node('span', 'team-current-tag');
      roleTag.hidden = true;
      nameRow.append(nameText, roleTag);
      const status = node('small', 'team-member-status');
      const description = node('p', 'team-member-description');
      const activity = node('p', 'team-member-activity');
      const error = node('p', 'team-member-error');
      textBox.append(nameRow, status, description, activity, error);
      element.append(dot, textBox);
      const item = { element, dot, nameText, roleTag, status, description, activity, error, member: undefined };
      element.addEventListener('click', () => {
        if (!item.member) return;
        selectMember(item.member);
      });
      element.addEventListener('keydown', event => {
        if (!item.member || item.member.role === 'lead') return;
        if (event.key !== 'Enter' && event.key !== ' ' && event.key !== 'Spacebar') return;
        event.preventDefault();
        selectMember(item.member);
      });
      return item;
    }
    // Selecting a teammate closes the popover first so focus can move into the
    // conversation view; the Lead row is the current conversation, so it only
    // returns there (a no-op when the member view is already closed).
    function selectMember(member) {
      if (!member || !member.name) return;
      closePanel();
      try { onSelectMember?.(member.role === 'lead' ? null : member.name); } catch { /* Selection is host-owned. */ }
    }
    function updateMember(item, member) {
      item.member = member;
      const selectable = member.role !== 'lead';
      const role = selectable ? 'button' : '';
      if (role) {
        if (item.element.getAttribute('role') !== role) item.element.setAttribute('role', role);
      } else if (item.element.hasAttribute('role')) item.element.removeAttribute('role');
      if (selectable) {
        item.element.classList.add('team-member-selectable');
        setAttribute(item.element, 'tabindex', '0');
        setAttribute(item.element, 'aria-haspopup', 'dialog');
        setAttribute(item.element, 'aria-controls', 'team-member-view');
        // Translate the template (not the composed label) so English shows the
        // member name inside localized copy without touching i18n catalogs.
        item.element.setAttribute('aria-label', t('查看 {0} 的会话', member.name));
      } else {
        item.element.classList.remove('team-member-selectable');
        item.element.removeAttribute('tabindex');
        item.element.removeAttribute('aria-haspopup');
        item.element.removeAttribute('aria-controls');
        item.element.removeAttribute('aria-label');
      }
      setData(item.element, 'status', member.status);
      setData(item.element, 'current', member.role === 'lead');
      if (member.context) setData(item.element, 'context', member.context);
      const state = memberState(member);
      if (item.dot.dataset.state !== state) {
        item.dot.dataset.state = state;
        item.dot.replaceChildren(...(state === 'inactive' ? [personIcon()] : []));
      }
      setRaw(item.nameText, member.name);
      if (item.nameText.title !== member.name) item.nameText.title = member.name;
      const lead = member.role === 'lead';
      setHidden(item.roleTag, !lead);
      if (lead) setText(item.roleTag, '主 Agent');
      setText(item.status, MEMBER_STATUS[member.status] || member.status);
      setHidden(item.description, !member.description);
      if (member.description) {
        setRaw(item.description, member.description);
        if (item.description.title !== member.description) item.description.title = member.description;
      } else if (item.description.title) item.description.removeAttribute('title');
      const activity = member.activity ? activityText(member.activity) : '';
      setHidden(item.activity, !activity);
      if (activity) setRaw(item.activity, activity);
      setHidden(item.error, !member.error);
      if (member.error) setRaw(item.error, member.error);
    }
    function createTask() {
      const element = node('article', 'team-task');
      element.setAttribute('role', 'listitem');
      const title = node('div', 'team-task-title');
      const subject = node('strong', 'team-task-subject');
      const state = node('span', 'team-task-state');
      const dot = node('span', 'team-task-dot');
      dot.setAttribute('aria-hidden', 'true');
      const status = node('span', 'team-task-status');
      state.append(dot, status);
      title.append(subject, state);
      const description = node('p', 'team-task-description team-clamped');
      const meta = node('div', 'team-task-meta');
      const id = node('span', 'team-task-id');
      const owner = node('span', 'team-task-owner');
      const blocked = node('span', 'team-task-blocked');
      const scopes = node('span', 'team-task-scopes');
      const warnings = node('span', 'team-task-warnings');
      const expand = node('button', 'team-task-expand');
      expand.type = 'button';
      expand.hidden = true;
      expand.setAttribute('aria-expanded', 'false');
      const expandLabel = node('span', 'team-task-expand-label', '展开');
      expand.append(expandLabel, chevronIcon());
      meta.append(id, owner, blocked, scopes, warnings, expand);
      element.append(title, description, meta);
      const item = { element, subject, state, dot, status, description, meta, id, owner, blocked, scopes, warnings, expand, expandLabel, expanded: false, warningKey: '', descriptionTitle: '' };
      expand.addEventListener('click', () => {
        item.expanded = !item.expanded;
        description.classList.toggle('team-clamped', !item.expanded);
        expand.setAttribute('aria-expanded', String(item.expanded));
        setText(expandLabel, item.expanded ? '收起' : '展开');
        scheduleMeasure();
      });
      return item;
    }
    function updateTask(item, task) {
      const state = taskState(task);
      setData(item.element, 'status', task.status);
      setData(item.element, 'ready', task.ready);
      setData(item.state, 'state', state);
      setData(item.dot, 'state', state);
      setText(item.status, taskStatusText(task));
      setRaw(item.subject, task.subject);
      if (item.subject.title !== task.subject) item.subject.title = task.subject;
      if (item.descriptionTitle !== task.description) {
        item.descriptionTitle = task.description;
        setRaw(item.description, task.description);
        if (task.description) item.description.title = task.description;
        else item.description.removeAttribute('title');
      }
      setRaw(item.id, task.id);
      labeled(item.owner, '负责人：', task.ownerName || t('未认领'), false);
      labeled(item.blocked, '依赖：', task.blockedBy.join(', '), task.blockedBy.length === 0);
      labeled(item.scopes, '写入范围：', task.writeScopes.join(', '), task.writeScopes.length === 0);
      const warningKey = JSON.stringify(task.warnings);
      if (item.warningKey !== warningKey) {
        item.warningKey = warningKey;
        item.warnings.replaceChildren(...task.warnings.map(warning => {
          const span = node('span', 'team-task-warning');
          setRaw(span, warning);
          return span;
        }));
        item.warnings.hidden = task.warnings.length === 0;
      }
      setHidden(item.element, false);
    }
    function reconcile(container, store, entries, keyOf, create, updateOne) {
      const seen = new Set();
      const ordered = [];
      for (const entry of entries) {
        const key = keyOf(entry);
        if (seen.has(key)) continue;
        seen.add(key);
        let item = store.get(key);
        if (!item) {
          item = create();
          store.set(key, item);
        }
        updateOne(item, entry);
        ordered.push(item.element);
      }
      let anchor = null;
      for (const element of ordered) {
        const next = anchor ? anchor.nextSibling : container.firstChild;
        if (element !== next) container.insertBefore(element, next);
        anchor = element;
      }
      for (const [key, item] of store) {
        if (seen.has(key)) continue;
        item.element.remove();
        store.delete(key);
      }
    }
    function render(roster, tasks) {
      setRaw(rosterCount, String(roster.length));
      setRaw(tasksCount, String(tasks.length));
      reconcile(rosterList, rosterItems, roster, member => member.name, createMember, updateMember);
      reconcile(taskList, taskItems, tasks, task => task.id, createTask, updateTask);
      setHidden(emptyNotice, tasks.length > 0);
      setHidden(taskList, tasks.length === 0);
      panel.classList.toggle('team-panel-compact', roster.length <= 1 && tasks.length === 0);
      setHidden(errorNotice, true);
    }
    function measure() {
      measureFrame = 0;
      if (!open) return;
      for (const item of taskItems.values()) {
        if (item.expanded) { setHidden(item.expand, false); continue; }
        const overflow = item.description.scrollHeight > item.description.clientHeight + 1;
        setHidden(item.expand, !overflow);
      }
    }
    function scheduleMeasure() {
      if (!open || measureFrame) return;
      measureFrame = requestAnimationFrame(measure);
    }
    function place() {
      if (!open) return;
      const rect = trigger.getBoundingClientRect();
      const margin = 12;
      const available = Math.max(120, window.innerWidth - margin * 2);
      const width = Math.min(panel.getBoundingClientRect().width || available, available);
      const top = Math.max(margin, Math.min(rect.bottom + 6, window.innerHeight - 96));
      const left = Math.min(Math.max(margin, rect.right - width), Math.max(margin, window.innerWidth - width - margin));
      panel.style.top = Math.round(top) + 'px';
      panel.style.left = Math.round(left) + 'px';
      panel.style.right = 'auto';
    }
    function openPanel({ focus = true } = {}) {
      if (open || trigger.hidden) return;
      open = true;
      panel.hidden = false;
      panel.setAttribute('aria-live', 'polite');
      setAttribute(trigger, 'aria-expanded', 'true');
      place();
      scheduleMeasure();
      if (focus) {
        try { panel.focus({ preventScroll: true }); } catch { panel.focus(); }
      }
    }
    function closePanel({ restoreFocus = false } = {}) {
      if (!open) return;
      open = false;
      panel.hidden = true;
      panel.removeAttribute('aria-live');
      setAttribute(trigger, 'aria-expanded', 'false');
      if (measureFrame) { cancelAnimationFrame(measureFrame); measureFrame = 0; }
      if (restoreFocus && !trigger.hidden) trigger.focus();
    }
    function update(team) {
      const roster = normalizeRoster(team?.roster);
      const tasks = normalizeTasks(team?.tasks);
      const teammates = Math.max(0, roster.length - 1);
      const visible = roster.length > 1 || tasks.length > 0;
      const key = signature(roster, tasks);
      const locale = window.UBOVMi18n?.locale || 'zh-CN';
      if (!visible) closePanel();
      setHidden(trigger, !visible);
      if (countEl) {
        setHidden(countEl, !visible || teammates === 0);
        if (teammates > 0) setRaw(countEl, String(teammates));
      }
      if (key === lastKey && locale === lastLocale && visible === lastVisible) return;
      lastKey = key; lastLocale = locale; lastVisible = visible;
      render(roster, tasks);
      if (open) scheduleMeasure();
    }

    trigger.addEventListener('click', () => { if (open) closePanel(); else openPanel(); });
    document.addEventListener('keydown', event => {
      if (event.key !== 'Escape' || !open || event.defaultPrevented) return;
      event.preventDefault();
      closePanel({ restoreFocus: true });
    });
    document.addEventListener('pointerdown', event => {
      if (!open) return;
      const target = event.target;
      if (panel.contains(target) || trigger.contains(target)) return;
      closePanel();
    }, true);
    window.addEventListener('resize', () => { if (!open) return; place(); scheduleMeasure(); });

    return {
      element: panel,
      update,
      open: openPanel,
      close: closePanel,
      toggle: () => { if (open) closePanel(); else openPanel(); },
      refresh: () => { if (open) { place(); scheduleMeasure(); } },
      get isOpen() { return open; }
    };
  };
})();
