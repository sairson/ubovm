/* A local navigation index over published user turns, never queued inputs. */
window.createConversationOutline = ({ scroller, beforeNavigate, onError = () => {} }) => {
  const nav = document.getElementById('conversation-outline');
  const list = document.getElementById('outline-list');
  const toggle = document.getElementById('outline-toggle');
  let turns = [], frame = 0, session = '', suspended = false, settingsOpen = false, disposed = false, synchronized = false;
  let source, activeTurn;
  const enabled = () => !disposed && !suspended && !settingsOpen && !document.hidden;
  const cancel = () => { if (frame) cancelAnimationFrame(frame); frame = 0; };
  const expand = value => {
    nav.classList.toggle('expanded', value);
    toggle.setAttribute('aria-expanded', String(value));
    toggle.setAttribute('aria-label', value ? '收起对话骨架' : '展开对话骨架');
  };
  const toggleExpanded = () => expand(!nav.classList.contains('expanded'));
  const keydown = event => {
    if (event.key === 'Escape') { expand(false); toggle.focus(); }
  };
  toggle.addEventListener('click', toggleExpanded);
  nav.addEventListener('keydown', keydown);
  function refresh() {
    if (frame || !enabled() || !turns.length) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      if (!enabled() || nav.hidden || !turns.length || !scroller.clientHeight) return;
      try {
        const edge = scroller.getBoundingClientRect().top + 48;
        // Published turns follow document order. Locate the last turn above
        // the reading edge without measuring the entire conversation.
        let low = 0, high = turns.length;
        while (low < high) {
          const middle = (low + high) >>> 1;
          if (turns[middle].article.getBoundingClientRect().top <= edge) low = middle + 1;
          else high = middle;
        }
        const active = turns[Math.max(0, low - 1)];
        if (activeTurn !== active) {
          activeTurn?.button.removeAttribute('aria-current');
          active.button.setAttribute('aria-current', 'location');
          activeTurn = active;
        }
      } catch (error) { onError(error); }
    });
  }
  scroller.addEventListener('scroll', refresh, { passive: true });
  const observer = new ResizeObserver(refresh);
  function syncObservers() {
    observer.disconnect(); cancel();
    if (!enabled()) return;
    observer.observe(scroller);
    observer.observe(document.getElementById('messages'));
    refresh();
  }
  const hide = () => { suspended = true; syncObservers(); };
  const show = () => { suspended = false; syncObservers(); };
  const settings = event => { settingsOpen = event.detail?.open === true; syncObservers(); };
  window.addEventListener('pagehide', hide);
  window.addEventListener('pageshow', show);
  window.addEventListener('ubovm-settings-visibility', settings);
  document.addEventListener('visibilitychange', syncObservers);
  syncObservers();
  function reset() {
    cancel(); turns = []; session = ''; synchronized = false; source = undefined; activeTurn = undefined;
    list.replaceChildren(); list.scrollTop = 0; nav.hidden = true;
    document.getElementById('outline-count').textContent = '0 轮';
    expand(false);
  }
  return {
    reset,
    dispose() {
      if (disposed) return;
      disposed = true; reset(); observer.disconnect();
      scroller.removeEventListener('scroll', refresh);
      toggle.removeEventListener('click', toggleExpanded);
      nav.removeEventListener('keydown', keydown);
      window.removeEventListener('pagehide', hide);
      window.removeEventListener('pageshow', show);
      window.removeEventListener('ubovm-settings-visibility', settings);
      document.removeEventListener('visibilitychange', syncObservers);
    },
    update(entries, sessionId) {
      if (disposed) return;
      if (session !== sessionId) reset();
      session = sessionId;
      // The message view replaces its entries array on history reconciliation;
      // execution-only stream updates keep that published array unchanged.
      // Token updates retain this array. Scroll and resize observers already
      // track reading geometry; unchanged history needs no extra layout pass.
      if (synchronized && source === entries) return;
      const users = entries.filter(entry => entry.role === 'user');
      // Preserve focused buttons and list position during streamed updates.
      if (synchronized && users.length === turns.length && users.every((entry, i) => entry.article === turns[i].article && entry.text === turns[i].text && Boolean(entry.steeringStatus) === turns[i].steering)) { source = entries; refresh(); return; }
      synchronized = false;
      const retained = new Map(turns.map(turn => [turn.article, turn]));
      const next = users.map((entry, index) => {
        const label = entry.text.replace(/\s+/g, ' ').trim() || '附件消息';
        let turn = retained.get(entry.article);
        if (!turn) {
          const item = document.createElement('li');
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'outline-turn';
          const mark = document.createElement('span');
          mark.className = 'outline-mark'; mark.setAttribute('aria-hidden', 'true');
          const text = document.createElement('span');
          text.className = 'outline-label';
          const number = document.createElement('span');
          number.className = 'outline-number'; number.setAttribute('aria-hidden', 'true');
          button.append(mark, number, text); item.append(button);
          turn = { article: entry.article, item, button, label: text, number };
          button.addEventListener('click', () => {
            if (!enabled() || !turns.includes(turn) || !scroller.contains(turn.article) || !scroller.clientHeight) return;
            beforeNavigate();
            const offset = turn.article.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
            scroller.scrollTop += offset - 20;
            turn.article.tabIndex = -1;
            turn.article.focus({ preventScroll: true });
            refresh();
          });
        }
        turn.text = entry.text;
        turn.steering = Boolean(entry.steeringStatus);
        turn.button.dataset.steering = String(turn.steering);
        const prefix = turn.steering ? '引导 · ' : '';
        turn.button.title = `${index + 1}. ${prefix}${label.slice(0, 500)}`;
        turn.button.setAttribute('aria-label', `第 ${index + 1} 轮：${prefix}${label.slice(0, 160)}`);
        turn.number.textContent = String(index + 1).padStart(2, '0');
        turn.label.textContent = prefix + label.slice(0, 160);
        return turn;
      });
      const keep = new Set(next.map(turn => turn.item));
      const lostFocus = turns.some(turn => !keep.has(turn.item) && turn.button === document.activeElement);
      for (const child of [...list.children]) if (!keep.has(child)) child.remove();
      let previous = null;
      for (const turn of next) {
        const sibling = previous ? previous.nextSibling : list.firstChild;
        if (turn.item !== sibling) list.insertBefore(turn.item, sibling);
        previous = turn.item;
      }
      turns = next;
      nav.hidden = !turns.length;
      document.getElementById('outline-count').textContent = `${turns.length} 轮`;
      if (lostFocus) { if (turns.length) toggle.focus({ preventScroll: true }); else scroller.focus({ preventScroll: true }); }
      synchronized = true;
      source = entries;
      refresh();
    }
  };
};
