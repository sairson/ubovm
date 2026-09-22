(() => {
  window.createOverviewSplit = ({ initialWidth = 300, initialLayout, onWidthChange, onLayoutChange }) => {
    const columns = document.querySelector('.goal-overview-columns');
    const handle = document.getElementById('goal-overview-split');
    let preferred = Number.isFinite(initialWidth) ? Math.max(240, Math.min(800, initialWidth)) : 300;
    let width = preferred, maximum = 800, drag;
    const panels = { log: columns.querySelector('[data-overview-panel="log"]'), workers: columns.querySelector('[data-overview-panel="workers"]') };
    const visible = { log: initialLayout?.log !== false, workers: initialLayout?.workers !== false };
    let swapped = initialLayout?.swapped === true, moving;
    let focusLayout;
    const focusButtons = new Map();
    const toggles = [...document.querySelectorAll('[data-overview-toggle]')];
    function restoreFocus() {
      if (!focusLayout) return;
      Object.assign(visible, focusLayout); focusLayout = undefined;
    }
    for (const [name, panel] of Object.entries(panels)) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'goal-panel-focus';
      button.dataset.overviewFocus = name;
      panel.querySelector('[data-overview-close]').before(button); focusButtons.set(name, button);
      button.addEventListener('click', () => {
        if (focusLayout) restoreFocus();
        else { focusLayout = { ...visible }; visible.log = name === 'log'; visible.workers = name === 'workers'; }
        renderPanels(); button.focus();
      });
    }
    const reset = document.createElement('button'); reset.type = 'button'; reset.id = 'goal-panels-reset'; reset.textContent = '恢复默认布局';
    document.querySelector('.goal-panel-controls').append(reset);
    reset.addEventListener('click', () => {
      finish(true); focusLayout = undefined; visible.log = visible.workers = true; swapped = false; preferred = 300;
      renderPanels(true); onWidthChange(300);
    });
    function renderPanels(save = false) {
      finish(true);
      for (const [name, panel] of Object.entries(panels)) panel.hidden = !visible[name];
      for (const button of toggles) button.setAttribute('aria-pressed', String(visible[button.dataset.overviewToggle]));
      for (const [name, button] of focusButtons) {
        const focused = Boolean(focusLayout && visible[name]);
        button.textContent = focused ? '退出专注' : '专注'; button.setAttribute('aria-pressed', String(focused));
        button.setAttribute('aria-label', focused ? '退出面板专注查看' : '专注查看' + (name === 'log' ? '思考日志' : '任务执行'));
      }
      columns.dataset.visible = String(Number(visible.log) + Number(visible.workers));
      columns.dataset.swapped = String(swapped);
      // Move existing nodes so transcript selection, expansion and scroll survive.
      const first = swapped ? panels.workers : panels.log, last = swapped ? panels.log : panels.workers;
      if (columns.firstElementChild !== first) { columns.insertBefore(first, handle); columns.append(last); }
      document.getElementById('goal-panels-empty').hidden = visible.log || visible.workers;
      document.getElementById('goal-panels-swap').disabled = !visible.log || !visible.workers;
      layout();
      if (save) onLayoutChange?.({ ...visible, swapped });
      window.dispatchEvent(new Event('ubovm-overview-visibility'));
    }
    for (const button of toggles) button.addEventListener('click', () => { restoreFocus(); const name = button.dataset.overviewToggle; visible[name] = !visible[name]; renderPanels(true); });
    for (const button of columns.querySelectorAll('[data-overview-close]')) button.addEventListener('click', () => {
      restoreFocus(); const name = button.dataset.overviewClose; visible[name] = false; renderPanels(true);
      toggles.find(toggle => toggle.dataset.overviewToggle === name).focus();
    });
    const swap = () => { if (visible.log && visible.workers) { swapped = !swapped; renderPanels(true); } };
    document.getElementById('goal-panels-swap').addEventListener('click', swap);
    const clearDrop = () => { moving = undefined; for (const panel of Object.values(panels)) panel.classList.remove('goal-panel-drop'); };
    for (const [name, panel] of Object.entries(panels)) {
      const grip = panel.querySelector('.goal-panel-grip');
      grip.addEventListener('dragstart', event => { moving = name; event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', name); });
      grip.addEventListener('dragend', clearDrop);
      grip.addEventListener('keydown', event => { if (event.altKey && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) { event.preventDefault(); swap(); grip.focus(); } });
      panel.addEventListener('dragover', event => { if (moving && moving !== name) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; panel.classList.add('goal-panel-drop'); } });
      panel.addEventListener('dragleave', event => { if (!panel.contains(event.relatedTarget)) panel.classList.remove('goal-panel-drop'); });
      panel.addEventListener('drop', event => { if (moving && moving !== name) { event.preventDefault(); swap(); } clearDrop(); });
    }
    function layout() {
      if (!columns.clientWidth || getComputedStyle(handle).display === 'none') { finish(true); return; }
      maximum = Math.max(240, Math.min(800, columns.clientWidth - 360 - handle.getBoundingClientRect().width));
      width = Math.round(Math.max(240, Math.min(maximum, preferred)));
      columns.style.setProperty('--goal-worker-width', width + 'px');
      handle.setAttribute('aria-valuemin', '240');
      handle.setAttribute('aria-valuemax', String(maximum));
      handle.setAttribute('aria-valuenow', String(width));
      handle.setAttribute('aria-valuetext', '任务执行面板 ' + width + ' 像素');
    }
    function change(value, save = false) {
      preferred = Math.max(240, Math.min(maximum, value)); layout();
      if (save) onWidthChange(preferred);
    }
    function finish(cancel = false) {
      if (!drag) return;
      const previous = drag; drag = undefined;
      document.body.classList.remove('goal-overview-resizing');
      if (cancel) { preferred = previous.preferred; layout(); } else onWidthChange(preferred);
      if (handle.hasPointerCapture(previous.id)) handle.releasePointerCapture(previous.id);
    }
    handle.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      event.preventDefault(); handle.focus();
      drag = { id: event.pointerId, x: event.clientX, width, preferred };
      handle.setPointerCapture(event.pointerId);
      document.body.classList.add('goal-overview-resizing');
    });
    handle.addEventListener('pointermove', event => { if (drag?.id === event.pointerId) change(drag.width + (drag.x - event.clientX) * (swapped ? -1 : 1)); });
    handle.addEventListener('pointerup', event => { if (drag?.id === event.pointerId) finish(); });
    handle.addEventListener('pointercancel', () => finish(true));
    handle.addEventListener('lostpointercapture', () => finish());
    handle.addEventListener('dblclick', () => change(300, true));
    handle.addEventListener('keydown', event => {
      if (event.key === 'Escape' && drag) { event.preventDefault(); event.stopPropagation(); finish(true); return; }
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      change(event.key === 'Home' ? 240 : event.key === 'End' ? maximum : width + (event.key === 'ArrowLeft' ? 1 : -1) * (swapped ? -1 : 1) * (event.shiftKey ? 40 : 10), true);
    });
    window.addEventListener('blur', () => finish(true));
    const observer = new ResizeObserver(layout); observer.observe(columns);
    window.addEventListener('pagehide', () => { finish(true); observer.disconnect(); }, { once: true });
    renderPanels();
  };
})();
