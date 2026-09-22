'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { setImmediate: nextTurn } = require('node:timers/promises');
const { createTerminalService } = require('../host/terminal-service.cjs');

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
  const terminalOpened = new VSCodeEventEmitter(), terminalClosed = new VSCodeEventEmitter();
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
      createTerminal(options) {
        const terminal = { options, creationOptions: options, shown: false, disposed: false,
          show() { this.shown = true; },
          dispose() { this.disposed = true; options.pty?.close(); terminalClosed.fire(this); }
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

test('default SSH starts only when the terminal opens and uses the hydrated default profile', async t => {
  const f = fixture(t);
  const terminal = await f.service.open();
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
  const f = fixture(t), observed = observe(await f.service.open());
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
  const f = fixture(t, { connect: () => pending.promise }), observed = observe(await f.service.open());
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
  const f = fixture(t, { read: () => pending.promise }), observed = observe(await f.service.open());
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
  const f = fixture(t, { connect: () => pending.promise }), observed = observe(await f.service.open());
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
  const f = fixture(t), observed = observe(await f.service.open());
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
  const f = fixture(t), observed = observe(await f.service.open());
  observed.pty.open({ columns: 80, rows: 24 });
  await eventually(() => f.connections[0]?.session.stream.listenerCount('data') > 0, 'shell should be ready');
  const connection = f.connections[0];
  connection.session.stream.emit('error', new Error('connection lost'));
  await nextTurn();
  assert.equal(observed.exits.length, 1);
  assert.notEqual(observed.exits[0], 0);
  assert.equal(connection.closed, 1);
  assert.equal(connection.session.stream.listenerCount('data'), 0);
});

test('connection errors redact saved credentials and release the failed connection', async t => {
  const f = fixture(t, { connect() { throw new Error('authentication rejected: hydrated-password'); } });
  const observed = observe(await f.service.open());
  observed.pty.open({ columns: 80, rows: 24 });
  await eventually(() => observed.exits.length === 1, 'connection rejection should close the terminal');
  assert.notEqual(observed.exits[0], 0);
  assert(!observed.output.join('').includes('hydrated-password'));
  assert.equal(f.connections[0].closed, 1);
});

test('disposing the service closes active shells and prevents additional terminal creation', async t => {
  const f = fixture(t), terminal = await f.service.open();
  terminal.options.pty.open({ columns: 80, rows: 24 });
  await eventually(() => f.connections[0]?.session.stream.listenerCount('data') > 0, 'shell should be ready');
  const connection = f.connections[0];
  f.service.dispose();
  await nextTurn();
  assert.equal(terminal.disposed, true);
  assert.equal(connection.calls[0].signal.aborted, true);
  assert.equal(connection.closed, 1);
  assert.equal(connection.session.closed, 1);
  assert.throws(() => f.service.open());
  assert.equal(f.terminals.length, 1);
});

test('missing SSH configuration and unknown profile do not silently open a local shell', async t => {
  for (const { config, profileId } of [{ config: { profiles: [] } }, { config: { profiles: [development] }, profileId: 'missing' }]) {
    const f = fixture(t, { config }), observed = observe(await f.service.open('ssh', profileId));
    observed.pty.open({ columns: 80, rows: 24 });
    await eventually(() => observed.exits.length > 0, 'missing profile should fail visibly');
    assert.equal(f.connections.length, 0);
    assert.equal(f.terminals.length, 1);
    assert(f.terminals.every(terminal => terminal.options.pty));
    assert.notEqual(observed.exits[0], 0);
    assert(observed.output.length > 0 || f.messages.length > 0);
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
