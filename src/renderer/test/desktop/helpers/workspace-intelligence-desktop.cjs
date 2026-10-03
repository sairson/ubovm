'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createCodingService } = require('../../../harness/coding/coding-service.cjs');
const { createWorkspaceSearch } = require('../../../harness/workspace/workspace-search.cjs');
const { createWorkspaceValidation } = require('../../../harness/workspace/workspace-validation.cjs');

exports.checkWorkspaceIntelligence = async (vscode, workspace) => {
  const filename = `intelligence-${randomUUID()}.ts`, file = path.join(workspace, filename), state = new Map();
  const context = { workspaceState: { get: (key, fallback) => state.get(key) ?? fallback, async update(key, value) { state.set(key, structuredClone(value)); } } };
  const search = createWorkspaceSearch(vscode).tools()[0];
  const validation = createWorkspaceValidation(vscode, context, { changes: id => coding.changes(id) });
  const coding = createCodingService(vscode, context, { beforeEdit: validation.capture });
  const call = async (service, name, input = {}) => (await service.tools('native-validation').find(tool => tool.name === name).execute('test', input)).details;
  try {
    const created = await call(coding, 'edit_workspace_file', { path: filename, operation: 'create', newText: 'const count: number = "invalid";\n' });
    const found = (await search.execute('test', { query: 'const count', include: [filename] })).details;
    assert.equal(found.matches.length, 1); assert.equal(found.matches[0].line, 1);
    const failed = await call(validation, 'validate_workspace_changes');
    assert.equal(failed.status, 'issues_found', JSON.stringify(failed));
    assert(failed.compilerResults[0].diagnostics.some(item => item.code === 2322));
    await call(coding, 'edit_workspace_file', { path: filename, operation: 'replace', expectedHash: created.hash, oldText: '"invalid"', newText: '42' });
    const passed = await call(validation, 'validate_workspace_changes');
    assert.equal(passed.status, 'selected_checks_passed', JSON.stringify(passed));
    assert.equal(passed.tests, 'not_run'); assert.equal(passed.build, 'not_run');
    assert.equal((await call(coding, 'recover_workspace_changes'))[0].state, 'applied');
    return { nativeSearch: true, compilerErrorDetected: true, repairedAndRevalidated: true, noProjectCommands: true };
  } finally {
    coding.dispose(); validation.dispose();
    await fs.rm(file, { force: true });
  }
};
