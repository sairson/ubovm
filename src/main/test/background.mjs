import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { installBackgroundMode } from '../background.mjs';

function fixture(options = {}) {
  const app = new EventEmitter();
  let tray;
  const dialogs = [];
  class Tray extends EventEmitter {
    constructor() { super(); tray = this; }
    setToolTip(value) { if (options.tooltipFails) throw Error('tooltip failed'); this.tooltip = value; }
    setContextMenu(value) {
      if (options.menuFails) throw Error('menu failed');
      this.menu = value; this.menuUpdates = (this.menuUpdates ?? 0) + 1;
    }
    displayBalloon(value) {
      if (options.notificationFails) throw new Error('Notifications unavailable');
      (this.balloons ??= []).push(value);
    }
    removeBalloon() { if (options.dismissFails) throw Error('dismiss failed'); this.balloonRemoved = true; }
    isDestroyed() { return !!this.destroyed; }
    destroy() { if (options.destroyFails) throw Error('destroy failed'); this.destroyed = true; }
  }
  app.quit = () => { app.quitCalled = true; };
  installBackgroundMode({ app, Tray, Menu: { buildFromTemplate: value => value },
    dialog: { async showMessageBox(win, config) { dialogs.push(config); return { response: options.choose ? await options.choose(win, config) : options.choice ?? 1 }; } },
    nativeImage: { createFromPath: () => ({ isEmpty: () => !!options.missingIcon }) },
    icon: 'icon.ico', platform: options.platform ?? 'win32', log: { error() {}, warn() {} } });
  function window({ url = 'vscode-file://vscode-app/workbench.html', throttling = true, loaded = true } = {}) {
    const win = Object.assign(new EventEmitter(), {
      visible: true, minimized: false, destroyed: false,
      webContents: Object.assign(new EventEmitter(), {
        throttling, getURL() { return url; }, isDestroyed() { return false; },
        getBackgroundThrottling() { return this.throttling; },
        setBackgroundThrottling(value) { this.throttling = value; }
      }),
      isDestroyed() { return this.destroyed; }, isMinimized() { return this.minimized; },
      isVisible() { return this.visible; },
      hide() { this.visible = false; this.emit('hide'); }, show() { this.visible = true; this.emit('show'); },
      focus() { this.focusCount = (this.focusCount ?? 0) + 1; this.emit('focus'); },
      minimize() { this.minimized = true; this.emit('minimize'); },
      restore() { this.minimized = false; this.emit('restore'); },
      destroy() { this.destroyed = true; this.emit('closed'); }
    });
    app.emit('browser-window-created', {}, win);
    if (loaded) win.webContents.emit('did-finish-load');
    return win;
  }
  async function close(win, quitting = false) {
    const event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
    win.emit('ubovm-before-close', event, quitting);
    await new Promise(resolve => setImmediate(resolve));
    return event.defaultPrevented;
  }
  return { app, window, close, dialogs, get tray() { return tray; } };
}

test('close choice exits through normal lifecycle or cancels without hiding', async () => {
  for (const choice of [0, 2]) {
    const f = fixture({ choice }); const win = f.window();
    assert.equal(await f.close(win), true);
    assert.equal(win.visible, true);
    assert.equal(Boolean(f.app.quitCalled), choice === 0);
    assert.deepEqual(f.dialogs[0].buttons, ['退出 IDE', '后台运行', '取消']);
    assert.equal(f.dialogs[0].defaultId, 2); assert.equal(f.dialogs[0].cancelId, 2);
    assert.equal(await f.close(win, true), false); assert.equal(f.dialogs.length, 1);
  }
});

test('pending close choice leaves the event loop responsive and suppresses prompts across windows', async () => {
  let answer;
  const options = { choose: () => new Promise(resolve => { answer = resolve; }) };
  const f = fixture(options); const a = f.window(), b = f.window();
  assert.equal(await f.close(a), true);
  let ticked = false;
  await new Promise(resolve => setTimeout(() => { ticked = true; resolve(); }, 5));
  assert(ticked); assert.equal(a.visible, true);
  await f.close(a); await f.close(b);
  assert.equal(f.dialogs.length, 1);
  answer(1); await new Promise(resolve => setImmediate(resolve));
  assert.equal(a.visible, false); assert.equal(b.visible, true);
  options.choose = () => 2;
  await f.close(b); assert.equal(f.dialogs.length, 2); assert.equal(b.visible, true);
});

for (const event of ['before-quit', 'quit', 'session-end', 'destroy']) {
  for (const response of [0, 1]) test(`late close choice ${response} is ignored after ${event}`, async () => {
    let answer;
    const f = fixture({ choose: () => new Promise(resolve => { answer = resolve; }) });
    const win = f.window(); await f.close(win);
    if (event === 'destroy') win.destroy();
    else if (event === 'session-end') win.emit(event);
    else f.app.emit(event);
    assert.equal(f.dialogs[0].signal.aborted, true);
    answer(response); await new Promise(resolve => setImmediate(resolve));
    assert.equal(win.visible, true);
    assert.equal(f.app.quitCalled, undefined);
  });
}

