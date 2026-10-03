import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const modalJs = fs.readFileSync(path.join(root, 'webview/ui/modal-dialog.js'), 'utf8');
const modalCss = fs.readFileSync(path.join(root, 'webview/ui/modal-dialog.css'), 'utf8');

async function withPage(run) {
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.UBOVM_STYLE_EDGE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
  });
  try {
    const page = await browser.newPage();
    await page.setContent(`<!doctype html><html><head><style>${modalCss}
      .text-button{padding:6px 12px;border:1px solid #ccc;background:#fff;cursor:pointer}
      .primary-button{font-weight:600}
    </style></head><body>
      <dialog id="ubovm-modal" data-kind="confirm">
        <div class="ubovm-modal-shell">
          <header class="ubovm-modal-header">
            <h2 id="ubovm-modal-title">确认</h2>
            <button id="ubovm-modal-close" class="ubovm-modal-close" type="button">关闭</button>
          </header>
          <div class="ubovm-modal-body">
            <p class="ubovm-modal-message" id="ubovm-modal-message"></p>
            <p class="ubovm-modal-detail" id="ubovm-modal-detail"></p>
            <div class="ubovm-modal-field" id="ubovm-modal-field" hidden>
              <label id="ubovm-modal-label" for="ubovm-modal-input">名称</label>
              <input id="ubovm-modal-input" type="text" maxlength="60">
            </div>
            <div id="ubovm-modal-search-wrap" hidden>
              <input id="ubovm-modal-search" class="ubovm-modal-search" type="search">
            </div>
            <p class="ubovm-modal-empty" id="ubovm-modal-empty" hidden></p>
            <div id="ubovm-modal-list" class="ubovm-modal-list" hidden></div>
            <p class="ubovm-modal-error" id="ubovm-modal-error" hidden></p>
          </div>
          <footer class="ubovm-modal-footer" id="ubovm-modal-footer">
            <button class="text-button" id="ubovm-modal-cancel" type="button">取消</button>
            <button class="text-button primary-button" id="ubovm-modal-confirm" type="button">确定</button>
          </footer>
        </div>
      </dialog>
      <script>${modalJs.replace(/<\/script/gi, '<\\/script')}</script>
    </body></html>`);
    await run(page);
  } finally {
    await browser.close();
  }
}

test('confirm prompt and search-list modals resolve without VS Code chrome', async () => {
  await withPage(async page => {
    await page.evaluate(() => { window.__modal = window.createModalDialog(); });

    assert.equal(await page.evaluate(async () => {
      const pending = window.__modal.confirm({ title: '删除项目', message: '确认删除？', detail: '不可撤销', confirmLabel: '删除项目', danger: true });
      document.getElementById('ubovm-modal-confirm').click();
      return pending;
    }), true);

    assert.equal(await page.evaluate(async () => {
      const pending = window.__modal.prompt({
        title: '重命名项目',
        value: '旧名',
        validate: value => !value.trim() ? '必填' : undefined
      });
      const input = document.getElementById('ubovm-modal-input');
      input.value = '新项目';
      document.getElementById('ubovm-modal-confirm').click();
      return pending;
    }), '新项目');

    assert.deepEqual(await page.evaluate(async () => {
      const pending = window.__modal.searchList({
        title: '搜索协助会话',
        items: [
          { id: 'a', label: '会话甲', detail: 'hello world', searchText: 'alpha' },
          { id: 'b', label: '会话乙', detail: 'other', searchText: 'beta' }
        ]
      });
      document.getElementById('ubovm-modal-search').value = 'beta';
      document.getElementById('ubovm-modal-search').dispatchEvent(new Event('input'));
      document.querySelector('.ubovm-modal-row').click();
      return pending;
    }), { id: 'b' });
  });
});
