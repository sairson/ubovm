(() => {
  'use strict';
  // Native right-sidebar exploration chat. The page is a VS Code WebviewView
  // tab (goal-chat-panel.cjs) bootstrapped by goal-chat-view.js; this module only
  // owns the panel DOM. It projects `chat` snapshots pushed by the host and
  // reports user intents through callbacks so the host keeps session ownership.
  const t = (value, ...args) => window.UBOVMi18n?.t(value, ...args) ?? value;
  const MAX_LENGTH = 4000;
  const MAX_INPUT_LINES = 5;
  const ROLES = new Set(['user', 'assistant']);
  const TRANSCRIPT_LIMIT = 60;
  // Image attachments travel as data URLs to the host, which re-validates and
  // saves them through the shared attachment store. The page only keeps the
  // bounded pending set; saved transcripts carry descriptors, never pixels.
  const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
  const IMAGE_NAME = /\.(png|jpe?g|webp|gif)$/i;
  const MAX_IMAGES = 4;
  const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
  const CLOSE_ICON = ['m6 6 12 12', 'M18 6 6 18'];
  const IMAGE_ICON = ['M4 5h16v14H4V5Z', 'm4 16 4.5-4.5 3 3L15 11l5 5', 'M15.5 8.5h.01'];

  const element = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const setText = (node, value) => {
    if (!node) return;
    const text = value == null ? '' : String(value);
    if (node.textContent !== text) node.textContent = text;
  };
  const setHidden = (node, hidden) => { if (node && node.hidden !== hidden) node.hidden = hidden; };
  const setAttribute = (node, name, value) => {
    if (!node) return;
    const text = String(value);
    if (node.getAttribute(name) !== text) node.setAttribute(name, text);
  };
  const setData = (node, name, value) => {
    if (!node) return;
    const text = String(value ?? '');
    if (node.dataset[name] !== text) node.dataset[name] = text;
  };
  const setProperty = (node, name, value) => { if (node && node[name] !== value) node[name] = value; };
  const errorText = value => {
    if (typeof value === 'string') return value;
    return value && typeof value === 'object' ? String(value.message ?? '') : '';
  };
  const icon = (paths, size = 13) => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    for (const [name, value] of Object.entries({
      viewBox: '0 0 24 24', width: String(size), height: String(size), fill: 'none', stroke: 'currentColor',
      'stroke-width': '1.6', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true'
    })) svg.setAttribute(name, value);
    for (const d of paths) {
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', d);
      svg.append(path);
    }
    return svg;
  };
  const REWIND_ICON = ['m9 14-5-5 5-5', 'M4 9h9a6 6 0 0 1 0 12h-3'];

  // Host-owned list of exploration chat tabs. The page never invents sessions;
  // `draft:true` only marks a freshly created exploration without a saved goal.
  function normalizeThreads(value) {
    const rows = [];
    const seen = new Set();
    for (const item of (Array.isArray(value) ? value : []).slice(0, 40)) {
      if (!item || typeof item !== 'object') continue;
      const id = typeof item.id === 'string' ? item.id : '';
      if (!id || seen.has(id)) continue;
      seen.add(id);
      rows.push({
        id,
        title: typeof item.title === 'string' ? item.title.trim().slice(0, 120) : '',
        active: item.active === true,
        draft: item.draft === true
      });
    }
    return rows;
  }

  const PART_TYPES = new Set(['text', 'tool', 'thinking', 'summary']);
  function normalizeParts(value) {
    if (!Array.isArray(value)) return [];
    return value.filter(part => part && typeof part.id === 'string' && PART_TYPES.has(part.type)).slice(-80);
  }
  // Host snapshots carry saved descriptors `{id,name,mimeType,bytes,path}`. The
  // page keeps the display fields only and lazily asks the host for the pixels.
  function normalizeImages(value) {
    const images = [];
    const seen = new Set();
    for (const item of (Array.isArray(value) ? value : []).slice(0, MAX_IMAGES)) {
      if (!item || typeof item !== 'object') continue;
      const id = typeof item.id === 'string' ? item.id : '';
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const name = typeof item.name === 'string' && item.name.trim() ? item.name.trim().slice(0, 120) : t('图片');
      const mimeType = IMAGE_TYPES.has(item.mimeType) ? item.mimeType : '';
      const bytes = Number.isFinite(item.bytes) ? item.bytes : 0;
      images.push({ id, name, ...(mimeType ? { mimeType } : {}), ...(bytes ? { bytes } : {}) });
    }
    return images;
  }
  const imageKeyOf = images => images.map(image => image.id).join('|');
  // Cheap change signature for timeline parts: avoids JSON.stringify on every
  // streamed frame while still reacting to text growth, tool output and status.
  function partsSignature(value) {
    if (!Array.isArray(value) || !value.length) return '';
    let signature = '';
    for (const part of value) {
      signature += `${part.id}|${part.type}|${part.status || ''}|${typeof part.text === 'string' ? part.text.length : 0}|${typeof part.output === 'string' ? part.output.length : 0};`;
    }
    return signature;
  }
  const partSignatures = new WeakMap();
  function signatureOf(value) {
    if (!Array.isArray(value) || !value.length) return '';
    let signature = partSignatures.get(value);
    if (signature === undefined) {
      signature = partsSignature(value);
      partSignatures.set(value, signature);
    }
    return signature;
  }

  function normalizeChat(value, previous = []) {
    const source = value && typeof value === 'object' ? value : {};
    const status = ['idle', 'running', 'completed', 'failed', 'interrupted'].includes(source.status) ? source.status : 'idle';
    const messages = [];
    const seen = new Set();
    const previousById = new Map((Array.isArray(previous) ? previous : []).map(message => [message.id, message]));
    for (const item of (Array.isArray(source.messages) ? source.messages : []).slice(-TRANSCRIPT_LIMIT)) {
      if (!item || typeof item !== 'object') continue;
      const id = typeof item.id === 'string' ? item.id : '';
      const role = ROLES.has(item.role) ? item.role : '';
      const text = typeof item.text === 'string' ? item.text : '';
      // An image-only user turn has no text of its own; the host may still supply
      // a caption. Never drop a message just because its body is empty.
      const images = role === 'user' ? normalizeImages(item.images) : [];
      if (!id || !role || (!text && !images.length) || seen.has(id)) continue;
      seen.add(id);
      const parts = role === 'assistant' ? normalizeParts(item.parts) : [];
      const imagesKey = imageKeyOf(images);
      // Reuse the previous message object when nothing visible changed so the
      // renderer can skip its DOM work on the next host snapshot.
      const prior = previousById.get(id);
      if (prior && prior.role === role && prior.text === text && (prior.imagesKey ?? '') === imagesKey
        && signatureOf(prior.parts) === signatureOf(parts)) {
        messages.push(prior);
        continue;
      }
      messages.push({ id, role, text, ...(images.length ? { images, imagesKey } : {}), ...(parts.length ? { parts } : {}) });
    }
    const error = source.error && typeof source.error === 'object' && typeof source.error.message === 'string' && source.error.message.trim()
      ? { message: source.error.message }
      : null;
    return {
      status,
      messages,
      streamText: typeof source.streamText === 'string' ? source.streamText : '',
      streamParts: normalizeParts(source.streamParts),
      // Name of the tool the agent is currently calling (empty while writing).
      activity: typeof source.activity === 'string' ? source.activity : '',
      error,
      canStop: source.canStop === true || status === 'running'
    };
  }

  window.createGoalChat = (container, options = {}) => {
    if (!container) throw new Error('Goal chat requires a panel container');
    const find = id => container.querySelector('#' + id) || document.getElementById(id);
    const nodes = {
      body: find('goal-chat-body'),
      log: find('goal-chat-log'),
      empty: find('goal-chat-empty'),
      error: find('goal-chat-error'),
      latest: find('goal-chat-latest'),
      form: find('goal-chat-form'),
      input: find('goal-chat-input'),
      count: find('goal-chat-count'),
      send: find('goal-chat-send'),
      stop: find('goal-chat-stop'),
      notice: find('goal-chat-notice'),
      close: find('goal-chat-close'),
      threads: find('goal-chat-threads'),
      threadList: find('goal-chat-thread-list'),
      newThread: find('goal-chat-thread-new'),
      threadError: find('goal-chat-thread-error'),
      attach: find('goal-chat-attach'),
      imageInput: find('goal-chat-image-input'),
      images: find('goal-chat-images'),
      hint: find('goal-chat-hint')
    };
    if (!nodes.body || !nodes.log || !nodes.input || !nodes.form) {
      return { update() {}, reset() {}, focus() {}, dispose() {} };
    }
    const actions = options.actions && typeof options.actions === 'object' ? options.actions : {};
    const suggestions = [...container.querySelectorAll('.goal-chat-suggestion')];
    // The native panel shell nests the page under <aside id="goal-chat">, while
    // the parser-facing container is document.body; state hooks go on the aside.
    const panel = container === document.body
      ? (document.getElementById('goal-chat') || document.body)
      : container;

    let session = '';
    let status = 'idle';
    let chat = normalizeChat();
    let available = true;
    let goalMissing = false;
    let modelReady = true;
    let offline = false;
    let sending = false;
    let cancelling = false;
    let composing = false;
    let localError = '';
    let follow = true;
    let lastTop = 0;
    let followFrame = 0;
    // While the reader drags the scrollbar or wheels, do not yank the transcript
    // back to the bottom on every streamed height change; that is what makes both
    // the content and the scrollbar thumb jump under the pointer.
    let interactingUntil = 0;
    let interactionTimer = 0;
    let syncFrame = 0;
    const interacting = () => performance.now() < interactingUntil;
    const noteInteraction = () => {
      interactingUntil = performance.now() + 220;
      clearTimeout(interactionTimer);
      interactionTimer = setTimeout(() => {
        interactionTimer = 0;
        // Flush the buffered partial answer before sticking so the height is final.
        if (!blocked() && status === 'running' && streamRow && streamRow.text !== chat.streamText) paintStream(streamRow);
        if (!blocked() && follow && nearBottom()) {
          stickToBottom();
          updateLatest();
        }
      }, 240);
    };
    let lineHeight = 0;
    let unavailable;
    let threads = [];
    let threadBusy = false;
    let threadError = '';
    let rewinding = '';
    let lastActiveThread = '';
    // Pending composer attachments live only in the page until the send
    // succeeds; saved transcript thumbnails come back lazily from the host.
    let imageInputEnabled = true;
    let pendingImages = [];
    let pendingKey = '';
    let imageSequence = 0;
    const imageCache = new Map();
    let dragDepth = 0;
    const rows = new Map();
    const threadButtons = new Map();
    let streamRow;
    let streamStartedAt = 0;
    let streamClock = 0;
    let stopNote;

    function blocked() { return goalMissing || !available; }

    // ---- Blocked states (assist mode / conversation without a goal) ---------
    function unavailableText() {
      return goalMissing ? t('先在探索工作台保存目标，再开始对话') : t('探索对话仅在探索模式可用');
    }
    function ensureUnavailable() {
      if (unavailable) return unavailable;
      unavailable = element('div', 'goal-chat-unavailable');
      unavailable.id = 'goal-chat-unavailable';
      unavailable.setAttribute('role', 'status');
      unavailable.append(element('p', 'goal-chat-unavailable-copy', t('探索对话仅在探索模式可用')));
      nodes.log.before(unavailable);
      setHidden(unavailable, true);
      return unavailable;
    }
    function renderUnavailable() {
      const node = ensureUnavailable();
      setHidden(node, !blocked());
      if (!blocked()) return;
      setText(node.querySelector('.goal-chat-unavailable-copy'), unavailableText());
      setData(node, 'kind', goalMissing ? 'goal-missing' : 'unavailable');
    }

    // ---- Conversation tab strip --------------------------------------------
    function ensureThreadError() {
      if (nodes.threadError) return nodes.threadError;
      nodes.threadError = element('p', 'goal-chat-thread-error');
      nodes.threadError.id = 'goal-chat-thread-error';
      nodes.threadError.setAttribute('role', 'alert');
      nodes.threadError.hidden = true;
      nodes.threads?.after(nodes.threadError);
      return nodes.threadError;
    }
    function threadTitle(thread) { return thread.title || t('新对话'); }
    function renderThreads() {
      if (!nodes.threads || !nodes.threadList || !nodes.newThread) return;
      const visible = threads.length > 0;
      setHidden(nodes.threads, !visible);
      const error = ensureThreadError();
      setText(error, threadError);
      setHidden(error, !threadError);
      const busy = threadBusy || Boolean(rewinding);
      setData(nodes.threads, 'busy', String(busy));
      setProperty(nodes.newThread, 'disabled', busy);
      if (!visible) return;
      setAttribute(nodes.threadList, 'aria-label', t('探索对话会话'));
      const lastThread = threads.length <= 1;
      let activeWrapper;
      let activeId = '';
      const kept = new Set();
      let previous;
      for (const thread of threads) {
        kept.add(thread.id);
        let entry = threadButtons.get(thread.id);
        if (!entry) {
          // Wrapper + two buttons: a tab cannot nest a close button inside itself.
          const wrapper = element('div', 'goal-chat-thread');
          wrapper.dataset.threadId = thread.id;
          const select = element('button', 'goal-chat-thread-select');
          select.type = 'button';
          select.setAttribute('role', 'tab');
          select.dataset.threadId = thread.id;
          select.addEventListener('click', () => selectThread(thread.id));
          const close = element('button', 'goal-chat-thread-close', '×');
          close.type = 'button';
          close.dataset.threadId = thread.id;
          close.addEventListener('click', event => {
            event.preventDefault();
            event.stopPropagation();
            deleteThread(thread.id);
          });
          wrapper.append(select, close);
          entry = { wrapper, select, close };
          threadButtons.set(thread.id, entry);
        }
        const { wrapper, select, close } = entry;
        const title = threadTitle(thread);
        setText(select, title);
        setAttribute(select, 'title', title);
        setAttribute(select, 'aria-selected', String(thread.active));
        setData(wrapper, 'active', String(thread.active));
        setData(select, 'active', String(thread.active));
        setProperty(select, 'disabled', busy);
        const closeDisabled = busy || status === 'running' || lastThread;
        setProperty(close, 'disabled', closeDisabled);
        close.title = lastThread ? t('至少保留一个对话') : t('删除这个对话');
        setAttribute(close, 'aria-label', lastThread ? t('至少保留一个对话') : t('删除对话“{0}”', title));
        if (thread.active) { activeWrapper = wrapper; activeId = thread.id; }
        const next = previous ? previous.nextSibling : nodes.threadList.firstChild;
        if (next !== wrapper) nodes.threadList.insertBefore(wrapper, next);
        previous = wrapper;
      }
      for (const [id, entry] of threadButtons) {
        if (kept.has(id)) continue;
        entry.wrapper.remove();
        threadButtons.delete(id);
      }
      if (activeWrapper && activeId !== lastActiveThread && nodes.threadList.scrollWidth > nodes.threadList.clientWidth) {
        activeWrapper.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      }
      lastActiveThread = activeId;
    }
    function beginThreadRequest(run, fallbackError) {
      threadBusy = true;
      threadError = '';
      renderThreads();
      let settled = false;
      const done = {
        success() {
          if (settled) return;
          settled = true;
          threadBusy = false;
          threadError = '';
          renderThreads();
        },
        failure(error) {
          if (settled) return;
          settled = true;
          threadBusy = false;
          threadError = errorText(error) || t(fallbackError);
          renderThreads();
        }
      };
      try { run(done); } catch (error) { done.failure(error); }
    }
    function selectThread(threadId) {
      if (threadBusy || rewinding || !threadId) return;
      const thread = threads.find(item => item.id === threadId);
      if (!thread || thread.active || typeof options.onSelectThread !== 'function') return;
      beginThreadRequest(done => options.onSelectThread(threadId, done), '切换探索对话失败，请重试。');
    }
    function newThread() {
      if (threadBusy || rewinding || typeof options.onNewThread !== 'function') return;
      beginThreadRequest(done => options.onNewThread(done), '新建对话失败，请重试。');
    }
    function deleteDisabled() {
      return threadBusy || Boolean(rewinding) || status === 'running' || threads.length <= 1;
    }
    function deleteThread(threadId) {
      if (deleteDisabled() || !threadId) return;
      if (typeof options.onDeleteThread !== 'function') return;
      beginThreadRequest(done => options.onDeleteThread(threadId, done), '删除对话失败，请重试。');
    }
    nodes.newThread?.addEventListener('click', () => newThread());
    nodes.threadList?.addEventListener('keydown', event => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      const buttons = [...nodes.threadList.querySelectorAll('.goal-chat-thread-select:not(:disabled)')];
      const index = buttons.indexOf(document.activeElement);
      if (index < 0) return;
      event.preventDefault();
      const offset = event.key === 'ArrowRight' ? 1 : -1;
      buttons[(index + offset + buttons.length) % buttons.length].focus();
    });

    // ---- Scroll follow ------------------------------------------------------
    function cancelFollowFrame() {
      if (followFrame) { cancelAnimationFrame(followFrame); followFrame = 0; }
    }
    function nearBottom() {
      const body = nodes.body;
      return body.scrollHeight - body.scrollTop - body.clientHeight < 24;
    }
    function stickToBottom() {
      nodes.body.scrollTop = nodes.body.scrollHeight;
      lastTop = nodes.body.scrollTop;
    }
    function scheduleStick() {
      if (blocked() || !follow || interacting()) { updateLatest(); return; }
      // Stick synchronously after the DOM update so the browser never paints a
      // frame at the previous bottom. A deferred animation frame made the thumb
      // bounce once per streamed height change.
      stickToBottom();
      updateLatest();
    }
    function updateLatest() {
      setHidden(nodes.latest, blocked() || follow);
    }
    nodes.body.addEventListener('scroll', () => {
      // A position above the bottom can only come from the reader: our own pin
      // always lands exactly at the bottom. Treat it as an active gesture so
      // streamed Markdown does not reflow under the pointer.
      if (nodes.body.scrollHeight - nodes.body.scrollTop - nodes.body.clientHeight > 1) noteInteraction();
      if (nodes.body.scrollTop < lastTop - 2) {
        follow = false;
        cancelFollowFrame();
      } else if (nearBottom()) {
        follow = true;
      }
      lastTop = nodes.body.scrollTop;
      updateLatest();
    }, { passive: true });
    // Native scrollbar coordinate hit-test: pointerdown lands in the reserved
    // gutter on the right edge of the transcript.
    nodes.body.addEventListener('pointerdown', event => {
      const gutter = nodes.body.offsetWidth - nodes.body.clientWidth;
      if (gutter <= 0) return;
      const rect = nodes.body.getBoundingClientRect();
      if (event.clientX >= rect.right - gutter - 1 && event.clientX <= rect.right + 1 &&
          event.clientY >= rect.top - 1 && event.clientY <= rect.bottom + 1) noteInteraction();
    }, { capture: true, passive: true });
    nodes.body.addEventListener('wheel', noteInteraction, { passive: true });
    nodes.body.addEventListener('touchstart', noteInteraction, { passive: true });
    nodes.latest?.addEventListener('click', () => {
      follow = true;
      updateLatest();
      const behavior = matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth';
      nodes.body.scrollTo({ top: nodes.body.scrollHeight, behavior });
      lastTop = nodes.body.scrollTop;
      nodes.input.focus({ preventScroll: true });
    });

    // ---- Transcript rows ----------------------------------------------------
    function releaseRow(row) {
      try { window.UBOVMMessage?.release?.(row.body); } catch { /* Keep teardown independent. */ }
      row.root.remove();
    }
    // Saved user turns project thumbnails from descriptors. The pixels are not
    // part of the page snapshot: each id is resolved once through the host and
    // the resulting data URI is cached for the lifetime of the session.
    function imageEntry(descriptor) {
      const id = descriptor.id;
      let entry = imageCache.get(id);
      if (entry) return entry;
      entry = { uri: '', name: descriptor.name || '', pending: true, failed: false };
      imageCache.set(id, entry);
      let settled = false;
      const finish = (uri, failed) => {
        if (settled) return;
        settled = true;
        entry.pending = false;
        entry.uri = typeof uri === 'string' ? uri : '';
        entry.failed = failed === true || !entry.uri;
        refreshImage(id);
      };
      const done = {
        success(value) {
          finish(typeof value === 'string' ? value : value?.uri, false);
        },
        failure() { finish('', true); }
      };
      if (typeof options.onImage !== 'function') { finish('', true); return entry; }
      try { options.onImage(id, done); } catch { finish('', true); }
      return entry;
    }
    function refreshImage(imageId) {
      let changed = false;
      for (const row of rows.values()) {
        const images = row.message && Array.isArray(row.message.images) ? row.message.images : [];
        if (!images.some(image => image.id === imageId)) continue;
        renderGallery(row, row.message);
        changed = true;
      }
      // A late thumbnail grows the transcript; keep a following reader pinned.
      if (changed && follow) scheduleStick();
    }
    function imageThumb(descriptor) {
      const entry = imageEntry(descriptor);
      const name = entry.name || descriptor.name || t('图片');
      if (entry.uri) {
        const figure = element('figure', 'goal-chat-message-image');
        figure.dataset.imageId = descriptor.id;
        figure.title = name;
        const preview = element('img');
        preview.src = entry.uri;
        preview.alt = name;
        preview.loading = 'lazy';
        preview.decoding = 'async';
        figure.append(preview);
        return figure;
      }
      if (entry.failed) {
        const fallback = element('span', 'goal-chat-image-fallback');
        fallback.dataset.imageId = descriptor.id;
        fallback.title = t('图片资源未加载');
        fallback.append(icon(IMAGE_ICON), element('span', 'goal-chat-image-fallback-name', name));
        return fallback;
      }
      const placeholder = element('figure', 'goal-chat-message-image goal-chat-image-pending');
      placeholder.dataset.imageId = descriptor.id;
      placeholder.setAttribute('aria-busy', 'true');
      placeholder.append(element('span', 'goal-chat-image-placeholder'));
      return placeholder;
    }
    function renderGallery(row, message) {
      if (row.role !== 'user' || !row.images) return;
      const images = Array.isArray(message.images) ? message.images : [];
      // Compare before building DOM: an untouched gallery must not allocate new
      // <img> elements on every streamed host snapshot. A cache miss is treated
      // as pending so the first paint and the next snapshot agree.
      const key = images.map(image => {
        const entry = imageCache.get(image.id);
        return image.id + ':' + (!entry ? 'pending' : entry.uri ? 'ready' : entry.failed ? 'failed' : 'pending');
      }).join('|');
      if (row.galleryKey === key) return;
      row.galleryKey = key;
      row.images.replaceChildren(...images.map(imageThumb));
      setHidden(row.images, images.length === 0);
    }
    function createRow(message) {
      const root = element('article', 'goal-chat-message');
      root.dataset.role = message.role;
      root.dataset.messageId = message.id;
      if (message.role !== 'user') {
        const body = element('div', 'goal-chat-message-body');
        root.append(body);
        return { root, body, role: message.role, text: undefined, partsKey: undefined };
      }
      // User actions live in a row below the bubble: the plain-text renderer
      // replaces the bubble's content on every update, so the action stays in a
      // stable sibling. Thumbnails sit above the bubble in their own stable
      // container for the same reason.
      const images = element('div', 'goal-chat-message-images');
      const body = element('div', 'goal-chat-bubble');
      const actions = element('div', 'goal-chat-user-actions');
      const rewind = element('button', 'goal-chat-rewind');
      rewind.type = 'button';
      rewind.dataset.messageId = message.id;
      rewind.dataset.action = 'rewind';
      rewind.setAttribute('aria-label', t('撤回这条消息及之后的回答'));
      rewind.title = t('删除这条消息及其后的回答，文字放回输入框');
      rewind.append(icon(REWIND_ICON), element('span', 'goal-chat-rewind-label', t('撤回')));
      rewind.addEventListener('click', () => rewindMessage(message.id));
      actions.append(rewind);
      root.append(images, body, actions);
      setHidden(images, true);
      return { root, body, images, role: message.role, text: undefined, partsKey: undefined, galleryKey: '', rewind, actions };
    }
    function renderRow(row, message) {
      row.message = message;
      const parts = Array.isArray(message.parts) ? message.parts : [];
      const partsKey = signatureOf(parts);
      if (row.text !== message.text || row.partsKey !== partsKey) {
        row.text = message.text; row.partsKey = partsKey;
        try {
          window.UBOVMMessage.update(row.body, message.text, message.role === 'user'
            ? { role: 'user' }
            : { ...actions, role: 'assistant', streaming: false, ...(parts.length ? { parts } : {}) });
        } catch {
          row.body.textContent = message.text;
        }
      }
      if (message.role === 'user') setHidden(row.body, !message.text);
      renderGallery(row, message);
    }
    function renderMessages() {
      const kept = new Set();
      let previous;
      for (const message of chat.messages) {
        kept.add(message.id);
        let row = rows.get(message.id);
        if (!row) {
          row = createRow(message);
          rows.set(message.id, row);
        }
        renderRow(row, message);
        const next = previous ? previous.nextSibling : nodes.log.firstChild;
        if (next !== row.root) nodes.log.insertBefore(row.root, next);
        previous = row.root;
      }
      for (const [id, row] of rows) {
        if (kept.has(id)) continue;
        releaseRow(row);
        rows.delete(id);
      }
    }
    function stopStreamClock() {
      if (streamClock) { clearInterval(streamClock); streamClock = 0; }
      streamStartedAt = 0;
    }
    function streamLabelText() {
      if (cancelling) return t('正在停止回答…');
      const base = chat.activity ? t('正在调用 {0}…', chat.activity) : t('正在回答…');
      const seconds = streamStartedAt ? Math.floor((performance.now() - streamStartedAt) / 1000) : 0;
      // Elapsed time appears only after a couple of seconds so fast answers do
      // not flash a counter; long tool calls get an honest progress signal.
      return seconds >= 3 ? `${base} · ${seconds}s` : base;
    }
    function updateStreamLabel(row) {
      if (row) setText(row.label, streamLabelText());
    }
    function releaseStream() {
      stopStreamClock();
      if (!streamRow) return;
      try { window.UBOVMMessage?.release?.(streamRow.body); } catch { /* Keep teardown independent. */ }
      streamRow.root.remove();
      streamRow = undefined;
    }
    function ensureStreamRow() {
      if (streamRow) return streamRow;
      const root = element('article', 'goal-chat-message goal-chat-streaming');
      root.id = 'goal-chat-stream';
      root.dataset.role = 'assistant';
      root.dataset.streaming = 'true';
      const body = element('div', 'goal-chat-message-body');
      const meta = element('div', 'goal-chat-streaming-status');
      const dots = element('span', 'goal-chat-streaming-dots');
      dots.setAttribute('aria-hidden', 'true');
      dots.textContent = '···';
      const label = element('span', 'goal-chat-streaming-label', t('正在回答…'));
      meta.append(dots, label);
      root.append(body, meta);
      streamRow = { root, body, label, text: undefined };
      return streamRow;
    }
    function paintStream(row) {
      const parts = Array.isArray(chat.streamParts) ? chat.streamParts : [];
      row.text = chat.streamText;
      row.partsKey = signatureOf(parts);
      try {
        window.UBOVMMessage.update(row.body, chat.streamText, { ...actions, role: 'assistant', streaming: true, ...(parts.length ? { parts } : {}) });
      } catch {
        row.body.textContent = chat.streamText;
      }
    }
    function renderStream() {
      if (blocked() || status !== 'running') {
        releaseStream();
        return;
      }
      const row = ensureStreamRow();
      if (!streamStartedAt) {
        streamStartedAt = performance.now();
        if (!streamClock) {
          streamClock = setInterval(() => {
            if (!streamRow) { stopStreamClock(); return; }
            if (blocked() || status !== 'running') { stopStreamClock(); return; }
            updateStreamLabel(streamRow);
          }, 1000);
        }
      }
      updateStreamLabel(row);
      if (nodes.log.lastElementChild !== row.root) nodes.log.append(row.root);
      const parts = Array.isArray(chat.streamParts) ? chat.streamParts : [];
      const partsKey = signatureOf(parts);
      if (row.text === chat.streamText && row.partsKey === partsKey) return;
      // Markdown growth during a scrollbar drag changes scrollHeight under the
      // pointer; buffer until the gesture settles, then paint once.
      if (interacting()) return;
      paintStream(row);
    }
    // One render per frame: several host snapshots can arrive within a single
    // frame while tokens stream, and assist-mode smoothness relies on the same
    // coalescing instead of painting every snapshot synchronously.
    function scheduleSync() {
      if (syncFrame) return;
      syncFrame = requestAnimationFrame(() => {
        syncFrame = 0;
        setData(panel, 'status', status);
        setData(panel, 'available', String(available));
        setData(panel, 'goalMissing', String(goalMissing));
        setAttribute(nodes.log, 'aria-busy', String(status === 'running'));
        renderThreads();
        renderUnavailable();
        if (!blocked()) {
          setHidden(nodes.log, false);
          renderMessages();
          renderStream();
          renderEmpty();
        } else {
          // Keep the transcript data for when the tab becomes available again, but
          // never leave stale rows visible behind the blocked notice.
          clearTranscript();
          setHidden(nodes.log, true);
          setHidden(nodes.empty, true);
          setHidden(nodes.latest, true);
        }
        renderError();
        renderStopNote();
        syncControls();
        if (!blocked()) {
          updateLatest();
          if (follow) scheduleStick();
        }
      });
    }
    function clearTranscript() {
      for (const row of rows.values()) releaseRow(row);
      rows.clear();
      releaseStream();
      nodes.log.replaceChildren();
    }

    // ---- Rewind: drop one user message and every reply after it -------------
    function rewindDisabled() {
      return blocked() || status === 'running' || sending || cancelling || threadBusy || Boolean(rewinding);
    }
    function updateRewindButtons() {
      const disabled = rewindDisabled();
      for (const row of rows.values()) {
        if (!row.rewind) continue;
        setProperty(row.rewind, 'disabled', disabled);
        setAttribute(row.rewind, 'aria-disabled', String(disabled));
      }
    }
    function rewindMessage(messageId) {
      if (rewindDisabled() || typeof options.onRewind !== 'function') return;
      rewinding = messageId;
      localError = '';
      syncAll();
      renderThreads();
      let settled = false;
      const done = {
        success(value) {
          if (settled) return;
          settled = true;
          rewinding = '';
          const text = value && typeof value.text === 'string' ? value.text.slice(0, MAX_LENGTH) : '';
          if (text) {
            setInputValue(text);
            resizeInput();
            follow = true;
            options.onDraft?.(nodes.input.value);
            nodes.input.focus({ preventScroll: true });
          }
          syncAll();
          renderThreads();
          scheduleStick();
        },
        failure(error) {
          if (settled) return;
          settled = true;
          rewinding = '';
          localError = errorText(error) || t('撤回失败，请重试。');
          syncAll();
          renderThreads();
        }
      };
      try { options.onRewind(messageId, done); } catch (error) { done.failure(error); }
    }

    // ---- Empty state / errors ----------------------------------------------
    function canType() { return available && !goalMissing && modelReady && !offline; }
    function canSubmit() {
      const text = nodes.input.value;
      const hasImages = pendingImages.length > 0;
      return canType() && !sending && status !== 'running'
        && (text.trim().length > 0 || hasImages) && text.length <= MAX_LENGTH;
    }
    function renderEmpty() {
      const visible = !blocked() && chat.messages.length === 0 && status !== 'running';
      setHidden(nodes.empty, !visible);
      for (const button of suggestions) {
        const disabled = !canType();
        setProperty(button, 'disabled', disabled);
        setAttribute(button, 'aria-disabled', String(disabled));
      }
    }
    function errorMessage() {
      return localError || (chat.error?.message ? String(chat.error.message) : '');
    }
    function renderError() {
      const message = errorMessage();
      setText(nodes.error, message);
      setHidden(nodes.error, !message);
    }
    // An interrupted turn keeps its partial answer as a normal message; explain
    // why it stopped without turning a user stop into an error.
    function renderStopNote() {
      if (!stopNote) {
        stopNote = element('p', 'goal-chat-stop-note');
        stopNote.id = 'goal-chat-stop-note';
        stopNote.setAttribute('role', 'status');
        nodes.log.insertAdjacentElement('afterend', stopNote);
      }
      const last = chat.messages.at(-1);
      const visible = !blocked() && status === 'interrupted' && !chat.streamText
        && last?.role === 'assistant' && typeof last.text === 'string' && last.text.trim().length > 0;
      setText(stopNote, visible ? t('回答已停止，已保留已生成的内容。') : '');
      setHidden(stopNote, !visible);
    }

    // ---- Composer -----------------------------------------------------------
    function resizeInput() {
      const input = nodes.input;
      if (!lineHeight) lineHeight = parseFloat(getComputedStyle(input).lineHeight) || 21;
      const maximum = Math.round(lineHeight * MAX_INPUT_LINES + 18);
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight || maximum, maximum) + 'px';
    }
    function setInputValue(value) {
      const text = typeof value === 'string' ? value.slice(0, MAX_LENGTH) : '';
      if (nodes.input.value !== text) nodes.input.value = text;
    }
    // ---- Pending images -----------------------------------------------------
    const isImageFile = file => Boolean(file && (IMAGE_TYPES.has(file.type) || (!file.type && IMAGE_NAME.test(file.name || ''))));
    const imageMime = file => file && IMAGE_TYPES.has(file.type) ? file.type : '';
    const readFileDataUrl = file => new Promise((resolve, reject) => {
      try {
        const reader = new FileReader();
        reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
        reader.onerror = () => reject(reader.error || new Error(t('无法读取图片。')));
        reader.readAsDataURL(file);
      } catch (error) { reject(error); }
    });
    function attachmentBlocked() {
      return !canType() || !imageInputEnabled || sending || status === 'running';
    }
    function renderPendingImages() {
      const container = nodes.images;
      if (!container) return;
      if (!pendingImages.length) {
        setHidden(container, true);
        // Callers clear the key before rerendering; still drop stale chips so the
        // hidden strip never keeps detached nodes after the last image is sent.
        if (pendingKey || container.childElementCount) { pendingKey = ''; container.replaceChildren(); }
        return;
      }
      setHidden(container, false);
      const key = pendingImages.map(image => image.key).join('|');
      const disabled = attachmentBlocked();
      if (key === pendingKey) {
        for (const button of container.querySelectorAll('.goal-chat-image-remove')) setProperty(button, 'disabled', disabled);
        return;
      }
      pendingKey = key;
      container.replaceChildren(...pendingImages.map(image => {
        const figure = element('figure', 'goal-chat-image');
        figure.dataset.imageKey = image.key;
        if (image.data) {
          const preview = element('img', 'goal-chat-image-preview');
          preview.src = image.data;
          preview.alt = image.name;
          preview.loading = 'lazy';
          preview.decoding = 'async';
          figure.append(preview);
        }
        const remove = element('button', 'goal-chat-image-remove');
        remove.type = 'button';
        remove.dataset.imageKey = image.key;
        remove.setAttribute('aria-label', t('移除图片'));
        remove.title = t('移除图片');
        remove.append(icon(CLOSE_ICON, 10));
        figure.append(remove, element('figcaption', 'goal-chat-image-name', image.name));
        return figure;
      }));
      for (const button of container.querySelectorAll('.goal-chat-image-remove')) setProperty(button, 'disabled', disabled);
    }
    function clearPendingImages() {
      if (!pendingImages.length) return;
      pendingImages = [];
      pendingKey = '';
      renderPendingImages();
    }
    function removePendingImage(key) {
      if (attachmentBlocked() || !key) return;
      const next = pendingImages.filter(image => image.key !== key);
      if (next.length === pendingImages.length) return;
      pendingImages = next;
      pendingKey = '';
      renderPendingImages();
      syncAll();
    }
    async function addImageFiles(files) {
      if (attachmentBlocked()) return;
      localError = '';
      for (const file of [...files]) {
        if (attachmentBlocked()) break;
        if (pendingImages.length >= MAX_IMAGES) {
          localError = t('一条消息最多附加 {0} 张图片。', MAX_IMAGES);
          break;
        }
        if (!isImageFile(file)) { localError = t('仅支持 PNG、JPEG、WebP 或 GIF 图片。'); continue; }
        if (file.size > MAX_IMAGE_BYTES) {
          localError = t('图片不能超过 {0} MiB。', Math.round(MAX_IMAGE_BYTES / 1024 / 1024));
          continue;
        }
        let data = '';
        try { data = await readFileDataUrl(file); } catch { data = ''; }
        if (!data) { localError = t('无法读取图片。'); continue; }
        if (pendingImages.some(image => image.data === data)) continue;
        pendingImages = [...pendingImages, {
          key: 'image-' + (++imageSequence),
          name: (file.name || t('图片')).slice(0, 100),
          mimeType: imageMime(file),
          data
        }];
      }
      pendingKey = '';
      renderPendingImages();
      syncAll();
    }
    const fileDrag = transfer => Boolean(transfer)
      && [...(transfer.types || [])].some(type => String(type).toLowerCase() === 'files');
    function clearDrag() {
      dragDepth = 0;
      nodes.form.classList.remove('goal-chat-dragover');
    }
    function syncControls() {
      // The blocked empty state is the single explanation for its mode; the
      // toolbar notice only explains a missing model (or a lost connection).
      const notice = blocked() ? ''
        : !modelReady ? t('先配置模型')
          : offline ? t('连接已中断，恢复后可继续提问') : '';
      setText(nodes.count, nodes.input.value.length + ' / 4,000');
      // Copilot-style composers keep the character count quiet until the field
      // has content.
      setHidden(nodes.count, nodes.input.value.length === 0);
      setText(nodes.notice, notice);
      setHidden(nodes.notice, !notice);
      setData(nodes.notice, 'kind', offline ? 'offline' : 'model');
      setProperty(nodes.input, 'disabled', !canType());
      // The attach button explains itself: a text-only model says so instead of
      // silently ignoring the click.
      const attachBlocked = attachmentBlocked();
      const attachLabel = imageInputEnabled ? t('添加图片') : t('当前模型不支持图片输入');
      setProperty(nodes.attach, 'disabled', attachBlocked);
      setAttribute(nodes.attach, 'aria-label', attachLabel);
      setAttribute(nodes.attach, 'title', attachLabel);
      setProperty(nodes.imageInput, 'disabled', attachBlocked);
      if (nodes.images) {
        for (const button of nodes.images.querySelectorAll('.goal-chat-image-remove')) {
          setProperty(button, 'disabled', attachBlocked);
        }
      }
      setProperty(nodes.send, 'disabled', !canSubmit());
      setAttribute(nodes.send, 'aria-label', t('发送探索对话消息'));
      setHidden(nodes.stop, blocked() || status !== 'running');
      setProperty(nodes.stop, 'disabled', cancelling);
      setText(nodes.stop, cancelling ? t('正在停止…') : t('停止回答'));
      updateRewindButtons();
    }
    function syncAll() {
      renderError();
      renderEmpty();
      syncControls();
    }
    function submit() {
      const text = nodes.input.value.trim();
      // The host re-validates and persists every image; the page forwards only
      // the display name, declared type and data URL (never a host path).
      const images = pendingImages.map(image => ({
        name: image.name,
        ...(image.mimeType ? { mimeType: image.mimeType } : {}),
        data: image.data
      }));
      if ((!text && !images.length) || sending || !canSubmit()) return;
      sending = true;
      localError = '';
      syncAll();
      let settled = false;
      const done = {
        success: () => {
          if (settled) return;
          settled = true;
          sending = false;
          if (nodes.input.value.trim() === text) setInputValue('');
          clearPendingImages();
          resizeInput();
          syncAll();
          options.onDraft?.('');
          nodes.input.focus({ preventScroll: true });
        },
        failure: error => {
          if (settled) return;
          settled = true;
          sending = false;
          // A failed send keeps both the text and the pending attachments so the
          // reader can retry without picking the files again.
          localError = errorText(error) || t('发送失败，请重试。');
          resizeInput();
          syncAll();
          nodes.input.focus({ preventScroll: true });
        }
      };
      try {
        if (typeof options.onSend !== 'function') throw new Error(t('发送失败，请重试。'));
        options.onSend(text, images, done);
      } catch (error) {
        done.failure(error);
      }
    }
    function cancel() {
      if (blocked() || status !== 'running' || cancelling) return;
      cancelling = true;
      syncControls();
      if (streamRow) updateStreamLabel(streamRow);
      let settled = false;
      const done = {
        success: () => {
          if (settled) return;
          settled = true;
          // The next chat snapshot clears cancelling once status leaves running.
        },
        failure: error => {
          if (settled) return;
          settled = true;
          cancelling = false;
          localError = errorText(error) || t('停止回答失败，请重试。');
          if (streamRow) updateStreamLabel(streamRow);
          syncAll();
        }
      };
      try {
        if (typeof options.onCancel !== 'function') throw new Error(t('停止回答失败，请重试。'));
        options.onCancel(done);
      } catch (error) {
        done.failure(error);
      }
    }
    nodes.form.addEventListener('submit', event => { event.preventDefault(); submit(); });
    nodes.input.addEventListener('input', () => {
      resizeInput();
      syncAll();
      options.onDraft?.(nodes.input.value);
    });
    nodes.input.addEventListener('compositionstart', () => { composing = true; });
    nodes.input.addEventListener('compositionend', () => { composing = false; });
    nodes.input.addEventListener('keydown', event => {
      if (event.key !== 'Enter' || event.shiftKey || composing || event.isComposing || event.keyCode === 229) return;
      event.preventDefault();
      submit();
    });
    nodes.stop?.addEventListener('click', cancel);
    // ---- Image intake -------------------------------------------------------
    nodes.attach?.addEventListener('click', () => {
      if (attachmentBlocked()) return;
      nodes.imageInput?.click();
    });
    nodes.imageInput?.addEventListener('change', event => {
      const files = [...(event.target.files ?? [])];
      event.target.value = '';
      if (files.length) void addImageFiles(files);
    });
    nodes.images?.addEventListener('click', event => {
      const button = event.target.closest?.('.goal-chat-image-remove');
      if (!button) return;
      removePendingImage(button.dataset.imageKey);
    });
    nodes.input.addEventListener('paste', event => {
      const files = [...(event.clipboardData?.items ?? [])]
        .filter(item => item.kind === 'file' && (!item.type || IMAGE_TYPES.has(item.type)))
        .map(item => item.getAsFile())
        .filter(Boolean);
      if (!files.length) return;
      event.preventDefault();
      if (!imageInputEnabled) {
        localError = t('当前模型不支持图片输入');
        syncAll();
        return;
      }
      if (attachmentBlocked()) return;
      void addImageFiles(files);
    });
    // A file drag anywhere on the sidebar highlights the composer and adds the
    // images there, so the narrow panel never needs a separate drop zone.
    panel.addEventListener('dragenter', event => {
      if (!fileDrag(event.dataTransfer)) return;
      event.preventDefault();
      event.stopPropagation();
      dragDepth++;
      if (!attachmentBlocked()) nodes.form.classList.add('goal-chat-dragover');
    });
    panel.addEventListener('dragover', event => {
      if (!fileDrag(event.dataTransfer)) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.dataTransfer) event.dataTransfer.dropEffect = attachmentBlocked() ? 'none' : 'copy';
    });
    panel.addEventListener('dragleave', event => {
      if (!fileDrag(event.dataTransfer)) return;
      event.stopPropagation();
      if (--dragDepth <= 0) clearDrag();
    });
    panel.addEventListener('drop', event => {
      if (!fileDrag(event.dataTransfer)) return;
      event.preventDefault();
      event.stopPropagation();
      const files = [...(event.dataTransfer?.files ?? [])].filter(isImageFile);
      clearDrag();
      if (!files.length) return;
      if (!imageInputEnabled) {
        localError = t('当前模型不支持图片输入');
        syncAll();
        return;
      }
      if (attachmentBlocked()) return;
      void addImageFiles(files);
    });
    document.addEventListener('dragend', clearDrag);
    for (const button of suggestions) {
      button.addEventListener('click', () => {
        if (!canType()) return;
        setInputValue(button.textContent || button.dataset.question || '');
        resizeInput();
        syncAll();
        options.onDraft?.(nodes.input.value);
        nodes.input.focus({ preventScroll: true });
        follow = true;
        scheduleStick();
      });
    }

    // ---- Shell controls -----------------------------------------------------
    nodes.close?.addEventListener('click', () => options.onClose?.());

    // ---- Lifecycle ----------------------------------------------------------
    function reset() {
      cancelFollowFrame();
      stopStreamClock();
      if (syncFrame) { cancelAnimationFrame(syncFrame); syncFrame = 0; }
      clearTranscript();
      if (stopNote) { setHidden(stopNote, true); setText(stopNote, ''); }
      session = '';
      status = 'idle';
      chat = normalizeChat();
      available = true;
      goalMissing = false;
      threads = [];
      threadBusy = false;
      threadError = '';
      rewinding = '';
      lastActiveThread = '';
      for (const entry of threadButtons.values()) entry.wrapper.remove();
      threadButtons.clear();
      sending = false;
      cancelling = false;
      composing = false;
      localError = '';
      imageInputEnabled = true;
      pendingImages = [];
      pendingKey = '';
      imageCache.clear();
      clearDrag();
      follow = true;
      lastTop = 0;
      interactingUntil = 0;
      clearTimeout(interactionTimer);
      interactionTimer = 0;
      nodes.body.scrollTop = 0;
      setInputValue('');
      resizeInput();
      renderPendingImages();
      setData(panel, 'status', 'idle');
      setData(panel, 'available', 'true');
      setData(panel, 'goalMissing', 'false');
      setAttribute(nodes.log, 'aria-busy', 'false');
      renderThreads();
      syncAll();
      updateLatest();
      setHidden(nodes.empty, false);
      renderUnavailable();
    }
    function update(view = {}) {
      const nextSession = typeof view.sessionId === 'string' ? view.sessionId : '';
      const nextAvailable = view.available !== false && (view.mode === undefined || view.mode === 'goal');
      const nextGoalMissing = view.goalMissing === true;
      const changedSession = nextSession !== session;
      const changedBlocked = nextAvailable !== available || nextGoalMissing !== goalMissing;
      const nextImageInput = view.imageInput !== false;
      modelReady = view.modelReady !== false;
      offline = view.offline === true;
      threads = normalizeThreads(view.threads);
      if (changedSession || changedBlocked) {
        cancelFollowFrame();
        clearTranscript();
      }
      if (changedBlocked) localError = '';
      if (changedSession) {
        session = nextSession;
        sending = false;
        cancelling = false;
        localError = '';
        threadBusy = false;
        threadError = '';
        rewinding = '';
        follow = true;
        lastTop = 0;
        nodes.body.scrollTop = 0;
        // Host thumbnails are session-scoped ids; a switch invalidates the cache
        // and any attachment the reader did not send yet.
        imageCache.clear();
        pendingImages = [];
        pendingKey = '';
        clearDrag();
        renderPendingImages();
        setInputValue(typeof view.draft === 'string' ? view.draft : '');
        resizeInput();
      } else if (typeof view.draft === 'string' && !nodes.input.value && view.draft) {
        // Drafts may be restored after the first message; only fill an empty field.
        setInputValue(view.draft);
        resizeInput();
      }
      if (!nextImageInput && imageInputEnabled) {
        // A text-only model cannot accept the queued pixels; drop them instead of
        // letting the send fail after the fact.
        pendingImages = [];
        pendingKey = '';
        renderPendingImages();
      }
      imageInputEnabled = nextImageInput;
      available = nextAvailable;
      goalMissing = nextGoalMissing;
      chat = normalizeChat(view.chat, chat.messages);
      status = chat.status;
      if (status === 'running') {
        localError = '';
        cancelling = false;
      }
      scheduleSync();
    }

    reset();
    return {
      update,
      reset,
      focus() {
        if (blocked()) return;
        if (!nodes.input.disabled) nodes.input.focus({ preventScroll: true });
        else nodes.close?.focus?.({ preventScroll: true });
      },
      dispose() {
        reset();
      }
    };
  };
})();