for (const reason of ['quit-veto', 'destroy', 'background', 'quit-requested']) {
  for (const lateFailure of [false, true]) test(`invalidated dialog releases lock immediately: ${reason}, rejection=${lateFailure}`, async () => {
    const pending = [];
    const f = fixture({ choose: () => new Promise((resolve, reject) => pending.push({ resolve, reject })) });
    const a = f.window(), b = f.window();
    await f.close(a);
    if (reason === 'destroy') a.destroy();
    else if (reason === 'background') f.tray.menu.find(item => item.label === '后台运行').click();
    else if (reason === 'quit-requested') assert.equal(await f.close(b, true), false);
    else f.app.emit('before-quit'); // A later save prompt vetoes this quit.
    assert.equal(f.dialogs[0].signal.aborted, true);
    b.show();
    await f.close(b);
    assert.equal(pending.length, 2, 'new prompt must not wait for canceled native completion');
    if (lateFailure) pending[0].reject(Error('late cancellation'));
    else pending[0].resolve(0);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.app.quitCalled, undefined, 'stale choice cannot exit the application');
    await f.close(b);
    assert.equal(pending.length, 2, 'old finally must not unlock the newer prompt');
    assert.equal(f.dialogs[1].signal.aborted, false);
    pending[1].resolve(1);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(b.visible, false);
    f.tray.emit('click'); assert.equal(b.visible, true);
  });
}

test('destroying an unrelated window preserves the active close choice', async () => {
  let answer;
  const f = fixture({ choose: () => new Promise(resolve => { answer = resolve; }) });
  const a = f.window(), b = f.window();
  await f.close(a); b.destroy();
  assert.equal(f.dialogs[0].signal.aborted, false);
  await f.close(a); assert.equal(f.dialogs.length, 1);
  answer(1); await new Promise(resolve => setImmediate(resolve));
  assert.equal(a.visible, false);
});

test('close choice suppresses reentry and recovers after dialog failure', async () => {
  const options = {}; const f = fixture(options); const win = f.window();
  options.choose = async () => { await f.close(win); throw Error('dialog failed'); };
  await f.close(win); assert.equal(f.dialogs.length, 1); assert.equal(win.visible, true);
  options.choose = () => 1;
  await f.close(win); assert.equal(f.dialogs.length, 2); assert.equal(win.visible, false);
});

test('forwarded launch focus restores a hidden or minimized workbench without creating windows', async () => {
  const f = fixture(); const win = f.window();
  await f.close(win); win.focus();
  assert.equal(win.visible, true); assert.equal(win.focusCount, 1);
  win.minimize(); win.focus();
  assert.equal(win.minimized, false); assert.equal(win.focusCount, 2);
  win.destroy(); win.focus(); assert.equal(win.focusCount, 2);
});

test('close preserves windows and background execution; tray restores multiple windows', async () => {
  const f = fixture(); const a = f.window(); const b = f.window();
  assert.equal(await f.close(a), true); assert.equal(await f.close(b), true);
  assert.equal(a.visible, false); assert.equal(a.webContents.throttling, false);
  b.minimized = true;
  f.tray.emit('double-click');
  assert.equal(a.visible, true); assert.equal(b.visible, true); assert.equal(b.minimized, false);
});

test('explicit quit restores windows for prompts, permits shutdown and survives a veto', async () => {
  const f = fixture(); const win = f.window(); await f.close(win);
  f.tray.menu.at(-1).click();
  assert.equal(f.app.quitCalled, true); assert.equal(win.visible, true);
  assert.equal(await f.close(win, true), false);
  // Code OSS resets quitRequested when a save prompt vetoes shutdown.
  assert.equal(await f.close(win, false), true);
  f.app.emit('before-quit'); assert.equal(win.visible, true);
  f.app.emit('quit'); assert.equal(f.tray.destroyed, true);
});

test('session end bypasses choice and missing tray keeps the window reachable', async () => {
  const f = fixture(); const win = f.window(); win.emit('session-end');
  assert.equal(await f.close(win), false);
  const missing = fixture({ missingIcon: true });
  const visible = missing.window();
  assert.equal(await missing.close(visible), true); assert.equal(visible.visible, true);
  const exit = fixture({ missingIcon: true, choice: 0 });
  await exit.close(exit.window()); assert.equal(exit.app.quitCalled, true);
});

test('non-Windows lifecycle remains unchanged', async () => {
  const f = fixture({ platform: 'darwin' });
  assert.equal(await f.close(f.window()), false); assert.equal(f.tray, undefined);
});

