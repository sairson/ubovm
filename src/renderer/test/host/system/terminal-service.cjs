'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { setImmediate: nextTurn } = require('node:timers/promises');
const { createTerminalService } = require('../../../host/system/terminal-service.cjs');

test('terminal disposal continues after failures and a reentrant dispose is harmless', t => {
  const f = fixture(t); const registrations = f.service.register();
  t.after(() => registrations.forEach(registration => registration.dispose()));
  const first = f.service.open('local'), second = f.service.open('local'), last = f.service.open('local');
  let attempts = 0;
  first.dispose = () => { attempts++; f.service.dispose(); throw Error('first failure'); };
  second.dispose = () => { attempts++; throw Error('second failure'); };
  assert.throws(() => f.service.dispose(), error => {
    assert(error instanceof AggregateError);
    assert.deepEqual(error.errors.map(item => item.message), ['first failure', 'second failure']);
    return true;
  });
  assert.equal(last.disposed, true); assert.equal(attempts, 2);
  assert.doesNotThrow(() => f.service.dispose());
  assert.equal(attempts, 2);
  assert.throws(() => f.service.open('local'), /已关闭/);
  const unrelated = f.vscode.window.createTerminal({ name: '当前系统终端', shellPath: f.vscode.env.shell });
  f.service.dispose(); assert.equal(unrelated.disposed, false);
});

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

