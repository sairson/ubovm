import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

// The native backend shares an account. A named pipe releases automatically if
// a host dies, and serializes UBOVM runs and setup across IDE processes.
export async function acquirePythonLease(signal) {
  if (process.platform !== 'win32') return () => {};
  while (true) {
    signal?.throwIfAborted();
    const server = createServer(socket => socket.destroy());
    try {
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen('\\\\.\\pipe\\ubovm-python-sandbox-v1', resolve); });
      return () => new Promise(resolve => server.close(resolve));
    } catch (error) {
      server.close();
      if (error.code !== 'EADDRINUSE') throw error;
      await delay(100, undefined, { signal });
    }
  }
}
