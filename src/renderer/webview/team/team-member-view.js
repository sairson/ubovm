(() => {
  'use strict';
  // DSH-style teammate conversation view. The Team panel selects a teammate and
  // this component projects `execution.teamWatch` (history transcript + live
  // assistant run) into a read-only reading surface. It reuses the main message
  // renderer for assistant turns, so thinking/tool/code cards behave exactly as
  // they do in the Lead conversation. Plain DOM only, no framework, no HTML.
  const byId = id => document.getElementById(id);
  // i18n `t(value, ...args)` needs the format arguments forwarded: both the
  // loading and omitted-history strings interpolate a value.
  const t = (value, ...args) => window.UBOVMi18n?.t(value, ...args) ?? value;
  const node = (tag, className, text) => {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = t(text);
    return element;
  };
  const setText = (element, value) => {
    if (!element) return;
    const text = t(value);
    if (element.textContent !== text) element.textContent = text;
  };
  const setRaw = (element, value) => {
    if (!element) return;
    const text = String(value ?? '');
    if (element.textContent !== text) element.textContent = text;
  };
  const setAttribute = (element, name, value) => {
    if (!element) return;
    const text = String(value);
    if (element.getAttribute(name) !== text) element.setAttribute(name, text);
  };
  const setHidden = (element, hidden) => { if (element && element.hidden !== hidden) element.hidden = hidden; };
  const setData = (element, name, value) => {
    if (!element) return;
    const text = String(value);
    if (element.dataset[name] !== text) element.dataset[name] = text;
  };
  const clean = (value, limit) => typeof value === 'string' ? value.trim().slice(0, limit) : '';
  // Monogram: ASCII names use their first letters ("reviewer" -> "RE",
  // "test-runner" -> "TR"); CJK and other scripts use their first two glyphs.
  function initialsFor(value) {
    const name = clean(value, 64);
    if (!name) return '?';
    if (/^[\x20-\x7e]+$/.test(name)) {
      const tokens = name.split(/[\s._-]+/).filter(Boolean);
      const raw = tokens.length > 1 ? tokens[0][0] + tokens[1][0] : name.slice(0, 2);
      return raw.toUpperCase();
    }
    return Array.from(name).slice(0, 2).join('');
  }

  const MEMBER_STATUS = Object.freeze({ running: '运行中', inactive: '未运行', provisioning: '准备中', failed: '失败' });
  const ACTIVITY_STATUS = Object.freeze({ running: '进行中', completed: '完成', failed: '失败', interrupted: '已停止' });
  const ROLES = Object.freeze({ lead: '主 Agent', teammate: '团队成员' });
  const WAITING = '等待该成员开始执行…';
  const NO_HISTORY = '该成员还没有会话记录。';
  const DEFAULT_ERROR = '读取该成员的会话失败，请重试。';
  const TIMEOUT_ERROR = '读取该成员的会话超时，请重试。';
  const LOADING_TIMEOUT_MS = 12000;
  // Progressive transcript: long histories paint the newest six entries on the
  // first frame and stream the older ones in above them. The batch budget keeps
  // every frame interactive; at least one entry is always painted per frame.
  const PROGRESSIVE_THRESHOLD = 12;
  const PROGRESSIVE_TAIL = 6;
  const FILL_BUDGET_MS = 6;
  // Offscreen containment only pays off once the surface is actually long.
  const DENSE_THRESHOLD = 30;
  const ENTER_DURATION_MS = 140;

  function normalizeActivity(value) {
    if (!value || typeof value !== 'object') return null;
    const label = clean(value.label, 120);
    if (!label) return null;
    return { label, status: clean(value.status, 40) };
  }
  function activityText(activity) {
    const label = window.UBOVMTimeline?.displayActivityLabel?.(activity.label) || activity.label;
    const status = ACTIVITY_STATUS[activity.status] || activity.status;
    return status ? t(label) + ' · ' + t(status) : t(label);
  }
  function memberErrorText(value) {
    if (typeof value === 'string') return clean(value, 500);
    if (value && typeof value === 'object') return clean(value.message, 500);
    return '';
  }
  // History payloads are bounded by the host projection. Normalize defensively
  // so a partially built snapshot can never break the reading surface.
  function normalizeEntries(value) {
    const entries = [];
    for (const item of Array.isArray(value) ? value.slice(0, 400) : []) {
      if (!item || typeof item !== 'object') continue;
      const role = item.role === 'user' ? 'user' : item.role === 'assistant' ? 'assistant' : '';
      if (!role) continue;
      const entry = {
        id: clean(item.id, 96),
        role,
        text: typeof item.text === 'string' ? item.text : '',
        streaming: item.streaming === true,
        parts: role === 'assistant' && Array.isArray(item.parts) ? item.parts.filter(part => part && typeof part === 'object' && typeof part.id === 'string') : []
      };
      if (role === 'user' && !entry.text.trim()) continue;
      entries.push(entry);
    }
    return entries;
  }
  // Stable per-entry DOM keys, identical to the ones renderEntries assigns:
  // entry id when present, positional fallback otherwise, ':' suffix on repeats.
  function entryKeys(entries) {
    const seen = new Set(), keys = [];
    let index = 0;
    for (const entry of entries) {
      let key = entry.id || 'entry-' + index;
      index++;
      while (seen.has(key)) key += ':';
      seen.add(key);
      keys.push(key);
    }
    return keys;
  }
  // Cheap steady-state facts: an id/count/omitted signature lets a live tick skip
  // normalizeEntries/renderEntries entirely when the transcript did not change.
  // Streaming history entries also participate so a partially published turn can
  // never stay stale behind the cache.
  function historyFacts(value, omitted) {
    const source = Array.isArray(value) ? value.slice(0, 400) : [];
    const keys = [];
    let signature = omitted + '\u0001' + source.length + '\u0001';
    for (let index = 0; index < source.length; index++) {
      const item = source[index];
      const object = item && typeof item === 'object' ? item : null;
      const id = object && typeof object.id === 'string' ? object.id : '';
      const key = id || '#' + index;
      keys.push(key);
      signature += key + '\u0002'
        + (object && object.role === 'user' ? 'u' : object && object.role === 'assistant' ? 'a' : '-')
        + (object && item.streaming === true ? '+' : '')
        + '\u0003';
    }
    return { keys, signature };
  }
  // A history update that only appends entries after the previous ones is a
  // growth (the settled live turn); anything else replaced the transcript.
  function isHistoryGrowth(previous, next) {
    if (!previous.length) return true;
    if (next.length < previous.length) return false;
    for (let index = 0; index < previous.length; index++) {
      if (previous[index] !== next[index]) return false;
    }
    return true;
  }
  function visibleParts(value) {
    const parts = Array.isArray(value) ? value : [];
    try {
      return window.UBOVMTimeline?.visibleTimelineParts?.(parts) || parts;
    } catch { return parts; }
  }
  // Compare only cheap shape facts: full tool outputs can be large and are
  // rendered incrementally by UBOVMMessage.update anyway.
  function partsSignature(parts) {
    if (!Array.isArray(parts) || !parts.length) return '';
    let signature = '';
    for (const part of parts) {
      if (!part || typeof part !== 'object') continue;
      signature += [part.id, part.type, part.name, part.status,
        typeof part.text === 'string' ? part.text.length : '',
        typeof part.output === 'string' ? part.output.length : '',
        Number.isFinite(part.startedAt) ? part.startedAt : '',
        Number.isFinite(part.endedAt) ? part.endedAt : ''].join('\u0001') + '\u0002';
    }
    return signature;
  }

  window.createTeamMemberView = function createTeamMemberView({
    actions = {}, onClose, onRetry, isBlocked
  } = {}) {
    const element = byId('team-member-view');
    const back = byId('team-member-back');
    const nameEl = byId('team-member-view-name');
    const avatarEl = byId('team-member-view-avatar');
    const initialsEl = byId('team-member-view-initials');
    const roleEl = byId('team-member-view-role');
    const chip = byId('team-member-view-status');
    const statusText = byId('team-member-view-status-text');
    const liveDot = byId('team-member-view-live');
    const activityEl = byId('team-member-view-activity');
    const descriptionEl = byId('team-member-view-description');
    const memberErrorEl = byId('team-member-view-member-error');
    const scroll = byId('team-member-view-scroll');
    const history = byId('team-member-view-history');
    const fillEl = byId('team-member-view-fill');
    const loading = byId('team-member-view-loading');
    const errorBox = byId('team-member-view-error');
    const errorText = byId('team-member-view-error-text');
    const retry = byId('team-member-view-retry');
    const emptyEl = byId('team-member-view-empty');
    const omittedEl = byId('team-member-view-omitted');
    const assistMode = byId('assist-mode');
    if (!element || !back || !history) {
      return { element, open() {}, close() {}, update() {}, fail() {}, get isOpen() { return false; }, get name() { return ''; } };
    }

    const entryViews = new Map();
    let open = false;
    let currentName = '';
    let viewSessionId = '';
    let received = false;
    let returnFocus;
    let loadingTimer = 0;
    let liveView = null;
    let follow = true;
    let lastTop = 0;
    let followFrame = 0;
    let lastLocale = window.UBOVMi18n?.locale || 'zh-CN';
    // Progressive fill state (older entries waiting to be prepended, newest last
    // so pop() yields the entry closest to the painted tail first).
    let fillFrame = 0;
    let fillItems = [];
    let fillActive = false;
    // History signature cache: unchanged transcripts skip the whole render pass.
    let historySignature = '';
    let historyKeys = [];
    let historyCount = 0;
    // Loading -> content soft swap: the loading surface stays until the newest
    // entries are painted, then the transcript fades in once.
    let revealFrame = 0;
    let revealEpoch = 0;
    let enterTimer = 0;
    let contentRevealed = false;

    function clearLoadingTimer() {
      if (loadingTimer) { clearTimeout(loadingTimer); loadingTimer = 0; }
    }
    function pin() {
      if (!open || !follow || followFrame) return;
      followFrame = requestAnimationFrame(() => {
        followFrame = 0;
        if (!open || !follow || !scroll) return;
        scroll.scrollTop = scroll.scrollHeight;
        lastTop = scroll.scrollTop;
      });
    }
    // Long transcripts opt into offscreen containment; short ones keep the plain
    // document flow so reading widths and find-in-page stay untouched.
    function updateDensity() {
      if (!history) return;
      const dense = entryViews.size + (liveView ? 1 : 0) > DENSE_THRESHOLD;
      if (history.classList.contains('is-long') !== dense) history.classList.toggle('is-long', dense);
    }
    function cancelFill() {
      if (fillFrame) { cancelAnimationFrame(fillFrame); fillFrame = 0; }
      fillActive = false;
      fillItems = [];
      setHidden(fillEl, true);
    }
    function cancelReveal() {
      if (revealFrame) { cancelAnimationFrame(revealFrame); revealFrame = 0; }
      if (enterTimer) { clearTimeout(enterTimer); enterTimer = 0; }
      if (history) history.classList.remove('is-entering');
    }
    function releaseEntry(view) {
      if (!view) return;
      try { window.UBOVMMessage?.release?.(view.body || view.text); } catch { /* Keep teardown independent. */ }
      view.article.remove();
    }
    function resetContent() {
      cancelFill();
      cancelReveal();
      revealEpoch += 1;
      contentRevealed = false;
      historySignature = '';
      historyKeys = [];
      historyCount = 0;
      for (const view of entryViews.values()) releaseEntry(view);
      entryViews.clear();
      if (liveView) {
        releaseEntry(liveView);
        liveView = null;
      }
      if (history) {
        history.replaceChildren();
        history.classList.remove('is-long', 'is-entering');
      }
      setHidden(loading, true);
      setHidden(errorBox, true);
      setHidden(emptyEl, true);
      setHidden(omittedEl, true);
      setHidden(fillEl, true);
    }
    // Pick the first article that still intersects the viewport so prepending
    // older entries can compensate scrollTop by exactly its visual delta. This
    // works for every batch size and stays accurate with intrinsic-size boxes.
    function captureAnchor() {
      if (!history) return null;
      let found = history.firstElementChild;
      for (const child of history.children) {
        if (child.getBoundingClientRect().bottom > 0) { found = child; break; }
      }
      return found ? { element: found, top: found.getBoundingClientRect().top } : null;
    }
    function createEntry(entry, key) {
      const article = node('article', 'team-member-message team-member-message-' + entry.role);
      article.setAttribute('data-entry-role', entry.role);
      setAttribute(article, 'data-entry-id', key);
      if (entry.role === 'user') {
        const text = node('div', 'team-member-message-text message-text');
        article.append(text);
        return { article, text, role: 'user', signature: '' };
      }
      const body = node('div', 'team-member-message-body message-text');
      article.append(body);
      return { article, body, role: 'assistant', signature: '' };
    }
    function updateEntry(view, entry) {
      if (entry.role === 'user') {
        if (view.signature !== entry.text) {
          view.signature = entry.text;
          setRaw(view.text, entry.text);
        }
        return;
      }
      const signature = entry.text + '\u0001' + partsSignature(entry.parts) + '\u0001' + (entry.streaming === true ? '1' : '0');
      if (view.signature === signature) return;
      view.signature = signature;
      try {
        window.UBOVMMessage.update(view.body, entry.text, {
          ...actions, role: 'assistant', parts: entry.parts, streaming: entry.streaming === true
        });
      } catch { /* A failed turn keeps its previous content instead of blanking. */ }
    }
    function renderEntries(entries, keys = entryKeys(entries)) {
      const seen = new Set(), ordered = [];
      for (let index = 0; index < entries.length; index++) {
        const entry = entries[index];
        const key = keys[index];
        seen.add(key);
        let view = entryViews.get(key);
        if (!view) {
          view = createEntry(entry, key);
          entryViews.set(key, view);
        }
        updateEntry(view, entry);
        ordered.push(view);
      }
      for (const [key, view] of entryViews) {
        if (seen.has(key)) continue;
        releaseEntry(view);
        entryViews.delete(key);
      }
      // Keep the live entry last: insert retained history before it (or append).
      let anchor = liveView && liveView.article.parentElement === history ? liveView.article : null;
      for (let at = ordered.length - 1; at >= 0; at--) {
        const article = ordered[at].article;
        if (article.parentElement !== history || article.nextSibling !== anchor) history.insertBefore(article, anchor);
        anchor = article;
      }
      updateDensity();
    }
    function renderLive(watch) {
      const live = watch.live && typeof watch.live === 'object' ? watch.live : {};
      const parts = visibleParts(live.parts);
      const streamText = typeof live.streamText === 'string' ? live.streamText : '';
      const running = watch.running === true;
      // A live entry exists only once there is something to read. While a run is
      // starting but silent, the empty state explains the wait instead.
      const active = parts.length > 0 || streamText !== '';
      if (!active) {
        if (liveView) { releaseEntry(liveView); liveView = null; updateDensity(); }
        return null;
      }
      if (!liveView) {
        liveView = createEntry({ role: 'assistant' }, 'live');
        liveView.article.classList.add('team-member-message-live');
        history.append(liveView.article);
        updateDensity();
      } else if (liveView.article.parentElement !== history || liveView.article.nextSibling) {
        history.append(liveView.article);
      }
      const signature = streamText + '\u0001' + partsSignature(parts) + '\u0001' + (running ? '1' : '0');
      if (liveView.signature !== signature) {
        liveView.signature = signature;
        try {
          window.UBOVMMessage.update(liveView.body, streamText, { ...actions, role: 'assistant', parts, streaming: running });
        } catch { /* Keep the previous streamed content. */ }
      }
      if (running) setAttribute(liveView.article, 'data-streaming', 'true');
      else liveView.article.removeAttribute('data-streaming');
      return liveView;
    }
    function setState(state) {
      setHidden(loading, state !== 'loading');
      setHidden(errorBox, state !== 'error');
      setHidden(emptyEl, state !== 'empty');
    }
    function scheduleReveal() {
      cancelReveal();
      const epoch = revealEpoch;
      revealFrame = requestAnimationFrame(() => {
        revealFrame = 0;
        if (!open || epoch !== revealEpoch) return;
        setState('content');
        if (history) {
          history.classList.add('is-entering');
          enterTimer = setTimeout(() => {
            enterTimer = 0;
            if (history) history.classList.remove('is-entering');
          }, ENTER_DURATION_MS);
        }
        if (follow) pin();
      });
    }
    function renderState(watch, entryCount, liveActive) {
      const historyData = watch.history && typeof watch.history === 'object' ? watch.history : {};
      const historyError = memberErrorText(historyData.error);
      const omitted = Number.isSafeInteger(historyData.omitted) && historyData.omitted > 0 ? historyData.omitted : 0;
      setHidden(omittedEl, omitted === 0);
      if (omitted) setRaw(omittedEl, t('已省略 {0} 条更早的会话记录。', omitted));
      if (historyError) {
        cancelFill();
        cancelReveal();
        setState('error');
        setText(errorText, historyError);
        return;
      }
      if (entryCount > 0 || liveActive) {
        if (contentRevealed) {
          setState('content');
        } else {
          // The transcript rows are already in the DOM; keep the loading surface
          // for one more paint, then swap (and fade) once they are paintable.
          contentRevealed = true;
          scheduleReveal();
        }
        return;
      }
      setHidden(fillEl, true);
      const waiting = watch.running === true || watch.status === 'running' || watch.status === 'provisioning';
      setState('empty');
      setText(emptyEl, waiting ? WAITING : NO_HISTORY);
    }
    // First paint of a long transcript: newest six synchronously, the rest queued
    // newest-first so each fill frame prepends directly above the painted tail.
    function startProgressive(entries) {
      const keys = entryKeys(entries);
      const baseStart = Math.max(0, entries.length - PROGRESSIVE_TAIL);
      renderEntries(entries.slice(baseStart), keys.slice(baseStart));
      fillItems = [];
      for (let index = 0; index < baseStart; index++) fillItems.push({ entry: entries[index], key: keys[index] });
      if (!fillItems.length) { fillActive = false; setHidden(fillEl, true); return; }
      fillActive = true;
      setHidden(fillEl, false);
      scheduleFill();
    }
    function scheduleFill() {
      if (fillFrame || !fillActive || !open) return;
      fillFrame = requestAnimationFrame(fillStep);
    }
    function fillStep() {
      fillFrame = 0;
      if (!open || !fillActive || !history) { cancelFill(); return; }
      const anchored = follow ? null : captureAnchor();
      const beforeHeight = !follow && scroll ? scroll.scrollHeight : 0;
      const started = performance.now();
      let inserted = 0;
      while (fillItems.length) {
        const item = fillItems.pop();
        let view = entryViews.get(item.key);
        if (!view) {
          view = createEntry(item.entry, item.key);
          entryViews.set(item.key, view);
        }
        updateEntry(view, item.entry);
        history.insertBefore(view.article, history.firstElementChild);
        inserted += 1;
        if (performance.now() - started >= FILL_BUDGET_MS) break;
      }
      if (inserted) updateDensity();
      if (inserted && scroll) {
        if (follow) {
          scroll.scrollTop = scroll.scrollHeight;
        } else if (anchored && anchored.element.isConnected) {
          const delta = anchored.element.getBoundingClientRect().top - anchored.top;
          if (delta) scroll.scrollTop += delta;
        } else {
          scroll.scrollTop += scroll.scrollHeight - beforeHeight;
        }
        lastTop = scroll.scrollTop;
      }
      if (!fillItems.length) {
        fillActive = false;
        setHidden(fillEl, true);
        if (follow) pin();
      } else {
        scheduleFill();
      }
    }
    // History projection: normalize/render only when the transcript identity
    // (ids + omitted + count) changed; header and live entry update on every tick.
    function syncHistory(watch) {
      const historyData = watch.history && typeof watch.history === 'object' ? watch.history : {};
      const omitted = Number.isSafeInteger(historyData.omitted) && historyData.omitted > 0 ? historyData.omitted : 0;
      const facts = historyFacts(historyData.entries, omitted);
      if (facts.signature === historySignature) return;
      const growth = contentRevealed && isHistoryGrowth(historyKeys, facts.keys);
      historySignature = facts.signature;
      historyKeys = facts.keys;
      cancelFill();
      const entries = normalizeEntries(historyData.entries);
      historyCount = entries.length;
      if (contentRevealed && !growth) contentRevealed = false;
      if (!contentRevealed && entries.length > PROGRESSIVE_THRESHOLD) startProgressive(entries);
      else renderEntries(entries);
    }
    function renderHeader(watch) {
      const name = clean(watch.name, 64) || currentName;
      setRaw(nameEl, name);
      setRaw(initialsEl, initialsFor(name));
      setText(roleEl, ROLES[watch.role === 'lead' ? 'lead' : 'teammate']);
      const status = ['running', 'inactive', 'provisioning', 'failed'].includes(watch.status) ? watch.status : 'inactive';
      const running = watch.running === true || status === 'running';
      setData(chip, 'status', status);
      setData(chip, 'live', String(running));
      setData(avatarEl, 'status', status);
      setData(element, 'status', status);
      setHidden(liveDot, !running);
      setText(statusText, MEMBER_STATUS[status] || MEMBER_STATUS.inactive);
      const activity = normalizeActivity(watch.activity);
      setHidden(activityEl, !activity);
      if (activity) setRaw(activityEl, activityText(activity));
      const description = clean(watch.description, 400);
      setHidden(descriptionEl, !description);
      if (description) setRaw(descriptionEl, description);
      else if (descriptionEl.title) descriptionEl.removeAttribute('title');
      if (description) descriptionEl.title = description;
      const memberError = memberErrorText(watch.error);
      setHidden(memberErrorEl, !memberError);
      if (memberError) setRaw(memberErrorEl, memberError);
    }

    function showLoading(name = currentName) {
      clearLoadingTimer();
      received = false;
      cancelFill();
      cancelReveal();
      contentRevealed = false;
      // A new watch snapshot may repeat the old transcript ids: reset the
      // signature so the next update re-syncs from scratch.
      historySignature = '';
      historyKeys = [];
      setState('loading');
      setText(loading, t('正在读取 {0} 的会话…', name));
      loadingTimer = setTimeout(() => {
        loadingTimer = 0;
        if (open && !received) fail(TIMEOUT_ERROR);
      }, LOADING_TIMEOUT_MS);
    }
    function fail(message) {
      if (!open) return;
      received = true;
      clearLoadingTimer();
      cancelFill();
      cancelReveal();
      setState('error');
      setText(errorText, message || DEFAULT_ERROR);
      setHidden(omittedEl, true);
    }
    function openView(name) {
      const next = clean(name, 64);
      if (!next) return;
      if (open && next === currentName) {
        pin();
        return;
      }
      resetContent();
      currentName = next;
      open = true;
      received = false;
      viewSessionId = '';
      returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
      element.hidden = false;
      if (assistMode) assistMode.dataset.teamMember = 'true';
      setRaw(nameEl, next);
      setRaw(initialsEl, initialsFor(next));
      setText(roleEl, ROLES.teammate);
      setData(chip, 'status', 'provisioning');
      setData(chip, 'live', 'false');
      setData(avatarEl, 'status', 'provisioning');
      setData(element, 'status', 'provisioning');
      setHidden(liveDot, true);
      setText(statusText, MEMBER_STATUS.provisioning);
      setHidden(activityEl, true);
      setHidden(descriptionEl, true);
      setHidden(memberErrorEl, true);
      setRaw(errorText, '');
      removeAttribute(descriptionEl, 'title');
      follow = true;
      lastTop = 0;
      if (scroll) { scroll.scrollTop = 0; }
      showLoading(next);
      try { back.focus({ preventScroll: true }); } catch { try { back.focus(); } catch { /* Focus is best effort. */ } }
    }
    function removeAttribute(element, name) {
      if (element && element.hasAttribute(name)) element.removeAttribute(name);
    }
    function closeView({ restoreFocus = true } = {}) {
      if (!open) return;
      open = false;
      clearLoadingTimer();
      resetContent();
      element.hidden = true;
      if (assistMode) delete assistMode.dataset.teamMember;
      if (element.dataset.status) delete element.dataset.status;
      currentName = '';
      viewSessionId = '';
      if (restoreFocus) {
        const target = returnFocus;
        if (target && target.isConnected && target.getClientRects && target.getClientRects().length) {
          try { target.focus({ preventScroll: true }); } catch { /* Focus is best effort. */ }
        } else {
          const toggle = byId('team-toggle');
          const prompt = byId('prompt-input');
          const fallback = toggle && !toggle.hidden ? toggle : prompt;
          if (fallback) { try { fallback.focus({ preventScroll: true }); } catch { /* Focus is best effort. */ } }
        }
      }
      returnFocus = undefined;
      onClose?.();
    }
    function update(watch, sessionId) {
      if (!open) return;
      if (typeof sessionId === 'string' && sessionId) viewSessionId = sessionId;
      const locale = window.UBOVMi18n?.locale || 'zh-CN';
      const localeChanged = locale !== lastLocale;
      lastLocale = locale;
      if (!watch || typeof watch !== 'object') {
        // Keep the loading surface: a transient execution-only snapshot (or a
        // late state) must not look like a terminal empty conversation.
        if (localeChanged) showLoading(currentName);
        return;
      }
      const name = clean(watch.name, 64);
      if (!name || name !== currentName) return;
      received = true;
      clearLoadingTimer();
      renderHeader(watch);
      syncHistory(watch);
      const live = renderLive(watch);
      renderState(watch, historyCount, Boolean(live));
      pin();
    }

    back.addEventListener('click', () => closeView({ restoreFocus: true }));
    retry?.addEventListener('click', () => {
      if (!open) return;
      showLoading(currentName);
      try { onRetry?.(currentName); } catch { /* Retry callback is host-owned. */ }
    });
    document.addEventListener('keydown', event => {
      if (event.key !== 'Escape' || !open || event.defaultPrevented) return;
      if (isBlocked?.()) return;
      event.preventDefault();
      closeView({ restoreFocus: true });
    });
    scroll?.addEventListener('scroll', () => {
      const top = scroll.scrollTop;
      const max = scroll.scrollHeight - scroll.clientHeight;
      if (top < lastTop - 2) follow = false;
      else if (max - top <= 32) follow = true;
      lastTop = top;
    }, { passive: true });
    window.addEventListener('resize', () => { if (open) pin(); });

    return {
      element,
      open: openView,
      close: closeView,
      update,
      fail,
      showLoading: () => showLoading(currentName),
      get isOpen() { return open; },
      get name() { return currentName; }
    };
  };
})();
