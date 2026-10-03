import { randomUUID } from 'node:crypto';
import { abortError } from '../../shared/common.mjs';
const ignoreChannelEvent = () => {};
const absorbLateErrors = stream => {
  for (const target of [stream, stream.stderr]) {
    if (target && !target.listeners('error').includes(ignoreChannelEvent)) target.on('error', ignoreChannelEvent);
  }
};

// A process group lets cancellation kill descendants even on SSH servers that
// ignore channel signal requests. The environment token fences stale PIDs.
export function openPersistentTransport(client, signal) {
  signal.throwIfAborted();
  const token = randomUUID(), prefix = Buffer.from(`\x1e${token}:`);
  return new Promise((resolve, reject) => {
    let channel, detachChannel, pid, stopped = false, ready = false, opening = Buffer.alloc(0), closing;
    const closeChannel = stream => {
      absorbLateErrors(stream);
      try { stream.signal('KILL'); } catch {}
      try { stream.close(); } catch {}
    };
    const cleanup = () => {
      signal.removeEventListener('abort', cancel);
      client.removeListener('close', disconnected); client.removeListener('error', failed);
      channel?.removeListener('data', handshake);
      detachChannel?.(); detachChannel = undefined;
      opening = Buffer.alloc(0);
    };
    const terminate = () => {
      if (closing) return closing;
      stopped = true; cleanup();
      closing = new Promise(resolve => {
        let control, detachControl, done = false;
        const finish = confirmed => {
          if (done) return; done = true; clearTimeout(timer);
          detachControl?.(); detachControl = undefined;
          if (channel) closeChannel(channel);
          if (control) { try { control.close(); } catch {} }
          resolve({ remote_termination_confirmed: confirmed });
        };
        const timer = setTimeout(() => finish(false), 1500);
        if (!pid) { finish(false); return; }
        // Only digits and a host-generated UUID enter this command.
        const command = `test "$(tr '\\0' '\\n' < /proc/${pid}/environ | grep -Fx 'UBOVM_SHELL_SESSION=${token}')" = 'UBOVM_SHELL_SESSION=${token}' && kill -KILL -- -${pid} && { for attempt in 1 2 3 4 5 6 7 8 9 10; do kill -0 -- -${pid} 2>/dev/null || exit 0; sleep 0.05; done; exit 1; }`;
        try { client.exec(command, (error, stream) => {
          if (done) { if (stream) closeChannel(stream); return; }
          if (error) { finish(false); return; }
          control = stream;
          let code;
          const failed = () => finish(false), exited = value => { code = value; };
          const closed = value => finish((code ?? value) === 0);
          detachControl = () => {
            stream.removeListener('error', failed); stream.stderr?.removeListener('error', failed);
            stream.removeListener('data', ignoreChannelEvent); stream.stderr?.removeListener('data', ignoreChannelEvent);
            stream.removeListener('exit', exited); stream.removeListener('close', closed);
            stream.on('error', ignoreChannelEvent); stream.stderr?.on('error', ignoreChannelEvent);
          };
          stream.on('error', failed); stream.stderr?.on('error', failed);
          stream.on('data', ignoreChannelEvent); stream.stderr?.on('data', ignoreChannelEvent);
          stream.on('exit', exited); stream.once('close', closed);
        }); } catch { finish(false); }
      });
      return closing;
    };
    const stop = error => {
      if (stopped) return;
      if (!ready) { stopped = true; cleanup(); if (channel) closeChannel(channel); reject(error); }
      else {
        stopped = true;
        try { channel.emit('error', error); } catch { /* Observers cannot prevent fenced termination. */ }
        void terminate();
      }
    };
    const cancel = () => stop(abortError(signal));
    const disconnected = () => stop(new Error('SSH transport closed; remote command termination is unconfirmed'));
    const failed = error => stop(error);
    const handshake = chunk => {
      const previousLength = opening.length, available = 128 - previousLength;
      const frameChunk = chunk.subarray(0, available);
      // The cap applies to the identity frame, not coalesced shell output.
      // Reject oversized delimiter-free input before copying it.
      if (chunk.length > available && frameChunk.indexOf(31) === -1) { stop(new Error('Invalid SSH shell startup frame')); return; }
      opening = Buffer.concat([opening, frameChunk]);
      const end = opening.indexOf(31);
      if (end === -1) return;
      if (!opening.subarray(0, prefix.length).equals(prefix) || !/^[1-9]\d{0,9}$/.test(opening.subarray(prefix.length, end).toString())) {
        stop(new Error('Invalid SSH shell process identity')); return;
      }
      pid = opening.subarray(prefix.length, end).toString();
      channel.removeListener('data', handshake); signal.removeEventListener('abort', cancel); ready = true;
      channel.pause?.();
      const tail = chunk.subarray(end + 1 - previousLength);
      if (tail.length) channel.unshift(tail);
      opening = Buffer.alloc(0);
      resolve({ stdout: channel, stderr: channel.stderr, events: channel, write: data => channel.write(data), close: terminate });
    };
    signal.addEventListener('abort', cancel, { once: true });
    client.once('close', disconnected); client.on('error', failed);
    // Linux SSH execution already requires bash; setsid and /proc are required
    // for named sessions. Do not silently fall back to an unkillable shell.
    const command = `env UBOVM_SHELL_SESSION=${token} setsid bash --noprofile --norc -c 'printf "\\036${token}:%s\\037" "$$"; exec bash --noprofile --norc -s'`;
    try { client.exec(command, (error, stream) => {
      if (stopped) { if (stream) closeChannel(stream); return; }
      if (error) { stop(error); return; }
      channel = stream;
      const startupError = error => { if (!ready) stop(error); };
      const closed = () => {
        cleanup();
        if (!ready && !stopped) { stopped = true; reject(new Error('SSH persistent shell could not start; Linux setsid and bash are required')); }
      };
      detachChannel = () => {
        stream.removeListener('error', startupError); stream.stderr.removeListener('error', failed);
        stream.removeListener('close', closed);
        absorbLateErrors(stream);
      };
      stream.on('error', startupError); stream.stderr.on('error', failed);
      stream.on('data', handshake); stream.once('close', closed);
    }); } catch (error) { stop(error); }
    if (signal.aborted) cancel();
  });
}
