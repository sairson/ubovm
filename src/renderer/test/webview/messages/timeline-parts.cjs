'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  visibleTimelineParts, visibleActivities, displayActivityLabel, isBackgroundTool, isReadOnlyTool
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

  it('classifies result-echoing read tools without catching action tools', () => {
    for (const name of ['read_workspace_file', 'read_workspace_code', 'read_context_evidence', 'read_worker_evidence', 'read_worker_result',
      'list_workspace_files', 'list_workspace_changes', 'list_workers', 'get_workspace_diagnostics', 'search_workspace', 'inspect_harness',
      'web_search', 'fetch_web_content', 'navigate_workspace_code', 'load_skill', 'scan_workspace_secrets',
      'inventory_workspace_dependencies', 'analyze_workspace_call_chain']) {
      assert.equal(isReadOnlyTool(name), true, `${name} should be treated as read-only`);
    }
    for (const name of ['edit_workspace_file', 'run_local_shell_command', 'run_python', 'deploy_remote_service', 'upload_sftp',
      'delivery_workflow', 'validate_workspace_changes', 'spawn_worker', 'wait_workers', 'note', 'todo', 'browser_action', 'mcp_custom_probe']) {
      assert.equal(isReadOnlyTool(name), false, `${name} must keep its result body`);
    }
    assert.equal(isReadOnlyTool(''), false);
    assert.equal(isReadOnlyTool(undefined), false);
  });

  it('localizes leaked snake_case tool ids instead of showing protocol names', () => {
    assert.equal(displayActivityLabel('run_linux_ssh_command'), '运行命令');
    assert.equal(displayActivityLabel('mcp_custom_probe'), 'MCP 工具');
    assert.equal(displayActivityLabel('some_unknown_tool'), '工具调用');
    assert.equal(displayActivityLabel('Reason'), '规划');
    assert.equal(displayActivityLabel('skill.loaded'), 'skill.loaded');
  });
});
