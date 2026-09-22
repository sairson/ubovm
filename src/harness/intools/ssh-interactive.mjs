import { integer, abortError } from './common.mjs';

/** Open a real PTY shell on an authenticated SSH connection. */
export function openInteractiveShell(client, { columns = 80, rows = 24, signal } = {}) {
  columns = integer(columns, 80, 1, 65535, 'columns');
  rows = integer(rows, 24, 1, 65535, 'rows');
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    let channel, settled = false, stopped = false;
    const closeChannel = stream => {
      // A cancelled shell request can still deliver its channel later.
      stream.on('error', () => {});
      try { stream.close(); } catch { /* transport already closed */ }
    };
    const cleanup = () => {
      signal?.removeEventListener('abort', cancel);
      client.removeListener('close', disconnected);
      client.removeListener('error', failed);
    };
    const stop = error => {
      if (stopped) return;
      stopped = true;
      cleanup();
      if (!settled) { settled = true; reject(error ?? new Error('SSH shell closed before ready')); }
      else if (error && channel) channel.emit('error', error);
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
        channel.on('error', () => stop());
        channel.stderr?.on('error', failed);
        channel.once('close', () => { stopped = true; cleanup(); });
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
