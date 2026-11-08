import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { chromium } from 'playwright-core';
const { renderWebview } = createRequire(import.meta.url)('../../../host/ui/webview.cjs');

const screenshotDirectory = '.cache/domain-inventory';
const now = Date.now();
const at = minutes => new Date(now - minutes * 60000).toISOString();

// A small but complete ledger: two seed roots, a tested apex, an in-progress
// subdomain with evidence, a pending deep subdomain, a skipped alias and an
// out-of-scope IP host.
const domain = (hostname, overrides = {}) => ({
  hostname, kind: 'subdomain', parent: null, seed_roots: ['example.com'], discovery: 'enum',
  relations: [], test_status: 'pending', skip_reason: null, last_tested_at: null,
  evidence: [], linked_note_ids: [], finding_ids: [], updated_at: at(5), created_at: at(30), ...overrides
});
const inventory = (revision = 7, domains = [
  domain('example.com', { kind: 'apex', discovery: 'seed', seed_roots: ['example.com'], relations: [{ type: 'manual', evidence_refs: ['n-1'] }], test_status: 'tested', evidence: ['n-1'], updated_at: at(20) }),
  domain('api.example.com', { parent: 'example.com', discovery: 'cert', relations: [{ type: 'cert_san', evidence_refs: ['n-2'] }], test_status: 'in_progress', evidence: ['n-2'], finding_ids: ['F-1'], linked_note_ids: ['n-2'], updated_at: at(2) }),
  domain('admin.app.example.com', { parent: 'app.example.com', seed_roots: ['app.example.com'], discovery: 'dns', updated_at: at(3) }),
  domain('cdn.example.net', { kind: 'alias', discovery: 'redirect', test_status: 'skipped', skip_reason: 'redirect target is third-party', updated_at: at(8) }),
  domain('192.0.2.10', { kind: 'ip_host', discovery: 'manual', test_status: 'out_of_scope', skip_reason: 'third-party CDN edge', updated_at: at(9) })
]) => ({ revision, seedRoots: ['example.com', 'app.example.com'], domains });

const state = (overrides = {}) => ({
  type: 'state', mode: 'goal', conversation: { id: 'domain-inventory', title: '域名台账' },
  goal: { objective: '确认测试范围内的域名覆盖', criteria: [], notes: [] },
  messages: [], provider: { configured: true, connected: true, label: 'deepseek-flash' }, context: {}, busy: false,
  execution: { status: 'running', busy: false, phase: 'execute', parts: [], activities: [], workers: [], memory: { domainInventory: inventory() } },
  ...overrides
});

let browser;
test.before(async () => {
  await mkdir(screenshotDirectory, { recursive: true });
  browser = await chromium.launch({ headless: true, executablePath: process.env.UBOVM_STYLE_EDGE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' });
});
test.after(async () => browser?.close());

async function fixture(t, options = {}) {
  const page = await browser.newPage({ viewport: { width: 1180, height: 800 }, reducedMotion: 'reduce', ...options });
  t.after(() => page.close());
  page.setDefaultTimeout(7000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(({ locale }) => {
    if (locale) window.localStorage.setItem('ubovm.locale', locale);
    window.acquireVsCodeApi = () => ({ getState: () => ({}), setState() {}, postMessage() {} });
  }, { locale: options.locale });
  await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: renderWebview({ nonce: 'domain-inventory' }) }));
  await page.goto('http://domain-inventory.test/');
  const frames = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.evaluate(value => window.dispatchEvent(new MessageEvent('message', { data: value })), state());
  await frames(); await frames();
  return { page, frames, errors };
}

const panelFacts = page => page.evaluate(() => {
  const panel = document.getElementById('goal-domain-panel');
  const checked = panel.querySelector('summary');
  return {
    hidden: panel.hidden, open: panel.open,
    scope: document.getElementById('goal-domain-scope').textContent,
    coverage: document.getElementById('goal-domain-coverage').textContent,
    coverageHidden: document.getElementById('goal-domain-coverage').hidden,
    coverageComplete: document.getElementById('goal-domain-coverage').dataset.complete,
    counts: [...document.querySelectorAll('#goal-domain-counts .goal-domain-chip')].map(chip => chip.textContent),
    seeds: [...document.querySelectorAll('#goal-domain-seeds .goal-domain-seed')].map(chip => chip.textContent),
    meter: document.getElementById('goal-domain-progress').value,
    meterMax: document.getElementById('goal-domain-progress').max,
    meterLabel: document.getElementById('goal-domain-meter-label').textContent,
    rows: [...document.querySelectorAll('#goal-domain-list tr')].map(row => ({
      host: row.querySelector('.goal-domain-host')?.textContent ?? '',
      parent: row.querySelector('.goal-domain-parent')?.textContent ?? '',
      kind: row.children[1]?.textContent ?? '',
      discovery: row.children[2]?.textContent ?? '',
      status: row.querySelector('.goal-domain-state')?.textContent ?? '',
      statusState: row.querySelector('.goal-domain-state')?.dataset.status ?? '',
      evidence: row.querySelector('.goal-domain-evidence')?.textContent ?? ''
    })),
    caption: document.getElementById('goal-domain-caption').textContent,
    emptyVisible: !document.getElementById('goal-domain-empty').hidden,
    tableHidden: document.getElementById('goal-domain-table').hidden,
    layout: (() => {
      const panels = document.getElementById('goal-panels');
      const acceptance = document.querySelector('.goal-acceptance-panel');
      const content = document.getElementById('goal-output-content');
      const rect = element => element.getBoundingClientRect();
      return {
        pageScrolling: document.scrollingElement.scrollHeight > window.innerHeight + 4,
        acceptanceVisible: rect(acceptance).top >= -1 && rect(acceptance).bottom <= window.innerHeight + 1,
        overviewFills: Math.round(rect(document.getElementById('goal-overview')).height) >= Math.round(rect(panels).height) - 64,
        logScrolls: content.scrollHeight > content.clientHeight + 4,
        panelOverflowX: panel.scrollWidth > panel.clientWidth + 1
      };
    })(),
    summaryLabel: checked.getAttribute('aria-label') || ''
  };
});

