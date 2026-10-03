import { integer, abortError } from '../../shared/common.mjs';
const ignoreLateShellError = () => {};
const protectLateErrors = stream => {
  for (const target of [stream, stream.stderr]) {
    if (target && !target.listeners('error').includes(ignoreLateShellError)) target.on('error', ignoreLateShellError);
  }
};

/** Open a real PTY shell on an authenticated SSH connection. */
export function openInteractiveShell(client, { columns = 80, rows = 24, signal } = {}) {
  columns = integer(columns, 80, 1, 65535, 'columns');
  rows = integer(rows, 24, 1, 65535, 'rows');
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    let channel, detachChannel, settled = false, stopped = false;
    const closeChannel = stream => {
      // A cancelled shell request can still deliver its channel later.
      protectLateErrors(stream);
      try { stream.close(); } catch { /* transport already closed */ }
    };
    const cleanup = () => {
      signal?.removeEventListener('abort', cancel);
      client.removeListener('close', disconnected);
      client.removeListener('error', failed);
      detachChannel?.(); detachChannel = undefined;
    };
    const stop = error => {
      if (stopped) return;
      stopped = true;
      cleanup();
      if (!settled) { settled = true; reject(error ?? new Error('SSH shell closed before ready')); }
      else if (error && channel) {
        try { channel.emit('error', error); } catch { /* Terminal observers cannot prevent transport cleanup. */ }
      }
      if (channel) closeChannel(channel);
    };
    const cancel = () => stop(abortError(signal));
    const disconnected = () => stop(new Error('SSH transport closed during interactive shell'));
    const failed = error => stop(error);
    client.once('close', disconnected);
    client.once('error', failed);
    signal?.addEventListener('abort', cancel, { once: true });
    try {
      client.shell({ term: 'xterm-256color', cols: columns, rows }, (error, stream) => {
        if (stopped) { if (stream) closeChannel(stream); return; }
        if (error) { stop(error); return; }
        channel = stream;
        // Keep an error listener after shutdown to absorb late transport events.
        const channelError = () => stop();
        const channelClosed = () => { stopped = true; cleanup(); };
        detachChannel = () => {
          channel.removeListener('error', channelError);
          channel.stderr?.removeListener('error', failed);
          channel.removeListener('close', channelClosed);
          protectLateErrors(channel);
        };
        channel.on('error', channelError);
        channel.stderr?.on('error', failed);
        channel.once('close', channelClosed);
        settled = true;
        resolve({
          stream: channel,
          write(data) {
            if (stopped) return false;
            try { return channel.write(data); }
            catch (error) { stop(error); return false; }
          },
          resize(columns, rows) {
            if (stopped) return;
            columns = integer(columns, 80, 1, 65535, 'columns');
            rows = integer(rows, 24, 1, 65535, 'rows');
            try { channel.setWindow(rows, columns, 0, 0); }
            catch (error) { stop(error); }
          },
          close: () => stop()
        });
      });
    } catch (error) { stop(error); }
    if (signal?.aborted) cancel();
  });
}
