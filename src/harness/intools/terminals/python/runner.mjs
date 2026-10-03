import { executePythonRequest } from './runner-core.mjs';

const controller = new AbortController();
let started = false;
// EPIPE is emitted asynchronously after the host disappears. Handle it without
// crashing the sidecar before its finally block can restore native permissions.
for (const stream of [process.stdout, process.stderr]) stream.on('error', error => controller.abort(error));
const notify = message => {
  if (message.type === 'output') { if (!process.stdout.destroyed) process.stdout.write(message.text); return; }
  if (process.connected) process.send(message, () => {});
};
process.on('disconnect', () => controller.abort(new Error('Python host disconnected')));
process.on('message', message => {
  if (message?.type === 'cancel') controller.abort(new Error('Python execution cancelled'));
  if (message?.type === 'run' && !started) {
    started = true;
    executePythonRequest(message.request, controller.signal, notify).then(result => {
      if (process.connected) process.send({ type: 'result', ...result }, () => { if (process.connected) process.disconnect(); });
    }).catch(error => {
      console.error(error.message); process.exitCode = 1;
      if (process.connected) process.disconnect();
    });
  }
});