test('overview shows the domain_inventory ledger: scope, coverage, hosts and pending work', async t => {
  const { page, frames, errors } = await fixture(t);
  const facts = await panelFacts(page);
  assert.equal(facts.hidden, false, 'the ledger is visible once domain_inventory has data');
  assert.equal(facts.open, true, 'a small ledger defaults to expanded');
  assert.equal(facts.scope, '2 个种子域 · 5 个主机');
  assert.deepEqual(facts.seeds, ['example.com', 'app.example.com']);
  assert.equal(facts.coverage, '已覆盖 3/5');
  assert.equal(facts.coverageComplete, 'false');
  assert.deepEqual(facts.counts, ['进行中 1', '待测 1', '已测 1', '范围外 1']);
  assert.equal(Number(facts.meter), 0.6);
  assert.equal(facts.meterMax, 1);
  assert.match(facts.meterLabel, /覆盖率 60%/);
  assert.match(facts.meterLabel, /未完成 2 个/);
  // Sorted by remaining work first: in_progress, pending, tested, skipped, out_of_scope.
  assert.deepEqual(facts.rows.map(row => row.host), ['api.example.com', 'admin.app.example.com', 'example.com', 'cdn.example.net', '192.0.2.10']);
  assert.deepEqual(facts.rows.map(row => row.status), ['进行中', '待测', '已测', '跳过', '范围外']);
  assert.deepEqual(facts.rows.map(row => row.kind), ['子域', '子域', '主域', '别名', 'IP 主机']);
  assert.deepEqual(facts.rows.map(row => row.discovery), ['证书', 'DNS', '种子', '跳转', '手工']);
  assert.equal(facts.rows[0].parent, '← example.com');
  assert.equal(facts.rows[0].evidence, '关系 1 · 证据 1 · 发现 1 · 笔记 1');
  assert.equal(facts.rows[2].evidence, '关系 1 · 证据 1');
  assert.equal(facts.rows[4].statusState, 'out_of_scope');
  assert.match(facts.caption, /种子域及其子域自动计入范围/);
  assert.match(facts.caption, /待测 2 个：api\.example\.com、admin\.app\.example\.com/);
  assert.equal(facts.layout.pageScrolling, false, 'the overview page itself must not scroll');
  assert.equal(facts.layout.acceptanceVisible, true, 'the acceptance footer stays visible');
  assert.equal(facts.layout.overviewFills, true);
  assert.equal(facts.layout.panelOverflowX, false);
  assert.deepEqual(errors, []);
  await page.screenshot({ path: `${screenshotDirectory}/wide-light.png` });
  await page.evaluate(() => document.body.classList.add('vscode-dark'));
  await frames();
  await page.screenshot({ path: `${screenshotDirectory}/wide-dark.png` });
});

