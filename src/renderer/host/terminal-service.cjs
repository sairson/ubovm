'use strict';

const { StringDecoder } = require('node:string_decoder');

const cleanLabel = value => String(value).replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').slice(0, 180);
const dimensions = value => ({ columns: Math.max(1, Math.min(65535, Math.floor(value?.columns || 80))), rows: Math.max(1, Math.min(65535, Math.floor(value?.rows || 24))) });

/** The renderer only sees terminal bytes; connection credentials stay in this host. */
function createTerminalService(vscode, { readConfiguration, loadSSH, openSettings }) {
  const terminals = new Set(), pending = new Set();
  let disposed = false;
  const assertTrusted = () => {
    if (disposed) throw new Error('终端服务已关闭。');
    if (!vscode.workspace.isTrusted) throw new Error('请先信任当前工作区，再打开终端。');
  };
  const localOptions = () => {
    // Supplying the executable bypasses the contributed default SSH profile.
    if (!vscode.env.shell) throw new Error('当前系统没有可用的终端 Shell。');
    return { name: '当前系统终端', shellPath: vscode.env.shell, cwd: vscode.workspace.workspaceFolders?.find(folder => folder.uri.scheme === 'file')?.uri,
      location: vscode.TerminalLocation.Panel, iconPath: new vscode.ThemeIcon('terminal') };
  };

  function sshOptions(profileId, token) {
    const writes = new vscode.EventEmitter(), closes = new vscode.EventEmitter(), names = new vscode.EventEmitter();
    const controller = new AbortController();
    const stdout = new StringDecoder('utf8'), stderr = new StringDecoder('utf8');
    let started = false, ended = false, size = dimensions(), connection, session, profile, exitCode, exitSignal, cancellation, detach;
    const cleanError = error => {
      let message = String(error?.message ?? error);
      for (const key of ['password', 'private_key_passphrase', 'privateKey']) {
        if (profile?.[key]) message = message.split(String(profile[key])).join('[已隐藏]');
      }
      return cleanLabel(message);
    };
    const write = value => { if (!ended && value) writes.fire(value); };
    const release = () => {
      cancellation?.dispose();
      detach?.();
      controller.abort();
      try { session?.close(); } catch { /* Already disconnected. */ }
      Promise.resolve().then(() => connection?.close()).catch(() => {});
      pending.delete(pty);
    };
    const finish = (code, message) => {
      if (ended) return;
      write(stdout.end()); write(stderr.end());
      if (message) write('\r\n' + message + '\r\n');
      ended = true;
      release();
      closes.fire(code);
      writes.dispose(); names.dispose(); closes.dispose();
    };
    const fail = error => finish(1, 'SSH 终端连接失败：' + cleanError(error) + '\r\n请检查“系统配置 → SSH 连接”，然后新建终端重试。');
    async function start() {
      try {
        assertTrusted();
        const configuration = await readConfiguration();
        if (ended) return;
        const profiles = configuration?.profiles ?? [];
        const id = profileId ?? configuration?.defaultId ?? profiles[0]?.id;
        profile = profiles.find(entry => (entry.id ?? (profiles.length === 1 ? 'default' : undefined)) === (id ?? 'default'));
        if (!profile) {
          finish(1, profiles.length ? '默认 SSH 连接不存在，请在“系统配置 → SSH 连接”重新选择默认连接。' : '尚未配置 SSH 连接。请在“系统配置 → SSH 连接”添加主机，或从终端下拉菜单选择“当前系统终端”。');
          void vscode.window.showInformationMessage('请先配置 SSH 连接，或选择当前系统终端。', '配置 SSH', '当前系统终端').then(action => {
            if (disposed) return;
            if (action === '配置 SSH') return openSettings();
            if (action === '当前系统终端') return open('local');
          }).catch(() => {});
          return;
        }
        const label = cleanLabel(profile.name || `${profile.username}@${profile.host}`);
        names.fire('SSH · ' + label);
        write(`正在连接 SSH · ${label}…\r\n`);
        const { SSHCommands } = await loadSSH();
        if (ended) return;
        assertTrusted();
        connection = new SSHCommands(profile);
        session = await connection.openInteractive({ ...size, signal: controller.signal });
        if (ended) { session.close(); return; }
        const onData = chunk => write(typeof chunk === 'string' ? chunk : stdout.write(chunk));
        const onStderr = chunk => write(typeof chunk === 'string' ? chunk : stderr.write(chunk));
        const onExit = (code, signal) => { exitCode = code; exitSignal = signal; };
        const onClose = code => {
          const status = Number.isInteger(exitCode) ? exitCode : Number.isInteger(code) ? code : undefined;
          finish(status ?? 1, exitSignal ? `SSH 会话已结束（信号 ${cleanLabel(exitSignal)}）。` : status !== undefined ? `SSH 会话已结束（退出码 ${status}）。` : 'SSH 连接已断开，请新建终端重新连接。');
        };
        session.stream.on('data', onData);
        session.stream.stderr?.on('data', onStderr);
        session.stream.on('error', fail);
        session.stream.on('exit', onExit);
        session.stream.on('close', onClose);
        detach = () => {
          session.stream.removeListener('data', onData);
          session.stream.stderr?.removeListener('data', onStderr);
          session.stream.removeListener('exit', onExit);
          session.stream.removeListener('close', onClose);
          session.stream.removeListener('error', fail);
          session.stream.on('error', () => {});
        };
        // A panel resize can happen while the connection is being established.
        session.resize(size.columns, size.rows);
      } catch (error) { if (!ended) fail(error); }
    }
    const pty = {
      onDidWrite: writes.event, onDidClose: closes.event, onDidChangeName: names.event,
      open(initialDimensions) { if (started || ended) return; started = true; cancellation?.dispose(); size = dimensions(initialDimensions ?? size); void start(); },
      close() { if (ended) return; ended = true; release(); writes.dispose(); names.dispose(); closes.dispose(); },
      handleInput(data) { if (!ended && session) { try { session.write(data); } catch (error) { fail(error); } } },
      setDimensions(value) { size = dimensions(value); if (!ended && session) { try { session.resize(size.columns, size.rows); } catch (error) { fail(error); } } }
    };
    pending.add(pty);
    cancellation = token?.onCancellationRequested(() => pty.close());
    return { name: 'UBOVM SSH', pty, location: vscode.TerminalLocation.Panel, iconPath: new vscode.ThemeIcon('remote') };
  }

  function open(target = 'ssh', profileId) {
    assertTrusted();
    if (!['ssh', 'local'].includes(target)) throw new Error('未知的终端类型。');
    const options = target === 'local' ? localOptions() : sshOptions(profileId);
    let terminal;
    try { terminal = vscode.window.createTerminal(options); } catch (error) { options.pty?.close(); throw error; }
    terminals.add(terminal);
    terminal.show();
    return terminal;
  }

  async function select() {
    assertTrusted();
    const configuration = await readConfiguration();
    const profiles = configuration?.profiles ?? [], defaultId = configuration?.defaultId ?? profiles[0]?.id;
    const entries = profiles.map(profile => ({ label: '$(remote) ' + cleanLabel(profile.name || `${profile.username}@${profile.host}`),
      description: profile.id === defaultId ? '默认 SSH' : 'SSH', detail: cleanLabel(`${profile.username}@${profile.host}:${profile.port ?? 22}`), target: 'ssh', profileId: profile.id }));
    entries.push({ label: '$(terminal) 当前系统终端', description: '本机', target: 'local' }, { label: '$(settings-gear) 配置 SSH 连接', target: 'settings' });
    const choice = await vscode.window.showQuickPick(entries, { title: '新建终端', placeHolder: '选择 SSH 连接或当前系统终端' });
    if (!choice || disposed) return;
    return choice.target === 'settings' ? openSettings() : open(choice.target, choice.profileId);
  }

  function register() {
    return [
      ...['ssh', 'local'].map(target => vscode.window.registerTerminalProfileProvider('ubovm.' + target, {
        provideTerminalProfile(token) {
          if (token.isCancellationRequested) return;
          assertTrusted();
          return new vscode.TerminalProfile(target === 'local' ? localOptions() : sshOptions(undefined, token));
        }
      })),
      vscode.window.onDidOpenTerminal(terminal => { if (pending.has(terminal.creationOptions?.pty)) terminals.add(terminal); }),
      vscode.window.onDidCloseTerminal(terminal => { if (terminals.delete(terminal)) terminal.creationOptions?.pty?.close(); })
    ];
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    for (const pty of [...pending]) pty.close();
    for (const terminal of terminals) terminal.dispose();
    terminals.clear();
  }
  return { open, select, register, dispose };
}

module.exports = { createTerminalService };