test('first minimize disables throttling; foreground restores the original policy', async () => {
  const f = fixture(); const win = f.window();
  win.minimize();
  assert.equal(win.webContents.throttling, false);
  assert.match(f.tray.tooltip, /后台运行中/);
  win.restore();
  assert.equal(win.webContents.throttling, true);
  assert.match(f.tray.tooltip, /后台 0 个/);
  const unthrottled = f.window({ throttling: false });
  await f.close(unthrottled); unthrottled.show();
  assert.equal(unthrottled.webContents.throttling, false);
});

test('one quiet hint per launch after all windows are in background; balloon restores', async () => {
  const f = fixture(); const a = f.window(); const b = f.window(); a.focus();
  await f.close(a); assert.equal(f.tray.balloons, undefined);
  await f.close(b);
  assert.equal(f.tray.balloons.length, 1);
  assert.equal(f.tray.balloons[0].noSound, true);
  assert.equal(f.tray.balloons[0].respectQuietTime, true);
  assert.match(f.tray.balloons[0].content, /退出 IDE/);
  f.tray.emit('balloon-click');
  assert.equal(a.visible, true); assert.equal(b.visible, true);
  assert.equal(a.focusCount, 2); assert.equal(b.focusCount, undefined);
  assert.equal(f.tray.balloonRemoved, true);
  await f.close(a); await f.close(b); assert.equal(f.tray.balloons.length, 1);
});

test('tray menu hides all windows and status follows external restores without redundant rebuilds', async () => {
  const f = fixture(); const a = f.window(); const b = f.window();
  f.tray.menu.find(item => item.label === '后台运行').click();
  assert.equal(a.visible, false); assert.equal(b.visible, false);
  assert.match(f.tray.tooltip, /后台 2 个/);
  assert.equal(f.tray.menu.find(item => item.label === '后台运行').enabled, false);
  a.show(); assert.match(f.tray.tooltip, /后台 1 个/);
  const updates = f.tray.menuUpdates;
  a.emit('show'); assert.equal(f.tray.menuUpdates, updates);
  b.destroy(); assert.match(f.tray.tooltip, /窗口 1 个 · 后台 0 个/);
});

test('DevTools and auxiliary windows do not affect tray counts or focus', async () => {
  const f = fixture(); const main = f.window();
  const devtools = f.window({ url: 'devtools://devtools/bundled/inspector.html' });
  devtools.focus(); devtools.minimize();
  assert.match(f.tray.tooltip, /窗口 1 个/);
  assert.equal(devtools.webContents.throttling, true);
  await f.close(main); f.tray.emit('click');
  assert.equal(main.visible, true); assert.equal(main.focusCount, 1);
  assert.equal(devtools.minimized, true);
});

test('tray recovery failure restores hidden windows; notification failure never blocks closing', async () => {
  const options = {}; const f = fixture(options); const a = f.window(); const b = f.window();
  await f.close(a); f.tray.destroy(); options.missingIcon = true;
  assert.equal(await f.close(b), true); assert.equal(a.visible, true); assert.equal(b.visible, true);
  options.missingIcon = false;
  assert.equal(await f.close(b), true); assert.equal(f.tray.isDestroyed(), false);
  const unavailable = fixture({ notificationFails: true }); const win = unavailable.window();
  assert.equal(await unavailable.close(win), true); assert.equal(win.visible, false);
  unavailable.tray.emit('click'); assert.equal(win.visible, true);
});

test('confirmed system session end allows every window to close without restoring hidden ones', async () => {
  const f = fixture(); const a = f.window(); const b = f.window(); await f.close(a);
  b.emit('session-end');
  f.app.emit('before-quit'); assert.equal(a.visible, false);
  assert.equal(await f.close(a), false); assert.equal(await f.close(b), false);
});

test('minimizing before first load registers once and does not emit a tray-close hint', async () => {
  const f = fixture(); const win = f.window({ loaded: false });
  assert.equal(f.tray, undefined);
  win.minimize();
  assert.equal(win.webContents.throttling, false);
  assert.match(f.tray.tooltip, /窗口 1 个 · 后台 1 个/);
  assert.equal(f.tray.balloons, undefined);
  win.webContents.emit('did-finish-load'); win.emit('ready-to-show');
  assert.match(f.tray.tooltip, /窗口 1 个/);
  win.restore(); assert.equal(win.webContents.throttling, true);
});

test('repeated close and tray restore focus the pending dialog parent', async () => {
  let answer;
  const f = fixture({ choose: () => new Promise(resolve => { answer = resolve; }) });
  const a = f.window(), b = f.window();
  await f.close(a); a.minimize(); b.focus();
  await f.close(b);
  assert.equal(a.minimized, false); assert.equal(a.focusCount, 1);
  assert.equal(f.dialogs.length, 1);
  b.focus(); f.tray.emit('click');
  assert.equal(a.focusCount, 2); assert.equal(b.focusCount, 2);
  answer(2); await new Promise(resolve => setImmediate(resolve));
  b.focus(); f.tray.emit('click'); assert.equal(b.focusCount, 4);
});