test('collapsing the ledger, live updates and session switches keep the panel coherent', async t => {
  const { page, frames } = await fixture(t);
  await page.locator('#goal-domain-panel > summary').click();
  await frames();
  let facts = await panelFacts(page);
  assert.equal(facts.open, false, 'clicking the summary collapses the ledger');
  assert.equal(facts.layout.pageScrolling, false);

  // A live execution increment (the host's executionState push) with one new host
  // and a status move; memory must travel with the increment, not only in a full snapshot.
  const next = inventory(8, [
    ...inventory().domains.map(item => item.hostname === 'admin.app.example.com' ? { ...item, test_status: 'tested', last_tested_at: at(1) } : item),
    domain('vpn.example.com', { parent: 'example.com', discovery: 'enum', test_status: 'pending', updated_at: at(1) })
  ]);
  await page.evaluate(value => window.dispatchEvent(new MessageEvent('message', { data: value })), {
    type: 'executionState', conversationId: 'domain-inventory', busy: true,
    execution: { ...state().execution, memory: { domainInventory: next }, busy: true }
  });
  await frames(); await frames();
  facts = await panelFacts(page);
  assert.equal(facts.open, false, 'a manual collapse survives live updates');
  assert.equal(facts.rows.length, 6, 'new hosts appear without reopening the panel');
  assert.equal(facts.scope, '2 个种子域 · 6 个主机');
  assert.equal(facts.coverage, '已覆盖 4/6');
  assert.deepEqual(facts.counts, ['进行中 1', '待测 1', '已测 2', '范围外 1']);
  assert.equal(facts.rows[0].host, 'api.example.com');
  assert.equal(facts.rows[1].host, 'vpn.example.com', 'newly discovered hosts show up in the remaining-work section');
  assert.equal(facts.rows.at(-1).host, '192.0.2.10');

  // Switching sessions re-initialises the panel (expanded again for a small ledger).
  await page.evaluate(value => window.dispatchEvent(new MessageEvent('message', { data: value })), {
    ...state(), conversation: { id: 'domain-inventory-other', title: '另一个目标' }
  });
  await frames(); await frames();
  facts = await panelFacts(page);
  assert.equal(facts.hidden, false);
  assert.equal(facts.open, true, 'the next session starts from the default expansion');
  assert.equal(facts.rows.length, 5);
});

test('an empty inventory hides the ledger, and the expanded ledger renders in dark narrow mode', async t => {
  const empty = await fixture(t, { viewport: { width: 1000, height: 800 } });
  const emptyPage = empty.page;
  await emptyPage.evaluate(value => window.dispatchEvent(new MessageEvent('message', { data: value })), state({ execution: { ...state().execution, memory: {} } }));
  await empty.frames(); await empty.frames();
  assert.equal(await emptyPage.locator('#goal-domain-panel').isHidden(), true, 'no inventory means no ledger');
  assert.equal(await emptyPage.evaluate(() => document.getElementById('goal-domain-list').children.length), 0);

  const dark = await fixture(t, { viewport: { width: 390, height: 800 } });
  await dark.page.evaluate(() => document.body.classList.add('vscode-dark'));
  await dark.page.evaluate(value => window.dispatchEvent(new MessageEvent('message', { data: value })), state());
  await dark.frames(); await dark.frames();
  const facts = await panelFacts(dark.page);
  assert.equal(facts.hidden, false);
  assert.equal(facts.open, true);
  assert.equal(facts.layout.panelOverflowX, false, 'the narrow ledger must not overflow horizontally');
  assert.equal(facts.layout.pageScrolling, false);
  await dark.page.screenshot({ path: `${screenshotDirectory}/narrow-dark.png` });
});

test('large inventories cap the rendered rows and say what is hidden', async t => {
  const { page, frames } = await fixture(t, { viewport: { width: 1180, height: 800 } });
  const many = Array.from({ length: 250 }, (_, index) => domain(`h${String(index).padStart(3, '0')}.example.com`, {
    parent: 'example.com', test_status: index < 240 ? 'tested' : 'pending', updated_at: at(index % 30)
  }));
  await page.evaluate(value => window.dispatchEvent(new MessageEvent('message', { data: value })), state({
    execution: { ...state().execution, memory: { domainInventory: inventory(11, many) } }
  }));
  await frames(); await frames();
  const facts = await page.evaluate(() => ({
    rows: document.querySelectorAll('#goal-domain-list tr').length,
    caption: document.getElementById('goal-domain-caption').textContent,
    scope: document.getElementById('goal-domain-scope').textContent,
    pageScrolling: document.scrollingElement.scrollHeight > window.innerHeight + 4
  }));
  assert.equal(facts.rows, 200, 'only the first 200 hosts get DOM rows');
  assert.match(facts.caption, /仅显示前 200 个主机（共 250）/);
  assert.equal(facts.scope, '2 个种子域 · 250 个主机');
  assert.equal(facts.pageScrolling, false);
});

test('English locale translates the ledger labels and leaves no visible Chinese UI text', async t => {
  const { page, errors } = await fixture(t, { locale: 'en' });
  const result = await page.evaluate(() => {
    const panel = document.getElementById('goal-domain-panel');
    const walker = document.createTreeWalker(panel, NodeFilter.SHOW_TEXT);
    const leaks = [];
    while (walker.nextNode()) {
      const text = walker.currentNode.nodeValue.replace(/\s+/g, ' ').trim();
      if (/[\u4e00-\u9fff]/.test(text)) leaks.push(text);
    }
    return { leaks, text: panel.innerText.replace(/\s+/g, ' ') };
  });
  assert.deepEqual(result.leaks, [], 'the ledger must be fully translated in English');
  assert.match(result.text, /Domain inventory/);
  assert.match(result.text, /2 seed domains · 5 hosts/);
  assert.match(result.text, /Covered 3\/5/);
  assert.match(result.text, /Pending/);
  assert.deepEqual(errors, []);
});
