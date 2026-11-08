import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { applyBuiltinExtensionPolicy, loadBuiltinAllowlist, pruneBuiltinExtensions, stripExtensionGallery } from '../../../build/builtin-extensions.mjs';

const root = path.resolve(import.meta.dirname, '../../..');
const readJson = async file => JSON.parse(await readFile(path.join(root, file), 'utf8'));

test('builtin extension allowlist keeps extension compatibility surfaces and drops optional tooling', async () => {
  const keep = await loadBuiltinAllowlist();
  for (const name of ['ubovm-core', 'typescript-language-features', 'json-language-features', 'python',
    'git', 'git-base', 'github', 'github-authentication', 'microsoft-authentication', 'npm',
    'emmet', 'simple-browser', 'ipynb', 'ms-vscode.js-debug']) {
    assert.equal(keep.includes(name), true, `${name} must stay available`);
  }
  for (const name of ['mermaid-markdown-features', 'tunnel-forwarding']) {
    assert.equal(keep.includes(name), false, `${name} must be removed`);
  }
});

test('runtime defaults contain no blocking extension allowlist', async () => {
  const app = await readJson('resources/app.json');
  const extension = await readJson('src/renderer/package.json');
  assert.equal(app.settings['extensions.allowed'], undefined);
  assert.equal(extension.contributes.configurationDefaults['extensions.allowed'], undefined);
  assert.equal(app.settings['extensions.autoCheckUpdates'], false);
});

test('builtin extension allowlist keeps only the harness and language services', async t => {
  const pair = await mkdtemp(path.join(tmpdir(), 'ubovm-ext-'));
  t.after(() => rm(pair, { recursive: true, force: true }));
  const keep = await loadBuiltinAllowlist();
  for (const name of ['ubovm-core', 'node_modules', 'typescript-language-features', 'json-language-features', 'github', 'ms-vscode.js-debug', 'mermaid-markdown-features']) {
    await mkdir(path.join(pair, name), { recursive: true });
  }
  const result = await pruneBuiltinExtensions(pair, keep);
  assert.deepEqual(result.removed.sort(), ['mermaid-markdown-features']);
  assert.equal(result.kept.includes('github'), true);
  assert.equal(result.kept.includes('ms-vscode.js-debug'), true);
  assert.equal(result.kept.includes('ubovm-core'), true);
  assert.equal(result.kept.includes('typescript-language-features'), true);
});

test('builtin extension state disables and re-enables a builtin across restarts', async t => {
  const app = await mkdtemp(path.join(tmpdir(), 'ubovm-builtin-state-app-'));
  const source = await mkdtemp(path.join(tmpdir(), 'ubovm-builtin-state-source-'));
  t.after(() => rm(app, { recursive: true, force: true }));
  t.after(() => rm(source, { recursive: true, force: true }));
  for (const name of ['ubovm-core', 'typescript-language-features', 'json-language-features', 'git']) {
    await mkdir(path.join(app, 'extensions', name), { recursive: true });
    await mkdir(path.join(source, name), { recursive: true });
  }
  await writeFile(path.join(app, 'extensions', 'git', 'package.json'), '{"name":"git"}');
  const stateFile = path.join(app, 'extension-state.json');
  await writeFile(stateFile, JSON.stringify({ disabledBuiltin: ['git'] }));
  const disabled = await applyBuiltinExtensionPolicy({ appRoot: app, sourceRoot: source, stateFile, logger: { log() {} } });
  assert.equal(disabled.builtinState.disabled.includes('git'), true);
  assert.equal(existsSync(path.join(app, 'extensions', 'git')), false);

  await writeFile(stateFile, JSON.stringify({ disabledBuiltin: [] }));
  const enabled = await applyBuiltinExtensionPolicy({ appRoot: app, sourceRoot: source, stateFile, logger: { log() {} } });
  assert.equal(enabled.builtinState.enabled.includes('git'), true);
  assert.equal(existsSync(path.join(app, 'extensions', 'git')), true);
});

