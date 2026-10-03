'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  visibleTimelineParts, visibleActivities, displayActivityLabel, isBackgroundTool
} = require('../../../webview/messages/timeline-parts.js');

describe('timeline-parts', () => {
  it('hides background tools from inline timelines', () => {
    const parts = [
      { id: 'fg', type: 'tool', name: 'read_workspace_file', status: 'completed' },
      { id: 'bg', type: 'tool', name: 'run_linux_ssh_command', status: 'running', background: true }
    ];
    assert.deepEqual(visibleTimelineParts(parts).map(part => part.id), ['fg']);
    assert.equal(isBackgroundTool(parts[1]), true);
  });

  it('keeps unmatched same-name activities until an inline card covers that status', () => {
    const activities = [
      { key: 'old', label: 'build', status: 'completed' },
      { key: 'new', label: 'build', status: 'running' },
      { key: 'failure', label: 'build', status: 'failed' }
    ];
    const covered = visibleActivities(activities, { execution: { parts: [{ type: 'tool', name: 'build', status: 'completed' }] } });
    assert.deepEqual(covered.map(item => item.status), ['running', 'failed']);
    const running = visibleActivities(activities, { execution: { parts: [
      { type: 'tool', name: 'build', status: 'completed' },
      { id: 'live', type: 'tool', name: 'build', status: 'running' }
    ] } });
    assert.deepEqual(running.map(item => item.status), ['failed']);
  });

  it('covers live tool activities from messages and workers after a command is put aside', () => {
    const activities = [{ key: 'ssh', label: 'run_linux_ssh_command', status: 'running', timestamp: 1 }];
    const hidden = visibleActivities(activities, {
      messages: [{ parts: [{ type: 'tool', name: 'run_linux_ssh_command', status: 'running', background: true, commandId: 'c1' }] }],
      execution: { parts: [], workers: [{ parts: [] }] }
    });
    assert.deepEqual(hidden, []);
    const workerHidden = visibleActivities(activities, {
      execution: { parts: [], workers: [{ parts: [{ type: 'tool', name: 'run_linux_ssh_command', status: 'running', background: true }] }] }
    });
    assert.deepEqual(workerHidden, []);
    const completedHidden = visibleActivities(
      [{ key: 'ssh', label: 'run_linux_ssh_command', status: 'completed' }],
      { messages: [{ parts: [{ type: 'tool', name: 'run_linux_ssh_command', status: 'running', background: true }] }] }
    );
    assert.deepEqual(completedHidden, []);
  });

  it('localizes leaked snake_case tool ids instead of showing protocol names', () => {
    assert.equal(displayActivityLabel('run_linux_ssh_command'), '运行命令');
    assert.equal(displayActivityLabel('mcp_custom_probe'), 'MCP 工具');
    assert.equal(displayActivityLabel('some_unknown_tool'), '工具调用');
    assert.equal(displayActivityLabel('Reason'), '规划');
    assert.equal(displayActivityLabel('skill.loaded'), 'skill.loaded');
  });
});
