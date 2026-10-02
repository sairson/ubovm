'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '../../..');

test('project switcher assets and host wiring are present', () => {
  const html = fs.readFileSync(path.join(root, 'webview/index.html'), 'utf8');
  assert.match(html, /id="project-switcher"/);
  assert.match(html, /id="project-switcher-search"/);
  const webview = fs.readFileSync(path.join(root, 'host/ui/webview.cjs'), 'utf8');
  assert.match(webview, /project\/project-switcher\.css/);
  assert.match(webview, /project\/project-switcher\.js/);
  const extension = fs.readFileSync(path.join(root, 'extension.cjs'), 'utf8');
  assert.match(extension, /function projectCatalog\(/);
  assert.match(extension, /projectSwitcherOpen/);
  assert.match(extension, /projectSwitcherCreate/);
  assert.match(extension, /openProjectSwitcher/);
  assert.match(extension, /manageProjects.*openProjectSwitcher/);
  assert.match(extension, /registerCommand\('ubovm\.newProject'[\s\S]*?openProjectSwitcher\(\{ create: true/);
  assert.match(extension, /openProjectSwitcherCreate/);
  assert.doesNotMatch(extension, /registerCommand\('ubovm\.newProject'[\s\S]*?readProjectInput/);
  const switcher = fs.readFileSync(path.join(root, 'webview/project/project-switcher.js'), 'utf8');
  assert.match(switcher, /createProjectSwitcher/);
  assert.match(switcher, /projectSwitcherOpen/);
});
