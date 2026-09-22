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
    container.replaceChildren(workspace);
    let session = '', selected = '', nodes = [], positions = new Map(), records = new Map(), rootId = '';
    let scale = 1, lastSnapshot, graphWidth = 288, graphHeight = 160;
    let detailOpen = false, drag = null, dragFrame = 0, suppressClick = '';
    let pan = { x: 0, y: 0 }, panGesture = null;
    const applyPan = () => { canvas.style.transform = `translate(${pan.x}px, ${pan.y}px)`; };
    const resetPan = () => { pan = { x: 0, y: 0 }; applyPan(); };
    viewport.setAttribute('aria-label', '探索画布，可拖动空白区域平移，拖动节点调整位置');
    viewport.addEventListener('pointerdown', event => {
      if (event.button !== 0 || !event.isPrimary || event.target.closest('button, [role="button"]')) return;
      const rect = viewport.getBoundingClientRect();
      if (event.clientX >= rect.left + viewport.clientWidth || event.clientY >= rect.top + viewport.clientHeight) return;
      panGesture = { pointer: event.pointerId, x: event.clientX, y: event.clientY, start: { ...pan } };
      viewport.setPointerCapture(event.pointerId); viewport.classList.add('is-panning'); event.preventDefault();
    });
    viewport.addEventListener('pointermove', event => {
      if (!panGesture || event.pointerId !== panGesture.pointer) return;
      pan = { x: panGesture.start.x + (event.clientX - panGesture.x) / scale, y: panGesture.start.y + (event.clientY - panGesture.y) / scale };
      applyPan();
    });
    const endPan = event => {
      if (!panGesture || event.pointerId !== panGesture.pointer) return;
      panGesture = null; viewport.classList.remove('is-panning');
      if (viewport.hasPointerCapture(event.pointerId)) viewport.releasePointerCapture(event.pointerId);
    };
    for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) viewport.addEventListener(event, endPan);
    const manualPositions = new Map();
    let labelFrame = 0;
    function scheduleLabels() {
      if (labelFrame) return;
      labelFrame = requestAnimationFrame(() => {
        labelFrame = 0;
        if (!viewport.clientWidth) return;
        const obstacles = [goalBadge, ...[...records.values()].map(record => record.button)].map(button => button.getBoundingClientRect());
        const accepted = [], bounds = canvas.getBoundingClientRect();
        const intersects = (a, b) => a.left < b.right + 4 && a.right > b.left - 4 && a.top < b.bottom + 4 && a.bottom > b.top - 4;
        for (const label of edges.querySelectorAll('.graph-edge-label')) {
          const rect = label.getBoundingClientRect(), line = label.previousElementSibling;
          const textPath = label.querySelector('textPath'), track = document.getElementById(textPath?.getAttribute('href')?.slice(1));
          const hidden = scale < .65 || track && label.getComputedTextLength() > track.getTotalLength() - 8 || rect.left < bounds.left || rect.right > bounds.right || rect.top < bounds.top || rect.bottom > bounds.bottom ||
            obstacles.some(box => intersects(rect, box)) || accepted.some(box => intersects(rect, box));
          label.style.visibility = hidden ? 'hidden' : 'visible';
          label.setAttribute('aria-hidden', String(hidden));
          if (label.dataset.selectionId) {
            label.setAttribute('tabindex', hidden ? '-1' : '0');
            line.setAttribute('tabindex', hidden ? '0' : '-1');
            if (hidden && document.activeElement === label) line.focus({ preventScroll: true });
          }
          if (!hidden) accepted.push(rect);
        }
      });
    }
    new ResizeObserver(scheduleLabels).observe(viewport);
    const positionKey = id => id;
    function closeDetail() {
      detailOpen = false; detail.hidden = true;
      onDetail?.(null, false);
      const control = records.get(selected)?.button || [...edges.children].find(n => n.getAttribute('tabindex') === '0' && n.dataset.selectionId === selected);
      control?.focus({ preventScroll: true });
    }
    detail.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); closeDetail(); } });
    function attachDrag(button, id) {
      button.addEventListener('pointerdown', event => {
        if (event.button !== 0 || !event.isPrimary) return;
        suppressClick = ''; const p = positions.get(id); if (!p) return;
        drag = { id, pointer: event.pointerId, x: event.clientX, y: event.clientY, start: { ...p }, moved: false };
        button.setPointerCapture(event.pointerId);
      });
      button.addEventListener('pointermove', event => {
        if (!drag || drag.id !== id || drag.pointer !== event.pointerId) return;
        const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
        if (!drag.moved && Math.hypot(dx, dy) < 4) return;
        drag.moved = true; button.classList.add('is-dragging');
        manualPositions.set(positionKey(id), { x: Math.max(8, Math.min(graphWidth - NODE_WIDTH - 8, drag.start.x + dx / scale)), y: Math.max(8, Math.min(graphHeight - NODE_HEIGHT - 8, drag.start.y + dy / scale)) });
        if (!dragFrame) dragFrame = requestAnimationFrame(() => { dragFrame = 0; render(lastSnapshot); });
      });
      const finish = event => {
        if (!drag || drag.id !== id || drag.pointer !== event.pointerId) return;
        if (drag.moved) suppressClick = id;
        drag = null; button.classList.remove('is-dragging');
        if (button.hasPointerCapture(event.pointerId)) button.releasePointerCapture(event.pointerId);
      };
      button.addEventListener('pointerup', finish); button.addEventListener('pointercancel', finish); button.addEventListener('lostpointercapture', finish);
    }
    function zoom(value) {
      const x = (viewport.scrollLeft + viewport.clientWidth / 2) / scale, y = (viewport.scrollTop + viewport.clientHeight / 2) / scale;
      scale = Math.max(.25, Math.min(1.5, value)); canvas.style.zoom = String(scale);
      for (const hit of edges.querySelectorAll('.graph-edge-hit')) hit.style.strokeWidth = String(14 / scale);
      put(zoomLabel, Math.round(scale * 100) + '%'); minus.disabled = scale <= .25; plus.disabled = scale >= 1.5;
      viewport.scrollLeft = x * scale - viewport.clientWidth / 2; viewport.scrollTop = y * scale - viewport.clientHeight / 2;
      scheduleLabels();
    }
    minus.addEventListener('click', () => zoom(scale - .15)); plus.addEventListener('click', () => zoom(scale + .15));
    fit.addEventListener('click', () => { manualPositions.clear(); render(lastSnapshot); resetPan(); zoom(Math.min(1, (viewport.clientWidth - 16) / graphWidth, (viewport.clientHeight - 16) / graphHeight)); viewport.scrollLeft = viewport.scrollTop = 0; });
    const title = n => n.kind === 'root' ? n.goal || '目标' : n.intent?.description || factText(n.fact?.content) || '共享事实';
    const state = n => n.kind === 'root' ? '目标' : n.kind === 'intent' ? '意图 · ' + statusText(n.intent?.status) : '事实';
    function select(id, reveal = false, open = true) {
      if (reveal) resetPan();
      if (open) detailOpen = true;
      selected = id;
      for (const [key, record] of records) record.button.setAttribute('aria-pressed', String(key === selected));
      for (const edge of edges.children) edge.classList.toggle('is-selected', edge.dataset.intentId === selected || edge.dataset.source === selected || edge.dataset.target === selected);
      const n = nodes.find(n => n.id === selected); detail.hidden = !!onDetail || !n || !detailOpen;
      if (!n) { if (detailOpen) onDetail?.(null, false); return; }
      const heading = el('h3', '', title(n)), meta = el('p', 'graph-detail-meta', `${state(n)} · ${n.sourceId || n.id}${n.producerId ? ' · 执行产出' : ''}`);
      const close = el('button', 'graph-detail-close', '×'); close.type = 'button'; close.setAttribute('aria-label', '关闭节点详情'); close.addEventListener('click', closeDetail);
      const content = [close, heading, meta];
      if (n.resultId) {
        const result = el('button', 'graph-result-link', '查看产出事实 →'); result.type = 'button'; result.addEventListener('click', () => select(n.resultId, true)); content.push(result);
      }
      for (const [label, value] of [['执行提示', n.intent?.hint], ['关注点', n.intent?.keyPoints?.join('\n')], ['证据 / 结果', factText(n.fact?.content)], ['最近执行错误', n.attempts?.at(-1)?.error]]) {
        if (value) content.push(el('h4', '', label), el('p', 'graph-detail-text', typeof value === 'string' ? value : JSON.stringify(value)));
      }
      const parents = (n.parentIds || []).map(id => nodes.find(n => n.id === id)).filter(Boolean);
      if (parents.length) {
        const links = el('div', 'graph-parent-links'); links.append(el('span', '', '来源'));
        for (const parent of parents) { const link = el('button', '', title(parent)); link.type = 'button'; link.addEventListener('click', () => select(parent.id, true)); links.append(link); }
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
        onDetail({ id: n.id, title: title(n), meta: meta.textContent, sections,
          links: [...(n.resultId ? [{ id: n.resultId, label: '查看产出事实 →' }] : []), ...parents.map(parent => ({ id: parent.id, label: '来源 · ' + title(parent) }))] }, open);
      }
      if (detail.dataset.key !== key) { detail.replaceChildren(...content); detail.dataset.key = key; }
      if (reveal) { const p = positions.get(id); if (p) { viewport.scrollLeft = Math.max(0, p.x * scale - 24); viewport.scrollTop = Math.max(0, p.y * scale - 24); records.get(id)?.button.focus({ preventScroll: true }); } }
    }
    attachDrag(goalBadge, goalPositionId);
    goalBadge.addEventListener('click', event => {
      if (suppressClick === goalPositionId && event.detail !== 0) { suppressClick = ''; return; }
      select(rootId);
    });
    function render(snapshot) {
      lastSnapshot = snapshot;
      snapshot = window.projectExplorationGraph(snapshot);
      const nextSession = snapshot?.sessionId || '';
      if (session !== nextSession) { session = nextSession; selected = ''; detailOpen = false; manualPositions.clear(); drag = null; panGesture = null; viewport.classList.remove('is-panning'); resetPan(); zoom(1); viewport.scrollLeft = viewport.scrollTop = 0; }
      nodes = [...new Map((snapshot?.nodes || []).filter(n => n && typeof n.id === 'string').map(n => [n.id, n.kind === 'root' ? { ...n, goal: snapshot.goal } : n])).values()];
      rootId = snapshot?.rootId || nodes.find(n => n.kind === 'root')?.id;
      put(goalTitle, snapshot?.goal || '目标尚未设置');
      goalBadge.title = snapshot?.goal || '目标尚未设置';
      goalBadge.setAttribute('aria-label', '最终目标：' + goalBadge.title);
        controls.hidden = viewport.hidden = !nodes.length;
      fit.disabled = !nodes.length;
      const graphNodes = snapshot.graphNodes, allById = new Map(nodes.map(n => [n.id, n]));
      const byId = new Map(graphNodes.map(n => [n.id, n])), ranks = new Map(), remaining = new Set(byId.keys());
      // Longest-parent layering preserves joins. Invalid/cyclic snapshots still render safely.
      while (remaining.size) {
        let advanced = false;
        for (const id of remaining) {
          const parents = (byId.get(id).parentIds || []).filter(p => byId.has(p));
          if (parents.every(p => ranks.has(p))) { ranks.set(id, parents.length ? Math.max(...parents.map(p => ranks.get(p))) + 1 : 0); remaining.delete(id); advanced = true; }
        }
        if (!advanced) { for (const id of remaining) ranks.set(id, 0); break; }
      }
      const layers = new Map();
      for (const n of graphNodes) { const rank = ranks.get(n.id); if (!layers.has(rank)) layers.set(rank, []); layers.get(rank).push(n); }
      positions = new Map(); let widest = 1;
      for (const layer of layers.values()) widest = Math.max(widest, layer.length);
      const vertical = true;
      // Center layers and order siblings by their parents to clarify forks and joins.
      const breadth = Math.max(400, vertical ? viewport.clientWidth : viewport.clientHeight, widest * COLUMN_STEP + 64), cross = new Map();
      for (const [rank, layer] of [...layers].sort((a, b) => a[0] - b[0])) {
        const center = n => {
          const sources = (n.parentIds || []).map(id => cross.get(id)).filter(Number.isFinite);
          return sources.length ? sources.reduce((a, b) => a + b, 0) / sources.length : breadth / 2;
        };
        layer.sort((a, b) => center(a) - center(b));
        const start = (breadth - (layer.length - 1) * COLUMN_STEP) / 2;
        layer.forEach((n, i) => {
          const c = start + i * COLUMN_STEP; cross.set(n.id, c);
          positions.set(n.id, { x: c - NODE_WIDTH / 2, y: 36 + rank * ROW_STEP });
        });
      }
      const depth = Math.max(0, ...ranks.values()) + 1;
      const goalPosition = manualPositions.get(goalPositionId) || { x: breadth / 2 - NODE_WIDTH / 2, y: 36 + depth * ROW_STEP };
      positions.set(goalPositionId, goalPosition);
      goalBadge.style.left = goalPosition.x + 'px'; goalBadge.style.top = goalPosition.y + 'px';
      for (const n of graphNodes) { const manual = manualPositions.get(positionKey(n.id)); if (manual) positions.set(n.id, manual); }
      const width = Math.max(viewport.clientWidth / scale, breadth), height = Math.max(viewport.clientHeight / scale, (depth + 1) * ROW_STEP + 16);
      graphWidth = width; graphHeight = height;
      canvas.style.width = width + 'px'; canvas.style.height = height + 'px'; edges.setAttribute('width', width); edges.setAttribute('height', height);
      edges.style.width = width + 'px'; edges.style.height = height + 'px';
      const paths = document.createDocumentFragment();
      let edgeSequence = 0;
      for (const n of graphNodes) {
        const p = positions.get(n.id);
        for (const edge of snapshot.edges.filter(e => e.target === n.id)) {
          const parent = edge.source;
          const from = positions.get(parent); if (!from) continue;
          const line = document.createElementNS('http://www.w3.org/2000/svg', 'path');
          line.dataset.source = parent; line.dataset.target = n.id;
          line.dataset.kind = edge.intentId ? 'explores' : 'derives'; line.dataset.status = edge.status || '';
          if (edge.intentId) line.dataset.intentId = edge.intentId;
          const bypass = vertical && ranks.get(n.id) - ranks.get(parent) > 1;
          const parentHeight = byId.get(parent).kind === 'root' ? 48 : NODE_HEIGHT;
          const parentWidth = byId.get(parent).kind === 'root' ? 88 : NODE_WIDTH;
          const targetHeight = n.kind === 'frontier' ? 32 : NODE_HEIGHT;
          const targetWidth = n.kind === 'frontier' ? 32 : NODE_WIDTH;
          const x1 = from.x + NODE_WIDTH / 2 + (bypass ? parentWidth / 2 : 0), y1 = from.y + NODE_HEIGHT / 2 + (bypass ? 0 : parentHeight / 2);
          const x2 = p.x + NODE_WIDTH / 2 + (bypass ? targetWidth / 2 : 0), y2 = p.y + NODE_HEIGHT / 2 - (bypass ? 0 : targetHeight / 2);
          const lane = Math.max(x1, x2) + 24;
          const angle = bypass ? Math.PI : Math.atan2(y2 - y1, x2 - x1);
          const route = bypass ? `M${x1},${y1} C${lane},${y1} ${lane},${y2} ${x2},${y2}` : `M${x1},${y1} L${x2},${y2}`;
          line.setAttribute('d', `${route} M${x2 - 6 * Math.cos(angle - .5)},${y2 - 6 * Math.sin(angle - .5)} L${x2},${y2} L${x2 - 6 * Math.cos(angle + .5)},${y2 - 6 * Math.sin(angle + .5)}`);
          const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
          label.classList.add('graph-edge-label'); label.dataset.source = parent; label.dataset.target = n.id; label.dataset.status = edge.status || '';
          const edgeTitle = edge.intentId ? `${edge.description} · ${statusText(edge.status)}` : '提供依据';
          const tooltip = document.createElementNS('http://www.w3.org/2000/svg', 'title'); tooltip.textContent = edgeTitle; line.append(tooltip);
          const definitions = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
          const track = document.createElementNS('http://www.w3.org/2000/svg', 'path');
          track.id = `graph-${graphId}-edge-${++edgeSequence}`;
          const reverse = x2 < x1 || x2 === x1 && y2 < y1;
          track.setAttribute('d', reverse ? bypass ? `M${x2},${y2} C${lane},${y2} ${lane},${y1} ${x1},${y1}` : `M${x2},${y2} L${x1},${y1}` : route);
          definitions.append(track);
          const textPath = document.createElementNS('http://www.w3.org/2000/svg', 'textPath');
          textPath.setAttribute('href', '#' + track.id); textPath.setAttribute('startOffset', '50%');
          textPath.textContent = edgeTitle.length > 26 ? edgeTitle.slice(0, 25) + '…' : edgeTitle;
          label.append(textPath);
          const selectionId = edge.intentId || n.id;
          const hit = document.createElementNS('http://www.w3.org/2000/svg', 'path');
          hit.classList.add('graph-edge-hit'); hit.setAttribute('d', route);
          hit.style.strokeWidth = String(14 / scale);
          hit.setAttribute('aria-hidden', 'true');
          label.dataset.selectionId = line.dataset.selectionId = hit.dataset.selectionId = selectionId;
          if (edge.intentId) label.dataset.intentId = edge.intentId;
          {
            for (const element of [hit, line, label]) {
              element.setAttribute('role', 'button'); element.setAttribute('tabindex', element === label ? '0' : '-1'); element.setAttribute('aria-label', edgeTitle);
              element.addEventListener('click', () => select(selectionId));
              element.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); select(selectionId); } });
            }
          }
          label.setAttribute('text-anchor', 'middle'); label.setAttribute('dy', '-5');
          paths.append(definitions, hit, line, label);
        }
        let record = records.get(n.id);
        if (!record) {
          const button = el('button', n.kind === 'frontier' ? 'graph-frontier' : 'graph-node'); button.type = 'button'; button.dataset.nodeId = n.id;
          const badge = el('span', 'graph-node-state'), name = el('strong', 'graph-node-title'), info = el('small', 'graph-node-info'); button.append(badge, name, info);
          button.addEventListener('click', event => { if (suppressClick === n.id && event.detail !== 0) { suppressClick = ''; return; } select(n.intentId || n.id); });
          attachDrag(button, n.id); record = { button, badge, name, info }; records.set(n.id, record); canvas.append(button);
        }
        record.button.style.left = p.x + 'px'; record.button.style.top = p.y + 'px';
        record.button.dataset.status = n.status || n.kind; record.button.dataset.kind = n.kind; record.button.title = n.kind === 'frontier' ? '尚未产出事实 · ' + statusText(n.status) : title(n);
        record.button.setAttribute('aria-label', n.kind === 'frontier' ? `尚未产出事实：${allById.get(n.intentId)?.intent?.description || ''}` : state(n) + '：' + title(n));
        put(record.badge, state(n)); put(record.name, n.kind === 'frontier' ? '?' : n.kind === 'root' ? '起点' : title(n));
        put(record.info, n.kind === 'root' ? '探索目标 · 非已证实事实' : n.kind === 'intent' ? `${(n.parentIds || []).length} 个来源 · ${n.resultId ? '已产出事实' : '尚无产出事实'}${n.attempts?.length ? ` · ${n.attempts.length} 次执行` : ''}` : n.producerId ? '由意图执行产出' : `${(n.parentIds || []).length} 个来源 · 共享事实`);
      }
      edges.replaceChildren(paths);
      for (const [id, record] of records) if (!byId.has(id)) { record.button.remove(); records.delete(id); }
      select(allById.has(selected) ? selected : rootId, false, false);
      scheduleLabels();
    }
    return { update: render, select: id => select(id, true), closeDetail };
  };
})();