test('destroyed tray events and menus cannot affect a replacement tray', async () => {
  const f = fixture(); const a = f.window(); const old = f.tray;
  old.destroy(); await f.close(a);
  assert.notEqual(f.tray, old); assert.equal(a.visible, false);
  for (const event of ['click', 'double-click', 'balloon-click']) old.emit(event);
  for (const item of old.menu) item.click?.();
  assert.equal(a.visible, false); assert.equal(f.app.quitCalled, undefined);
  f.tray.emit('click'); assert.equal(a.visible, true);
  old.menu.find(item => item.label === '后台运行').click();
  assert.equal(a.visible, true);
});

for (const ending of ['session-end', 'quit']) test(`late tray and window events remain inert after ${ending}`, async () => {
  const f = fixture(); const a = f.window(); const old = f.tray;
  await f.close(a);
  if (ending === 'session-end') a.emit(ending); else f.app.emit(ending);
  for (const event of ['click', 'double-click', 'balloon-click']) old.emit(event);
  for (const item of old.menu) item.click?.();
  const b = f.window(); b.emit('ready-to-show');
  assert.equal(a.visible, false); assert.equal(f.app.quitCalled, undefined);
  assert.equal(f.tray, old, 'late workbench registration cannot create another tray');
  assert.equal(await f.close(b), false);
});

test('tray exit cancels a pending dialog before initiating quit', async () => {
  let answer;
  const f = fixture({ choose: () => new Promise(resolve => { answer = resolve; }) });
  const a = f.window(); await f.close(a);
  f.app.quit = () => {
    assert.equal(f.dialogs[0].signal.aborted, true);
    f.app.quitCalled = true;
  };
  f.tray.menu.at(-1).click();
  answer(1); await new Promise(resolve => setImmediate(resolve));
  assert.equal(a.visible, true); assert.equal(f.app.quitCalled, true);
});

for (const failure of ['tooltipFails', 'menuFails']) {
  test(`tray ${failure} during batch hide restores every window and permits retry`, async () => {
    const options = {}; const f = fixture(options);
    const a = f.window(), b = f.window(), c = f.window(); const old = f.tray;
    options[failure] = true;
    assert.doesNotThrow(() => old.menu.find(item => item.label === '后台运行').click());
    for (const win of [a, b, c]) {
      assert.equal(win.visible, true); assert.equal(win.webContents.throttling, true);
    }
    assert.equal(old.destroyed, true);
    assert.equal(old.balloons, undefined);
    options[failure] = false;
    await f.close(a); assert.notEqual(f.tray, old); assert.equal(a.visible, false);
    f.tray.emit('click'); assert.equal(a.visible, true);
  });

  test(`tray ${failure} during creation cannot hide a window without a return path`, async () => {
    const options = { [failure]: true }; const f = fixture(options); const a = f.window();
    await f.close(a); assert.equal(a.visible, true); assert.equal(f.tray.destroyed, true);
    options[failure] = false;
    await f.close(a); assert.equal(a.visible, false);
    f.tray.emit('click'); assert.equal(a.visible, true);
  });
}

test('failed tray disposal still invalidates old callbacks and restores windows', async () => {
  const options = {}; const f = fixture(options); const a = f.window(); const old = f.tray;
  options.menuFails = true; options.destroyFails = true;
  assert.doesNotThrow(() => old.menu.find(item => item.label === '后台运行').click());
  assert.equal(a.visible, true);
  old.menu.at(-1).click(); assert.equal(f.app.quitCalled, undefined);
  options.menuFails = false; options.destroyFails = false;
  await f.close(a); assert.notEqual(f.tray, old);
  old.emit('click'); assert.equal(a.visible, false);
  options.destroyFails = true;
  assert.doesNotThrow(() => f.app.emit('quit'));
  f.tray.emit('click'); assert.equal(a.visible, false);
});

test('notification cleanup failure does not block restore or explicit exit', async () => {
  const f = fixture({ dismissFails: true }); const a = f.window();
  await f.close(a);
  assert.doesNotThrow(() => f.tray.emit('click')); assert.equal(a.visible, true);
  assert.doesNotThrow(() => f.tray.menu.at(-1).click()); assert.equal(f.app.quitCalled, true);
});

test('destroying a window in restore does not call native methods on the destroyed window', async () => {
  const f = fixture(); const a = f.window(); a.minimize();
  a.once('restore', () => a.destroy());
  a.show = () => { throw Error('show called after destruction'); };
  assert.doesNotThrow(() => a.focus());
  assert.equal(a.focusCount, undefined);
});
