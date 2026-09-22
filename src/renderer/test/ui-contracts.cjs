'use strict';

// Installed-artifact checks. Desktop smoke/CDP tests cover visible UI behavior.
// Run from any directory: node src/renderer/test/ui-contracts.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { existsSync, readFileSync } = require('node:fs');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '../../..');
const readJson = file => JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const configuration = readJson(path.join(projectRoot, 'resources/app.json'));
const appRoot = path.resolve(projectRoot, configuration.core.runtime.directory, 'resources/app');
assert.ok(existsSync(appRoot), 'Installed runtime is missing; run build.bat setup first.');

const htmlPath = 'vs/code/electron-browser/workbench/workbench.html';
const html = readFileSync(path.join(appRoot, 'out', htmlPath), 'utf8');
const product = readJson(path.join(appRoot, 'product.json'));

function attributes(markup) {
  return Object.fromEntries([...markup.matchAll(/([^\s=<>/]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)]
    .map(match => [match[1].toLowerCase(), match[2] ?? match[3]]));
}

test('installed npm extension hides its view while retaining npm task support', () => {
  const manifest = readJson(path.join(appRoot, 'extensions/npm/package.json'));
  assert.equal(manifest.name, 'npm');
  const views = Object.values(manifest.contributes?.views || {}).flat().filter(view => view.id === 'npm');
  assert.equal(views.length, 1, 'The installed npm view must have one contribution.');
  assert.equal(views[0].when, 'false', 'Hidden-by-default is insufficient: npm must have a false visibility condition.');
  assert.ok(manifest.contributes.taskDefinitions.some(task => task.type === 'npm'), 'Hiding npm UI must retain task registration.');
});

test('installed startup markup occurs once inside the workbench body', () => {
  const begin = '<!-- UBOVM STARTUP BEGIN -->';
  const end = '<!-- UBOVM STARTUP END -->';
  assert.equal(html.split(begin).length - 1, 1, 'Repeated setup must not duplicate the startup fragment.');
  assert.equal(html.split(end).length - 1, 1);
  assert.equal([...html.matchAll(/\bid\s*=\s*["']ubovm-startup["']/g)].length, 1);
  assert.equal([...html.matchAll(/\bid\s*=\s*["']ubovm-startup-style["']/g)].length, 1);

  const body = /<body\b[^>]*>([\s\S]*?)<\/body\s*>/i.exec(html);
  assert.ok(body, 'Workbench body is missing.');
  assert.ok(body[1].includes(begin) && body[1].includes(end), 'Startup must be part of the body.');
  assert.ok(html.indexOf(begin) < html.indexOf(end), 'Startup markers must be ordered.');
  const fragment = html.slice(html.indexOf(begin), html.indexOf(end));
  assert.doesNotMatch(fragment, /<script\b|\son[a-z]+\s*=|javascript\s*:/i, 'Startup markup must not introduce inline execution.');
});

test('installed HTML preserves the upstream script policy and external module loader', () => {
  const policies = [...html.matchAll(/<meta\b[^>]*>/gi)].map(match => attributes(match[0]))
    .filter(meta => meta['http-equiv']?.toLowerCase() === 'content-security-policy');
  assert.equal(policies.length, 1, 'Workbench must have one unambiguous CSP.');
  const directives = new Map();
  for (const directive of policies[0].content.split(';').map(value => value.trim()).filter(Boolean)) {
    const [name, ...values] = directive.split(/\s+/);
    assert.ok(!directives.has(name), `Duplicate CSP directive: ${name}`);
    directives.set(name, values);
  }
  // This pinned desktop core requires unsafe-eval and blob workers, but never
  // unsafe-inline, remote script origins, wildcard sources or inline hashes.
  const upstreamScripts = ["'self'", "'unsafe-eval'", 'blob:'];
  assert.deepEqual([...(directives.get('script-src') || [])].sort(), [...upstreamScripts].sort());
  for (const name of ['script-src-elem', 'script-src-attr']) {
    const values = directives.get(name);
    if (values) assert.ok(values.length > 0 && values.every(value => value === "'none'" || upstreamScripts.includes(value)), `${name} must not weaken script-src.`);
  }
  assert.deepEqual(directives.get('default-src'), ["'none'"]);
  assert.ok(directives.get('require-trusted-types-for')?.includes("'script'"), 'Keep Trusted Types enforcement.');

  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)];
  assert.equal(scripts.length, 1, 'Startup must retain the single upstream module loader.');
  const loader = attributes(scripts[0][1]);
  assert.equal(loader.src, './workbench.js');
  assert.equal(loader.type, 'module');
  assert.equal(scripts[0][2].trim(), '', 'The loader must not contain inline JavaScript.');
  assert.ok(existsSync(path.join(path.dirname(path.join(appRoot, 'out', htmlPath)), loader.src)), 'Loader asset is missing.');
});

for (const relativePath of [
  'vs/workbench/workbench.desktop.main.js',
  'vs/workbench/workbench.desktop.main.css',
  htmlPath
]) {
  test(`installed product checksum matches ${relativePath}`, () => {
    const recorded = product.checksums?.[relativePath];
    assert.equal(typeof recorded, 'string', 'Patched assets must retain an integrity entry.');
    assert.match(recorded, /^[A-Za-z0-9+/]{43}$/, 'Checksums use unpadded SHA-256 Base64.');
    const bytes = readFileSync(path.join(appRoot, 'out', relativePath));
    assert.ok(bytes.length > 0, 'Installed asset must not be empty.');
    const actual = createHash('sha256').update(bytes).digest('base64').replace(/=+$/, '');
    assert.equal(recorded, actual, 'Installed bytes differ from product.checksums; rerun setup before shipping.');
  });
}
