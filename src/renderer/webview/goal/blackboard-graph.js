(() => {
  'use strict';
  const el = (tag, cls, text) => { const n = document.createElement(tag); n.className = cls; if (text) n.textContent = text; return n; };
  const put = (n, text) => { if (n.textContent !== text) n.textContent = text; };
  let graphSequence = 0;
  const NODE_WIDTH = 240, NODE_HEIGHT = 128, COLUMN_STEP = 288, ROW_STEP = 208;
  window.createBlackboardGraph = (container, { factText, statusText, actionsContainer, onDetail }) => {
    const graphId = ++graphSequence;
    const controls = el('div', 'graph-controls');
    controls.setAttribute('role', 'group'); controls.setAttribute('aria-label', '画布缩放');
    const minus = el('button', '', '−'), zoomLabel = el('span', 'graph-zoom', '100%'), plus = el('button', '', '+'), fit = el('button', 'graph-fit', '⛶');
    minus.type = plus.type = fit.type = 'button';
    minus.setAttribute('aria-label', '缩小探索图'); plus.setAttribute('aria-label', '放大探索图');
    fit.setAttribute('aria-label', '适应画布'); fit.title = '重置布局并适应画布';
    controls.append(minus, zoomLabel, plus, fit);
    const navigation = el('div', 'graph-navigation');
    const search = el('input', 'graph-search'); search.type = 'search'; search.placeholder = '搜索事实、意图或节点 ID'; search.setAttribute('aria-label', '搜索探索图');
    const next = el('button', '', '下一项'); next.type = 'button';
    const searchCount = el('span', 'graph-search-count'); searchCount.setAttribute('role', 'status');
    const trace = el('select', 'graph-trace'); trace.setAttribute('aria-label', '探索路径');
    for (const [value, label] of [['all', '全部路径'], ['upstream', '追溯上游证据'], ['downstream', '追踪下游分支']]) {
      const option = el('option', '', label); option.value = value; trace.append(option);
    }
    navigation.append(search, next, searchCount, trace);
    actionsContainer?.replaceChildren();
    const viewport = el('div', 'graph-viewport'); viewport.tabIndex = 0; viewport.setAttribute('aria-label', '任务关系图，可横向和纵向滚动');
    const canvas = el('div', 'graph-canvas');
    const edges = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); edges.classList.add('graph-edges'); edges.setAttribute('aria-label', '探索意图连线');
    const goalPositionId = Symbol('final-goal');
    const goalBadge = el('button', 'graph-node graph-goal-badge'); goalBadge.type = 'button';
    const goalTitle = el('strong', 'graph-node-title');
    goalBadge.append(el('span', 'graph-node-state', '最终目标'), goalTitle);
    canvas.append(edges, goalBadge); viewport.append(canvas);
    const detail = el('section', 'graph-detail'); detail.hidden = true; detail.setAttribute('aria-label', '黑板节点详情');
    const workspace = el('div', 'graph-workspace'); workspace.append(viewport, controls, detail);
    workspace.style.setProperty('--graph-node-width', NODE_WIDTH + 'px');
    workspace.style.setProperty('--graph-node-height', NODE_HEIGHT + 'px');
    container.replaceChildren(navigation, workspace);
    let session = '', selected = '', nodes = [], positions = new Map(), records = new Map(), rootId = '';
    let scale = 1, lastSnapshot, projectedSource, projectedSnapshot, cachedRanks, graphWidth = 288, graphHeight = 160;
    let detailOpen = false, drag = null, dragFrame = 0, suppressClick = '';
    let pan = { x: 0, y: 0 }, panGesture = null;
    let matches = [], matchIndex = -1;
    let suspended = false, disposed = false;
    const blocked = () => disposed || suspended || document.hidden || document.getElementById('settings-dialog')?.open;
    const edgeRecords = new Map();
    let edgeSequence = 0;
    function updateSearch() {
      if (blocked()) return;
      const query = search.value.trim().toLocaleLowerCase();
      matches = query ? nodes.filter(n => [n.id, title(n), factText(n.fact?.content), n.intent?.hint, ...(n.intent?.keyPoints || [])].join('\n').toLocaleLowerCase().includes(query)).map(n => n.id) : [];
      matchIndex = matches.indexOf(selected);
      put(searchCount, query ? `${matchIndex + 1} / ${matches.length}` : ''); next.disabled = !matches.length;
    }
    function applyTrace() {
      if (blocked()) return;
      const visible = trace.value === 'all' || !projectedSnapshot ? null : window.traceExplorationGraph(projectedSnapshot, selected, trace.value);
      for (const [id, record] of records) record.button.classList.toggle('is-muted', !!visible && !visible.has(id));
      for (const edge of edges.children) edge.classList.toggle('is-muted', !!visible && edge.dataset.selectionId !== selected && !(visible.has(edge.dataset.source) && visible.has(edge.dataset.target)));
    }
    search.addEventListener('input', updateSearch);
    let composingSearch = false;
    search.addEventListener('compositionstart', () => { composingSearch = true; });
    search.addEventListener('compositionend', () => { composingSearch = false; updateSearch(); });
    search.addEventListener('blur', () => { composingSearch = false; });
    next.addEventListener('click', () => { if (matches.length) select(matches[(matchIndex + 1) % matches.length], true); });
    search.addEventListener('keydown', event => { if (event.key === 'Enter' && !composingSearch && !event.isComposing && event.keyCode !== 229) { event.preventDefault(); next.click(); } });
    trace.addEventListener('change', applyTrace);
    // One camera in viewport pixels. CSS zoom/scroll offsets must not participate:
    // their changing overflow and auto margins otherwise move the zoom anchor.
    const applyPan = () => { canvas.style.transform = `translate(${pan.x}px, ${pan.y}px) scale(${scale})`; };
    const resetPan = () => { pan = { x: 0, y: 0 }; applyPan(); };
    viewport.setAttribute('aria-label', '探索画布，滚轮缩放，拖动空白区域平移，拖动节点调整位置');
    zoomLabel.title = '滚轮缩放 · 拖动空白区域平移';
    viewport.addEventListener('pointerdown', event => {
      if (blocked()) return;
      if (event.button !== 0 || !event.isPrimary || event.target.closest('button, [role="button"]')) return;
      const rect = viewport.getBoundingClientRect();
      if (event.clientX >= rect.left + viewport.clientWidth || event.clientY >= rect.top + viewport.clientHeight) return;
      panGesture = { pointer: event.pointerId, x: event.clientX, y: event.clientY, start: { ...pan } };
      viewport.setPointerCapture(event.pointerId); viewport.classList.add('is-panning'); event.preventDefault();
    });
    viewport.addEventListener('pointermove', event => {
      if (!panGesture || event.pointerId !== panGesture.pointer) return;
      pan = { x: panGesture.start.x + event.clientX - panGesture.x, y: panGesture.start.y + event.clientY - panGesture.y };
      applyPan();
    });
    const endPan = event => {
      if (!panGesture || event.pointerId !== panGesture.pointer) return;
      panGesture = null; viewport.classList.remove('is-panning');
      if (viewport.hasPointerCapture(event.pointerId)) viewport.releasePointerCapture(event.pointerId);
    };
    for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) viewport.addEventListener(event, endPan);
    const manualPositions = new Map();
    const automaticPositions = new Map();
    let labelFrame = 0;
    function scheduleLabels() {
      if (blocked() || labelFrame) return;
      labelFrame = requestAnimationFrame(() => {
        labelFrame = 0;
        if (blocked() || !viewport.clientWidth) return;
        // Wheel bursts share one hit-target/label update per animation frame.
        for (const hit of edges.querySelectorAll('.graph-edge-hit')) hit.style.strokeWidth = String(14 / scale);
        const collisions = window.createGraphCollisionIndex(), decisions = [];
        // The camera, not the old layout origin, defines the visible area.
        const bounds = scale < .65 ? null : viewport.getBoundingClientRect();
        if (bounds) {
          collisions.add(goalBadge.getBoundingClientRect());
          for (const record of records.values()) collisions.add(record.button.getBoundingClientRect());
        }
        for (const label of edges.querySelectorAll('.graph-edge-label')) {
          let hidden = true;
          if (bounds) {
            const rect = label.getBoundingClientRect();
            const textPath = label.querySelector('textPath'), track = document.getElementById(textPath?.getAttribute('href')?.slice(1));
            hidden = !!(track && label.getComputedTextLength() > track.getTotalLength() - 8 || rect.left < bounds.left || rect.right > bounds.right || rect.top < bounds.top || rect.bottom > bounds.bottom || collisions.intersects(rect));
            if (!hidden) collisions.add(rect);
          }
          decisions.push({ label, hidden });
        }
        // Finish all geometry reads before changing visibility or focus.
        for (const { label, hidden } of decisions) {
          const line = label.previousElementSibling;
          const transferFocus = hidden && document.activeElement === label;
          label.style.visibility = hidden ? 'hidden' : 'visible';
          label.setAttribute('aria-hidden', String(hidden));
          if (label.dataset.selectionId) {
            label.setAttribute('tabindex', hidden ? '-1' : '0');
            line.setAttribute('tabindex', hidden ? '0' : '-1');
            if (transferFocus) line.focus({ preventScroll: true });
          }
        }
      });
    }
    let resizeFrame = 0, viewportSize = '';
    const observer = new ResizeObserver(() => {
      if (blocked()) return;
      const size = `${viewport.clientWidth}:${viewport.clientHeight}`;
      if (!viewport.clientWidth || !viewport.clientHeight || size === viewportSize) return;
      viewportSize = size;
      if (!resizeFrame) resizeFrame = requestAnimationFrame(() => {
        resizeFrame = 0;
        if (!blocked() && lastSnapshot) render(lastSnapshot, true);
      });
    });
    observer.observe(viewport);
    const suspend = () => {
      observer.disconnect();
      cancelAnimationFrame(resizeFrame); cancelAnimationFrame(labelFrame); cancelAnimationFrame(dragFrame);
      resizeFrame = labelFrame = dragFrame = 0;
      const capturedDrag = drag, capturedPan = panGesture;
      drag = panGesture = null; viewport.classList.remove('is-panning');
      const dragButton = capturedDrag?.id === goalPositionId ? goalBadge : records.get(capturedDrag?.id)?.button;
      if (dragButton?.hasPointerCapture(capturedDrag.pointer)) dragButton.releasePointerCapture(capturedDrag.pointer);
      if (capturedPan && viewport.hasPointerCapture(capturedPan.pointer)) viewport.releasePointerCapture(capturedPan.pointer);
      for (const record of records.values()) record.button.classList.remove('is-dragging');
      goalBadge.classList.remove('is-dragging');
    };
    const resume = () => {
      if (blocked()) return;
      observer.observe(viewport); viewportSize = '';
      if (lastSnapshot) render(lastSnapshot, true);
    };
    const hide = () => { suspended = true; suspend(); };
    const show = () => { suspended = false; resume(); };
    const visibility = () => { if (blocked()) suspend(); else resume(); };
    window.addEventListener('pagehide', hide);
    window.addEventListener('pageshow', show);
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('ubovm-settings-visibility', visibility);
    const positionKey = id => id;
    function closeDetail() {
      if (blocked()) return;
      detailOpen = false; detail.hidden = true;
      onDetail?.(null, false);
      const control = records.get(selected)?.button || [...edges.children].find(n => n.getAttribute('tabindex') === '0' && n.dataset.selectionId === selected);
      control?.focus({ preventScroll: true });
    }
    detail.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); closeDetail(); } });
    function attachDrag(button, id) {
      button.addEventListener('pointerdown', event => {
        if (blocked()) return;
        if (event.button !== 0 || !event.isPrimary) return;
        suppressClick = ''; const p = positions.get(id); if (!p) return;
        // Native focus scrolling must not move an ancestor while dragging a
        // transformed node near a clipped edge.
        event.preventDefault(); button.focus({ preventScroll: true });
        drag = { id, pointer: event.pointerId, x: event.clientX, y: event.clientY, start: { ...p }, moved: false };
        button.setPointerCapture(event.pointerId);
      });
      button.addEventListener('pointermove', event => {
        if (!drag || drag.id !== id || drag.pointer !== event.pointerId) return;
        const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
        if (!drag.moved && Math.hypot(dx, dy) < 4) return;
        drag.moved = true; button.classList.add('is-dragging');
        // Pan can reveal negative world coordinates. Do not clamp nodes to the
        // original layout rectangle or they get stuck at an invisible wall.
        manualPositions.set(positionKey(id), { x: drag.start.x + dx / scale, y: drag.start.y + dy / scale });
        if (!dragFrame) dragFrame = requestAnimationFrame(() => { dragFrame = 0; render(lastSnapshot, true); });
      });
      const finish = event => {
        if (!drag || drag.id !== id || drag.pointer !== event.pointerId) return;
        if (drag.moved) suppressClick = id;
        drag = null; button.classList.remove('is-dragging');
        if (button.hasPointerCapture(event.pointerId)) button.releasePointerCapture(event.pointerId);
      };
      button.addEventListener('pointerup', finish); button.addEventListener('pointercancel', finish); button.addEventListener('lostpointercapture', finish);
    }
    function zoom(value, anchor) {
      if (blocked()) return;
      const nextScale = Math.max(.25, Math.min(1.5, value));
      if (!Number.isFinite(nextScale) || nextScale === scale) return;
      const bounds = viewport.getBoundingClientRect();
      const point = anchor
        ? { x: anchor.x - bounds.left - viewport.clientLeft, y: anchor.y - bounds.top - viewport.clientTop }
        : { x: viewport.clientWidth / 2, y: viewport.clientHeight / 2 };
      const ratio = nextScale / scale;
      pan = { x: point.x - (point.x - pan.x) * ratio, y: point.y - (point.y - pan.y) * ratio };
      scale = nextScale;
      applyPan();
      put(zoomLabel, Math.round(scale * 100) + '%'); minus.disabled = scale <= .25; plus.disabled = scale >= 1.5;
      scheduleLabels();
    }
    viewport.addEventListener('wheel', event => {
      if (!event.deltaY) return;
      event.preventDefault();
      if (drag || panGesture) return;
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.clientHeight : 1;
      const delta = Math.max(-240, Math.min(240, event.deltaY * unit));
      zoom(scale * Math.exp(-delta * .002), { x: event.clientX, y: event.clientY });
    }, { passive: false });
    minus.addEventListener('click', () => zoom(scale - .15)); plus.addEventListener('click', () => zoom(scale + .15));
    fit.addEventListener('click', () => {
      if (blocked()) return;
      manualPositions.clear(); automaticPositions.clear(); render(lastSnapshot);
      zoom(Math.min(1, (viewport.clientWidth - 16) / graphWidth, (viewport.clientHeight - 16) / graphHeight));
      pan = { x: (viewport.clientWidth - graphWidth * scale) / 2, y: (viewport.clientHeight - graphHeight * scale) / 2 };
      applyPan(); scheduleLabels();
    });
    function factSections(content) {
      try {
        const fact = JSON.parse(content);
        if (fact?.version === 1 && typeof fact.statement === 'string' && Array.isArray(fact.evidence)) {
          const strings = values => Array.isArray(values) ? values.filter(value => typeof value === 'string' && value.trim()) : [];
          const list = values => strings(values).map(value => '- ' + value).join('\n');
          const statuses = { confirmed: '已确认', negative: '已否定', partial: '部分完成', blocked: '受阻' };
          return [
            ['结论', fact.statement],
            ['验证覆盖', list(Array.isArray(fact.coverage) ? fact.coverage.filter(item => item && typeof item.point === 'string' && typeof item.result === 'string').map(item => `${statuses[item.status] || '待确认'}：${item.point} — ${item.result}`) : [])],
            ['证据', list(fact.evidence.filter(item => item && typeof item.observation === 'string').map(item => item.observation + (item.toolCallId || item.nodeRef ? ` [${item.toolCallId || item.nodeRef}]` : '')))],
            ['失败检查', list(fact.failedChecks)], ['限制', list(fact.limitations)], ['后续步骤', list(fact.nextSteps)]
          ].filter(([, value]) => value?.trim());
        }
      } catch { /* Plain facts retain their original content. */ }
      const text = factText(content);
      return text ? [['事实内容', text]] : [];
    }
    const title = n => n.kind === 'root' ? n.goal || '目标' : n.intent?.description || factSections(n.fact?.content)[0]?.[1] || '共享事实';
    const summary = n => { const text = title(n).replace(/\s+/g, ' ').trim(); return text.length > 100 ? text.slice(0, 100) + '…' : text; };
    function factInfo(n) {
      const source = n.producerId ? '执行产出' : `${new Set(n.parentIds || []).size} 个来源`;
      try {
        const fact = JSON.parse(n.fact?.content);
        if (fact?.version === 1 && typeof fact.statement === 'string' && Array.isArray(fact.evidence)) {
          const evidence = fact.evidence.filter(item => typeof item?.observation === 'string' && item.observation.trim()).length;
          const limits = Array.isArray(fact.limitations) ? fact.limitations.filter(item => typeof item === 'string' && item.trim()).length : 0;
          const failed = Array.isArray(fact.failedChecks) ? fact.failedChecks.filter(item => typeof item === 'string' && item.trim()).length : 0;
          return [source, `${evidence} 条证据`, limits ? `${limits} 项限制` : '', failed ? `${failed} 项检查失败` : ''].filter(Boolean).join(' · ');
        }
      } catch { /* Plain facts do not imply verified evidence. */ }
      return source + ' · 共享事实';
    }
    function factOutcome(n) {
      try {
        const fact = JSON.parse(n.fact?.content);
        return fact?.version === 1 && ['confirmed', 'negative', 'partial', 'blocked'].includes(fact.outcome) ? fact.outcome : '';
      } catch { return ''; }
    }
    const state = n => n.kind === 'root' ? '目标' : n.kind === 'intent' ? '意图 · ' + statusText(n.intent?.status)
      : ({ confirmed: '事实 · 已确认', negative: '事实 · 已否定', partial: '事实 · 待补证', blocked: '事实 · 受阻' }[factOutcome(n)] || '事实');
    function select(id, reveal = false, open = true) {
      if (blocked()) return;
      if (open) detailOpen = true;
      selected = id;
      const visualId = projectedSnapshot?.graphNodes.find(n => n.intentId === id)?.id || nodes.find(n => n.id === id)?.resultId || id;
      for (const [key, record] of records) record.button.setAttribute('aria-pressed', String(key === selected || key === visualId));
      for (const edge of edges.children) edge.classList.toggle('is-selected', edge.dataset.intentId === selected || edge.dataset.source === selected || edge.dataset.target === selected);
      updateSearch(); applyTrace();
      const n = nodes.find(n => n.id === selected); detail.hidden = !!onDetail || !n || !detailOpen;
      if (!n) { if (detailOpen) onDetail?.(null, false); return; }
      const detailTitle = n.kind === 'fact' ? '事实详情' : title(n);
      const heading = el('h3', '', detailTitle), meta = el('p', 'graph-detail-meta', `${state(n)} · ${n.sourceId || n.id}${n.producerId ? ' · 执行产出' : ''}`);
      const close = el('button', 'graph-detail-close', '×'); close.type = 'button'; close.setAttribute('aria-label', '关闭节点详情'); close.addEventListener('click', closeDetail);
      const content = [close, heading, meta];
      if (n.resultId) {
        const result = el('button', 'graph-result-link', '查看产出事实 →'); result.type = 'button'; result.addEventListener('click', () => select(n.resultId, true)); content.push(result);
      }
      for (const [label, value] of [['执行提示', n.intent?.hint], ['关注点', n.intent?.keyPoints?.join('\n')], ...factSections(n.fact?.content), ['最近执行错误', n.attempts?.at(-1)?.error]]) {
        if (value) content.push(el('h4', '', label), el('p', 'graph-detail-text', typeof value === 'string' ? value : JSON.stringify(value)));
      }
      const parents = [...new Set(n.parentIds || [])].map(id => nodes.find(n => n.id === id)).filter(Boolean);
      if (parents.length) {
        const links = el('div', 'graph-parent-links'); links.append(el('span', '', '来源'));
        for (const parent of parents) { const link = el('button', '', summary(parent)); link.type = 'button'; link.addEventListener('click', () => select(parent.id, true)); links.append(link); }
        content.push(links);
      }
      if (n.attempts?.length) content.push(el('p', 'graph-detail-meta', `执行 ${n.attempts.length} 次 · 最近状态：${statusText(n.attempts.at(-1).status)}`));
      const key = JSON.stringify([selected, n.parentIds, n.resultId, ...content.map(n => n.textContent)]);
      if (onDetail && detailOpen && (open || detail.dataset.key !== key)) {
        const sections = [];
        for (let i = 0; i < content.length; i++) {
          if (content[i].tagName === 'H4') sections.push({ label: content[i].textContent, text: content[i + 1]?.textContent || '' });
        }
        if (n.attempts?.length) sections.push({ label: '执行记录', text: `执行 ${n.attempts.length} 次 · 最近状态：${statusText(n.attempts.at(-1).status)}` });
        onDetail({ id: n.id, title: detailTitle, meta: meta.textContent, sections,
          links: [...(n.resultId ? [{ id: n.resultId, label: '查看产出事实 →' }] : []), ...parents.map(parent => ({ id: parent.id, label: '来源 · ' + summary(parent) }))] }, open);
      }
      if (detail.dataset.key !== key) { detail.replaceChildren(...content); detail.dataset.key = key; }
      if (reveal) { const p = positions.get(visualId); if (p) {
        pan = { x: viewport.clientWidth / 2 - (p.x + NODE_WIDTH / 2) * scale, y: viewport.clientHeight / 2 - (p.y + NODE_HEIGHT / 2) * scale };
        applyPan(); records.get(visualId)?.button.focus({ preventScroll: true });
      } }
    }
    attachDrag(goalBadge, goalPositionId);
    goalBadge.addEventListener('click', event => {
      if (suppressClick === goalPositionId && event.detail !== 0) { suppressClick = ''; return; }
      select(rootId);
    });
    function render(snapshot, geometryOnly = false) {
      if (disposed) return;
      lastSnapshot = snapshot;
      if (blocked()) return;
      const reuse = geometryOnly && snapshot === projectedSource && projectedSnapshot;
      snapshot = reuse ? projectedSnapshot : window.projectExplorationGraph(snapshot);
      const nextSession = snapshot?.sessionId || '';
      if (session !== nextSession) { search.value = ''; trace.value = 'all'; }
      if (session !== nextSession) { session = nextSession; selected = ''; detailOpen = false; manualPositions.clear(); automaticPositions.clear(); drag = null; panGesture = null; viewport.classList.remove('is-panning'); zoom(1); resetPan(); }
      nodes = [...new Map((snapshot?.nodes || []).filter(n => n && typeof n.id === 'string').map(n => [n.id, n.kind === 'root' ? { ...n, goal: snapshot.goal } : n])).values()];
      rootId = snapshot?.rootId || nodes.find(n => n.kind === 'root')?.id;
      put(goalTitle, snapshot?.goal || '目标尚未设置');
      goalBadge.title = snapshot?.goal || '目标尚未设置';
      goalBadge.setAttribute('aria-label', '最终目标：' + goalBadge.title);
        controls.hidden = viewport.hidden = !nodes.length;
      fit.disabled = !nodes.length;
      const graphNodes = snapshot.graphNodes, allById = new Map(nodes.map(n => [n.id, n]));
      const byId = new Map(graphNodes.map(n => [n.id, n]));
      const ranks = reuse ? cachedRanks : window.rankExplorationGraph(graphNodes);
      projectedSource = lastSnapshot;
      projectedSnapshot = snapshot;
      cachedRanks = ranks;
      for (const id of manualPositions.keys()) if (id !== goalPositionId && !byId.has(id)) manualPositions.delete(id);
      for (const id of automaticPositions.keys()) if (!byId.has(id)) automaticPositions.delete(id);
      const layers = new Map();
      for (const n of graphNodes) { const rank = ranks.get(n.id); if (!layers.has(rank)) layers.set(rank, []); layers.get(rank).push(n); }
      positions = new Map(); let widest = 1;
      for (const layer of layers.values()) widest = Math.max(widest, layer.length);
      const vertical = true;
      // Center layers and order siblings by their parents to clarify forks and joins.
      const breadth = Math.max(400, vertical ? viewport.clientWidth : viewport.clientHeight, widest * COLUMN_STEP + 64), cross = new Map();
      for (const [rank, layer] of [...layers].sort((a, b) => a[0] - b[0])) {
        // Compute each parent barycenter once, not on every sort comparison.
        const centers = new Map(layer.map(n => {
          const sources = (n.parentIds || []).map(id => cross.get(id)).filter(Number.isFinite);
          return [n.id, sources.length ? sources.reduce((a, b) => a + b, 0) / sources.length : breadth / 2];
        }));
        layer.sort((a, b) => centers.get(a.id) - centers.get(b.id) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
        const start = (breadth - (layer.length - 1) * COLUMN_STEP) / 2;
        layer.forEach((n, i) => {
          const c = start + i * COLUMN_STEP; cross.set(n.id, c);
          positions.set(n.id, { x: c - NODE_WIDTH / 2, y: 36 + rank * ROW_STEP });
        });
      }
      let depth = 1;
      for (const rank of ranks.values()) depth = Math.max(depth, rank + 1);
      // Streaming additions must not recenter every existing layer. Keep existing
      // positions and place only new nodes into free space; Fit explicitly relayouts.
      const occupied = window.createGraphCollisionIndex();
      const rectFor = p => ({ left: p.x, top: p.y, right: p.x + NODE_WIDTH, bottom: p.y + NODE_HEIGHT });
      for (const n of graphNodes) {
        const saved = manualPositions.get(n.id) || automaticPositions.get(n.id);
        if (saved) { positions.set(n.id, saved); occupied.add(rectFor(saved)); }
      }
      for (const n of graphNodes) {
        if (manualPositions.has(n.id) || automaticPositions.has(n.id)) continue;
        const p = { ...positions.get(n.id) };
        while (occupied.intersects(rectFor(p))) p.x += COLUMN_STEP;
        positions.set(n.id, p); automaticPositions.set(n.id, p); occupied.add(rectFor(p));
      }
      let extentX = breadth, extentY = (depth + 1) * ROW_STEP + 16, goalY = 36 + depth * ROW_STEP;
      for (const p of positions.values()) { extentX = Math.max(extentX, p.x + NODE_WIDTH + 32); goalY = Math.max(goalY, p.y + ROW_STEP); }
      extentY = Math.max(extentY, goalY + NODE_HEIGHT + 32);
      const goalPosition = manualPositions.get(goalPositionId) || { x: breadth / 2 - NODE_WIDTH / 2, y: goalY };
      positions.set(goalPositionId, goalPosition);
      goalBadge.style.left = goalPosition.x + 'px'; goalBadge.style.top = goalPosition.y + 'px';
      for (const n of graphNodes) { const manual = manualPositions.get(positionKey(n.id)); if (manual) positions.set(n.id, manual); }
      const width = Math.max(viewport.clientWidth, extentX, goalPosition.x + NODE_WIDTH + 32), height = Math.max(viewport.clientHeight, extentY, goalPosition.y + NODE_HEIGHT + 32);
      graphWidth = width; graphHeight = height;
      canvas.style.width = width + 'px'; canvas.style.height = height + 'px'; edges.setAttribute('width', width); edges.setAttribute('height', height);
      edges.style.width = width + 'px'; edges.style.height = height + 'px';
      const paths = [], keptEdges = new Set();
      const incoming = new Map();
      for (const edge of snapshot.edges) {
        if (!incoming.has(edge.target)) incoming.set(edge.target, []);
        incoming.get(edge.target).push(edge);
      }
      for (const n of graphNodes) {
        const p = positions.get(n.id);
        for (const edge of incoming.get(n.id) || []) {
          const parent = edge.source;
          const from = positions.get(parent); if (!from) continue;
          const key = JSON.stringify([parent, n.id, edge.intentId || null]);
          const cached = edgeRecords.get(key); keptEdges.add(key);
          const line = cached?.line || document.createElementNS('http://www.w3.org/2000/svg', 'path');
          line.dataset.source = parent; line.dataset.target = n.id;
          line.dataset.kind = edge.intentId ? 'explores' : 'derives'; line.dataset.status = edge.status || '';
          if (edge.intentId) line.dataset.intentId = edge.intentId;
          const parentHeight = byId.get(parent).kind === 'root' ? 48 : NODE_HEIGHT;
          const parentWidth = byId.get(parent).kind === 'root' ? 88 : NODE_WIDTH;
          const targetHeight = n.kind === 'frontier' ? 32 : NODE_HEIGHT;
          const targetWidth = n.kind === 'frontier' ? 32 : NODE_WIDTH;
          // Intersect the center-to-center line with both node bounds. This
          // stays straight across ranks and follows nodes dragged sideways/upward.
          const cx = from.x + NODE_WIDTH / 2, cy = from.y + NODE_HEIGHT / 2;
          const dx = p.x - from.x, dy = p.y - from.y;
          let start = 1 / Math.max(Math.abs(dx) / (parentWidth / 2), Math.abs(dy) / (parentHeight / 2));
          let end = 1 / Math.max(Math.abs(dx) / (targetWidth / 2), Math.abs(dy) / (targetHeight / 2));
          // Overlapping nodes have no exposed segment; do not reverse the edge.
          if (!Number.isFinite(start + end) || start + end >= 1) start = end = .5;
          const x1 = cx + dx * start, y1 = cy + dy * start;
          const x2 = cx + dx * (1 - end), y2 = cy + dy * (1 - end);
          const angle = Math.atan2(y2 - y1, x2 - x1);
          const route = `M${x1},${y1} L${x2},${y2}`;
          line.setAttribute('d', `${route} M${x2 - 6 * Math.cos(angle - .5)},${y2 - 6 * Math.sin(angle - .5)} L${x2},${y2} L${x2 - 6 * Math.cos(angle + .5)},${y2 - 6 * Math.sin(angle + .5)}`);
          const label = cached?.label || document.createElementNS('http://www.w3.org/2000/svg', 'text');
          label.classList.add('graph-edge-label'); label.dataset.source = parent; label.dataset.target = n.id; label.dataset.status = edge.status || '';
          const edgeTitle = edge.intentId ? `${edge.description} · ${statusText(edge.status)}` : '提供依据';
          const tooltip = cached?.tooltip || document.createElementNS('http://www.w3.org/2000/svg', 'title'); put(tooltip, edgeTitle); if (!cached) line.append(tooltip);
          const definitions = cached?.definitions || document.createElementNS('http://www.w3.org/2000/svg', 'defs');
          const track = cached?.track || document.createElementNS('http://www.w3.org/2000/svg', 'path');
          if (!cached) track.id = `graph-${graphId}-edge-${++edgeSequence}`;
          const reverse = x2 < x1 || x2 === x1 && y2 < y1;
          if (Math.abs(y2 - y1) > Math.abs(x2 - x1)) {
            const middleX = (x1 + x2) / 2, middleY = (y1 + y2) / 2;
            const halfLength = Math.hypot(x2 - x1, y2 - y1) / 2;
            track.setAttribute('d', `M${middleX - halfLength},${middleY} L${middleX + halfLength},${middleY}`);
          } else {
            track.setAttribute('d', reverse ? `M${x2},${y2} L${x1},${y1}` : route);
          }
          if (!cached) definitions.append(track);
          const textPath = cached?.textPath || document.createElementNS('http://www.w3.org/2000/svg', 'textPath');
          textPath.setAttribute('href', '#' + track.id); textPath.setAttribute('startOffset', '50%');
          put(textPath, edgeTitle.length > 26 ? edgeTitle.slice(0, 25) + '…' : edgeTitle);
          if (!cached) label.append(textPath);
          const selectionId = edge.intentId || n.id;
          const hit = cached?.hit || document.createElementNS('http://www.w3.org/2000/svg', 'path');
          hit.classList.add('graph-edge-hit'); hit.setAttribute('d', route);
          hit.dataset.source = parent; hit.dataset.target = n.id;
          hit.style.strokeWidth = String(14 / scale);
          hit.setAttribute('aria-hidden', 'true');
          label.dataset.selectionId = line.dataset.selectionId = hit.dataset.selectionId = selectionId;
          if (edge.intentId) label.dataset.intentId = edge.intentId;
          {
            for (const element of [hit, line, label]) {
              element.setAttribute('role', 'button'); element.setAttribute('aria-label', edgeTitle);
              if (!cached) {
                element.setAttribute('tabindex', element === label ? '0' : '-1');
                element.addEventListener('click', () => select(selectionId));
                element.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); select(selectionId); } });
              }
            }
          }
          label.setAttribute('text-anchor', 'middle'); label.setAttribute('dy', '-5');
          if (!cached) edgeRecords.set(key, { definitions, hit, line, label, track, tooltip, textPath });
          paths.push(definitions, hit, line, label);
        }
        let record = records.get(n.id);
        const fresh = !record;
        if (!record) {
          const button = el('button', n.kind === 'frontier' ? 'graph-frontier' : 'graph-node'); button.type = 'button'; button.dataset.nodeId = n.id;
          const badge = el('span', 'graph-node-state'), name = el('strong', 'graph-node-title'), info = el('small', 'graph-node-info'); button.append(badge, name, info);
          button.addEventListener('click', event => { if (suppressClick === n.id && event.detail !== 0) { suppressClick = ''; return; } select(n.intentId || n.id); });
          attachDrag(button, n.id); record = { button, badge, name, info }; records.set(n.id, record); canvas.append(button);
        }
        record.button.style.left = p.x + 'px'; record.button.style.top = p.y + 'px';
        if (!reuse || fresh) {
        record.button.dataset.outcome = factOutcome(n);
        record.button.dataset.status = n.status || n.kind; record.button.dataset.kind = n.kind; record.button.title = n.kind === 'frontier' ? '尚未产出事实 · ' + statusText(n.status) : title(n);
        record.button.setAttribute('aria-label', n.kind === 'frontier' ? `尚未产出事实：${allById.get(n.intentId)?.intent?.description || ''}` : state(n) + '：' + title(n));
        put(record.badge, state(n)); put(record.name, n.kind === 'frontier' ? '?' : n.kind === 'root' ? '起点' : title(n));
        put(record.info, n.kind === 'root' ? '探索目标 · 非已证实事实' : n.kind === 'intent' ? `${(n.parentIds || []).length} 个来源 · ${n.resultId ? '已产出事实' : '尚无产出事实'}${n.attempts?.length ? ` · ${n.attempts.length} 次执行` : ''}` : factInfo(n));
        }
      }
      for (const [key, record] of edgeRecords) if (!keptEdges.has(key)) {
        for (const element of [record.definitions, record.hit, record.line, record.label]) element.remove();
        edgeRecords.delete(key);
      }
      let previous;
      for (const element of paths) {
        const next = previous ? previous.nextSibling : edges.firstChild;
        if (element !== next) edges.insertBefore(element, next);
        previous = element;
      }
      for (const [id, record] of records) if (!byId.has(id)) { record.button.remove(); records.delete(id); }
      if (!reuse) select(allById.has(selected) ? selected : rootId, false, false);
      scheduleLabels();
    }
    return { update: render, select: id => select(id, true), closeDetail, dispose() {
      if (disposed) return;
      disposed = true;
      suspend(); window.removeEventListener('pagehide', hide); window.removeEventListener('pageshow', show);
      document.removeEventListener('visibilitychange', visibility); window.removeEventListener('ubovm-settings-visibility', visibility);
      lastSnapshot = projectedSource = projectedSnapshot = cachedRanks = undefined;
      nodes = []; positions.clear(); records.clear(); edgeRecords.clear(); manualPositions.clear(); automaticPositions.clear();
      container.replaceChildren();
    } };
  };
})();
