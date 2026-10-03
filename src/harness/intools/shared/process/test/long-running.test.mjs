import test from 'node:test';
import assert from 'node:assert/strict';
import { isLongRunningShellCommand, shouldRetainShellCommand } from '../long-running.mjs';

test('detects common long-lived servers and rejects one-shot builds', () => {
  for (const command of ['npm run dev', 'pnpm start', 'yarn run serve', 'bun run dev', 'next dev', 'vite', 'vite --port 5173', 'nodemon index.js', 'uvicorn app:main --reload', 'docker compose up']) {
    assert.equal(isLongRunningShellCommand(command), true, command);
  }
  for (const command of ['npm run build', 'vite build', 'next build', 'echo hi', 'pytest', '']) {
    assert.equal(isLongRunningShellCommand(command), false, command);
  }
});

test('retain flag overrides heuristics', () => {
  assert.equal(shouldRetainShellCommand({ retain: true, command: 'echo hi' }), true);
  assert.equal(shouldRetainShellCommand({ retain: false, command: 'npm run dev' }), false);
  assert.equal(shouldRetainShellCommand({ command: 'npm run dev' }), true);
});