test('product gallery is removed without deleting startup-critical product fields', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'ubovm-product-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'product.json');
  await writeFile(file, JSON.stringify({
    nameShort: 'UBOVM',
    extensionsGallery: { serviceUrl: 'https://open-vsx.org/vscode/gallery' },
    builtInExtensionsEnabledWithAutoUpdates: ['GitHub.copilot-chat'],
    builtInExtensions: [{ name: 'ms-vscode.js-debug' }],
    defaultChatAgent: { extensionId: 'GitHub.copilot' },
    updateUrl: 'https://vscodium.example/update',
    extensionEnabledApiProposals: { 'GitHub.copilot': ['chat'] },
    extensionKind: { 'vscodevim.vim': ['ui'] },
    win32AppId: '{{vscodium}}',
    win32ContextMenu: { x64: { clsid: 'x' } },
    sharedDataFolderName: '.vscode-oss-shared',
    darwinBundleIdentifier: 'com.vscodium',
    linuxIconName: 'vscodium',
    win32MutexName: 'ubovm'
  }));
  assert.equal(await stripExtensionGallery(file), true);
  const product = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(Object.hasOwn(product, 'extensionsGallery'), false);
  assert.deepEqual(product.builtInExtensions, [{ name: 'ms-vscode.js-debug' }]);
  assert.deepEqual(product.builtInExtensionsEnabledWithAutoUpdates, ['GitHub.copilot-chat']);
  assert.deepEqual(product.defaultChatAgent, { extensionId: 'GitHub.copilot' });
  assert.deepEqual(product.extensionEnabledApiProposals, { 'GitHub.copilot': ['chat'] });
  assert.equal(product.win32MutexName, 'ubovm');
  assert.equal(product.updateUrl, '');
});

test('expanding the allowlist restores missing builtins from a pristine source', async t => {
  const app = await mkdtemp(path.join(tmpdir(), 'ubovm-restore-app-'));
  const source = await mkdtemp(path.join(tmpdir(), 'ubovm-restore-source-'));
  t.after(() => rm(app, { recursive: true, force: true }));
  t.after(() => rm(source, { recursive: true, force: true }));
  await mkdir(path.join(app, 'extensions', 'ubovm-core'), { recursive: true });
  await mkdir(path.join(app, 'extensions', 'typescript-language-features'), { recursive: true });
  await mkdir(path.join(app, 'extensions', 'json-language-features'), { recursive: true });
  await mkdir(path.join(source, 'git'), { recursive: true });
  await mkdir(path.join(source, 'github'), { recursive: true });
  await writeFile(path.join(source, 'git', 'package.json'), '{"name":"git"}');
  await writeFile(path.join(source, 'github', 'package.json'), '{"name":"github"}');
  const result = await applyBuiltinExtensionPolicy({
    appRoot: app, sourceRoot: source, logger: { log() {} }
  });
  assert.equal(result.restored.includes('git'), true);
  assert.equal(JSON.parse(await readFile(path.join(app, 'extensions', 'git', 'package.json'), 'utf8')).name, 'git');
});

test('applying policy to a runtime tree strips gallery without touching required files', async t => {
  const app = await mkdtemp(path.join(tmpdir(), 'ubovm-runtime-'));
  t.after(() => rm(app, { recursive: true, force: true }));
  for (const name of ['ubovm-core', 'typescript-language-features', 'json-language-features', 'github', 'mermaid-markdown-features']) {
    await mkdir(path.join(app, 'extensions', name), { recursive: true });
  }
  await writeFile(path.join(app, 'product.json'), JSON.stringify({ nameShort: 'UBOVM', extensionsGallery: { serviceUrl: 'x' } }));
  await writeFile(path.join(app, 'product.ubovm-base.json'), JSON.stringify({ nameShort: 'VSCodium', extensionsGallery: { serviceUrl: 'x' } }));
  const result = await applyBuiltinExtensionPolicy({ appRoot: app, logger: { log() {} } });
  assert.equal(result.removed.includes('mermaid-markdown-features'), true);
  assert.equal(result.removed.includes('github'), false);
  assert.equal(JSON.parse(await readFile(path.join(app, 'product.json'), 'utf8')).extensionsGallery, undefined);
  assert.equal(JSON.parse(await readFile(path.join(app, 'product.ubovm-base.json'), 'utf8')).extensionsGallery, undefined);
});