class VSCodeEventEmitter {
  #listeners = new Set();
  event = (listener, thisArg) => {
    const call = thisArg ? listener.bind(thisArg) : listener;
    this.#listeners.add(call);
    return { dispose: () => this.#listeners.delete(call) };
  };
  fire(value) { for (const listener of [...this.#listeners]) listener(value); }
  dispose() { this.#listeners.clear(); }
}

const development = { id: 'development', name: '开发机', host: '192.0.2.10', username: 'developer', known_hosts_file: '~/.ssh/known_hosts' };
const production = { id: 'production', name: '服务器', host: '192.0.2.20', username: 'operator', password: 'hydrated-password', known_hosts_file: '~/.ssh/known_hosts' };

function fixture(t, overrides = {}) {
  const terminals = [], connections = [], profiles = new Map(), messages = [], picks = [];
  const terminalOpened = new VSCodeEventEmitter(), terminalClosed = new VSCodeEventEmitter(), terminalChanged = new VSCodeEventEmitter();
  let configurationReads = 0, sshLoads = 0, settingsOpened = 0;
  const config = overrides.config ?? { profiles: [development, production], defaultId: 'production' };
  const vscode = {
    EventEmitter: VSCodeEventEmitter,
    ThemeIcon: class { constructor(id) { this.id = id; } },
    TerminalProfile: class { constructor(options) { this.options = options; } },
    TerminalLocation: { Panel: 1 },
    env: { shell: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' },
    workspace: { isTrusted: true, workspaceFolders: [{ uri: { scheme: 'file', fsPath: 'C:\\workspace' } }] },
    window: {
      onDidOpenTerminal: terminalOpened.event,
      onDidCloseTerminal: terminalClosed.event,
      onDidChangeActiveTerminal: terminalChanged.event,
      createTerminal(options) {
        const terminal = { options, creationOptions: options, shown: false, disposed: false,
          show(preserveFocus) {
            if (this.disposed) throw new Error('Terminal has already been disposed');
            this.preserveFocus = preserveFocus; this.shown = true;
            vscode.window.activeTerminal = this; terminalChanged.fire(this);
          },
          dispose() {
            this.disposed = true; options.pty?.close();
            if (overrides.deferClose) setImmediate(() => terminalClosed.fire(this));
            else terminalClosed.fire(this);
          }
        };
        terminals.push(terminal);
        terminalOpened.fire(terminal);
        return terminal;
      },
      registerTerminalProfileProvider(id, provider) {
        profiles.set(id, provider);
        return { dispose: () => profiles.delete(id) };
      },
      async showQuickPick(items, options) {
        const resolved = await items;
        picks.push({ items: resolved, options });
        return overrides.pick?.(resolved);
      },
      async showWarningMessage(message, ...actions) { messages.push({ message, actions }); return overrides.messageChoice; },
      async showErrorMessage(message, ...actions) { messages.push({ message, actions }); return overrides.messageChoice; },
      async showInformationMessage(message, ...actions) { messages.push({ message, actions }); return overrides.messageChoice; }
    }
  };
  class SSHCommands {
    constructor(profile) {
      this.profile = profile;
      this.calls = [];
      this.closed = 0;
      const stream = new EventEmitter();
      stream.stderr = new EventEmitter();
      this.session = { stream, written: [], resized: [], closed: 0,
        write(data) { this.written.push(data); return true; },
        resize(columns, rows) { this.resized.push({ columns, rows }); },
        close() { this.closed++; }
      };
      connections.push(this);
    }
    async openInteractive(options) {
      this.calls.push(options);
      if (overrides.connect) return overrides.connect(this, options);
      return this.session;
    }
    async close() { this.closed++; }
  }
  const service = createTerminalService(vscode, {
    async readConfiguration() { configurationReads++; return overrides.read ? overrides.read() : config; },
    async loadSSH() { sshLoads++; return { SSHCommands }; },
    async openSettings() { settingsOpened++; }
  });
  t.after(() => service.dispose());
  return { service, vscode, terminals, connections, profiles, messages, picks,
    configurationReads: () => configurationReads,
    sshLoads: () => sshLoads,
    settingsOpened: () => settingsOpened
  };
}

async function eventually(predicate, message) {
  for (let attempt = 0; attempt < 20; attempt++) {
    if (predicate()) return;
    await nextTurn();
  }
  assert.fail(message);
}

function observe(terminal) {
  const pty = terminal.options.pty, output = [], exits = [], names = [];
  assert(pty, 'SSH must use an interactive pseudoterminal');
  pty.onDidWrite(data => output.push(data));
  pty.onDidClose(code => exits.push(code));
  pty.onDidChangeName(name => names.push(name));
  return { pty, output, exits, names };
}

test('a failing cancellation subscription cannot strand an active SSH transport', async t => {
  const f = fixture(t);
  f.service.register();
  let disposals = 0;
  const token = { isCancellationRequested: false, onCancellationRequested() {
    return { dispose() { disposals++; throw Error('subscription cleanup failed'); } };
  } };
  const profile = f.profiles.get('ubovm.ssh').provideTerminalProfile(token);
  const terminal = f.vscode.window.createTerminal(profile.options);
  const observed = observe(terminal);
  assert.doesNotThrow(() => observed.pty.open());
  await eventually(() => f.connections[0]?.session.stream.listenerCount('data') > 0, 'SSH should connect');
  assert.doesNotThrow(() => observed.pty.close());
  await nextTurn();
  assert.equal(f.connections[0].closed, 1);
  assert.equal(f.connections[0].session.closed, 1);
  assert.equal(f.connections[0].calls[0].signal.aborted, true);
  assert.equal(f.connections[0].session.stream.listenerCount('data'), 0);
  assert.equal(disposals, 1, 'subscription is released only once');
});

test('registration is passive and default terminal operations use the local shell', t => {
  const f = fixture(t, { read() { throw new Error('Default local terminal must not read SSH settings'); } });
  f.service.register();
  assert.equal(f.terminals.length, 0);
  const terminal = f.service.open();
  assert.equal(terminal.options.shellPath, f.vscode.env.shell);
  assert.equal(terminal.options.pty, undefined);
  assert.equal(f.service.switchTo(), terminal);
  assert.equal(f.terminals.length, 1);
  assert.equal(f.configurationReads(), 0);
  assert.equal(f.sshLoads(), 0);
});

test('switching destinations reuses live terminals without closing either process', async t => {
  const f = fixture(t);
  f.service.register();
  const ssh = f.service.switchTo('ssh');
  ssh.options.pty.open();
  await eventually(() => f.connections[0]?.session.stream.listenerCount('data') > 0, 'SSH should connect');
  const local = f.service.switchTo('local');
  for (let i = 0; i < 5; i++) {
    assert.equal(f.service.switchTo('ssh'), ssh);
    assert.equal(f.service.switchTo('local'), local);
  }
  assert.equal(f.terminals.length, 2);
  assert.equal(f.connections.length, 1);
  assert.equal(f.connections[0].session.closed, 0);
  assert.equal(ssh.disposed, false);
  assert.equal(local.disposed, false);
});

test('switching remembers the most recently focused SSH connection', t => {
  const f = fixture(t);
  f.service.register();
  const first = f.service.open('ssh', 'development');
  const second = f.service.open('ssh', 'production');
  first.show();
  f.service.switchTo('local');
  assert.equal(f.service.switchTo('ssh'), first);
  first.dispose();
  assert.equal(f.service.switchTo('ssh'), second);
});

test('closed and exited terminals are replaced, including SSH before native close delivery', async t => {
  const f = fixture(t);
  f.service.register();
  const ssh = f.service.switchTo('ssh');
  ssh.options.pty.open();
  await eventually(() => f.connections[0]?.session.stream.listenerCount('close') > 0, 'SSH should connect');
  f.connections[0].session.stream.emit('close', 0);
  assert.notEqual(f.service.switchTo('ssh'), ssh);
  const local = f.service.switchTo('local');
  local.exitStatus = { code: 0 };
  const replacement = f.service.switchTo('local');
  assert.notEqual(replacement, local);
  replacement.dispose();
  assert.notEqual(f.service.switchTo('local'), replacement);
});

test('switching skips a disposed local shell before its close event arrives', async t => {
  const f = fixture(t, { deferClose: true });
  f.service.register();
  const first = f.service.open();
  first.dispose();
  const replacement = f.service.switchTo();
  assert.notEqual(replacement, first);
  assert.equal(replacement.disposed, false);
  assert.equal(f.service.switchTo(), replacement);
  await nextTurn();
  assert.equal(f.service.switchTo(), replacement, 'late close must not remove the new shell');
  assert.equal(f.terminals.length, 2);
});

test('terminal show failures other than disposal do not silently create another shell', t => {
  const f = fixture(t);
  const terminal = f.service.open();
  terminal.show = () => { throw new Error('transport unavailable'); };
  assert.throws(() => f.service.switchTo(), /transport unavailable/);
  assert.equal(f.terminals.length, 1);
});

test('native profiles participate in switching without reading SSH settings for local shells', async t => {
  const f = fixture(t);
  f.service.register();
  for (const target of ['local', 'ssh']) {
    const profile = await f.profiles.get('ubovm.' + target).provideTerminalProfile({ isCancellationRequested: false, onCancellationRequested: new VSCodeEventEmitter().event });
    const terminal = f.vscode.window.createTerminal(profile.options);
    assert.equal(f.service.switchTo(target), terminal);
  }
  assert.equal(f.configurationReads(), 0);
  assert.equal(f.sshLoads(), 0);
  assert.equal(f.terminals.length, 2);
  f.vscode.workspace.isTrusted = false;
  assert.throws(() => f.service.switchTo('local'), /信任/);
});

test('explicit SSH starts only when the terminal opens and uses the hydrated default profile', async t => {
  const f = fixture(t);
  const terminal = await f.service.open('ssh');
  const observed = observe(terminal);
  assert.equal(terminal.shown, true);
  assert.equal(f.configurationReads(), 0);
  assert.equal(f.sshLoads(), 0);
  observed.pty.open({ columns: 132, rows: 41 });
  await eventually(() => f.connections[0]?.calls.length === 1, 'opening the PTY should connect');
  const connection = f.connections[0];
  assert.deepEqual(connection.profile, production);
  assert.equal(connection.calls[0].columns, 132);
  assert.equal(connection.calls[0].rows, 41);
  assert(connection.calls[0].signal instanceof AbortSignal);
  assert(observed.names.some(name => name.includes('服务器') || name.includes('192.0.2.20')));
  assert(!observed.output.join('').includes('hydrated-password'));
  observed.pty.open({ columns: 80, rows: 24 });
  await nextTurn();
  assert.equal(connection.calls.length, 1, 'duplicate PTY open must not create a second shell');
});

test('an explicit SSH profile overrides the saved default', async t => {
  const f = fixture(t), terminal = await f.service.open('ssh', 'development');
  terminal.options.pty.open({ columns: 80, rows: 24 });
  await eventually(() => f.connections.length === 1, 'explicit profile should connect');
  assert.deepEqual(f.connections[0].profile, development);
});

test('local terminal uses the system shell without reading SSH configuration or loading SSH', async t => {
  const f = fixture(t, { read() { throw new Error('SSH configuration must not be read'); } });
  const terminal = await f.service.open('local');
  assert.equal(terminal.options.shellPath, f.vscode.env.shell);
  assert.equal(terminal.options.pty, undefined);
  assert.equal(terminal.shown, true);
  assert.equal(f.configurationReads(), 0);
  assert.equal(f.sshLoads(), 0);
  assert.equal(f.connections.length, 0);
});

test('terminal chooser opens the selected SSH profile or the current system terminal', async t => {
  const ssh = fixture(t, { pick: items => items.find(item => item.profileId === 'development') });
  const terminal = await ssh.service.select();
  assert.equal(ssh.picks[0].items[0].target, 'local');
  assert(ssh.picks[0].items.some(item => item.target === 'local'), 'local shell must remain available alongside SSH profiles');
  terminal.options.pty.open({ columns: 80, rows: 24 });
  await eventually(() => ssh.connections.length === 1, 'chosen SSH profile should connect');
  assert.deepEqual(ssh.connections[0].profile, development);

  const local = fixture(t, { pick: items => items.find(item => item.target === 'local') });
  const systemTerminal = await local.service.select();
  assert.equal(systemTerminal.options.shellPath, local.vscode.env.shell);
  assert.equal(local.sshLoads(), 0);

  const canceled = fixture(t);
  await canceled.service.select();
  assert.equal(canceled.terminals.length, 0, 'dismissing the chooser must not open a terminal');
});

test('UTF-8 output survives separate stdout and stderr chunks and input reaches the interactive shell', async t => {
  const f = fixture(t), observed = observe(await f.service.open('ssh'));
  observed.pty.open({ columns: 80, rows: 24 });
  await eventually(() => f.connections[0]?.session.stream.listenerCount('data') > 0, 'stream listeners should attach');
  const { session } = f.connections[0];
  const before = observed.output.length, stdout = Buffer.from('中文🙂'), stderr = Buffer.from('错误');
  for (const byte of stdout) session.stream.emit('data', Buffer.from([byte]));
  for (const byte of stderr) session.stream.stderr.emit('data', Buffer.from([byte]));
  assert.equal(observed.output.slice(before).join(''), '中文🙂错误');
  observed.pty.handleInput('echo 中文\r');
  observed.pty.handleInput('\u0003');
  assert.deepEqual(session.written, ['echo 中文\r', '\u0003']);
});

test('resizes during connection are applied once the shell is ready and subsequent sizes are forwarded', async t => {
  const pending = deferred();
  const f = fixture(t, { connect: () => pending.promise }), observed = observe(await f.service.open('ssh'));
  observed.pty.open({ columns: 100, rows: 30 });
  await eventually(() => f.connections[0]?.calls.length === 1, 'connect should be pending');
  const { session } = f.connections[0];
  observed.pty.setDimensions({ columns: 141, rows: 49 });
  pending.resolve(session);
  await eventually(() => session.stream.listenerCount('data') > 0, 'stream should become ready');
  assert.deepEqual(session.resized.at(-1), { columns: 141, rows: 49 });
  observed.pty.setDimensions({ columns: 160, rows: 52 });
  assert.deepEqual(session.resized.at(-1), { columns: 160, rows: 52 });
});

test('closing before configuration loads prevents opening an SSH connection', async t => {
  const pending = deferred();
  const f = fixture(t, { read: () => pending.promise }), observed = observe(await f.service.open('ssh'));
  observed.pty.open({ columns: 80, rows: 24 });
  await eventually(() => f.configurationReads() === 1, 'configuration read should start');
  observed.pty.close();
  pending.resolve({ profiles: [development] });
  await nextTurn();
  await nextTurn();
  assert.equal(f.connections.length, 0);
});

test('closing while connecting aborts the attempt and disposes a late arriving session', async t => {
  const pending = deferred();
  const f = fixture(t, { connect: () => pending.promise }), observed = observe(await f.service.open('ssh'));
  observed.pty.open({ columns: 80, rows: 24 });
  await eventually(() => f.connections[0]?.calls.length === 1, 'connect should start');
  const connection = f.connections[0];
  observed.pty.close();
  assert.equal(connection.calls[0].signal.aborted, true);
  pending.resolve(connection.session);
  await eventually(() => connection.session.closed > 0, 'late session must be closed');
  assert.equal(connection.closed, 1);
  assert.equal(connection.session.stream.listenerCount('data'), 0);
});

test('remote exit preserves its status and closes the SSH transport exactly once', async t => {
  const f = fixture(t), observed = observe(await f.service.open('ssh'));
  observed.pty.open({ columns: 80, rows: 24 });
  await eventually(() => f.connections[0]?.session.stream.listenerCount('data') > 0, 'shell should be ready');
  const connection = f.connections[0], stream = connection.session.stream;
  stream.emit('exit', 17);
  stream.emit('close');
  await nextTurn();
  assert.deepEqual(observed.exits, [17]);
  assert.equal(connection.closed, 1);
  assert.equal(stream.listenerCount('data'), 0);
  assert.equal(stream.stderr.listenerCount('data'), 0);
  observed.pty.close();
  f.service.dispose();
  assert.equal(connection.closed, 1);
});

test('stream failures report an unsuccessful terminal exit and release the transport', async t => {
  const f = fixture(t), observed = observe(await f.service.open('ssh'));
  observed.pty.open({ columns: 80, rows: 24 });
  await eventually(() => f.connections[0]?.session.stream.listenerCount('data') > 0, 'shell should be ready');
  const connection = f.connections[0];
  connection.session.stream.emit('error', new Error('connection lost'));
  await nextTurn();
  assert.equal(f.terminals.length, 1, 'an established session failure must not switch command destinations');
  assert.equal(observed.exits.length, 1);
  assert.notEqual(observed.exits[0], 0);
  assert.equal(connection.closed, 1);
  assert.equal(connection.session.stream.listenerCount('data'), 0);
});

test('connection errors redact saved credentials and release the failed connection', async t => {
  const f = fixture(t, { connect() { throw new Error('authentication rejected: hydrated-password'); } });
  const observed = observe(await f.service.open('ssh'));
  observed.pty.open({ columns: 80, rows: 24 });
  await eventually(() => observed.exits.length === 1, 'connection rejection should close the terminal');
  assert.notEqual(observed.exits[0], 0);
  assert(!observed.output.join('').includes('hydrated-password'));
  assert.equal(f.connections[0].closed, 1);
  assert.equal(f.terminals.at(-1).options.shellPath, f.vscode.env.shell);
  assert.equal(f.terminals.at(-1).shown, true);
  assert.equal(f.terminals.at(-1).preserveFocus, true, 'delayed fallback must not reopen a hidden panel');
  assert(f.messages.every(({ message }) => !message.includes('hydrated-password')));
});

test('hostile SSH errors cannot escape the stream callback or bypass transport cleanup', async t => {
  const f = fixture(t), observed = observe(f.service.open('ssh'));
  observed.pty.open({ columns: 80, rows: 24 });
  await eventually(() => f.connections[0]?.session.stream.listenerCount('data') > 0, 'shell should be ready');
  const connection = f.connections[0];
  const error = { get message() { throw Error('broken error getter'); }, toString() { throw Error('broken conversion'); } };
  assert.doesNotThrow(() => connection.session.stream.emit('error', error));
  await nextTurn();
  assert.equal(observed.exits.length, 1);
  assert.notEqual(observed.exits[0], 0);
  assert.equal(connection.closed, 1);
  assert.equal(connection.session.stream.listenerCount('data'), 0);
});

test('unconvertible connection rejection still closes SSH and completes fallback', async t => {
  const error = { message: { toString() { throw Error('unsafe message conversion'); } }, toString() { throw Error('unsafe error conversion'); } };
  const f = fixture(t, { connect() { throw error; } });
  const observed = observe(f.service.open('ssh'));
  observed.pty.open({ columns: 80, rows: 24 });
  await eventually(() => observed.exits.length === 1, 'unsafe error must not strand the terminal');
  await nextTurn();
  assert.equal(f.connections[0].closed, 1);
  assert.match(observed.output.join(''), /错误详情不可读取/);
  assert.equal(f.terminals.at(-1).options.shellPath, f.vscode.env.shell);
});

test('disposing the service closes active shells and prevents additional terminal creation', async t => {
  const f = fixture(t), terminal = await f.service.open('ssh');
  terminal.options.pty.open({ columns: 80, rows: 24 });
  await eventually(() => f.connections[0]?.session.stream.listenerCount('data') > 0, 'shell should be ready');
  const connection = f.connections[0];
  f.service.dispose();
  await nextTurn();
  assert.equal(terminal.disposed, true);
  assert.equal(connection.calls[0].signal.aborted, true);
  assert.equal(connection.closed, 1);
  assert.equal(connection.session.closed, 1);
  assert.throws(() => f.service.open('ssh'));
  assert.equal(f.terminals.length, 1);
});

test('missing SSH configuration and unknown profile open a local shell automatically', async t => {
  for (const { config, profileId } of [{ config: { profiles: [] } }, { config: { profiles: [development], defaultId: 'missing' } }, { config: { profiles: [development] }, profileId: 'missing' }]) {
    const f = fixture(t, { config }), observed = observe(await f.service.open('ssh', profileId));
    observed.pty.open({ columns: 80, rows: 24 });
    await eventually(() => observed.exits.length > 0, 'missing profile should fail visibly');
    assert.equal(f.connections.length, 0);
    assert.equal(f.terminals.length, 2);
    assert.equal(f.terminals[0].disposed, true);
    assert.equal(f.terminals[1].options.shellPath, f.vscode.env.shell);
    assert.equal(f.terminals[1].shown, true);
    assert.equal(f.terminals[1].preserveFocus, true);
    assert.notEqual(observed.exits[0], 0);
    assert(observed.output.length > 0 || f.messages.length > 0);
  }
});

test('native SSH profile falls back to an existing local terminal when configuration fails', async t => {
  const f = fixture(t, { read() { throw new Error('configuration unavailable'); } });
  f.service.register();
  const local = f.service.open('local');
  const profile = await f.profiles.get('ubovm.ssh').provideTerminalProfile({ isCancellationRequested: false, onCancellationRequested: new VSCodeEventEmitter().event });
  const ssh = f.vscode.window.createTerminal(profile.options);
  const observed = observe(ssh);
  ssh.show();
  observed.pty.open();
  observed.pty.handleInput('must not run locally\r');
  await eventually(() => ssh.disposed, 'failed native terminal should be removed');
  assert.equal(f.terminals.length, 2, 'fallback must reuse the live local shell');
  assert.equal(local.preserveFocus, true, 'fallback to an existing shell must preserve focus');
  assert.equal(f.service.switchTo('local'), local);
  assert.equal(local.preserveFocus, false, 'manual switches still focus the terminal');
  assert.equal(local.disposed, false);
  assert.equal(f.sshLoads(), 0);
  assert.match(f.messages[0].message, /已切换到当前系统终端/);
});

test('canceling or disposing a pending SSH connection does not open a fallback terminal', async t => {
  for (const dispose of [false, true]) {
    const pending = deferred();
    const f = fixture(t, { connect: () => pending.promise });
    const ssh = f.service.open('ssh');
    ssh.options.pty.open();
    await eventually(() => f.connections.length === 1, 'connection should start');
    if (dispose) f.service.dispose();
    else ssh.dispose();
    pending.reject(new Error('connection canceled'));
    await nextTurn();
    assert.equal(f.terminals.length, 1);
    assert.equal(f.messages.length, 0);
    assert.equal(f.connections[0].closed, 1);
  }
});

test('fallback respects workspace trust and reports an unavailable local shell', async t => {
  for (const trusted of [false, true]) {
    const pending = deferred();
    const f = fixture(t, { read: () => pending.promise });
    const ssh = f.service.open('ssh');
    ssh.options.pty.open();
    f.vscode.workspace.isTrusted = trusted;
    f.vscode.env.shell = '';
    pending.resolve({ profiles: [] });
    await nextTurn();
    assert.equal(f.terminals.length, 1);
    if (trusted) assert.match(f.messages[0].message, /无法打开当前系统终端/);
    else assert.equal(f.messages.length, 0);
  }
});

test('terminal profile provider is lazy and respects canceled profile requests', async t => {
  const f = fixture(t), registrations = f.service.register();
  assert(Array.isArray(registrations));
  assert(f.profiles.size > 0);
  const provider = [...f.profiles.entries()].find(([id]) => /ssh/i.test(id))?.[1];
  assert(provider, 'SSH should be registered as a terminal profile');
  const canceled = new VSCodeEventEmitter();
  const result = await provider.provideTerminalProfile({ isCancellationRequested: true, onCancellationRequested: canceled.event });
  assert.equal(result, undefined);
  assert.equal(f.configurationReads(), 0);
  const token = { isCancellationRequested: false, onCancellationRequested: canceled.event };
  const profile = await provider.provideTerminalProfile(token);
  assert(profile instanceof f.vscode.TerminalProfile);
  assert(profile.options.pty);
  assert.equal(f.configurationReads(), 0);
  const observed = observe({ options: profile.options });
  token.isCancellationRequested = true;
  canceled.fire();
  observed.pty.open({ columns: 80, rows: 24 });
  await nextTurn();
  assert.equal(f.connections.length, 0);
  for (const registration of registrations) registration.dispose();
  assert.equal(f.profiles.size, 0);
});

test('SSH terminals created through the native profile are tracked and disposed with the service', async t => {
  const f = fixture(t), registrations = f.service.register();
  t.after(() => registrations.forEach(registration => registration.dispose()));
  const canceled = new VSCodeEventEmitter();
  const provider = f.profiles.get('ubovm.ssh');
  const profile = await provider.provideTerminalProfile({ isCancellationRequested: false, onCancellationRequested: canceled.event });
  const terminal = f.vscode.window.createTerminal(profile.options);
  const unrelated = f.vscode.window.createTerminal({ name: 'Existing local terminal', shellPath: f.vscode.env.shell });
  terminal.options.pty.open({ columns: 80, rows: 24 });
  await eventually(() => f.connections[0]?.session.stream.listenerCount('data') > 0, 'native profile should connect');
  const connection = f.connections[0];
  f.service.dispose();
  await nextTurn();
  assert.equal(terminal.disposed, true);
  assert.equal(unrelated.disposed, false, 'disposing the service should preserve unrelated terminals');
  assert.equal(connection.session.closed, 1);
  assert.equal(connection.closed, 1);
  assert.equal(connection.session.stream.listenerCount('data'), 0);
});


test('a stale SSH connection failure preserves a newer terminal selection', async t => {
  for (const target of ['local', 'ssh']) {
    const pending = deferred();
    const f = fixture(t, { connect: () => pending.promise });
    f.service.register();
    const first = f.service.open('ssh', 'development');
    first.options.pty.open();
    await eventually(() => f.connections.length === 1, 'first SSH attempt should start');
    const selected = f.service.open(target, 'production');
    pending.reject(new Error('connection failed'));
    await eventually(() => first.disposed, 'failed SSH terminal should be removed');
    assert.equal(f.vscode.window.activeTerminal, selected);
    assert.equal(selected.disposed, false);
    assert.equal(f.terminals.length, 2, 'late failure must not create a fallback shell');
    assert.equal(f.connections[0].closed, 1);
    assert.match(f.messages[0].message, /当前终端保持不变/);
  }
});

test('the chooser still offers local shells and settings when SSH configuration fails', async t => {
  for (const target of ['local', 'settings']) {
    const f = fixture(t, {
      read() { throw new Error('secret config failure'); },
      pick: items => items.find(item => item.target === target)
    });
    const result = await f.service.select();
    assert.deepEqual(f.picks[0].items.map(item => item.target), ['local', 'settings']);
    assert.match(f.picks[0].options.placeHolder, /SSH 配置读取失败/);
    assert(!f.picks[0].options.placeHolder.includes('secret'));
    if (target === 'local') assert.equal(result.options.shellPath, f.vscode.env.shell);
    else assert.equal(f.settingsOpened(), 1);
    assert.equal(f.sshLoads(), 0);
  }
});

test('a pending chooser does not open after service disposal or lost workspace trust', async t => {
  for (const dispose of [true, false]) {
    const pending = deferred();
    const f = fixture(t, { read: () => pending.promise });
    const selection = f.service.select();
    if (dispose) f.service.dispose();
    else f.vscode.workspace.isTrusted = false;
    pending.resolve({ profiles: [] });
    if (dispose) await selection;
    else await assert.rejects(selection, /信任/);
    assert.equal(f.picks.length, 0);
    assert.equal(f.terminals.length, 0);
  }
});
