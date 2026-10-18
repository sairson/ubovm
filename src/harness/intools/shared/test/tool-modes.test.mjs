import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PARALLEL_READ_TOOLS,
  applyExecutionModes,
  executionModeFor,
  isParallelReadTool,
} from '../tool-modes.mjs';

test('the parallel read allowlist is unique and nonempty', () => {
  assert.ok(PARALLEL_READ_TOOLS.length > 0);
  assert.equal(new Set(PARALLEL_READ_TOOLS).size, PARALLEL_READ_TOOLS.length);
  for (const name of PARALLEL_READ_TOOLS) assert.equal(typeof name, 'string');
});

test('only reviewed read-only tools are parallel', () => {
  for (const name of [
    'read_workspace_file', 'list_workspace_files', 'search_workspace',
    'read_worker_result', 'read_skills_resource', 'web_search', 'fetch_web_content',
  ]) {
    assert.equal(isParallelReadTool(name), true, name);
    assert.equal(executionModeFor(name), 'parallel', name);
  }
  for (const name of [
    'run_local_shell_command', 'run_linux_ssh_command', 'run_python',
    'edit_workspace_file', 'edit_workspace_files', 'todo', 'note', 'load_skill',
    'ask_human', 'spawn_worker', 'wait_workers', 'browser_action',
    'mcp_github_create_issue', 'unknown_tool',
  ]) {
    assert.equal(isParallelReadTool(name), false, name);
    assert.equal(executionModeFor(name), 'sequential', name);
  }
  assert.equal(executionModeFor(undefined), 'sequential');
});

test('applyExecutionModes preserves tool identity and does not mutate input', () => {
  const execute = async () => ({ content: [{ type: 'text', text: 'ok' }], details: {} });
  const tools = Object.freeze([
    { name: 'read_workspace_file', description: 'read', execute },
    { name: 'run_local_shell_command', description: 'shell', execute },
  ]);
  const resolved = applyExecutionModes(tools);
  assert.equal(tools[0].executionMode, undefined);
  assert.equal(resolved[0].executionMode, 'parallel');
  assert.equal(resolved[1].executionMode, 'sequential');
  assert.equal(resolved[0].execute, execute);
  assert.equal(resolved[0].description, 'read');
  assert.notEqual(resolved[0], tools[0]);
});

test('applyExecutionModes rejects malformed tools instead of guessing', () => {
  assert.throws(() => applyExecutionModes('read_workspace_file'), /array/);
  assert.throws(() => applyExecutionModes([{ description: 'missing name' }]), /nonempty name/);
  assert.throws(() => applyExecutionModes([{ name: '' }]), /nonempty name/);
});
